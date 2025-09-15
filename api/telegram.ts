// api/telegram.ts
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import axios from "axios";
import FormData from "form-data";

// Força Node no Vercel (serverless) e dá folga pra cold start
export const config = { runtime: "nodejs", maxDuration: 10 };

const token = process.env.TELEGRAM_TOKEN!;
const PREDICT_URL = process.env.PREDICT_URL!;
const API_KEY = process.env.API_KEY || "";

if (!token) throw new Error("TELEGRAM_TOKEN ausente");
if (!PREDICT_URL) throw new Error("PREDICT_URL ausente");

// ===== Tipos e estado =====
type Pred = { label: string; score: number };
type UserInfo = { name?: string; cpf?: string; phone?: string };
type Address = {
  cep?: string;
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  numero?: string;
  complemento?: string;
};
type Schedule = { day?: string; time?: string };
type Step =
  | "name"
  | "cpf"
  | "phone"
  | "await_photo"
  | "confirm_item"
  | "await_qty"
  | "await_cep"
  | "await_number"
  | "await_day"
  | "await_time";

type Draft = {
  step?: Step;
  user?: UserInfo;
  item?: Pred; // apenas label/score; score não exibido
  qty?: number;
  address?: Address;
  schedule?: Schedule;
  latestFileId?: string;
  latestFileUrl?: string;
};

const drafts = new Map<number, Draft>();

// ===== Mapeamento EN -> PT dos rótulos =====
const LABEL_PT: Record<string, string> = {
  Battery: "Bateria",
  Keyboard: "Teclado",
  Microwave: "Micro-ondas",
  Mobile: "Celular",
  Mouse: "Mouse",
  PCB: "Placa de circuito",
  Player: "Reprodutor",
  Printer: "Impressora",
  Television: "Televisão",
  "Washing Machine": "Máquina de lavar",
};
const toPT = (en: string) => LABEL_PT[en] ?? en;

// ===== Helpers comuns =====
const bot = new Bot(token);

async function getFileUrl(fileId: string): Promise<string> {
  const f = await bot.api.getFile(fileId);
  return `https://api.telegram.org/file/bot${token}/${f.file_path}`;
}
async function getFileBuffer(fileId: string): Promise<Buffer> {
  const url = await getFileUrl(fileId);
  const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer" });
  return Buffer.from(resp.data as any);
}
async function classifyImage(bytes: Buffer, topk = 1): Promise<Pred[]> {
  const form = new FormData();
  form.append("file", bytes, { filename: "photo.jpg", contentType: "image/jpeg" });
  const headers: Record<string, string> = { ...(form.getHeaders?.() || {}) };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  const { data } = await axios.post(`${PREDICT_URL}?topk=${topk}`, form as any, {
    headers,
    timeout: 20000,
    maxBodyLength: Infinity,
  });
  return data.topk as Pred[];
}

// ===== Validações simples =====
function onlyDigits(s: string) {
  return (s || "").replace(/\D/g, "");
}
// CPF: validação de dígitos verificadores (básica)
function isValidCPF(cpfRaw: string): boolean {
  const cpf = onlyDigits(cpfRaw);
  if (!cpf || cpf.length !== 11) return false;
  if (/^(\d)\1+$/.test(cpf)) return false;
  const calc = (base: string, factor: number) => {
    let total = 0;
    for (let i = 0; i < base.length; i++) total += parseInt(base[i]) * factor--;
    const rest = (total * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  const d1 = calc(cpf.slice(0, 9), 10);
  const d2 = calc(cpf.slice(0, 10), 11);
  return d1 === parseInt(cpf[9]) && d2 === parseInt(cpf[10]);
}
function isValidPhone(p: string): boolean {
  const digits = onlyDigits(p);
  // aceita 10 ou 11 dígitos (com DDD)
  return digits.length === 10 || digits.length === 11;
}

// ===== ViaCEP =====
type ViaCEP = {
  cep?: string;
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  complemento?: string;
  erro?: boolean;
};
async function fetchViaCEP(cep: string): Promise<ViaCEP> {
  const c = onlyDigits(cep);
  const { data } = await axios.get<ViaCEP>(`https://viacep.com.br/ws/${c}/json/`, { timeout: 8000 });
  return data;
}
function formatAddressPT(a: Address) {
  const parts = [
    a.logradouro && a.numero ? `${a.logradouro}, ${a.numero}` : a.logradouro,
    a.bairro,
    a.localidade && a.uf ? `${a.localidade}/${a.uf}` : a.localidade || a.uf,
    a.complemento,
    a.cep && `CEP ${a.cep}`,
  ].filter(Boolean);
  return parts.join(" • ");
}

// ===== agendamento: botões para dia e hora =====
const TIME_SLOTS = ["09:00", "11:00", "14:00", "16:00", "18:00"];
function nextDays(n = 7): { iso: string; label: string }[] {
  const out: { iso: string; label: string }[] = [];
  const fmtDay = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const label = fmtDay.format(d); // ex: seg., 16/09
    out.push({ iso, label });
  }
  return out;
}
function kbDays() {
  const kb = new InlineKeyboard();
  const days = nextDays(7);
  for (const d of days) kb.text(d.label, `day:${d.iso}`).row();
  kb.text("Cancelar", "cancel");
  return kb;
}
function kbTimes(dayISO: string) {
  const kb = new InlineKeyboard();
  for (const t of TIME_SLOTS) kb.text(t, `time:${dayISO}T${t}`).row();
  kb.text("Voltar dias", "back:days").text("Cancelar", "cancel");
  return kb;
}
function kbQty() {
  const kb = new InlineKeyboard();
  for (let i = 1; i <= 6; i++) kb.text(String(i), `qty:${i}`).row();
  kb.text("7-9", "qty:7").text("10+", "qty:other");
  return kb;
}

// ===== fluxo =====
bot.command("cancel", async (ctx) => {
  drafts.set(ctx.chat!.id, {});
  await ctx.reply("Fluxo cancelado. Envie /start para começar novamente.");
});

bot.command("start", async (ctx) => {
  drafts.set(ctx.chat!.id, { step: "name", user: {}, address: {}, schedule: {} });
  await ctx.reply("Olá! Eu sou o bot da E-Coleta ♻️\n\nVamos começar com seus dados.\n\n👉 *Seu nome completo?*", {
    parse_mode: "Markdown",
  });
});

bot.command("help", (ctx) =>
  ctx.reply("Comandos: /start, /cancel.\nFluxo: Nome → CPF → Telefone → Foto/Arquivo → Quantidade → CEP → Número → Data/Hora.")
);

// ===== imagem (foto ou arquivo) =====
async function handleImage(chatId: number, fileId: string) {
  const [buf, url] = await Promise.all([getFileBuffer(fileId), getFileUrl(fileId)]);
  const preds = await classifyImage(buf, 1);
  if (!preds.length) throw new Error("Sem predições");
  const top = preds[0];

  const d = drafts.get(chatId) || {};
  drafts.set(chatId, {
    ...d,
    latestFileId: fileId,
    latestFileUrl: url,
    item: top,
    step: "await_qty",
  });

  const kb = kbQty();
  return { text: `Detectei: *${toPT(top.label)}*.\nQuantas unidades você deseja descartar?`, kb };
}

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat!.id;
  const d = drafts.get(chatId);
  if (!d || !d.user?.name || !d.user?.cpf || !d.user?.phone) {
    return ctx.reply("Antes, por favor informe Nome, CPF e Telefone. Envie /start para iniciar.");
  }
  try {
    const best = ctx.message.photo.at(-1)!;
    const { text, kb } = await handleImage(chatId, best.file_id);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Não consegui processar. Tente enviar como *Arquivo* (sem compressão).", { parse_mode: "Markdown" });
  }
});

bot.on("message:document", async (ctx) => {
  const chatId = ctx.chat!.id;
  const d = drafts.get(chatId);
  if (!d || !d.user?.name || !d.user?.cpf || !d.user?.phone) {
    return ctx.reply("Antes, por favor informe Nome, CPF e Telefone. Envie /start para iniciar.");
  }
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith("image/")) {
    return ctx.reply("Envie um *arquivo de imagem* (JPG/PNG).", { parse_mode: "Markdown" });
  }
  try {
    const { text, kb } = await handleImage(chatId, doc.file_id);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Não consegui baixar/processar o arquivo. Tente novamente.");
  }
});

// ===== callback buttons (confirm item, qty, day/time, navegação) =====
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat!.id;
  const d = drafts.get(chatId) || {};

  // quantidade
  if (data.startsWith("qty:")) {
    const val = data.split(":")[1];
    if (val === "other") {
      drafts.set(chatId, { ...d, step: "await_qty" });
      await ctx.answerCallbackQuery();
      return ctx.editMessageText("Digite a *quantidade* (número inteiro):", { parse_mode: "Markdown" });
    }
    const q = Math.max(1, Math.min(99, Number(val)));
    drafts.set(chatId, { ...d, qty: q, step: "await_cep" });
    await ctx.answerCallbackQuery({ text: `Qtd: ${q}` });
    return ctx.editMessageText(`Ok! Quantidade: *${q}*.\nAgora, informe seu *CEP* (somente números).`, {
      parse_mode: "Markdown",
    });
  }

  // datas
  if (data === "back:days") {
    await ctx.answerCallbackQuery();
    return ctx.editMessageReplyMarkup({ reply_markup: kbDays() });
  }
  if (data.startsWith("day:")) {
    const dayISO = data.split(":")[1];
    drafts.set(chatId, { ...d, schedule: { ...(d.schedule || {}), day: dayISO }, step: "await_time" });
    await ctx.answerCallbackQuery({ text: new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(new Date(dayISO)) });
    return ctx.editMessageText("Escolha um horário:", { reply_markup: kbTimes(dayISO) });
  }
  if (data.startsWith("time:")) {
    const iso = data.split(":")[1]; // YYYY-MM-DDTHH:mm
    const [dayISO, time] = iso.split("T");
    const nd = { ...d, schedule: { day: dayISO, time } };
    drafts.set(chatId, nd);
    await ctx.answerCallbackQuery({ text: `Horário: ${time}` });

    // resumo final
    const addr = nd.address!;
    const user = nd.user!;
    const item = nd.item!;
    const resumo = [
      "✅ *Pedido de coleta registrado!*",
      `• Nome: *${user.name}*`,
      `• CPF: *${user.cpf}*`,
      `• Telefone: *${user.phone}*`,
      `• Item: *${toPT(item.label)}*`,
      `• Quantidade: *${nd.qty}*`,
      `• Endereço: *${formatAddressPT(addr)}*`,
      `• Data/Hora: *${new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "medium",
      }).format(new Date(dayISO))} às *${time}*`,
      "",
      "_(Demo serverless: estado pode reiniciar no cold start.)_",
    ].join("\n");
    await ctx.editMessageText(resumo, { parse_mode: "Markdown" });

    // limpa estado
    drafts.set(chatId, {});
    return;
  }

  if (data === "cancel") {
    drafts.set(chatId, {});
    await ctx.answerCallbackQuery({ text: "Cancelado" });
    return ctx.editMessageText("Fluxo cancelado. Envie /start para começar novamente.");
  }
});

// ===== fluxo de texto (dados do usuário, qty manual, CEP, número) =====
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat!.id;
  const txt = (ctx.message.text || "").trim();
  const d = drafts.get(chatId) || {};

  // etapa inicial: nome -> cpf -> phone
  if (!d.user?.name && d.step === "name") {
    const user = { ...(d.user || {}), name: txt };
    drafts.set(chatId, { ...d, user, step: "cpf" });
    return ctx.reply("Ótimo! Agora informe seu *CPF* (somente números).", { parse_mode: "Markdown" });
  }
  if (!d.user?.cpf && (d.step === "cpf" || d.step === "name")) {
    const cpf = onlyDigits(txt);
    if (!isValidCPF(cpf)) {
      return ctx.reply("CPF inválido. Tente novamente (somente números).");
    }
    const user = { ...(d.user || {}), cpf: cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") };
    drafts.set(chatId, { ...d, user, step: "phone" });
    return ctx.reply("Perfeito. Informe seu *telefone com DDD* (ex.: 11987654321).", { parse_mode: "Markdown" });
  }
  if (!d.user?.phone && d.step === "phone") {
    if (!isValidPhone(txt)) {
      return ctx.reply("Telefone inválido. Envie no formato com DDD (ex.: 11987654321).");
    }
    const digits = onlyDigits(txt);
    const fmt =
      digits.length === 11
        ? digits.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3")
        : digits.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
    const user = { ...(d.user || {}), phone: fmt };
    drafts.set(chatId, { ...d, user, step: "await_photo" });
    return ctx.reply("Dados salvos! ✅ Agora, envie uma *foto* do item (ou como *Arquivo* para melhor qualidade).", {
      parse_mode: "Markdown",
    });
  }

  // quantidade digitada manualmente
  if (d.step === "await_qty" && d.item && !d.qty) {
    const q = Number(onlyDigits(txt));
    if (!Number.isFinite(q) || q <= 0) return ctx.reply("Quantidade inválida. Envie um número inteiro maior que 0.");
    drafts.set(chatId, { ...d, qty: Math.min(999, q), step: "await_cep" });
    return ctx.reply("Agora, informe seu *CEP* (somente números).", { parse_mode: "Markdown" });
  }

  // CEP -> ViaCEP -> pede número
  if (d.step === "await_cep" && d.item && d.qty && !d.address?.cep) {
    const cep = onlyDigits(txt);
    if (cep.length !== 8) return ctx.reply("CEP inválido. Envie 8 dígitos (ex.: 01001000).");
    try {
      const via = await fetchViaCEP(cep);
      if (via.erro) return ctx.reply("CEP não encontrado. Verifique e envie novamente.");
      const addr: Address = {
        cep: via.cep,
        logradouro: via.logradouro,
        bairro: via.bairro,
        localidade: via.localidade,
        uf: via.uf,
        complemento: via.complemento,
      };
      drafts.set(chatId, { ...d, address: addr, step: "await_number" });
      return ctx.reply(
        [
          "Endereço encontrado pelo CEP:",
          `• ${formatAddressPT(addr)}`,
          "",
          "👉 Informe o *número* da residência (e complemento se houver).",
        ].join("\n"),
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.error(e);
      return ctx.reply("Falha ao consultar o CEP. Tente novamente em instantes.");
    }
  }

  // Número/complemento -> escolher dia
  if (d.step === "await_number" && d.item && d.qty && d.address?.cep) {
    // separa número do complemento (ex.: "123, apto 45")
    const m = txt.match(/^\s*(\d+)\s*(.*)$/);
    if (!m) return ctx.reply("Informe o número (ex.: 123) e, opcionalmente, complemento (ex.: 123, apto 45).");
    const numero = m[1];
    const complemento = m[2]?.trim() || undefined;

    const addr = { ...(d.address || {}), numero, complemento };
    drafts.set(chatId, { ...d, address: addr, step: "await_day" });

    await ctx.reply(
      `Endereço completo:\n*${formatAddressPT(addr)}*\n\nAgora, escolha a *data* da coleta:`,
      { parse_mode: "Markdown", reply_markup: kbDays() }
    );
    return;
  }

  // Se chegou texto fora de fluxo
  if (!d.step) {
    return ctx.reply("Envie /start para iniciar o fluxo de agendamento. 😉");
  }

  // Mensagens fora do esperado
  return ctx.reply("Beleza! Siga as instruções acima ou envie /cancel para recomeçar.");
});

// ===== exporta handler (webhook do Vercel) =====
export default webhookCallback(bot, "http");
