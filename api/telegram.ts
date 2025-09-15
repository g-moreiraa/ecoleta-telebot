// api/telegram.ts
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import axios from "axios";
import FormData from "form-data";

// (opcional, dá mais tempo e força Node no Vercel)
export const config = { runtime: "nodejs", maxDuration: 10 };

const token = process.env.TELEGRAM_TOKEN!;
const PREDICT_URL = process.env.PREDICT_URL!;
const API_KEY = process.env.API_KEY || "";

type Pred = { label: string; score: number };
type Draft = { item?: Pred; cep?: string; when?: string; latestFileId?: string; latestFileUrl?: string };

const drafts = new Map<number, Draft>();

if (!token) throw new Error("TELEGRAM_TOKEN ausente");
if (!PREDICT_URL) throw new Error("PREDICT_URL ausente");

const bot = new Bot(token);

// ===== mapa EN → PT =====
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

// ===== helpers =====
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

// ===== comandos =====
bot.command("start", (ctx) =>
  ctx.reply(
    "Olá! Eu sou o bot da E-Coleta ♻️\nEnvie uma *foto* (ou *Arquivo*) do lixo eletrônico.",
    { parse_mode: "Markdown" }
  )
);
bot.command("help", (ctx) => ctx.reply("Comandos: /start, /help. Envie foto/arquivo de imagem."));

async function handleImage(chatId: number, fileId: string) {
  const [buf, url] = await Promise.all([getFileBuffer(fileId), getFileUrl(fileId)]);
  const preds = await classifyImage(buf, 1);
  if (!preds.length) throw new Error("Sem predições");

  const top = preds[0]; // apenas 1 sugestão
  drafts.set(chatId, { ...(drafts.get(chatId) || {}), latestFileId: fileId, latestFileUrl: url, item: top });

  const kb = new InlineKeyboard()
    .text("Sim", `yes:${top.label}`)
    .text("Não", "no");

  // Sem porcentagem e com nome em PT
  return { text: `Detectei: *${toPT(top.label)}*. Está correto?`, kb };
}

bot.on("message:photo", async (ctx) => {
  try {
    const best = ctx.message.photo.at(-1)!;
    const { text, kb } = await handleImage(ctx.chat!.id, best.file_id);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Não consegui processar. Tente enviar como *Arquivo* (sem compressão).", { parse_mode: "Markdown" });
  }
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith("image/")) {
    return ctx.reply("Envie um *arquivo de imagem* (JPG/PNG).", { parse_mode: "Markdown" });
  }
  try {
    const { text, kb } = await handleImage(ctx.chat!.id, doc.file_id);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Não consegui baixar/processar o arquivo. Tente novamente.");
  }
});

// ===== confirmações =====
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data === "no") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Beleza. Mande outra foto (de outro ângulo) ou outro item.");
    drafts.set(ctx.chat!.id, {});
    return;
  }
  if (data.startsWith("yes:")) {
    const [, labelEN] = data.split(":");
    await ctx.answerCallbackQuery({ text: "Confirmado" });

    // Mostra o nome PT sem porcentagem
    await ctx.editMessageText(`✅ Item confirmado: *${toPT(labelEN)}*`, { parse_mode: "Markdown" });

    const old = drafts.get(ctx.chat!.id) || {};
    drafts.set(ctx.chat!.id, { ...old, item: { label: labelEN, score: 1 } }); // score não exibido
    await ctx.reply("📍 Informe seu *CEP* (somente números).", { parse_mode: "Markdown" });
  }
});

// ===== fluxo de texto (CEP e data/hora) =====
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const draft = drafts.get(chatId) || {};
  const txt = ctx.message.text.trim();

  if (!draft.item) {
    return ctx.reply("Antes, envie uma *foto* do item para identificação.", { parse_mode: "Markdown" });
  }
  if (!draft.cep) {
    const cep = txt.replace(/\D/g, "");
    if (cep.length < 8) return ctx.reply("CEP inválido. Envie somente números (ex.: 01001000).");
    drafts.set(chatId, { ...draft, cep });
    return ctx.reply("🗓️ Agora me diga *data e horário* (ex.: 25/09 às 14h).", { parse_mode: "Markdown" });
  }
  if (!draft.when) {
    const when = txt;
    drafts.set(chatId, { ...draft, when });

    await ctx.reply(
      [
        "✅ *Pedido de coleta registrado!*",
        `• Item: *${toPT(draft.item.label)}*`,
        `• CEP: *${draft.cep}*`,
        `• Quando: *${when}*`,
        "",
        "_(Demo serverless: estado pode reiniciar no cold start.)_",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );

    drafts.set(chatId, {}); // limpa estado
  }
});

// Exporta handler do webhook (Vercel)
export default webhookCallback(bot, "http");
