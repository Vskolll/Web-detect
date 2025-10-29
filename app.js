// === Настройки ===
const API_BASE = 'https://geo-photo-report.onrender.com';

const UI = {
  text: document.getElementById('text'),
  card: document.getElementById('card'),
};

async function askGeolocation() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy), ts: Date.now() }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

async function takePhoto() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera unsupported');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
  const [track] = stream.getVideoTracks();
  try {
    const cap = new ImageCapture(track);
    const bmp = await cap.grabFrame();
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    track.stop(); return dataUrl;
  } catch {
    const v = document.createElement('video'); v.srcObject = stream; await v.play();
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    stream.getTracks().forEach(t => t.stop()); return dataUrl;
  }
}

function getDeviceInfo() {
  const ua = navigator.userAgent;
  const isSafari = /Safari\//.test(ua) && !/Chrome|CriOS|Chromium|FxiOS|Edg|OPR/.test(ua) && navigator.vendor === 'Apple Computer, Inc.';
  const m = ua.match(/OS\s(\d+)[_.]/);
  const iosVer = m ? parseInt(m[1], 10) : null;
  return { userAgent: ua, platform: navigator.platform, iosVersion: iosVer, isSafari };
}

async function sendReport({ photoBase64, geo, note }) {
  const info = getDeviceInfo();
  const r = await fetch(`${API_BASE}/api/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...info, geo, photoBase64, note })
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || 'Send failed');
  return data;
}

function renderPreview({ photoBase64, geo }) {
  const wrap = document.createElement('div'); wrap.style.marginTop = '16px';
  wrap.innerHTML = `
    <img src="${photoBase64}" alt="preview" style="max-width:100%;border-radius:12px;display:block;margin:0 auto 8px;"/>
    <div style="font-size:13px;opacity:.85;margin-bottom:8px;">
      ${geo ? `Гео: ${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)} ±${geo.acc}м` : 'Гео: нет'}
    </div>
    <button id="sendBtn" style="width:100%;height:48px;border:none;border-radius:10px;background:linear-gradient(90deg,#0a7,#0cf);color:#fff;font-weight:700;">Отправить отчёт</button>
    <div style="font-size:12px;opacity:.7;margin-top:8px;">Отправится: фото, координаты (если есть) и тех.мета. Нажимая кнопку, ты согласен(на).</div>
  `;
  UI.card.appendChild(wrap);
  return wrap.querySelector('#sendBtn');
}

async function startFlow() {
  try {
    UI.text.innerHTML = 'Запрашиваем гео и камеру…';
    const [geo, photoBase64] = await Promise.all([askGeolocation(), takePhoto()]);
    const btn = renderPreview({ photoBase64, geo });
    btn.addEventListener('click', async () => {
      UI.text.innerHTML = 'Отправляем в Telegram…';
      try { await sendReport({ photoBase64, geo, note: 'consent:yes' });
        UI.text.innerHTML = '<span class="ok">Отчёт отправлен.</span>';
      } catch (e) {
        console.error(e); UI.text.innerHTML = '<span class="err">Ошибка отправки.</span>';
      }
    }, { once: true });
  } catch (e) {
    console.error(e); UI.text.innerHTML = '<span class="err">Доступ к камере/гео отклонён.</span>';
  }
}

window.__startGeoPhotoFlow = startFlow;
