function sanitizeApiBase(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'http://127.0.0.1:8000';
    }
    return parsed.pathname && parsed.pathname !== '/'
      ? `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`
      : parsed.origin;
  } catch (_) {
    return 'http://127.0.0.1:8000';
  }
}

// Default to public/deployed API if provided, else fall back to localhost.
// To deploy, replace PUBLIC_API_BASE with your actual URL, e.g., https://your-domain.com
const PUBLIC_API_BASE = '';
let apiBase = sanitizeApiBase(
  (typeof window !== 'undefined' && window.BACKEND_URL) ||
  (typeof localStorage !== 'undefined' && localStorage.getItem('apiBase')) ||
  PUBLIC_API_BASE ||
  'http://127.0.0.1:8000'
);

async function fetchWithTimeout(resource, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(resource, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
}

const imageInput = document.getElementById('imageInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const preview = document.getElementById('preview');
const previewImg = document.getElementById('previewImg');
const statusEl = document.getElementById('status');
const alertBanner = document.getElementById('alertBanner');
const details = document.getElementById('details');
const forceBtn = document.getElementById('forceBtn');
const resultChartEl = document.getElementById('resultChart');
let resultChart = null;
const apiInput = null;
const saveApiBtn = null;

let selectedFile = null;

imageInput.addEventListener('change', () => {
  const file = imageInput.files && imageInput.files[0];
  selectedFile = file || null;
  analyzeBtn.disabled = !selectedFile;
  if (selectedFile) {
    const reader = new FileReader();
    reader.onload = e => {
      previewImg.src = e.target.result;
      preview.classList.remove('hidden');
      statusEl.textContent = 'Ready to analyze.';
    };
    reader.readAsDataURL(selectedFile);
  } else {
    preview.classList.add('hidden');
    statusEl.textContent = 'Waiting for image...';
  }
});

// Basic connectivity check so users see immediately if API is reachable
window.addEventListener('DOMContentLoaded', async () => {
  await pingApi();
});

async function pingApi() {
  try {
    const ping = await fetchWithTimeout(`${apiBase}/`, { method: 'GET' }, 8000);
    const ct = (ping.headers.get('content-type') || '').toLowerCase();
    if (!ping.ok) {
      apiAvailable = false;
      statusEl.textContent = 'API not available. You can still analyze locally in the browser.';
      return;
    }

    if (!ct.includes('application/json')) {
      apiAvailable = false;
      statusEl.textContent = 'API not available. You can still analyze locally in the browser.';
      return;
    }

    apiAvailable = true;
    statusEl.textContent = 'API connected. Choose an image to start.';
  } catch (e) {
    apiAvailable = false;
    statusEl.textContent = 'API not available. You can still analyze locally in the browser.';
  }
}

analyzeBtn.addEventListener('click', async () => {
  // Fallback: read directly from input if state missing
  if (!selectedFile && imageInput && imageInput.files && imageInput.files[0]) {
    selectedFile = imageInput.files[0];
  }
  if (!selectedFile) {
    statusEl.textContent = 'Please choose an image first.';
    return;
  }
  try {
    setUIStateLoading(true);
    const form = new FormData();
    form.append('file', selectedFile);

    // Prefer API if available, else fall back to local analysis
    if (apiAvailable) {
      const res = await fetchWithTimeout(`${apiBase}/analyze`, {
        method: 'POST',
        body: form
      }, 60000);
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok) {
        let serverMsg = '';
        try {
          if (contentType.includes('application/json')) {
            const maybeJson = await res.json();
            serverMsg = maybeJson && (maybeJson.error || JSON.stringify(maybeJson));
          } else {
            serverMsg = await res.text();
          }
        } catch (_) {
          try { serverMsg = await res.text(); } catch (_) { /* ignore */ }
        }
        const reason = serverMsg ? `: ${serverMsg}` : '';
        throw new Error(`Server error ${res.status}${reason}`);
      }
      if (!contentType.includes('application/json')) {
        const bodyText = await res.text();
        throw new Error(`Unexpected non-JSON response from API (content-type: ${contentType || 'unknown'}).`);
      }
      const data = await res.json();
      if (data && data.invalid) {
        showInvalidImageError();
        if (forceBtn) forceBtn.classList.remove('hidden');
        return;
      }
      if (forceBtn) forceBtn.classList.add('hidden');
      renderResult(data);
    } else {
      const local = await analyzeLocally(selectedFile);
      renderResult(local);
    }
  } catch (err) {
    console.error(err);
    // Fallback to local analysis on any error
    try {
      const local = await analyzeLocally(selectedFile);
      renderResult(local);
    } catch (_) {
      statusEl.textContent = 'Error analyzing image.';
      alertBanner.className = 'alert danger';
      alertBanner.classList.remove('hidden');
      alertBanner.textContent = (err && err.message) || 'Failed to analyze image.';
    }
  } finally {
    setUIStateLoading(false);
  }
});

if (forceBtn) {
  forceBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    try {
      setUIStateLoading(true);
      const form = new FormData();
      form.append('file', selectedFile);
      form.append('force', 'true');
      const res = await fetchWithTimeout(`${apiBase}/analyze`, { method: 'POST', body: form }, 20000);
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        const bodyText = await res.text();
        throw new Error(`Unexpected non-JSON response from API (content-type: ${contentType || 'unknown'}).`);
      }
      const data = await res.json();
      renderResult(data);
      forceBtn.classList.add('hidden');
    } catch (err) {
      console.error(err);
      alertBanner.classList.remove('hidden');
      alertBanner.className = 'alert danger';
      alertBanner.textContent = err.message || 'Failed to analyze image.';
    } finally {
      setUIStateLoading(false);
    }
  });
}

// API config UI removed

function setUIStateLoading(isLoading) {
  if (analyzeBtn) analyzeBtn.disabled = isLoading;
  statusEl.textContent = isLoading ? 'Analyzing…' : '';
}

async function renderResult(result) {
  const { danger, direction, confidence, slope_angle, class_name, class_prob } = result;
  details.classList.remove('hidden');
  details.innerHTML = `
    <div><strong>Slope Angle:</strong> ${typeof slope_angle === 'number' ? `${slope_angle}°` : 'N/A'}</div>
    <div><strong>Risk:</strong> ${danger ? 'Danger' : 'Safe'}</div>
    <div><strong>Direction:</strong> ${direction || 'N/A'}</div>
    ${class_name ? `<div><strong>Category:</strong> ${class_name} (${(class_prob*100||0).toFixed(1)}%)</div>` : ''}
  `;

  alertBanner.classList.remove('hidden');
  if (danger) {
    alertBanner.className = 'alert danger';
    alertBanner.textContent = `ALERT: Rockfall detected! Move ${direction.toUpperCase()}.`;
  } else {
    alertBanner.className = 'alert safe';
    alertBanner.textContent = 'No immediate rockfall risk detected.';
  }

  statusEl.textContent = 'Analysis complete.';

  try {
    if (resultChartEl && window.Chart) {
      if (!resultChart) {
        resultChart = new Chart(resultChartEl, {
          type: 'line',
          data: { labels: [], datasets: [ { label: 'Risk (%)', data: [], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.2)', tension: 0.2 } ] },
          options: { responsive: true, plugins: { legend: { display: true } }, scales: { y: { beginAtZero: true, suggestedMax: 100 } } }
        });
      }
      const ts = new Date().toLocaleTimeString();
      resultChart.data.labels.push(ts);
      const riskPercent = danger ? 100 : 0; // simple binary risk for chart
      resultChart.data.datasets[0].data.push(riskPercent);
      // keep last 20 points
      if (resultChart.data.labels.length > 20) {
        resultChart.data.labels.shift();
        resultChart.data.datasets[0].data.shift();
      }
      resultChart.update();
    }
  } catch (_) { /* noop */ }

  // If danger, attempt to notify control room via backend (if configured)
  if (danger && apiAvailable) {
    try {
      const form = new FormData();
      form.append('subject', 'RockShield ALERT');
      form.append('message', `Danger detected. Category=${class_name || 'n/a'}, Direction=${direction || 'n/a'}, Slope=${slope_angle || 'n/a'}°.`);
      await fetchWithTimeout(`${apiBase}/notify`, { method: 'POST', body: form }, 10000);
    } catch (_) { /* ignore if backend not configured */ }
  }
}

function showInvalidImageError() {
  details.classList.add('hidden');
  alertBanner.classList.remove('hidden');
  alertBanner.className = 'alert danger';
  alertBanner.textContent = '❌ Uploaded image is not related to rockfall or landslide';
  statusEl.textContent = '';
}

// Local-only analysis: compute simple heuristics in-browser and simulate slope
async function analyzeLocally(file) {
  const imgDataUrl = await readFileAsDataURL(file);
  const img = await loadImage(imgDataUrl);
  const canvas = document.createElement('canvas');
  const maxSide = 512;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  canvas.width = Math.floor(img.width * scale);
  canvas.height = Math.floor(img.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let sum = 0, sumLeft = 0, sumRight = 0, count = width * height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += gray;
      if (x < width / 2) sumLeft += gray; else sumRight += gray;
    }
  }
  const mean = sum / count;
  const leftMean = sumLeft / (count / 2);
  const rightMean = sumRight / (count / 2);
  const confidence = Math.min(1, Math.abs(mean - 128) / 128);
  const danger = mean < 110; // same heuristic as backend
  const direction = leftMean < rightMean ? 'left' : 'right';
  const slope_angle = Math.floor(20 + Math.random() * 60);

  return { danger, direction, confidence, slope_angle };
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

