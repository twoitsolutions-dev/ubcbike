import { h, mount } from '../ui/dom.js';
import { card, pageHead, toast } from '../ui/components.js';
import { money } from '../ui/format.js';
import { encodeMjpegAvi, encodeRgb24Avi, rgbaToBgr24BottomUp } from '../ui/avi-encoder.js?v=81';

const W = 224;
const H = 212;

const PALETTES = {
  cyan_white: { label: 'Light Blue + White', primary: '#00E5FF', secondary: '#FFFFFF', badgeBg: '#00E5FF', badgeFg: '#000000', border: '#00E5FF' },
  red_white: { label: 'Vibrant Red + White', primary: '#FF1E1E', secondary: '#FFFFFF', badgeBg: '#FF1E1E', badgeFg: '#FFFFFF', border: '#FF1E1E' },
  blue_red_white: { label: 'Light Blue + Red + White', primary: '#38BDF8', secondary: '#FFFFFF', badgeBg: '#FF1E1E', badgeFg: '#FFFFFF', border: '#38BDF8' },
  yellow_cyan: { label: 'Neon Yellow + Light Blue', primary: '#FFE600', secondary: '#00E5FF', badgeBg: '#FFE600', badgeFg: '#000000', border: '#00E5FF' },
  green_white: { label: 'Neon Green + White', primary: '#00FF66', secondary: '#FFFFFF', badgeBg: '#00FF66', badgeFg: '#000000', border: '#00FF66' },
};

const TEMPLATES = [
  {
    id: 'service',
    name: 'Walk-In Service Center',
    slides: [
      { badge: 'UBC SERVICE CENTER', line1: 'WALK-IN', line2: 'BIKE REPAIR', foot: 'MOST IN 24 HRS · NO APPT', palette: 'blue_red_white', seconds: 3 },
      { badge: 'ALL BRANDS WELCOME', line1: 'TUNE-UPS', line2: 'FROM $100', foot: 'CALL (813) 971-2277', palette: 'cyan_white', seconds: 3 },
    ],
  },
  {
    id: 'ebikes',
    name: 'Bikes & E-Bikes + 0% APR',
    slides: [
      { badge: 'IN STOCK TODAY', line1: 'BIKES &', line2: 'E-BIKES', foot: 'TEST RIDE ON FLETCHER', palette: 'cyan_white', seconds: 3 },
      { badge: 'EASY FINANCING', line1: '0% APR', line2: 'AVAILABLE', foot: 'INSTANT TRADE-IN CREDIT', palette: 'yellow_cyan', seconds: 3 },
    ],
  },
  {
    id: 'deals',
    name: 'Hot Sale / Red Tag',
    slides: [
      { badge: 'IN-STORE SPECIAL', line1: 'UP TO', line2: '$500 OFF', foot: 'SELECT BIKES & GEAR', palette: 'red_white', seconds: 3 },
      { badge: 'LOW PRICE GUARANTEE', line1: 'SHOP UBC', line2: 'SINCE 1972', foot: '1220 E FLETCHER AVE', palette: 'blue_red_white', seconds: 3 },
    ],
  },
  {
    id: 'discounts',
    name: 'Students, Veterans & Police',
    slides: [
      { badge: 'EVERYDAY SAVINGS', line1: 'USF · VETS', line2: '& POLICE', foot: 'IN-STORE DISCOUNTS', palette: 'blue_red_white', seconds: 3 },
      { badge: 'SHOW VALID ID', line1: 'HELMETS', line2: '& REPAIRS', foot: '5 MIN FROM USF CAMPUS', palette: 'cyan_white', seconds: 3 },
    ],
  },
  {
    id: 'alafia',
    name: 'Alafia Trail Rentals',
    slides: [
      { badge: 'ALAFIA RIVER PARK', line1: 'MTB & E-MTB', line2: 'RENTALS', foot: '20+ MILES OF TRAILS', palette: 'green_white', seconds: 3 },
      { badge: 'OPEN SAT & SUN 8AM', line1: 'RESERVE', line2: 'AT UBCBIKE', foot: '(813) 459-8293', palette: 'cyan_white', seconds: 3 },
    ],
  },
];

function wrapLines(ctx2d, text, maxWidth) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const next = cur + ' ' + words[i];
    if (ctx2d.measureText(next).width <= maxWidth) cur = next;
    else {
      lines.push(cur);
      cur = words[i];
    }
  }
  lines.push(cur);
  return lines;
}

function fitText(ctx2d, text, maxWidth, startSize, minSize, weight) {
  let size = startSize;
  const clean = String(text || '').trim();
  while (size > minSize) {
    ctx2d.font = weight + ' ' + size + 'px "Arial Black", Impact, Arial, sans-serif';
    if (ctx2d.measureText(clean).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

function drawSlideFrame(ctx2d, slide, phase01, animMode) {
  const pal = PALETTES[slide.palette] || PALETTES.cyan_white;
  // Pure black background maximizes outdoor LED contrast
  ctx2d.fillStyle = '#000000';
  ctx2d.fillRect(0, 0, W, H);

  // Subtle corner/border pulse for street visibility
  const pulse = animMode === 'pulse' ? (0.65 + 0.35 * Math.sin(phase01 * Math.PI * 4)) : 1;
  ctx2d.save();
  ctx2d.globalAlpha = pulse;
  ctx2d.strokeStyle = pal.border;
  ctx2d.lineWidth = 4;
  ctx2d.strokeRect(2, 2, W - 4, H - 4);
  ctx2d.restore();

  // Slide-in entrance during first 0.16 of slide duration
  let offsetY = 0;
  if (animMode === 'slide' && phase01 < 0.16) {
    const k = 1 - phase01 / 0.16;
    offsetY = Math.round(k * k * 28);
  }

  ctx2d.save();
  ctx2d.translate(0, offsetY);

  // Top bright pill bar
  const badge = String(slide.badge || '').toUpperCase().trim();
  if (badge) {
    ctx2d.fillStyle = pal.badgeBg;
    ctx2d.fillRect(8, 8, W - 16, 30);
    ctx2d.fillStyle = pal.badgeFg;
    const bSize = fitText(ctx2d, badge, W - 26, 17, 11, '900');
    ctx2d.font = '900 ' + bSize + 'px Arial, sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'middle';
    ctx2d.fillText(badge, W / 2, 24);
  }

  // Main Headline (Line 1 + Line 2) — extra large & high brightness
  const l1 = String(slide.line1 || '').toUpperCase().trim();
  const l2 = String(slide.line2 || '').toUpperCase().trim();
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';

  if (l1 && l2) {
    const s1 = fitText(ctx2d, l1, W - 20, 42, 18, '900');
    ctx2d.font = '900 ' + s1 + 'px "Arial Black", Impact, Arial, sans-serif';
    ctx2d.fillStyle = pal.secondary;
    ctx2d.fillText(l1, W / 2, 76);

    const s2 = fitText(ctx2d, l2, W - 20, 42, 18, '900');
    ctx2d.font = '900 ' + s2 + 'px "Arial Black", Impact, Arial, sans-serif';
    ctx2d.fillStyle = pal.primary;
    ctx2d.fillText(l2, W / 2, 126);
  } else if (l1 || l2) {
    const single = l1 || l2;
    ctx2d.font = '900 34px "Arial Black", Impact, Arial, sans-serif';
    const lines = wrapLines(ctx2d, single, W - 22).slice(0, 2);
    lines.forEach((ln, idx) => {
      const sz = fitText(ctx2d, ln, W - 22, 36, 18, '900');
      ctx2d.font = '900 ' + sz + 'px "Arial Black", Impact, Arial, sans-serif';
      ctx2d.fillStyle = idx === 0 ? pal.secondary : pal.primary;
      ctx2d.fillText(ln, W / 2, lines.length === 1 ? 104 : (idx === 0 ? 78 : 124));
    });
  }

  // Bottom callout bar
  const foot = String(slide.foot || '').toUpperCase().trim();
  if (foot) {
    ctx2d.fillStyle = '#111827';
    ctx2d.fillRect(8, H - 40, W - 16, 32);
    ctx2d.strokeStyle = pal.primary;
    ctx2d.lineWidth = 2;
    ctx2d.strokeRect(8, H - 40, W - 16, 32);
    const fSize = fitText(ctx2d, foot, W - 28, 16, 10, '800');
    ctx2d.font = '800 ' + fSize + 'px Arial, sans-serif';
    ctx2d.fillStyle = '#FFFFFF';
    ctx2d.fillText(foot, W / 2, H - 23);
  }

  ctx2d.restore();
}

export async function renderLedSign(ctx) {
  const st = {
    slides: TEMPLATES[0].slides.map((s) => Object.assign({}, s)),
    activeIdx: 0,
    animMode: 'pulse',
    codec: 'mjpeg',
    fps: 15,
    exporting: false,
    catalogResults: [],
  };

  const canvas1x = h('canvas.led-canvas-1x', { width: W, height: H });
  const canvas2x = h('canvas.led-canvas-2x', { width: W, height: H });
  const ctx1 = canvas1x.getContext('2d', { willReadFrequently: true });
  const ctx2 = canvas2x.getContext('2d', { willReadFrequently: true });

  const slidesHost = h('div.stack-sm');
  const editorHost = h('div.stack-sm');
  const exportBtn = h('button.btn.primary', { type: 'button' }, 'Download 224×212 .AVI');
  const exportStatus = h('span.small.muted', 'Audio-free 224×212 AVI ready for LED controllers');
  const catalogHost = h('div.led-catalog-hits');

  let rafId = null;
  let startTs = performance.now();

  function drawPreviewLoop(now) {
    if (!ctx.isCurrent()) {
      if (rafId) window.cancelAnimationFrame(rafId);
      return;
    }
    const totalMs = st.slides.reduce((a, s) => a + Math.max(1, Number(s.seconds) || 3) * 1000, 0);
    let elapsed = (now - startTs) % Math.max(1000, totalMs);
    let slide = st.slides[0];
    let phase = 0;
    for (let i = 0; i < st.slides.length; i++) {
      const dur = Math.max(1, Number(st.slides[i].seconds) || 3) * 1000;
      if (elapsed < dur || i === st.slides.length - 1) {
        slide = st.slides[i];
        phase = Math.min(1, elapsed / dur);
        break;
      }
      elapsed -= dur;
    }
    drawSlideFrame(ctx1, slide, phase, st.animMode);
    ctx2.drawImage(canvas1x, 0, 0);
    rafId = window.requestAnimationFrame(drawPreviewLoop);
  }

  function renderSlidesBar() {
    mount(slidesHost,
      h('div.led-slide-tabs',
        st.slides.map((s, idx) => h('button.rep-tab', {
          type: 'button',
          class: idx === st.activeIdx ? 'on' : '',
          onclick: () => { st.activeIdx = idx; renderSlidesBar(); renderSlideEditor(); },
        }, 'Slide ' + (idx + 1) + (s.line1 ? ': ' + s.line1.slice(0, 10) : ''))),
        st.slides.length < 4 ? h('button.btn.sm', {
          type: 'button',
          onclick: () => {
            st.slides.push({ badge: 'UBC TAMPA', line1: 'SHOP TODAY', line2: '1220 E FLETCHER', foot: 'OPEN MON–SAT', palette: 'cyan_white', seconds: 3 });
            st.activeIdx = st.slides.length - 1;
            renderSlidesBar();
            renderSlideEditor();
          },
        }, '+ Slide') : null));
  }

  function renderSlideEditor() {
    const cur = st.slides[st.activeIdx] || st.slides[0];
    const field = (label, key, placeholder) => h('label.led-field',
      h('span.small.muted', label),
      h('input', {
        type: 'text',
        value: cur[key] || '',
        placeholder,
        oninput: (e) => { cur[key] = e.target.value; },
      }));

    const palSel = h('select', {
      onchange: (e) => { cur.palette = e.target.value; },
    }, Object.keys(PALETTES).map((k) => h('option', { value: k, selected: cur.palette === k }, PALETTES[k].label)));

    const secSel = h('select', {
      onchange: (e) => { cur.seconds = Number(e.target.value) || 3; },
    }, [2, 3, 4, 5].map((sec) => h('option', { value: String(sec), selected: Number(cur.seconds) === sec }, sec + ' seconds')));

    const delBtn = st.slides.length > 1 ? h('button.btn.sm.danger', {
      type: 'button',
      onclick: () => {
        st.slides.splice(st.activeIdx, 1);
        st.activeIdx = Math.max(0, st.activeIdx - 1);
        renderSlidesBar();
        renderSlideEditor();
      },
    }, 'Remove Slide') : null;

    mount(editorHost,
      h('div.led-form-grid',
        field('Top Banner (Bright Pill)', 'badge', 'e.g. IN STOCK TODAY'),
        field('Duration', 'seconds', '3'),
        field('Big Headline 1', 'line1', 'e.g. WALK-IN'),
        field('Big Headline 2 (Accent)', 'line2', 'e.g. BIKE REPAIR'),
        field('Bottom Line (Phone / Info)', 'foot', 'e.g. CALL (813) 971-2277'),
        h('label.led-field', h('span.small.muted', 'Vibrant LED Colors'), palSel),
        h('label.led-field', h('span.small.muted', 'Slide Duration'), secSel),
      ),
      delBtn ? h('div.row-between', h('span.small.muted', 'Tip: Pure black background + bright cyan/red/white shines best on aging LEDs.'), delBtn) : null);
    // Remove duplicate duration text input by keeping clean grid
    const inputs = editorHost.querySelectorAll('.led-field');
    if (inputs[1]) inputs[1].remove();
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
      const off = document.createElement('canvas');
      off.width = W;
      off.height = H;
      const octx = off.getContext('2d', { willReadFrequently: true });
      const frames = [];
      const fps = st.fps;
      const totalFrames = st.slides.reduce((a, s) => a + Math.max(1, Number(s.seconds) || 3) * fps, 0);
      let done = 0;

      for (let si = 0; si < st.slides.length; si++) {
        const s = st.slides[si];
        const count = Math.max(1, Number(s.seconds) || 3) * fps;
        for (let f = 0; f < count; f++) {
          drawSlideFrame(octx, s, f / count, st.animMode);
          if (st.codec === 'rgb24') {
            const imgData = octx.getImageData(0, 0, W, H);
            frames.push(rgbaToBgr24BottomUp(imgData.data, W, H));
          } else {
            frames.push(await canvasToJpegBytes(off));
          }
          done++;
          if (done % 10 === 0 || done === totalFrames) {
            exportStatus.textContent = 'Rendering frame ' + done + ' / ' + totalFrames + '…';
            await new Promise((r) => setTimeout(r, 0));
          }
        }
      }

      const aviBlob = st.codec === 'rgb24'
        ? encodeRgb24Avi(frames, W, H, fps)
        : encodeMjpegAvi(frames, W, H, fps);

      const url = URL.createObjectURL(aviBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ubc-led-sign-224x212-' + st.codec + '.avi';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      const kb = Math.round(aviBlob.size / 1024);
      exportStatus.textContent = 'Downloaded ubc-led-sign-224x212-' + st.codec + '.avi (' + kb + ' KB, ' + totalFrames + ' frames)';
      toast('224×212 .AVI ready (' + kb + ' KB)', 'ok');
    } catch (err) {
      toast(err.message || 'AVI export failed', 'bad');
      exportStatus.textContent = 'Export failed — try MJPEG .avi';
    } finally {
      st.exporting = false;
      exportBtn.disabled = false;
    }
  });

  const tplBar = h('div.led-tpl-row',
    TEMPLATES.map((t) => h('button.btn.sm', {
      type: 'button',
      onclick: () => {
        st.slides = t.slides.map((s) => Object.assign({}, s));
        st.activeIdx = 0;
        startTs = performance.now();
        renderSlidesBar();
        renderSlideEditor();
      },
    }, t.name)));

  const qInput = h('input', {
    type: 'search',
    placeholder: 'Search Hub catalog (e.g. Turbo Levo, Helmet, 2100000…)',
    onkeydown: async (e) => {
      if (e.key !== 'Enter') return;
      const q = e.target.value.trim();
      if (!q) return;
      mount(catalogHost, h('span.small.muted', 'Searching…'));
      try {
        const res = await ctx.api.items({ q, stock: 'physical', limit: 6 });
        const list = res.items || [];
        mount(catalogHost, list.length
          ? list.map((it) => h('button.btn.sm', {
            type: 'button',
            onclick: () => {
              const cur = st.slides[st.activeIdx];
              cur.badge = (it.brand || 'UBC IN STOCK').toUpperCase().slice(0, 22);
              const words = String(it.title || '').toUpperCase().split(/\s+/);
              cur.line1 = words.slice(0, 2).join(' ');
              cur.line2 = money(it.priceCents);
              cur.foot = 'IN STOCK · TEST RIDE TODAY';
              renderSlidesBar();
              renderSlideEditor();
              toast('Loaded ' + it.title + ' onto Slide ' + (st.activeIdx + 1), 'ok');
            },
          }, it.title.slice(0, 28) + ' (' + money(it.priceCents) + ')'))
          : h('span.small.muted', 'No in-stock match found.'));
      } catch (err) {
        mount(catalogHost, h('span.small.muted', 'Search unavailable.'));
      }
    },
  });

  const animSel = h('select', { onchange: (e) => { st.animMode = e.target.value; } },
    h('option', { value: 'pulse', selected: true }, 'Bright Border Pulse'),
    h('option', { value: 'slide' }, 'Slide-Up Entrance'),
    h('option', { value: 'static' }, 'Static High Contrast'));

  const codecSel = h('select', { onchange: (e) => { st.codec = e.target.value; } },
    h('option', { value: 'mjpeg', selected: true }, 'MJPEG .avi (Standard — Small File)'),
    h('option', { value: 'rgb24' }, 'Uncompressed RGB .avi (Legacy LED Controllers)'));

  const fpsSel = h('select', { onchange: (e) => { st.fps = Number(e.target.value) || 15; } },
    h('option', { value: '15', selected: true }, '15 fps (Recommended for LED)'),
    h('option', { value: '24' }, '24 fps (Smooth)'));

  renderSlidesBar();
  renderSlideEditor();
  rafId = window.requestAnimationFrame(drawPreviewLoop);

  return h('div.stack.led-root',
    pageHead('LED Sign Studio (224×212 .AVI)', 'Create high-contrast street sign ads in vibrant Light Blue, Red & White for aging outdoor LEDs.'),
    card('1. Quick Templates & Catalog Picker', h('div.stack-sm',
      tplBar,
      h('div.led-catalog-search', qInput, catalogHost))),
    h('div.grid.grid-2',
      card('2. Slide Editor', h('div.stack-sm', slidesHost, editorHost)),
      card('3. Live 224×212 Preview & Export', h('div.stack-sm',
        h('div.led-previews',
          h('div.led-prev-box', h('span.small.muted', 'Actual Pixels (224×212)'), canvas1x),
          h('div.led-prev-box', h('span.small.muted', '2× Street Preview'), canvas2x)),
        h('div.led-export-opts',
          h('label.led-field', h('span.small.muted', 'Animation'), animSel),
          h('label.led-field', h('span.small.muted', 'AVI Format'), codecSel),
          h('label.led-field', h('span.small.muted', 'Frame Rate'), fpsSel)),
        h('div.row-between', exportStatus, exportBtn)))));
}
