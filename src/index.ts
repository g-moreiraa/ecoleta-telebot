import { Bot, InlineKeyboard } from "grammy";
import * as dotenv from "dotenv";
import axios from "axios";
import FormData from "form-data";

dotenv.config();

const token = process.env.TELEGRAM_TOKEN;
const PREDICT_URL = process.env.PREDICT_URL || "http://localhost:8000/predict";
if (!token) throw new Error("Defina TELEGRAM_TOKEN no .env");

type Pred = { label: string; score: number };
type Draft = { item?: Pred; cep?: string; when?: string };

const bot = new Bot(token);
const drafts = new Map<number, Draft>(); // chatId -> draft

// -------- helpers --------
async function getFileBuffer(fileId: string): Promise<Buffer> {
  const f = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${token}/${f.file_path}`;
  const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer" });
  return Buffer.from(resp.data as any);
}

async function classifyImage(bytes: Buffer, topk = 3): Promise<Pred[]> {
  const form = new FormData();
  form.append("file", bytes, { filename: "photo.jpg", contentType: "image/jpeg" });

  const res = await axios.post(`${PREDICT_URL}?topk=${topk}`, form as any, {
    headers: form.getHeaders(),
    timeout: 20000,
    maxBodyLength: Infinity,
  });
  return res.data.topk as Pred[];
}

// -------- commands --------
bot.command("start", async (ctx) => {
  await ctx.reply(
    "Olá! Eu sou o bot da E-Coleta ♻️\n" +
      "Envie uma *foto* (ou *Arquivo* p/ melhor qualidade) do lixo eletrônico.\n" +
      "Vou reconhecer o item e você já agenda a coleta.",
    { parse_mode: "Markdown" }
  );
});

bot.command("help", (ctx) =>
  ctx.reply("Comandos: /start, /help. Envie uma *foto* ou *arquivo de imagem*.", { parse_mode: "Markdown" })
);

// -------- photo handler --------
bot.on("message:photo", async (ctx) => {
  try {
    if (!ctx.chat) return;
    const best = ctx.message.photo.at(-1)!; // maior resolução
    const buf = await getFileBuffer(best.file_id);
    const preds = await classifyImage(buf, 3);

    const kb = new InlineKeyboard();
    preds.forEach((p, i) =>
      kb.text(`${i + 1}. ${p.label} (${(p.score * 100).toFixed(1)}%)`, `confirm:${p.label}:${p.score}`).row()
    );
    kb.text("Nenhum desses", "confirm:none");

    await ctx.reply("Top-3 que encontrei. Qual está correto?", { reply_markup: kb });
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Não consegui processar a imagem. Tente enviar como *Arquivo* (sem compressão).", {
      parse_mode: "Markdown",
    });
  }
});

// -------- document handler (imagem como arquivo) --------
bot.on("message:document", async (ctx) => {
  if (!ctx.chat) return;
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith("image/")) {
    return ctx.reply("Envie um *arquivo de imagem* (JPG/PNG).", { parse_mode: "Markdown" });
  }
  try {
    const buf = await getFileBuffer(doc.file_id);
    const preds = await classifyImage(buf, 3);

    const kb = new InlineKeyboard();
    preds.forEach((p, i) =>
      kb.text(`${i + 1}. ${p.label} (${(p.score * 100).toFixed(1)}%)`, `confirm:${p.label}:${p.score}`).row()
    );
    kb.text("Nenhum desses", "confirm:none");

    await ctx.reply("Top-3 que encontrei. Qual está correto?", { reply_markup: kb });
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Não consegui baixar/processar o arquivo. Tente novamente.");
  }
});

// -------- callback para confirmação --------
bot.on("callback_query:data", async (ctx) => {
  try {
    if (!ctx.chat) return;
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("confirm:")) return;

    if (data === "confirm:none") {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("Beleza. Pode mandar outra foto (de outro ângulo) ou outro item.");
      drafts.set(ctx.chat.id, {});
      return;
    }

    const [, label, scoreStr] = data.split(":");
    const score = Number(scoreStr);

    await ctx.answerCallbackQuery({ text: `Selecionado: ${label}` });
    await ctx.editMessageText(`✅ Item confirmado: *${label}* (${(score * 100).toFixed(1)}%)`, { parse_mode: "Markdown" });

    drafts.set(ctx.chat.id, { item: { label, score } });
    await ctx.reply("📍 Informe seu *CEP* (somente números).", { parse_mode: "Markdown" });
  } catch (e) {
    console.error(e);
  }
});

// -------- fluxo de texto (CEP e data/hora) --------
bot.on("message:text", async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const draft = drafts.get(chatId) || {};
  const txt = ctx.message.text.trim();

  if (!draft.item) {
    return ctx.reply("Antes, envie uma *foto* do item para identificação.", { parse_mode: "Markdown" });
  }

  if (!draft.cep) {
    const cep = txt.replace(/\D/g, "");
    if (cep.length < 8) return ctx.reply("CEP inválido. Envie somente números (ex.: 01001000).");
    draft.cep = cep;
    drafts.set(chatId, draft);
    return ctx.reply("🗓️ Agora me diga *data e horário desejados* (ex.: 25/09 às 14h).", { parse_mode: "Markdown" });
  }

  if (!draft.when) {
    draft.when = txt;
    drafts.set(chatId, draft);

    await ctx.reply(
      [
        "✅ *Pedido de coleta registrado!*",
        `• Item: *${draft.item.label}* (${(draft.item.score * 100).toFixed(1)}%)`,
        `• CEP: *${draft.cep}*`,
        `• Quando: *${draft.when}*`,
        "",
        "_Obs.: rascunho em memória. Depois conectamos a um banco/planilha e envio de confirmação._",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );

    drafts.set(chatId, {}); // limpa
  }
});

// -------- start --------
bot.catch((err) => console.error("Erro no bot:", err));
bot.start();
console.log("🤖 Bot rodando (long polling). Envie /start no Telegram.");
