import { h, mount } from '../ui/dom.js';
import { card, pageHead, toast } from '../ui/components.js';
import { money } from '../ui/format.js';
import { encodeMjpegAvi, encodeRgb24Avi, rgbaToBgr24BottomUp } from '../ui/avi-encoder.js?v=81';

const W = 224;
const H = 212;

const PALETTES = {
  blue_red_white: { label: 'Light Blue + Red + White', primary: '#38BDF8', secondary: '#FFFFFF', badgeBg: '#FF1E1E', badgeFg: '#FFFFFF', border: '#38BDF8', glow: '#00E5FF' },
  cyan_white: { label: 'Electric Cyan + White', primary: '#00E5FF', secondary: '#FFFFFF', badgeBg: '#00E5FF', badgeFg: '#000000', border: '#00E5FF', glow: '#FFFFFF' },
  red_white: { label: 'Vibrant Red + White', primary: '#FF1E1E', secondary: '#FFFFFF', badgeBg: '#FF1E1E', badgeFg: '#FFFFFF', border: '#FF1E1E', glow: '#38BDF8' },
  yellow_cyan: { label: 'Neon Yellow + Light Blue', primary: '#FFE600', secondary: '#00E5FF', badgeBg: '#FFE600', badgeFg: '#000000', border: '#00E5FF', glow: '#FFFFFF' },
  green_white: { label: 'Neon Green + White', primary: '#00FF66', secondary: '#FFFFFF', badgeBg: '#00FF66', badgeFg: '#000000', border: '#00FF66', glow: '#FFFFFF' },
};

const ICONS = [
  ['none', 'No Icon'],
  ['wheel', 'Spinning Bike Wheel'],
  ['bolt', 'E-Bike Lightning'],
  ['wrench', 'Service Wrench'],
  ['star', 'Patriot Star'],
  ['tag', 'Sale Tag'],
];

const LOGOS = [
  ['ubc', 'UBC Official Logo'],
  ['custom', 'Uploaded Logo / Photo'],
  ['none', 'Text Only (No Logo)'],
];

const TEMPLATES = [
  {
    id: 'brand_service',
    name: 'UBC Logo + Service Center',
    anim: 'laser',
    slides: [
      { badge: 'TAMPA · SINCE 1972', line1: 'UNIVERSITY', line2: 'BICYCLE CTR', foot: '1220 E FLETCHER AVE · USF', palette: 'blue_red_white', logo: 'ubc', icon: 'wheel', seconds: 3 },
      { badge: 'WALK-IN SERVICE CENTER', line1: 'SAME-DAY', line2: 'BIKE REPAIR', foot: 'MOST IN 24H · (813) 971-2277', palette: 'cyan_white', logo: 'none', icon: 'wrench', seconds: 3 },
    ],
  },
  {
    id: 'ebikes',
    name: 'E-Bikes + 0% APR',
    anim: 'scan',
    slides: [
      { badge: 'IN STOCK TODAY', line1: 'E-BIKES &', line2: 'ROAD BIKES', foot: 'TEST RIDE TODAY ON FLETCHER', palette: 'cyan_white', logo: 'ubc', icon: 'bolt', seconds: 3 },
      { badge: 'EASY FINANCING', line1: '0% APR', line2: 'AVAILABLE', foot: 'INSTANT BIKE TRADE-IN CREDIT', palette: 'yellow_cyan', logo: 'none', icon: 'bolt', seconds: 3 },
    ],
  },
  {
    id: 'deals',
    name: 'Hot Sale / Red Tag',
    anim: 'pop',
    slides: [
      { badge: 'LIMITED TIME OFFER', line1: 'UP TO', line2: '$500 OFF', foot: 'IN-STOCK BIKES & HELMETS', palette: 'red_white', logo: 'ubc', icon: 'tag', seconds: 3 },
      { badge: 'LOW PRICE GUARANTEE', line1: 'SHOP UBC', line2: 'SINCE 1972', foot: 'FREE LIFETIME ADJUSTMENTS', palette: 'blue_red_white', logo: 'none', icon: 'wheel', seconds: 3 },
    ],
  },
  {
    id: 'discounts',
    name: 'USF, Veterans & Police',
    anim: 'ticker',
    slides: [
      { badge: 'EVERYDAY DISCOUNTS', line1: 'USF · VETS', line2: '& POLICE', foot: 'SHOW VALID ID IN STORE FOR INSTANT SAVINGS · SINCE 1972', palette: 'blue_red_white', logo: 'ubc', icon: 'star', seconds: 4 },
      { badge: '5 MIN FROM USF', line1: 'HELMETS', line2: '& REPAIRS', foot: 'BIKES · E-SCOOTERS · LOCKS · LIGHTS · (813) 971-2277', palette: 'cyan_white', logo: 'none', icon: 'wheel', seconds: 3 },
    ],
  },
  {
    id: 'alafia',
    name: 'Alafia Trail Rentals',
    anim: 'laser',
    slides: [
      { badge: 'ALAFIA RIVER PARK', line1: 'MTB & E-MTB', line2: 'RENTALS', foot: '20+ MILES OF SINGLETRACK', palette: 'green_white', logo: 'ubc', icon: 'wheel', seconds: 3 },
      { badge: 'OPEN SAT & SUN 8AM', line1: 'RESERVE', line2: 'AT UBCBIKE', foot: 'CALL (813) 459-8293', palette: 'cyan_white', logo: 'none', icon: 'bolt', seconds: 3 },
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

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function drawVectorIcon(ctx2d, type, cx, cy, r, phase, pal) {
  if (!type || type === 'none') return;
  ctx2d.save();
  ctx2d.translate(cx, cy);
  if (type === 'wheel') {
    const angle = phase * Math.PI * 2;
    ctx2d.strokeStyle = pal.primary;
    ctx2d.lineWidth = 2.6;
    ctx2d.beginPath();
    ctx2d.arc(0, 0, r, 0, Math.PI * 2);
    ctx2d.stroke();
    ctx2d.strokeStyle = pal.secondary;
    ctx2d.lineWidth = 1.4;
    for (let i = 0; i < 6; i++) {
      const a = angle + (i * Math.PI) / 3;
      ctx2d.beginPath();
      ctx2d.moveTo(0, 0);
      ctx2d.lineTo(Math.cos(a) * (r - 2), Math.sin(a) * (r - 2));
      ctx2d.stroke();
    }
    ctx2d.fillStyle = pal.badgeBg;
    ctx2d.beginPath();
    ctx2d.arc(0, 0, 3.2, 0, Math.PI * 2);
    ctx2d.fill();
  } else if (type === 'bolt') {
    const sc = 0.92 + 0.14 * Math.sin(phase * Math.PI * 6);
    ctx2d.scale(sc, sc);
    ctx2d.fillStyle = '#FFE600';
    ctx2d.strokeStyle = '#FFFFFF';
    ctx2d.lineWidth = 1.4;
    ctx2d.beginPath();
    ctx2d.moveTo(3, -r);
    ctx2d.lineTo(-r * 0.65, 2);
    ctx2d.lineTo(0, 2);
    ctx2d.lineTo(-3, r);
    ctx2d.lineTo(r * 0.65, -2);
    ctx2d.lineTo(0, -2);
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.stroke();
  } else if (type === 'wrench') {
    const tilt = Math.sin(phase * Math.PI * 4) * 0.35;
    ctx2d.rotate(tilt);
    ctx2d.strokeStyle = pal.secondary;
    ctx2d.lineWidth = 3.2;
    ctx2d.lineCap = 'round';
    ctx2d.beginPath();
    ctx2d.moveTo(-r * 0.7, r * 0.7);
    ctx2d.lineTo(r * 0.45, -r * 0.45);
    ctx2d.stroke();
    ctx2d.strokeStyle = pal.primary;
    ctx2d.lineWidth = 2.6;
    ctx2d.beginPath();
    ctx2d.arc(r * 0.52, -r * 0.52, r * 0.42, 0.4, Math.PI * 1.65);
    ctx2d.stroke();
  } else if (type === 'star') {
    const sc = 0.9 + 0.14 * Math.sin(phase * Math.PI * 6);
    ctx2d.scale(sc, sc);
    ctx2d.fillStyle = pal.badgeBg === '#000000' ? '#FF1E1E' : pal.badgeBg;
    ctx2d.strokeStyle = '#FFFFFF';
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? r : r * 0.44;
      const a = (i * Math.PI) / 5 - Math.PI / 2;
      if (i === 0) ctx2d.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
      else ctx2d.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.stroke();
  } else if (type === 'tag') {
    const sc = 0.92 + 0.12 * Math.sin(phase * Math.PI * 6);
    ctx2d.scale(sc, sc);
    ctx2d.fillStyle = '#FF1E1E';
    ctx2d.strokeStyle = '#FFFFFF';
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.moveTo(-r * 0.85, -r * 0.5);
    ctx2d.lineTo(r * 0.2, -r * 0.5);
    ctx2d.lineTo(r * 0.85, 0);
    ctx2d.lineTo(r * 0.2, r * 0.55);
    ctx2d.lineTo(-r * 0.85, r * 0.55);
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.stroke();
  }
  ctx2d.restore();
}

function drawBorderEffect(ctx2d, animMode, phase01, pal) {
  if (animMode === 'laser') {
    // Dim base border + 2 bright chasing neon bars around the perimeter
    ctx2d.strokeStyle = '#1E293B';
    ctx2d.lineWidth = 3;
    ctx2d.strokeRect(2, 2, W - 4, H - 4);
    const perim = 2 * ((W - 4) + (H - 4));
    const segLen = 96;
    [0, perim / 2].forEach((offset, idx) => {
      ctx2d.save();
      ctx2d.strokeStyle = idx === 0 ? pal.primary : pal.badgeBg;
      ctx2d.lineWidth = 4;
      ctx2d.setLineDash([segLen, perim - segLen]);
      ctx2d.lineDashOffset = -((phase01 * perim * 2 + offset) % perim);
      ctx2d.strokeRect(2, 2, W - 4, H - 4);
      ctx2d.restore();
    });
    return;
  }
  const pulse = animMode === 'pulse' ? (0.55 + 0.45 * Math.sin(phase01 * Math.PI * 6)) : 1;
  ctx2d.save();
  ctx2d.globalAlpha = pulse;
  ctx2d.strokeStyle = pal.border;
  ctx2d.lineWidth = 4;
  ctx2d.strokeRect(2, 2, W - 4, H - 4);
  ctx2d.restore();
}

function drawSlideFrame(ctx2d, slide, phase01, animMode, assets) {
  const pal = PALETTES[slide.palette] || PALETTES.blue_red_white;
  // Pure black background maximizes contrast on aging outdoor LEDs
  ctx2d.fillStyle = '#000000';
  ctx2d.fillRect(0, 0, W, H);

  drawBorderEffect(ctx2d, animMode, phase01, pal);

  // Kinetic entrance transform
  let scale = 1;
  let offsetY = 0;
  if (animMode === 'pop' && phase01 < 0.2) {
    scale = 0.72 + 0.28 * easeOutBack(phase01 / 0.2);
  } else if ((animMode === 'slide' || animMode === 'ticker') && phase01 < 0.16) {
    const k = 1 - phase01 / 0.16;
    offsetY = Math.round(k * k * 24);
  }

  ctx2d.save();
  ctx2d.translate(W / 2, H / 2 + offsetY);
  ctx2d.scale(scale, scale);
  ctx2d.translate(-W / 2, -H / 2);

  // Top Header: Official UBC Logo, Custom Uploaded Image, or Bright Pill Banner
  let contentTop = 44;
  const activeImg = slide.logo === 'ubc'
    ? assets.ubcLogo
    : slide.logo === 'custom'
      ? assets.customImg
      : null;

  if (activeImg && activeImg.complete && activeImg.naturalWidth > 0) {
    const maxW = slide.icon && slide.icon !== 'none' ? 132 : 168;
    const maxH = 38;
    const ratio = Math.min(maxW / activeImg.naturalWidth, maxH / activeImg.naturalHeight);
    const dw = Math.round(activeImg.naturalWidth * ratio);
    const dh = Math.round(activeImg.naturalHeight * ratio);
    const dx = slide.icon && slide.icon !== 'none' ? 14 : Math.round((W - dw) / 2);
    const dy = 10 + Math.round((maxH - dh) / 2);
    ctx2d.drawImage(activeImg, dx, dy, dw, dh);
    if (slide.icon && slide.icon !== 'none') {
      drawVectorIcon(ctx2d, slide.icon, W - 30, 29, 15, phase01, pal);
    }
    // Thin bright divider under logo
    ctx2d.fillStyle = pal.badgeBg;
    ctx2d.fillRect(10, 52, W - 20, 3);
    contentTop = 58;
  } else {
    const badge = String(slide.badge || '').toUpperCase().trim();
    if (badge) {
      ctx2d.fillStyle = pal.badgeBg;
      ctx2d.fillRect(8, 8, W - 16, 30);
      ctx2d.fillStyle = pal.badgeFg;
      const bMax = slide.icon && slide.icon !== 'none' ? W - 56 : W - 26;
      const bSize = fitText(ctx2d, badge, bMax, 16, 10, '900');
      ctx2d.font = '900 ' + bSize + 'px Arial, sans-serif';
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'middle';
      ctx2d.fillText(badge, slide.icon && slide.icon !== 'none' ? (W - 28) / 2 : W / 2, 24);
    }
    if (slide.icon && slide.icon !== 'none') {
      drawVectorIcon(ctx2d, slide.icon, W - 24, 23, 12, phase01, pal);
    }
    contentTop = 44;
  }

  // Main Headlines (extra bold high-contrast for 40mph visibility)
  const l1 = String(slide.line1 || '').toUpperCase().trim();
  const l2 = String(slide.line2 || '').toUpperCase().trim();
  const centerMid = Math.round((contentTop + (H - 42)) / 2);
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';

  if (l1 && l2) {
    const y1 = centerMid - 23;
    const y2 = centerMid + 23;
    const s1 = fitText(ctx2d, l1, W - 18, 40, 18, '900');
    ctx2d.font = '900 ' + s1 + 'px "Arial Black", Impact, Arial, sans-serif';
    ctx2d.fillStyle = pal.secondary;
    ctx2d.fillText(l1, W / 2, y1);

    const s2 = fitText(ctx2d, l2, W - 18, 40, 18, '900');
    ctx2d.font = '900 ' + s2 + 'px "Arial Black", Impact, Arial, sans-serif';
    ctx2d.fillStyle = pal.primary;
    ctx2d.fillText(l2, W / 2, y2);
  } else if (l1 || l2) {
    const single = l1 || l2;
    ctx2d.font = '900 34px "Arial Black", Impact, Arial, sans-serif';
    const lines = wrapLines(ctx2d, single, W - 20).slice(0, 2);
    lines.forEach((ln, idx) => {
      const sz = fitText(ctx2d, ln, W - 20, 38, 18, '900');
      ctx2d.font = '900 ' + sz + 'px "Arial Black", Impact, Arial, sans-serif';
      ctx2d.fillStyle = idx === 0 ? pal.secondary : pal.primary;
      ctx2d.fillText(ln, W / 2, lines.length === 1 ? centerMid : (idx === 0 ? centerMid - 21 : centerMid + 21));
    });
  }

  // Bottom Bar (Scrolling Marquee Ticker or High-Contrast Static Bar)
  const foot = String(slide.foot || '').toUpperCase().trim();
  if (foot) {
    ctx2d.fillStyle = '#0B1320';
    ctx2d.fillRect(8, H - 40, W - 16, 32);
    ctx2d.strokeStyle = pal.primary;
    ctx2d.lineWidth = 2;
    ctx2d.strokeRect(8, H - 40, W - 16, 32);

    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.rect(10, H - 39, W - 20, 30);
    ctx2d.clip();

    if (animMode === 'ticker') {
      ctx2d.font = '900 16px Arial, sans-serif';
      const tw = ctx2d.measureText(foot + '   ★   ').width;
      const shift = (phase01 * Math.max(tw, W)) % Math.max(tw, 1);
      ctx2d.textAlign = 'left';
      ctx2d.fillStyle = '#FFFFFF';
      for (let rx = 14 - shift; rx < W; rx += Math.max(tw, 120)) {
        ctx2d.fillText(foot + '   ★   ', rx, H - 23);
      }
    } else {
      const fSize = fitText(ctx2d, foot, W - 26, 15, 10, '800');
      ctx2d.font = '800 ' + fSize + 'px Arial, sans-serif';
      ctx2d.textAlign = 'center';
      ctx2d.fillStyle = '#FFFFFF';
      ctx2d.fillText(foot, W / 2, H - 23);
    }
    ctx2d.restore();
  }

  // Neon Scan Light Sweep overlay
  if (animMode === 'scan') {
    const sx = -80 + phase01 * (W + 180);
    const grad = ctx2d.createLinearGradient(sx, 0, sx + 70, H);
    grad.addColorStop(0, 'rgba(0,229,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.28)');
    grad.addColorStop(1, 'rgba(0,229,255,0)');
    ctx2d.fillStyle = grad;
    ctx2d.fillRect(4, 4, W - 8, H - 8);
  }

  ctx2d.restore();
}

export async function renderLedSign(ctx) {
  const ubcLogo = new window.Image();
  ubcLogo.src = 'assets/ubc-logo-white.png';
  const assets = { ubcLogo, customImg: null, customName: '' };

  const st = {
    slides: TEMPLATES[0].slides.map((s) => Object.assign({}, s)),
    activeIdx: 0,
    animMode: TEMPLATES[0].anim || 'laser',
    codec: 'mjpeg',
    fps: 15,
    exporting: false,
  };

  const canvas1x = h('canvas.led-canvas-1x', { width: W, height: H });
  const canvas2x = h('canvas.led-canvas-2x', { width: W, height: H });
  const ctx1 = canvas1x.getContext('2d', { willReadFrequently: true });
  const ctx2 = canvas2x.getContext('2d', { willReadFrequently: true });

  const slidesHost = h('div.stack-sm');
  const editorHost = h('div.stack-sm');
  const exportBtn = h('button.btn.primary', { type: 'button' }, 'Download 224×212 .AVI');
  const exportStatus = h('span.small.muted', 'Audio-free 224×212 AVI ready for outdoor LED signs');
  const catalogHost = h('div.led-catalog-hits');
  const uploadStatus = h('span.small.muted', 'No custom image uploaded yet');

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
    drawSlideFrame(ctx1, slide, phase, st.animMode, assets);
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
            st.slides.push({ badge: 'UBC TAMPA', line1: 'SHOP TODAY', line2: '1220 E FLETCHER', foot: 'OPEN MON–SAT', palette: 'blue_red_white', logo: 'ubc', icon: 'wheel', seconds: 3 });
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

    const logoSel = h('select', {
      onchange: (e) => { cur.logo = e.target.value; },
    }, LOGOS.map(([v, lbl]) => h('option', { value: v, selected: (cur.logo || 'none') === v }, lbl)));

    const iconSel = h('select', {
      onchange: (e) => { cur.icon = e.target.value; },
    }, ICONS.map(([v, lbl]) => h('option', { value: v, selected: (cur.icon || 'none') === v }, lbl)));

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
        h('label.led-field', h('span.small.muted', 'Top Logo / Header'), logoSel),
        h('label.led-field', h('span.small.muted', 'Animated Vector Icon'), iconSel),
        field('Top Banner (when Text Only)', 'badge', 'e.g. IN STOCK TODAY'),
        h('label.led-field', h('span.small.muted', 'Slide Duration'), secSel),
        field('Big Headline 1', 'line1', 'e.g. WALK-IN'),
        field('Big Headline 2 (Accent)', 'line2', 'e.g. BIKE REPAIR'),
        field('Bottom Line (Phone / Ticker)', 'foot', 'e.g. CALL (813) 971-2277'),
        h('label.led-field', h('span.small.muted', 'Vibrant LED Colors'), palSel),
      ),
      delBtn ? h('div.row-between', h('span.small.muted', 'Pure black background + high-contrast cyan/red/white shines best on aging LEDs.'), delBtn) : null);
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
          drawSlideFrame(octx, s, f / count, st.animMode, assets);
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
        if (t.anim) {
          st.animMode = t.anim;
          animSel.value = t.anim;
        }
        startTs = performance.now();
        renderSlidesBar();
        renderSlideEditor();
      },
    }, t.name)));

  const logoUploadInput = h('input', {
    type: 'file',
    accept: 'image/*',
    onchange: (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new window.FileReader();
      reader.onload = () => {
        const img = new window.Image();
        img.onload = () => {
          assets.customImg = img;
          assets.customName = file.name;
          st.slides[st.activeIdx].logo = 'custom';
          uploadStatus.textContent = 'Loaded: ' + file.name + ' (' + img.naturalWidth + '×' + img.naturalHeight + ')';
          renderSlideEditor();
          toast('Custom logo/photo loaded onto Slide ' + (st.activeIdx + 1), 'ok');
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    },
  });

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
    h('option', { value: 'laser', selected: true }, 'Laser Corner Chase'),
    h('option', { value: 'scan' }, 'Neon Light Sweep'),
    h('option', { value: 'pop' }, 'Kinetic Zoom Pop'),
    h('option', { value: 'ticker' }, 'Scrolling Bottom Ticker'),
    h('option', { value: 'pulse' }, 'Bright Border Pulse'),
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
    pageHead('LED Sign Studio (224×212 .AVI)', 'Modern animations, official UBC logo, custom brand logos & vibrant outdoor LED colors.'),
    card('1. Quick Templates, Custom Logo Upload & Catalog Picker', h('div.stack-sm',
      tplBar,
      h('div.led-form-grid',
        h('div.led-catalog-search',
          h('span.small.muted', 'Upload Brand Logo or Bike Photo (PNG/JPG)'),
          logoUploadInput,
          uploadStatus),
        h('div.led-catalog-search',
          h('span.small.muted', 'Or Load Live Item from UBC Catalog'),
          qInput,
          catalogHost)))),
    h('div.grid.grid-2',
      card('2. Slide Editor', h('div.stack-sm', slidesHost, editorHost)),
      card('3. Live 224×212 Preview & Export', h('div.stack-sm',
        h('div.led-previews',
          h('div.led-prev-box', h('span.small.muted', 'Actual Pixels (224×212)'), canvas1x),
          h('div.led-prev-box', h('span.small.muted', '2× Street Preview'), canvas2x)),
        h('div.led-export-opts',
          h('label.led-field', h('span.small.muted', 'Modern Animation'), animSel),
          h('label.led-field', h('span.small.muted', 'AVI Format'), codecSel),
          h('label.led-field', h('span.small.muted', 'Frame Rate'), fpsSel)),
        h('div.row-between', exportStatus, exportBtn)))));
}
