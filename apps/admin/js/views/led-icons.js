// Vector icons for the LED Sign Studio, drawn with canvas paths (no images), so they stay
// sharp at 214x112 and take the slide colors. Every icon is drawn in a box of `size` px
// centered on (0, 0); `t` is the time in seconds since the slide started (animations).

export const ICONS = [
  ['none', 'No icon'],
  ['bike', 'Bike'],
  ['ebike', 'E-bike'],
  ['scooter', 'Scooter'],
  ['wheel', 'Wheel'],
  ['gear', 'Chainring / gear'],
  ['wrench', 'Wrench'],
  ['tools', 'Wrench + screwdriver'],
  ['helmet', 'Helmet'],
  ['tag', 'Price tag'],
  ['percent', 'Percent'],
  ['bolt', 'Lightning bolt'],
  ['clock', 'Clock'],
  ['calendar', 'Calendar'],
  ['cart', 'Shopping cart'],
  ['gift', 'Gift'],
  ['check', 'Check mark'],
  ['pin', 'Location pin'],
  ['phone', 'Phone'],
  ['star', 'Star'],
];

const TAU = Math.PI * 2;

function line(ctx, pts, r) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * r, y * r) : ctx.moveTo(x * r, y * r)));
  ctx.stroke();
}

function circle(ctx, x, y, rad, r, fill) {
  ctx.beginPath();
  ctx.arc(x * r, y * r, rad * r, 0, TAU);
  if (fill) ctx.fill();
  else ctx.stroke();
}

function spokes(ctx, x, y, rad, r, n, angle) {
  for (let i = 0; i < n; i++) {
    const a = angle + (i * Math.PI) / n;
    line(ctx, [[x + Math.cos(a) * rad, y + Math.sin(a) * rad], [x - Math.cos(a) * rad, y - Math.sin(a) * rad]], r);
  }
}

function wheel(ctx, x, y, rad, r, spin, accent) {
  circle(ctx, x, y, rad, r);
  ctx.save();
  ctx.lineWidth = Math.max(1, ctx.lineWidth * 0.5);
  ctx.strokeStyle = accent;
  spokes(ctx, x, y, rad * 0.85, r, 3, spin);
  ctx.restore();
}

function bike(ctx, r, t, main, accent) {
  const spin = t * 7;
  wheel(ctx, -0.56, 0.3, 0.36, r, spin, accent);
  wheel(ctx, 0.56, 0.3, 0.36, r, spin, accent);
  ctx.strokeStyle = main;
  line(ctx, [[-0.56, 0.3], [-0.02, 0.3], [-0.2, -0.28], [-0.56, 0.3]], r); // rear triangle
  line(ctx, [[-0.2, -0.28], [0.38, -0.28], [-0.02, 0.3]], r); // top tube + down tube
  line(ctx, [[0.38, -0.28], [0.56, 0.3]], r); // fork
  line(ctx, [[-0.33, -0.42], [-0.08, -0.42]], r); // saddle
  line(ctx, [[-0.2, -0.28], [-0.2, -0.42]], r);
  line(ctx, [[0.38, -0.28], [0.36, -0.46], [0.54, -0.5]], r); // stem + bar
  ctx.save();
  ctx.fillStyle = accent;
  circle(ctx, -0.02, 0.3, 0.09, r, true); // chainring
  ctx.restore();
}

function bolt(ctx, r, x, y, s) {
  ctx.beginPath();
  const p = [[0.15, -1], [-0.55, 0.12], [-0.05, 0.12], [-0.2, 1], [0.55, -0.15], [0.05, -0.15]];
  p.forEach(([px, py], i) => {
    const X = (x + px * s) * r;
    const Y = (y + py * s) * r;
    if (i) ctx.lineTo(X, Y);
    else ctx.moveTo(X, Y);
  });
  ctx.closePath();
  ctx.fill();
}

export function drawIcon(ctx, name, size, t, main, accent) {
  if (!name || name === 'none') return;
  const r = size / 2;
  ctx.save();
  ctx.lineWidth = Math.max(2, size / 14);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = main;
  ctx.fillStyle = main;

  if (name === 'bike' || name === 'ebike') {
    ctx.translate(0, Math.sin(t * 9) * 0.6);
    bike(ctx, r, t, main, accent);
    if (name === 'ebike') {
      ctx.fillStyle = accent;
      bolt(ctx, r, 0.1, -0.78, 0.28);
    }
  } else if (name === 'scooter') {
    const spin = t * 7;
    ctx.translate(0, Math.sin(t * 9) * 0.6);
    line(ctx, [[-0.62, 0.4], [0.32, 0.4], [0.2, -0.62]], r);
    line(ctx, [[0.02, -0.62], [0.36, -0.62]], r);
    wheel(ctx, -0.58, 0.55, 0.2, r, spin, accent);
    wheel(ctx, 0.48, 0.55, 0.2, r, spin, accent);
  } else if (name === 'wheel') {
    const spin = t * 3;
    circle(ctx, 0, 0, 0.9, r);
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(1, ctx.lineWidth * 0.5);
    spokes(ctx, 0, 0, 0.74, r, 6, spin);
    circle(ctx, 0, 0, 0.74, r);
    ctx.restore();
    circle(ctx, 0, 0, 0.13, r, true);
  } else if (name === 'gear') {
    ctx.rotate(t * 1.6);
    ctx.beginPath();
    const teeth = 12;
    for (let i = 0; i < teeth * 2; i++) {
      const a = (i * Math.PI) / teeth;
      const rad = (i % 2 === 0 ? 0.92 : 0.72) * r;
      ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = accent;
    circle(ctx, 0, 0, 0.42, r);
    for (let i = 0; i < 5; i++) {
      const a = (i * TAU) / 5;
      line(ctx, [[Math.cos(a) * 0.15, Math.sin(a) * 0.15], [Math.cos(a) * 0.42, Math.sin(a) * 0.42]], r);
    }
  } else if (name === 'wrench' || name === 'tools') {
    ctx.save();
    ctx.rotate(-Math.PI / 4 + Math.sin(t * 5) * 0.12);
    // solid wrench: handle + round head with an open jaw at the top
    ctx.lineWidth = r * 0.26;
    line(ctx, [[0, 0.8], [0, -0.4]], r);
    ctx.beginPath();
    ctx.arc(0, -0.56 * r, 0.38 * r, -Math.PI / 3, (4 * Math.PI) / 3);
    ctx.lineTo(-0.11 * r, -0.62 * r);
    ctx.lineTo(0.11 * r, -0.62 * r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (name === 'tools') {
      ctx.save();
      ctx.rotate(Math.PI / 4 - Math.sin(t * 5) * 0.12);
      ctx.strokeStyle = accent;
      ctx.lineWidth = r * 0.26;
      line(ctx, [[0, 0.85], [0, 0.25]], r); // handle
      ctx.lineWidth = r * 0.1;
      line(ctx, [[0, 0.25], [0, -0.75]], r); // shaft
      ctx.restore();
    }
  } else if (name === 'helmet') {
    ctx.beginPath();
    ctx.arc(0, 0.2 * r, 0.82 * r, Math.PI, 0);
    ctx.closePath();
    ctx.stroke();
    line(ctx, [[-0.95, 0.2], [0.95, 0.2], [0.75, 0.42]], r);
    ctx.strokeStyle = accent;
    line(ctx, [[-0.35, -0.5], [-0.15, -0.05]], r);
    line(ctx, [[0.05, -0.6], [0.12, -0.05]], r);
    line(ctx, [[0.42, -0.45], [0.35, -0.05]], r);
  } else if (name === 'tag') {
    ctx.rotate(-0.35 + Math.sin(t * 3) * 0.08);
    ctx.beginPath();
    [[-0.85, -0.45], [0.35, -0.45], [0.85, 0], [0.35, 0.45], [-0.85, 0.45]].forEach(([x, y], i) => (i ? ctx.lineTo(x * r, y * r) : ctx.moveTo(x * r, y * r)));
    ctx.closePath();
    ctx.stroke();
    circle(ctx, 0.42, 0, 0.1, r, true);
    ctx.fillStyle = accent;
    ctx.font = '900 ' + Math.round(size * 0.52) + 'px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', -0.25 * r, 0.04 * r);
  } else if (name === 'percent') {
    circle(ctx, -0.45, -0.45, 0.24, r);
    circle(ctx, 0.45, 0.45, 0.24, r);
    ctx.strokeStyle = accent;
    line(ctx, [[0.6, -0.75], [-0.6, 0.75]], r);
  } else if (name === 'bolt') {
    ctx.fillStyle = accent;
    const k = 0.9 + 0.1 * Math.sin(t * 8);
    bolt(ctx, r, 0, 0, 0.95 * k);
  } else if (name === 'clock') {
    circle(ctx, 0, 0, 0.88, r);
    ctx.strokeStyle = accent;
    const m = t * 2.2;
    line(ctx, [[0, 0], [Math.sin(m) * 0.66, -Math.cos(m) * 0.66]], r);
    line(ctx, [[0, 0], [Math.sin(m / 12) * 0.42, -Math.cos(m / 12) * 0.42]], r);
    circle(ctx, 0, 0, 0.08, r, true);
  } else if (name === 'calendar') {
    ctx.strokeRect(-0.85 * r, -0.62 * r, 1.7 * r, 1.45 * r);
    ctx.fillStyle = accent;
    ctx.fillRect(-0.85 * r, -0.62 * r, 1.7 * r, 0.36 * r);
    line(ctx, [[-0.45, -0.85], [-0.45, -0.5]], r);
    line(ctx, [[0.45, -0.85], [0.45, -0.5]], r);
    ctx.fillStyle = main;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) circle(ctx, -0.45 + col * 0.45, 0.1 + row * 0.38, 0.08, r, true);
    }
  } else if (name === 'cart') {
    ctx.translate(Math.sin(t * 6) * 0.8, 0);
    line(ctx, [[-0.95, -0.7], [-0.62, -0.7], [-0.35, 0.35], [0.65, 0.35], [0.85, -0.42], [-0.52, -0.42]], r);
    ctx.fillStyle = accent;
    circle(ctx, -0.25, 0.68, 0.13, r, true);
    circle(ctx, 0.55, 0.68, 0.13, r, true);
  } else if (name === 'gift') {
    ctx.strokeRect(-0.78 * r, -0.25 * r, 1.56 * r, 1.05 * r);
    ctx.strokeRect(-0.88 * r, -0.5 * r, 1.76 * r, 0.25 * r);
    ctx.strokeStyle = accent;
    line(ctx, [[0, -0.5], [0, 0.8]], r);
    const b = 1 + 0.12 * Math.sin(t * 6);
    ctx.beginPath();
    ctx.ellipse(-0.28 * r, -0.68 * r, 0.26 * r * b, 0.16 * r, -0.4, 0, TAU);
    ctx.ellipse(0.28 * r, -0.68 * r, 0.26 * r * b, 0.16 * r, 0.4, 0, TAU);
    ctx.stroke();
  } else if (name === 'check') {
    circle(ctx, 0, 0, 0.88, r);
    ctx.strokeStyle = accent;
    const p = Math.min(1, t / 0.6);
    const pts = [[-0.45, 0.02], [-0.12, 0.35], [0.5, -0.35]];
    const segs = p < 0.4 ? [pts[0], [pts[0][0] + (pts[1][0] - pts[0][0]) * (p / 0.4), pts[0][1] + (pts[1][1] - pts[0][1]) * (p / 0.4)]]
      : [pts[0], pts[1], [pts[1][0] + (pts[2][0] - pts[1][0]) * ((p - 0.4) / 0.6), pts[1][1] + (pts[2][1] - pts[1][1]) * ((p - 0.4) / 0.6)]];
    ctx.lineWidth *= 1.3;
    line(ctx, segs, r);
  } else if (name === 'pin') {
    ctx.translate(0, -Math.abs(Math.sin(t * 4)) * 2);
    ctx.beginPath();
    ctx.arc(0, -0.28 * r, 0.56 * r, Math.PI * 0.82, Math.PI * 2.18);
    ctx.lineTo(0, 0.92 * r);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = accent;
    circle(ctx, 0, -0.28, 0.2, r, true);
  } else if (name === 'phone') {
    ctx.rotate(Math.sin(t * 20) * (Math.floor(t * 1.2) % 2 === 0 ? 0.12 : 0));
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-0.48 * r, -0.9 * r, 0.96 * r, 1.8 * r, 0.16 * r);
    else ctx.rect(-0.48 * r, -0.9 * r, 0.96 * r, 1.8 * r);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillRect(-0.3 * r, -0.66 * r, 0.6 * r, 1.1 * r);
    ctx.fillStyle = main;
    circle(ctx, 0, 0.7, 0.08, r, true);
  } else if (name === 'star') {
    ctx.rotate(Math.sin(t * 2) * 0.15);
    ctx.fillStyle = accent;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = (i % 2 === 0 ? 0.95 : 0.42) * r;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// Entrance for the icon box (matches the slide timing): wheels roll in, others pop.
export function iconEntrance(name, t) {
  const c = Math.max(0, Math.min(1, t / 0.55));
  if (name === 'bike' || name === 'ebike' || name === 'scooter' || name === 'cart') {
    const e = 1 - Math.pow(1 - c, 3);
    return { dx: -(1 - e) * 90, s: 1, a: Math.min(1, c * 3) };
  }
  const k = Math.max(0, Math.min(1, (t - 0.1) / 0.45));
  const back = 1 + 2.70158 * Math.pow(k - 1, 3) + 1.70158 * Math.pow(k - 1, 2);
  return { dx: 0, s: Math.max(0.01, back), a: Math.min(1, k * 3) };
}
