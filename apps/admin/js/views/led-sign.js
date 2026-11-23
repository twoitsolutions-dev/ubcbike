import { h, mount } from '../ui/dom.js';
import { card, pageHead, toast } from '../ui/components.js';
import { encodeMjpegAvi, encodeRgb24Avi, rgbaToBgr24BottomUp } from '../ui/avi-encoder.js?v=84';

// UBC street sign: 214 x 112 pixels, 15 fps, audio-free .AVI.
const W = 214;
const H = 112;
const FPS = 15;
const MAX_SLIDES = 6;

// Kallisto (cufonfonts demo) ships blank digits/punctuation, so the FontFace is limited
// to letters + space via unicodeRange and everything else falls back to Arial Black.
const PRO_FONT = '"UBC Kallisto", "Arial Black", Impact, Arial, sans-serif';
const NUM_FONT = '"Arial Black", Impact, Arial, sans-serif';

const COLORS = {
  blue_red_white: { label: 'Light Blue', primary: '#38BDF8' },
  red_white: { label: 'UBC Red', primary: '#FF2D2D' },
  cyan_white: { label: 'Electric Cyan', primary: '#00E5FF' },
  yellow_cyan: { label: 'Neon Yellow', primary: '#FFE600' },
  green_white: { label: 'Neon Green', primary: '#00FF66' },
};

const LAYOUTS = [
  ['slam', 'Headline'],
  ['swap', 'Line Swap'],
  ['rating', 'Star Rating'],
  ['brand', 'UBC Close (logo + phone)'],
];

const TAMPA = '(813) 971-2277 · UBCBIKE.COM';
const ALAFIA = '(813) 459-8293 · UBCBIKE.COM';
const S = (layout, line1, line2, palette, seconds, foot) => ({ layout, line1, line2, foot: foot || '', palette, seconds });

// Built-in templates. Copy only uses facts published on ubcbike.com or given by UBC.
const BUILTIN = [
  { id: 'street', name: 'Street Ad', slides: [S('slam', 'NEW', 'E-BIKES', 'blue_red_white', 5), S('slam', 'WE FIX', 'BIKES, E-BIKES, SCOOTERS', 'red_white', 6), S('swap', 'WALK IN TODAY', 'READY IN 24H', 'blue_red_white', 5), S('brand', '', '', 'blue_red_white', 5, TAMPA)] },
  { id: 'reviews', name: '4.8 Stars · 1,100+ Reviews', slides: [S('rating', '4.8 STARS', '1,100+ REVIEWS', 'yellow_cyan', 6), S('slam', 'THANK YOU', 'TAMPA', 'blue_red_white', 4), S('swap', 'SEE WHY', 'VISIT UBC TODAY', 'yellow_cyan', 5), S('brand', '', '', 'yellow_cyan', 5, TAMPA)] },
  { id: 'black_friday', name: 'Black Friday', slides: [S('slam', 'BLACK', 'FRIDAY', 'red_white', 4), S('slam', 'BIKES UP TO', '35% OFF', 'red_white', 5), S('swap', 'WE PRICE MATCH', 'SHOP IN STORE', 'blue_red_white', 5), S('brand', '', '', 'red_white', 5, TAMPA)] },
  { id: 'alafia', name: 'Alafia Rentals', slides: [S('slam', 'ALAFIA', 'BIKE RENTALS', 'green_white', 5), S('slam', 'RIDE THE', 'TRAILS', 'green_white', 6), S('swap', 'WED-FRI 10-5', 'SAT-SUN 8-5', 'green_white', 5), S('brand', '', '', 'green_white', 5, ALAFIA)] },
  { id: 'online', name: 'Shop Online', slides: [S('slam', 'SHOP', 'ONLINE', 'cyan_white', 4), S('swap', 'ORDER ONLINE', 'FREE PICKUP', 'cyan_white', 5), S('slam', 'FREE SHIPPING', '$50+', 'cyan_white', 5), S('brand', '', '', 'cyan_white', 5, 'UBCBIKE.COM · (813) 971-2277')] },
  { id: 'financing', name: 'Financing', slides: [S('slam', 'EASY', 'FINANCING', 'yellow_cyan', 4), S('slam', 'WITH', 'SYNCHRONY, SNAP, ACIMA', 'yellow_cyan', 6), S('swap', 'RIDE TODAY', 'PAY OVER TIME', 'yellow_cyan', 5), S('brand', '', '', 'yellow_cyan', 5, TAMPA)] },
  { id: 'service', name: 'Service & Tune-Ups', slides: [S('slam', 'TUNE-UPS', 'FROM $100', 'blue_red_white', 5), S('swap', 'NO APPOINTMENT', '1 DAY REPAIRS', 'blue_red_white', 5), S('slam', 'WE FIX', 'ROAD, MTB, E-BIKES', 'red_white', 6), S('brand', '', '', 'blue_red_white', 5, TAMPA)] },
  { id: 'trade_in', name: 'Trade-In', slides: [S('slam', 'TRADE IN', 'YOUR BIKE', 'cyan_white', 5), S('swap', 'GET CREDIT', 'UPGRADE TODAY', 'cyan_white', 5), S('slam', 'WE', 'PRICE MATCH', 'red_white', 4), S('brand', '', '', 'cyan_white', 5, TAMPA)] },
  { id: 'since_1972', name: 'Since 1972', slides: [S('slam', 'SINCE', '1972', 'blue_red_white', 4), S('slam', 'TAMPA', 'BIKE SHOP', 'blue_red_white', 5), S('swap', '1220 E FLETCHER', 'OPEN MON - SAT', 'blue_red_white', 5), S('brand', '', '', 'blue_red_white', 5, TAMPA)] },
];

const cloneSlides = (slides) => slides.map((s) => Object.assign({}, s));
const slideSeconds = (s) => Math.min(10, Math.max(2, Number(s.seconds) || 5));
const totalSeconds = (slides) => slides.reduce((a, s) => a + slideSeconds(s), 0);

function easeOutExpo(t) {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * Math.max(0, t));
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function fitFont(ctx2d, text, maxWidth, startSize, minSize, family) {
  let size = startSize;
  while (size > minSize) {
    ctx2d.font = '900 ' + size + 'px ' + family;
    if (ctx2d.measureText(text).width <= maxWidth) break;
    size -= 1;
  }
  ctx2d.font = '900 ' + size + 'px ' + family;
  return size;
}

function drawRail(ctx2d, railSec) {
  const x = ((railSec / 3.5) % 1) * 2 * W - W;
  const g = ctx2d.createLinearGradient(x, 0, x + W, 0);
  g.addColorStop(0, 'rgba(56,189,248,0)');
  g.addColorStop(0.35, '#38BDF8');
  g.addColorStop(0.65, '#FF2D2D');
  g.addColorStop(1, 'rgba(255,45,45,0)');
  ctx2d.save();
  ctx2d.globalAlpha = 0.9;
  ctx2d.fillStyle = g;
  ctx2d.fillRect(x, H - 2, W, 2);
  ctx2d.restore();
}

function starPath(ctx2d, cx, cy, r) {
  ctx2d.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx2d.moveTo(x, y);
    else ctx2d.lineTo(x, y);
  }
  ctx2d.closePath();
}

function drawBrand(ctx2d, slide, t, assets) {
  const parts = String(slide.foot || TAMPA).split(/[·|]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const mark = assets.ubcMark;
  const kIn = easeOutExpo(Math.min(1, t / 0.75));
  let y = Math.round(H * 0.06);
  if (mark && mark.complete && mark.naturalWidth > 0) {
    const mh = Math.round(H * 0.41);
    const mw = Math.round(mark.naturalWidth * (mh / mark.naturalHeight));
    const sc = 1.18 - 0.18 * kIn;
    ctx2d.save();
    ctx2d.globalAlpha = kIn;
    if ('filter' in ctx2d) ctx2d.filter = 'blur(' + ((1 - kIn) * 6).toFixed(2) + 'px)';
    ctx2d.translate(W / 2, y + mh / 2);
    ctx2d.scale(sc, sc);
    ctx2d.drawImage(mark, -mw / 2, -mh / 2, mw, mh);
    ctx2d.restore();
    y += mh + 4;
  }
  const sizes = [Math.round(H * 0.19), Math.round(H * 0.12)];
  const colors = ['#FFFFFF', '#38BDF8'];
  parts.slice(0, 2).forEach((txt, i) => {
    const k = easeOutExpo(Math.min(1, Math.max(0, t - 0.35 - i * 0.25) / 0.55));
    const sz = fitFont(ctx2d, txt, W - 12, sizes[i], 7, NUM_FONT);
    ctx2d.save();
    ctx2d.globalAlpha = k;
    ctx2d.fillStyle = colors[i];
    ctx2d.fillText(txt, W / 2, y + sz / 2 + Math.round((1 - k) * 8));
    ctx2d.restore();
    y += sz + 3;
  });
}

function drawSwap(ctx2d, slide, t, dur, accent) {
  const lines = [String(slide.line1 || '').toUpperCase().trim(), String(slide.line2 || '').toUpperCase().trim()].filter(Boolean);
  if (!lines.length) return;
  const swapAt = lines.length > 1 ? dur * 0.42 : dur + 1;
  const showB = t >= swapAt;
  const txt = showB ? lines[1] : lines[0];
  const local = showB ? t - swapAt : t;
  const k = easeOutExpo(Math.min(1, local / 0.4));
  const sz = fitFont(ctx2d, txt, W - 12, Math.round(H * 0.4), 10, PRO_FONT);
  const cy = Math.round(H * 0.48);
  ctx2d.save();
  ctx2d.globalAlpha = k;
  ctx2d.fillStyle = '#FFFFFF';
  ctx2d.fillText(txt, W / 2, cy + Math.round((1 - k) * 14));
  ctx2d.restore();
  if (showB) {
    const words = txt.split(/\s+/);
    const last = words[words.length - 1];
    const full = ctx2d.measureText(txt).width;
    const lw = ctx2d.measureText(last).width;
    const u = easeOutExpo(Math.min(1, Math.max(0, local - 0.3) / 0.5));
    ctx2d.fillStyle = accent;
    ctx2d.fillRect(Math.round(W / 2 + full / 2 - lw), Math.round(cy + sz * 0.5 + 2), Math.round(lw * u), 2);
  }
}

function drawRating(ctx2d, slide, t, accent) {
  const l1 = String(slide.line1 || '').toUpperCase().trim();
  const l2 = String(slide.line2 || '').toUpperCase().trim();
  const m = l1.match(/\d+(\.\d+)?/);
  const rating = Math.max(0, Math.min(5, m ? Number(m[0]) : 5));
  const r = 10;
  const gap = 24;
  const cy = 18;
  for (let i = 0; i < 5; i++) {
    const cx = W / 2 + (i - 2) * gap;
    const k = easeOutExpo(Math.min(1, Math.max(0, t - i * 0.12) / 0.35));
    if (k <= 0) continue;
    ctx2d.save();
    ctx2d.globalAlpha = k;
    ctx2d.translate(cx, cy);
    ctx2d.scale(0.4 + 0.6 * k, 0.4 + 0.6 * k);
    starPath(ctx2d, 0, 0, r);
    ctx2d.fillStyle = '#3A3A3A';
    ctx2d.fill();
    const fill = Math.max(0, Math.min(1, rating - i));
    if (fill > 0) {
      ctx2d.save();
      ctx2d.clip();
      ctx2d.fillStyle = accent;
      ctx2d.fillRect(-r, -r, 2 * r * fill, 2 * r);
      ctx2d.restore();
    }
    ctx2d.restore();
  }
  const kText = easeOutExpo(Math.min(1, Math.max(0, t - 0.6) / 0.45));
  ctx2d.save();
  ctx2d.globalAlpha = kText;
  if (l1) {
    fitFont(ctx2d, l1, W - 12, 30, 10, PRO_FONT);
    ctx2d.fillStyle = '#FFFFFF';
    ctx2d.fillText(l1, W / 2, 54 + Math.round((1 - kText) * 8));
  }
  if (l2) {
    fitFont(ctx2d, l2, W - 12, 24, 9, PRO_FONT);
    ctx2d.fillStyle = accent;
    ctx2d.fillText(l2, W / 2, 86 + Math.round((1 - kText) * 8));
  }
  ctx2d.restore();
}

function drawSlam(ctx2d, slide, t, dur, accent) {
  const l1 = String(slide.line1 || '').toUpperCase().trim();
  const opts = String(slide.line2 || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  const share = dur / Math.max(1, opts.length);
  const wi = Math.max(0, Math.min(opts.length - 1, Math.floor(t / share)));
  const word = opts.length ? opts[wi] : '';
  const kIn = easeOutExpo(Math.min(1, t / 0.35));
  const kWord = wi > 0 ? easeOutExpo(Math.min(1, (t - wi * share) / 0.3)) : kIn;
  const big = Math.round(H * 0.4);

  // one line if every rotating word fits big enough, otherwise stack the two lines
  let longest = word;
  opts.forEach((o) => { if (o.length > longest.length) longest = o; });
  const oneSz = fitFont(ctx2d, (l1 ? l1 + ' ' : '') + longest, W - 12, big, 8, PRO_FONT);
  const stacked = l1 && word && oneSz < Math.round(H * 0.24);

  ctx2d.save();
  const sc = 1.28 - 0.28 * kIn;
  ctx2d.translate(W / 2, H * 0.47);
  ctx2d.scale(sc, sc);
  const alpha = Math.min(1, kIn * 1.2);
  ctx2d.globalAlpha = alpha;
  if (!stacked) {
    ctx2d.font = '900 ' + oneSz + 'px ' + PRO_FONT;
    const w1 = l1 ? ctx2d.measureText(l1 + ' ').width : 0;
    const w2 = ctx2d.measureText(word).width;
    let x = -(w1 + w2) / 2;
    ctx2d.textAlign = 'left';
    if (l1) { ctx2d.fillStyle = '#FFFFFF'; ctx2d.fillText(l1, x, 0); x += w1; }
    ctx2d.globalAlpha = alpha * kWord;
    ctx2d.fillStyle = accent;
    ctx2d.fillText(word, x, Math.round((1 - kWord) * 10));
  } else {
    const s1 = fitFont(ctx2d, l1, W - 12, big, 8, PRO_FONT);
    ctx2d.fillStyle = '#FFFFFF';
    ctx2d.fillText(l1, 0, -Math.round(s1 * 0.55));
    const s2 = fitFont(ctx2d, longest, W - 12, big, 8, PRO_FONT);
    ctx2d.font = '900 ' + s2 + 'px ' + PRO_FONT;
    ctx2d.globalAlpha = alpha * kWord;
    ctx2d.fillStyle = accent;
    ctx2d.fillText(word, 0, Math.round(s2 * 0.55) + Math.round((1 - kWord) * 10));
  }
  ctx2d.restore();
}

function drawSlide(ctx2d, slide, t, assets, railSec) {
  const accent = (COLORS[slide.palette] || COLORS.blue_red_white).primary;
  const dur = slideSeconds(slide);
  ctx2d.fillStyle = '#000000';
  ctx2d.fillRect(0, 0, W, H);
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';
  if (slide.layout === 'brand') drawBrand(ctx2d, slide, t, assets);
  else if (slide.layout === 'swap') drawSwap(ctx2d, slide, t, dur, accent);
  else if (slide.layout === 'rating') drawRating(ctx2d, slide, t, accent);
  else drawSlam(ctx2d, slide, t, dur, accent);
  drawRail(ctx2d, railSec);
}

const bufs = {};
function buffer(key) {
  if (!bufs[key]) {
    bufs[key] = document.createElement('canvas');
    bufs[key].width = W;
    bufs[key].height = H;
  }
  return bufs[key];
}

// Draws the whole ad at time `sec` (loops), with a 0.3 s crossfade between slides.
function drawFrame(ctx2d, slides, sec, assets) {
  const total = totalSeconds(slides);
  let rem = sec % Math.max(1, total);
  let idx = 0;
  for (let i = 0; i < slides.length; i++) {
    const d = slideSeconds(slides[i]);
    if (rem < d || i === slides.length - 1) { idx = i; break; }
    rem -= d;
  }
  const cur = slides[idx];
  const dur = slideSeconds(cur);
  const trans = slides.length > 1 ? 0.3 : 0;
  if (trans && rem > dur - trans) {
    const k = easeInOutCubic((rem - (dur - trans)) / trans);
    const a = buffer('a');
    const b = buffer('b');
    drawSlide(a.getContext('2d'), cur, rem, assets, sec);
    drawSlide(b.getContext('2d'), slides[(idx + 1) % slides.length], 0.01, assets, sec);
    ctx2d.fillStyle = '#000000';
    ctx2d.fillRect(0, 0, W, H);
    ctx2d.save();
    ctx2d.globalAlpha = 1 - k;
    ctx2d.drawImage(a, 0, 0);
    ctx2d.globalAlpha = k;
    ctx2d.drawImage(b, 0, 0);
    ctx2d.restore();
    return;
  }
  drawSlide(ctx2d, cur, rem, assets, sec);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function slugify(name) {
  return String(name || 'ad').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ad';
}

export async function renderLedSign(ctx) {
  const ubcMark = new window.Image();
  ubcMark.src = 'assets/ubc-mark-white.png';
  const assets = { ubcMark };
  let fontReady = Promise.resolve();
  if (window.FontFace && document.fonts) {
    const ff = new window.FontFace('UBC Kallisto', 'url(assets/fonts/kallisto-black.otf)', {
      weight: '900',
      unicodeRange: 'U+0020, U+0041-005A, U+0061-007A',
    });
    fontReady = ff.load().then((f) => { document.fonts.add(f); }).catch(() => {});
  }

  const st = {
    slides: cloneSlides(BUILTIN[0].slides),
    activeIdx: 0,
    source: { kind: 'builtin', id: BUILTIN[0].id, name: BUILTIN[0].name },
    custom: [],
    codec: 'mjpeg',
    exporting: false,
  };

  const canvas1x = h('canvas.led-canvas-1x', { width: W, height: H });
  const canvas2x = h('canvas.led-canvas-2x', { width: W, height: H });
  canvas1x.style.width = W + 'px';
  canvas1x.style.height = H + 'px';
  canvas2x.style.width = W * 2 + 'px';
  canvas2x.style.height = H * 2 + 'px';
  const ctx1 = canvas1x.getContext('2d');
  const ctx2 = canvas2x.getContext('2d');

  const builtinHost = h('div.led-tpl-row');
  const customHost = h('div.led-tpl-row');
  const saveHost = h('div.led-tpl-row');
  const slidesHost = h('div.led-slide-tabs');
  const editorHost = h('div.stack-sm');
  const exportBtn = h('button.btn.primary', { type: 'button' }, 'Download .AVI');
  const exportStatus = h('span.small.muted', '');
  const nameInput = h('input.led-name', { type: 'text', maxlength: '60', placeholder: 'Template name, e.g. Christmas Sale' });

  let rafId = null;
  let startTs = performance.now();
  const restartPreview = () => { startTs = performance.now(); };

  function drawPreviewLoop(now) {
    if (!ctx.isCurrent()) {
      if (rafId) window.cancelAnimationFrame(rafId);
      return;
    }
    drawFrame(ctx1, st.slides, (now - startTs) / 1000, assets);
    ctx2.drawImage(canvas1x, 0, 0);
    rafId = window.requestAnimationFrame(drawPreviewLoop);
  }

  function updateStatus() {
    exportStatus.textContent = st.slides.length + ' slides · ' + totalSeconds(st.slides) + ' s loop · ' + W + '×' + H + ' · ' + FPS + ' fps · no audio';
  }

  function loadTemplate(kind, tpl) {
    st.slides = cloneSlides(tpl.slides);
    st.activeIdx = 0;
    st.source = { kind, id: tpl.id, name: tpl.name };
    nameInput.value = kind === 'custom' ? tpl.name : '';
    restartPreview();
    renderAll();
  }

  function renderTemplates() {
    const isOn = (kind, id) => st.source.kind === kind && st.source.id === id;
    mount(builtinHost, BUILTIN.map((t) => h('button.btn.sm', {
      type: 'button',
      class: isOn('builtin', t.id) ? 'primary' : '',
      onclick: () => loadTemplate('builtin', t),
    }, t.name)));
    mount(customHost, st.custom.length
      ? st.custom.map((t) => h('span.led-custom-chip',
        h('button.btn.sm', {
          type: 'button',
          class: isOn('custom', t.id) ? 'primary' : '',
          title: t.author ? 'Saved by ' + t.author : '',
          onclick: () => loadTemplate('custom', t),
        }, t.name),
        h('button.btn.sm.danger', {
          type: 'button',
          title: 'Delete template',
          'aria-label': 'Delete ' + t.name,
          onclick: () => deleteTemplate(t),
        }, '×')))
      : h('span.small.muted', 'No saved templates yet. Edit the slides, write a name and press "Save as new template".'));
    const editingCustom = st.source.kind === 'custom';
    mount(saveHost,
      nameInput,
      h('button.btn.sm.primary', { type: 'button', onclick: () => saveTemplate(false) }, 'Save as new template'),
      editingCustom ? h('button.btn.sm', { type: 'button', onclick: () => saveTemplate(true) }, 'Update "' + st.source.name + '"') : null,
      h('button.btn.sm', {
        type: 'button',
        onclick: () => {
          st.slides = [S('slam', 'NEW', 'MESSAGE', 'blue_red_white', 5), S('brand', '', '', 'blue_red_white', 5, TAMPA)];
          st.activeIdx = 0;
          st.source = { kind: 'new', id: null, name: '' };
          nameInput.value = '';
          restartPreview();
          renderAll();
        },
      }, 'Start blank'));
  }

  function slidePayload() {
    return st.slides.map((s) => ({
      layout: s.layout || 'slam',
      line1: String(s.line1 || '').slice(0, 60),
      line2: String(s.line2 || '').slice(0, 120),
      foot: String(s.foot || '').slice(0, 80),
      palette: COLORS[s.palette] ? s.palette : 'blue_red_white',
      seconds: slideSeconds(s),
    }));
  }

  async function loadCustom() {
    try {
      const res = await ctx.api.ledTemplates();
      st.custom = res.templates || [];
    } catch (err) {
      st.custom = [];
      toast('Could not load saved templates: ' + (err.message || err), 'bad');
    }
    renderTemplates();
  }

  async function saveTemplate(update) {
    const name = nameInput.value.trim() || (update ? st.source.name : '');
    if (!name) {
      toast('Write a name for the template first.', 'bad');
      nameInput.focus();
      return;
    }
    try {
      const body = { name, slides: slidePayload() };
      const saved = update ? await ctx.api.updateLedTemplate(st.source.id, body) : await ctx.api.createLedTemplate(body);
      st.source = { kind: 'custom', id: saved.id, name: saved.name };
      nameInput.value = saved.name;
      toast((update ? 'Updated' : 'Saved') + ' template "' + saved.name + '"', 'ok');
      await loadCustom();
    } catch (err) {
      toast(err.message || 'Could not save the template', 'bad');
    }
  }

  async function deleteTemplate(t) {
    customHost.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await ctx.api.deleteLedTemplate(t.id);
      if (st.source.kind === 'custom' && st.source.id === t.id) st.source = { kind: 'new', id: null, name: '' };
      toast('Deleted template "' + t.name + '"', 'ok');
    } catch (err) {
      toast(err.message || 'Could not delete the template', 'bad');
    }
    await loadCustom();
  }

  function layoutName(layout) {
    return (LAYOUTS.find((l) => l[0] === layout) || LAYOUTS[0])[1].split(' (')[0];
  }

  function renderSlidesBar() {
    mount(slidesHost,
      st.slides.map((s, idx) => h('button.rep-tab', {
        type: 'button',
        class: idx === st.activeIdx ? 'on' : '',
        onclick: () => { st.activeIdx = idx; renderSlidesBar(); renderSlideEditor(); },
      }, (idx + 1) + '. ' + layoutName(s.layout) + ' · ' + slideSeconds(s) + 's')),
      st.slides.length < MAX_SLIDES ? h('button.btn.sm', {
        type: 'button',
        onclick: () => {
          st.slides.splice(st.activeIdx + 1, 0, S('slam', 'NEW', 'MESSAGE', 'blue_red_white', 5));
          st.activeIdx += 1;
          restartPreview();
          renderAll();
        },
      }, '+ Slide') : null);
  }

  function renderSlideEditor() {
    const cur = st.slides[st.activeIdx] || st.slides[0];
    const layout = cur.layout || 'slam';
    const field = (label, key, placeholder, hint) => h('label.led-field',
      h('span.small.muted', label),
      h('input', { type: 'text', value: cur[key] || '', placeholder, oninput: (e) => { cur[key] = e.target.value; } }),
      hint ? h('span.small.muted', hint) : null);

    const layoutSel = h('select', {
      onchange: (e) => {
        cur.layout = e.target.value;
        if (cur.layout === 'brand' && !cur.foot) cur.foot = TAMPA;
        restartPreview();
        renderSlidesBar();
        renderSlideEditor();
      },
    }, LAYOUTS.map(([v, lbl]) => h('option', { value: v, selected: layout === v }, lbl)));

    const colorSel = h('select', { onchange: (e) => { cur.palette = e.target.value; } },
      Object.keys(COLORS).map((k) => h('option', { value: k, selected: cur.palette === k }, COLORS[k].label)));

    const secSel = h('select', {
      onchange: (e) => { cur.seconds = Number(e.target.value) || 5; restartPreview(); renderSlidesBar(); updateStatus(); },
    }, [3, 4, 5, 6, 7, 8].map((sec) => h('option', { value: String(sec), selected: slideSeconds(cur) === sec }, sec + ' seconds')));

    const move = (dir) => {
      const j = st.activeIdx + dir;
      if (j < 0 || j >= st.slides.length) return;
      const tmp = st.slides[j];
      st.slides[j] = st.slides[st.activeIdx];
      st.slides[st.activeIdx] = tmp;
      st.activeIdx = j;
      restartPreview();
      renderAll();
    };

    let fields;
    if (layout === 'brand') {
      fields = [field('Phone · Website', 'foot', '(813) 971-2277 · UBCBIKE.COM', 'Separate the two lines with ·')];
    } else if (layout === 'rating') {
      fields = [
        field('Rating line', 'line1', '4.8 STARS', 'The number fills the stars (4.8 = 4 full + 80%).'),
        field('Reviews line (accent color)', 'line2', '1,100+ REVIEWS'),
      ];
    } else if (layout === 'swap') {
      fields = [field('First line', 'line1', 'WALK IN TODAY'), field('Second line (last word underlined)', 'line2', 'READY IN 24H')];
    } else {
      fields = [
        field('Line 1 (white)', 'line1', 'WE FIX'),
        field('Line 2 (accent color)', 'line2', 'BIKES, E-BIKES, SCOOTERS', 'Use commas to rotate several words.'),
      ];
    }

    mount(editorHost,
      h('div.led-form-grid',
        h('label.led-field', h('span.small.muted', 'Slide type'), layoutSel),
        h('label.led-field', h('span.small.muted', 'Time on screen'), secSel),
        fields,
        layout !== 'brand' ? h('label.led-field', h('span.small.muted', 'Accent color'), colorSel) : null),
      h('div.led-tpl-row',
        h('button.btn.sm', { type: 'button', disabled: st.activeIdx === 0, onclick: () => move(-1) }, '← Move'),
        h('button.btn.sm', { type: 'button', disabled: st.activeIdx === st.slides.length - 1, onclick: () => move(1) }, 'Move →'),
        st.slides.length > 1 ? h('button.btn.sm.danger', {
          type: 'button',
          onclick: () => {
            st.slides.splice(st.activeIdx, 1);
            st.activeIdx = Math.max(0, st.activeIdx - 1);
            restartPreview();
            renderAll();
          },
        }, 'Remove slide') : null));
  }

  function renderAll() {
    renderTemplates();
    renderSlidesBar();
    renderSlideEditor();
    updateStatus();
  }

  async function canvasToJpegBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error('Canvas JPEG export failed'));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, 'image/jpeg', 0.94);
    });
  }

  exportBtn.addEventListener('click', async () => {
    if (st.exporting) return;
    st.exporting = true;
    exportBtn.disabled = true;
    try {
      await fontReady;
      const off = document.createElement('canvas');
      off.width = W;
      off.height = H;
      const octx = off.getContext('2d', { willReadFrequently: true });
      const total = totalSeconds(st.slides);
      const frames = [];
      const count = Math.round(total * FPS);
      for (let f = 0; f < count; f++) {
        drawFrame(octx, st.slides, f / FPS, assets);
        if (st.codec === 'rgb24') frames.push(rgbaToBgr24BottomUp(octx.getImageData(0, 0, W, H).data, W, H));
        else frames.push(await canvasToJpegBytes(off));
        if ((f + 1) % 15 === 0 || f + 1 === count) {
          exportStatus.textContent = 'Rendering frame ' + (f + 1) + ' / ' + count + '…';
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      const blob = st.codec === 'rgb24' ? encodeRgb24Avi(frames, W, H, FPS) : encodeMjpegAvi(frames, W, H, FPS);
      const fname = 'ubc-led-' + slugify(st.source.name || nameInput.value) + '-' + W + 'x' + H + '.avi';
      downloadBlob(blob, fname);
      const kb = Math.round(blob.size / 1024);
      exportStatus.textContent = 'Downloaded ' + fname + ' (' + kb + ' KB, ' + total + ' s)';
      toast('.AVI ready (' + total + ' s, ' + kb + ' KB)', 'ok');
    } catch (err) {
      toast(err.message || 'AVI export failed', 'bad');
      updateStatus();
    } finally {
      st.exporting = false;
      exportBtn.disabled = false;
    }
  });

  const codecSel = h('select', { onchange: (e) => { st.codec = e.target.value; } },
    h('option', { value: 'mjpeg', selected: true }, 'MJPEG .avi (standard, small file)'),
    h('option', { value: 'rgb24' }, 'Uncompressed .avi (older LED controllers)'));

  renderAll();
  loadCustom();
  fontReady.then(restartPreview);
  rafId = window.requestAnimationFrame(drawPreviewLoop);

  return h('div.stack.led-root',
    pageHead('LED Sign Studio', 'Ads for the 214×112 street sign. Pick a template, edit the slides, save your own templates and download the .AVI.'),
    card('1. Templates', h('div.stack-sm',
      h('span.small.muted', 'UBC templates'),
      builtinHost,
      h('span.small.muted', 'Saved by the team'),
      customHost,
      saveHost)),
    h('div.grid.grid-2',
      card('2. Slides', h('div.stack-sm', slidesHost, editorHost)),
      card('3. Preview & download', h('div.stack-sm',
        h('div.led-previews',
          h('div.led-prev-box', h('span.small.muted', 'Actual size'), canvas1x),
          h('div.led-prev-box', h('span.small.muted', '2× zoom'), canvas2x)),
        h('div.led-export-opts', h('label.led-field', h('span.small.muted', 'File format'), codecSel)),
        h('div.row-between', exportStatus, exportBtn)))));
}
