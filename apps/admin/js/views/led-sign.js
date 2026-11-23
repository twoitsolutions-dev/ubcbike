import { h, mount } from '../ui/dom.js';
import { card, pageHead, toast } from '../ui/components.js';
import { money } from '../ui/format.js';
import { encodeMjpegAvi, encodeRgb24Avi, rgbaToBgr24BottomUp } from '../ui/avi-encoder.js?v=82';

const SIZES = {
  '214x112': { w: 214, h: 112, label: '214 × 112 (UBC Sign)' },
  '224x112': { w: 224, h: 112, label: '224 × 112 (Wide Module)' },
  '224x212': { w: 224, h: 212, label: '224 × 212 (Tall)' },
};

const PALETTES = {
  blue_red_white: { label: 'Light Blue + Red + White', primary: '#38BDF8', secondary: '#FFFFFF', badgeBg: '#FF1E1E', badgeFg: '#FFFFFF', border: '#38BDF8' },
  cyan_white: { label: 'Electric Cyan + White', primary: '#00E5FF', secondary: '#FFFFFF', badgeBg: '#00E5FF', badgeFg: '#000000', border: '#00E5FF' },
  red_white: { label: 'Vibrant Red + White', primary: '#FF1E1E', secondary: '#FFFFFF', badgeBg: '#FF1E1E', badgeFg: '#FFFFFF', border: '#FF1E1E' },
  yellow_cyan: { label: 'Neon Yellow + Light Blue', primary: '#FFE600', secondary: '#00E5FF', badgeBg: '#FFE600', badgeFg: '#000000', border: '#00E5FF' },
  green_white: { label: 'Neon Green + White', primary: '#00FF66', secondary: '#FFFFFF', badgeBg: '#00FF66', badgeFg: '#000000', border: '#00FF66' },
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
    id: 'ubc_pro',
    name: 'UBC Pro Street Ad (Kallisto)',
    anim: 'pro',
    slides: [
      { layout: 'slam', badge: '', line1: 'NEW', line2: 'E-BIKES', foot: '', palette: 'blue_red_white', logo: 'none', icon: 'none', seconds: 5 },
      { layout: 'slam', badge: '', line1: 'WE FIX', line2: 'BIKES, E-BIKES, SCOOTERS', foot: '', palette: 'red_white', logo: 'none', icon: 'none', seconds: 6 },
      { layout: 'swap', badge: '', line1: 'WALK IN TODAY', line2: 'READY IN 24H', foot: '', palette: 'blue_red_white', logo: 'none', icon: 'none', seconds: 5 },
      { layout: 'brand', badge: '', line1: '', line2: '', foot: '(813) 971-2277 · UBCBIKE.COM', palette: 'blue_red_white', logo: 'ubc', icon: 'none', seconds: 5 },
    ],
  },
  {
    id: 'brand_service',
    name: 'UBC Logo + Service Center',
    anim: 'motion_push',
    slides: [
      { badge: 'SINCE 1972', line1: 'WALK-IN', line2: 'SERVICE CENTER', foot: '(813) 971-2277 · UBCBIKE.COM', palette: 'blue_red_white', logo: 'ubc', icon: 'wheel', seconds: 5 },
      { badge: 'ALL BRANDS WELCOME', line1: 'TUNE-UPS', line2: 'FROM $100', foot: '24H TURNAROUND · UBCBIKE.COM', palette: 'cyan_white', logo: 'none', icon: 'wrench', seconds: 5 },
    ],
  },
  {
    id: 'ebikes',
    name: 'E-Bikes + 0% APR',
    anim: 'motion_fade',
    slides: [
      { badge: 'IN STOCK TODAY', line1: 'BIKES &', line2: 'E-BIKES', foot: 'UBCBIKE.COM · (813) 971-2277', palette: 'cyan_white', logo: 'ubc', icon: 'bolt', seconds: 5 },
      { badge: 'EASY FINANCING', line1: '0% APR', line2: 'AVAILABLE', foot: 'INSTANT TRADE-IN · UBCBIKE.COM', palette: 'yellow_cyan', logo: 'none', icon: 'bolt', seconds: 5 },
    ],
  },
  {
    id: 'deals',
    name: 'Hot Sale / Red Tag',
    anim: 'motion_push',
    slides: [
      { badge: 'IN-STORE SPECIAL', line1: 'UP TO', line2: '$500 OFF', foot: 'BIKES & HELMETS · UBCBIKE.COM', palette: 'red_white', logo: 'ubc', icon: 'tag', seconds: 5 },
      { badge: 'LOW PRICE GUARANTEE', line1: 'TEST RIDE', line2: 'TODAY', foot: 'CALL (813) 971-2277 · UBCBIKE.COM', palette: 'blue_red_white', logo: 'none', icon: 'wheel', seconds: 5 },
    ],
  },
  {
    id: 'discounts',
    name: 'USF, Veterans & Police',
    anim: 'ticker',
    slides: [
      { badge: 'EVERYDAY DISCOUNTS', line1: 'USF · VETS', line2: '& POLICE', foot: 'SHOW VALID ID FOR SAVINGS · (813) 971-2277 · UBCBIKE.COM', palette: 'blue_red_white', logo: 'ubc', icon: 'star', seconds: 6 },
      { badge: 'WALK-INS WELCOME', line1: 'HELMETS', line2: '& REPAIRS', foot: 'BIKES · E-SCOOTERS · LOCKS · LIGHTS · UBCBIKE.COM', palette: 'cyan_white', logo: 'none', icon: 'wheel', seconds: 5 },
    ],
  },
  {
    id: 'alafia',
    name: 'Alafia Trail Rentals',
    anim: 'motion_fade',
    slides: [
      { badge: 'ALAFIA RIVER PARK', line1: 'MTB & E-MTB', line2: 'RENTALS', foot: 'BOOK AT UBCBIKE.COM', palette: 'green_white', logo: 'ubc', icon: 'wheel', seconds: 5 },
      { badge: 'SAT & SUN 8AM', line1: 'TRAILHEAD', line2: 'BIKE SHOP', foot: 'CALL (813) 459-8293 · UBCBIKE.COM', palette: 'cyan_white', logo: 'none', icon: 'bolt', seconds: 5 },
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
    size -= 1;
  }
  return size;
}

function easeOutExpo(t) {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * Math.max(0, t));
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ---- UBC Pro street style (same look as tools/led-pro HyperFrames render) ----
// Kallisto (cufonfonts demo) ships blank digits/punctuation, so the FontFace is limited
// to letters + space via unicodeRange and everything else falls back to Arial Black.
const PRO_FONT = '"UBC Kallisto", "Arial Black", Impact, Arial, sans-serif';
const PRO_NUM_FONT = '"Arial Black", Impact, Arial, sans-serif';
const PRO_LAYOUTS = [
  ['slam', 'Headline Slam (Line 2 commas = rotating words)'],
  ['swap', 'Line Swap (Line 1 → Line 2)'],
  ['brand', 'UBC Brand Close (logo + phone + web)'],
];

function fitPro(ctx2d, text, maxWidth, startSize, minSize, family) {
  let size = startSize;
  while (size > minSize) {
    ctx2d.font = '900 ' + size + 'px ' + family;
    if (ctx2d.measureText(text).width <= maxWidth) break;
    size -= 1;
  }
  ctx2d.font = '900 ' + size + 'px ' + family;
  return size;
}

function drawProRail(ctx2d, W, H, elapsedSec) {
  const x = ((elapsedSec / 3.5) % 1) * 2 * W - W;
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

function drawProSlide(ctx2d, W, H, slide, elapsedSec, secDur, pal, assets, railSec) {
  ctx2d.fillStyle = '#000000';
  ctx2d.fillRect(0, 0, W, H);
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';
  const layout = slide.layout || 'slam';
  const maxW = W - 12;
  const big = Math.round(H * 0.4);

  if (layout === 'brand') {
    const parts = String(slide.foot || '(813) 971-2277 · UBCBIKE.COM').split(/[·|]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    const mark = assets.ubcMark;
    const kIn = easeOutExpo(Math.min(1, elapsedSec / 0.75));
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
      const k = easeOutExpo(Math.min(1, Math.max(0, elapsedSec - 0.35 - i * 0.25) / 0.55));
      const sz = fitPro(ctx2d, txt, maxW, sizes[i], 7, PRO_NUM_FONT);
      ctx2d.save();
      ctx2d.globalAlpha = k;
      ctx2d.fillStyle = colors[i];
      ctx2d.fillText(txt, W / 2, y + sz / 2 + Math.round((1 - k) * 8));
      ctx2d.restore();
      y += sz + 3;
    });
    drawProRail(ctx2d, W, H, railSec);
    return;
  }

  if (layout === 'swap') {
    const lines = [String(slide.line1 || '').toUpperCase().trim(), String(slide.line2 || '').toUpperCase().trim()].filter(Boolean);
    const swapAt = lines.length > 1 ? secDur * 0.42 : secDur + 1;
    const showB = elapsedSec >= swapAt;
    const txt = showB ? lines[1] : lines[0];
    const local = showB ? elapsedSec - swapAt : elapsedSec;
    const k = easeOutExpo(Math.min(1, local / 0.4));
    const sz = fitPro(ctx2d, txt || '', maxW, big, 10, PRO_FONT);
    const cy = Math.round(H * 0.48);
    ctx2d.save();
    ctx2d.globalAlpha = k;
    ctx2d.fillStyle = '#FFFFFF';
    ctx2d.fillText(txt || '', W / 2, cy + Math.round((1 - k) * 14));
    ctx2d.restore();
    if (showB) {
      // underline the last word of line 2 (e.g. "24H")
      const words = txt.split(/\s+/);
      const last = words[words.length - 1];
      const full = ctx2d.measureText(txt).width;
      const lw = ctx2d.measureText(last).width;
      const u = easeOutExpo(Math.min(1, Math.max(0, local - 0.3) / 0.5));
      ctx2d.fillStyle = pal.primary;
      ctx2d.fillRect(Math.round(W / 2 + full / 2 - lw), Math.round(cy + sz * 0.5 + 2), Math.round(lw * u), 2);
    }
    drawProRail(ctx2d, W, H, railSec);
    return;
  }

  // slam: line1 white + line2 accent; line2 "A,B,C" rotates through the words
  const l1 = String(slide.line1 || '').toUpperCase().trim();
  const opts = String(slide.line2 || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  const share = secDur / Math.max(1, opts.length);
  const wi = Math.min(opts.length - 1, Math.floor(elapsedSec / share));
  const word = opts.length ? opts[Math.max(0, wi)] : '';
  const wordLocal = elapsedSec - Math.max(0, wi) * share;
  const kIn = easeOutExpo(Math.min(1, elapsedSec / 0.35));
  const kWord = wi > 0 ? easeOutExpo(Math.min(1, wordLocal / 0.3)) : kIn;

  // one line if every rotating word fits big enough, otherwise stack the two lines
  let longest = word;
  opts.forEach((o) => { if (o.length > longest.length) longest = o; });
  const joined = (l1 ? l1 + ' ' : '') + longest;
  const oneSz = fitPro(ctx2d, joined, maxW, big, 8, PRO_FONT);
  const stacked = l1 && word && oneSz < Math.round(H * 0.24);

  ctx2d.save();
  const sc = 1.28 - 0.28 * kIn;
  ctx2d.translate(W / 2, H * 0.47);
  ctx2d.scale(sc, sc);
  ctx2d.globalAlpha = Math.min(1, kIn * 1.2);
  if (!stacked) {
    ctx2d.font = '900 ' + oneSz + 'px ' + PRO_FONT;
    const w1 = l1 ? ctx2d.measureText(l1 + ' ').width : 0;
    const w2 = ctx2d.measureText(word).width;
    let x = -(w1 + w2) / 2;
    ctx2d.textAlign = 'left';
    if (l1) { ctx2d.fillStyle = '#FFFFFF'; ctx2d.fillText(l1, x, 0); x += w1; }
    ctx2d.globalAlpha = Math.min(1, kIn * 1.2) * kWord;
    ctx2d.fillStyle = pal.primary;
    ctx2d.fillText(word, x, Math.round((1 - kWord) * 10));
  } else {
    const s1 = fitPro(ctx2d, l1, maxW, big, 8, PRO_FONT);
    ctx2d.fillStyle = '#FFFFFF';
    ctx2d.fillText(l1, 0, -Math.round(s1 * 0.55));
    const s2 = fitPro(ctx2d, longest, maxW, big, 8, PRO_FONT);
    ctx2d.font = '900 ' + s2 + 'px ' + PRO_FONT;
    ctx2d.globalAlpha = Math.min(1, kIn * 1.2) * kWord;
    ctx2d.fillStyle = pal.primary;
    ctx2d.fillText(word, 0, Math.round(s2 * 0.55) + Math.round((1 - kWord) * 10));
  }
  ctx2d.restore();
  drawProRail(ctx2d, W, H, railSec);
}

function drawVectorIcon(ctx2d, type, cx, cy, r, phase, pal) {
  if (!type || type === 'none') return;
  ctx2d.save();
  ctx2d.translate(cx, cy);
  if (type === 'wheel') {
    const angle = phase * Math.PI * 2;
    ctx2d.strokeStyle = pal.primary;
    ctx2d.lineWidth = 2.2;
    ctx2d.beginPath();
    ctx2d.arc(0, 0, r, 0, Math.PI * 2);
    ctx2d.stroke();
    ctx2d.strokeStyle = pal.secondary;
    ctx2d.lineWidth = 1.2;
    for (let i = 0; i < 6; i++) {
      const a = angle + (i * Math.PI) / 3;
      ctx2d.beginPath();
      ctx2d.moveTo(0, 0);
      ctx2d.lineTo(Math.cos(a) * (r - 1.5), Math.sin(a) * (r - 1.5));
      ctx2d.stroke();
    }
    ctx2d.fillStyle = pal.badgeBg;
    ctx2d.beginPath();
    ctx2d.arc(0, 0, 2.4, 0, Math.PI * 2);
    ctx2d.fill();
  } else if (type === 'bolt') {
    const sc = 0.94 + 0.1 * Math.sin(phase * Math.PI * 4);
    ctx2d.scale(sc, sc);
    ctx2d.fillStyle = '#FFE600';
    ctx2d.strokeStyle = '#FFFFFF';
    ctx2d.lineWidth = 1.2;
    ctx2d.beginPath();
    ctx2d.moveTo(2, -r);
    ctx2d.lineTo(-r * 0.65, 1.5);
    ctx2d.lineTo(0, 1.5);
    ctx2d.lineTo(-2, r);
    ctx2d.lineTo(r * 0.65, -1.5);
    ctx2d.lineTo(0, -1.5);
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.stroke();
  } else if (type === 'wrench') {
    const tilt = Math.sin(phase * Math.PI * 3) * 0.28;
    ctx2d.rotate(tilt);
    ctx2d.strokeStyle = pal.secondary;
    ctx2d.lineWidth = 2.6;
    ctx2d.lineCap = 'round';
    ctx2d.beginPath();
    ctx2d.moveTo(-r * 0.7, r * 0.7);
    ctx2d.lineTo(r * 0.45, -r * 0.45);
    ctx2d.stroke();
    ctx2d.strokeStyle = pal.primary;
    ctx2d.lineWidth = 2.2;
    ctx2d.beginPath();
    ctx2d.arc(r * 0.52, -r * 0.52, r * 0.42, 0.4, Math.PI * 1.65);
    ctx2d.stroke();
  } else if (type === 'star') {
    const sc = 0.92 + 0.1 * Math.sin(phase * Math.PI * 4);
    ctx2d.scale(sc, sc);
    ctx2d.fillStyle = pal.badgeBg === '#000000' ? '#FF1E1E' : pal.badgeBg;
    ctx2d.strokeStyle = '#FFFFFF';
    ctx2d.lineWidth = 1.2;
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
    const sc = 0.94 + 0.08 * Math.sin(phase * Math.PI * 4);
    ctx2d.scale(sc, sc);
    ctx2d.fillStyle = '#FF1E1E';
    ctx2d.strokeStyle = '#FFFFFF';
    ctx2d.lineWidth = 1.2;
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

function drawMotionBackdrop(ctx2d, W, H, phase01, animMode, pal) {
  ctx2d.fillStyle = '#000000';
  ctx2d.fillRect(0, 0, W, H);

  // Subtle hyperframe ambient speed streaks / neon glow (stays behind text, never reduces contrast)
  if (animMode === 'motion_push' || animMode === 'motion_fade') {
    ctx2d.save();
    for (let i = 0; i < 4; i++) {
      const y = Math.round(H * (0.28 + i * 0.16));
      const len = 36 + (i % 2) * 24;
      const x = ((phase01 * (W + 120) * (1.1 + i * 0.15) + i * 55) % (W + 120)) - 60;
      const g = ctx2d.createLinearGradient(x, y, x + len, y);
      g.addColorStop(0, 'rgba(56,189,248,0)');
      g.addColorStop(0.5, i % 2 === 0 ? 'rgba(56,189,248,0.16)' : 'rgba(255,30,30,0.14)');
      g.addColorStop(1, 'rgba(56,189,248,0)');
      ctx2d.fillStyle = g;
      ctx2d.fillRect(x, y, len, 2);
    }
    ctx2d.restore();
  }
}

function drawBorderEffect(ctx2d, W, H, animMode, phase01, pal) {
  if (animMode === 'laser' || animMode === 'motion_push') {
    ctx2d.strokeStyle = '#1E293B';
    ctx2d.lineWidth = 2;
    ctx2d.strokeRect(1.5, 1.5, W - 3, H - 3);
    const perim = 2 * ((W - 3) + (H - 3));
    const segLen = Math.round(W * 0.34);
    [0, perim / 2].forEach((offset, idx) => {
      ctx2d.save();
      ctx2d.strokeStyle = idx === 0 ? pal.primary : pal.badgeBg;
      ctx2d.lineWidth = 3;
      ctx2d.setLineDash([segLen, perim - segLen]);
      ctx2d.lineDashOffset = -((phase01 * perim * 1.4 + offset) % perim);
      ctx2d.strokeRect(1.5, 1.5, W - 3, H - 3);
      ctx2d.restore();
    });
    return;
  }
  const pulse = animMode === 'pulse' ? (0.65 + 0.35 * Math.sin(phase01 * Math.PI * 4)) : 1;
  ctx2d.save();
  ctx2d.globalAlpha = pulse;
  ctx2d.strokeStyle = pal.border;
  ctx2d.lineWidth = 2.5;
  ctx2d.strokeRect(1.5, 1.5, W - 3, H - 3);
  ctx2d.restore();
}

function drawSingleSlide(ctx2d, W, H, slide, phase01, secDur, animMode, assets) {
  const pal = PALETTES[slide.palette] || PALETTES.blue_red_white;
  const isWide = H <= 130;
  const elapsedSec = phase01 * secDur;

  if (animMode === 'pro') {
    drawProSlide(ctx2d, W, H, slide, elapsedSec, secDur, pal, assets, (assets.railSec || 0));
    return;
  }

  drawMotionBackdrop(ctx2d, W, H, phase01, animMode, pal);
  drawBorderEffect(ctx2d, W, H, animMode, phase01, pal);

  // Staggered Hyperframe entrance during first 0.45s, then 100% rock-steady readable hold!
  const enter1 = animMode === 'static' ? 1 : easeOutExpo(Math.min(1, elapsedSec / 0.32));
  const enter2 = animMode === 'static' ? 1 : easeOutExpo(Math.min(1, Math.max(0, elapsedSec - 0.1) / 0.35));

  const topPad = isWide ? 5 : 8;
  const headerH = isWide ? 22 : 36;
  const footH = isWide ? 20 : 32;
  const footY = H - footH - (isWide ? 5 : 8);
  let contentTop = topPad + headerH + (isWide ? 3 : 8);

  const activeImg = slide.logo === 'ubc'
    ? assets.ubcLogo
    : slide.logo === 'custom'
      ? assets.customImg
      : null;

  if (activeImg && activeImg.complete && activeImg.naturalWidth > 0) {
    const maxW = slide.icon && slide.icon !== 'none' ? Math.round(W * 0.56) : Math.round(W * 0.72);
    const maxH = isWide ? 20 : 36;
    const ratio = Math.min(maxW / activeImg.naturalWidth, maxH / activeImg.naturalHeight);
    const dw = Math.round(activeImg.naturalWidth * ratio);
    const dh = Math.round(activeImg.naturalHeight * ratio);
    const dx = slide.icon && slide.icon !== 'none' ? 10 : Math.round((W - dw) / 2);
    const dy = topPad + Math.round((headerH - dh) / 2);
    ctx2d.drawImage(activeImg, dx, dy, dw, dh);
    if (slide.icon && slide.icon !== 'none') {
      drawVectorIcon(ctx2d, slide.icon, W - (isWide ? 18 : 28), topPad + Math.round(headerH / 2), isWide ? 9 : 14, phase01, pal);
    }
    ctx2d.fillStyle = pal.badgeBg;
    ctx2d.fillRect(6, topPad + headerH + 1, W - 12, 2);
    contentTop = topPad + headerH + 5;
  } else {
    const badge = String(slide.badge || '').toUpperCase().trim();
    if (badge) {
      ctx2d.fillStyle = pal.badgeBg;
      ctx2d.fillRect(6, topPad, W - 12, headerH);
      ctx2d.fillStyle = pal.badgeFg;
      const bMax = slide.icon && slide.icon !== 'none' ? W - 44 : W - 20;
      const bSize = fitText(ctx2d, badge, bMax, isWide ? 12 : 16, 8, '900');
      ctx2d.font = '900 ' + bSize + 'px Arial, sans-serif';
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'middle';
      ctx2d.fillText(badge, slide.icon && slide.icon !== 'none' ? (W - 22) / 2 : W / 2, topPad + headerH / 2 + 0.5);
    }
    if (slide.icon && slide.icon !== 'none') {
      drawVectorIcon(ctx2d, slide.icon, W - (isWide ? 17 : 24), topPad + Math.round(headerH / 2), isWide ? 8 : 12, phase01, pal);
    }
  }

  // Main Headlines with subtle LED glow for aging outdoor panels
  const l1 = String(slide.line1 || '').toUpperCase().trim();
  const l2 = String(slide.line2 || '').toUpperCase().trim();
  const centerMid = Math.round((contentTop + footY) / 2);
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';

  if (l1 && l2) {
    const gap = isWide ? 13 : 23;
    const maxStart = isWide ? 24 : 40;
    const minSz = isWide ? 12 : 18;
    const dx1 = Math.round((1 - enter1) * -28);
    const dx2 = Math.round((1 - enter2) * 28);

    ctx2d.save();
    ctx2d.globalAlpha = Math.min(1, enter1 * 1.15);
    const s1 = fitText(ctx2d, l1, W - 16, maxStart, minSz, '900');
    ctx2d.font = '900 ' + s1 + 'px "Arial Black", Impact, Arial, sans-serif';
    ctx2d.fillStyle = pal.secondary;
    ctx2d.fillText(l1, W / 2 + dx1, centerMid - gap);
    ctx2d.restore();

    ctx2d.save();
    ctx2d.globalAlpha = Math.min(1, enter2 * 1.15);
    const s2 = fitText(ctx2d, l2, W - 16, maxStart, minSz, '900');
    ctx2d.font = '900 ' + s2 + 'px "Arial Black", Impact, Arial, sans-serif';
    ctx2d.fillStyle = pal.primary;
    ctx2d.fillText(l2, W / 2 + dx2, centerMid + gap);
    ctx2d.restore();
  } else if (l1 || l2) {
    const single = l1 || l2;
    ctx2d.font = '900 ' + (isWide ? 22 : 34) + 'px "Arial Black", Impact, Arial, sans-serif';
    const lines = wrapLines(ctx2d, single, W - 18).slice(0, 2);
    lines.forEach((ln, idx) => {
      const sz = fitText(ctx2d, ln, W - 18, isWide ? 24 : 38, 12, '900');
      ctx2d.font = '900 ' + sz + 'px "Arial Black", Impact, Arial, sans-serif';
      ctx2d.fillStyle = idx === 0 ? pal.secondary : pal.primary;
      const g = isWide ? 12 : 21;
      ctx2d.fillText(ln, W / 2, lines.length === 1 ? centerMid : (idx === 0 ? centerMid - g : centerMid + g));
    });
  }

  // Bottom Bar / Comfortable-Speed Scrolling Ticker (~36px/sec)
  const foot = String(slide.foot || '').toUpperCase().trim();
  if (foot) {
    ctx2d.fillStyle = '#0B1320';
    ctx2d.fillRect(6, footY, W - 12, footH);
    ctx2d.strokeStyle = pal.primary;
    ctx2d.lineWidth = 1.5;
    ctx2d.strokeRect(6, footY, W - 12, footH);

    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.rect(8, footY + 1, W - 16, footH - 2);
    ctx2d.clip();

    if (animMode === 'ticker') {
      ctx2d.font = '900 ' + (isWide ? 11 : 15) + 'px Arial, sans-serif';
      const msg = foot + '   ★   ';
      const tw = Math.max(ctx2d.measureText(msg).width, W);
      const shift = (elapsedSec * 36) % tw;
      ctx2d.textAlign = 'left';
      ctx2d.fillStyle = '#FFFFFF';
      for (let rx = 12 - shift; rx < W; rx += tw) {
        ctx2d.fillText(msg, rx, footY + footH / 2 + 0.5);
      }
    } else {
      const fSize = fitText(ctx2d, foot, W - 18, isWide ? 11 : 15, 8, '800');
      ctx2d.font = '800 ' + fSize + 'px Arial, sans-serif';
      ctx2d.textAlign = 'center';
      ctx2d.fillStyle = '#FFFFFF';
      ctx2d.fillText(foot, W / 2, footY + footH / 2 + 0.5);
    }
    ctx2d.restore();
  }

  // Clean subtle Hyperframe sweep once near the middle of the hold
  if (animMode === 'motion_fade' && elapsedSec > 0.8 && elapsedSec < 1.8) {
    const k = (elapsedSec - 0.8) / 1.0;
    const sx = -50 + k * (W + 100);
    const grad = ctx2d.createLinearGradient(sx, 0, sx + 45, H);
    grad.addColorStop(0, 'rgba(0,229,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(0,229,255,0)');
    ctx2d.fillStyle = grad;
    ctx2d.fillRect(3, 3, W - 6, H - 6);
  }
}

function drawComposedFrame(ctx2d, W, H, slides, totalSec, elapsedSec, animMode, assets) {
  assets.railSec = elapsedSec;
  let rem = elapsedSec % Math.max(1, totalSec);
  let curIdx = 0;
  let slideElapsed = 0;
  for (let i = 0; i < slides.length; i++) {
    const dur = Math.max(2, Number(slides[i].seconds) || 5);
    if (rem < dur || i === slides.length - 1) {
      curIdx = i;
      slideElapsed = rem;
      break;
    }
    rem -= dur;
  }

  const cur = slides[curIdx];
  const curDur = Math.max(2, Number(cur.seconds) || 5);
  const transDur = slides.length > 1 ? (animMode === 'pro' ? 0.3 : 0.42) : 0;

  // Smooth Motion Transition into the NEXT slide during the last 0.42s
  if (transDur > 0 && slideElapsed > curDur - transDur && (animMode === 'motion_push' || animMode === 'motion_fade' || animMode === 'pro')) {
    const t = easeInOutCubic((slideElapsed - (curDur - transDur)) / transDur);
    const nextIdx = (curIdx + 1) % slides.length;
    const next = slides[nextIdx];
    const nextDur = Math.max(2, Number(next.seconds) || 5);

    const bufA = drawComposedFrame._bufA || (drawComposedFrame._bufA = document.createElement('canvas'));
    const bufB = drawComposedFrame._bufB || (drawComposedFrame._bufB = document.createElement('canvas'));
    if (bufA.width !== W || bufA.height !== H) { bufA.width = W; bufA.height = H; }
    if (bufB.width !== W || bufB.height !== H) { bufB.width = W; bufB.height = H; }
    const ctxA = bufA.getContext('2d');
    const ctxB = bufB.getContext('2d');

    drawSingleSlide(ctxA, W, H, cur, slideElapsed / curDur, curDur, animMode, assets);
    drawSingleSlide(ctxB, W, H, next, 0.01, nextDur, animMode, assets);

    ctx2d.fillStyle = '#000000';
    ctx2d.fillRect(0, 0, W, H);
    if (animMode === 'motion_push') {
      const shift = Math.round(t * W);
      ctx2d.drawImage(bufA, -shift, 0);
      ctx2d.drawImage(bufB, W - shift, 0);
    } else {
      ctx2d.save();
      ctx2d.globalAlpha = 1 - t;
      ctx2d.drawImage(bufA, 0, 0);
      ctx2d.globalAlpha = t;
      ctx2d.drawImage(bufB, 0, 0);
      ctx2d.restore();
    }
    return;
  }

  drawSingleSlide(ctx2d, W, H, cur, slideElapsed / curDur, curDur, animMode, assets);
}

export async function renderLedSign(ctx) {
  const ubcLogo = new window.Image();
  ubcLogo.src = 'assets/ubc-logo-white.png';
  const ubcMark = new window.Image();
  ubcMark.src = 'assets/ubc-mark-white.png';
  let fontReady = Promise.resolve();
  if (window.FontFace && document.fonts) {
    const ff = new window.FontFace('UBC Kallisto', 'url(assets/fonts/kallisto-black.otf)', {
      weight: '900',
      unicodeRange: 'U+0020, U+0041-005A, U+0061-007A',
    });
    fontReady = ff.load().then((f) => { document.fonts.add(f); }).catch(() => {});
  }
  const assets = { ubcLogo, ubcMark, customImg: null, customName: '', railSec: 0 };

  const st = {
    sizeKey: '214x112',
    slides: TEMPLATES[0].slides.map((s) => Object.assign({}, s)),
    activeIdx: 0,
    animMode: TEMPLATES[0].anim || 'motion_push',
    codec: 'mjpeg',
    fps: 15,
    exporting: false,
  };

  const canvas1x = h('canvas.led-canvas-1x', { width: 214, height: 112 });
  const canvas2x = h('canvas.led-canvas-2x', { width: 214, height: 112 });
  const ctx1 = canvas1x.getContext('2d', { willReadFrequently: true });
  const ctx2 = canvas2x.getContext('2d', { willReadFrequently: true });
  const label1x = h('span.small.muted', 'Actual Pixels (214×112)');

  const slidesHost = h('div.stack-sm');
  const editorHost = h('div.stack-sm');
  const exportBtn = h('button.btn.primary', { type: 'button' }, 'Download 214×112 .AVI');
  const exportHfBtn = h('button.btn.sm', { type: 'button' }, 'Export HyperFrames .HTML');
  const exportStatus = h('span.small.muted', '5s reading time per slide · Audio-free 214×112 AVI');
  const catalogHost = h('div.led-catalog-hits');
  const uploadStatus = h('span.small.muted', 'No custom image uploaded yet');

  function syncCanvasSize() {
    const dim = SIZES[st.sizeKey] || SIZES['214x112'];
    canvas1x.width = dim.w;
    canvas1x.height = dim.h;
    canvas2x.width = dim.w;
    canvas2x.height = dim.h;
    canvas1x.style.width = dim.w + 'px';
    canvas1x.style.height = dim.h + 'px';
    canvas2x.style.width = Math.min(428, dim.w * 2) + 'px';
    canvas2x.style.height = Math.round(Math.min(428, dim.w * 2) * (dim.h / dim.w)) + 'px';
    label1x.textContent = 'Actual Pixels (' + dim.w + '×' + dim.h + ')';
    exportBtn.textContent = 'Download ' + dim.w + '×' + dim.h + ' .AVI';
  }

  let rafId = null;
  let startTs = performance.now();

  function drawPreviewLoop(now) {
    if (!ctx.isCurrent()) {
      if (rafId) window.cancelAnimationFrame(rafId);
      return;
    }
    const dim = SIZES[st.sizeKey] || SIZES['214x112'];
    const totalSec = st.slides.reduce((a, s) => a + Math.max(2, Number(s.seconds) || 5), 0);
    const elapsedSec = (now - startTs) / 1000;
    drawComposedFrame(ctx1, dim.w, dim.h, st.slides, totalSec, elapsedSec, st.animMode, assets);
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
        }, 'Slide ' + (idx + 1) + ' (' + (s.seconds || 5) + 's)')),
        st.slides.length < 4 ? h('button.btn.sm', {
          type: 'button',
          onclick: () => {
            st.slides.push({ layout: 'slam', badge: 'UBC TAMPA', line1: 'SHOP TODAY', line2: 'UBCBIKE.COM', foot: 'CALL (813) 971-2277', palette: 'blue_red_white', logo: 'ubc', icon: 'wheel', seconds: 5 });
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
      onchange: (e) => { cur.seconds = Number(e.target.value) || 5; renderSlidesBar(); },
    }, [3, 4, 5, 6, 8].map((sec) => h('option', { value: String(sec), selected: Number(cur.seconds || 5) === sec }, sec + ' seconds' + (sec === 5 ? ' (Recommended)' : ''))));

    const layoutSel = h('select', {
      onchange: (e) => { cur.layout = e.target.value; },
    }, PRO_LAYOUTS.map(([v, lbl]) => h('option', { value: v, selected: (cur.layout || 'slam') === v }, lbl)));

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
        h('label.led-field', h('span.small.muted', 'Pro Layout (UBC Pro mode)'), layoutSel),
        h('label.led-field', h('span.small.muted', 'Top Logo / Header'), logoSel),
        h('label.led-field', h('span.small.muted', 'Animated Vector Icon'), iconSel),
        field('Top Banner (when Text Only)', 'badge', 'e.g. IN STOCK TODAY'),
        h('label.led-field', h('span.small.muted', 'Reading Time'), secSel),
        field('Big Headline 1', 'line1', 'e.g. WALK-IN'),
        field('Big Headline 2 (Accent)', 'line2', 'e.g. SERVICE CENTER'),
        field('Bottom Line (Phone / Website)', 'foot', 'e.g. (813) 971-2277 · UBCBIKE.COM'),
        h('label.led-field', h('span.small.muted', 'Vibrant LED Colors'), palSel),
      ),
      delBtn ? h('div.row-between', h('span.small.muted', 'Tip: 5–6 seconds gives drivers plenty of time to read both lines + phone/website.'), delBtn) : null);
  }

  async function canvasToJpegBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error('Canvas JPEG export failed'));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, 'image/jpeg', 0.94);
    });
  }

  exportHfBtn.addEventListener('click', () => {
    const dim = SIZES[st.sizeKey] || SIZES['214x112'];
    const totalSec = st.slides.reduce((a, s) => a + Math.max(2, Number(s.seconds) || 5), 0);
    let cursor = 0;
    const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const sections = st.slides.map((s, idx) => {
      const dur = Math.max(2, Number(s.seconds) || 5);
      const pal = PALETTES[s.palette] || PALETTES.blue_red_white;
      const start = cursor;
      cursor += dur;
      return `    <section id="scene-${idx + 1}" class="clip" data-start="${start}" data-duration="${dur}" data-track-index="1" style="position:absolute;inset:0;background:#000;border:2px solid ${pal.border};display:flex;flex-direction:column;justify-content:space-between;padding:5px 6px;text-align:center;">
      <div style="background:${pal.badgeBg};color:${pal.badgeFg};font-size:10px;font-weight:900;padding:2px 6px;text-transform:uppercase;">${escHtml(s.badge || 'UBC TAMPA')}</div>
      <div>
        <div style="color:${pal.secondary};font-size:21px;font-weight:900;line-height:1.05;text-transform:uppercase;">${escHtml(s.line1)}</div>
        <div style="color:${pal.primary};font-size:20px;font-weight:900;line-height:1.05;text-transform:uppercase;">${escHtml(s.line2)}</div>
      </div>
      <div style="background:#0B1320;border:1.5px solid ${pal.primary};color:#FFF;font-size:10px;font-weight:900;padding:2px 4px;text-transform:uppercase;">${escHtml(s.foot)}</div>
    </section>`;
    }).join('\n');

    const doc = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>UBC LED Sign (${dim.w}x${dim.h})</title>
  <style>*{box-sizing:border-box;margin:0;padding:0}html,body{width:${dim.w}px;height:${dim.h}px;overflow:hidden;background:#000;font-family:"Arial Black",Arial,sans-serif}#main{position:relative;width:${dim.w}px;height:${dim.h}px}</style>
</head>
<body>
  <div id="main" data-composition-id="ubc-led-sign" data-start="0" data-duration="${totalSec}" data-width="${dim.w}" data-height="${dim.h}" data-no-timeline>
${sections}
  </div>
</body>
</html>`;
    const blob = new Blob([doc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'index.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('HyperFrames index.html downloaded (' + dim.w + '×' + dim.h + ', ' + totalSec + 's)', 'ok');
  });

  exportBtn.addEventListener('click', async () => {
    if (st.exporting) return;
    st.exporting = true;
    exportBtn.disabled = true;
    const dim = SIZES[st.sizeKey] || SIZES['214x112'];
    try {
      await fontReady;
      const off = document.createElement('canvas');
      off.width = dim.w;
      off.height = dim.h;
      const octx = off.getContext('2d', { willReadFrequently: true });
      const frames = [];
      const fps = st.fps;
      const totalSec = st.slides.reduce((a, s) => a + Math.max(2, Number(s.seconds) || 5), 0);
      const totalFrames = Math.round(totalSec * fps);

      for (let f = 0; f < totalFrames; f++) {
        drawComposedFrame(octx, dim.w, dim.h, st.slides, totalSec, f / fps, st.animMode, assets);
        if (st.codec === 'rgb24') {
          const imgData = octx.getImageData(0, 0, dim.w, dim.h);
          frames.push(rgbaToBgr24BottomUp(imgData.data, dim.w, dim.h));
        } else {
          frames.push(await canvasToJpegBytes(off));
        }
        if ((f + 1) % 12 === 0 || f + 1 === totalFrames) {
          exportStatus.textContent = 'Rendering frame ' + (f + 1) + ' / ' + totalFrames + ' (' + totalSec + 's)…';
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      const aviBlob = st.codec === 'rgb24'
        ? encodeRgb24Avi(frames, dim.w, dim.h, fps)
        : encodeMjpegAvi(frames, dim.w, dim.h, fps);

      const fname = 'ubc-led-sign-' + dim.w + 'x' + dim.h + '-' + st.codec + '.avi';
      const url = URL.createObjectURL(aviBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      const kb = Math.round(aviBlob.size / 1024);
      exportStatus.textContent = 'Downloaded ' + fname + ' (' + kb + ' KB, ' + totalSec + 's loop)';
      toast(dim.w + '×' + dim.h + ' .AVI ready (' + totalSec + 's, ' + kb + ' KB)', 'ok');
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
              cur.foot = '(813) 971-2277 · UBCBIKE.COM';
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

  const sizeSel = h('select', { onchange: (e) => { st.sizeKey = e.target.value; syncCanvasSize(); } },
    Object.keys(SIZES).map((k) => h('option', { value: k, selected: st.sizeKey === k }, SIZES[k].label)));

  const animSel = h('select', { onchange: (e) => { st.animMode = e.target.value; } },
    h('option', { value: 'pro', selected: true }, 'UBC Pro Street (Big Kallisto Type)'),
    h('option', { value: 'motion_push' }, 'Hyperframe Motion Push (Smooth Slide)'),
    h('option', { value: 'motion_fade' }, 'Hyperframe Glow + Crossfade'),
    h('option', { value: 'laser' }, 'Laser Corner Chase'),
    h('option', { value: 'ticker' }, 'Slow Readable Ticker'),
    h('option', { value: 'pulse' }, 'Bright Border Pulse'),
    h('option', { value: 'static' }, 'Static High Contrast'));

  const codecSel = h('select', { onchange: (e) => { st.codec = e.target.value; } },
    h('option', { value: 'mjpeg', selected: true }, 'MJPEG .avi (Standard — Small File)'),
    h('option', { value: 'rgb24' }, 'Uncompressed RGB .avi (Legacy LED Controllers)'));

  const fpsSel = h('select', { onchange: (e) => { st.fps = Number(e.target.value) || 15; } },
    h('option', { value: '15', selected: true }, '15 fps (Recommended for LED)'),
    h('option', { value: '24' }, '24 fps (Smooth Motion)'));

  syncCanvasSize();
  renderSlidesBar();
  renderSlideEditor();
  rafId = window.requestAnimationFrame(drawPreviewLoop);

  return h('div.stack.led-root',
    pageHead('LED Sign Studio (214×112 .AVI)', 'Readable 5s street pacing, Motion/Hyperframe transitions, phone & UBCBIKE.COM on vibrant LED colors.'),
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
      card('3. Live 214×112 Preview & Export', h('div.stack-sm',
        h('div.led-previews',
          h('div.led-prev-box', label1x, canvas1x),
          h('div.led-prev-box', h('span.small.muted', '2× Street Preview'), canvas2x)),
        h('div.led-export-opts',
          h('label.led-field', h('span.small.muted', 'Sign Resolution'), sizeSel),
          h('label.led-field', h('span.small.muted', 'Motion / Transitions'), animSel),
          h('label.led-field', h('span.small.muted', 'AVI Format'), codecSel),
          h('label.led-field', h('span.small.muted', 'Frame Rate'), fpsSel)),
        h('div.row-between', exportStatus, h('div.led-tpl-row', exportHfBtn, exportBtn))))));
}
