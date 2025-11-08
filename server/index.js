// === server/index.js (backend gate; VT18 required; 18.4 ignored; iPad desktop/MacIntel OK; JB logic; multi-chat)
// Extended reasons + anti-shortcut/bypass reporting + RU/EN localization

import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

// Node 18+: fetch/FormData/Blob must exist
if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
  throw new Error('Node 18+ with global fetch/FormData/Blob is required');
}

// ==== ENV ====
const BOT_TOKEN        = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const STATIC_ORIGIN    = (process.env.STATIC_ORIGIN || '*').trim();
const PUBLIC_BASE      = (process.env.PUBLIC_BASE || STATIC_ORIGIN).replace(/\/+$/, '');
const ADMIN_API_SECRET = (process.env.ADMIN_API_SECRET || '').trim();
const DB_PATH          = (process.env.DB_PATH || './data/links.db').trim();
const PORT             = Number(process.env.PORT || 10000);
const REPORT_LANG      = (process.env.REPORT_LANG || 'both').toLowerCase(); // 'ru' | 'en' | 'both'

// ==== i18n helper ====
function tr(ru, en) {
  switch (REPORT_LANG) {
    case 'ru':   return ru;
    case 'en':   return en;
    default:     return `${ru} / ${en}`;
  }
}

// ==== Paths / Static ====
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

// ==== App ====
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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

// single mapping (compat)
db.prepare(`
  CREATE TABLE IF NOT EXISTS user_codes (
    code       TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`).run();

// multi mapping
db.prepare(`
  CREATE TABLE IF NOT EXISTS user_code_map (
    code       TEXT NOT NULL,
    chat_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (code, chat_id)
  );
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_code_map_code ON user_code_map(code);`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_code_map_chat ON user_code_map(chat_id);`).run();

// ==== helpers ====
function requireAdminSecret(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!ADMIN_API_SECRET || auth !== `Bearer ${ADMIN_API_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

function escapeHTML(s = '') {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
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

function safeJson(obj, space = 0) {
  try { return JSON.stringify(obj, null, space); }
  catch { return String(obj); }
}

const OK = (b) => b ? '✅' : '❌';

function normVer(maybe) {
  if (typeof maybe === 'number') return maybe;
  if (typeof maybe === 'string') {
    const v = parseFloat(maybe.replace(/[^0-9.]/g,''));
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

function parseIOSMajorFromUAUniversal(ua = '') {
  ua = String(ua || '');
  const mOS = ua.match(/\bOS\s+(\d+)[._]/i);
  if (mOS) return parseInt(mOS[1], 10);
  const mVer = ua.match(/\bVersion\/(\d+)(?:[._]\d+)?/i);
  if (mVer) return parseInt(mVer[1], 10);
  return null;
}

// ignore some test schemes
const IGNORE_SCHEMES = [/^custom:/i, /^mytest:/i];
function isIgnoredScheme(s = '') {
  return IGNORE_SCHEMES.some(rx => rx.test(String(s)));
}

// iPad desktop mode
function isIpadDesktop({ platform, userAgent, cp }) {
  const plat = String(platform || '');
  const ua   = String(userAgent || '');
  const touch = Number(cp?.maxTouchPoints ?? cp?.navigator?.maxTouchPoints ?? 0);
  const flagIpad = cp?.isIpad === true || /iPad/i.test(ua);
  const isMacPlat = /MacIntel/i.test(plat) || /\bMac\b/i.test(plat);
  return isMacPlat && (touch > 1 || flagIpad);
}

// iOS version detection
function pickIosVersion(iosVersion, cp, userAgent, platform) {
  const candidates = [
    iosVersion,
    cp?.iosVersion,
    cp?.ios?.version,
    cp?.os?.iosVersion,
    cp?.device?.iOSVersion
  ].filter(v => v != null);

  for (const v of candidates) {
    const n = normVer(v);
    if (n != null) return n;
  }

  const plat = String(platform || '');
  if (/MacIntel/i.test(plat)) {
    const n = parseIOSMajorFromUAUniversal(String(userAgent || ''));
    if (n != null) return n;
  }
  return null;
}

// featuresSummary: VT18 required; 18.4 ignored for allow
function normalizeFeatures_Strict18Only(featuresSummary) {
  const fv = featuresSummary || {};
  const tag = (x) => (x === true || String(x).toLowerCase() === 'ok') ? 'ok' : '—';
  const VT18 = tag(fv.VT18 ?? fv.vt18 ?? fv.viewTransitions);
  const V184 = tag(fv.v18_4 ?? fv.v184 ?? fv.triple18_4 ?? fv.shape_cookie_webauthn);
  return { VT18, v18_4: V184, ok: (VT18 === 'ok') };
}

// base status
function deriveStatus({ iosVersion, platform, userAgent, cp = {}, dc = {}, features }) {
  const v = pickIosVersion(iosVersion, cp, userAgent, platform);
  const iosOk = v != null && v >= 18;

  const plat = String(platform || '');
  const classicOk     = /iPhone|iPad/i.test(plat);
  const ipadDesktopOk = isIpadDesktop({ platform: plat, userAgent, cp });
  const macIntelOk    = /MacIntel/i.test(plat);
  const platformOk    = classicOk || ipadDesktopOk || macIntelOk;

  const jb            = cp?.jbProbesActive || {};
  const jbRowsRaw     = Array.isArray(jb.results) ? jb.results : [];
  const jbRows        = jbRowsRaw.filter(r => !isIgnoredScheme(r?.scheme));
  const anyOpened     = jbRows.some(r => r?.opened === true);

  const labelRaw      = String(jb?.summary?.label || '').toLowerCase();
  const labelsClean   = new Set(['', 'n/a', 'negative', 'unlikely', 'none', 'clean', 'no', 'absent']);
  const jbOk          = !anyOpened && labelsClean.has(labelRaw);
  const jbLabel       = jbOk ? (labelRaw || 'negative') : (labelRaw || 'positive');

  const dcWords = Array.isArray(cp?.dcIspKeywords) ? cp.dcIspKeywords.join(',') : '';
  const dcOk    = !dcWords;

  const perms  = cp?.permissions || {};
  const geoOk  = perms.geolocation === 'granted' || perms.geolocation === true;
  const camOk  = perms.camera === 'granted' || perms.camera === true;
  const micOk  = perms.microphone === 'granted' || perms.microphone === true;

  const featuresOk = features ? !!features.ok : true;

  const canLaunch = iosOk && platformOk && jbOk && featuresOk;

  return {
    iosOk, platformOk, jbOk, dcOk, geoOk, camOk, micOk,
    featuresOk, features,
    jbLabel, dcWords, canLaunch,
    iosVersionDetected: v,
    ipadDesktopOk,
    macIntelOk,
    _jb: { rows: jbRows, rowsRaw: jbRowsRaw, anyOpened }
  };
}

// === Extended flags & reasons ===
function getJbSchemesFromProfile(cp = {}) {
  const jb = cp.jbProbesActive || cp.jb || {};
  const arr = Array.isArray(jb.results) ? jb.results : [];
  const res = [];
  for (const r of arr) {
    if (!r) continue;
    const scheme = String(r.scheme || '').trim();
    if (!scheme || isIgnoredScheme(scheme)) continue;
    if (r.opened) res.push(scheme);
  }
  return res;
}

function buildFlags(cp = {}, dc = {}, status = {}) {
  const flags = {};

  flags.jbSchemes = getJbSchemesFromProfile(cp);

  flags.automation = !!(
    dc.automation ||
    cp.automation ||
    dc.flags?.includes?.('automation') ||
    cp.shortcutUsed ||
    cp.shortCapUsed
  );

  flags.webApiPatched = !!(
    dc.webApiPatched ||
    cp.webApiPatched ||
    dc.flags?.includes?.('web_api_patched') ||
    cp.modifiedWebApi
  );

  flags.devtoolsLike = !!(
    dc.devtoolsLike ||
    cp.devtoolsLike ||
    dc.flags?.includes?.('devtools') ||
    status.devtoolsLike
  );

  flags.vpnOrProxy = !!(
    dc.vpnOrProxy ||
    cp.vpnOrProxy ||
    status.dcOk === false
  );

  flags.linkFlowMismatch = !!(
    dc.linkFlowMismatch ||
    cp.linkFlowMismatch ||
    dc.flags?.includes?.('link_flow_mismatch')
  );

  return flags;
}

function buildReasons(flags) {
  const reasons = [];

  if (flags.jbSchemes && flags.jbSchemes.length) {
    reasons.push({
      severity: 'HIGH',
      code: 'JAILBREAK_SCHEMES',
      text: tr(
        `Обнаружены инструменты джейлбрейка/хака через custom URL-схемы: ${flags.jbSchemes.join(', ')}. Это модифицированное устройство, не нужное для честной игры.`,
        `Jailbreak / hacking tools detected via custom URL schemes: ${flags.jbSchemes.join(', ')}. This indicates a modified environment not required for fair gameplay.`
      )
    });
  }

  if (flags.automation) {
    reasons.push({
      severity: 'HIGH',
      code: 'AUTOMATION_SHORTCUT',
      text: tr(
        `Обнаружено поведение автоматизации/shortcut: не-человеческие тайминги, странные переключения приложений и редиректы, характерные для скриптов или short-cap обхода.`,
        `Automation / shortcut behavior detected: non-human timing, abnormal app switching and redirects consistent with scripted or short-cap based bypass.`
      )
    });
  }

  if (flags.webApiPatched) {
    reasons.push({
      severity: 'HIGH',
      code: 'RUNTIME_MODIFIED',
      text: tr(
        `Модифицированный runtime: ключевые Web API переопределены. Типичный признак spoofing/anti-detect/чит-фреймворков.`,
        `Modified runtime: core Web APIs are overridden/non-native, typical for spoofing, anti-detect setups or cheat frameworks.`
      )
    });
  }

  if (flags.devtoolsLike) {
    reasons.push({
      severity: 'MEDIUM',
      code: 'DEVTOOLS_ENV',
      text: tr(
        `Признаки DevTools/эмулятора: размеры окна и метрики не похожи на реальное мобильное устройство.`,
        `DevTools/emulator-like environment: window size and metrics are inconsistent with a real mobile device.`
      )
    });
  }

  if (flags.vpnOrProxy) {
    reasons.push({
      severity: 'LOW',
      code: 'VPN_PROXY',
      text: tr(
        `Подозрение на VPN/прокси/датацентр. Сам по себе не доказательство чита, но повышает риск в сочетании с другими сигналами.`,
        `VPN / proxy / datacenter network suspected. Not direct proof of cheating, but raises risk when combined with other signals.`
      )
    });
  }

  if (flags.linkFlowMismatch) {
    reasons.push({
      severity: 'HIGH',
      code: 'LINK_FLOW_MISMATCH',
      text: tr(
        `Несоответствие цепочки ссылки: проверочная ссылка не прошла через ожидаемый официальный PUBG-ендпоинт. Подозрительные редиректы/кастомные схемы указывают на обход.`,
        `Link flow mismatch: the check link did NOT follow the expected official PUBG endpoint. Suspicious redirects/custom schemes indicate a bypass attempt.`
      )
    });
  }

  return reasons;
}

function deriveScoreAndLabel(flags, reasons) {
  let risk = 0;
  if (flags.jbSchemes?.length) risk += 45;
  if (flags.automation)        risk += 40;
  if (flags.webApiPatched)     risk += 35;
  if (flags.linkFlowMismatch)  risk += 35;
  if (flags.devtoolsLike)      risk += 15;
  if (flags.vpnOrProxy)        risk += 5;
  if (risk > 100) risk = 100;

  let label = 'clean';
  if (risk >= 60) label = 'bad';
  else if (risk >= 25) label = 'possible';

  return { score: risk, label, reasons };
}

function formatReasonsHtml(reasons) {
  if (!reasons || !reasons.length) {
    return `<p>${escapeHTML(tr(
      'Подозрительных сигналов нет. Среда выглядит честной.',
      'No suspicious signals. Environment looks clean.'
    ))}</p>`;
  }
  return '<ol>' + reasons.map(r =>
    `<li><b>[${escapeHTML(r.severity)}]</b> ${escapeHTML(r.text)}</li>`
  ).join('') + '</ol>';
}

// chatIds by code
function getChatIdsForCode(code) {
  const C = String(code).toUpperCase();
  const ids = new Set();
  try {
    const rowsMap = db.prepare('SELECT chat_id FROM user_code_map WHERE code = ?').all(C);
    rowsMap.forEach(r => ids.add(String(r.chat_id)));
  } catch {}
  try {
    const rowOld = db.prepare('SELECT chat_id FROM user_codes WHERE code = ?').get(C);
    if (rowOld?.chat_id) ids.add(String(rowOld.chat_id));
  } catch {}
  return [...ids];
}

// HTML report (RU/EN)
function buildHtmlReport({ code, geo, userAgent, platform, iosVersion, isSafari, cp, dc, features, strictTriggered, strictFailed }) {
  const s       = deriveStatus({ iosVersion, platform, userAgent, cp, dc, features });
  const flags   = buildFlags(cp, dc, s);
  const reasons = buildReasons(flags);
  const risk    = deriveScoreAndLabel(flags, reasons);

  const jb  = cp?.jbProbesActive || {};
  const jbSum  = jb.summary || {};

  const jbRows = Array.isArray(s?._jb?.rows)
    ? s._jb.rows
    : (Array.isArray(jb.results) ? jb.results.filter(r => !isIgnoredScheme(r?.scheme)) : []);
  const fp = jbRows.find(r => r?.opened === true) || null;

  const css = `
    :root { color-scheme: light dark; }
    body { font: 14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; margin: 0; padding: 24px; }
    .wrap { max-width: 980px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    h2 { margin: 12px 0 8px; font-size: 18px; }
    .muted { color: #6b7280; font-size: 12px; }
    .card { background: rgba(0,0,0,0.04); border: 1px solid rgba(0,0,0,0.08); padding: 16px; border-radius: 12px; margin: 14px 0; }
    .kv { display: grid; grid-template-columns: 220px 1fr; gap: 8px; }
    .kv div { padding: 6px 8px; border-bottom: 1px dashed rgba(0,0,0,0.12); }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid rgba(0,0,0,0.2); padding: 8px; text-align: left; vertical-align: top; }
    th { background: rgba(0,0,0,0.06); }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { white-space: pre-wrap; word-break: break-word; background: rgba(0,0,0,0.04); padding: 12px; border-radius: 10px; }
    .ok { color:#16a34a; font-weight:600 }
    .bad { color:#ef4444; font-weight:600 }
    .soft { color:#2563eb; }
    .pill { display:inline-block; padding:2px 8px; border-radius:999px; background:rgba(0,0,0,0.06); }
  `;

  const jbInfo = s.jbOk
    ? tr('Нет джейлбрейка', 'No jailbreak detected')
    : (fp?.scheme
        ? tr(
            `Сработала схема <code>${escapeHTML(fp.scheme)}</code> (${escapeHTML(fp.reason || 'signal')} ~${escapeHTML(fp.durationMs || '0')}мс)`,
            `Triggered scheme <code>${escapeHTML(fp.scheme)}</code> (${escapeHTML(fp.reason || 'signal')} ~${escapeHTML(fp.durationMs || '0')}ms)`
          )
        : (Array.isArray(jbSum.reasons) && jbSum.reasons.length
            ? tr(
                `Признаки: <code>${escapeHTML(jbSum.reasons.join(', '))}</code>`,
                `Indicators: <code>${escapeHTML(jbSum.reasons.join(', '))}</code>`
              )
            : tr('Сигналов нет', 'No direct jailbreak signals')));

  const reasonsBlock = `
    <div class="card">
      <h2>⚠️ ${escapeHTML(tr('Причины (высокий приоритет)', 'Reasons (top priority)'))}</h2>
      ${formatReasonsHtml(reasons)}
      <p>${escapeHTML(tr('Риск-оценка', 'Risk score'))}: <b>${risk.score}</b>/100 &nbsp; Status: <b>${escapeHTML(risk.label.toUpperCase())}</b></p>
    </div>
  `;

  const checklist = `
    <div class="card">
      <h2>${escapeHTML(tr('Чеклист статуса', 'Status checklist'))}</h2>
      <div class="kv">
        <div><b>Safari VT18</b></div>
        <div>${OK(s.featuresOk)} VT18=<span class="pill">${escapeHTML(s.features?.VT18 || '—')}</span> · 18.4=<span class="pill">${escapeHTML(s.features?.v18_4 || '—')}</span> <span class="pill">rule: 18.0-only</span></div>
        <div><b>iOS ≥ 18</b></div>
        <div>${OK(s.iosOk)} <span class="${s.iosOk?'ok':'bad'}">${s.iosOk ? 'ok' : 'low'}</span> <span class="pill"><code>${escapeHTML(String(s.iosVersionDetected ?? 'n/a'))}</code></span></div>
        <div><b>${escapeHTML(tr('Платформа', 'Platform'))}</b></div>
        <div>${OK(s.platformOk)}
          <span class="${s.platformOk?'ok':'bad'}">${
            s.platformOk
              ? (s.ipadDesktopOk
                  ? tr('iPad (desktop-режим)', 'iPad (desktop-mode)')
                  : (s.macIntelOk
                      ? tr('MacIntel (разрешено)', 'MacIntel (allowed)')
                      : 'ok'))
              : 'not iOS'
          }</span>
          <span class="pill"><code>${escapeHTML(String(platform||'n/a'))}</code></span>
        </div>
        <div><b>Jailbreak</b></div>
        <div>${OK(s.jbOk)} <span class="${s.jbOk?'ok':'bad'}">${s.jbOk
          ? tr('нет джейлбрейка','no jailbreak')
          : tr('обнаружены признаки','indicators detected')}</span>
          <span class="pill"><code>${escapeHTML(s.jbLabel||'n/a')}</code></span>
        </div>
        <div><b>DC/ISP</b></div>
        <div>${OK(s.dcOk)} <span class="${s.dcOk?'ok':'bad'}">${s.dcOk
          ? tr('нет датацентра','no DC/hosting')
          : tr('найдены сигнатуры DC/hosting','DC/hosting signatures detected')}</span></div>
        <div><b>${escapeHTML(tr('Гео-разрешение','Geo permission'))}</b></div>
        <div>${OK(s.geoOk)}</div>
        <div><b>Camera</b></div>
        <div>${OK(s.camOk)}</div>
        <div><b>Microphone</b></div>
        <div>${OK(s.micOk)}</div>
        <div><b>${escapeHTML(tr('Итог допуска','Final decision'))}</b></div>
        <div><b>${s.canLaunch
          ? tr('Можно запускать','Allowed to start')
          : tr('Нельзя запускать','Denied / manual review')}</b>${
            strictTriggered
              ? (strictFailed
                  ? ' <span class="bad">(strict fail)</span>'
                  : ' <span class="ok">(strict ok)</span>')
              : ''
          }</div>
      </div>
    </div>
  `;

  const overview = `
    <div class="card">
      <h2>${escapeHTML(tr('Сводка','Overview'))}</h2>
      <div class="kv">
        <div><b>Code</b></div><div><code>${escapeHTML(String(code).toUpperCase())}</code></div>
        <div><b>UA</b></div><div><code>${escapeHTML(userAgent || '')}</code></div>
        <div><b>iOS / Platform</b></div><div><code>${escapeHTML(String(s.iosVersionDetected ?? ''))}</code> · <code>${escapeHTML(String(platform||''))}</code></div>
        <div><b>Safari VT18/18.4</b></div><div>VT18=<code>${escapeHTML(s.features?.VT18 || '—')}</code>, 18.4=<code>${escapeHTML(s.features?.v18_4 || '—')}</code></div>
        <div><b>Jailbreak</b></div><div>${jbInfo}</div>
        <div><b>Geo</b></div><div>${
          geo
            ? `<a class="soft" href="https://maps.google.com/?q=${encodeURIComponent(geo.lat)},${encodeURIComponent(geo.lon)}&z=17" target="_blank" rel="noreferrer">${escapeHTML(`${geo.lat}, ${geo.lon}`)}</a> ±${escapeHTML(String(geo.acc))}m`
            : tr('нет данных','no data')
        }</div>
      </div>
    </div>
  `;

  const tableJb = jbRows.length ? `
    <div class="card">
      <h2>JB / Tools</h2>
      <table>
        <thead><tr><th>scheme</th><th>opened</th><th>reason</th><th>ms</th></tr></thead>
        <tbody>
          ${jbRows.slice(0, 100).map(r => `
            <tr>
              <td><code>${escapeHTML(String(r.scheme||'').trim())}</code></td>
              <td>${r.opened ? '<span class="ok">yes</span>' : 'no'}</td>
              <td><code>${escapeHTML(r.reason || (r.opened ? 'signal' : 'timeout'))}</code></td>
              <td>${r.durationMs != null ? escapeHTML(String(r.durationMs)) : '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${s?._jb?.rowsRaw && s._jb.rowsRaw.length !== jbRows.length
        ? `<div class="muted">${escapeHTML(tr(
            'Отфильтрованы тестовые кастомные схемы',
            'Filtered out test custom schemes'
          ))}</div>` : ''}
    </div>
  ` : '';

  const jsonPretty = safeJson({
    geo, userAgent, platform,
    iosVersionDetected: s.iosVersionDetected,
    isSafari,
    featuresSummary: s.features,
    client_profile: cp,
    device_check: dc,
    flags,
    risk
  }, 2);

  const raw = `
    <div class="card">
      <details open>
        <summary>${escapeHTML(tr('Сырой JSON','Raw JSON'))}</summary>
        <pre>${escapeHTML(jsonPretty)}</pre>
      </details>
    </div>
  `;

  const footer = tr(
    'Гейт на сервере • Правило: VT18 обязателен (18.4 не даёт пропуска)',
    'Server-side gate • Rule: VT18 required (18.4 does NOT grant access)'
  );

  const html = `
    <!doctype html>
    <html lang="ru">
    <head>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1"/>
      <title>Device Check — ${escapeHTML(String(code).toUpperCase())}</title>
      <style>${css}</style>
    </head>
    <body>
      <div class="wrap">
        <div class="card">
          <h1>Device Check Report</h1>
          <div class="muted">${escapeHTML(tr(
            'Сформировано:',
            'Generated:'
          ))} ${new Date().toISOString()}</div>
        </div>
        ${reasonsBlock}
        ${checklist}
        ${overview}
        ${tableJb}
        ${raw}
        <div class="muted">${escapeHTML(footer)}</div>
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
    const oldCnt = db.prepare('SELECT COUNT(*) AS c FROM user_codes').get().c;
    const mapCnt = db.prepare('SELECT COUNT(*) AS c FROM user_code_map').get().c;
    res.json({ ok:true, DB_PATH, size, old_table: oldCnt, map_table: mapCnt });
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
    const C = String(code).toUpperCase();
    const ID = String(chatId);
    db.prepare('INSERT OR IGNORE INTO user_code_map(code, chat_id, created_at) VALUES(?,?,?)')
      .run(C, ID, Date.now());
    db.prepare('INSERT OR REPLACE INTO user_codes(code, chat_id, created_at) VALUES(?,?,?)')
      .run(C, ID, Date.now());
    res.json({ ok:true, code:C, chatId:ID });
  } catch (e) {
    console.error('[register-code] error:', e);
    res.status(500).json({ ok:false, error:'Internal' });
  }
});

// ==== Admin: register-codes (multi-chat) ====
app.post('/api/register-codes', requireAdminSecret, (req, res) => {
  try {
    const { code, chatIds } = req.body || {};
    if (!code || !/^[A-Z0-9\-]{3,40}$/i.test(code)) {
      return res.status(400).json({ ok:false, error:'Invalid code' });
    }
    if (!Array.isArray(chatIds) || chatIds.length === 0) {
      return res.status(400).json({ ok:false, error:'chatIds[] required' });
    }
    const C = String(code).toUpperCase();
    const stmt = db.prepare('INSERT OR IGNORE INTO user_code_map(code, chat_id, created_at) VALUES(?,?,?)');
    const now = Date.now();
    for (const raw of chatIds) {
      const ID = String(raw);
      if (!/^-?\d+$/.test(ID)) continue;
      stmt.run(C, ID, now);
    }
    const all = getChatIdsForCode(C);
    if (all[0]) {
      db.prepare('INSERT OR REPLACE INTO user_codes(code, chat_id, created_at) VALUES(?,?,?)')
        .run(C, all[0], now);
    }
    res.json({ ok:true, code:C, chatIds:getChatIdsForCode(C) });
  } catch (e) {
    console.error('[register-codes] error:', e);
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

// ==== API: client-ip ====
app.get('/api/client-ip', (req, res) => {
  const fwd = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  const ip  = fwd || req.ip || null;
  const country =
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-country-code'] || null;
  const isp = req.headers['x-real-isp'] || null;
  res.json({ ip, country, isp, ua: req.headers['user-agent'] || null });
});

// ==== API: gate (frontend check only) ====
app.post('/api/gate', (req, res) => {
  try {
    const {
      userAgent, platform, iosVersion,
      client_profile, device_check, featuresSummary,
      strict
    } = req.body || {};

    const cp = client_profile || {};
    const dc = device_check   || {};
    const feats = normalizeFeatures_Strict18Only(featuresSummary);
    const s  = deriveStatus({ iosVersion, platform, userAgent, cp, dc, features: feats });

    let strictTriggered = !!(strict === true || strict === 1 || String(strict) === '1');
    let strictFailed = false;
    if (strictTriggered) {
      const sc = Number(dc?.score ?? NaN);
      if (!Number.isFinite(sc) || sc < 60) strictFailed = true;
    }

    const canLaunch = s.canLaunch && (!strictTriggered || !strictFailed);
    return res.json({
      ok: true,
      decision: {
        canLaunch,
        strict: { enabled: strictTriggered, failed: strictFailed, score: dc?.score ?? null }
      },
      features: feats,
      iosVersionDetected: s.iosVersionDetected,
      platformOk: s.platformOk,
      jbOk: s.jbOk,
      jbLabel: s.jbLabel,
      dcOk: s.dcOk
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || 'Internal error' });
  }
});

// ==== API: report (main TG report, reasons first) ====
app.post('/api/report', async (req, res) => {
  try {
    const {
      userAgent, platform, iosVersion, isSafari,
      geo, photoBase64, note, code,
      client_profile,
      device_check,
      featuresSummary,
      strict
    } = req.body || {};

    if (!code)        return res.status(400).json({ ok:false, error: 'No code' });
    if (!photoBase64) return res.status(400).json({ ok:false, error: 'No photoBase64' });

    const chatIds = getChatIdsForCode(String(code).toUpperCase());
    if (!chatIds.length) return res.status(404).json({ ok:false, error:'Unknown code' });

    const cp = client_profile || {};
    const dc = device_check   || {};
    const feats = normalizeFeatures_Strict18Only(featuresSummary);
    const s  = deriveStatus({ iosVersion, platform, userAgent, cp, dc, features: feats });

    let strictTriggered = !!(strict === true || strict === 1 || String(strict) === '1');
    let strictFailed = false;
    if (strictTriggered) {
      const sc = Number(dc?.score ?? NaN);
      if (!Number.isFinite(sc) || sc < 60) strictFailed = true;
    }
    const canLaunch = s.canLaunch && (!strictTriggered || !strictFailed);

    const flags   = buildFlags(cp, dc, s);
    const reasons = buildReasons(flags);
    const risk    = deriveScoreAndLabel(flags, reasons);

    const reasonsLines = reasons.length
      ? reasons.map((r, i) =>
          `${i+1}. [${escapeHTML(r.severity)}] ${escapeHTML(r.text)}`
        ).join('\n')
      : escapeHTML(tr(
          'Подозрительных сигналов нет. Среда выглядит честной.',
          'No suspicious signals. Environment looks clean.'
        ));

    const captionLines = [
      '<b>🕵️ DEVICE CHECK REPORT</b>',
      `${escapeHTML(tr('Статус','Status'))}: <b>${escapeHTML(risk.label.toUpperCase())}</b> (score: <b>${risk.score}</b>/100)`,
      `Code: <code>${escapeHTML(String(code).toUpperCase())}</code>`,
      '',
      `⚠️ <b>${escapeHTML(tr('Причины (высокий приоритет)','Reasons (top priority)'))}:</b>`,
      reasonsLines,
      '',
      '--- Technical details ---',
      `${OK(s.iosOk)} iOS: <code>${escapeHTML(String(s.iosVersionDetected ?? 'n/a'))}</code>`,
      `${OK(s.platformOk)} ${escapeHTML(tr('Платформа','Platform'))}: <code>${escapeHTML(String(platform||'n/a'))}${s.ipadDesktopOk ? ' (iPad desktop-mode)' : (s.macIntelOk ? ' (MacIntel)' : '')}</code>`,
      `${OK(s.jbOk)} ${s.jbOk
        ? escapeHTML(tr('нет джейлбрейка','no jailbreak'))
        : escapeHTML(tr('обнаружены JB-признаки','jailbreak indicators detected'))}`,
      `${OK(s.dcOk)} DC/ISP: ${s.dcOk
        ? escapeHTML(tr('нет','none'))
        : '<b>DC/hosting</b>'}`,
      `Safari: ${OK(s.featuresOk)} VT18=<code>${escapeHTML(feats.VT18)}</code>, 18.4=<code>${escapeHTML(feats.v18_4)}</code> (rule: 18.0-only)`,
      `Geo: ${
        geo
          ? `<a href="https://maps.google.com/?q=${encodeURIComponent(geo.lat)},${encodeURIComponent(geo.lon)}&z=17">${escapeHTML(`${geo.lat}, ${geo.lon}`)}</a> ±${escapeHTML(String(geo.acc))}m`
          : '<code>n/a</code>'
      }`,
      `UA: <code>${escapeHTML(userAgent || '')}</code>`,
      `${escapeHTML(tr('Итог','Result'))}: <b>${canLaunch
        ? escapeHTML(tr('МОЖНО ЗАПУСКАТЬ','ALLOW'))
        : escapeHTML(tr('ЗАПРЕТ / РУЧНАЯ ПРОВЕРКА','DENY / MANUAL REVIEW'))}</b>` +
        (strictTriggered
          ? (strictFailed ? ' (strict fail)' : ' (strict ok)')
          : ''),
      note ? `Note: <code>${escapeHTML(note)}</code>` : null
    ].filter(Boolean);

    const caption = captionLines.join('\n');

    const buf = b64ToBuffer(photoBase64);
    const html = buildHtmlReport({
      code, geo, userAgent, platform, iosVersion, isSafari,
      cp, dc, features: feats, strictTriggered, strictFailed
    });
    const fname = `report-${String(code).toUpperCase()}-${Date.now()}.html`;

    const sent = [];
    for (const id of chatIds) {
      try {
        const tgPhoto = await sendPhotoToTelegram({ chatId: String(id), caption, photoBuf: buf });
        sent.push({ chatId: String(id), ok: true, message_id: tgPhoto?.result?.message_id, type: 'photo' });
      } catch (e) {
        sent.push({ chatId: String(id), ok: false, error: String(e), type: 'photo' });
      }
      try {
        const tgDoc = await sendDocumentToTelegram({ chatId: String(id), htmlString: html, filename: fname });
        sent.push({ chatId: String(id), ok: true, message_id: tgDoc?.result?.message_id, type: 'document' });
      } catch (e) {
        sent.push({ chatId: String(id), ok: false, error: String(e), type: 'document' });
      }
    }

    return res.json({
      ok: true,
      decision: {
        canLaunch,
        strict: { enabled: strictTriggered, failed: strictFailed, score: dc?.score ?? null }
      },
      features: feats,
      iosVersionDetected: s.iosVersionDetected,
      platformOk: s.platformOk,
      jbOk: s.jbOk,
      jbLabel: s.jbLabel,
      dcOk: s.dcOk,
      flags,
      risk,
      sent
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
  console.log(`[server] REPORT_LANG: ${REPORT_LANG}`);
});
