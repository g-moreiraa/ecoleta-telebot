// api/telegram.ts
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import axios from "axios";
import FormData from "form-data";

// força Node e dá folga pra cold start
export const config = { runtime: "nodejs", maxDuration: 10 };

const token = process.env.TELEGRAM_TOKEN!;
const PREDICT_URL = process.env.PREDICT_URL!;
const API_KEY = process.env.API_KEY || "";

if (!token) throw new Error("TELEGRAM_TOKEN ausente");
if (!PREDICT_URL) throw new Error("PREDICT_URL ausente");

type Pred = { label: string; score: number };
type UserInfo = { name?: string; cpf?: string; phone?: string };
type Address = {
  cep?: string; logradouro?: string; bairro?: string; localidade?: string; uf?: string;
  numero?: string; complemento?: string
};
type Schedule = { day?: string; time?: string };
type Step =
  | "name" | "cpf" | "phone"
  | "await_photo" | "await_confirm" | "await_qty" | "await_cep" | "await_number" | "await_day" | "await_time";

type Draft = {
  step?: Step;
  user?: UserInfo;
  item?: Pred;
  qty?: number;
  address?: Address;
  schedule?: Schedule;
  latestFileId?: string;
  latestFileUrl?: string;
};

// ---------- Persistência com fallback (Upstash Redis REST ou memória) ----------
const DRAFT_TTL = 60 * 60 * 2; // 2h

type Store = {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSec?: number): Promise<void>;
};

function inMemoryStore(): Store {
  const mem = new Map<string, { v: unknown; exp: number }>();
  console.warn("[STORE] usando memória (fallback).");
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const hit = mem.get(key);
      if (!hit) return undefined;
      if (Date.now() > hit.exp) { mem.delete(key); return undefined; }
      return hit.v as T;
    },
    async set<T>(key: string, value: T, ttlSec = DRAFT_TTL): Promise<void> {
      mem.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
    }
  };
}

function parseUpstashResult<T>(result: any): T | undefined {
  // 1) Se vier string pura (o valor salvo), tentar parsear
  if (typeof result === "string") {
    try { return JSON.parse(result) as T; } catch { return result as T; }
  }
  // 2) Alguns setups retornam o envelope { value: "...", ex: 60 }
  if (result && typeof result === "object" && "value" in result) {
    const inner = (result as any).value;
    if (typeof inner === "string") {
      try { return JSON.parse(inner) as T; } catch { return inner as T; }
    }
    return inner as T;
  }
  // 3) Como último recurso, devolve o que veio
  return result as T;
}

function upstashStore(url: string, token: string): Store {
  console.log("[STORE] usando Upstash REST.");
  return {
    async get<T>(key: string): Promise<T | undefined> {
      try {
        const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!r.ok) {
          console.error("[UPSTASH][GET] HTTP", r.status, await r.text());
          return undefined;
        }
        const { result } = await r.json();
        if (result == null) return undefined;
        const parsed = parseUpstashResult<T>(result);
        return parsed;
      } catch (e) {
        console.error("[UPSTASH][GET] erro:", e);
        return undefined;
      }
    },
    async set<T>(key: string, value: T, ttlSec = DRAFT_TTL): Promise<void> {
      try {
        // API REST oficial aceita POST /set/{key} com body { value, ex }
        const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ value: JSON.stringify(value), ex: ttlSec }),
        });
        if (!r.ok) {
          console.error("[UPSTASH][SET] HTTP", r.status, await r.text());
        }
      } catch (e) {
        console.error("[UPSTASH][SET] erro:", e);
      }
    }
  };
}

const store: Store = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? upstashStore(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN)
  : inMemoryStore();

const draftKey = (chatId: number) => `ecoleta:draft:${chatId}`;

async function getDraft(chatId: number): Promise<Draft> {
  const d = await store.get<Draft>(draftKey(chatId));
  return d ?? { step: "name", user: {}, address: {}, schedule: {} };
}
async function setDraft(chatId: number, draft: Draft) {
  await store.set(draftKey(chatId), draft, DRAFT_TTL);
}
async function mergeDraft(chatId: number, partial: Partial<Draft>) {
  const d = await getDraft(chatId);
  const nd = { ...d, ...partial };
  console.log("[DRAFT] chat", chatId, "merge", { from: d.step, to: nd.step, hasUser: !!nd.user?.name, hasCPF: !!nd.user?.cpf, hasPhone: !!nd.user?.phone, hasItem: !!nd.item, qty: nd.qty, hasCEP: !!nd.address?.cep });
  await setDraft(chatId, nd);
  return nd;
}

// ---------- EN -> PT ----------
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

const bot = new Bot(token);

// ---------- helpers HTTP/IA ----------
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
    headers, timeout: 20000, maxBodyLength: Infinity,
  });
  return data.topk as Pred[];
}

const onlyDigits = (s: string) => (s || "").replace(/\D/g, "");
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
const isValidPhone = (p: string) => {
  const d = onlyDigits(p);
  return d.length === 10 || d.length === 11;
};

type ViaCEP = { cep?: string; logradouro?: string; bairro?: string; localidade?: string; uf?: string; complemento?: string; erro?: boolean; };
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
  ].filter(Boolean) as string[];
  return parts.join(" • ");
}

const TIME_SLOTS = ["09:00", "11:00", "14:00", "16:00", "18:00"];
function nextDays(n = 7) {
  const out: { iso: string; label: string }[] = [];
  const fmt = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
  for (let i = 0; i < n; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    out.push({ iso: d.toISOString().slice(0, 10), label: fmt.format(d) });
  }
  return out;
}
function kbDays() {
  const kb = new InlineKeyboard();
  for (const d of nextDays(7)) kb.text(d.label, `day:${d.iso}`).row();
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
  kb.text("7–9", "qty:range").text("10+", "qty:other");
  return kb;
}
function kbConfirm(labelPT: string) {
  return new InlineKeyboard()
    .text(`✅ Sim, é ${labelPT}`, "confirm:yes").row()
    .text("❌ Não, enviar outra foto", "confirm:no");
}

// ---------- fluxo ----------
bot.command("cancel", async (ctx) => {
  await setDraft(ctx.chat!.id, { step: "name", user: {}, address: {}, schedule: {} });
  await ctx.reply("Fluxo cancelado. Envie /start para começar novamente.");
});

bot.command("start", async (ctx) => {
  await setDraft(ctx.chat!.id, { step: "name", user: {}, address: {}, schedule: {} });
  await ctx.reply("Olá! Eu sou o bot da E-Coleta ♻️\n\nVamos começar com seus dados.\n\n👉 *Seu nome completo?*", {
    parse_mode: "Markdown",
  });
});

bot.command("help", (ctx) =>
  ctx.reply("Comandos: /start, /cancel.\nFluxo: Nome → CPF → Telefone → Foto/Arquivo → Confirmação → Quantidade → CEP → Número → Data/Hora.")
);

// DEBUG para ver envs/estado
bot.command("debug", async (ctx) => {
  const chatId = ctx.chat!.id;
  const d = await getDraft(chatId);
  const hasUrl = !!process.env.UPSTASH_REDIS_REST_URL;
  const hasTok = !!process.env.UPSTASH_REDIS_REST_TOKEN;
  const storeType = hasUrl && hasTok ? "upstash" : "memory";
  await ctx.reply(
    [
      `Store: ${storeType}`,
      `Env URL: ${hasUrl ? "ok" : "missing"}`,
      `Env TOKEN: ${hasTok ? "ok" : "missing"}`,
      `Step atual: ${d.step}`,
      `Tem user? ${d.user?.name ? "sim" : "não"}`,
      `Tem item? ${d.item ? "sim" : "não"}`,
      `Tem qty? ${d.qty ?? "não"}`,
      `Tem CEP? ${d.address?.cep ? "sim" : "não"}`
    ].join("\n")
  );
});

// KVTEST para testar Upstash set/get
bot.command("kvtest", async (ctx) => {
  const key = `ecoleta:test:${Date.now()}`;
  const value = { ok: true, ts: Date.now() };
  try {
    await store.set(key, value, 60);
    const got = await store.get<typeof value>(key);
    await ctx.reply(`KVTEST: set/get OK\nchave=${key}\nvalor=${JSON.stringify(got)}`);
  } catch (e: any) {
    await ctx.reply(`KVTEST: erro ${e?.message || e}`);
  }
});

// processa imagem
async function handleImage(chatId: number, fileId: string) {
  try { await bot.api.sendChatAction(chatId, "typing"); } catch {}
  const [buf, url] = await Promise.all([getFileBuffer(fileId), getFileUrl(fileId)]);
  const preds = await classifyImage(buf, 1);
  if (!preds.length) throw new Error("Sem predições");
  const top = preds[0];

  await mergeDraft(chatId, { latestFileId: fileId, latestFileUrl: url, item: top, step: "await_confirm" as const });

  const labelPT = toPT(top.label);
  return { text: `Detectei: *${labelPT}*.\nEstá correto?`, kb: kbConfirm(labelPT) };
}

// FOTO: se dados faltarem, guardo a foto e sigo pedindo os dados
bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat!.id;
  const d = await getDraft(chatId);
  const best = ctx.message.photo.at(-1)!;

  await mergeDraft(chatId, { latestFileId: best.file_id }); // guarda a foto sempre

  if (!d.user?.name) {
    return ctx.reply("Antes de processar a foto, me informe seu *Nome completo*.", { parse_mode: "Markdown" });
  }
  if (!d.user?.cpf) {
    return ctx.reply("Agora, informe seu *CPF* (somente números).", { parse_mode: "Markdown" });
  }
  if (!d.user?.phone) {
    return ctx.reply("Perfeito. Informe seu *telefone com DDD* (ex.: 11987654321).", { parse_mode: "Markdown" });
  }

  try {
    const { text, kb } = await handleImage(chatId, best.file_id);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  } catch (e: any) {
    console.error(e);
    const msg = e?.code === "ECONNABORTED"
      ? "⏱️ O servidor de IA demorou para responder. Tente novamente ou envie como *Arquivo* (sem compressão)."
      : "❌ Não consegui processar. Tente enviar como *Arquivo* (sem compressão).";
    await ctx.reply(msg, { parse_mode: "Markdown" });
  }
});

// DOCUMENTO (imagem como arquivo)
bot.on("message:document", async (ctx) => {
  const chatId = ctx.chat!.id;
  const d = await getDraft(chatId);
  const doc = ctx.message.document;

  if (!doc.mime_type?.startsWith("image/")) {
    return ctx.reply("Envie um *arquivo de imagem* (JPG/PNG).", { parse_mode: "Markdown" });
  }

  await mergeDraft(chatId, { latestFileId: doc.file_id }); // guarda a foto sempre

  if (!d.user?.name) {
    return ctx.reply("Antes de processar a foto, me informe seu *Nome completo*.", { parse_mode: "Markdown" });
  }
  if (!d.user?.cpf) {
    return ctx.reply("Agora, informe seu *CPF* (somente números).", { parse_mode: "Markdown" });
  }
  if (!d.user?.phone) {
    return ctx.reply("Perfeito. Informe seu *telefone com DDD* (ex.: 11987654321).", { parse_mode: "Markdown" });
  }

  try {
    const { text, kb } = await handleImage(chatId, doc.file_id);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  } catch (e: any) {
    console.error(e);
    const msg = e?.code === "ECONNABORTED"
      ? "⏱️ O servidor de IA demorou para responder. Tente novamente ou envie como *Arquivo* (sem compressão)."
      : "❌ Não consegui baixar/processar o arquivo. Tente novamente.";
    await ctx.reply(msg, { parse_mode: "Markdown" });
  }
});

// CALLBACKS
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data ?? "";
  try { await ctx.answerCallbackQuery(); } catch {}

  const [key, ...rest] = data.split(":");
  const payload = rest.join(":");
  const chatId = ctx.chat!.id;
  const d = await getDraft(chatId);

  // Confirmação da classe
  if (key === "confirm") {
    if (payload === "yes") {
      await mergeDraft(chatId, { step: "await_qty" as const });
      return ctx.editMessageText("Perfeito! Quantas unidades você deseja descartar?", {
        parse_mode: "Markdown", reply_markup: kbQty(),
      });
    }
    if (payload === "no") {
      await mergeDraft(chatId, { item: undefined, step: "await_photo" as const });
      return ctx.editMessageText("Sem problemas. Envie outra *foto* do item (de preferência como *Arquivo* para melhor qualidade).", {
        parse_mode: "Markdown",
      });
    }
  }

  // Quantidade
  if (key === "qty") {
    if (payload === "other" || payload === "range") {
      await mergeDraft(chatId, { step: "await_qty" as const });
      return ctx.editMessageText("Digite a *quantidade* (número inteiro):", { parse_mode: "Markdown" });
    }
    const q = Math.max(1, Math.min(999, Number(payload)));
    await mergeDraft(chatId, { qty: q, step: "await_cep" as const });
    return ctx.editMessageText(`Ok! Quantidade: *${q}*.\nAgora, informe seu *CEP* (somente números).`, { parse_mode: "Markdown" });
  }

  if (key === "back" && payload === "days") {
    return ctx.editMessageReplyMarkup({ reply_markup: kbDays() });
  }

  if (key === "day") {
    const dayISO = payload;
    await mergeDraft(chatId, { schedule: { ...(d.schedule || {}), day: dayISO }, step: "await_time" as const });
    return ctx.editMessageText("Escolha um horário:", { reply_markup: kbTimes(dayISO) });
  }

  if (key === "time") {
    const iso = payload;           // ex: 2025-09-16T14:00
    const [dayISO, time] = iso.split("T");
    const nd = await mergeDraft(chatId, { schedule: { day: dayISO, time } });

    // Guardas contra estado perdido
    if (!nd.user?.name || !nd.user?.cpf || !nd.user?.phone || !nd.item || !nd.qty || !nd.address?.cep) {
      return ctx.editMessageText(
        "Quase lá! Parece que o servidor reiniciou e perdi parte do estado.\n\n" +
        "👉 Envie /start para reiniciar rapidamente, ou reenvie o CEP para retomarmos o passo atual."
      );
    }

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
      `• Data/Hora: *${new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(new Date(dayISO))} às *${time}*`,
      "",
      "_(Aviso: em ambiente serverless o estado pode reiniciar no cold start.)_",
    ].join("\n");

    return ctx.editMessageText(resumo, { parse_mode: "Markdown" });
  }

  if (key === "cancel") {
    await setDraft(chatId, { step: "name", user: {}, address: {}, schedule: {} });
    return ctx.editMessageText("Fluxo cancelado. Envie /start para começar novamente.");
  }
});

// TEXTO: dados do usuário, qty manual, CEP, número
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat!.id;
  const txt = (ctx.message.text || "").trim();
  const d = await getDraft(chatId);

  // nome -> cpf -> phone
  if (d.step === "name" || !d.user?.name) {
    await mergeDraft(chatId, { user: { ...(d.user || {}), name: txt }, step: "cpf" as const });
    return ctx.reply("Ótimo! Agora informe seu *CPF* (somente números).", { parse_mode: "Markdown" });
  }

  if (d.step === "cpf" || (!d.user?.cpf && d.user?.name)) {
    const cpf = onlyDigits(txt);
    if (!isValidCPF(cpf)) {
      return ctx.reply("CPF inválido. Tente novamente (somente números).");
    }
    const cpfFmt = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
    await mergeDraft(chatId, { user: { ...(d.user || {}), cpf: cpfFmt }, step: "phone" as const });
    return ctx.reply("Perfeito. Informe seu *telefone com DDD* (ex.: 11987654321).", { parse_mode: "Markdown" });
  }

  if (d.step === "phone" || (!d.user?.phone && d.user?.cpf)) {
    if (!isValidPhone(txt)) {
      return ctx.reply("Telefone inválido. Envie no formato com DDD (ex.: 11987654321).");
    }
    const digits = onlyDigits(txt);
    const fmt = digits.length === 11
      ? digits.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3")
      : digits.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
    const nd = await mergeDraft(chatId, { user: { ...(d.user || {}), phone: fmt }, step: "await_photo" as const });

    // se já tinha foto guardada, processa direto
    if (nd.latestFileId) {
      try {
        const { text, kb } = await handleImage(chatId, nd.latestFileId);
        return ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
      } catch (e: any) {
        console.error(e);
        const msg = e?.code === "ECONNABORTED"
          ? "⏱️ O servidor de IA demorou para responder. Tente novamente ou envie como *Arquivo* (sem compressão)."
          : "Recebi seus dados! Agora envie uma *foto* do item (ou *Arquivo* para melhor qualidade).";
        return ctx.reply(msg, { parse_mode: "Markdown" });
      }
    }
    return ctx.reply("Dados salvos! ✅ Agora, envie uma *foto* do item (ou como *Arquivo* para melhor qualidade).", { parse_mode: "Markdown" });
  }

  // quantidade manual
  if (d.step === "await_qty" && d.item && !d.qty) {
    const q = Number(onlyDigits(txt));
    if (!Number.isFinite(q) || q <= 0) return ctx.reply("Quantidade inválida. Envie um número inteiro maior que 0.");
    await mergeDraft(chatId, { qty: Math.min(999, q), step: "await_cep" as const });
    return ctx.reply("Agora, informe seu *CEP* (somente números).", { parse_mode: "Markdown" });
  }

  // CEP -> ViaCEP -> número
  if (d.step === "await_cep" && d.item && d.qty && !d.address?.cep) {
    const cep = onlyDigits(txt);
    if (cep.length !== 8) return ctx.reply("CEP inválido. Envie 8 dígitos (ex.: 01001000).");
    try {
      const via = await fetchViaCEP(cep);
      if (via.erro) return ctx.reply("CEP não encontrado. Verifique e envie novamente.");
      const addr: Address = {
        cep: via.cep, logradouro: via.logradouro, bairro: via.bairro,
        localidade: via.localidade, uf: via.uf, complemento: via.complemento,
      };
      await mergeDraft(chatId, { address: addr, step: "await_number" as const });
      return ctx.reply(
        [
          "Endereço encontrado pelo CEP:",
          `• ${formatAddressPT(addr)}`,
          "",
          "👉 Informe o *número* da residência (e complemento se houver)."
        ].join("\n"),
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.error(e);
      return ctx.reply("Falha ao consultar o CEP. Tente novamente em instantes.");
    }
  }

  if (d.step === "await_number" && d.item && d.qty && d.address?.cep) {
    const m = txt.match(/^\s*(\d+)\s*(.*)$/);
    if (!m) return ctx.reply("Informe o número (ex.: 123) e, opcionalmente, complemento (ex.: 123, apto 45).");
    const numero = m[1]; const complemento = m[2]?.trim() || undefined;
    const addr = { ...(d.address || {}), numero, complemento };
    await mergeDraft(chatId, { address: addr, step: "await_day" as const });
    return ctx.reply(`Endereço completo:\n*${formatAddressPT(addr)}*\n\nAgora, escolha a *data* da coleta:`, {
      parse_mode: "Markdown", reply_markup: kbDays()
    });
  }

  // fora do fluxo
  if (!d.step) {
    return ctx.reply("Envie /start para iniciar o fluxo de agendamento. 😉");
  }
  return ctx.reply("Beleza! Siga as instruções acima ou envie /cancel para recomeçar.");
});

// log de erros
bot.catch((err) => console.error("Erro no bot:", err));

// webhook (Vercel/Render)
export default webhookCallback(bot, "http");
