import { h, mount } from '../ui/dom.js';
import { card, pageHead, toast } from '../ui/components.js';
import { encodeMjpegAvi, encodeRgb24Avi, rgbaToBgr24BottomUp } from '../ui/avi-encoder.js?v=91';
import { ICONS, drawIcon, iconEntrance } from './led-icons.js?v=91';

// UBC street sign: 214 x 112 pixels, 15 fps, audio-free .AVI.
const W = 214;
const H = 112;
const FPS = 15;
const MAX_SLIDES = 6;
const TRANS_SEC = 0.35;

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
  orange: { label: 'Orange', primary: '#FF8A00' },
  magenta: { label: 'Magenta', primary: '#FF2BD6' },
  purple: { label: 'Purple', primary: '#B26BFF' },
  gold: { label: 'Gold', primary: '#FFC400' },
  lime: { label: 'Lime', primary: '#B6FF1A' },
  white: { label: 'White', primary: '#FFFFFF' },
};

const LAYOUTS = [
  ['slam', 'Headline'],
  ['swap', 'Line Swap'],
  ['price', 'Price Tag'],
  ['rating', 'Star Rating'],
  ['ticker', 'Scrolling Ticker'],
  ['brand', 'UBC Close (logo + phone)'],
];
const BGS = [
  ['black', 'Black'], ['tint', 'Dark color tint'], ['gradient', 'Soft moving glow'], ['spotlight', 'Spotlight sweep'],
  ['stars', 'Twinkling stars'], ['flood', 'Solid color (bold)'],
];
const ENTERS = [
  ['zoom_in', 'Slam (zoom in)'], ['zoom_out', 'Pop (grow + bounce)'], ['slide_left', 'Slide in from right'],
  ['slide_right', 'Slide in from left'], ['drop', 'Drop + bounce'], ['rise', 'Rise up'], ['flip', 'Flip'],
  ['spin', 'Spin in (full turn)'], ['typewriter', 'Type reveal'], ['glitch', 'Glitch'], ['fade', 'Fade'],
];
const MOTIONS = [
  ['none', 'Hold still'], ['pulse', 'Pulse'], ['float', 'Float'], ['zoom', 'Slow zoom'],
  ['swing', 'Swing'], ['shake', 'Shake'], ['blink', 'Flash'],
];
const DECOS = [
  ['rail', 'Bottom rail'], ['chase', 'Border chase'], ['corners', 'Corner brackets'],
  ['bars', 'Top & bottom bars'], ['sparkle', 'Sparkles'], ['rider', 'Bike riding across'], ['none', 'None'],
];
const TRANS = [
  ['fade', 'Crossfade'], ['push_left', 'Push left'], ['push_up', 'Push up'], ['zoom', 'Zoom through'],
  ['wipe', 'Color wipe'], ['flash', 'Flash'], ['cut', 'Cut'],
];

const TAMPA = '(813) 971-2277 · UBCBIKE.COM';
const ALAFIA = '(813) 459-8293 · UBCBIKE.COM';
const S = (layout, line1, line2, palette, seconds, foot, style) => Object.assign(
  { layout, line1, line2, foot: foot || '', palette, seconds, bg: 'black', enter: 'zoom_in', motion: 'none', deco: 'rail', trans: 'fade', color: 'white', icon: 'none', iconSide: 'left' },
  style || {});
const st_ = (bg, enter, motion, deco, trans, color) => ({ bg, enter, motion, deco, trans, color: color || 'white' });
const ic = (icon, iconSide) => ({ icon, iconSide: iconSide || 'left' });

// Built-in templates (version 3: each has its own look, clean backgrounds only).
// Copy only uses facts published on ubcbike.com or given by UBC.
const BUILTIN_VERSION = 5;
const BUILTIN = [
  { name: 'Street Ad', slides: [
    S('slam', 'NEW', 'E-BIKES', 'blue_red_white', 5, '', Object.assign(st_('spotlight', 'zoom_in', 'pulse', 'rail', 'push_left'), ic('ebike', 'left'))),
    S('slam', 'WE FIX', 'BIKES, E-BIKES, SCOOTERS', 'red_white', 6, '', Object.assign(st_('tint', 'slide_left', 'none', 'chase', 'zoom'), ic('tools', 'right'))),
    S('swap', 'WALK IN TODAY', 'READY IN 24H', 'blue_red_white', 5, '', Object.assign(st_('spotlight', 'rise', 'float', 'corners', 'wipe'), ic('clock', 'left'))),
    S('brand', '', '', 'blue_red_white', 5, TAMPA, st_('black', 'zoom_in', 'none', 'sparkle', 'fade'))] },
  { name: '4.8 Stars · 1,100+ Reviews', slides: [
    S('rating', '4.8 STARS', '1,100+ REVIEWS', 'gold', 6, '', st_('stars', 'zoom_out', 'none', 'sparkle', 'flash')),
    S('slam', 'THANK YOU', 'TAMPA', 'blue_red_white', 4, '', st_('gradient', 'typewriter', 'float', 'bars', 'push_up')),
    S('swap', 'SEE WHY', 'VISIT UBC TODAY', 'gold', 5, '', Object.assign(st_('tint', 'flip', 'none', 'corners', 'wipe'), ic('pin', 'left'))),
    S('brand', '', '', 'gold', 5, TAMPA, st_('stars', 'zoom_in', 'none', 'corners', 'fade'))] },
  { name: 'Black Friday', slides: [
    S('slam', 'BLACK', 'FRIDAY', 'red_white', 4, '', st_('flood', 'glitch', 'shake', 'none', 'flash')),
    S('price', 'BIKES UP TO', '35% OFF', 'red_white', 5, '', Object.assign(st_('gradient', 'zoom_out', 'pulse', 'chase', 'zoom'), ic('tag', 'left'))),
    S('swap', 'WE PRICE MATCH', 'SHOP IN STORE', 'gold', 5, '', Object.assign(st_('black', 'slide_right', 'none', 'bars', 'wipe'), ic('check', 'right'))),
    S('brand', '', '', 'red_white', 5, TAMPA, st_('black', 'zoom_in', 'none', 'chase', 'fade'))] },
  { name: 'Alafia Rentals', slides: [
    S('slam', 'ALAFIA', 'BIKE RENTALS', 'green_white', 5, '', Object.assign(st_('spotlight', 'drop', 'none', 'corners', 'push_left'), ic('bike', 'left'))),
    S('slam', 'RIDE THE', 'TRAILS', 'lime', 5, '', st_('gradient', 'slide_left', 'none', 'rider', 'push_up')),
    S('swap', 'WED-FRI 10-5', 'SAT-SUN 8-5', 'green_white', 5, '', Object.assign(st_('tint', 'flip', 'none', 'bars', 'wipe'), ic('calendar', 'left'))),
    S('brand', '', '', 'green_white', 5, ALAFIA, st_('black', 'zoom_in', 'none', 'rail', 'fade'))] },
  { name: 'Shop Online', slides: [
    S('slam', 'SHOP', 'ONLINE', 'cyan_white', 4, '', st_('tint', 'typewriter', 'none', 'bars', 'zoom')),
    S('swap', 'ORDER ONLINE', 'FREE PICKUP', 'purple', 5, '', Object.assign(st_('spotlight', 'rise', 'pulse', 'corners', 'push_left'), ic('cart', 'left'))),
    S('ticker', 'FREE SHIPPING', 'ON $50+', 'cyan_white', 6, '', st_('tint', 'fade', 'none', 'rail', 'wipe')),
    S('brand', '', '', 'cyan_white', 5, 'UBCBIKE.COM · (813) 971-2277', st_('black', 'zoom_in', 'none', 'sparkle', 'fade'))] },
  { name: 'Financing', slides: [
    S('slam', 'EASY', 'FINANCING', 'gold', 4, '', Object.assign(st_('flood', 'zoom_out', 'none', 'none', 'push_up'), ic('check', 'left'))),
    S('slam', 'WITH', 'SYNCHRONY, SNAP, ACIMA', 'yellow_cyan', 6, '', st_('gradient', 'slide_right', 'none', 'chase', 'zoom')),
    S('swap', 'RIDE TODAY', 'PAY OVER TIME', 'yellow_cyan', 5, '', Object.assign(st_('black', 'spin', 'float', 'sparkle', 'flash'), ic('bike', 'right'))),
    S('brand', '', '', 'yellow_cyan', 5, TAMPA, st_('black', 'zoom_in', 'none', 'corners', 'fade'))] },
  { name: 'Service & Tune-Ups', slides: [
    S('price', 'TUNE-UPS FROM', '$100', 'blue_red_white', 5, '', Object.assign(st_('spotlight', 'drop', 'pulse', 'corners', 'push_left'), ic('wrench', 'left'))),
    S('swap', 'NO APPOINTMENT', '1 DAY REPAIRS', 'orange', 5, '', st_('spotlight', 'slide_left', 'none', 'bars', 'wipe')),
    S('slam', 'WE FIX', 'ROAD, MTB, E-BIKES', 'red_white', 6, '', Object.assign(st_('tint', 'glitch', 'none', 'chase', 'zoom'), ic('gear', 'right'))),
    S('brand', '', '', 'blue_red_white', 5, TAMPA, st_('black', 'zoom_in', 'none', 'rail', 'fade'))] },
  { name: 'Trade-In', slides: [
    S('slam', 'TRADE IN', 'YOUR BIKE', 'cyan_white', 5, '', Object.assign(st_('gradient', 'spin', 'none', 'sparkle', 'zoom'), ic('bike', 'left'))),
    S('swap', 'GET CREDIT', 'UPGRADE TODAY', 'lime', 5, '', st_('tint', 'rise', 'none', 'rider', 'push_up')),
    S('slam', 'WE', 'PRICE MATCH', 'red_white', 4, '', st_('flood', 'zoom_in', 'shake', 'none', 'flash')),
    S('brand', '', '', 'cyan_white', 5, TAMPA, st_('black', 'zoom_in', 'none', 'chase', 'fade'))] },
  { name: 'Student, Veteran & Police Discounts', since: 5, slides: [
    S('slam', 'SPECIAL', 'DISCOUNTS', 'gold', 4, '', Object.assign(st_('spotlight', 'zoom_out', 'pulse', 'sparkle', 'push_left'), ic('tag', 'left'))),
    S('slam', 'FOR', 'STUDENTS', 'blue_red_white', 4, '', Object.assign(st_('tint', 'slide_left', 'none', 'corners', 'push_left'), ic('grad', 'left'))),
    S('slam', 'FOR', 'VETERANS', 'red_white', 4, '', Object.assign(st_('black', 'slide_left', 'none', 'bars', 'push_left'), ic('flag', 'left'))),
    S('slam', 'FOR', 'POLICE', 'blue_red_white', 4, '', Object.assign(st_('tint', 'drop', 'none', 'chase', 'flash'), ic('badge', 'left'))),
    S('swap', 'THANK YOU', 'ASK IN STORE', 'gold', 5, '', Object.assign(st_('stars', 'rise', 'float', 'sparkle', 'fade'), ic('star', 'right'))),
    S('brand', '', '', 'blue_red_white', 5, TAMPA, st_('black', 'zoom_in', 'none', 'rail', 'fade'))] },
  { name: 'Since 1972', slides: [
    S('slam', 'SINCE', '1972', 'gold', 4, '', st_('stars', 'zoom_out', 'zoom', 'sparkle', 'push_left')),
    S('slam', 'TAMPA', 'BIKE SHOP', 'blue_red_white', 5, '', Object.assign(st_('gradient', 'typewriter', 'none', 'rail', 'wipe'), ic('wheel', 'left'))),
    S('swap', '1220 E FLETCHER', 'OPEN MON - SAT', 'blue_red_white', 5, '', st_('tint', 'flip', 'none', 'bars', 'zoom')),
    S('brand', '', '', 'gold', 5, TAMPA, st_('stars', 'zoom_in', 'none', 'corners', 'fade'))] },
];

const cloneSlides = (slides) => slides.map((s) => Object.assign({}, s));
const slideSeconds = (s) => Math.min(10, Math.max(2, Number(s.seconds) || 5));
const totalSeconds = (slides) => slides.reduce((a, s) => a + slideSeconds(s), 0);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function easeOutExpo(t) {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * Math.max(0, t));
}
function easeOutCubic(t) {
  return 1 - Math.pow(1 - clamp01(t), 3);
}
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = clamp01(t) - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}
function easeOutBounce(t) {
  let x = clamp01(t);
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) { x -= 1.5 / d1; return n1 * x * x + 0.75; }
  if (x < 2.5 / d1) { x -= 2.25 / d1; return n1 * x * x + 0.9375; }
  x -= 2.625 / d1;
  return n1 * x * x + 0.984375;
}
// deterministic pseudo-random in [0,1) so the export and the preview match
function rand(n) {
  const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
}
function hexToRgb(hex) {
  const v = parseInt(String(hex).slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgba(hex, a) {
  const c = hexToRgb(hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
}
function isLight(hex) {
  const c = hexToRgb(hex);
  return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.6;
}

// Text size of the slide being drawn (per-slide "Text size" control, 1 = 100 %).
let TEXT_SCALE = 1;

function fitFont(ctx2d, text, maxWidth, startSize, minSize, family) {
  let size = Math.max(minSize, Math.round(startSize * TEXT_SCALE));
  while (size > minSize) {
    ctx2d.font = '900 ' + size + 'px ' + family;
    if (ctx2d.measureText(text).width <= maxWidth) break;
    size -= 1;
  }
  ctx2d.font = '900 ' + size + 'px ' + family;
  return size;
}

// ---------- Backgrounds ----------
function drawBackground(ctx2d, kind, rs, accent) {
  ctx2d.fillStyle = '#000000';
  ctx2d.fillRect(0, 0, W, H);
  ctx2d.save();
  if (kind === 'flood') {
    ctx2d.fillStyle = accent;
    ctx2d.fillRect(0, 0, W, H);
  } else if (kind === 'tint') {
    ctx2d.fillStyle = rgba(accent, 0.17);
    ctx2d.fillRect(0, 0, W, H);
  } else if (kind === 'gradient') {
    const p = ((rs * 45) % (2 * W)) - W;
    const g = ctx2d.createLinearGradient(p - W, 0, p + W, H);
    g.addColorStop(0, rgba(accent, 0.05));
    g.addColorStop(0.5, rgba(accent, 0.38));
    g.addColorStop(1, rgba(accent, 0.05));
    ctx2d.fillStyle = g;
    ctx2d.fillRect(0, 0, W, H);
  } else if (kind === 'spotlight') {
    const x = W / 2 + Math.sin(rs * 1.1) * W * 0.42;
    const g = ctx2d.createRadialGradient(x, H * 0.45, 4, x, H * 0.45, 85);
    g.addColorStop(0, rgba(accent, 0.45));
    g.addColorStop(1, rgba(accent, 0));
    ctx2d.fillStyle = g;
    ctx2d.fillRect(0, 0, W, H);
  } else if (kind === 'stars') {
    for (let i = 0; i < 34; i++) {
      const tw = Math.abs(Math.sin(rs * (1.3 + rand(i + 7) * 2) + i));
      ctx2d.globalAlpha = 0.15 + 0.85 * tw;
      ctx2d.fillStyle = i % 3 === 0 ? accent : '#FFFFFF';
      const sz = rand(i + 3) > 0.8 ? 2 : 1;
      ctx2d.fillRect(Math.floor(rand(i) * W), Math.floor(rand(i + 100) * H), sz, sz);
    }
  }
  ctx2d.restore();
}

// ---------- Decorations ----------
function drawDeco(ctx2d, kind, rs, accent) {
  ctx2d.save();
  if (kind === 'rail') {
    const x = ((rs / 3.5) % 1) * 2 * W - W;
    const g = ctx2d.createLinearGradient(x, 0, x + W, 0);
    g.addColorStop(0, 'rgba(56,189,248,0)');
    g.addColorStop(0.35, '#38BDF8');
    g.addColorStop(0.65, '#FF2D2D');
    g.addColorStop(1, 'rgba(255,45,45,0)');
    ctx2d.globalAlpha = 0.9;
    ctx2d.fillStyle = g;
    ctx2d.fillRect(x, H - 2, W, 2);
  } else if (kind === 'chase') {
    const per = 2 * (W - 2 + H - 2);
    ctx2d.lineWidth = 2;
    [accent, '#FFFFFF'].forEach((c, i) => {
      ctx2d.strokeStyle = c;
      ctx2d.setLineDash([46, per - 46]);
      ctx2d.lineDashOffset = -((rs * 140 + (i * per) / 2) % per);
      ctx2d.strokeRect(1, 1, W - 2, H - 2);
    });
  } else if (kind === 'corners') {
    const L = 13;
    ctx2d.strokeStyle = accent;
    ctx2d.lineWidth = 2;
    ctx2d.globalAlpha = 0.65 + 0.35 * Math.sin(rs * 4);
    [[2, 2, 1, 1], [W - 2, 2, -1, 1], [2, H - 2, 1, -1], [W - 2, H - 2, -1, -1]].forEach(([x, y, dx, dy]) => {
      ctx2d.beginPath();
      ctx2d.moveTo(x, y + dy * L);
      ctx2d.lineTo(x, y);
      ctx2d.lineTo(x + dx * L, y);
      ctx2d.stroke();
    });
  } else if (kind === 'bars') {
    ctx2d.fillStyle = accent;
    ctx2d.fillRect(0, 0, W, 3);
    ctx2d.fillRect(0, H - 3, W, 3);
    const x = ((rs * 90) % (W + 40)) - 40;
    ctx2d.fillStyle = 'rgba(255,255,255,0.85)';
    ctx2d.fillRect(x, 0, 40, 3);
    ctx2d.fillRect(W - x - 40, H - 3, 40, 3);
  } else if (kind === 'rider') {
    const x = ((rs * 48) % (W + 44)) - 22;
    ctx2d.translate(x, H - 11);
    drawIcon(ctx2d, 'bike', 20, rs, '#FFFFFF', accent);
  } else if (kind === 'sparkle') {
    for (let i = 0; i < 10; i++) {
      const s = 3.5 * Math.max(0, Math.sin(rs * 2.6 + i * 1.9));
      if (s < 0.4) continue;
      const edge = i % 2 === 0;
      const x = edge ? 6 + rand(i + 40) * (W - 12) : (rand(i + 41) > 0.5 ? 8 + rand(i) * 26 : W - 8 - rand(i) * 26);
      const y = edge ? (rand(i + 42) > 0.5 ? 6 + rand(i + 1) * 10 : H - 6 - rand(i + 1) * 10) : 8 + rand(i + 43) * (H - 16);
      ctx2d.strokeStyle = i % 3 === 0 ? '#FFFFFF' : accent;
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(x - s, y);
      ctx2d.lineTo(x + s, y);
      ctx2d.moveTo(x, y - s);
      ctx2d.lineTo(x, y + s);
      ctx2d.stroke();
    }
  }
  ctx2d.restore();
}

// ---------- Entrance + motion ----------
function fxState(enter, motion, local, dur) {
  const f = { a: 1, s: 1, sx: 1, rot: 0, dx: 0, dy: 0, reveal: 1, ghost: false };
  switch (enter) {
    case 'zoom_out': { f.s = Math.max(0.01, easeOutBack(local / 0.5)); f.a = clamp01(local / 0.12); break; }
    case 'slide_left': { f.dx = (1 - easeOutExpo(clamp01(local / 0.45))) * W; break; }
    case 'slide_right': { f.dx = -(1 - easeOutExpo(clamp01(local / 0.45))) * W; break; }
    case 'drop': { f.dy = -(1 - easeOutBounce(local / 0.8)) * H; break; }
    case 'rise': { f.dy = (1 - easeOutExpo(clamp01(local / 0.45))) * H * 0.7; f.a = clamp01(local / 0.25); break; }
    case 'flip': { f.sx = Math.max(0.02, easeOutBack(local / 0.6)); f.a = clamp01(local / 0.1); break; }
    case 'spin': {
      const e = easeOutCubic(local / 0.7);
      f.rot = (1 - e) * -Math.PI * 2;
      f.s = Math.max(0.01, e);
      f.a = clamp01(local / 0.2);
      break;
    }
    case 'typewriter': { f.reveal = clamp01(local / 0.9); break; }
    case 'glitch': {
      if (local < 0.6) {
        const k = Math.floor(local * 30);
        f.dx = (rand(k + 1) - 0.5) * 16;
        f.dy = (rand(k + 2) - 0.5) * 6;
        f.sx = 1 + (rand(k + 3) - 0.5) * 0.25;
        f.a = rand(k + 4) < 0.25 ? 0.35 : 1;
        f.ghost = true;
      }
      break;
    }
    case 'fade': { f.a = clamp01(local / 0.5); break; }
    default: {
      const e = easeOutExpo(clamp01(local / 0.35));
      f.s = 1.5 - 0.5 * e;
      f.a = clamp01(e * 1.3);
    }
  }
  const m = local - 0.8;
  if (m > 0) {
    if (motion === 'pulse') f.s *= 1 + 0.05 * Math.sin(m * Math.PI * 2 * 1.1);
    else if (motion === 'float') f.dy += 2.5 * Math.sin(m * Math.PI * 2 * 0.6);
    else if (motion === 'zoom') f.s *= 1 + 0.09 * clamp01(m / Math.max(1, dur - 0.8));
    else if (motion === 'swing') f.rot += 0.06 * Math.sin(m * Math.PI * 2 * 0.7);
    else if (motion === 'shake') { const ph = m % 1.4; if (ph < 0.3) f.dx += Math.sin(ph * 90) * 2.5; }
    else if (motion === 'blink') { if (Math.floor(m * 2.5) % 4 === 3) f.a *= 0.2; }
  }
  return f;
}

// Draws `draw` centered on (cx, cy) with the slide's entrance and motion applied.
function withFx(ctx2d, slide, local, dur, cx, cy, draw) {
  const f = fxState(slide.enter || 'zoom_in', slide.motion || 'none', local, dur);
  if (f.a <= 0.001) return;
  ctx2d.save();
  ctx2d.globalAlpha *= f.a;
  ctx2d.translate(cx + f.dx, cy + f.dy);
  if (f.rot) ctx2d.rotate(f.rot);
  ctx2d.scale(f.s * f.sx, f.s);
  if (f.ghost) {
    ctx2d.save();
    ctx2d.globalAlpha *= 0.45;
    ctx2d.translate(3, 0);
    draw();
    ctx2d.restore();
  }
  if (f.reveal < 1) {
    const x = -W / 2 - 2 + (W + 4) * f.reveal;
    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.rect(-W, -H, x + W, 2 * H);
    ctx2d.clip();
    draw();
    ctx2d.restore();
    ctx2d.fillStyle = '#FFFFFF';
    ctx2d.fillRect(x, -16, 2, 32);
  } else {
    draw();
  }
  ctx2d.restore();
}

// ---------- Layouts (each draws its group around the origin) ----------
// Text area: the whole sign, or the part left free by an icon.
const FULL_AREA = { cx: W / 2, w: W - 12 };
let AREA = FULL_AREA;
const ICON_LAYOUTS = ['slam', 'swap', 'price'];
const ICON_SIZE = 46;
function drawSlam(ctx2d, slide, t, dur, c1, acc) {
  const l1 = String(slide.line1 || '').toUpperCase().trim();
  const opts = String(slide.line2 || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  const share = dur / Math.max(1, opts.length);
  const wi = Math.max(0, Math.min(opts.length - 1, Math.floor(t / share)));
  const word = opts.length ? opts[wi] : '';
  const kWord = wi > 0 ? easeOutExpo(clamp01((t - wi * share) / 0.3)) : 1;
  const big = Math.round(H * 0.4);
  let longest = word;
  opts.forEach((o) => { if (o.length > longest.length) longest = o; });
  const oneSz = fitFont(ctx2d, (l1 ? l1 + ' ' : '') + longest, AREA.w, big, 8, PRO_FONT);
  const stacked = l1 && word && oneSz < Math.round(H * 0.24);
  withFx(ctx2d, slide, t, dur, AREA.cx, H * 0.47, () => {
    const alpha = ctx2d.globalAlpha;
    if (!stacked) {
      ctx2d.font = '900 ' + oneSz + 'px ' + PRO_FONT;
      const w1 = l1 ? ctx2d.measureText(l1 + ' ').width : 0;
      const w2 = ctx2d.measureText(word).width;
      let x = -(w1 + w2) / 2;
      ctx2d.textAlign = 'left';
      if (l1) { ctx2d.fillStyle = c1; ctx2d.fillText(l1, x, 0); x += w1; }
      ctx2d.globalAlpha = alpha * kWord;
      ctx2d.fillStyle = acc;
      ctx2d.fillText(word, x, Math.round((1 - kWord) * 10));
      ctx2d.textAlign = 'center';
    } else {
      const s1 = fitFont(ctx2d, l1, AREA.w, big, 8, PRO_FONT);
      ctx2d.fillStyle = c1;
      ctx2d.fillText(l1, 0, -Math.round(s1 * 0.55));
      const s2 = fitFont(ctx2d, longest, AREA.w, big, 8, PRO_FONT);
      ctx2d.font = '900 ' + s2 + 'px ' + PRO_FONT;
      ctx2d.globalAlpha = alpha * kWord;
      ctx2d.fillStyle = acc;
      ctx2d.fillText(word, 0, Math.round(s2 * 0.55) + Math.round((1 - kWord) * 10));
    }
    ctx2d.globalAlpha = alpha;
  });
}

function drawSwap(ctx2d, slide, t, dur, c1, acc) {
  const lines = [String(slide.line1 || '').toUpperCase().trim(), String(slide.line2 || '').toUpperCase().trim()].filter(Boolean);
  if (!lines.length) return;
  const swapAt = lines.length > 1 ? dur * 0.45 : dur + 1;
  const showB = t >= swapAt;
  const txt = showB ? lines[1] : lines[0];
  const local = showB ? t - swapAt : t;
  withFx(ctx2d, slide, local, showB ? dur - swapAt : swapAt, AREA.cx, Math.round(H * 0.48), () => {
    const sz = fitFont(ctx2d, txt, AREA.w, Math.round(H * 0.4), 10, PRO_FONT);
    ctx2d.fillStyle = showB ? acc : c1;
    ctx2d.fillText(txt, 0, 0);
    if (showB) {
      const words = txt.split(/\s+/);
      const last = words[words.length - 1];
      const full = ctx2d.measureText(txt).width;
      const lw = ctx2d.measureText(last).width;
      const u = easeOutExpo(clamp01((local - 0.35) / 0.5));
      ctx2d.fillStyle = c1;
      ctx2d.fillRect(Math.round(full / 2 - lw), Math.round(sz * 0.5 + 2), Math.round(lw * u), 2);
    }
  });
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

function drawRating(ctx2d, slide, t, dur, c1, acc) {
  const l1 = String(slide.line1 || '').toUpperCase().trim();
  const l2 = String(slide.line2 || '').toUpperCase().trim();
  const m = l1.match(/\d+(\.\d+)?/);
  const rating = Math.max(0, Math.min(5, m ? Number(m[0]) : 5));
  withFx(ctx2d, slide, t, dur, AREA.cx, H / 2, () => {
    const alpha = ctx2d.globalAlpha;
    for (let i = 0; i < 5; i++) {
      const k = easeOutBack(clamp01((t - 0.15 - i * 0.12) / 0.35));
      if (k <= 0) continue;
      ctx2d.save();
      ctx2d.translate((i - 2) * 24, -38);
      ctx2d.scale(Math.max(0.01, k), Math.max(0.01, k));
      starPath(ctx2d, 0, 0, 10);
      ctx2d.fillStyle = '#3A3A3A';
      ctx2d.fill();
      const fill = clamp01(rating - i);
      if (fill > 0) {
        ctx2d.clip();
        ctx2d.fillStyle = acc;
        ctx2d.fillRect(-10, -10, 20 * fill, 20);
      }
      ctx2d.restore();
    }
    ctx2d.globalAlpha = alpha * clamp01((t - 0.5) / 0.4);
    if (l1) { fitFont(ctx2d, l1, AREA.w, 30, 10, PRO_FONT); ctx2d.fillStyle = c1; ctx2d.fillText(l1, 0, -2); }
    if (l2) { fitFont(ctx2d, l2, AREA.w, 24, 9, PRO_FONT); ctx2d.fillStyle = acc; ctx2d.fillText(l2, 0, 30); }
    ctx2d.globalAlpha = alpha;
  });
}

function drawPrice(ctx2d, slide, t, dur, c1, acc) {
  const label = String(slide.line1 || '').toUpperCase().trim();
  const price = String(slide.line2 || '').toUpperCase().trim();
  const was = String(slide.foot || '').toUpperCase().trim();
  const yL = was ? -34 : -26;
  const yP = was ? 2 : 12;
  withFx(ctx2d, slide, t, dur, AREA.cx, H / 2, () => {
    if (label) { fitFont(ctx2d, label, AREA.w - 4, 20, 9, PRO_FONT); ctx2d.fillStyle = c1; ctx2d.fillText(label, 0, yL); }
    if (price) { fitFont(ctx2d, price, AREA.w + 2, 46, 12, PRO_FONT); ctx2d.fillStyle = acc; ctx2d.fillText(price, 0, yP); }
    if (was) {
      fitFont(ctx2d, was, AREA.w - 28, 15, 8, NUM_FONT);
      ctx2d.fillStyle = c1;
      ctx2d.fillText(was, 0, 38);
      const w = ctx2d.measureText(was).width;
      ctx2d.fillStyle = '#FF2D2D';
      ctx2d.fillRect(-w / 2 - 2, 37, w + 4, 2);
    }
  });
}

function drawTicker(ctx2d, slide, t, c1, acc) {
  const a = String(slide.line1 || '').toUpperCase().trim();
  const b = String(slide.line2 || '').toUpperCase().trim();
  const size = Math.round(H * 0.42 * TEXT_SCALE);
  ctx2d.font = '900 ' + size + 'px ' + PRO_FONT;
  const gap = '   ';
  const sep = '  •  ';
  const parts = [[a, c1], [b ? gap + b : '', acc], [sep, '#FFFFFF']].filter((p) => p[0]);
  const widths = parts.map((p) => ctx2d.measureText(p[0]).width);
  const total = widths.reduce((x, y) => x + y, 0) || W;
  const offset = (t * 60) % total;
  ctx2d.save();
  ctx2d.globalAlpha *= clamp01(t / 0.3);
  ctx2d.textAlign = 'left';
  for (let x0 = W - offset - total * Math.ceil((W - offset) / total); x0 < W; x0 += total) {
    let x = x0;
    parts.forEach((p, i) => {
      ctx2d.fillStyle = p[1];
      ctx2d.fillText(p[0], x, H * 0.5);
      x += widths[i];
    });
  }
  ctx2d.restore();
}

function drawBrand(ctx2d, slide, t, assets) {
  const parts = String(slide.foot || TAMPA).split(/[·|]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const mark = assets.ubcMark;
  const kIn = easeOutExpo(clamp01(t / 0.75));
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
    const k = easeOutExpo(clamp01((t - 0.35 - i * 0.25) / 0.55));
    const sz = fitFont(ctx2d, txt, W - 12, sizes[i], 7, NUM_FONT);
    ctx2d.save();
    ctx2d.globalAlpha = k;
    ctx2d.fillStyle = colors[i];
    ctx2d.fillText(txt, W / 2, y + sz / 2 + Math.round((1 - k) * 8));
    ctx2d.restore();
    y += sz + 3;
  });
}

// Sign fit: margins (px) around the content. The content is scaled uniformly into the
// remaining area; backgrounds still cover the whole sign.
const MAX_MARGIN = 30;
function normFit(settings) {
  const c = (v) => Math.max(0, Math.min(MAX_MARGIN, Math.round(Number(v) || 0)));
  const L = c(settings && settings.padL);
  const R = c(settings && settings.padR);
  const T = c(settings && settings.padT);
  const B = c(settings && settings.padB);
  const aw = W - L - R;
  const ah = H - T - B;
  const sc = Math.min(aw / W, ah / H);
  return { L, R, T, B, active: L + R + T + B > 0, s: sc, ox: L + (aw - W * sc) / 2, oy: T + (ah - H * sc) / 2 };
}

function drawSlide(ctx2d, slide, t, assets, rs, fit) {
  const accent = (COLORS[slide.palette] || COLORS.blue_red_white).primary;
  const dur = slideSeconds(slide);
  let bg = slide.bg || 'black';
  if (slide.layout === 'brand' && bg === 'flood') bg = 'tint';
  let c1 = (COLORS[slide.color] || COLORS.white).primary;
  let acc = accent;
  if (bg === 'flood') {
    if (isLight(accent)) { c1 = '#000000'; acc = '#000000'; }
    else { c1 = '#FFFFFF'; acc = '#000000'; }
  }
  drawBackground(ctx2d, bg, rs, accent);
  ctx2d.save();
  if (fit && fit.active) {
    ctx2d.translate(fit.ox, fit.oy);
    ctx2d.scale(fit.s, fit.s);
  }
  TEXT_SCALE = Math.max(0.6, Math.min(1.4, (Number(slide.size) || 100) / 100));
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';
  const icon = ICON_LAYOUTS.indexOf(slide.layout || 'slam') >= 0 ? (slide.icon || 'none') : 'none';
  if (icon !== 'none') {
    const right = slide.iconSide === 'right';
    AREA = right ? { cx: (4 + W - ICON_SIZE - 8) / 2, w: W - ICON_SIZE - 14 } : { cx: (ICON_SIZE + 8 + W - 4) / 2, w: W - ICON_SIZE - 14 };
    const e = iconEntrance(icon, t);
    ctx2d.save();
    ctx2d.globalAlpha = e.a;
    ctx2d.translate((right ? W - 4 - ICON_SIZE / 2 : 4 + ICON_SIZE / 2) + (right ? -e.dx : e.dx), Math.round(H * 0.47));
    ctx2d.scale(e.s, e.s);
    drawIcon(ctx2d, icon, ICON_SIZE, t, c1, acc);
    ctx2d.restore();
  }
  if (slide.layout === 'brand') drawBrand(ctx2d, slide, t, assets);
  else if (slide.layout === 'swap') drawSwap(ctx2d, slide, t, dur, c1, acc);
  else if (slide.layout === 'rating') drawRating(ctx2d, slide, t, dur, c1, acc);
  else if (slide.layout === 'price') drawPrice(ctx2d, slide, t, dur, c1, acc);
  else if (slide.layout === 'ticker') drawTicker(ctx2d, slide, t, c1, acc);
  else drawSlam(ctx2d, slide, t, dur, c1, acc);
  AREA = FULL_AREA;
  drawDeco(ctx2d, slide.deco || 'rail', rs, bg === 'flood' ? (isLight(accent) ? '#000000' : '#FFFFFF') : accent);
  ctx2d.restore();
  TEXT_SCALE = 1;
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

// Draws the whole ad at time `sec` (loops); each slide's transition plays into the next one.
function drawFrame(ctx2d, slides, sec, assets, settings) {
  const fit = normFit(settings);
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
  const kind = cur.trans || 'fade';
  if (slides.length > 1 && kind !== 'cut' && rem > dur - TRANS_SEC) {
    const k = easeInOutCubic((rem - (dur - TRANS_SEC)) / TRANS_SEC);
    const a = buffer('a');
    const b = buffer('b');
    drawSlide(a.getContext('2d'), cur, rem, assets, sec, fit);
    drawSlide(b.getContext('2d'), slides[(idx + 1) % slides.length], 0.001, assets, sec, fit);
    ctx2d.save();
    ctx2d.fillStyle = '#000000';
    ctx2d.fillRect(0, 0, W, H);
    if (kind === 'push_left') {
      ctx2d.drawImage(a, -Math.round(k * W), 0);
      ctx2d.drawImage(b, W - Math.round(k * W), 0);
    } else if (kind === 'push_up') {
      ctx2d.drawImage(a, 0, -Math.round(k * H));
      ctx2d.drawImage(b, 0, H - Math.round(k * H));
    } else if (kind === 'zoom') {
      const sa = 1 + k * 0.8;
      ctx2d.globalAlpha = 1 - k;
      ctx2d.drawImage(a, (W - W * sa) / 2, (H - H * sa) / 2, W * sa, H * sa);
      const sb = 0.5 + 0.5 * k;
      ctx2d.globalAlpha = k;
      ctx2d.drawImage(b, (W - W * sb) / 2, (H - H * sb) / 2, W * sb, H * sb);
    } else if (kind === 'wipe') {
      const x = Math.round(k * (W + 8));
      ctx2d.drawImage(a, 0, 0);
      ctx2d.beginPath();
      ctx2d.rect(0, 0, x, H);
      ctx2d.clip();
      ctx2d.drawImage(b, 0, 0);
      ctx2d.restore();
      ctx2d.save();
      ctx2d.fillStyle = (COLORS[cur.palette] || COLORS.blue_red_white).primary;
      ctx2d.fillRect(x - 6, 0, 6, H);
    } else if (kind === 'flash') {
      ctx2d.drawImage(k < 0.5 ? a : b, 0, 0);
      ctx2d.fillStyle = 'rgba(255,255,255,' + (1 - Math.abs(k - 0.5) * 2).toFixed(3) + ')';
      ctx2d.fillRect(0, 0, W, H);
    } else {
      ctx2d.globalAlpha = 1 - k;
      ctx2d.drawImage(a, 0, 0);
      ctx2d.globalAlpha = k;
      ctx2d.drawImage(b, 0, 0);
    }
    ctx2d.restore();
    return;
  }
  drawSlide(ctx2d, cur, rem, assets, sec, fit);
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

const pick = (list) => list[Math.floor(Math.random() * list.length)][0];
function randomStyle() {
  return {
    bg: pick(BGS),
    enter: pick(ENTERS),
    motion: pick(MOTIONS),
    deco: pick(DECOS),
    trans: pick(TRANS),
    palette: pick(Object.keys(COLORS).filter((k) => k !== 'white').map((k) => [k])),
    icon: Math.random() < 0.6 ? pick(ICONS.slice(1)) : 'none',
    iconSide: Math.random() < 0.5 ? 'left' : 'right',
  };
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

  const blankSlides = () => [S('slam', 'NEW', 'MESSAGE', 'blue_red_white', 5), S('brand', '', '', 'blue_red_white', 5, TAMPA)];

  // st.cur = the template open in the editor. id === null means "not saved yet".
  const st = {
    list: [],
    readOnly: false,
    loading: true,
    cur: { id: null, name: BUILTIN[0].name, slides: cloneSlides(BUILTIN[0].slides), settings: {} },
    guides: true,
    fitScope: 'this',
    fitPick: null,
    activeIdx: 0,
    dirty: false,
    confirmDelete: false,
    confirmSwitch: null,
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

  const listHost = h('div.led-tpl-row');
  const listActions = h('div.led-tpl-row');
  const tplBar = h('div.stack-sm');
  const fitHost = h('div.stack-sm.led-fit');
  const slidesHost = h('div.led-slide-tabs');
  const editorHost = h('div.stack-sm');
  const exportBtn = h('button.btn.primary', { type: 'button' }, 'Download .AVI');
  const exportStatus = h('span.small.muted', '');
  const stateLabel = h('span.small');
  const nameInput = h('input.led-name', {
    type: 'text',
    maxlength: '60',
    placeholder: 'Template name',
    oninput: (e) => { st.cur.name = e.target.value; markDirty(); },
  });

  let rafId = null;
  let startTs = performance.now();
  const restartPreview = () => { startTs = performance.now(); };

  function drawPreviewLoop(now) {
    if (!ctx.isCurrent()) {
      if (rafId) window.cancelAnimationFrame(rafId);
      return;
    }
    drawFrame(ctx1, st.cur.slides, (now - startTs) / 1000, assets, st.cur.settings);
    ctx2.drawImage(canvas1x, 0, 0);
    const fit = normFit(st.cur.settings);
    if (st.guides && fit.active) {
      // guide only on the zoomed preview (never exported): the area the content fits into
      ctx2.save();
      ctx2.strokeStyle = 'rgba(255,0,200,0.9)';
      ctx2.lineWidth = 1;
      ctx2.setLineDash([3, 2]);
      ctx2.strokeRect(fit.L + 0.5, fit.T + 0.5, W - fit.L - fit.R - 1, H - fit.T - fit.B - 1);
      ctx2.restore();
    }
    rafId = window.requestAnimationFrame(drawPreviewLoop);
  }

  function updateStatus() {
    const sl = st.cur.slides;
    exportStatus.textContent = sl.length + ' slides · ' + totalSeconds(sl) + ' s loop · ' + W + '×' + H + ' · ' + FPS + ' fps · no audio';
  }

  function updateStateLabel() {
    let text = '✓ Saved';
    if (st.readOnly) text = 'View only: your role cannot save templates.';
    else if (st.cur.id === null) text = '● New template, not saved yet';
    else if (st.dirty) text = '● Unsaved changes';
    stateLabel.textContent = text;
    stateLabel.className = 'small ' + (!st.readOnly && (st.dirty || st.cur.id === null) ? 'led-unsaved' : 'muted');
  }

  function markDirty() {
    const first = !st.dirty;
    st.dirty = true;
    st.confirmDelete = false;
    updateStateLabel();
    if (first) renderTemplateBar();
  }

  function openTemplate(t) {
    st.cur = { id: t.id === undefined ? null : t.id, name: t.name, slides: cloneSlides(t.slides), settings: Object.assign({}, t.settings || {}) };
    st.activeIdx = 0;
    st.dirty = false;
    st.confirmDelete = false;
    st.confirmSwitch = null;
    nameInput.value = t.name;
    restartPreview();
    renderAll();
  }

  function newTemplate() {
    const keep = Object.assign({}, st.cur.settings || {});
    openTemplate({ id: null, name: 'New template', slides: blankSlides(), settings: keep });
    nameInput.focus();
    nameInput.select();
  }

  function slidePayload() {
    return st.cur.slides.map((s) => ({
      layout: s.layout || 'slam',
      line1: String(s.line1 || '').slice(0, 60),
      line2: String(s.line2 || '').slice(0, 120),
      foot: String(s.foot || '').slice(0, 80),
      palette: COLORS[s.palette] ? s.palette : 'blue_red_white',
      seconds: slideSeconds(s),
      bg: s.bg || 'black',
      enter: s.enter || 'zoom_in',
      motion: s.motion || 'none',
      deco: s.deco || 'rail',
      trans: s.trans || 'fade',
      color: COLORS[s.color] ? s.color : 'white',
      icon: s.icon || 'none',
      iconSide: s.iconSide === 'right' ? 'right' : 'left',
      size: Math.max(60, Math.min(140, Math.round(Number(s.size) || 100))),
    }));
  }

  function settingsPayload() {
    const f = normFit(st.cur.settings);
    return { padL: f.L, padR: f.R, padT: f.T, padB: f.B };
  }

  const builtinPayload = () => BUILTIN.map((t) => ({ name: t.name, since: t.since || 1, slides: cloneSlides(t.slides) }));
  const localDefaults = () => BUILTIN.map((t) => ({ id: null, name: t.name, slides: t.slides }));
  const isForbidden = (err) => err && (err.status === 403 || /cannot perform|forbidden/i.test(err.message || ''));

  // ---------- Read (the first visit copies UBC's templates into the list) ----------
  async function loadList(selectId) {
    try {
      let res = await ctx.api.ledTemplates();
      if (!res.seeded || (res.seededVersion || 1) < BUILTIN_VERSION) {
        try {
          res = await ctx.api.seedLedTemplates(builtinPayload(), false, BUILTIN_VERSION);
          if (res.added && res.seededVersion) toast('New UBC template' + (res.added === 1 ? '' : 's') + ' added (' + res.added + ')', 'ok');
          if (res.refreshed) toast('UBC templates updated to the new styles (' + res.refreshed + ')', 'ok');
        } catch (err) {
          if (!isForbidden(err)) throw err;
          st.readOnly = true;
        }
      }
      st.list = res.templates || [];
      if (st.readOnly && !st.list.length) st.list = localDefaults();
    } catch (err) {
      st.list = localDefaults();
      st.readOnly = true;
      toast('Could not load templates: ' + (err.message || err), 'bad');
    }
    st.loading = false;
    const pick = selectId ? st.list.find((t) => t.id === selectId) : null;
    if (pick) openTemplate(pick);
    else if (!st.dirty && st.list.length && (st.cur.id === null || !st.list.some((t) => t.id === st.cur.id))) openTemplate(st.list[0]);
    else renderAll();
  }

  // ---------- Create / Update ----------
  async function save(asCopy) {
    let name = (nameInput.value || '').trim();
    if (!name) {
      toast('Write a name for the template first.', 'bad');
      nameInput.focus();
      return;
    }
    const creating = asCopy || st.cur.id === null;
    if (asCopy && st.list.some((t) => t.name.toLowerCase() === name.toLowerCase())) name = (name + ' (copy)').slice(0, 60);
    try {
      const body = { name, slides: slidePayload(), settings: settingsPayload() };
      const saved = creating ? await ctx.api.createLedTemplate(body) : await ctx.api.updateLedTemplate(st.cur.id, body);
      toast((creating ? 'Created' : 'Saved') + ' "' + saved.name + '"', 'ok');
      st.dirty = false;
      await loadList(saved.id);
    } catch (err) {
      toast(err.message || 'Could not save the template', 'bad');
    }
  }

  // ---------- Delete (asks to confirm with a second click) ----------
  async function removeTemplate() {
    if (st.cur.id === null) {
      if (st.list.length) openTemplate(st.list[0]);
      else newTemplate();
      return;
    }
    if (!st.confirmDelete) {
      st.confirmDelete = true;
      renderTemplateBar();
      return;
    }
    const gone = st.cur;
    try {
      await ctx.api.deleteLedTemplate(gone.id);
      toast('Deleted template "' + gone.name + '"', 'ok');
      st.dirty = false;
      st.cur = { id: null, name: '', slides: blankSlides(), settings: {} };
      await loadList();
      if (!st.list.length) newTemplate();
    } catch (err) {
      st.confirmDelete = false;
      toast(err.message || 'Could not delete the template', 'bad');
      renderTemplateBar();
    }
  }

  async function restoreDefaults() {
    try {
      const res = await ctx.api.seedLedTemplates(builtinPayload(), true, BUILTIN_VERSION);
      toast(res.added ? 'Restored ' + res.added + ' UBC template' + (res.added === 1 ? '' : 's') : 'All UBC templates are already in the list', 'ok');
      await loadList(st.cur.id);
    } catch (err) {
      toast(err.message || 'Could not restore the templates', 'bad');
    }
  }

  // ---------- Template list ----------
  function renderList() {
    if (st.loading) {
      mount(listHost, h('span.small.muted', 'Loading templates…'));
      mount(listActions);
      return;
    }
    mount(listHost, st.list.length
      ? st.list.map((t) => {
        const on = st.cur.id !== null && t.id === st.cur.id;
        const asking = st.confirmSwitch !== null && st.confirmSwitch === t.name;
        return h('button.btn.sm', {
          type: 'button',
          class: on ? 'primary' : asking ? 'danger' : '',
          title: t.author ? 'Last saved by ' + t.author : '',
          onclick: () => {
            if (on) return;
            if (st.dirty && !asking) {
              st.confirmSwitch = t.name;
              renderList();
              toast('You have unsaved changes. Save them, or click that template again to open it without saving.', 'bad');
              return;
            }
            openTemplate(t);
          },
        }, asking ? 'Open "' + t.name + '" without saving?' : t.name);
      })
      : h('span.small.muted', 'No templates yet. Create one with "+ New template".'));
    const names = new Set(st.list.map((t) => String(t.name).toLowerCase()));
    const missing = BUILTIN.filter((t) => !names.has(t.name.toLowerCase())).length;
    mount(listActions,
      st.readOnly ? null : h('button.btn.sm.primary', { type: 'button', onclick: newTemplate }, '+ New template'),
      !st.readOnly && missing ? h('button.btn.sm', { type: 'button', onclick: restoreDefaults }, 'Restore UBC templates (' + missing + ')') : null);
  }

  // ---------- Editor header: name + Save / Save as copy / Discard / Delete ----------
  function renderTemplateBar() {
    renderList();
    nameInput.disabled = st.readOnly;
    updateStateLabel();
    const stored = st.cur.id !== null ? st.list.find((t) => t.id === st.cur.id) : null;
    mount(tplBar,
      h('label.led-field', h('span.small.muted', 'Template name'), nameInput),
      stateLabel,
      st.readOnly ? null : h('div.led-tpl-row',
        h('button.btn.sm.primary', { type: 'button', onclick: () => save(false) }, st.cur.id === null ? 'Create template' : 'Save changes'),
        st.cur.id !== null ? h('button.btn.sm', { type: 'button', onclick: () => save(true) }, 'Save as copy') : null,
        st.dirty && stored ? h('button.btn.sm', { type: 'button', onclick: () => openTemplate(stored) }, 'Discard changes') : null,
        h('button.btn.sm.danger', { type: 'button', onclick: removeTemplate },
          st.cur.id === null ? 'Cancel new template' : st.confirmDelete ? 'Yes, delete "' + st.cur.name + '"' : 'Delete template'),
        st.confirmDelete ? h('button.btn.sm', { type: 'button', onclick: () => { st.confirmDelete = false; renderTemplateBar(); } }, 'Keep it') : null));
  }

  function layoutName(layout) {
    return (LAYOUTS.find((l) => l[0] === layout) || LAYOUTS[0])[1].split(' (')[0];
  }

  function afterStructureChange() {
    restartPreview();
    markDirty();
    renderSlidesBar();
    renderSlideEditor();
    updateStatus();
  }

  function renderSlidesBar() {
    const slides = st.cur.slides;
    mount(slidesHost,
      slides.map((s, idx) => h('button.rep-tab', {
        type: 'button',
        class: idx === st.activeIdx ? 'on' : '',
        onclick: () => { st.activeIdx = idx; renderSlidesBar(); renderSlideEditor(); },
      }, (idx + 1) + '. ' + layoutName(s.layout) + ' · ' + slideSeconds(s) + 's')),
      slides.length < MAX_SLIDES ? h('button.btn.sm', {
        type: 'button',
        onclick: () => {
          slides.splice(st.activeIdx + 1, 0, S('slam', 'NEW', 'MESSAGE', 'blue_red_white', 5));
          st.activeIdx += 1;
          afterStructureChange();
        },
      }, '+ Slide') : null);
  }

  function renderSlideEditor() {
    const slides = st.cur.slides;
    if (st.activeIdx >= slides.length) st.activeIdx = slides.length - 1;
    const cur = slides[st.activeIdx];
    const layout = cur.layout || 'slam';
    const field = (label, key, placeholder, hint) => h('label.led-field',
      h('span.small.muted', label),
      h('input', { type: 'text', value: cur[key] || '', placeholder, oninput: (e) => { cur[key] = e.target.value; markDirty(); } }),
      hint ? h('span.small.muted', hint) : null);

    const layoutSel = h('select', {
      onchange: (e) => {
        cur.layout = e.target.value;
        if (cur.layout === 'brand' && !cur.foot) cur.foot = TAMPA;
        afterStructureChange();
      },
    }, LAYOUTS.map(([v, lbl]) => h('option', { value: v, selected: layout === v }, lbl)));

    const colorSel = h('select', { onchange: (e) => { cur.palette = e.target.value; markDirty(); } },
      Object.keys(COLORS).map((k) => h('option', { value: k, selected: cur.palette === k }, COLORS[k].label)));
    const textSel = h('select', { onchange: (e) => { cur.color = e.target.value; markDirty(); } },
      Object.keys(COLORS).map((k) => h('option', { value: k, selected: (cur.color || 'white') === k }, COLORS[k].label)));
    const styleSel = (label, key, list, def, replay) => h('label.led-field', h('span.small.muted', label),
      h('select', {
        onchange: (e) => {
          cur[key] = e.target.value;
          if (replay) replayHint();
          markDirty();
          if (key === 'icon') renderSlideEditor();
        },
      }, list.map(([v, lbl]) => h('option', { value: v, selected: (cur[key] || def) === v }, lbl))));
    const replayHint = () => {
      // jump the preview to the start of this slide so the new effect is visible at once
      const before = slides.slice(0, st.activeIdx).reduce((a, s) => a + slideSeconds(s), 0);
      startTs = performance.now() - before * 1000;
    };

    const secSel = h('select', {
      onchange: (e) => { cur.seconds = Number(e.target.value) || 5; afterStructureChange(); },
    }, [3, 4, 5, 6, 7, 8].map((sec) => h('option', { value: String(sec), selected: slideSeconds(cur) === sec }, sec + ' seconds')));

    const move = (dir) => {
      const j = st.activeIdx + dir;
      if (j < 0 || j >= slides.length) return;
      const tmp = slides[j];
      slides[j] = slides[st.activeIdx];
      slides[st.activeIdx] = tmp;
      st.activeIdx = j;
      afterStructureChange();
    };

    let fields;
    if (layout === 'brand') {
      fields = [field('Phone · Website', 'foot', '(813) 971-2277 · UBCBIKE.COM', 'Separate the two lines with ·')];
    } else if (layout === 'rating') {
      fields = [
        field('Rating line', 'line1', '4.8 STARS', 'The number fills the stars (4.8 = 4 full + 80%).'),
        field('Reviews line (accent color)', 'line2', '1,100+ REVIEWS'),
      ];
    } else if (layout === 'price') {
      fields = [
        field('Label (small, on top)', 'line1', 'TUNE-UPS FROM'),
        field('Price or big text (accent color)', 'line2', '$100'),
        field('Old price (crossed out, optional)', 'foot', 'WAS $1,299'),
      ];
    } else if (layout === 'ticker') {
      fields = [field('Text 1', 'line1', 'FREE SHIPPING'), field('Text 2 (accent color)', 'line2', 'ON $50+', 'Scrolls across the sign in a loop.')];
    } else if (layout === 'swap') {
      fields = [field('First line', 'line1', 'WALK IN TODAY'), field('Second line (last word underlined)', 'line2', 'READY IN 24H')];
    } else {
      fields = [
        field('Line 1 (main text color)', 'line1', 'WE FIX'),
        field('Line 2 (accent color)', 'line2', 'BIKES, E-BIKES, SCOOTERS', 'Use commas to rotate several words.'),
      ];
    }

    const surprise = () => {
      Object.assign(cur, randomStyle());
      replayHint();
      markDirty();
      renderSlideEditor();
    };

    mount(editorHost,
      h('div.led-form-grid',
        h('label.led-field', h('span.small.muted', 'Slide type'), layoutSel),
        h('label.led-field', h('span.small.muted', 'Time on screen'), secSel),
        fields),
      h('div.led-style-head',
        h('strong.small', 'Style of this slide'),
        h('div.led-tpl-row',
          h('button.btn.sm', { type: 'button', onclick: surprise }, '🎲 Surprise me'),
          h('button.btn.sm', { type: 'button', onclick: () => { replayHint(); } }, '▶ Replay slide'))),
      ICON_LAYOUTS.indexOf(layout) >= 0 ? h('div.led-form-grid',
        styleSel('Icon (vector drawing)', 'icon', ICONS, 'none', true),
        (cur.icon || 'none') !== 'none' ? styleSel('Icon side', 'iconSide', [['left', 'Left of the text'], ['right', 'Right of the text']], 'left', true) : null) : null,
      h('div.led-form-grid',
        styleSel('Background', 'bg', BGS, 'black', false),
        layout !== 'brand' && layout !== 'ticker' ? styleSel('Entrance', 'enter', ENTERS, 'zoom_in', true) : null,
        layout !== 'brand' && layout !== 'ticker' ? styleSel('Motion while on screen', 'motion', MOTIONS, 'none', false) : null,
        styleSel('Decoration', 'deco', DECOS, 'rail', false),
        styleSel('Transition to next slide', 'trans', TRANS, 'fade', false),
        layout !== 'brand' ? h('label.led-field', h('span.small.muted', 'Accent color'), colorSel) : null,
        layout !== 'brand' ? h('label.led-field', h('span.small.muted', 'Main text color'), textSel) : null,
        h('label.led-field', h('span.small.muted', 'Text size'),
          h('select', { onchange: (e) => { cur.size = Number(e.target.value) || 100; markDirty(); } },
            [70, 80, 90, 100, 110, 120, 130].map((v) => h('option', { value: String(v), selected: (Number(cur.size) || 100) === v }, v + ' %' + (v === 100 ? ' (auto fit)' : '')))))),
      h('div.led-tpl-row',
        h('button.btn.sm', { type: 'button', disabled: st.activeIdx === 0, onclick: () => move(-1) }, '← Move'),
        h('button.btn.sm', { type: 'button', disabled: st.activeIdx === slides.length - 1, onclick: () => move(1) }, 'Move →'),
        h('button.btn.sm', {
          type: 'button',
          disabled: slides.length >= MAX_SLIDES,
          onclick: () => {
            slides.splice(st.activeIdx + 1, 0, Object.assign({}, cur));
            st.activeIdx += 1;
            afterStructureChange();
          },
        }, 'Duplicate slide'),
        slides.length > 1 ? h('button.btn.sm.danger', {
          type: 'button',
          onclick: () => {
            slides.splice(st.activeIdx, 1);
            st.activeIdx = Math.max(0, st.activeIdx - 1);
            afterStructureChange();
          },
        }, 'Remove slide') : null),
      st.readOnly ? null : h('span.small.muted', 'Slide edits are stored when you press "Save changes".'));
  }

  // ---------- Sign fit (margins for the whole template) ----------
  function renderFit() {
    const f = normFit(st.cur.settings);
    const sides = [['padT', 'Top', f.T], ['padB', 'Bottom', f.B], ['padL', 'Left', f.L], ['padR', 'Right', f.R]];
    const setVal = (key, v) => {
      const next = Object.assign({}, st.cur.settings);
      next[key] = Math.max(0, Math.min(MAX_MARGIN, v));
      st.cur.settings = next;
      markDirty();
      renderFit();
    };
    mount(fitHost,
      h('div.row-between',
        h('strong.small', 'Sign fit (margins)'),
        h('label.small.muted.led-guides',
          h('input', { type: 'checkbox', checked: st.guides, onchange: (e) => { st.guides = e.target.checked; } }),
          ' Show guides')),
      h('span.small.muted', 'If the sign cuts an edge or the text looks tight, add margin on that side. The pink dashed box in the 2x preview is where the content fits.'),
      h('div.led-fit-grid',
        sides.map(([key, label, val]) => h('div.led-fit-side',
          h('span.small.muted', label),
          h('div.led-stepper',
            h('button.btn.sm', { type: 'button', disabled: st.readOnly || val <= 0, 'aria-label': label + ' margin minus', onclick: () => setVal(key, val - 1) }, '−'),
            h('span.led-fit-val', val + ' px'),
            h('button.btn.sm', { type: 'button', disabled: st.readOnly || val >= MAX_MARGIN, 'aria-label': label + ' margin plus', onclick: () => setVal(key, val + 1) }, '+'))))),
      st.readOnly ? null : h('div.led-tpl-row',
        h('button.btn.sm', { type: 'button', onclick: () => { st.cur.settings = { padL: 4, padR: 4, padT: 3, padB: 3 }; markDirty(); renderFit(); } }, 'Small margin all around'),
        h('button.btn.sm', { type: 'button', disabled: !f.active, onclick: () => { st.cur.settings = {}; markDirty(); renderFit(); } }, 'Reset to 0')),
      st.readOnly ? null : renderApplyScope(f));
  }

  // Where the margins go: this template (Save changes), all templates, or the chosen ones.
  function renderApplyScope(f) {
    const saved = st.list.filter((t) => t.id !== null && t.id !== undefined);
    const scopeSel = h('select', {
      onchange: (e) => {
        st.fitScope = e.target.value;
        if (st.fitScope === 'some' && !st.fitPick) st.fitPick = st.cur.id !== null ? [st.cur.id] : [];
        renderFit();
      },
    },
    h('option', { value: 'this', selected: st.fitScope === 'this' }, 'Only this template'),
    h('option', { value: 'all', selected: st.fitScope === 'all' }, 'All templates (' + saved.length + ')'),
    h('option', { value: 'some', selected: st.fitScope === 'some' }, 'Choose templates…'));

    let body = null;
    if (st.fitScope === 'this') {
      body = h('span.small.muted', st.cur.id === null ? 'Saved with this template when you press "Create template".' : 'Saved with this template when you press "Save changes".');
    } else if (st.fitScope === 'all') {
      body = h('button.btn.sm.primary', { type: 'button', onclick: () => applyFit(true, []) },
        'Apply ' + fitLabel(f) + ' to all ' + saved.length + ' templates');
    } else {
      const pick = st.fitPick || [];
      body = h('div.stack-sm',
        h('div.led-pick-list',
          saved.map((t) => h('label.led-pick',
            h('input', {
              type: 'checkbox',
              checked: pick.indexOf(t.id) >= 0,
              onchange: (e) => {
                const next = (st.fitPick || []).filter((x) => x !== t.id);
                if (e.target.checked) next.push(t.id);
                st.fitPick = next;
                renderFit();
              },
            }),
            ' ' + t.name))),
        h('div.led-tpl-row',
          h('button.btn.sm', { type: 'button', onclick: () => { st.fitPick = saved.map((t) => t.id); renderFit(); } }, 'Select all'),
          h('button.btn.sm', { type: 'button', onclick: () => { st.fitPick = []; renderFit(); } }, 'Select none'),
          h('button.btn.sm.primary', { type: 'button', disabled: !pick.length, onclick: () => applyFit(false, pick) },
            'Apply ' + fitLabel(f) + ' to ' + pick.length + ' template' + (pick.length === 1 ? '' : 's'))));
    }
    return h('div.stack-sm.led-apply',
      h('label.led-field', h('span.small.muted', 'Apply these margins to'), scopeSel),
      body);
  }

  function fitLabel(f) {
    return f.active ? 'T' + f.T + ' B' + f.B + ' L' + f.L + ' R' + f.R : 'no margins';
  }

  async function applyFit(all, ids) {
    const settings = settingsPayload();
    try {
      const res = await ctx.api.applyLedSettings({ all, ids, settings });
      st.list.forEach((t) => {
        if (all || ids.indexOf(t.id) >= 0) t.settings = Object.assign({}, settings);
      });
      toast('Margins applied to ' + res.updated + ' template' + (res.updated === 1 ? '' : 's'), 'ok');
      renderFit();
    } catch (err) {
      toast(err.message || 'Could not apply the margins', 'bad');
    }
  }

  function renderAll() {
    renderFit();
    renderTemplateBar();
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
      const slides = st.cur.slides;
      const total = totalSeconds(slides);
      const frames = [];
      const count = Math.round(total * FPS);
      for (let f = 0; f < count; f++) {
        drawFrame(octx, slides, f / FPS, assets, st.cur.settings);
        if (st.codec === 'rgb24') frames.push(rgbaToBgr24BottomUp(octx.getImageData(0, 0, W, H).data, W, H));
        else frames.push(await canvasToJpegBytes(off));
        if ((f + 1) % 15 === 0 || f + 1 === count) {
          exportStatus.textContent = 'Rendering frame ' + (f + 1) + ' / ' + count + '…';
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      const blob = st.codec === 'rgb24' ? encodeRgb24Avi(frames, W, H, FPS) : encodeMjpegAvi(frames, W, H, FPS);
      const fname = 'ubc-led-' + slugify(st.cur.name) + '-' + W + 'x' + H + '.avi';
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

  nameInput.value = st.cur.name;
  renderAll();
  loadList();
  fontReady.then(restartPreview);
  rafId = window.requestAnimationFrame(drawPreviewLoop);

  return h('div.stack.led-root',
    pageHead('LED Sign Studio', 'Ads for the 214×112 street sign. Open a template, edit it, save it and download the .AVI.'),
    card('1. Templates', h('div.stack-sm', listHost, listActions)),
    h('div.grid.grid-2',
      card('2. Edit template', h('div.stack-sm', tplBar, h('hr.led-sep'), slidesHost, editorHost)),
      card('3. Preview & download', h('div.stack-sm',
        h('div.led-previews',
          h('div.led-prev-box', h('span.small.muted', 'Actual size'), canvas1x),
          h('div.led-prev-box', h('span.small.muted', '2× zoom'), canvas2x)),
        fitHost,
        h('div.led-export-opts', h('label.led-field', h('span.small.muted', 'File format'), codecSel)),
        h('div.row-between', exportStatus, exportBtn)))));
}
