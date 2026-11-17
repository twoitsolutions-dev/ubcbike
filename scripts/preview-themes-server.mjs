// Local Interactive Preview Server for BOTH UBC Shopify Dawn 16.1.1 Themes:
//   - http://localhost:5179/          -> Side-by-side switcher + ZIP upload instructions
//   - http://localhost:5179/boutique  -> Live render of `apps/dawn-ubc-theme` (v11 Boutique Pinterest)
//   - http://localhost:5179/fable     -> Live render of `apps/dawn-ubc-fable-theme` (v12 Fable UBC Tampa)
// Renders real theme CSS/JS/assets + live UBC Commerce Hub sandbox catalog (`ubc.*` metafields).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const PORT = Number(process.env.PREVIEW_PORT || 5179);
const root = process.cwd();
const dirBoutique = resolve(root, 'apps/dawn-ubc-theme');
const dirFable = resolve(root, 'apps/dawn-ubc-fable-theme');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
};

const LIVE_PRODUCTS = [
  {
    handle: 'specialized-tarmac-sl7-sport-56cm',
    title: 'Specialized Tarmac SL7 Sport — 56cm',
    vendor: 'Specialized',
    description: 'FACT 9r carbon aero frame with Shimano 105 12-speed mechanical drivetrain and hydraulic flat-mount disc brakes. Assembled and fitted by UBC mechanics in Tampa.',
    priceCents: 279999,
    compareAtCents: 320000,
    sku: 'UBC-TARMAC-SL7-56',
    variantId: 49001,
    availability: 'in_stock',
    leadDays: 0,
    pickupOnly: true,
    imgBoutique: '/assets/boutique/ubc-bike-tarmac-sl9.webp',
    imgFable: '/assets/fable/fable-bike-tarmac.png',
    ride: 'road',
  },
  {
    handle: 'surly-midnight-special-frame-54cm',
    title: 'Surly Midnight Special Frame — 54cm',
    vendor: 'Surly',
    description: '4130 CroMoly steel all-road endurance frameset with 44mm headtube, flat-mount disc mounts, and 650b x 60mm / 700c x 42mm tire clearance.',
    priceCents: 89999,
    compareAtCents: 0,
    sku: 'UBC-SURLY-MS-54',
    variantId: 49002,
    availability: 'special_order',
    leadDays: 4,
    pickupOnly: false,
    imgBoutique: '/assets/boutique/ubc-bike-diverge.webp',
    imgFable: '/assets/fable/ubc-bike-diverge.png',
    ride: 'road',
  },
  {
    handle: 'continental-grand-prix-5000-700x28c-tire',
    title: 'Continental Grand Prix 5000 — 700x28c',
    vendor: 'Continental',
    description: 'BlackChili compound benchmark road clincher tire with VectranBreaker puncture protection and Lazer Grip shoulder micro-profile.',
    priceCents: 7999,
    compareAtCents: 9499,
    sku: 'UBC-CONTI-GP5K-28',
    variantId: 49003,
    availability: 'in_stock',
    leadDays: 0,
    pickupOnly: false,
    imgBoutique: '/assets/boutique/ubc-part-tires.webp',
    imgFable: '/assets/fable/ubc-part-tires.png',
    ride: 'gear',
  },
  {
    handle: 'bell-z20-mips-road-helmet-medium',
    title: 'Bell Z20 MIPS Road Helmet — Medium',
    vendor: 'Bell',
    description: 'Progressive layering dual-density EPS foam with integrated MIPS rotational impact management and Float Fit Race retention.',
    priceCents: 18999,
    compareAtCents: 22999,
    sku: 'UBC-BELL-Z20-M',
    variantId: 49004,
    availability: 'in_stock',
    leadDays: 0,
    pickupOnly: false,
    imgBoutique: '/assets/boutique/ubc-part-cockpit.webp',
    imgFable: '/assets/fable/fable-gear-agilis.png',
    ride: 'gear',
  },
];

function moneyFmt(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderUbcBadge(p, detailed = false) {
  const pills = [];
  if (p.availability === 'in_stock') {
    pills.push('<span class="availability availability--in_stock">In Stock &middot; Tampa Showroom</span>');
  } else if (p.availability === 'special_order') {
    pills.push(`<span class="availability availability--special_order">Special Order &middot; ${p.leadDays || 4}–5 Days</span>`);
  } else {
    pills.push('<span class="availability availability--unavailable">Unavailable</span>');
  }
  if (p.pickupOnly) {
    pills.push('<span class="availability availability--pickup">In-Store Pickup Only &middot; Tampa</span>');
  }
  let extra = '';
  if (detailed && p.pickupOnly) {
    extra = '<p class="ubc-pickup-callout"><strong>Certified Mechanic Rider Fit Included:</strong> Pick up ready-to-ride at 1218 E Fletcher Ave, Tampa, FL.</p>';
  }
  return `<div class="ubc-availability-group"><div class="ubc-availability-pills">${pills.join('')}</div>${extra}</div>`;
}

function topPreviewBar(active) {
  const zipHref =
    active === 'black_friday'
      ? '/download/ubc-fable-dawn-v24-black-friday.zip'
      : active === 'christmas'
        ? '/download/ubc-fable-dawn-v24-christmas.zip'
        : active === 'july_4'
          ? '/download/ubc-fable-dawn-v24-july-4.zip'
          : '/download/ubc-fable-dawn-v24.zip';
  const zipLbl =
    active === 'black_friday'
      ? 'ZIP Black Friday'
      : active === 'christmas'
        ? 'ZIP Navidad'
        : active === 'july_4'
          ? 'ZIP July 4th'
          : 'ZIP Classic';
  return `
  <div id="ubcPreviewTopBar" style="position:sticky;top:0;z-index:9999;background:#14202d;color:#fefdf3;padding:7px 12px;display:flex;align-items:center;justify-content:space-between;gap:6px 12px;flex-wrap:wrap;font:600 12px/1.3 system-ui,-apple-system,sans-serif;border-bottom:1px solid rgba(254,253,243,0.14);max-width:100%;overflow-x:clip;">
    <div style="display:flex;align-items:center;gap:8px;min-width:0;">
      <a href="/" style="background:#ccbb8d;color:#14202d;padding:3px 9px;border-radius:999px;font-weight:700;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;text-decoration:none;">Dawn 16.1.1 &middot; v24</a>
      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Temas Auto-Activables en Shopify (OS 2.0) + Paletas Completas por Ocasión</span>
    </div>
    <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
      <a href="/fable" style="padding:4px 10px;border-radius:999px;text-decoration:none;font-weight:600;white-space:nowrap;${active === 'classic' || active === 'fable' ? 'background:#e04f33;color:#fff;' : 'background:rgba(255,255,255,0.1);color:#fefdf3;'}">Classic</a>
      <a href="/black-friday" style="padding:4px 10px;border-radius:999px;text-decoration:none;font-weight:600;white-space:nowrap;${active === 'black_friday' ? 'background:#ff4d29;color:#fff;' : 'background:rgba(255,255,255,0.1);color:#fefdf3;'}">Black Friday</a>
      <a href="/christmas" style="padding:4px 10px;border-radius:999px;text-decoration:none;font-weight:600;white-space:nowrap;${active === 'christmas' ? 'background:#143828;border:1px solid #dfc47e;color:#fff;' : 'background:rgba(255,255,255,0.1);color:#fefdf3;'}">Navidad</a>
      <a href="/july-4" style="padding:4px 10px;border-radius:999px;text-decoration:none;font-weight:600;white-space:nowrap;${active === 'july_4' ? 'background:#173766;border:1px solid #e5c878;color:#fff;' : 'background:rgba(255,255,255,0.1);color:#fefdf3;'}">4 de Julio</a>
      <a href="/our-story" style="padding:4px 10px;border-radius:999px;text-decoration:none;font-weight:600;white-space:nowrap;${active === 'our_story' ? 'background:#e04f33;color:#fff;' : 'background:rgba(255,255,255,0.1);color:#fefdf3;'}">Historia + 8 Reels</a>
      <a href="/locations" style="padding:4px 10px;border-radius:999px;text-decoration:none;font-weight:600;white-space:nowrap;${active === 'locations' ? 'background:#e04f33;color:#fff;' : 'background:rgba(255,255,255,0.1);color:#fefdf3;'}">Locations</a>
      <a href="${zipHref}" style="padding:4px 10px;border-radius:999px;text-decoration:none;background:#ccbb8d;color:#14202d;font-weight:700;white-space:nowrap;">${zipLbl}</a>
    </div>
  </div>`;
}

function renderBoutiquePage() {
  const heroSlides = [
    { p: LIVE_PRODUCTS[0], wm1: 'RIDE FOR', wm2: 'PASSION', ghost: 'TARMAC', kicker: 'University Bicycle Center · Tampa, FL · Est. 1972', light: 'THE SPECIALIZED', bold: 'TARMAC SL7', acc: '56', sub1: 'FACT 9R CARBON ·', sub2: 'AERO RACE GEOMETRY', tag: 'Road Bikes', s1: '#18222d', s2: '#e84c3d', img: '/assets/boutique/ubc-bike-tarmac-sl9.webp', pins: [[68, 24, 'Aero Carbon Cockpit · Clean Internal Routing'], [44, 66, 'Shimano 105 12-Speed Mechanical Drivetrain'], [79, 64, 'Hydraulic Flat-Mount Disc Calipers']] },
    { p: LIVE_PRODUCTS[1], wm1: 'ALL ROAD', wm2: 'FREEDOM', ghost: 'GRAVEL', kicker: 'Special Order · Direct Distributor Dispatch', light: 'SURLY & ALL-ROAD', bold: 'MIDNIGHT SPECIAL', acc: '54', sub1: '4130 CHROMOLY & CARBON ·', sub2: 'MIXED-TERRAIN ENDURANCE', tag: 'Gravel Bikes', s1: '#213549', s2: '#ccbb8d', img: '/assets/boutique/ubc-bike-diverge.webp', pins: [[69, 28, '44mm Headtube · Tapered Fork Clearance'], [43, 67, 'Wide-Range Gravel Drivetrain Compatibility'], [80, 63, '650b x 60mm / 700c x 42mm Tire Clearance']] },
    { p: null, price: '$3,499.99', wm1: 'SUPER', wm2: 'LIGHT', ghost: 'TURBO', kicker: 'Tampa Bay E-Commute & Fitness', light: 'THE SPECIALIZED', bold: 'TURBO VADO SL', acc: '2.0', sub1: 'SUPERLIGHT ASSIST ·', sub2: '2X RIDER AMPLIFICATION', tag: 'E-Bikes', s1: '#0f172a', s2: '#ff6b4a', img: '/assets/boutique/ubc-bike-turbo-vado-sl.webp', pins: [[67, 21, 'MasterMind TCD Display & Cockpit'], [46, 69, 'Whisper-Quiet Mid-Drive SL Motor'], [81, 65, 'All-Weather Hydraulic Disc Stopping']] },
    { p: null, price: '$4,799.99', wm1: 'SINGLE', wm2: 'TRACK', ghost: 'EPIC', kicker: 'Florida XC & Singletrack Performance', light: 'THE SPECIALIZED', bold: 'EPIC 9', acc: 'EVO', sub1: '120MM PROGRESSIVE XC ·', sub2: 'FLIGHT ATTENDANT READY', tag: 'XC Trail', s1: '#1e293b', s2: '#e84c3d', img: '/assets/boutique/ubc-bike-epic-9.webp', pins: [[52, 38, 'Progressive 120mm Suspension Kinematics'], [24, 68, 'SRAM Eagle T-Type Transmission'], [81, 64, '4-Piston Trail Hydraulic Brakes']] },
  ];

  const slidesHtml = heroSlides.map((s, idx) => `
    <div class="ub-hero__grid${idx === 0 ? ' is-active' : ''}" data-ub-slide ${idx === 0 ? '' : 'hidden'}>
      <div class="ub-hero__rail" role="tablist">
        ${heroSlides.map((_, j) => `<button type="button" class="ub-rail-btn" data-ub-go="${j}" ${j === idx ? 'aria-current="true"' : ''}>0${j + 1}</button>`).join('')}
      </div>
      <div class="ub-hero__stage">
        <div class="ub-hero__watermark" aria-hidden="true"><span>${s.wm1}</span><span>${s.wm2}</span></div>
        <div class="ub-hero__halo" aria-hidden="true"></div>
        <div class="ub-hero__bike-wrap">
          <img src="${s.img}" class="ub-hero__bike-img" width="1300" height="820" alt="${s.bold}">
          ${s.pins.map(([x, y, lbl]) => `<button type="button" class="ub-hero__pin" style="left:${x}%;top:${y}%;" aria-label="${lbl}"><span class="ub-hero__pin-tip">${lbl}</span></button>`).join('')}
          <span class="ub-hero__wheel-tag">${s.tag}</span>
        </div>
      </div>
      <div class="ub-hero__copy">
        <span class="ub-hero__ghost-v" aria-hidden="true">${s.ghost}</span>
        <p class="ub-hero__kicker">${s.kicker}</p>
        <h2 class="ub-hero__title">${s.light} <strong>${s.bold} <em>${s.acc}</em></strong></h2>
        <p class="ub-hero__sub">${s.sub1} <strong>${s.sub2}</strong></p>
        <div class="ub-hero__price-row">
          <p class="ub-hero__price">${s.p ? moneyFmt(s.p.priceCents) : s.price}</p>
          ${s.p ? renderUbcBadge(s.p) : '<span class="availability availability--in_stock">Tampa Showroom &middot; Ready to Fit</span>'}
        </div>
        <div class="ub-hero__cta-row">
          <a href="#shop" class="ub-plus-cta"><span class="ub-plus-cta__circle">+</span><span>DISCOVER</span></a>
          <div class="ub-swatches"><span class="ub-swatches__label">Finish</span><span class="ub-swatch" style="background:${s.s1}"></span><span class="ub-swatch" style="background:${s.s2}"></span></div>
        </div>
      </div>
    </div>`).join('');

  const thumbsHtml = heroSlides.map((s, idx) => `
    <button type="button" class="ub-hero-thumb" data-ub-go="${idx}" ${idx === 0 ? 'aria-current="true"' : ''}><img src="${s.img}" width="260" height="164" alt="${s.bold}"></button>
  `).join('');

  const techParts = [
    { k: 'Genuine Parts & E-Drive Lab', t: 'SPARE PARTS FOR YOUR BIKE', d: 'Direct catalog integration with QBP, J&B Importers, and Specialized USA. Stocked in our Tampa showroom or ordered on demand in 3–5 business days.', img: '/assets/boutique/ubc-part-motor.webp' },
    { k: 'Precision Shifting & Cassettes', t: 'DRIVETRAIN & GROUPSETS', d: 'Shimano 105, Ultegra Di2, CUES, and SRAM Eagle drivetrains indexed and torque-checked by UBC master mechanics.', img: '/assets/boutique/ubc-part-drivetrain.webp' },
    { k: 'Stopping Power & Rotors', t: 'HYDRAULIC DISC BRAKE SYSTEMS', d: '4-piston calipers, Centerlock rotors, and sintered or organic pad compounds bled in-house for Florida wet-weather modulation.', img: '/assets/boutique/ubc-part-brakes.webp' },
  ];

  const stageBikes = [
    { name: 'TARMAC SL9', img: '/assets/boutique/ubc-bike-tarmac-sl9.webp', nextImg: '/assets/boutique/ubc-bike-diverge.webp', peek: 'D' },
    { name: 'DIVERGE STR', img: '/assets/boutique/ubc-bike-diverge.webp', nextImg: '/assets/boutique/ubc-bike-turbo-vado-evo.webp', peek: 'V' },
    { name: 'VADO EVO', img: '/assets/boutique/ubc-bike-turbo-vado-evo.webp', nextImg: '/assets/boutique/ubc-bike-epic-9.webp', peek: 'E' },
    { name: 'EPIC 9 EVO', img: '/assets/boutique/ubc-bike-epic-9.webp', nextImg: '/assets/boutique/ubc-bike-tarmac-sl9.webp', peek: 'T' },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>UBC Boutique Dawn v11 — Local Preview</title>
  <style>
    html { font-size: 62.5%; box-sizing: border-box; scroll-behavior: smooth; }
    *, *::before, *::after { box-sizing: inherit; }
    body { margin: 0; font-size: 1.6rem; }
    .visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    @font-face { font-family: 'Archivo'; font-style: normal; font-weight: 100 900; font-display: swap; src: url('/assets/boutique/ubc-archivo-latin.woff2') format('woff2'); }
  </style>
  <link rel="stylesheet" href="/assets/boutique/base.css">
  <link rel="stylesheet" href="/assets/boutique/ubc-brand.css">
  <link rel="stylesheet" href="/assets/boutique/ubc-sections.css">
  <link rel="stylesheet" href="/assets/boutique/ubc-boutique.css">
</head>
<body>
  ${topPreviewBar('boutique')}
  <div style="background:#14202d;color:#fefdf3;text-align:center;padding:9px 16px;font-size:1.15rem;letter-spacing:0.14em;font-weight:700;">
    UNIVERSITY BICYCLE CENTER &middot; TAMPA, FL &middot; FREE IN-STORE PICKUP &amp; CERTIFIED MECHANIC FITTING SINCE 1972
  </div>
  <header class="header-wrapper" style="padding:16px 28px;display:flex;align-items:center;justify-content:space-between;max-width:100%;">
    <nav style="display:flex;gap:24px;font-size:1.22rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">
      <a href="#shop" style="color:inherit;text-decoration:none;">Bikes</a>
      <a href="#parts" style="color:inherit;text-decoration:none;">Components</a>
      <a href="#stage" style="color:inherit;text-decoration:none;">Showroom</a>
    </nav>
    <a href="/boutique"><img src="/assets/boutique/ubc-logo-navy.png" width="165" height="34" alt="University Bicycle Center" class="ubc-logo-img"></a>
    <div style="display:flex;align-items:center;gap:16px;font-size:1.22rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;">
      <span id="preview-bag-toast" style="color:#e84c3d;">Bag (<span id="preview-bag-count">0</span>)</span>
    </div>
  </header>

  <main>
    <section class="ub-hero" data-ub-hero>
      <div class="ub-dots ub-hero__dots-top" aria-hidden="true"></div>
      <div class="ub-shell">
        ${slidesHtml}
        <div class="ub-hero__bottom">
          <div class="ub-scroll-cue"><span class="ub-scroll-cue__mouse"></span><span>Scroll</span></div>
          <div class="ub-hero__thumbs">
            <button type="button" class="ub-round-arrow" data-ub-prev>&lsaquo;</button>
            ${thumbsHtml}
            <button type="button" class="ub-round-arrow" data-ub-next>&rsaquo;</button>
          </div>
        </div>
      </div>
    </section>

    <section class="ub-tech" id="parts" data-ub-tech>
      <span class="ub-tech__watermark" aria-hidden="true">COMPONENTS</span>
      <div class="ub-shell">
        ${techParts.map((tp, i) => `
          <div class="ub-tech__grid${i === 0 ? ' is-active' : ''}" data-ub-slide ${i === 0 ? '' : 'hidden'}>
            <div>
              <p class="ub-tech__kicker">${tp.k}</p>
              <h2 class="ub-tech__title">${tp.t}</h2>
              <p class="ub-tech__desc">${tp.d}</p>
              <a href="#shop" class="ub-pill-btn"><span>SEE MORE</span><span>+</span></a>
            </div>
            <div>
              <div class="ub-tech__visual">
                <button type="button" class="ub-round-arrow" data-ub-prev>&lsaquo;</button>
                <div class="ub-tech__halo"></div>
                <img src="${tp.img}" class="ub-tech__img" width="760" height="540" alt="${tp.t}">
                <button type="button" class="ub-round-arrow" data-ub-next>&rsaquo;</button>
              </div>
              <div class="ub-tech__dots">
                ${techParts.map((_, j) => `<button type="button" class="ub-tech__dot" data-ub-go="${j}" ${j === i ? 'aria-current="true"' : ''}></button>`).join('')}
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </section>

    <section class="ub-shop-spot" id="shop" data-ub-spotlight>
      <div class="ub-shell">
        <div class="ub-tab-head"><h2 class="ub-tab-head__title">SHOP</h2></div>
        ${LIVE_PRODUCTS.map((p, i) => `
          <div class="ub-shop-spot__row${i === 0 ? ' is-active' : ''}" data-ub-slide ${i === 0 ? '' : 'hidden'}>
            <div class="ub-shop-spot__media">
              <span class="ub-shop-spot__ghost" aria-hidden="true">${p.vendor.toUpperCase()}</span>
              <img src="${p.imgBoutique}" width="1100" height="720" alt="${p.title}">
            </div>
            <div>
              <div class="ub-shop-spot__head">
                <button type="button" class="ub-round-arrow" data-ub-prev>&lsaquo;</button>
                <h3 class="ub-shop-spot__name">${p.title}</h3>
                <button type="button" class="ub-round-arrow" data-ub-next>&rsaquo;</button>
              </div>
              <p class="ub-shop-spot__spec">${p.description}</p>
              <p class="ub-shop-spot__price">${moneyFmt(p.priceCents)}</p>
              ${renderUbcBadge(p, true)}
              <div class="ub-shop-spot__buy">
                <button type="button" class="ub-circle-bag" onclick="window.__addPreviewBag('${p.title.replace(/'/g, '')}')">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
                </button>
                <span class="ub-shop-spot__add-label">Add to Bag &middot; SKU ${p.sku}</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </section>

    <section class="ub-promos">
      <div class="ub-shell">
        <div class="ub-tab-head"><h2 class="ub-tab-head__title">PROMOTIONS &amp; IN-STORE LINEUP</h2></div>
        <div class="ub-promos__grid">
          ${LIVE_PRODUCTS.map((p) => {
            const pct = p.compareAtCents > p.priceCents ? Math.round(((p.compareAtCents - p.priceCents) * 100) / p.compareAtCents) : 0;
            return `
            <article class="ub-pcard">
              ${pct > 0 ? `<span class="ub-pcard__discount">-${pct}%</span>` : ''}
              <div>
                <div class="ub-pcard__media"><img src="${p.imgBoutique}" width="520" height="340" alt="${p.title}"></div>
                <div class="ub-pcard__mid">
                  <div>
                    <h3 class="ub-pcard__title">${p.title}</h3>
                    <p class="ub-pcard__vendor">${p.vendor} &middot; ${p.sku}</p>
                  </div>
                  <button type="button" class="ub-circle-bag" onclick="window.__addPreviewBag('${p.title.replace(/'/g, '')}')">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
                  </button>
                </div>
              </div>
              <div class="ub-pcard__foot">
                <div class="ub-pcard__price-row">
                  <span class="ub-pcard__price">${moneyFmt(p.priceCents)}</span>
                  ${pct > 0 ? `<s class="ub-pcard__compare">${moneyFmt(p.compareAtCents)}</s>` : ''}
                </div>
                ${renderUbcBadge(p)}
              </div>
            </article>`;
          }).join('')}
        </div>
      </div>
    </section>

    <section class="ub-argon" id="stage" data-ub-argon>
      ${stageBikes.map((sb, i) => `
        <div class="ub-argon__stage${i === 0 ? ' is-active' : ''}" data-ub-slide ${i === 0 ? '' : 'hidden'}>
          <span class="ub-argon__rail-line ub-argon__rail-line--left"></span>
          <span class="ub-argon__rail-line ub-argon__rail-line--right"></span>
          <span class="ub-argon__stroke-year ub-argon__stroke-year--left">1972</span>
          <span class="ub-argon__stroke-year ub-argon__stroke-year--right">2026</span>
          <div class="ub-argon__center">
            <h2 class="ub-argon__giant-name">${sb.name}</h2>
            <img src="${sb.img}" class="ub-argon__bike" width="1400" height="880" alt="${sb.name}">
            <div class="ub-argon__peek" aria-hidden="true">
              <span class="ub-argon__peek-letter">${sb.peek}</span>
              <img src="${sb.nextImg}" width="680" height="428" alt="">
            </div>
          </div>
          <div class="ub-argon__hud">
            <div class="ub-argon__nums">
              ${stageBikes.map((_, j) => `<button type="button" class="ub-argon__num" data-ub-go="${j}" ${j === i ? 'aria-current="true"' : ''}>0${j + 1}</button>`).join('')}
            </div>
            <a href="#shop" class="ub-argon__discover"><span>DISCOVER BIKE</span><span class="ub-argon__discover-dot"></span></a>
            <div class="ub-argon__arrows">
              <button type="button" class="ub-argon__line-arrow" data-ub-prev>&larr;</button>
              <button type="button" class="ub-argon__line-arrow" data-ub-next>&rarr;</button>
            </div>
          </div>
        </div>
      `).join('')}
    </section>

    <section class="ub-pill-story">
      <div class="ub-shell">
        <div class="ub-pill-story__grid">
          <div class="ub-pill-story__copy">
            <span class="ub-pill-story__watermark" aria-hidden="true">WORKSHOP</span>
            <p class="ub-tech__kicker">Precision Fitting &amp; Master Service &middot; Tampa, FL</p>
            <h2 class="ub-tech__title">BUILT, TORQUED &amp; FITTED TO YOUR GEOMETRY</h2>
            <p class="ub-tech__desc">Every complete bicycle at University Bicycle Center includes certified mechanic assembly, hydraulic bleed verification, drivetrain indexing, and an individualized Tampa showroom rider fit since 1972.</p>
            <a href="#shop" class="ub-pill-btn"><span>EXPLORE IN-STORE PICKUP</span><span>+</span></a>
          </div>
          <div class="ub-pill-story__media-wrap">
            <div class="ub-pill-story__frame"><img src="/assets/boutique/ubc-bike-aethos.webp" width="1160" height="730" alt="Workshop"></div>
            <div class="ub-pill-story__badge"><span>TAMPA, FL &middot; SERVING RIDERS SINCE 1972</span><span>&rarr;</span></div>
          </div>
        </div>
      </div>
    </section>
  </main>

  <footer class="ub-footer">
    <div class="ub-dots ub-footer__dots-right" aria-hidden="true"></div>
    <span class="ub-footer__contact-v" aria-hidden="true">CONTACT</span>
    <div class="ub-shell">
      <div class="ub-footer__grid">
        <div class="ub-footer__showroom-card">
          <span class="ub-footer__pin-badge"><span>&#9679;</span><span>Tampa Showroom &amp; Service Bay</span></span>
          <h2 class="ub-footer__showroom-title">University Bicycle Center</h2>
          <p class="ub-footer__showroom-addr">1218 E Fletcher Ave &middot; Tampa, FL 33612 &middot; Authorized Specialized, Surly, Continental &amp; Bell dealer serving Tampa Bay cyclists since 1972.</p>
          <div class="ub-footer__pillars">
            <div class="ub-footer__pillar"><strong>In-Store Stock</strong><span>Ready today for free Tampa pickup or fast shipping.</span></div>
            <div class="ub-footer__pillar"><strong>Special Order</strong><span>Direct from authorized U.S. distributors in 3–5 days.</span></div>
          </div>
        </div>
        <div class="ub-footer__center">
          <img src="/assets/boutique/ubc-logo-navy.png" width="190" height="39" alt="UBC">
          <p class="ub-footer__hours">MON–FRI: 10:00–19:00 &middot; SAT: 10:00–17:00 &middot; SUN: 12:00–16:00</p>
          <p class="ub-footer__subcopy">Receive seasonal event releases, Tampa group rides, and workshop service reminders.</p>
        </div>
      </div>
    </div>
    <div class="ub-footer__bottom">
      <div class="ub-shell ub-footer__bottom-row">
        <span>&copy; 2026 University Bicycle Center &middot; Tampa, FL (Est. 1972)</span>
        <span>Powered by UBC Commerce Hub &middot; TwoIT Solutions LLC</span>
      </div>
    </div>
  </footer>

  <script>
    window.__bagCount = 0;
    window.__addPreviewBag = function(name) {
      window.__bagCount += 1;
      document.getElementById('preview-bag-count').textContent = String(window.__bagCount);
      document.getElementById('preview-bag-toast').textContent = 'Added: ' + name + ' (' + window.__bagCount + ')';
    };
  </script>
  <script src="/assets/boutique/ubc-boutique.js" defer></script>
</body>
</html>`;
}

function wrapFableDocument(title, activeTab, bodyHtml, edition = 'classic') {
  return `<!DOCTYPE html>
<html lang="en" class="js">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${title}</title>
  <style>
    :root {
      --font-body-scale: 1.0;
      --font-heading-scale: 1.0;
      --color-foreground: 20, 32, 45;
      --color-background: 254, 253, 243;
      --fb-pattern-url: url('/assets/fable/fable-pattern.jpg');
      --fb-ebike-tile-url: url('/assets/fable/fable-ebike-tile.jpg');
      --preview-bar-h: 42px;
    }
    html { box-sizing: border-box; font-size: 62.5%; height: 100%; }
    body { margin: 0; font-size: 1.6rem; letter-spacing: 0.06rem; line-height: 1.8; }
    @font-face { font-family: 'Anton'; font-style: normal; font-weight: 400; font-display: swap; src: url('/assets/fable/fable-anton-400.woff2') format('woff2'); }
    @font-face { font-family: 'Barlow Condensed'; font-style: normal; font-weight: 600; font-display: swap; src: url('/assets/fable/fable-barlow-condensed-600.woff2') format('woff2'); }
    @font-face { font-family: 'Barlow Condensed'; font-style: normal; font-weight: 700; font-display: swap; src: url('/assets/fable/fable-barlow-condensed-700.woff2') format('woff2'); }
    @font-face { font-family: 'Barlow'; font-style: normal; font-weight: 400; font-display: swap; src: url('/assets/fable/fable-barlow-400.woff2') format('woff2'); }
    @font-face { font-family: 'Barlow'; font-style: normal; font-weight: 500; font-display: swap; src: url('/assets/fable/fable-barlow-500.woff2') format('woff2'); }
    @font-face { font-family: 'Barlow'; font-style: normal; font-weight: 600; font-display: swap; src: url('/assets/fable/fable-barlow-600.woff2') format('woff2'); }
    @font-face { font-family: 'Barlow'; font-style: normal; font-weight: 700; font-display: swap; src: url('/assets/fable/fable-barlow-700.woff2') format('woff2'); }
  </style>
  <link rel="stylesheet" href="/assets/fable/base.css">
  <link rel="stylesheet" href="/assets/fable/ubc-brand.css">
  <link rel="stylesheet" href="/assets/fable/ubc-fable.css">
</head>
<body data-ubc-edition="${edition}">
  ${topPreviewBar(activeTab)}
  <script>
    (function(){
      var bar = document.getElementById('ubcPreviewTopBar');
      function syncH(){
        if (bar) document.documentElement.style.setProperty('--preview-bar-h', bar.offsetHeight + 'px');
      }
      syncH();
      window.addEventListener('resize', syncH);
      if (window.ResizeObserver && bar) new ResizeObserver(syncH).observe(bar);
    })();
  </script>
  ${bodyHtml}
  <script>
    window.__bagCount = 0;
    window.__addPreviewBag = function() {
      window.__bagCount += 1;
      var badge = document.getElementById('fable-cart-count');
      if (badge) {
        badge.textContent = String(window.__bagCount);
        badge.removeAttribute('hidden');
      }
    };
  </script>
  <script src="/assets/fable/ubc-fable.js" defer></script>
</body>
</html>`;
}

function resolveEditionConditionals(raw, edition) {
  // Normalize `if section.blocks.size > 0 ... elsif edition ==` so default edition promo cards render in preview
  raw = raw.replace(
    /\{%-?\s*if\s+section\.blocks\.size\s*>\s*0\s*-?%\}(?:(?!\{%-?\s*elsif\s+edition)[\s\S])*?\{%-?\s*elsif\s+edition\s*==/g,
    '{%- if edition ==',
  );

  // Evaluate any `if edition == '...' ... [elsif edition == '...']* ... [else]? ... endif` block without crossing blocks
  raw = raw.replace(
    /\{%-?\s*if\s+edition\s*==\s*'([a-z0-9_]+)'\s*-?%\}((?:(?!\{%-?\s*(?:if|unless)\b)[\s\S])*?)\{%-?\s*endif\s*-?%\}/g,
    (_, firstEd, body) => {
      const branches = [];
      const tokenRe = /\{%-?\s*(?:elsif\s+edition\s*==\s*'([a-z0-9_]+)'|(else))\s*-?%\}/g;
      let curCond = firstEd;
      let lastIdx = 0;
      let m;
      while ((m = tokenRe.exec(body)) !== null) {
        branches.push({ cond: curCond, html: body.slice(lastIdx, m.index) });
        curCond = m[2] === 'else' ? '__else__' : m[1];
        lastIdx = tokenRe.lastIndex;
      }
      branches.push({ cond: curCond, html: body.slice(lastIdx) });
      const hit = branches.find((b) => b.cond === edition) || branches.find((b) => b.cond === '__else__');
      return hit ? hit.html : '';
    },
  );
  return raw;
}

function resolveBalancedLiquidIfs(input, evalCond) {
  const tagRe = /\{%-?\s*(if|unless|elsif|else|endif)\b([^%]*?)-?%\}/g;
  function parseSeq(startPos, topLevel = false) {
    let out = '';
    while (true) {
      tagRe.lastIndex = startPos;
      const m = tagRe.exec(input);
      if (!m) {
        out += input.slice(startPos);
        return { out, endPos: input.length, tag: null };
      }
      const [fullTag, kw, condRaw] = m;
      const before = input.slice(startPos, m.index);
      if (!topLevel && (kw === 'elsif' || kw === 'else' || kw === 'endif')) {
        out += before;
        return { out, endPos: tagRe.lastIndex, tag: kw, cond: condRaw.trim() };
      }
      out += before;
      if (kw === 'if' || kw === 'unless') {
        const branches = [];
        let curKind = kw;
        let curCond = condRaw.trim();
        let cursor = tagRe.lastIndex;
        while (true) {
          const seg = parseSeq(cursor, false);
          branches.push({ kind: curKind, cond: curCond, body: seg.out });
          cursor = seg.endPos;
          if (!seg.tag || seg.tag === 'endif') break;
          curKind = seg.tag;
          curCond = seg.cond || '';
        }
        let chosen = '';
        for (const b of branches) {
          if (b.kind === 'else') {
            chosen = b.body;
            break;
          }
          const ok = Boolean(evalCond(b.cond));
          const pass = b.kind === 'unless' ? !ok : ok;
          if (pass) {
            chosen = b.body;
            break;
          }
        }
        out += chosen;
        startPos = cursor;
      } else {
        startPos = tagRe.lastIndex;
      }
    }
  }
  return parseSeq(0, true).out;
}

function compileFableSection(f, raw, opts = {}) {
  const isStandalonePage = Boolean(opts.isStandalonePage);
  const isOurStoryPage = Boolean(opts.isOurStoryPage);
  const edition = opts.edition || 'classic';

  // Strip schema and comments
  raw = raw.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '');
  raw = raw.replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g, '');
  raw = resolveEditionConditionals(raw, edition);

  if (f === 'fable-bike-finder.liquid') {
    const catalogItems = [
      { kind: 'bike', t: 'electric', b: 'Specialized', n: 'Turbo Vado 4.0', sku: 'SPZ-TURBO-VADO-4', p: 3249.99, bfPrice: 2799.99, xmasPrice: 2999.99, julyPrice: 2949.99, u: '#new-arrivals', img: '/assets/fable/spz-turbo-vado-4.png', availability: 'in_stock', pickupOnly: true },
      { kind: 'bike', t: 'electric', b: 'Specialized', n: 'S-Works Turbo Creo 2', sku: 'SPZ-TURBO-CREO-2', p: 6499.99, bfPrice: 5799.99, xmasPrice: 6099.99, julyPrice: 5999.99, u: '#new-arrivals', img: '/assets/fable/spz-turbo-creo-2.png', availability: 'in_stock', pickupOnly: true },
      { kind: 'bike', t: 'electric', b: 'Electra', n: 'Townie Go! Step-Thru', sku: 'ELC-TOWNIE-GO', p: 1999.99, bfPrice: 1749.99, xmasPrice: 1849.99, julyPrice: 1799.99, u: '#new-arrivals', img: '/assets/fable/ebike-townie-go.png', availability: 'in_stock', pickupOnly: true },
      { kind: 'bike', t: 'electric', b: 'Cannondale', n: 'Synapse Neo Allroad 2', sku: 'CAN-SYNAPSE-NEO2', p: 3799.99, bfPrice: 3399.99, xmasPrice: 3549.99, julyPrice: 3499.99, u: '#new-arrivals', img: '/assets/fable/ebike-synapse-neo.png', availability: 'in_stock', pickupOnly: true },
      { kind: 'bike', t: 'road', b: 'Specialized', n: 'Specialized Tarmac SL7 Sport — 56cm', p: 2799.99, compareAt: 3200.00, bfPrice: 2499.99, xmasPrice: 2599.99, julyPrice: 2599.99, u: '#new-arrivals', img: '/assets/fable/fable-bike-tarmac.png', sku: 'UBC-TARMAC-SL7-56', variantId: 49001, availability: 'in_stock', leadDays: 0, pickupOnly: true },
      { kind: 'bike', t: 'road', b: 'Surly', n: 'Surly Midnight Special Frame — 54cm', p: 899.99, bfPrice: 799.99, xmasPrice: 829.99, julyPrice: 829.99, u: '#new-arrivals', img: '/assets/fable/ubc-bike-diverge.png', sku: 'UBC-SURLY-MS-54', variantId: 49002, availability: 'special_order', leadDays: 4, pickupOnly: false },
      { kind: 'bike', t: 'road', b: 'Specialized', n: 'Allez Comp', p: 2099.99, bfPrice: 1899.99, xmasPrice: 1949.99, julyPrice: 1949.99, u: '#new-arrivals', img: '/assets/fable/fable-bike-allez.png', availability: 'in_stock', pickupOnly: true },
      { kind: 'bike', t: 'road', b: 'Specialized', n: 'Allez', p: 1599.99, bfPrice: 1399.99, xmasPrice: 1499.99, julyPrice: 1449.99, u: '#new-arrivals', img: '/assets/fable/spz-allez-2026.png', availability: 'in_stock', pickupOnly: true },
      { kind: 'bike', t: 'mtb', b: 'Specialized', n: 'Epic 9 Sport', p: 4699.99, bfPrice: 4199.99, xmasPrice: 4399.99, julyPrice: 4349.99, u: '#new-arrivals', img: '/assets/fable/ubc-bike-epic-9.png', availability: 'in_stock', pickupOnly: true },
      { kind: 'bike', t: 'mtb', b: 'Specialized', n: 'Rockhopper 29', p: 749.99, bfPrice: 649.99, xmasPrice: 689.99, julyPrice: 679.99, u: '#new-arrivals', img: '/assets/fable/fable-bike-rockhopper.png', availability: 'in_stock', pickupOnly: true },
      { kind: 'bike', t: 'mtb', b: 'Giant', n: 'Talon 2', p: 799.99, bfPrice: 699.99, xmasPrice: 729.99, julyPrice: 719.99, u: '#new-arrivals', img: '/assets/fable/cat-giant-talon.png', availability: 'in_stock', pickupOnly: true },
      { kind: 'bike', t: 'fitness', b: 'Specialized', n: 'Sirrus X 2.0', p: 849.99, bfPrice: 749.99, xmasPrice: 779.99, julyPrice: 769.99, u: '#new-arrivals', img: '/assets/fable/fable-bike-sirrus.png', availability: 'in_stock', pickupOnly: true },
      { kind: 'bike', t: 'cruise', b: 'Specialized', n: 'Roll 2.0 Low Entry', p: 799.99, bfPrice: 699.99, xmasPrice: 729.99, julyPrice: 719.99, u: '#new-arrivals', img: '/assets/fable/fable-bike-roll.png', availability: 'in_stock', pickupOnly: true },
      { kind: 'bike', t: 'cruise', b: 'Electra', n: 'Loft 7D Step-Over', p: 499.99, bfPrice: 429.99, xmasPrice: 449.99, julyPrice: 439.99, u: '#new-arrivals', img: '/assets/fable/cat-electra-loft.png', availability: 'in_stock', pickupOnly: true },
    ];
    raw = raw.replace(/<script type="application\/json" id="FableCatalogData">[\s\S]*?<\/script>/, `<script type="application/json" id="FableCatalogData">${JSON.stringify(catalogItems)}</script>`);
  }

  if (f === 'fable-hero-showcase.liquid') {
    const heroItems = [
      { b: 'Specialized', g: 'TURBO', c: '#ccbb8d', n: 'Turbo Vado 4.0', p: 3249.99, bfPrice: 2799.99, xmasPrice: 2999.99, julyPrice: 2949.99, u: '#finder', img: '/assets/fable/spz-turbo-vado-4.png', availability: 'in_stock', cta: ['Explore E-Bike', 'Ver E-Bike'], cat: ['Electric Commuter · Specialized', 'E-Bike Urbana · Specialized'], d: ['Smooth pedal-assist power, integrated lighting and rear rack, assembled and adjusted road-ready in Tampa.', 'Asistencia suave al pedaleo, luces y parrilla integradas, armada y ajustada lista para rodar en Tampa.'] },
      { b: 'Specialized', g: 'MIPS', c: '#f2bfb3', n: 'Propero 4 MIPS Helmet', p: 199.99, promoPrice: 179.99, bfPrice: 159.99, xmasPrice: 169.99, julyPrice: 169.99, u: '#new-arrivals', img: '/assets/fable/spz-propero-4.png', availability: 'in_stock', cta: ['Shop Helmets & Gear', 'Ver Cascos y Equipo'], cat: ['Helmets & Rider Safety · Specialized', 'Cascos y Seguridad · Specialized'], d: ['Virginia Tech 5-Star safety rating with micro-channeled cooling for warm, humid Florida rides.', 'Calificación 5 estrellas Virginia Tech con ventilación interna diseñada para rodar fresco en Florida.'] },
      { b: 'Specialized', g: 'TARMAC', c: '#ccbb8d', n: 'Tarmac SL7 Sport — 56cm', p: 2799.99, bfPrice: 2499.99, xmasPrice: 2599.99, julyPrice: 2599.99, u: '#finder', img: '/assets/fable/fable-bike-tarmac.png', availability: 'in_stock', cta: ['View Road Build', 'Ver Bici de Ruta'], cat: ['Road Performance · Specialized', 'Ruta · Specialized'], d: ['Light, aerodynamic FACT carbon frameset with Shimano 105 12-speed, fitted and torque-checked in Tampa.', 'Cuadro ligero y aerodinámico de carbono FACT con Shimano 105 12v, ajustado a tu medida en Tampa.'] },
      { b: 'Specialized', g: 'S-WORKS', c: '#d9cfb2', n: 'S-Works Power Carbon Saddle', p: 324.99, promoPrice: 299.99, bfPrice: 274.99, xmasPrice: 289.99, julyPrice: 289.99, u: '#new-arrivals', img: '/assets/fable/spz-power-saddle.png', availability: 'in_stock', cta: ['Shop Components', 'Ver Componentes'], cat: ['Pro Components & Fit · Specialized', 'Componentes y Fit · Specialized'], d: ['FACT carbon shell and rails with Body Geometry pressure relief, sized in our Tampa showroom.', 'Base y rieles de carbono FACT con diseño anatómico Body Geometry medido en nuestro showroom de Tampa.'] },
      { b: 'Specialized', g: 'EPIC 9', c: '#f2bfb3', n: 'Epic 9 Sport', p: 4699.99, bfPrice: 4199.99, xmasPrice: 4399.99, julyPrice: 4349.99, u: '#finder', img: '/assets/fable/ubc-bike-epic-9.png', availability: 'in_stock', cta: ['View Trail Bike', 'Ver Bici MTB'], cat: ['Cross-Country Trail · Specialized', 'Montaña XC y Trail · Specialized'], d: ['Progressive carbon full-suspension speed built for Alafia River, Balm-Boyette and Santos singletrack.', 'Doble suspensión progresiva en carbono lista para los senderos de Alafia River, Balm-Boyette y Santos.'] },
    ];
    raw = raw.replace(/<script type="application\/json" id="FableHeroData">[\s\S]*?<\/script>/, `<script type="application/json" id="FableHeroData">${JSON.stringify(heroItems)}</script>`);
  }

  if (f === 'fable-new-arrivals.liquid') {
    const naItems = [
      { id: 'na-propero4', cat: 'helmets', promo: true, b: 'Specialized', n: 'Propero 4 MIPS Helmet', p: 199.99, promoPrice: 179.99, bfPrice: 159.99, xmasPrice: 169.99, julyPrice: 169.99, u: '#new-arrivals', variantId: 49010, img: '/assets/fable/spz-propero-4.png', pickupOnly: false, tagClassic: ['10% Off · 5-Star VT', '10% Off · MIPS'], tagBf: ['Save 20% · BF', '20% Off · BF'], tagXmas: ['Top Rider Gift', 'Regalo Estrella'], tagJuly: ['Summer Aero Pick', 'Oferta Verano'] },
      { id: 'na-skratch', cat: 'nutrition', promo: true, b: 'Skratch Labs', n: 'Sport Hydration Drink Mix', p: 24.95, promoPrice: 21.95, bfPrice: 19.95, xmasPrice: 20.95, julyPrice: 19.95, u: '#new-arrivals', variantId: 49021, img: '/assets/fable/supp-skratch-hydration.png', pickupOnly: false, tagClassic: ['Bundle Save 15%', 'Combo -15%'], tagBf: ['BF Fuel Deal', 'Oferta BF'], tagXmas: ['Stocking Stuffer', 'Detalle Ciclista'], tagJuly: ['3-for-2 Summer Fuel', 'Promo Hidratación'] },
      { id: 'na-gp5000', cat: 'parts', promo: true, b: 'Continental', n: 'Grand Prix 5000 700x28c Tire', p: 89.95, promoPrice: 79.95, bfPrice: 69.95, xmasPrice: 74.95, julyPrice: 74.95, u: '#new-arrivals', variantId: 49003, img: '/assets/fable/spz-cannibal-tire.png', pickupOnly: false, tagClassic: ['Pair Promo', 'Promo Par'], tagBf: ['Save $20 · BF', 'Ahorra $20'], tagXmas: ['Road Upgrade', 'Regalo Ruta'], tagJuly: ['Summer Miles Deal', 'Oferta Ruta'] },
      { id: 'na-allez-2026', cat: 'bikes', promo: false, b: 'Specialized', n: 'Allez 2026 Road Build', p: 1599.99, bfPrice: 1399.99, xmasPrice: 1499.99, julyPrice: 1449.99, u: '#finder', img: '/assets/fable/spz-allez-2026.png', pickupOnly: true, tagClassic: ['New 2026 Arrival', 'Nuevo Modelo 2026'], tagBf: ['Save $200 · BF', 'Ahorra $200'], tagXmas: ['Free Hold to Dec 24', 'Apartado Gratis'], tagJuly: ['Save $150 · July 4', 'Ahorra $150'] },
      { id: 'na-power-saddle', cat: 'parts', promo: true, b: 'Specialized', n: 'S-Works Power Carbon Saddle', p: 324.99, promoPrice: 299.99, bfPrice: 274.99, xmasPrice: 289.99, julyPrice: 289.99, u: '#new-arrivals', variantId: 49031, img: '/assets/fable/spz-power-saddle.png', pickupOnly: false, tagClassic: ['Free Fit Check', 'Fit Incluido'], tagBf: ['Save $50 · BF', 'Ahorra $50'], tagXmas: ['Pro Carbon Gift', 'Regalo Carbono'], tagJuly: ['Save $35 · Summer', 'Ahorra $35'] },
      { id: 'na-bell-z20', cat: 'helmets', promo: true, b: 'Bell', n: 'Z20 MIPS Road Helmet', p: 172.49, promoPrice: 149.99, bfPrice: 134.99, xmasPrice: 144.99, julyPrice: 144.99, u: '#new-arrivals', variantId: 49004, img: '/assets/fable/fable-gear-agilis.png', pickupOnly: false, tagClassic: ['Save $22 · In Stock', 'Ahorra $22'], tagBf: ['Save $37 · BF', 'Ahorra $37'], tagXmas: ['MIPS Gift Pick', 'Regalo MIPS'], tagJuly: ['Cool-Vent Summer', 'Ventilación Pro'] },
      { id: 'na-vado4', cat: 'bikes', promo: false, b: 'Specialized', n: 'Turbo Vado 4.0 E-Bike', p: 3249.99, bfPrice: 2799.99, xmasPrice: 2999.99, julyPrice: 2949.99, u: '#finder', img: '/assets/fable/spz-turbo-vado-4.png', pickupOnly: true, tagClassic: ['0% APR Eligible', '0% APR Disponible'], tagBf: ['Save $450 · BF', 'Ahorra $450'], tagXmas: ['Dream Holiday Ride', 'Regalo Estrella'], tagJuly: ['Save $300 · Summer', 'Ahorra $300'] },
      { id: 'na-roctane', cat: 'nutrition', promo: true, b: 'GU Energy', n: 'Roctane Electrolyte Capsules (50ct)', p: 22.00, promoPrice: 19.50, bfPrice: 17.50, xmasPrice: 18.50, julyPrice: 17.50, u: '#new-arrivals', variantId: 49023, img: '/assets/fable/supp-gu-capsules.png', pickupOnly: false, tagClassic: ['Florida Heat Pick', 'Clima Húmedo'], tagBf: ['BF Under $20', 'Menos de $20'], tagXmas: ['Under $20 Gift', 'Detalle < $20'], tagJuly: ['Summer Sweat Essential', 'Esencial Calor'] },
      { id: 'na-mk15-light', cat: 'helmets', promo: false, b: 'Exposure Lights', n: 'Six Pack MK15 CNC Headlight', p: 545.00, bfPrice: 469.00, xmasPrice: 489.00, julyPrice: 499.00, u: '#new-arrivals', variantId: 49011, img: '/assets/fable/spz-stix-light.png', pickupOnly: false, tagClassic: ['Night Trail CNC', 'Trail Nocturno'], tagBf: ['Save $76 · BF', 'Ahorra $76'], tagXmas: ['Trail Rider Gift', 'Regalo Trail'], tagJuly: ['Dawn Patrol Light', 'Rodada Temprana'] },
      { id: 'na-sram-s200', cat: 'parts', promo: false, b: 'SRAM', n: 'Eagle S200 Rear Derailleur', p: 139.99, bfPrice: 114.99, xmasPrice: 124.99, julyPrice: 124.99, u: '#new-arrivals', variantId: 49033, img: '/assets/fable/cat-sram-s200.png', pickupOnly: false, tagClassic: ['OEM Workshop Part', 'Repuesto OEM'], tagBf: ['Save 18% · BF', '18% Off · BF'], tagXmas: ['MTB Upgrade', 'Mejora MTB'], tagJuly: ['Trail Prep Part', 'Listo para Alafia'] },
      { id: 'na-gu-box', cat: 'nutrition', promo: true, b: 'GU Energy', n: 'Energy Gel 24-Count Box', p: 38.40, promoPrice: 33.95, bfPrice: 29.95, xmasPrice: 31.95, julyPrice: 30.95, u: '#new-arrivals', variantId: 49022, img: '/assets/fable/cat-gu-gel.png', pickupOnly: false, tagClassic: ['Box Save 12%', 'Caja -12%'], tagBf: ['Save $8.45 · BF', 'Ahorra $8.45'], tagXmas: ['Rider Fuel Box', 'Caja Regalo'], tagJuly: ['Long Ride Pack', 'Pack Verano'] },
      { id: 'na-epic9', cat: 'bikes', promo: false, b: 'Specialized', n: 'Epic 9 Sport Carbon MTB', p: 4699.99, bfPrice: 4199.99, xmasPrice: 4399.99, julyPrice: 4349.99, u: '#finder', img: '/assets/fable/ubc-bike-epic-9.png', pickupOnly: true, tagClassic: ['Alafia Ready', 'Lista para Alafia'], tagBf: ['Save $500 · BF', 'Ahorra $500'], tagXmas: ['Assembled by Ashton', 'Armada en Taller'], tagJuly: ['Save $350 · Summer', 'Ahorra $350'] },
    ];
    raw = raw.replace(/<script type="application\/json" id="FableNewArrivalsData">[\s\S]*?<\/script>/, `<script type="application/json" id="FableNewArrivalsData">${JSON.stringify(naItems)}</script>`);
  }

  if (f === 'fable-family-story.liquid') {
    raw = raw.replace(
      /\{%\s*if\s+is_page\s*%\} fam-sec--page\{%\s*endif\s*%\}/g,
      isOurStoryPage ? ' fam-sec--page' : '',
    );
    raw = raw.replace(
      /\{%-?\s*unless\s+is_page\s*-?%\}([\s\S]*?)\{%-?\s*endunless\s*-?%\}/g,
      isOurStoryPage ? '' : '$1',
    );
    if (isOurStoryPage) {
      raw = raw.replace(
        /\{%-?\s*if\s+is_page\s*-?%\}((?:(?!\{%-?\s*(?:if|else|endif))[\s\S])*?)\{%-?\s*else\s*-?%\}(?:(?!\{%-?\s*endif)[\s\S])*?\{%-?\s*endif\s*-?%\}/g,
        '$1',
      );
      raw = raw.replace(
        /\{%-?\s*if\s+is_page\s*-?%\}((?:(?!\{%-?\s*(?:if|else|endif))[\s\S])*?)\{%-?\s*endif\s*-?%\}/g,
        '$1',
      );
    } else {
      raw = raw.replace(
        /\{%-?\s*if\s+is_page\s*-?%\}(?:(?!\{%-?\s*(?:if|else|endif))[\s\S])*?\{%-?\s*else\s*-?%\}((?:(?!\{%-?\s*endif)[\s\S])*?)\{%-?\s*endif\s*-?%\}/g,
        '$1',
      );
      raw = raw.replace(
        /\{%-?\s*if\s+is_page\s*-?%\}(?:(?!\{%-?\s*(?:if|else|endif))[\s\S])*?\{%-?\s*endif\s*-?%\}/g,
        '',
      );
    }
  }

  if (f === 'fable-store-locator.liquid') {
    raw = raw.replace(
      /\{%\s*if\s+section\.settings\.is_standalone_page\s*%\} sl-sec--page\{%\s*else\s*%\} sl-sec--home\{%\s*endif\s*%\}/g,
      isStandalonePage ? ' sl-sec--page' : ' sl-sec--home',
    );
    raw = raw.replace(
      /\{%\s*if\s+section\.settings\.is_standalone_page\s*%\} sl-sec--page\{%\s*endif\s*%\}/g,
      isStandalonePage ? ' sl-sec--page' : ' sl-sec--home',
    );
    raw = raw.replace(
      /\{%-?\s*if\s+section\.settings\.enable_near_me\s*-?%\}([\s\S]*?)\{%-?\s*endif\s*-?%\}/g,
      isStandalonePage ? '$1' : '',
    );
    raw = raw.replace(
      /\{%-?\s*if\s+section\.settings\.show_page_link\s+and\s+section\.settings\.is_standalone_page\s*==\s*false\s*-?%\}([\s\S]*?)\{%-?\s*endif\s*-?%\}/g,
      isStandalonePage ? '' : '$1',
    );
    if (isStandalonePage) {
      raw = raw.replace(
        /\{%-?\s*if\s+section\.settings\.is_standalone_page\s*-?%\}((?:(?!\{%-?\s*(?:else|endif))[\s\S])*?)\{%-?\s*else\s*-?%\}(?:(?!\{%-?\s*endif)[\s\S])*?\{%-?\s*endif\s*-?%\}/g,
        '$1',
      );
      raw = raw.replace(
        /\{%-?\s*if\s+section\.settings\.is_standalone_page\s*-?%\}((?:(?!\{%-?\s*(?:else|endif))[\s\S])*?)\{%-?\s*endif\s*-?%\}/g,
        '$1',
      );
    } else {
      raw = raw.replace(
        /\{%-?\s*if\s+section\.settings\.is_standalone_page\s*-?%\}(?:(?!\{%-?\s*(?:else|endif))[\s\S])*?\{%-?\s*else\s*-?%\}((?:(?!\{%-?\s*endif)[\s\S])*?)\{%-?\s*endif\s*-?%\}/g,
        '$1',
      );
      raw = raw.replace(
        /\{%-?\s*if\s+section\.settings\.is_standalone_page\s*-?%\}(?:(?!\{%-?\s*(?:else|endif))[\s\S])*?\{%-?\s*endif\s*-?%\}/g,
        '',
      );
    }
    raw = raw.replace(/\{\{\s*section\.settings\.google_maps_api_key[^}]*\}\}/g, '');
    raw = raw.replace(/\{\{\s*section\.settings\.eyebrow[^}]*\}\}/g, 'Store Locator · Tampa Bay');
  }

  // Strip {% liquid ... %} blocks first so bare keywords inside liquid blocks don't interfere
  raw = raw.replace(/\{%-?\s*liquid[\s\S]*?-?%\}/g, '');

  // Evaluate ALL remaining Liquid {% if / unless / elsif / else / endif %} blocks with full nesting support
  raw = resolveBalancedLiquidIfs(raw, (cond) => {
    const mEd = cond.match(/^edition\s*==\s*'([a-z0-9_]+)'$/);
    if (mEd) return edition === mEd[1];
    if (cond === 'is_page') return isOurStoryPage;
    if (cond === 'section.settings.is_standalone_page') return isStandalonePage;
    if (cond === 'section.settings.enable_near_me') return isStandalonePage;
    if (cond === 'section.settings.is_standalone_page and section.settings.enable_near_me') return isStandalonePage;
    if (cond === 'section.settings.show_page_link and section.settings.is_standalone_page == false') return !isStandalonePage;
    if (cond === 'section.settings.enable_bilingual_toggle') return true;
    if (cond === 'cart == empty') return true;
    if (cond === "word_clean == 'SINCE 1972'") return true;
    if (cond === 'settings.ubc_ikeono_enabled != false') return true;
    return false;
  });

  // Replace common Liquid output expressions
  const homeBase =
    edition === 'black_friday'
      ? '/black-friday'
      : edition === 'christmas'
        ? '/christmas'
        : edition === 'july_4'
          ? '/july-4'
          : '/fable';

  raw = raw.replace(/\{\{\s*ik_sms[^}]*\}\}/g, '+18139712277');
  raw = raw.replace(/\{\{\s*ik_phone[^}]*\}\}/g, '(813) 971-2277');
  raw = raw.replace(/\{\{\s*home_anchor\s*\}\}/g, isStandalonePage ? homeBase : '');
  raw = raw.replace(/\{\{\s*routes\.root_url\s*\}\}/g, homeBase);
  raw = raw.replace(/\{\{\s*routes\.collections_url\s*\}\}\/all/g, `${isStandalonePage ? homeBase : ''}#new-arrivals`);
  raw = raw.replace(/\{\{\s*(?:catalog_url|all_bikes_href|ebike_href|road_href|mtb_href|hybrid_href)\s*\}\}/g, `${isStandalonePage ? homeBase : ''}#finder`);
  raw = raw.replace(/\{\{\s*target_col\.url[^}]*\}\}/g, `${isStandalonePage ? homeBase : ''}#finder`);
  raw = raw.replace(/\{\{\s*browse_label[^}]*\}\}/g, 'Browse All 20,000+ Items');
  raw = raw.replace(/\{\{\s*(?:story_href|story_url)\s*\}\}/g, '/our-story');
  raw = raw.replace(/\{\{\s*locations_href\s*\}\}/g, '/locations');
  raw = raw.replace(/\/pages\/our-story/g, '/our-story');
  raw = raw.replace(/\/pages\/locations/g, '/locations');
  raw = raw.replace(/\{\{\s*'([^']+)'\s*\|\s*asset_url\s*\|\s*json\s*\}\}/g, '"/assets/fable/$1"');
  raw = raw.replace(/\{\{\s*'([^']+)'\s*\|\s*asset_url\s*\}\}/g, '/assets/fable/$1');
  raw = raw.replace(/\{\{\s*(?:phone_tel|ws_tel)\s*\}\}/g, '+18139712277');
  raw = raw.replace(/\{\{\s*alafia_tel\s*\}\}/g, '+18134598293');
  raw = raw.replace(/\{\{\s*(?:raw_phone|ws_phone|section\.settings\.phone)[^}]*\}\}/g, '(813) 971-2277');
  raw = raw.replace(/\{\{\s*alafia_phone[^}]*\}\}/g, '(813) 459-8293');
  raw = raw.replace(/\{\{\s*section\.settings\.live_status[^}]*\}\}/g, 'Walk-In Workshop · Mon–Fri 10–7 · Sat 10–6 · Sun 12–5');
  raw = raw.replace(/\{\{\s*p_lvl1[^}]*\}\}/g, '$99.99');
  raw = raw.replace(/\{\{\s*p_lvl2[^}]*\}\}/g, '$179.99');
  raw = raw.replace(/\{\{\s*p_lvl3[^}]*\}\}/g, '$299.99');
  raw = raw.replace(/\{\{\s*acima_href[^}]*\}\}/g, 'https://shop.acima.com');
  raw = raw.replace(/\{\{\s*snap_href[^}]*\}\}/g, 'https://snapfinance.com');
  raw = raw.replace(/\{\{\s*section\.settings\.col1_heading[^}]*\}\}/g, 'Shop');
  raw = raw.replace(/\{\{\s*section\.settings\.col2_heading[^}]*\}\}/g, 'Services');
  raw = raw.replace(/\{\{\s*section\.settings\.col3_heading[^}]*\}\}/g, 'Our Family Shop');
  raw = raw.replace(/\{\{\s*'general\.search\.search'\s*\|\s*t\s*\}\}/g, 'Search');
  raw = raw.replace(/\{\{\s*'customer\.account\.title'\s*\|\s*t\s*\}\}/g, 'Account');
  raw = raw.replace(/\{\{\s*'templates\.cart\.cart'\s*\|\s*t\s*\}\}/g, 'Bag');
  raw = raw.replace(/\{\{\s*'sections\.header\.menu'\s*\|\s*t\s*\}\}/g, 'Open menu');
  raw = raw.replace(/\{\{\s*'accessibility\.close'\s*\|\s*t\s*\}\}/g, 'Close');
  raw = raw.replace(
    /\{\{\s*section\.settings\.eyebrow[^}]*\}\}/g,
    edition === 'black_friday'
      ? 'Black Friday Event · Bikes, Helmets, Parts & Service'
      : edition === 'christmas'
        ? 'Holiday Gift Guide · Bikes, Gear, Fitting & Service'
        : edition === 'july_4'
          ? 'July 4th Summer Event · Bikes, Hydration & Alafia Rides'
          : '3-Generation Family Shop · Bikes, Gear & Service Since 1972',
  );
  raw = raw.replace(/\{\{\s*section\.settings\.giant_word[^}]*\}\}/g, 'SINCE 1972');
  raw = raw.replace(/\{\{\s*tarmac_price\s*\}\}/g, '2,799.99');
  raw = raw.replace(/\{\{\s*tarmac_url\s*\}\}/g, '#finder');
  raw = raw.replace(/\{\{\s*shop\.name[^}]*\}\}/g, 'University Bicycle Center');
  raw = raw.replace(/\{\{\s*cart\.item_count\s*\}\}/g, '0');
  raw = raw.replace(/\{\{\s*'now'\s*\|\s*date:\s*'%Y'\s*\}\}/g, '2026');
  raw = raw.replace(/\{\{\s*routes\.[a-z_]+\s*\}\}/g, '#new-arrivals');
  raw = raw.replace(/\{%[\s\S]*?%\}/g, '');
  raw = raw.replace(/\{\{[\s\S]*?\}\}/g, '');

  if (f === 'fable-header.liquid') {
    raw = `<div class="shopify-section-fable-header preview-header-sticky">${raw}</div>`;
  }

  return raw;
}

async function appendGlobalSnippets(bodyHtml, opts) {
  const ikRaw = await readFile(join(dirFable, 'snippets', 'ubc-ikeono-widget.liquid'), 'utf8');
  bodyHtml += compileFableSection('ubc-ikeono-widget.liquid', ikRaw, opts) + '\n';
  const reelRaw = await readFile(join(dirFable, 'snippets', 'ubc-reel-modal.liquid'), 'utf8');
  bodyHtml += compileFableSection('ubc-reel-modal.liquid', reelRaw, opts) + '\n';
  return bodyHtml;
}

async function renderFablePage(edition = 'classic') {
  const secFiles = [
    'fable-header.liquid',
    'fable-hero-showcase.liquid',
    'fable-new-arrivals.liquid',
    'fable-workshop-pro.liquid',
    'fable-bike-finder.liquid',
    'fable-family-story.liquid',
    'fable-service-rentals-stores.liquid',
    'fable-store-locator.liquid',
    'fable-footer.liquid',
  ];

  let bodyHtml = '';
  for (const f of secFiles) {
    const raw = await readFile(join(dirFable, 'sections', f), 'utf8');
    bodyHtml += compileFableSection(f, raw, { isStandalonePage: false, isOurStoryPage: false, edition }) + '\n';
  }
  bodyHtml = await appendGlobalSnippets(bodyHtml, { isStandalonePage: false, edition });

  const titles = {
    classic: 'UBC Dawn v23 Classic — University Bicycle Center',
    black_friday: 'UBC Dawn v23 Black Friday — University Bicycle Center',
    christmas: 'UBC Dawn v23 Christmas / Navidad — University Bicycle Center',
    july_4: 'UBC Dawn v23 July 4th Summer Event — University Bicycle Center',
  };
  return wrapFableDocument(titles[edition] || titles.classic, edition, bodyHtml, edition);
}

async function renderFableOurStoryPage() {
  const secFiles = [
    'fable-header.liquid',
    'fable-family-story.liquid',
    'fable-workshop-pro.liquid',
    'fable-store-locator.liquid',
    'fable-footer.liquid',
  ];

  let bodyHtml = '';
  for (const f of secFiles) {
    const raw = await readFile(join(dirFable, 'sections', f), 'utf8');
    bodyHtml += compileFableSection(f, raw, {
      isStandalonePage: true,
      isOurStoryPage: f === 'fable-family-story.liquid',
      edition: 'classic',
    }) + '\n';
  }
  bodyHtml = await appendGlobalSnippets(bodyHtml, { isStandalonePage: true, edition: 'classic' });

  return wrapFableDocument('Our Story & 8 Shop Reels · University Bicycle Center (v23)', 'our_story', bodyHtml, 'classic');
}

async function renderFableLocationsPage() {
  const secFiles = [
    'fable-header.liquid',
    'fable-store-locator.liquid',
    'fable-footer.liquid',
  ];

  let bodyHtml = '';
  for (const f of secFiles) {
    const raw = await readFile(join(dirFable, 'sections', f), 'utf8');
    bodyHtml += compileFableSection(f, raw, { isStandalonePage: true, edition: 'classic' }) + '\n';
  }
  bodyHtml = await appendGlobalSnippets(bodyHtml, { isStandalonePage: true, edition: 'classic' });

  return wrapFableDocument('Store Locator · University Bicycle Center (v23)', 'locations', bodyHtml, 'classic');
}

function renderLanding() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>UBC Dawn Themes v24 — Temas Auto-Activables en Shopify + Paletas Estacionales Completas</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #111315; color: #fefdf3; min-height: 100vh; display: grid; place-items: center; padding: 32px 20px; }
    .wrap { max-width: 1180px; width: 100%; display: grid; gap: 24px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    .card { background: #1a1d21; border: 1px solid rgba(254,253,243,0.14); border-radius: 22px; padding: 24px; display: flex; flex-direction: column; justify-content: space-between; gap: 16px; }
    .badge { display: inline-block; width: fit-content; padding: 4px 12px; border-radius: 999px; font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
    h1 { margin: 0; font-size: clamp(24px, 3.2vw, 32px); }
    h2 { margin: 0; font-size: 20px; }
    p { margin: 0; color: #b2b8c2; line-height: 1.55; font-size: 14px; }
    .btns { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn { padding: 10px 16px; border-radius: 999px; font-weight: 700; text-decoration: none; font-size: 13px; display: inline-flex; align-items: center; gap: 8px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div>
      <span class="badge" style="background:#ccbb8d;color:#14202d;">Shopify Dawn 16.1.1 &middot; Online Store 2.0 &middot; v24</span>
      <h1 style="margin-top:10px;">University Bicycle Center — 4 Ediciones Auto-Activables en Shopify (v24)</h1>
      <p style="margin-top:6px;">Cada archivo ZIP incluye <code>settings_data.json</code> con objeto nativo OS 2.0 <code>"current": { ... }</code>, defaults Liquid/JS dedicados por ocasión y paletas completas de principio a fin.</p>
    </div>
    <div class="cards">
      <div class="card" style="border-color:rgba(204,187,141,0.55);">
        <div style="display:grid;gap:10px;">
          <span class="badge" style="background:rgba(204,187,141,0.2);color:#ccbb8d;">Edición 1 &middot; Crema + Navy + Oro</span>
          <h2>UBC Classic Edition (v24)</h2>
          <p>Paleta oficial UBC (<code>#FEFDF3</code>, <code>#213549</code>, <code>#CCBB8D</code>, <code>#E04F33</code>), menús <code>link_list</code> editables, teléfonos dinámicos y financiamiento en 4 columnas.</p>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <a class="btn" style="background:#e04f33;color:#fff;" href="/fable">Ver Classic &rarr;</a>
          <a class="btn" style="background:#ccbb8d;color:#14202d;" href="/download/ubc-fable-dawn-v24.zip">ZIP v24</a>
        </div>
      </div>
      <div class="card" style="border-color:rgba(255,77,41,0.55);">
        <div style="display:grid;gap:10px;">
          <span class="badge" style="background:rgba(255,77,41,0.22);color:#ff9b87;">Edición 2 &middot; Obsidiana + Blaze + Oro</span>
          <h2>Black Friday (v24)</h2>
          <p>Paleta Black Friday completa (<code>#070B10</code>, <code>#FF4D29</code>, <code>#E4C773</code>, superficies platino <code>#F1F3F6</code>), franja de marcas obsidiana, doorbusters y precios tachados.</p>
        </div>
        <div class="btns">
          <a class="btn" style="background:#ff4d29;color:#fff;" href="/black-friday">Ver Black Friday &rarr;</a>
          <a class="btn" style="background:#ccbb8d;color:#14202d;" href="/download/ubc-fable-dawn-v24-black-friday.zip">ZIP BF</a>
        </div>
      </div>
      <div class="card" style="border-color:rgba(20,56,40,0.85);">
        <div style="display:grid;gap:10px;">
          <span class="badge" style="background:rgba(20,56,40,0.85);color:#dfc47e;">Edición 3 &middot; Evergreen + Carmesí + Oro</span>
          <h2>Navidad / Holiday (v24)</h2>
          <p>Paleta navideña Pino Evergreen (<code>#143B2A</code>), franja Rojo Carmesí (<code>#9E1F1B</code>), Oro Festivo (<code>#E2C578</code>) y Salvia Invernal (<code>#DFEBE2</code>), apartado gratis y regalos.</p>
        </div>
        <div class="btns">
          <a class="btn" style="background:#143828;border:1px solid #dfc47e;color:#fff;" href="/christmas">Ver Navidad &rarr;</a>
          <a class="btn" style="background:#ccbb8d;color:#14202d;" href="/download/ubc-fable-dawn-v24-christmas.zip">ZIP Navidad</a>
        </div>
      </div>
      <div class="card" style="border-color:rgba(23,55,102,0.85);">
        <div style="display:grid;gap:10px;">
          <span class="badge" style="background:#173766;color:#e5c878;">Edición 4 &middot; Azul Patriota + Rojo + Hielo</span>
          <h2>July 4th + Historia (v24)</h2>
          <p>Paleta 4 de Julio (<code>#16386B</code>, franja Rojo Señal <code>#B51D1D</code>, Hielo Costero <code>#DBE7F8</code>) + descarga directa de su ZIP auto-activable.</p>
        </div>
        <div class="btns">
          <a class="btn" style="background:#173766;color:#fefdf3;" href="/july-4">Ver 4 de Julio &rarr;</a>
          <a class="btn" style="background:#ccbb8d;color:#14202d;" href="/download/ubc-fable-dawn-v24-july-4.zip">ZIP 4 Julio</a>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLanding());
      return;
    }
    if (p === '/boutique' || p === '/boutique/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderBoutiquePage());
      return;
    }
    if (p === '/fable' || p === '/fable/' || p === '/classic' || p === '/classic/') {
      const html = await renderFablePage('classic');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (p === '/black-friday' || p === '/black-friday/') {
      const html = await renderFablePage('black_friday');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (p === '/christmas' || p === '/christmas/' || p === '/navidad' || p === '/navidad/') {
      const html = await renderFablePage('christmas');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (p === '/july-4' || p === '/july-4/' || p === '/4-de-julio' || p === '/4-de-julio/') {
      const html = await renderFablePage('july_4');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (p === '/our-story' || p === '/our-story/' || p === '/pages/our-story' || p === '/pages/our-story/') {
      const html = await renderFableOurStoryPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (p === '/locations' || p === '/locations/' || p === '/pages/locations' || p === '/pages/locations/') {
      const html = await renderFableLocationsPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (p.startsWith('/assets/boutique/')) {
      const name = p.replace('/assets/boutique/', '');
      const fp = join(dirBoutique, 'assets', name);
      if (existsSync(fp)) {
        const buf = await readFile(fp);
        res.writeHead(200, { 'Content-Type': MIME[extname(name).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
        return;
      }
    }
    if (p.startsWith('/assets/fable/')) {
      const name = p.replace('/assets/fable/', '');
      const fp = join(dirFable, 'assets', name);
      if (existsSync(fp)) {
        const buf = await readFile(fp);
        res.writeHead(200, { 'Content-Type': MIME[extname(name).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
        return;
      }
    }
    if (p.startsWith('/download/')) {
      const name = p.replace('/download/', '');
      if ([
        'ubc-boutique-dawn-v11.zip',
        'ubc-fable-dawn-v12.zip',
        'ubc-fable-dawn-v13.zip',
        'ubc-fable-dawn-v14.zip',
        'ubc-fable-dawn-v15.zip',
        'ubc-fable-dawn-v16.zip',
        'ubc-fable-dawn-v17.zip',
        'ubc-fable-dawn-v18.zip',
        'ubc-fable-dawn-v19.zip',
        'ubc-fable-dawn-v20.zip',
        'ubc-fable-dawn-v20-black-friday.zip',
        'ubc-fable-dawn-v20-christmas.zip',
        'ubc-fable-dawn-v21.zip',
        'ubc-fable-dawn-v21-black-friday.zip',
        'ubc-fable-dawn-v21-christmas.zip',
        'ubc-fable-dawn-v21-july-4.zip',
        'ubc-fable-dawn-v22.zip',
        'ubc-fable-dawn-v22-black-friday.zip',
        'ubc-fable-dawn-v22-christmas.zip',
        'ubc-fable-dawn-v22-july-4.zip',
        'ubc-fable-dawn-v23.zip',
        'ubc-fable-dawn-v23-black-friday.zip',
        'ubc-fable-dawn-v23-christmas.zip',
        'ubc-fable-dawn-v23-july-4.zip',
        'ubc-fable-dawn-v24.zip',
        'ubc-fable-dawn-v24-black-friday.zip',
        'ubc-fable-dawn-v24-christmas.zip',
        'ubc-fable-dawn-v24-july-4.zip',
      ].includes(name)) {
        const fp = resolve(root, 'build', name);
        if (existsSync(fp)) {
          const buf = await readFile(fp);
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${name}"`,
          });
          res.end(buf);
          return;
        }
      }
    }
    if (p === '/cart/add.js' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 200, sections: {} }));
      return;
    }
    if (p === '/cart.js') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ item_count: 1 }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`UBC Dawn Themes v21 Preview Server listening at http://localhost:${PORT}`);
  console.log(`  -> Selector (4 Editions) : http://localhost:${PORT}/`);
  console.log(`  -> Classic Edition (v21) : http://localhost:${PORT}/fable`);
  console.log(`  -> Black Friday (v21)    : http://localhost:${PORT}/black-friday`);
  console.log(`  -> Christmas (v21)       : http://localhost:${PORT}/christmas`);
  console.log(`  -> July 4th (v21)        : http://localhost:${PORT}/july-4`);
  console.log(`  -> Our Story + 8 Reels   : http://localhost:${PORT}/our-story`);
  console.log(`  -> Store Locator Page    : http://localhost:${PORT}/locations`);
});
