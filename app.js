'use strict';

const THUMB_MAX = 640;          // longest side of preview canvases
const CORNERS = ['tl', 'tr', 'bl', 'br'];
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const $ = (id) => document.getElementById(id);
const ui = {
  iconInput: $('iconInput'), iconDrop: $('iconDrop'), iconPreview: $('iconPreview'), iconHint: $('iconHint'),
  picsInput: $('picsInput'), picsDrop: $('picsDrop'), picsCount: $('picsCount'), clearBtn: $('clearBtn'),
  position: $('position'), autoCornersField: $('autoCornersField'),
  size: $('size'), margin: $('margin'), opacity: $('opacity'),
  format: $('format'), quality: $('quality'),
  downloadBtn: $('downloadBtn'), progress: $('progress'), status: $('status'),
  gallery: $('gallery'), empty: $('empty'),
};

const state = {
  icon: null,   // { bitmap, aspect }
  pics: [],     // { file, base: canvas (unwatermarked thumb), view: canvas, tag, corner }
  busy: false,
};

// ---------- settings ----------

function settings() {
  const allowed = [...ui.autoCornersField.querySelectorAll('input:checked')].map((i) => i.value);
  return {
    position: ui.position.value,
    allowed: allowed.length ? allowed : CORNERS,
    size: +ui.size.value / 100,
    margin: +ui.margin.value / 100,
    opacity: +ui.opacity.value / 100,
    format: ui.format.value,
    quality: +ui.quality.value / 100,
  };
}

function syncOutputs() {
  $('sizeOut').textContent = ui.size.value + '%';
  $('marginOut').textContent = ui.margin.value + '%';
  $('opacityOut').textContent = ui.opacity.value + '%';
  $('qualityOut').textContent = ui.quality.value + '%';
  ui.autoCornersField.hidden = ui.position.value !== 'auto';
  const lossless = ui.format.value === 'image/png';
  ui.quality.disabled = lossless;
}

// ---------- geometry ----------

// Icon rect for a W×H picture at the given corner. Size and margin are
// relative to the shorter side so portrait and landscape shots match.
function iconRect(W, H, corner, s) {
  const short = Math.min(W, H);
  const w = Math.max(1, Math.round(short * s.size));
  const h = Math.max(1, Math.round(w / state.icon.aspect));
  const m = Math.round(short * s.margin);
  const x = corner[1] === 'l' ? m : W - w - m;
  const y = corner[0] === 't' ? m : H - h - m;
  return { x, y, w, h };
}

// ---------- contrast analysis ----------

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Scores how well the icon would stand out at a corner of the (thumbnail)
// base canvas: alpha-weighted per-pixel luminance difference between icon and
// background, minus a penalty for busy backgrounds.
function scoreCorner(base, corner, s) {
  const r = iconRect(base.width, base.height, corner, s);
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  const w = Math.min(r.w, base.width - x), h = Math.min(r.h, base.height - y);
  if (w < 1 || h < 1) return -Infinity;

  const bg = base.getContext('2d', { willReadFrequently: true }).getImageData(x, y, w, h).data;
  const ic = document.createElement('canvas');
  ic.width = w; ic.height = h;
  const ictx = ic.getContext('2d', { willReadFrequently: true });
  ictx.drawImage(state.icon.bitmap, 0, 0, w, h);
  const fg = ictx.getImageData(0, 0, w, h).data;

  let diff = 0, weight = 0, sum = 0, sumSq = 0, n = 0;
  for (let i = 0; i < bg.length; i += 4) {
    const lb = lum(bg[i], bg[i + 1], bg[i + 2]);
    sum += lb; sumSq += lb * lb; n++;
    const a = fg[i + 3] / 255;
    if (a > 0.05) {
      diff += a * Math.abs(lum(fg[i], fg[i + 1], fg[i + 2]) - lb);
      weight += a;
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return (weight ? diff / weight : 0) - 0.35 * std;
}

function pickCorner(pic, s) {
  if (s.position !== 'auto') return s.position;
  let best = s.allowed[0], bestScore = -Infinity;
  for (const c of s.allowed) {
    const score = scoreCorner(pic.base, c, s);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// ---------- drawing ----------

function drawWatermark(ctx, W, H, corner, s) {
  const r = iconRect(W, H, corner, s);
  ctx.save();
  ctx.globalAlpha = s.opacity;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(state.icon.bitmap, r.x, r.y, r.w, r.h);
  ctx.restore();
}

function renderPic(pic, s) {
  const { base, view } = pic;
  const ctx = view.getContext('2d');
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.drawImage(base, 0, 0);
  if (!state.icon) { pic.corner = null; pic.tag.hidden = true; return; }
  pic.corner = pickCorner(pic, s);
  drawWatermark(ctx, view.width, view.height, pic.corner, s);
  pic.tag.hidden = false;
  pic.tag.textContent = pic.corner;
  pic.tag.title = s.position === 'auto' ? 'Auto-selected corner' : 'Corner';
}

let raf = 0;
function renderAll() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    const s = settings();
    state.pics.forEach((p) => renderPic(p, s));
    updateControls();
  });
}

function updateControls() {
  const n = state.pics.length;
  ui.empty.hidden = n > 0;
  ui.picsCount.textContent = n ? `${n} loaded` : 'none loaded';
  ui.clearBtn.disabled = !n || state.busy;
  ui.downloadBtn.disabled = !n || !state.icon || state.busy;
  state.pics.forEach((p) => { p.dlBtn.disabled = !state.icon || state.busy; });
}

// ---------- loading ----------

async function loadIcon(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const bitmap = await createImageBitmap(file);
    if (state.icon) state.icon.bitmap.close();
    state.icon = { bitmap, aspect: bitmap.width / bitmap.height };
    ui.iconPreview.src = URL.createObjectURL(file);
    ui.iconPreview.hidden = false;
    ui.iconHint.innerHTML = `${escapeHtml(file.name)}<br><small>click to replace</small>`;
    renderAll();
  } catch (err) {
    ui.status.textContent = `Could not read icon: ${file.name}`;
  }
}

async function addPics(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  const s = settings();
  for (const file of images) {
    let bitmap;
    try { bitmap = await createImageBitmap(file); }
    catch { ui.status.textContent = `Skipped unreadable file: ${file.name}`; continue; }

    const k = Math.min(1, THUMB_MAX / Math.max(bitmap.width, bitmap.height));
    const base = document.createElement('canvas');
    base.width = Math.max(1, Math.round(bitmap.width * k));
    base.height = Math.max(1, Math.round(bitmap.height * k));
    const bctx = base.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(bitmap, 0, 0, base.width, base.height);
    const dims = `${bitmap.width}×${bitmap.height}`;
    bitmap.close();

    const pic = { file, base, ...buildCard(file, dims) };
    pic.view.width = base.width;
    pic.view.height = base.height;
    state.pics.push(pic);
    renderPic(pic, s);
    updateControls();
  }
}

function buildCard(file, dims) {
  const card = document.createElement('figure');
  card.className = 'card';
  card.style.margin = '0';
  card.innerHTML = `
    <div class="thumb"><canvas></canvas></div>
    <figcaption class="meta">
      <span class="name"></span>
      <span class="tag" hidden></span>
      <button type="button" title="Download this picture">↓</button>
    </figcaption>`;
  const name = card.querySelector('.name');
  name.textContent = file.name;
  name.title = `${file.name} · ${dims}`;
  const pic = {
    card,
    view: card.querySelector('canvas'),
    tag: card.querySelector('.tag'),
    dlBtn: card.querySelector('button'),
  };
  pic.dlBtn.addEventListener('click', () => downloadOne(file));
  ui.gallery.appendChild(card);
  return pic;
}

// ---------- export ----------

function outputType(file, s) {
  if (s.format !== 'same') return s.format;
  return EXT[file.type] ? file.type : 'image/png';
}

function outputName(file, type, used) {
  const stem = file.name.replace(/\.[^.]+$/, '') || 'image';
  let name = `${stem}.${EXT[type]}`;
  for (let i = 2; used && used.has(name); i++) name = `${stem}-${i}.${EXT[type]}`;
  used && used.add(name);
  return name;
}

async function renderFull(pic, s) {
  const bitmap = await createImageBitmap(pic.file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  const type = outputType(pic.file, s);
  if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  drawWatermark(ctx, canvas.width, canvas.height, pic.corner || pickCorner(pic, s), s);
  const blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, s.quality));
  canvas.width = canvas.height = 0; // release memory early
  return { blob, type };
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function downloadOne(file) {
  const pic = state.pics.find((p) => p.file === file);
  if (!pic || !state.icon) return;
  const s = settings();
  const { blob, type } = await renderFull(pic, s);
  saveBlob(blob, outputName(file, type));
}

async function downloadAll() {
  if (state.busy || !state.icon || !state.pics.length) return;
  state.busy = true;
  updateControls();
  const s = settings();
  const zip = new JSZip();
  const used = new Set();
  const bar = ui.progress.firstElementChild;
  ui.progress.hidden = false;
  let failed = 0;
  try {
    for (let i = 0; i < state.pics.length; i++) {
      const pic = state.pics[i];
      ui.status.textContent = `Rendering ${i + 1} / ${state.pics.length}…`;
      bar.style.width = `${(i / state.pics.length) * 90}%`;
      try {
        const { blob, type } = await renderFull(pic, s);
        zip.file(outputName(pic.file, type, used), blob);
      } catch { failed++; }
    }
    ui.status.textContent = 'Zipping…';
    // Images are already compressed; STORE keeps zipping fast.
    const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' },
      (m) => { bar.style.width = `${90 + m.percent / 10}%`; });
    saveBlob(out, 'iconized.zip');
    ui.status.textContent = failed ? `Done — ${failed} file(s) failed.` : `Done — ${state.pics.length} pictures.`;
  } catch (err) {
    ui.status.textContent = `Export failed: ${err.message}`;
  } finally {
    state.busy = false;
    ui.progress.hidden = true;
    bar.style.width = '0';
    updateControls();
  }
}

// ---------- wiring ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wireDrop(zone, onFiles) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    onFiles(e.dataTransfer.files);
  });
}

ui.iconInput.addEventListener('change', () => { loadIcon(ui.iconInput.files[0]); ui.iconInput.value = ''; });
ui.picsInput.addEventListener('change', () => { addPics(ui.picsInput.files); ui.picsInput.value = ''; });
wireDrop(ui.iconDrop, (files) => loadIcon(files[0]));
wireDrop(ui.picsDrop, addPics);

// Dropping pictures anywhere on the gallery also works.
ui.gallery.addEventListener('dragover', (e) => e.preventDefault());
ui.gallery.addEventListener('drop', (e) => { e.preventDefault(); addPics(e.dataTransfer.files); });

ui.clearBtn.addEventListener('click', () => {
  state.pics.forEach((p) => p.card.remove());
  state.pics = [];
  ui.status.textContent = '';
  updateControls();
});

for (const el of [ui.position, ui.size, ui.margin, ui.opacity, ...ui.autoCornersField.querySelectorAll('input')]) {
  el.addEventListener('input', () => { syncOutputs(); renderAll(); });
}
for (const el of [ui.format, ui.quality]) el.addEventListener('input', syncOutputs);
ui.downloadBtn.addEventListener('click', downloadAll);

syncOutputs();
updateControls();
