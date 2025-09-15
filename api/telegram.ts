import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import axios from "axios";
import FormData from "form-data";

const token = process.env.TELEGRAM_TOKEN!;
const PREDICT_URL = process.env.PREDICT_URL!;
const API_KEY = process.env.API_KEY || "";

type Pred = { label: string; score: number };
type Draft = { item?: Pred; cep?: string; when?: string; latestFileId?: string; latestFileUrl?: string };
const drafts = new Map<number, Draft>();

if (!token) throw new Error("TELEGRAM_TOKEN ausente");
if (!PREDICT_URL) throw new Error("PREDICT_URL ausente");

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
async function classifyImage(bytes: Buffer, topk = 3): Promise<Pred[]> {
  const form = new FormData();
  form.append("file", bytes, { filename: "photo.jpg", contentType: "image/jpeg" });
  const headers: Record<string, string> = { ...(form.getHeaders?.() || {}) };
  if (API_KEY) headers["X-API-Key"] = API_KEY;

  const { data } = await axios.post(`${PREDICT_URL}?topk=${topk}`, form as any, {
    headers, timeout: 20000, maxBodyLength: Infinity,
  });
  return data.topk as Pred[];
}

// comandos
bot.command("start", (ctx) =>
  ctx.reply(
    "Olá! Eu sou o bot da E-Coleta ♻️\nEnvie uma *foto* (ou *Arquivo*) do lixo eletrônico.",
    { parse_mode: "Markdown" }
  )
);
bot.command("help", (ctx) => ctx.reply("Comandos: /start, /help. Envie foto/arquivo de imagem."));

bot.on("message:photo", async (ctx) => {
  try {
    const best = ctx.message.photo.at(-1)!;
    const [buf, url] = await Promise.all([getFileBuffer(best.file_id), getFileUrl(best.file_id)]);
    const preds = await classifyImage(buf, 3);
    drafts.set(ctx.chat!.id, { ...(drafts.get(ctx.chat!.id) || {}), latestFileId: best.file_id, latestFileUrl: url });

    const kb = new InlineKeyboard();
    preds.forEach((p, i) => kb.text(`${i + 1}. ${p.label} (${(p.score * 100).toFixed(1)}%)`, `confirm:${p.label}:${p.score}`).row());
    kb.text("Nenhum desses", "confirm:none");
    await ctx.reply("Top-3 que encontrei. Qual está correto?", { reply_markup: kb });
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Não consegui processar. Tente enviar como *Arquivo*.", { parse_mode: "Markdown" });
  }
});

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith("image/")) {
    return ctx.reply("Envie um *arquivo de imagem* (JPG/PNG).", { parse_mode: "Markdown" });
  }
  try {
    const [buf, url] = await Promise.all([getFileBuffer(doc.file_id), getFileUrl(doc.file_id)]);
    const preds = await classifyImage(buf, 3);
    drafts.set(ctx.chat!.id, { ...(drafts.get(ctx.chat!.id) || {}), latestFileId: doc.file_id, latestFileUrl: url });

    const kb = new InlineKeyboard();
    preds.forEach((p, i) => kb.text(`${i + 1}. ${p.label} (${(p.score * 100).toFixed(1)}%)`, `confirm:${p.label}:${p.score}`).row());
    kb.text("Nenhum desses", "confirm:none");
    await ctx.reply("Top-3 que encontrei. Qual está correto?", { reply_markup: kb });
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Não consegui baixar/processar o arquivo. Tente novamente.");
  }
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("confirm:")) return;

  if (data === "confirm:none") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Beleza. Mande outra foto (outro ângulo) ou outro item.");
    drafts.set(ctx.chat!.id, {});
    return;
  }

  const [, label, scoreStr] = data.split(":");
  const score = Number(scoreStr);
  await ctx.answerCallbackQuery({ text: `Selecionado: ${label}` });
  await ctx.editMessageText(`✅ Item confirmado: *${label}* (${(score * 100).toFixed(1)}%)`, { parse_mode: "Markdown" });

  const old = drafts.get(ctx.chat!.id) || {};
  drafts.set(ctx.chat!.id, { ...old, item: { label, score } });
  await ctx.reply("📍 Informe seu *CEP* (somente números).", { parse_mode: "Markdown" });
});

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
        `• Item: *${draft.item.label}* (${(draft.item.score * 100).toFixed(1)}%)`,
        `• CEP: *${draft.cep}*`,
        `• Quando: *${when}*`,
        "",
        "_(Demo serverless: estado pode reiniciar no cold start.)_"
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    drafts.set(chatId, {});
  }
});

// Exporta handler do webhook
export default webhookCallback(bot, "http");
