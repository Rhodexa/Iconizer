'use strict';

const THUMB_MAX = 640;          // longest side of preview canvases
const CORNERS = ['tl', 'tr', 'bl', 'br'];
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' };
// Recording formats to try, best first. H.264 MP4 plays everywhere (Linux
// Chrome can't encode AAC, hence the Opus variant); WebM is the fallback.
const VIDEO_TYPES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4',
  'video/webm;codecs=vp9,opus', 'video/webm'];

const $ = (id) => document.getElementById(id);
const ui = {
  iconInput: $('iconInput'), iconDrop: $('iconDrop'), iconPreview: $('iconPreview'), iconHint: $('iconHint'),
  picsInput: $('picsInput'), picsDrop: $('picsDrop'), picsCount: $('picsCount'), clearBtn: $('clearBtn'),
  position: $('position'), autoCornersField: $('autoCornersField'),
  size: $('size'), margin: $('margin'), opacity: $('opacity'),
  priceOn: $('priceOn'), price: $('price'), priceCorner: $('priceCorner'),
  sizeTagOn: $('sizeTagOn'), sizeTag: $('sizeTag'), sizeTagCorner: $('sizeTagCorner'),
  tagOptions: $('tagOptions'), tagStyle: $('tagStyle'), tagSize: $('tagSize'),
  format: $('format'), quality: $('quality'),
  downloadBtn: $('downloadBtn'), progress: $('progress'), status: $('status'),
  gallery: $('gallery'), empty: $('empty'),
};

const state = {
  icon: null,   // { bitmap, aspect }
  pics: [],     // { file, video, base: canvas (unwatermarked thumb), view: canvas, tag, corner }
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
    tags: [
      ui.priceOn.checked && { text: ui.price.value.trim(), corner: ui.priceCorner.value },
      ui.sizeTagOn.checked && { text: ui.sizeTag.value.trim(), corner: ui.sizeTagCorner.value },
    ].filter((t) => t && t.text),
    tagStyle: ui.tagStyle.value,
    tagSize: +ui.tagSize.value / 100,
    format: ui.format.value,
    quality: +ui.quality.value / 100,
  };
}

function syncOutputs() {
  $('sizeOut').textContent = ui.size.value + '%';
  $('marginOut').textContent = ui.margin.value + '%';
  $('opacityOut').textContent = ui.opacity.value + '%';
  $('qualityOut').textContent = ui.quality.value + '%';
  $('tagSizeOut').textContent = ui.tagSize.value + '%';
  ui.autoCornersField.hidden = ui.position.value !== 'auto';
  ui.tagOptions.hidden = !ui.priceOn.checked && !ui.sizeTagOn.checked;
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

// Mirrors the corner horizontally, so tags sit on the same edge as the icon.
const opposite = (c) => c[0] + (c[1] === 'l' ? 'r' : 'l');

function pickCorner(pic, s) {
  if (s.position !== 'auto') return s.position;
  // Keep auto placement out of corners reserved for tags.
  let allowed = s.allowed;
  const taken = s.tags.map((t) => t.corner);
  const free = allowed.filter((c) => !taken.includes(c));
  if (free.length) allowed = free;
  let best = allowed[0], bestScore = -Infinity;
  for (const c of allowed) {
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

// Price / size tags: rounded pills, each in its own corner. Tags that share a
// corner sit side by side. Height and margin are relative to the shorter
// side, like the icon.
function drawTags(ctx, W, H, iconCorner, s) {
  const groups = {};
  for (const t of s.tags) {
    const c = t.corner === 'opposite' ? opposite(iconCorner || 'bl') : t.corner;
    (groups[c] ||= []).push(t.text);
  }
  for (const [corner, texts] of Object.entries(groups)) drawTagRow(ctx, W, H, corner, texts, s);
}

function drawTagRow(ctx, W, H, corner, texts, s) {
  const short = Math.min(W, H);
  const h = Math.max(4, Math.round(short * s.tagSize));
  const m = Math.round(short * s.margin);
  const gap = Math.round(h * 0.25), pad = h * 0.4;
  ctx.save();
  ctx.font = `600 ${Math.round(h * 0.56)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const widths = texts.map((t) => Math.max(h, Math.ceil(ctx.measureText(t).width + pad * 2)));
  const total = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  let x = corner[1] === 'l' ? m : W - m - total;
  const y = corner[0] === 't' ? m : H - m - h;
  const [bg, fg] = s.tagStyle === 'light' ? ['rgba(255,255,255,.88)', '#151515'] : ['rgba(20,20,20,.78)', '#fff'];
  texts.forEach((t, i) => {
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(x, y, widths[i], h, h * 0.3);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.fillText(t, x + widths[i] / 2, y + h / 2 + h * 0.03);
    x += widths[i] + gap;
  });
  ctx.restore();
}

const hasMarks = (s) => !!state.icon || s.tags.length > 0;

function drawMarks(ctx, W, H, corner, s) {
  if (state.icon) drawWatermark(ctx, W, H, corner, s);
  drawTags(ctx, W, H, corner, s);
}

function renderPic(pic, s) {
  const { base, view } = pic;
  const ctx = view.getContext('2d');
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.drawImage(base, 0, 0);
  pic.corner = state.icon ? pickCorner(pic, s) : null;
  if (hasMarks(s)) drawMarks(ctx, view.width, view.height, pic.corner, s);
  if (!pic.corner) { pic.tag.hidden = true; return; }
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
  const ready = hasMarks(settings());
  ui.empty.hidden = n > 0;
  ui.picsCount.textContent = n ? `${n} loaded` : 'none loaded';
  ui.clearBtn.disabled = !n || state.busy;
  ui.downloadBtn.disabled = !n || !ready || state.busy;
  ui.downloadBtn.textContent = n === 1 ? 'Download file' : 'Download all (.zip)';
  state.pics.forEach((p) => { p.dlBtn.disabled = !ready || state.busy; });
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

const isVideo = (file) => file.type.startsWith('video/');

function loadVideo(file, muted = true) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.muted = muted;
    v.playsInline = true;
    v.preload = 'auto';
    v.onloadedmetadata = () => res(v);
    v.onerror = () => rej(new Error(`could not read ${file.name}`));
    v.src = URL.createObjectURL(file);
  });
}

function releaseVideo(v) {
  v.pause();
  URL.revokeObjectURL(v.src);
  v.removeAttribute('src');
  v.load();
}

const seek = (v, t) => new Promise((res) => { v.onseeked = () => res(); v.currentTime = t; });

// A still from early in the video stands in for it in the preview and for
// auto corner analysis.
async function videoStill(file) {
  const v = await loadVideo(file);
  // iOS only decodes frames once playback has started.
  try { await v.play(); v.pause(); } catch {}
  await seek(v, Math.min(1, (v.duration || 0) * 0.1));
  return v;
}

const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

async function addPics(files) {
  const media = [...files].filter((f) => f.type.startsWith('image/') || isVideo(f));
  const s = settings();
  for (const file of media) {
    let src;
    try { src = isVideo(file) ? await videoStill(file) : await createImageBitmap(file); }
    catch { ui.status.textContent = `Skipped unreadable file: ${file.name}`; continue; }
    const video = isVideo(file);
    const sw = video ? src.videoWidth : src.width, sh = video ? src.videoHeight : src.height;

    const k = Math.min(1, THUMB_MAX / Math.max(sw, sh));
    const base = document.createElement('canvas');
    base.width = Math.max(1, Math.round(sw * k));
    base.height = Math.max(1, Math.round(sh * k));
    const bctx = base.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(src, 0, 0, base.width, base.height);
    const dims = `${sw}×${sh}`;
    const duration = video && isFinite(src.duration) ? clock(src.duration) : '';
    if (video) releaseVideo(src); else src.close();

    const pic = { file, video, base, ...buildCard(file, dims, video && `▶ ${duration}`.trim()) };
    pic.view.width = base.width;
    pic.view.height = base.height;
    state.pics.push(pic);
    renderPic(pic, s);
    updateControls();
  }
}

function buildCard(file, dims, kind) {
  const card = document.createElement('figure');
  card.className = 'card';
  card.style.margin = '0';
  card.innerHTML = `
    <div class="thumb"><canvas></canvas></div>
    <figcaption class="meta">
      <span class="name"></span>
      <span class="kind" hidden></span>
      <span class="tag" hidden></span>
      <button type="button" title="Download this file">↓</button>
    </figcaption>`;
  const name = card.querySelector('.name');
  name.textContent = file.name;
  name.title = `${file.name} · ${dims}`;
  if (kind) Object.assign(card.querySelector('.kind'), { hidden: false, textContent: kind });
  const pic = {
    card,
    view: card.querySelector('canvas'),
    tag: card.querySelector('.tag'),
    dlBtn: card.querySelector('button'),
  };
  pic.dlBtn.addEventListener('click', () => exportPics(state.pics.filter((p) => p.file === file)));
  ui.gallery.appendChild(card);
  return pic;
}

// ---------- export ----------

const videoType = () => window.MediaRecorder && VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported(t));

function outputType(file, s) {
  if (isVideo(file)) return (videoType() || 'video/webm').split(';')[0];
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

async function renderFull(pic, s, onProgress) {
  if (pic.video) return renderVideo(pic, s, onProgress);
  const bitmap = await createImageBitmap(pic.file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  const type = outputType(pic.file, s);
  if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const corner = state.icon ? pic.corner || pickCorner(pic, s) : null;
  drawMarks(ctx, canvas.width, canvas.height, corner, s);
  const blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, s.quality));
  canvas.width = canvas.height = 0; // release memory early
  return { blob, type };
}

// Plays the video once, drawing every frame plus the marks onto a canvas, and
// records that canvas together with the original soundtrack. Runs in real
// time; background tabs stop delivering frames, so the tab must stay visible.
async function renderVideo(pic, s, onProgress) {
  const mimeType = videoType();
  if (!mimeType) throw new Error('this browser cannot record video');
  const v = await loadVideo(pic.file, false);
  const W = v.videoWidth, H = v.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const corner = state.icon ? pic.corner || pickCorner(pic, s) : null;
  const draw = () => { ctx.drawImage(v, 0, 0, W, H); drawMarks(ctx, W, H, corner, s); };

  // Route the soundtrack into the recording instead of the speakers.
  const stream = canvas.captureStream();
  const audio = new AudioContext();
  try {
    await audio.resume();
    const dest = audio.createMediaStreamDestination();
    audio.createMediaElementSource(v).connect(dest);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.max(2e6, W * H * 5) });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });
    const ended = new Promise((res, rej) => {
      v.onended = res;
      v.onerror = () => rej(new Error(`playback failed: ${pic.file.name}`));
    });

    await seek(v, 0);
    draw();
    let running = true;
    const next = () => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick));
    const tick = () => {
      if (!running) return;
      draw();
      if (onProgress && isFinite(v.duration)) onProgress(v.currentTime / v.duration);
      next();
    };
    rec.start(1000);
    next();
    // Unmuted playback can be refused without a fresh tap; fall back to a silent recording.
    try { await v.play(); } catch { v.muted = true; await v.play(); }
    await ended;
    running = false;
    draw();
    rec.stop();
    await stopped;
    return { blob: new Blob(chunks, { type: mimeType.split(';')[0] }), type: mimeType.split(';')[0] };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    audio.close();
    releaseVideo(v);
    canvas.width = canvas.height = 0;
  }
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

// One file downloads directly; several go into a zip.
async function exportPics(pics) {
  if (state.busy || !pics.length || !hasMarks(settings())) return;
  state.busy = true;
  updateControls();
  const s = settings();
  const single = pics.length === 1;
  const span = single ? 100 : 90; // leave the last 10% of the bar for zipping
  const zip = single ? null : new JSZip();
  const used = new Set();
  const bar = ui.progress.firstElementChild;
  ui.progress.hidden = false;
  let failed = 0;
  try {
    for (let i = 0; i < pics.length; i++) {
      const pic = pics[i];
      const count = single ? '' : ` ${i + 1} / ${pics.length}`;
      ui.status.textContent = pic.video
        ? `Recording video${count} — keep this tab open…`
        : `Rendering${count}…`;
      bar.style.width = `${(i / pics.length) * span}%`;
      const progress = (f) => { bar.style.width = `${((i + f) / pics.length) * span}%`; };
      try {
        const { blob, type } = await renderFull(pic, s, progress);
        if (single) {
          saveBlob(blob, outputName(pic.file, type));
          ui.status.textContent = `Saved ${pic.file.name}.`;
          return;
        }
        zip.file(outputName(pic.file, type, used), blob);
      } catch (err) {
        if (single) throw err;
        failed++;
      }
    }
    ui.status.textContent = 'Zipping…';
    // Images are already compressed; STORE keeps zipping fast.
    const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' },
      (m) => { bar.style.width = `${90 + m.percent / 10}%`; });
    saveBlob(out, 'iconized.zip');
    ui.status.textContent = failed ? `Done — ${failed} file(s) failed.` : `Done — ${pics.length} files.`;
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

for (const el of [ui.position, ui.size, ui.margin, ui.opacity, ...ui.autoCornersField.querySelectorAll('input'),
  ui.priceOn, ui.price, ui.priceCorner, ui.sizeTagOn, ui.sizeTag, ui.sizeTagCorner, ui.tagStyle, ui.tagSize]) {
  for (const type of ['input', 'change']) el.addEventListener(type, () => { syncOutputs(); renderAll(); });
}
// Typing into a tag turns it on; the checkbox alone toggles it off.
for (const [box, text] of [[ui.priceOn, ui.price], [ui.sizeTagOn, ui.sizeTag]]) {
  text.addEventListener('input', () => { if (text.value.trim()) { box.checked = true; syncOutputs(); } });
}
for (const el of [ui.format, ui.quality]) for (const type of ['input', 'change']) el.addEventListener(type, syncOutputs);
ui.downloadBtn.addEventListener('click', () => exportPics(state.pics));

syncOutputs();
updateControls();
