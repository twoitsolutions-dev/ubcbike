/* ==========================================================================
   UBC Dawn Ecommerce v17 — Storefront Controller (ES5 Compatible)
   Full v12 Hero Showcase Choreography + Mosaic + Finder + Pro-Shop + Hybrid Store Locator
   Dawn Cart Drawer AJAX · Official UBC Palette + Coral · Zero Emojis
   ========================================================================== */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }
  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function money(num) {
    var n = Number(num) || 0;
    return '$' + n.toLocaleString('en-US', {
      minimumFractionDigits: n % 1 ? 2 : 0,
      maximumFractionDigits: 2
    });
  }
  function parseJsonEl(id) {
    var el = document.getElementById(id);
    if (!el) return [];
    try {
      return JSON.parse(el.textContent || '[]');
    } catch (e) {
      return [];
    }
  }

  var edition = (document.body && document.body.getAttribute('data-ubc-edition')) || 'classic';
  var htmlLang = ((document.documentElement && document.documentElement.getAttribute('lang')) || '').toLowerCase();
  var ubcLoc = window.__ubcLocale || {};
  var nativeIsEs = htmlLang.indexOf('es') === 0 || (ubcLoc.current || '').toLowerCase().indexOf('es') === 0;
  var lang = nativeIsEs ? 'es' : 'en';
  try {
    var savedLang = localStorage.getItem('ubc-lang');
    if (ubcLoc.hasEs) {
      lang = nativeIsEs ? 'es' : 'en';
      localStorage.setItem('ubc-lang', lang);
    } else if (nativeIsEs) {
      lang = 'es';
    } else if (savedLang === 'es' || savedLang === 'en') {
      lang = savedLang;
    }
  } catch (e) {}

  var COPY = {
    en: {
      inStock: 'In Stock · Tampa',
      pickup: 'Free Pickup',
      order: 'Special Order',
      days: 'd',
      addBag: 'Add to Bag',
      added: 'Added',
      viewBike: 'View Bike',
      shopGear: 'Shop',
      specs: 'Specs',
      hideSpecs: 'Hide',
      matches: 'models available',
      noBikes: 'No bikes under that maximum price.',
      noBikesSub: 'Raise the price slider above to view higher-spec builds.',
      noGear: 'No matching equipment found.',
      noGearSub: 'Clear the search filter or switch department tabs.',
      openNow: 'Open Now · Closes ',
      closedNow: 'Closed · Opens ',
      closedLabel: 'Closed',
      directions: 'Get Directions',
      fromPrefix: 'Distance from: ',
      locating: 'Locating…',
      locDenied: 'GPS unavailable — choose an area from the menu',
      nearMeOrigin: 'Your Live GPS Location',
      flagshipPill: 'Main Showroom',
      parkPill: 'Trailhead Park',
      milesAway: ' mi',
      minDrive: ' min drive',
      showAllGear: 'Show All {total} Pro-Shop Items (+{extra})',
      showLessGear: 'Show Fewer Items',
      showMoreNa: 'Show {extra} More Items',
      showLessNa: 'Show Fewer Items',
      storeHours: 'Store Hours'
    },
    es: {
      inStock: 'En Stock · Tampa',
      pickup: 'Retiro Gratis',
      order: 'Pedido Especial',
      days: 'd',
      addBag: 'Agregar',
      added: 'Agregado',
      viewBike: 'Ver Bici',
      shopGear: 'Ver',
      specs: 'Ficha',
      hideSpecs: 'Cerrar',
      matches: 'modelos disponibles',
      noBikes: 'No hay modelos bajo ese presupuesto.',
      noBikesSub: 'Aumenta el rango de precio para ver más opciones.',
      noGear: 'No encontramos artículos con ese filtro.',
      noGearSub: 'Limpia el buscador o cambia de departamento.',
      openNow: 'Abierto · Cierra ',
      closedNow: 'Cerrado · Abre ',
      closedLabel: 'Cerrado',
      directions: 'Cómo Llegar',
      fromPrefix: 'Distancia desde: ',
      locating: 'Ubicando…',
      locDenied: 'GPS no disponible — elige tu zona en el menú',
      nearMeOrigin: 'Tu ubicación GPS actual',
      flagshipPill: 'Tienda Principal',
      parkPill: 'Parque Estatal',
      milesAway: ' mi',
      minDrive: ' min en auto',
      showAllGear: 'Ver los {total} artículos Pro-Shop (+{extra})',
      showLessGear: 'Mostrar menos',
      showMoreNa: 'Mostrar {extra} artículos más',
      showLessNa: 'Mostrar menos artículos',
      storeHours: 'Horarios de tienda'
    }
  };

  function resolveItemPricing(item) {
    var base = Number(item.p) || 0;
    var active = base;
    var compare = Number(item.compareAt) || 0;
    if (edition === 'black_friday' && item.bfPrice && item.bfPrice < base) {
      active = item.bfPrice;
      compare = base;
    } else if (edition === 'christmas' && item.xmasPrice && item.xmasPrice < base) {
      active = item.xmasPrice;
      compare = base;
    } else if (edition === 'july_4' && item.julyPrice && item.julyPrice < base) {
      active = item.julyPrice;
      compare = base;
    } else if (edition === 'spring' && (item.julyPrice || item.xmasPrice) && (item.julyPrice || item.xmasPrice) < base) {
      active = item.julyPrice || item.xmasPrice;
      compare = base;
    } else if (edition === 'campus' && (item.xmasPrice || item.julyPrice) && (item.xmasPrice || item.julyPrice) < base) {
      active = item.xmasPrice || item.julyPrice;
      compare = base;
    } else if (edition === 'veterans' && (item.julyPrice || item.xmasPrice) && (item.julyPrice || item.xmasPrice) < base) {
      active = item.julyPrice || item.xmasPrice;
      compare = base;
    } else if (item.promoPrice && item.promoPrice < base) {
      active = item.promoPrice;
      compare = base;
    }
    return { active: active, compare: compare > active ? compare : 0 };
  }

  var RIDES = {
    electric: {
      en: 'Electric Bikes',
      es: 'Bicicletas Eléctricas',
      noteEn: 'Smooth pedal-assist commuters, lightweight carbon road e-bikes and step-through cruisers.',
      noteEs: 'Asistencia suave para ciudad, ruta ligera en carbono y paseo ergonómico.'
    },
    road: {
      en: 'Road & Gravel Bikes',
      es: 'Bicicletas de Ruta y Gravel',
      noteEn: 'Aerodynamic carbon race frames, endurance road builds and all-road steel.',
      noteEs: 'Cuadros aerodinámicos de carbono, resistencia en pavimento y acero all-road.'
    },
    mtb: {
      en: 'Mountain & Trail Bikes',
      es: 'Bicicletas de Montaña y Trail',
      noteEn: 'Full-suspension XC and trail hardtails ready for Alafia River, Balm-Boyette and Santos.',
      noteEs: 'Doble suspensión y rígidas listas para Alafia River, Balm-Boyette y Santos.'
    },
    fitness: {
      en: 'Hybrid & Fitness Bikes',
      es: 'Bicicletas Híbridas y Fitness',
      noteEn: 'Fast flat-bar geometry for Bayshore bike lanes, greenways and daily exercise.',
      noteEs: 'Geometría ágil de manubrio plano para ciclovías de Tampa y entrenamiento diario.'
    },
    cruise: {
      en: 'Comfort & Cruisers',
      es: 'Confort y Paseo',
      noteEn: 'Relaxed upright posture, low step-through frames and plush saddles.',
      noteEs: 'Postura erguida relajada, cuadros de fácil acceso y sillines cómodos.'
    }
  };

  /* ---------- 1. Scroll Progress, Sticky Header, Ghost Scrub & Reveal ---------- */
  var progressEl = document.getElementById('fbProgress');
  var headerEl = document.getElementById('fbHeader');
  var showElForScroll = document.getElementById('show');
  var showGhostForScroll = document.getElementById('showGhost');
  var rentElForScroll = document.getElementById('rentals');
  var rentGhostForScroll = rentElForScroll ? qs('.rent-ghost', rentElForScroll) : null;
  var sysReducedMotion = false;
  try {
    sysReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  function onScroll() {
    var y = window.scrollY || window.pageYOffset || 0;
    if (progressEl) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
      progressEl.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';
    }
    if (headerEl) {
      headerEl.classList.toggle('scrolled', y > 16);
    }
    if (!sysReducedMotion && showElForScroll && showGhostForScroll) {
      var rect = showElForScroll.getBoundingClientRect();
      var h = rect.height || 1;
      if (rect.bottom > 0 && rect.top < window.innerHeight) {
        var passed = Math.min(1, Math.max(0, -rect.top / h));
        showGhostForScroll.style.translate = '0 ' + (passed * 56).toFixed(1) + '%';
      }
    }
    if (!sysReducedMotion && rentElForScroll && rentGhostForScroll) {
      var rRect = rentElForScroll.getBoundingClientRect();
      var rH = rRect.height || 1;
      if (rRect.bottom > 0 && rRect.top < window.innerHeight) {
        var rProg = (window.innerHeight - rRect.top) / (window.innerHeight + rH);
        var rShift = (rProg - 0.5) * 36;
        rentGhostForScroll.style.translate = '0 ' + rShift.toFixed(1) + '%';
      }
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  var revealEls = qsa('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -24px 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- 2. Topbar Announcement Rotator ---------- */
  var topMsgs = qsa('#fbTopMsgs > span');
  if (topMsgs.length > 1) {
    var msgIdx = 0;
    setInterval(function () {
      topMsgs[msgIdx].classList.remove('on');
      msgIdx = (msgIdx + 1) % topMsgs.length;
      topMsgs[msgIdx].classList.add('on');
    }, 4800);
  }

  /* ---------- 3. Mega-Menu (Multi-Dropdown link_list Ready), Search Popover & Mobile Drawer ---------- */
  var megaItems = qsa('.has-mega');
  var searchBtn = document.getElementById('fbSearchBtn');
  var searchPop = document.getElementById('fbSearchPop');
  var searchInput = document.getElementById('fbQ');
  var burgerBtn = document.getElementById('fbBurger');
  var drawerEl = document.getElementById('fbDrawer');
  var drawerClose = document.getElementById('fbDrawerClose');

  function closeMenus() {
    megaItems.forEach(function (li) {
      li.classList.remove('open');
      var b = qs('button', li);
      if (b) b.setAttribute('aria-expanded', 'false');
    });
    if (searchPop && searchBtn) {
      searchPop.classList.remove('open');
      searchBtn.setAttribute('aria-expanded', 'false');
    }
  }

  function closeDrawer() {
    if (drawerEl) {
      drawerEl.classList.remove('open');
      drawerEl.setAttribute('aria-hidden', 'true');
    }
    if (burgerBtn) {
      burgerBtn.setAttribute('aria-expanded', 'false');
    }
    if (document.body) {
      document.body.style.overflow = '';
    }
  }

  megaItems.forEach(function (li) {
    var btn = qs('button', li);
    if (!btn) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var next = !li.classList.contains('open');
      closeMenus();
      if (next) {
        li.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });

  if (searchBtn && searchPop) {
    searchBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var next = !searchPop.classList.contains('open');
      closeMenus();
      if (next) {
        searchPop.classList.add('open');
        searchBtn.setAttribute('aria-expanded', 'true');
        if (searchInput) setTimeout(function () { searchInput.focus(); }, 40);
      }
    });
  }

  document.addEventListener('click', function (e) {
    var insideMega = megaItems.some(function (li) { return li.classList.contains('open') && li.contains(e.target); });
    if (!insideMega && megaItems.some(function (li) { return li.classList.contains('open'); })) {
      closeMenus();
    }
    if (searchPop && searchPop.classList.contains('open') && !searchPop.contains(e.target) && (!searchBtn || !searchBtn.contains(e.target))) {
      closeMenus();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeMenus();
      closeDrawer();
    }
  });

  if (burgerBtn && drawerEl) {
    burgerBtn.addEventListener('click', function () {
      drawerEl.classList.add('open');
      drawerEl.setAttribute('aria-hidden', 'false');
      burgerBtn.setAttribute('aria-expanded', 'true');
      if (document.body) {
        document.body.style.overflow = 'hidden';
      }
    });
  }
  if (drawerClose) {
    drawerClose.addEventListener('click', closeDrawer);
  }
  qsa('#fbDrawer a, #megaBikes a, #fbSearchPop .fb-search-tags a').forEach(function (a) {
    a.addEventListener('click', function () {
      closeMenus();
      closeDrawer();
    });
  });

  /* ---------- 4. Native Shopify Dawn Cart Drawer AJAX Integration ---------- */
  function syncFableCartBadge() {
    fetch((window.routes && window.routes.cart_url ? window.routes.cart_url : '/cart') + '.js')
      .then(function (r) { return r.json(); })
      .then(function (cart) {
        var badge = document.getElementById('fable-cart-count');
        if (!badge || !cart || typeof cart.item_count !== 'number') return;
        badge.textContent = String(cart.item_count);
        if (cart.item_count > 0) {
          badge.removeAttribute('hidden');
        } else {
          badge.setAttribute('hidden', '');
        }
      })
      .catch(function () {});
  }

  var cartTrigger = qs('[data-fable-cart-trigger]');
  if (cartTrigger) {
    cartTrigger.addEventListener('click', function (e) {
      var drawer = qs('cart-drawer');
      if (drawer && typeof drawer.open === 'function') {
        e.preventDefault();
        closeMenus();
        closeDrawer();
        drawer.open(cartTrigger);
      }
    });
    cartTrigger.addEventListener('keydown', function (e) {
      if (e.code && e.code.toUpperCase() === 'SPACE') {
        var drawer = qs('cart-drawer');
        if (drawer && typeof drawer.open === 'function') {
          e.preventDefault();
          closeMenus();
          closeDrawer();
          drawer.open(cartTrigger);
        }
      }
    });
  }

  if (typeof window.subscribe === 'function' && window.PUB_SUB_EVENTS && window.PUB_SUB_EVENTS.cartUpdate) {
    window.subscribe(window.PUB_SUB_EVENTS.cartUpdate, function () {
      syncFableCartBadge();
    });
  }

  function addVariantToDawnCart(variantId, btnEl, itemName) {
    if (!variantId) return false;
    var t = COPY[lang];
    var origHtml = btnEl.innerHTML;
    btnEl.disabled = true;

    var cartDrawer = qs('cart-drawer');
    var payload = {
      items: [{ id: Number(variantId), quantity: 1 }]
    };
    if (cartDrawer && typeof cartDrawer.getSectionsToRender === 'function') {
      payload.sections = cartDrawer.getSectionsToRender().map(function (s) { return s.id; });
      payload.sections_url = window.location.pathname;
    }

    var cartAddUrl = (window.routes && window.routes.cart_add_url ? window.routes.cart_add_url : '/cart/add') + '.js';
    fetch(cartAddUrl.replace(/\.js\.js$/, '.js'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        btnEl.innerHTML = '<span>' + esc(t.added) + '</span>';
        if (typeof window.__addPreviewBag === 'function') {
          window.__addPreviewBag(itemName || 'Item');
        }
        if (cartDrawer && res && res.sections && typeof cartDrawer.renderContents === 'function') {
          cartDrawer.classList.remove('is-empty');
          var cdi = qs('cart-drawer-items', cartDrawer);
          if (cdi) cdi.classList.remove('is-empty');
          var itemRow = res.items && res.items[0] ? res.items[0] : res;
          cartDrawer.renderContents({
            id: itemRow && itemRow.id ? itemRow.id : Number(variantId),
            sections: res.sections
          });
        }
        syncFableCartBadge();
        setTimeout(function () {
          btnEl.disabled = false;
          btnEl.innerHTML = origHtml;
        }, 1200);
      })
      .catch(function () {
        btnEl.disabled = false;
        btnEl.innerHTML = origHtml;
      });

    return true;
  }

  /* ---------- 5. Official Brand Marquee Seamless Clone ---------- */
  var marqueeTrack = document.getElementById('fbMarquee');
  if (marqueeTrack && !marqueeTrack.dataset.cloned) {
    marqueeTrack.dataset.cloned = '1';
    marqueeTrack.innerHTML = marqueeTrack.innerHTML + marqueeTrack.innerHTML;
  }

  /* ---------- 6. v12 Hero Bike & E-Bike Showcase (Full v12 Choreography Restored) ---------- */
  var heroData = parseJsonEl('FableHeroData');
  var showSec = document.getElementById('show');
  var showStage = document.getElementById('showStage');
  var showImg = document.getElementById('showImg');
  var showGhost = document.getElementById('showGhost');
  var showBlob = document.getElementById('showBlob');
  var showThumbs = document.getElementById('showThumbs');
  var heroIdx = 0;
  var heroTimer = null;
  var heroSwapTimeout = null;
  var canHoverFine = false;
  try {
    canHoverFine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch (e) {}

  function applyHeroContent(item) {
    var k = lang === 'es' ? 1 : 0;
    var t = COPY[lang];
    var catEl = document.getElementById('showCat');
    var nameEl = document.getElementById('showName');
    var descEl = document.getElementById('showDesc');
    var priceEl = document.getElementById('showPrice');
    var compareEl = document.getElementById('showCompare');
    var linkEl = document.getElementById('showLink');
    var primaryTxtEl = document.getElementById('showPrimaryTxt');
    var countEl = document.getElementById('showIdx');
    var stockEl = document.getElementById('showStock');

    if (catEl && item.cat) catEl.textContent = item.cat[k] || item.cat[0];
    if (nameEl) nameEl.textContent = item.n;
    if (descEl && item.d) descEl.textContent = item.d[k] || item.d[0];

    var heroPricing = resolveItemPricing(item);
    if (priceEl) priceEl.textContent = money(heroPricing.active);
    if (compareEl) {
      if (heroPricing.compare) {
        compareEl.textContent = money(heroPricing.compare);
        compareEl.removeAttribute('hidden');
      } else {
        compareEl.textContent = '';
        compareEl.setAttribute('hidden', 'hidden');
      }
    }

    if (linkEl && item.u) linkEl.href = item.u;
    if (primaryTxtEl) {
      var ctaLabel = item.cta ? (item.cta[k] || item.cta[0]) : t.viewBike;
      primaryTxtEl.textContent = ctaLabel;
    }
    if (countEl) countEl.textContent = String(heroIdx + 1).padStart(2, '0');

    var ghostWord = item.g || (item.b ? String(item.b).toUpperCase() : 'UBC');
    if (showGhost) {
      showGhost.textContent = ghostWord;
      showGhost.style.setProperty('--len', String(Math.max(5, ghostWord.length)));
    }
    if (showSec) {
      showSec.style.setProperty('--len', String(Math.max(5, ghostWord.length)));
    }
    if (showBlob) {
      showBlob.style.setProperty('--c', item.c || '#ccbb8d');
    }

    if (stockEl) {
      if (item.availability === 'special_order') {
        stockEl.className = 'stock-pill is-order';
        stockEl.innerHTML = '<i aria-hidden="true"></i> <span>' + esc(t.order + (item.leadDays ? ' · ' + item.leadDays + t.days : '')) + '</span>';
      } else {
        stockEl.className = 'stock-pill';
        stockEl.innerHTML = '<i aria-hidden="true"></i> <span>' + esc(t.inStock) + '</span>';
      }
    }

    if (showImg && item.img) {
      showImg.src = item.img;
      showImg.alt = item.b + ' ' + item.n;
    }

    if (showThumbs) {
      qsa('button', showThumbs).forEach(function (b, i) {
        b.setAttribute('aria-current', i === heroIdx ? 'true' : 'false');
      });
    }
  }

  function renderHeroSlide(idx, immediate, forcedDir) {
    if (!heroData.length) return;
    var nextIdx = (idx + heroData.length) % heroData.length;
    var item = heroData[nextIdx];

    if (immediate || !showSec) {
      heroIdx = nextIdx;
      applyHeroContent(item);
      if (showSec) {
        showSec.classList.remove('swap');
        showSec.classList.remove('pre');
      }
      return;
    }

    if (nextIdx === heroIdx && !heroSwapTimeout) return;

    var dir = forcedDir != null ? forcedDir : (nextIdx > heroIdx ? 1 : -1);
    if (heroIdx === heroData.length - 1 && nextIdx === 0 && forcedDir == null) dir = 1;
    if (heroIdx === 0 && nextIdx === heroData.length - 1 && forcedDir == null) dir = -1;

    heroIdx = nextIdx;
    showSec.classList.add('has-interacted');
    showSec.style.setProperty('--dir', String(dir));

    if (heroSwapTimeout) {
      clearTimeout(heroSwapTimeout);
      heroSwapTimeout = null;
    }

    // Update active thumbnail immediately so progress bar & selection respond on click
    if (showThumbs) {
      qsa('button', showThumbs).forEach(function (b, i) {
        b.setAttribute('aria-current', i === heroIdx ? 'true' : 'false');
      });
    }

    showSec.classList.remove('pre');
    showSec.classList.add('swap');

    // Preload next bike image while current bike rolls out (-14%, -4deg)
    var preImg = new Image();
    var settled = false;
    function finishSwap() {
      if (settled) return;
      settled = true;
      applyHeroContent(item);
      showSec.classList.add('pre');
      showSec.classList.remove('swap');
      if (showImg) {
        // Force layout so .pre (+14%, +4deg, transition:none) commits before gliding in
        void showImg.offsetWidth;
      }
      showSec.classList.remove('pre');
      heroSwapTimeout = null;
    }

    var imgReady = false;
    var minElapsed = false;
    preImg.onload = preImg.onerror = function () {
      imgReady = true;
      if (minElapsed) finishSwap();
    };
    preImg.src = item.img;

    heroSwapTimeout = setTimeout(function () {
      minElapsed = true;
      if (imgReady || preImg.complete) {
        finishSwap();
      } else {
        setTimeout(finishSwap, 450);
      }
    }, 360);
  }

  function resetHeroAuto() {
    if (heroTimer) clearInterval(heroTimer);
    if (showSec) {
      showSec.classList.remove('auto');
      void showSec.offsetWidth;
      showSec.classList.add('auto');
    }
    heroTimer = setInterval(function () {
      renderHeroSlide(heroIdx + 1, false, 1);
    }, 6500);
  }

  if (heroData.length && showThumbs) {
    showThumbs.innerHTML = heroData.map(function (item, i) {
      var barColor = item.c || '#ccbb8d';
      return (
        '<button type="button" style="--c:' + esc(barColor) + '" aria-label="' + esc(item.b + ' ' + item.n) + '" aria-current="' + (i === 0 ? 'true' : 'false') + '">' +
          '<img src="' + esc(item.img) + '" alt="" loading="lazy" draggable="false">' +
        '</button>'
      );
    }).join('');

    qsa('button', showThumbs).forEach(function (btn, i) {
      btn.addEventListener('click', function () {
        if (i === heroIdx) return;
        renderHeroSlide(i, false, i > heroIdx ? 1 : -1);
        resetHeroAuto();
      });
    });

    var prevBtn = document.getElementById('showPrev');
    var nextBtn = document.getElementById('showNext');
    if (prevBtn) {
      prevBtn.addEventListener('click', function () {
        renderHeroSlide(heroIdx - 1, false, -1);
        resetHeroAuto();
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        renderHeroSlide(heroIdx + 1, false, 1);
        resetHeroAuto();
      });
    }

    if (showSec) {
      showSec.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') {
          renderHeroSlide(heroIdx + 1, false, 1);
          resetHeroAuto();
        } else if (e.key === 'ArrowLeft') {
          renderHeroSlide(heroIdx - 1, false, -1);
          resetHeroAuto();
        }
      });
    }

    if (showStage) {
      var stagePointerX = null;
      showStage.addEventListener('pointerdown', function (e) {
        stagePointerX = e.clientX;
        showStage.classList.add('is-dragging');
      });
      window.addEventListener('pointerup', function (e) {
        if (stagePointerX === null) return;
        var dx = e.clientX - stagePointerX;
        stagePointerX = null;
        showStage.classList.remove('is-dragging');
        if (Math.abs(dx) > 50) {
          var dir = dx < 0 ? 1 : -1;
          renderHeroSlide(heroIdx + dir, false, dir);
          resetHeroAuto();
        }
      });

      if (canHoverFine) {
        showStage.addEventListener('pointermove', function (e) {
          var r = showStage.getBoundingClientRect();
          if (!r.width || !r.height) return;
          var x = (e.clientX - r.left) / r.width - 0.5;
          var y = (e.clientY - r.top) / r.height - 0.5;
          if (showImg) showImg.style.translate = (x * 18).toFixed(1) + 'px ' + (y * 12).toFixed(1) + 'px';
          if (showBlob) showBlob.style.translate = (x * -26).toFixed(1) + 'px ' + (y * -18).toFixed(1) + 'px';
        });
        showStage.addEventListener('pointerleave', function () {
          if (showImg) showImg.style.translate = '';
          if (showBlob) showBlob.style.translate = '';
        });
      }
    }

    renderHeroSlide(0, true, 1);
    resetHeroAuto();
  }

  /* v12 Magnetic Hero CTA Buttons & Statband Number Counters */
  if (canHoverFine) {
    qsa('.hero-cta .magnetic').forEach(function (el) {
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        var dx = (e.clientX - r.left - r.width / 2) * 0.22;
        var dy = (e.clientY - r.top - r.height / 2) * 0.3;
        el.style.translate = dx.toFixed(1) + 'px ' + dy.toFixed(1) + 'px';
      });
      el.addEventListener('pointerleave', function () {
        el.style.translate = '';
      });
    });
  }

  function animateStatCounter(el) {
    var end = Number(el.getAttribute('data-count')) || 0;
    var isPlain = el.hasAttribute('data-plain');
    var start = isPlain ? Math.max(0, end - 54) : 0;
    var dur = 1600;
    var t0 = window.performance && window.performance.now ? window.performance.now() : Date.now();

    function step(nowTs) {
      var now = nowTs || Date.now();
      var k = Math.min(1, Math.max(0, (now - t0) / dur));
      var eased = 1 - Math.pow(1 - k, 4);
      var val = Math.round(start + (end - start) * eased);
      el.textContent = isPlain ? String(val) : val.toLocaleString('en-US');
      if (k < 1) {
        window.requestAnimationFrame(step);
      }
    }
    window.requestAnimationFrame(step);
  }

  var statCountEls = qsa('[data-count]');
  if (statCountEls.length) {
    if ('IntersectionObserver' in window) {
      var countIo = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            animateStatCounter(entry.target);
            countIo.unobserve(entry.target);
          }
        });
      }, { threshold: 0.5 });
      statCountEls.forEach(function (el) { countIo.observe(el); });
    } else {
      statCountEls.forEach(animateStatCounter);
    }
  }

  /* ---------- 7. Shared Ecommerce Card Renderers & New Arrivals ---------- */
  function classifyCardImage(img) {
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    var r = img.naturalWidth / img.naturalHeight;
    img.setAttribute('data-img-shape', r >= 1.38 ? 'wide' : r >= 0.82 ? 'square' : 'tall');
  }

  function equalizeCardImages(root) {
    var scope = root || document;
    var imgs = scope.querySelectorAll('.pcard-img img, .gcard-img img, .product-card-wrapper .card__media img');
    for (var i = 0; i < imgs.length; i++) {
      (function (el) {
        if (el.complete && el.naturalWidth) {
          classifyCardImage(el);
        } else if (!el.getAttribute('data-ubc-img-bound')) {
          el.setAttribute('data-ubc-img-bound', '1');
          el.addEventListener('load', function () { classifyCardImage(el); });
        }
      })(imgs[i]);
    }
  }

  function normalizeBikeModelKey(brand, name) {
    var b = String(brand || '').toLowerCase().trim();
    var s = String(name || '').toLowerCase().trim();
    if (b && s.indexOf(b + ' ') === 0) s = s.slice(b.length + 1).trim();
    s = s
      .replace(/\s+[—–-]\s*(xs|s|m|l|xl|xxl|small|medium|large|s\d|\d{2}\s*cm).*$/i, '')
      .replace(/\b(step-through|step-thru|e-bike|complete bike)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    return s;
  }

  var rawCatalog = parseJsonEl('FableCatalogData');
  var gearData = parseJsonEl('FableGearData');
  var newArrivalsData = parseJsonEl('FableNewArrivalsData');
  var seenNames = {};
  var bikesCatalog = rawCatalog.filter(function (x) {
    if (!x || x.kind === 'gear') return false;
    var key = normalizeBikeModelKey(x.b, x.n);
    if (!key || seenNames[key]) return false;
    seenNames[key] = true;
    return true;
  });

  function renderBikeCard(b, isBig) {
    var t = COPY[lang];
    var k = lang === 'es' ? 1 : 0;
    var tags = [];
    if (b.customBadge) {
      var cbCls = b.customBadgeClass || 'ptag--accent';
      tags.push('<span class="ptag ' + esc(cbCls) + '">' + esc(b.customBadge) + '</span>');
    } else if (b.availability === 'special_order') {
      tags.push('<span class="ptag">' + esc(t.order + (b.leadDays ? ' · ' + b.leadDays + t.days : '')) + '</span>');
    } else {
      tags.push('<span class="ptag ptag--stock">' + esc(t.inStock) + '</span>');
    }
    if (b.pickupOnly) {
      tags.push('<span class="ptag ptag--pickup">' + esc(t.pickup) + '</span>');
    } else if (b.badge && b.badge[k] && !b.customBadge) {
      tags.push('<span class="ptag">' + esc(b.badge[k]) + '</span>');
    }

    var canQuickAdd = b.variantId && !b.pickupOnly;
    var viewLabel = b.isGear ? t.shopGear : t.viewBike;
    var cardHref = b.u || '/collections/all';
    var ctaHtml = canQuickAdd
      ? '<button type="button" class="pcard-cta is-add" data-quick-vid="' + esc(b.variantId) + '" data-quick-name="' + esc(b.n) + '"><span>' + esc(t.addBag) + '</span></button>'
      : '<a class="pcard-cta" href="' + esc(cardHref) + '"><span>' + esc(viewLabel) + '</span> <svg><use href="#i-arrow"/></svg></a>';

    var pricing = resolveItemPricing(b);
    var activePrice = pricing.active;
    var comparePrice = pricing.compare;

    var cmpHtml = comparePrice && comparePrice > activePrice ? '<del>' + money(comparePrice) + '</del>' : '';
    var cls = isBig ? 'pcard big' : 'pcard';

    return '<article class="' + cls + '">' +
      '<div class="pcard-tags">' + tags.join('') + '</div>' +
      '<a class="pcard-img" href="' + esc(cardHref) + '"><img src="' + esc(b.img) + '" alt="' + esc(b.b + ' ' + b.n) + '" loading="lazy"></a>' +
      '<span class="pcard-vendor">' + esc(b.b) + '</span>' +
      '<h3 class="pcard-title"><a href="' + esc(cardHref) + '" style="color:inherit;text-decoration:none;">' + esc(b.n) + '</a></h3>' +
      '<div class="pcard-foot">' +
        '<span class="pcard-price">' + money(activePrice) + cmpHtml + '</span>' +
        ctaHtml +
      '</div>' +
      '<a class="cover" href="' + esc(cardHref) + '" aria-label="' + esc(b.b + ' ' + b.n) + '"><span class="visually-hidden">' + esc(b.b + ' ' + b.n) + '</span></a>' +
    '</article>';
  }

  /* ---------- 7B. Unified Storefront Showcase & Promos (#new-arrivals) ---------- */
  var naGrid = document.getElementById('newArrivalsGrid');
  var naSearchInput = document.getElementById('naSearchInput');
  var naMoreWrap = document.getElementById('naMoreWrap');
  var naMoreBtn = document.getElementById('naMoreBtn');
  var naMoreTxt = document.getElementById('naMoreTxt');
  var activeNaCat = 'all';
  var naQuery = '';
  var naExpanded = false;
  var NA_FEATURED_IDS = ['na-propero4', 'na-skratch', 'na-gp5000', 'na-allez-2026', 'na-power-saddle', 'na-vado4', 'na-bell-z20', 'na-mk15-light'];

  function renderNewArrivals() {
    if (!naGrid || !newArrivalsData.length) return;
    var t = COPY[lang];
    var k = lang === 'es' ? 1 : 0;
    var q = naQuery.trim().toLowerCase();
    var pool = [];

    if (activeNaCat === 'all' && !q) {
      // Build a balanced multi-category, multi-brand showcase (1 Helmet, 1 Bike, 1 Tire/Part, 1 Hydration/Fuel...)
      var buckets = {};
      var catOrder = [];
      newArrivalsData.forEach(function (item) {
        var c = item.cat || 'other';
        if (!buckets[c]) { buckets[c] = []; catOrder.push(c); }
        buckets[c].push(item);
      });
      var seenIds = {};
      var round = 0;
      while (pool.length < Math.min(12, newArrivalsData.length) && round < 10) {
        for (var ci = 0; ci < catOrder.length; ci++) {
          var arr = buckets[catOrder[ci]];
          if (arr && arr[round] && !seenIds[arr[round].id]) {
            seenIds[arr[round].id] = true;
            pool.push(arr[round]);
          }
        }
        round++;
      }
    } else if (activeNaCat === 'deals') {
      pool = newArrivalsData.filter(function (item) {
        if (edition === 'black_friday' || edition === 'christmas' || edition === 'july_4') return true;
        return Boolean(item.promo || item.promoPrice);
      });
    } else if (activeNaCat === 'all') {
      pool = newArrivalsData.slice();
    } else {
      pool = newArrivalsData.filter(function (item) {
        return item.cat === activeNaCat;
      });
    }

    if (q) {
      pool = pool.filter(function (item) {
        var hay = ((item.b || '') + ' ' + (item.n || '') + ' ' + (item.cat || '')).toLowerCase();
        return hay.indexOf(q) !== -1;
      });
    }

    if (!pool.length) {
      if (naMoreWrap) naMoreWrap.setAttribute('hidden', 'hidden');
      naGrid.innerHTML = '<div class="empty-state"><strong>' + esc(t.noGear) + '</strong><p class="sub-lead">' + esc(t.noGearSub) + '</p></div>';
      return;
    }

    var canCollapse = pool.length > 4 && !q;
    var list = canCollapse && !naExpanded ? pool.slice(0, 4) : pool.slice(0, 8);

    if (naMoreWrap && naMoreBtn && naMoreTxt) {
      if (canCollapse) {
        var extra = Math.min(8, pool.length) - 4;
        naMoreWrap.removeAttribute('hidden');
        naMoreBtn.setAttribute('aria-expanded', naExpanded ? 'true' : 'false');
        naMoreTxt.textContent = naExpanded ? t.showLessNa : t.showMoreNa.replace('{extra}', String(extra));
      } else {
        naMoreWrap.setAttribute('hidden', 'hidden');
      }
    }

    naGrid.innerHTML = list.map(function (item) {
      var badgeArr = item.tagClassic;
      var badgeCls = 'ptag--accent';
      if (edition === 'black_friday' && item.tagBf) {
        badgeArr = item.tagBf;
        badgeCls = 'ptag--bf';
      } else if (edition === 'christmas' && item.tagXmas) {
        badgeArr = item.tagXmas;
        badgeCls = 'ptag--xmas';
      } else if (edition === 'july_4' && item.tagJuly) {
        badgeArr = item.tagJuly;
        badgeCls = 'ptag--july';
      }
      var cardObj = {
        b: item.b,
        n: item.n,
        p: item.p,
        promoPrice: item.promoPrice,
        bfPrice: item.bfPrice,
        xmasPrice: item.xmasPrice,
        julyPrice: item.julyPrice,
        u: item.u,
        img: item.img,
        variantId: item.variantId,
        pickupOnly: Boolean(item.pickupOnly),
        isGear: item.cat !== 'bikes',
        customBadge: badgeArr ? (badgeArr[k] || badgeArr[0]) : '',
        customBadgeClass: badgeCls
      };
      return renderBikeCard(cardObj, false);
    }).join('');
    equalizeCardImages(naGrid);
  }

  function setNaTab(nextCat) {
    activeNaCat = nextCat || 'all';
    naExpanded = false;
    qsa('#newArrivalsTabs .chip').forEach(function (c) {
      c.setAttribute('aria-pressed', c.getAttribute('data-na-cat') === activeNaCat ? 'true' : 'false');
    });
    renderNewArrivals();
  }

  qsa('#newArrivalsTabs .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      setNaTab(chip.getAttribute('data-na-cat') || 'all');
    });
  });

  if (naSearchInput) {
    naSearchInput.addEventListener('input', function () {
      naQuery = naSearchInput.value || '';
      renderNewArrivals();
    });
  }

  if (naMoreBtn) {
    naMoreBtn.addEventListener('click', function () {
      naExpanded = !naExpanded;
      renderNewArrivals();
    });
  }

  qsa('[data-na-jump]').forEach(function (el) {
    el.addEventListener('click', function () {
      var cat = el.getAttribute('data-na-jump');
      if (cat) setNaTab(cat);
    });
  });

  /* ---------- 8. Balanced Storewide On-the-Floor Grid (#instock) ---------- */
  var stockGrid = document.getElementById('stockGrid');
  var stockCat = 'all';

  function mapGearToStockItem(g) {
    return {
      b: g.b,
      n: g.n,
      p: g.p,
      u: g.u || '#gear',
      img: g.img,
      variantId: g.variantId,
      pickupOnly: false,
      isGear: true,
      availability: 'in_stock',
      badge: g.badge
    };
  }

  function renderStockGrid() {
    if (!stockGrid) return;
    var visible = [];

    if (stockCat === 'all') {
      var ebikePick = bikesCatalog.filter(function (b) { return b.t === 'electric'; })[0] || bikesCatalog[0];
      var roadPick = bikesCatalog.filter(function (b) { return b.t === 'road'; })[0] || bikesCatalog[1];
      var helmetPick = gearData.filter(function (g) { return g.id === 'spz-propero4' || g.cat === 'accessories'; })[0];
      var partPick = gearData.filter(function (g) { return g.id === 'conti-gp5000' || g.cat === 'parts'; })[0];
      if (ebikePick) visible.push(ebikePick);
      if (helmetPick) visible.push(mapGearToStockItem(helmetPick));
      if (roadPick) visible.push(roadPick);
      if (partPick) visible.push(mapGearToStockItem(partPick));
      if (visible.length < 4) {
        visible = bikesCatalog.slice(0, 4);
      }
    } else if (stockCat === 'electric') {
      visible = bikesCatalog.filter(function (b) { return b.t === 'electric'; }).slice(0, 4);
    } else if (stockCat === 'bikes') {
      visible = bikesCatalog.filter(function (b) { return b.t !== 'electric'; }).slice(0, 4);
    } else if (stockCat === 'accessories') {
      visible = gearData.filter(function (g) { return g.cat === 'accessories'; }).slice(0, 4).map(mapGearToStockItem);
    } else if (stockCat === 'parts') {
      visible = gearData.filter(function (g) { return g.cat === 'parts' || g.cat === 'supplements'; }).slice(0, 4).map(mapGearToStockItem);
    } else {
      visible = bikesCatalog.filter(function (b) { return b.t === stockCat; }).slice(0, 4);
    }

    stockGrid.innerHTML = visible.map(function (item) {
      return renderBikeCard(item, false);
    }).join('');
    equalizeCardImages(stockGrid);
  }

  qsa('#stockTabs .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      qsa('#stockTabs .chip').forEach(function (c) {
        c.setAttribute('aria-pressed', c === chip ? 'true' : 'false');
      });
      stockCat = chip.getAttribute('data-t') || 'all';
      renderStockGrid();
    });
  });

  /* ---------- 9. Interactive Bike & E-Bike Finder ---------- */
  var finderGrid = document.getElementById('finderGrid');
  var budgetRange = document.getElementById('budget');
  var budgetOut = document.getElementById('budgetOut');
  var activeRide = 'electric';

  function renderFinder() {
    if (!finderGrid || !budgetRange) return;
    var min = Number(budgetRange.min) || 500;
    var max = Number(budgetRange.value) || 4500;
    var cap = Number(budgetRange.max) || 7000;
    var pct = ((max - min) / (cap - min)) * 100;
    budgetRange.style.setProperty('--p', Math.max(0, Math.min(100, pct)).toFixed(1) + '%');

    var t = COPY[lang];
    var rInfo = RIDES[activeRide] || RIDES.electric;

    if (budgetOut) {
      budgetOut.textContent = max >= cap ? money(max) + '+' : money(max);
    }
    var titleEl = document.getElementById('finderTitle');
    var noteEl = document.getElementById('finderNote');
    var countEl = document.getElementById('finderCount');

    if (titleEl) titleEl.textContent = rInfo[lang];
    if (noteEl) noteEl.textContent = lang === 'es' ? rInfo.noteEs : rInfo.noteEn;

    var matches = bikesCatalog.filter(function (b) {
      return b.t === activeRide && (b.p <= max || max >= cap);
    });

    if (countEl) {
      countEl.textContent = matches.length + ' ' + t.matches;
    }

    if (!matches.length) {
      finderGrid.innerHTML = '<div class="empty-state"><strong>' + esc(t.noBikes) + '</strong><p class="sub-lead">' + esc(t.noBikesSub) + '</p></div>';
      return;
    }

    finderGrid.innerHTML = matches.slice(0, 4).map(function (b) {
      return renderBikeCard(b, false);
    }).join('');
    equalizeCardImages(finderGrid);
  }

  qsa('#rideChips .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      qsa('#rideChips .chip').forEach(function (c) {
        c.setAttribute('aria-pressed', c === chip ? 'true' : 'false');
      });
      activeRide = chip.getAttribute('data-ride') || 'electric';
      renderFinder();
    });
  });

  if (budgetRange) {
    budgetRange.addEventListener('input', renderFinder);
  }

  /* ---------- 10. Interactive Pro-Shop Equipment, Supplements & Parts ---------- */
  var gearGrid = document.getElementById('gearInteractiveGrid');
  var gearSearchInput = document.getElementById('gearSearchInput');
  var gearMoreWrap = document.getElementById('gearMoreWrap');
  var gearShowMoreBtn = document.getElementById('gearShowMoreBtn');
  var gearShowMoreTxt = document.getElementById('gearShowMoreTxt');
  var activeGearCat = 'all';
  var activeGearTag = 'all';
  var gearQuery = '';
  var gearExpanded = false;
  var FEATURED_GEAR_IDS = ['spz-propero4', 'bell-z20', 'skratch-hydration', 'conti-gp5000'];

  function renderGearExplorer() {
    if (!gearGrid) return;
    var t = COPY[lang];
    var k = lang === 'es' ? 1 : 0;
    var q = gearQuery.trim().toLowerCase();

    var filtered = gearData.filter(function (g) {
      if (activeGearCat !== 'all' && g.cat !== activeGearCat) return false;
      if (activeGearTag !== 'all' && (!g.tags || g.tags.indexOf(activeGearTag) === -1)) return false;
      if (q) {
        var hay = ((g.b || '') + ' ' + (g.n || '') + ' ' + ((g.spec && g.spec[k]) || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    if (!filtered.length) {
      if (gearMoreWrap) gearMoreWrap.setAttribute('hidden', 'hidden');
      gearGrid.innerHTML = '<div class="empty-state"><strong>' + esc(t.noGear) + '</strong><p class="sub-lead">' + esc(t.noGearSub) + '</p></div>';
      return;
    }

    // Reorder default "all" view so the top 4 showcase helmets, hydration & tires with live quick-add
    var ordered = filtered.slice();
    if (activeGearCat === 'all' && activeGearTag === 'all' && !q) {
      ordered.sort(function (a, b) {
        var ia = FEATURED_GEAR_IDS.indexOf(a.id);
        var ib = FEATURED_GEAR_IDS.indexOf(b.id);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    }

    var canCollapse = ordered.length > 4 && !q;
    var visible = canCollapse && !gearExpanded ? ordered.slice(0, 4) : ordered;

    if (gearMoreWrap && gearShowMoreBtn && gearShowMoreTxt) {
      if (canCollapse) {
        gearMoreWrap.removeAttribute('hidden');
        gearShowMoreBtn.setAttribute('aria-expanded', gearExpanded ? 'true' : 'false');
        var extraCount = ordered.length - 4;
        gearShowMoreTxt.textContent = gearExpanded
          ? t.showLessGear
          : t.showAllGear.replace('{total}', String(ordered.length)).replace('{extra}', String(extraCount));
      } else {
        gearMoreWrap.setAttribute('hidden', 'hidden');
      }
    }

    gearGrid.innerHTML = visible.map(function (g) {
      var badgeTxt = g.badge ? (g.badge[k] || g.badge[0]) : g.b;
      var specTxt = g.spec ? (g.spec[k] || g.spec[0]) : '';
      var actionBtn = g.variantId
        ? '<button type="button" class="pcard-cta is-add" data-quick-vid="' + esc(g.variantId) + '" data-quick-name="' + esc(g.n) + '"><span>' + esc(t.addBag) + '</span></button>'
        : '<a class="pcard-cta" href="' + esc(g.u || '#gear') + '"><span>' + esc(t.shopGear) + '</span> <svg><use href="#i-arrow"/></svg></a>';

      return '<article class="gcard">' +
        '<div class="gcard-top">' +
          '<span class="gcard-badge">' + esc(badgeTxt) + '</span>' +
          '<button type="button" class="gcard-spec-btn" aria-expanded="false" data-spec-toggle="' + esc(g.id) + '">' + esc(t.specs) + '</button>' +
        '</div>' +
        '<a class="gcard-img" href="' + esc(g.u || '#gear') + '"><img src="' + esc(g.img) + '" alt="' + esc(g.b + ' ' + g.n) + '" loading="lazy"></a>' +
        '<span class="pcard-vendor">' + esc(g.b) + '</span>' +
        '<h3 class="pcard-title"><a href="' + esc(g.u || '#gear') + '">' + esc(g.n) + '</a></h3>' +
        '<div class="gcard-spec-drawer" id="spec-' + esc(g.id) + '" hidden>' + esc(specTxt) + '</div>' +
        '<div class="pcard-foot">' +
          '<span class="pcard-price">' + money(g.p) + '</span>' +
          actionBtn +
        '</div>' +
      '</article>';
    }).join('');
    equalizeCardImages(gearGrid);
  }

  equalizeCardImages(document);

  if (gearShowMoreBtn) {
    gearShowMoreBtn.addEventListener('click', function () {
      gearExpanded = !gearExpanded;
      renderGearExplorer();
    });
  }

  qsa('#gearCatTabs .gear-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      qsa('#gearCatTabs .gear-tab').forEach(function (x) {
        x.setAttribute('aria-selected', x === tab ? 'true' : 'false');
      });
      activeGearCat = tab.getAttribute('data-gcat') || 'all';
      renderGearExplorer();
    });
  });

  qsa('#gearTagPills .chip').forEach(function (pill) {
    pill.addEventListener('click', function () {
      qsa('#gearTagPills .chip').forEach(function (x) {
        x.setAttribute('aria-pressed', x === pill ? 'true' : 'false');
      });
      activeGearTag = pill.getAttribute('data-gtag') || 'all';
      renderGearExplorer();
    });
  });

  if (gearSearchInput) {
    gearSearchInput.addEventListener('input', function () {
      gearQuery = gearSearchInput.value || '';
      renderGearExplorer();
    });
  }

  qsa('[data-gear-jump]').forEach(function (link) {
    link.addEventListener('click', function () {
      var targetCat = link.getAttribute('data-gear-jump');
      if (!targetCat) return;
      activeGearCat = targetCat;
      qsa('#gearCatTabs .gear-tab').forEach(function (tab) {
        tab.setAttribute('aria-selected', tab.getAttribute('data-gcat') === targetCat ? 'true' : 'false');
      });
      renderGearExplorer();
    });
  });

  document.addEventListener('click', function (e) {
    var quickBtn = e.target.closest ? e.target.closest('[data-quick-vid]') : null;
    if (quickBtn) {
      e.preventDefault();
      e.stopPropagation();
      addVariantToDawnCart(quickBtn.getAttribute('data-quick-vid'), quickBtn, quickBtn.getAttribute('data-quick-name'));
      return;
    }

    var specBtn = e.target.closest ? e.target.closest('[data-spec-toggle]') : null;
    if (specBtn) {
      var id = specBtn.getAttribute('data-spec-toggle');
      var drawer = document.getElementById('spec-' + id);
      if (drawer) {
        var isOpen = !drawer.hasAttribute('hidden');
        if (isOpen) {
          drawer.setAttribute('hidden', '');
          specBtn.setAttribute('aria-expanded', 'false');
          specBtn.textContent = COPY[lang].specs;
        } else {
          drawer.removeAttribute('hidden');
          specBtn.setAttribute('aria-expanded', 'true');
          specBtn.textContent = COPY[lang].hideSpecs;
        }
      }
    }
  });

  /* ---------- 11. Tune-Up Checklist Expand/Collapse ---------- */
  qsa('.plan-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var card = btn.closest('.plan');
      if (!card) return;
      var open = card.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      var attr = open ? (lang === 'es' ? 'data-less-es' : 'data-less') : (lang === 'es' ? 'data-more-es' : 'data-more');
      btn.textContent = btn.getAttribute(attr) || btn.textContent;
    });
  });

  /* ---------- 12. Hybrid AI Studio Store Locator (#stores & /pages/locations) ---------- */
  var SCHEDULES = {
    main: {
      1: [10, 18], 2: [10, 18], 3: [10, 18], 4: [10, 18], 5: [10, 18],
      6: [9, 17]
    },
    alafia: {
      3: [10, 17], 4: [10, 17], 5: [10, 17],
      6: [8, 17], 0: [8, 17]
    }
  };

  var ORIGINS = {
    usf: { lat: 28.0587, lng: -82.4139, en: 'USF / North Tampa (33612)', es: 'USF / Norte de Tampa (33612)' },
    downtown: { lat: 27.9506, lng: -82.4572, en: 'Downtown Tampa (33602)', es: 'Downtown Tampa (33602)' },
    southtampa: { lat: 27.9365, lng: -82.4820, en: 'South Tampa / Hyde Park (33606)', es: 'South Tampa / Hyde Park (33606)' },
    carrollwood: { lat: 28.0772, lng: -82.5065, en: 'Carrollwood / Lutz (33618)', es: 'Carrollwood / Lutz (33618)' },
    wesleychapel: { lat: 28.2397, lng: -82.3279, en: 'Wesley Chapel (33544)', es: 'Wesley Chapel (33544)' },
    brandon: { lat: 27.9378, lng: -82.2859, en: 'Brandon / Riverview (33511)', es: 'Brandon / Riverview (33511)' },
    lithia: { lat: 27.8531, lng: -82.2081, en: 'Lithia / FishHawk (33547)', es: 'Lithia / FishHawk (33547)' },
    stpete: { lat: 27.7676, lng: -82.6403, en: 'St. Petersburg (33701)', es: 'St. Petersburg (33701)' }
  };

  function fmtHour(h) {
    var suffix = h >= 12 ? 'PM' : 'AM';
    var hr = h % 12 || 12;
    return hr + ':00 ' + suffix;
  }

  function haversineMiles(lat1, lon1, lat2, lon2) {
    var rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad;
    var dLon = (lon2 - lon1) * rad;
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return 3958.8 * c;
  }

  function getTampaTimeInfo() {
    var now = new Date();
    var tampaNow = now;
    try {
      tampaNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    } catch (e) {}
    return {
      day: tampaNow.getDay(),
      dec: tampaNow.getHours() + tampaNow.getMinutes() / 60
    };
  }

  function getStoreLiveStatus(storeId, timeInfo) {
    var sched = SCHEDULES[storeId];
    var t = COPY[lang];
    if (!sched) return { isOpen: false, text: t.closedLabel };
    var todayHours = sched[timeInfo.day];
    if (todayHours && timeInfo.dec >= todayHours[0] && timeInfo.dec < todayHours[1]) {
      return { isOpen: true, text: t.openNow + fmtHour(todayHours[1]) };
    }
    var nextOpen = todayHours && timeInfo.dec < todayHours[0] ? fmtHour(todayHours[0]) : '';
    if (!nextOpen) {
      for (var offset = 1; offset <= 7; offset++) {
        var nd = (timeInfo.day + offset) % 7;
        if (sched[nd]) {
          nextOpen = fmtHour(sched[nd][0]);
          break;
        }
      }
    }
    return {
      isOpen: false,
      text: nextOpen ? t.closedNow + nextOpen : t.closedLabel
    };
  }

  var slRoot = qs('[data-sl-root]');
  var slStores = parseJsonEl('FableStoresData');
  var slCardsList = document.getElementById('slCardsList');
  var slHud = document.getElementById('slActiveHud');
  var slEmbed = document.getElementById('slEmbedFrame');
  var slJsCanvas = document.getElementById('slGoogleJsCanvas');
  var slMapPinsWrap = document.getElementById('slMapPins');
  var slOriginSelect = document.getElementById('slOriginSelect');
  var slPlacesWrap = document.getElementById('slPlacesWrap');
  var slPlacesInput = document.getElementById('slPlacesInput');
  var slNearMeBtn = document.getElementById('slNearMeBtn');
  var slOriginBanner = document.getElementById('slOriginBanner');
  var slOriginLabel = document.getElementById('slOriginLabel');
  var slClearOrigin = document.getElementById('slClearOrigin');
  var slFitBoundsBtn = document.getElementById('slFitBoundsBtn');

  var slSelectedId = slStores.length ? slStores[0].id : 'main';
  var slServiceFilter = 'all';
  var slMapMode = 'm';
  var slActiveOrigin = null; // { key, lat, lng, labelEn, labelEs }
  var slLastEmbedSrc = slEmbed ? slEmbed.getAttribute('src') || '' : '';
  var slEmbedTimer = null;

  // Optional Google Maps JS Vector Mode state
  var slVectorReady = false;
  var slGMap = null;
  var slGMarkers = {};
  var slGUserMarker = null;
  var slGRouteLine = null;

  function getFilteredSortedStores() {
    var list = slStores.filter(function (s) {
      if (slServiceFilter === 'all') return true;
      return (s.services || []).indexOf(slServiceFilter) !== -1;
    }).map(function (s) {
      var dist = slActiveOrigin ? haversineMiles(slActiveOrigin.lat, slActiveOrigin.lng, s.lat, s.lng) : null;
      var mins = dist != null ? Math.max(6, Math.round(dist * 1.65)) : null;
      return { store: s, dist: dist, mins: mins };
    });

    if (slActiveOrigin) {
      list.sort(function (a, b) {
        return (a.dist || 0) - (b.dist || 0);
      });
    }
    return list;
  }

  function makeVectorPinIcon(active) {
    var fill = active ? '%23E04F33' : '%23213549';
    var ring = active ? '%23FFFFFF' : '%23CCBB8D';
    var dot = active ? '%23FFFFFF' : '%23CCBB8D';
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="50" viewBox="0 0 40 50">' +
      '<path d="M20 2C10.06 2 2 10.06 2 20c0 12.6 18 28 18 28s18-15.4 18-28C38 10.06 29.94 2 20 2z" fill="' + fill + '" stroke="' + ring + '" stroke-width="2.5"/>' +
      '<circle cx="20" cy="19" r="6" fill="' + dot + '"/>' +
      '</svg>';
    return {
      url: 'data:image/svg+xml;charset=UTF-8,' + svg,
      scaledSize: new window.google.maps.Size(active ? 40 : 34, active ? 50 : 42),
      anchor: new window.google.maps.Point(active ? 20 : 17, active ? 48 : 40)
    };
  }

  function syncStoreMapViewport(activeEntry) {
    if (!activeEntry) return;
    var s = activeEntry.store;

    if (slVectorReady && slGMap && window.google && window.google.maps) {
      slGMap.setMapTypeId(slMapMode === 'k' ? 'hybrid' : 'roadmap');
      slStores.forEach(function (st) {
        var mk = slGMarkers[st.id];
        if (!mk) return;
        var visible = slServiceFilter === 'all' || (st.services || []).indexOf(slServiceFilter) !== -1;
        mk.setVisible(visible);
        mk.setIcon(makeVectorPinIcon(st.id === s.id));
        mk.setZIndex(st.id === s.id ? 20 : 10);
      });

      if (slGRouteLine) {
        slGRouteLine.setMap(null);
        slGRouteLine = null;
      }
      if (slGUserMarker) {
        slGUserMarker.setMap(null);
        slGUserMarker = null;
      }

      if (slActiveOrigin) {
        var originLatLng = { lat: slActiveOrigin.lat, lng: slActiveOrigin.lng };
        slGUserMarker = new window.google.maps.Marker({
          position: originLatLng,
          map: slGMap,
          title: lang === 'es' ? slActiveOrigin.labelEs : slActiveOrigin.labelEn,
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            scale: 7,
            fillColor: '#213549',
            fillOpacity: 1,
            strokeColor: '#FEFDF3',
            strokeWeight: 2.5
          }
        });
        slGRouteLine = new window.google.maps.Polyline({
          path: [originLatLng, { lat: s.lat, lng: s.lng }],
          geodesic: true,
          strokeOpacity: 0,
          icons: [{
            icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.88, strokeColor: '#E04F33', scale: 3.2 },
            offset: '0',
            repeat: '14px'
          }],
          map: slGMap
        });
        var bounds = new window.google.maps.LatLngBounds();
        bounds.extend(originLatLng);
        bounds.extend({ lat: s.lat, lng: s.lng });
        slGMap.fitBounds(bounds, 64);
      } else {
        slGMap.panTo({ lat: s.lat, lng: s.lng });
        slGMap.setZoom(s.zoom || 14);
      }
      return;
    }

    // Mode 1: Instant Zero-Key Synced Google Maps Embed
    if (slEmbed) {
      var nextSrc =
        'https://maps.google.com/maps?q=' +
        s.mapQuery +
        '&t=' +
        slMapMode +
        '&z=' +
        (s.zoom || 14) +
        '&ie=UTF8&iwloc=&output=embed';
      slEmbed.setAttribute('title', 'Google Map — ' + s.name + ', ' + s.fullAddress);
      if (nextSrc !== slLastEmbedSrc) {
        slLastEmbedSrc = nextSrc;
        slEmbed.classList.add('is-fading');
        if (slEmbedTimer) clearTimeout(slEmbedTimer);
        slEmbedTimer = setTimeout(function () {
          slEmbed.setAttribute('src', nextSrc);
          setTimeout(function () {
            slEmbed.classList.remove('is-fading');
          }, 180);
        }, 90);
      }
    }
  }

  function renderStoreLocator() {
    if (!slCardsList || !slStores.length) return;
    var t = COPY[lang];
    var li = lang === 'es' ? 1 : 0;
    var timeInfo = getTampaTimeInfo();
    var entries = getFilteredSortedStores();

    if (!entries.length) return;
    var activeEntry = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].store.id === slSelectedId) {
        activeEntry = entries[i];
        break;
      }
    }
    if (!activeEntry) {
      activeEntry = entries[0];
      slSelectedId = activeEntry.store.id;
    }

    // Origin banner
    if (slOriginBanner && slOriginLabel) {
      if (slActiveOrigin) {
        slOriginBanner.removeAttribute('hidden');
        slOriginLabel.textContent = t.fromPrefix + (lang === 'es' ? slActiveOrigin.labelEs : slActiveOrigin.labelEn);
      } else {
        slOriginBanner.setAttribute('hidden', 'hidden');
      }
    }

    // Sync top map pin pills (Mode 1)
    if (slMapPinsWrap && !slVectorReady) {
      qsa('[data-sl-pin]', slMapPinsWrap).forEach(function (pinBtn) {
        var pid = pinBtn.getAttribute('data-sl-pin');
        var visible = false;
        for (var j = 0; j < entries.length; j++) {
          if (entries[j].store.id === pid) {
            visible = true;
            break;
          }
        }
        if (visible) {
          pinBtn.removeAttribute('hidden');
        } else {
          pinBtn.setAttribute('hidden', 'hidden');
        }
        pinBtn.setAttribute('aria-pressed', pid === slSelectedId ? 'true' : 'false');
      });
    }

    // Render left-pane store cards
    var isStandalonePage = !!(slRoot && slRoot.classList.contains('sl-sec--page'));

    slCardsList.innerHTML = entries.map(function (entry) {
      var s = entry.store;
      var selected = s.id === slSelectedId;
      var st = getStoreLiveStatus(s.id, timeInfo);
      var dirUrlCard = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(s.fullAddress);

      if (!isStandalonePage) {
        var summaryHrs = s.summaryHours && s.summaryHours[li] ? s.summaryHours[li] : '';
        return (
          '<article class="sl-card sl-card--calm' + (selected ? ' is-selected' : '') + '" role="option" tabindex="0" aria-selected="' + (selected ? 'true' : 'false') + '" data-sl-card="' + esc(s.id) + '">' +
            '<div class="sl-card-top">' +
              '<div>' +
                '<span class="sl-role">' + esc(s.role[li]) + '</span>' +
                '<h3>' + esc(s.name) + '</h3>' +
              '</div>' +
              '<span class="sl-status' + (st.isOpen ? ' is-open' : '') + '">' + esc(st.text) + '</span>' +
            '</div>' +
            '<div class="sl-calm-meta">' +
              '<span>' + esc(s.fullAddress) + '</span>' +
              (summaryHrs ? '<span class="sl-calm-hours">' + esc(summaryHrs) + '</span>' : '') +
            '</div>' +
            '<div class="sl-calm-actions">' +
              '<a class="sl-calm-link sl-calm-link--dir" href="' + esc(dirUrlCard) + '" target="_blank" rel="noopener">' + esc(t.directions) + ' &rarr;</a>' +
              '<a class="sl-calm-link" href="tel:' + esc(s.tel) + '">' + esc(s.phone) + '</a>' +
            '</div>' +
          '</article>'
        );
      }

      var pillText = entry.dist != null
        ? entry.dist.toFixed(1) + t.milesAway
        : (s.id === 'main' ? t.flagshipPill : t.parkPill);
      var pillCls = entry.dist != null ? 'sl-dist-pill has-dist' : 'sl-dist-pill';

      var hoursHtml = (s.hours || []).map(function (row) {
        var isToday = (row.days || []).indexOf(timeInfo.day) !== -1;
        return (
          '<div' + (isToday ? ' class="is-today"' : '') + '>' +
            '<span>' + esc(row.label[li]) + '</span>' +
            '<span>' + esc(row.time[li]) + '</span>' +
          '</div>'
        );
      }).join('');

      var badgeList = s.badges || [];
      var badgesHtml = badgeList.map(function (b) {
        return '<span class="sl-badge">' + esc(b[li]) + '</span>';
      }).join('');

      var footText = s.footnote && s.footnote[li] ? s.footnote[li] : '';
      var openHoursByDefault = window.innerWidth > 760;

      return (
        '<article class="sl-card' + (selected ? ' is-selected' : '') + '" role="option" tabindex="0" aria-selected="' + (selected ? 'true' : 'false') + '" data-sl-card="' + esc(s.id) + '">' +
          '<div class="sl-card-top">' +
            '<div>' +
              '<span class="sl-role">' + esc(s.num + ' · ' + s.role[li]) + '</span>' +
              '<h3>' + esc(s.name) + '</h3>' +
            '</div>' +
            '<span class="' + pillCls + '">' + esc(pillText) + '</span>' +
          '</div>' +
          '<div class="sl-meta-row">' +
            '<span class="sl-addr">' + esc(s.fullAddress) + ' &middot; ' + esc(s.phone) + '</span>' +
            '<span class="sl-status' + (st.isOpen ? ' is-open' : '') + '">' + esc(st.text) + '</span>' +
          '</div>' +
          '<details class="sl-hours-acc"' + (openHoursByDefault ? ' open' : '') + '>' +
            '<summary class="sl-hours-sum"><span>' + esc(t.storeHours) + '</span><svg aria-hidden="true"><use href="#i-chev"/></svg></summary>' +
            '<div class="sl-hours">' + hoursHtml + '</div>' +
            (footText ? '<p class="sl-footnote">' + esc(footText) + '</p>' : '') +
          '</details>' +
          '<div class="sl-badges">' + badgesHtml + '</div>' +
        '</article>'
      );
    }).join('');

    qsa('[data-sl-card]', slCardsList).forEach(function (cardEl) {
      cardEl.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.sl-hours-sum, .sl-calm-link, a')) return;
        var nextId = cardEl.getAttribute('data-sl-card');
        if (nextId && nextId !== slSelectedId) {
          slSelectedId = nextId;
          renderStoreLocator();
        }
      });
      cardEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          var nextId = cardEl.getAttribute('data-sl-card');
          if (nextId) {
            slSelectedId = nextId;
            renderStoreLocator();
          }
        }
      });
    });

    // Render floating bottom HUD on the map stage
    if (slHud && activeEntry) {
      var act = activeEntry.store;
      var actStatus = getStoreLiveStatus(act.id, timeInfo);
      var dirUrl = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(act.fullAddress);
      if (slActiveOrigin) {
        dirUrl += '&origin=' + encodeURIComponent(slActiveOrigin.lat + ',' + slActiveOrigin.lng);
      }
      var driveHtml = activeEntry.dist != null
        ? '<span class="sl-hud-drive">' + esc(activeEntry.dist.toFixed(1) + t.milesAway + ' · ~' + activeEntry.mins + t.minDrive) + '</span>'
        : '';

      slHud.innerHTML =
        '<div class="sl-hud-copy">' +
          '<div class="sl-hud-kicker">' +
            '<span class="sl-hud-status' + (actStatus.isOpen ? ' is-open' : '') + '">' + esc(actStatus.text) + '</span>' +
            driveHtml +
          '</div>' +
          '<h4 class="sl-hud-title">' + esc(act.name) + '</h4>' +
          '<p class="sl-hud-sub">' + esc(act.fullAddress) + ' &middot; ' + esc(act.phone) + '</p>' +
        '</div>' +
        '<div class="sl-hud-actions">' +
          '<a class="fb-btn coral sm" href="' + esc(dirUrl) + '" target="_blank" rel="noopener">' +
            '<svg aria-hidden="true"><use href="#i-pin"/></svg> ' + esc(t.directions) +
          '</a>' +
          '<a class="fb-btn ghost-light sm" href="tel:' + esc(act.tel) + '">' +
            '<svg aria-hidden="true"><use href="#i-phone"/></svg> ' + esc(act.phone) +
          '</a>' +
        '</div>';
    }

    syncStoreMapViewport(activeEntry);
  }

  function applyOriginAndSelectClosest(originObj) {
    slActiveOrigin = originObj;
    if (slActiveOrigin) {
      var sorted = getFilteredSortedStores();
      if (sorted.length) {
        slSelectedId = sorted[0].store.id;
      }
    }
    renderStoreLocator();
  }

  if (slOriginSelect) {
    slOriginSelect.addEventListener('change', function () {
      var key = slOriginSelect.value;
      if (!key || !ORIGINS[key]) {
        applyOriginAndSelectClosest(null);
        return;
      }
      var o = ORIGINS[key];
      applyOriginAndSelectClosest({
        key: key,
        lat: o.lat,
        lng: o.lng,
        labelEn: o.en,
        labelEs: o.es
      });
    });
  }

  if (slClearOrigin) {
    slClearOrigin.addEventListener('click', function () {
      if (slOriginSelect) slOriginSelect.value = '';
      if (slPlacesInput) slPlacesInput.value = '';
      applyOriginAndSelectClosest(null);
    });
  }

  if (slNearMeBtn) {
    slNearMeBtn.addEventListener('click', function () {
      var labelSpan = qs('span', slNearMeBtn);
      var origLabel = labelSpan ? labelSpan.textContent : 'Near Me';
      if (!navigator.geolocation) {
        if (slOriginBanner && slOriginLabel) {
          slOriginBanner.removeAttribute('hidden');
          slOriginLabel.textContent = COPY[lang].locDenied;
        }
        return;
      }
      if (labelSpan) labelSpan.textContent = COPY[lang].locating;
      slNearMeBtn.disabled = true;

      navigator.geolocation.getCurrentPosition(
        function (pos) {
          slNearMeBtn.disabled = false;
          if (labelSpan) labelSpan.textContent = lang === 'es' ? 'Cerca de mí' : 'Near Me';
          if (slOriginSelect) slOriginSelect.value = '';
          applyOriginAndSelectClosest({
            key: 'gps',
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            labelEn: COPY.en.nearMeOrigin,
            labelEs: COPY.es.nearMeOrigin
          });
        },
        function () {
          slNearMeBtn.disabled = false;
          if (labelSpan) labelSpan.textContent = origLabel;
          if (slOriginBanner && slOriginLabel) {
            slOriginBanner.removeAttribute('hidden');
            slOriginLabel.textContent = COPY[lang].locDenied;
          }
        },
        { enableHighAccuracy: false, timeout: 7000, maximumAge: 120000 }
      );
    });
  }

  qsa('[data-sl-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      slServiceFilter = btn.getAttribute('data-sl-filter') || 'all';
      qsa('[data-sl-filter]').forEach(function (b) {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      renderStoreLocator();
    });
  });

  qsa('[data-sl-pin]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-sl-pin');
      if (id) {
        slSelectedId = id;
        renderStoreLocator();
      }
    });
  });

  qsa('[data-sl-map-mode]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      slMapMode = btn.getAttribute('data-sl-map-mode') || 'm';
      qsa('[data-sl-map-mode]').forEach(function (b) {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      renderStoreLocator();
    });
  });

  if (slFitBoundsBtn) {
    slFitBoundsBtn.addEventListener('click', function () {
      if (!slVectorReady || !slGMap || !window.google || !window.google.maps) return;
      var bounds = new window.google.maps.LatLngBounds();
      slStores.forEach(function (s) {
        bounds.extend({ lat: s.lat, lng: s.lng });
      });
      if (slActiveOrigin) {
        bounds.extend({ lat: slActiveOrigin.lat, lng: slActiveOrigin.lng });
      }
      slGMap.fitBounds(bounds, 56);
    });
  }

  function revertToEmbedMode() {
    slVectorReady = false;
    if (slJsCanvas) slJsCanvas.setAttribute('hidden', 'hidden');
    if (slPlacesWrap) slPlacesWrap.setAttribute('hidden', 'hidden');
    if (slFitBoundsBtn) slFitBoundsBtn.setAttribute('hidden', 'hidden');
    if (slEmbed) slEmbed.removeAttribute('hidden');
    if (slMapPinsWrap) slMapPinsWrap.removeAttribute('hidden');
    renderStoreLocator();
  }

  function bootVectorGoogleMaps(apiKey) {
    if (!apiKey || !slJsCanvas || !slStores.length) return;

    window.gm_authFailure = function () {
      revertToEmbedMode();
    };

    function onMapsLoaded() {
      if (!window.google || !window.google.maps) {
        revertToEmbedMode();
        return;
      }
      try {
        slJsCanvas.removeAttribute('hidden');
        if (slPlacesWrap) slPlacesWrap.removeAttribute('hidden');
        if (slFitBoundsBtn) slFitBoundsBtn.removeAttribute('hidden');
        if (slEmbed) slEmbed.setAttribute('hidden', 'hidden');
        if (slMapPinsWrap) slMapPinsWrap.setAttribute('hidden', 'hidden');

        slGMap = new window.google.maps.Map(slJsCanvas, {
          center: { lat: slStores[0].lat, lng: slStores[0].lng },
          zoom: slStores[0].zoom || 14,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false
        });

        slStores.forEach(function (st) {
          var marker = new window.google.maps.Marker({
            position: { lat: st.lat, lng: st.lng },
            map: slGMap,
            title: st.name,
            icon: makeVectorPinIcon(st.id === slSelectedId)
          });
          marker.addListener('click', function () {
            slSelectedId = st.id;
            renderStoreLocator();
          });
          slGMarkers[st.id] = marker;
        });

        if (slPlacesInput && window.google.maps.places && window.google.maps.places.Autocomplete) {
          var ac = new window.google.maps.places.Autocomplete(slPlacesInput, {
            componentRestrictions: { country: 'us' },
            fields: ['geometry', 'formatted_address', 'name']
          });
          ac.addListener('place_changed', function () {
            var place = ac.getPlace();
            if (!place || !place.geometry || !place.geometry.location) return;
            var label = place.name || place.formatted_address || slPlacesInput.value;
            if (slOriginSelect) slOriginSelect.value = '';
            applyOriginAndSelectClosest({
              key: 'places',
              lat: place.geometry.location.lat(),
              lng: place.geometry.location.lng(),
              labelEn: label,
              labelEs: label
            });
          });
        }

        slVectorReady = true;
        renderStoreLocator();
      } catch (err) {
        revertToEmbedMode();
      }
    }

    if (window.google && window.google.maps) {
      onMapsLoaded();
      return;
    }

    var script = document.createElement('script');
    script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(apiKey) + '&libraries=places';
    script.async = true;
    script.defer = true;
    script.onload = onMapsLoaded;
    script.onerror = revertToEmbedMode;
    document.head.appendChild(script);
  }

  /* ---------- 13. Ikeono Floating Text-to-Chat Controller ---------- */
  var ikRoot = document.getElementById('ubcIkeonoRoot');
  var ikFab = document.getElementById('ubcIkeonoFab');
  var ikPanel = document.getElementById('ubcIkeonoPanel');
  var ikClose = document.getElementById('ubcIkeonoClose');
  var ikTopicsWrap = document.getElementById('ubcIkeonoTopics');
  var ikMsg = document.getElementById('ubcIkeonoMsg');
  var ikSend = document.getElementById('ubcIkeonoSend');
  var ikUserTyped = false;

  function syncIkeonoSmsHref() {
    if (!ikRoot || !ikSend) return;
    var smsNum = ikRoot.getAttribute('data-ik-sms') || '+18139712277';
    var bodyTxt = ikMsg ? (ikMsg.value || '').trim() : '';
    ikSend.setAttribute('href', 'sms:' + smsNum + (bodyTxt ? '?&body=' + encodeURIComponent(bodyTxt) : ''));
  }

  function closeIkeonoPanel() {
    if (!ikPanel || !ikFab) return;
    ikPanel.setAttribute('hidden', 'hidden');
    ikFab.setAttribute('aria-expanded', 'false');
  }

  if (ikFab && ikPanel) {
    ikFab.addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.Ikeono && typeof window.Ikeono.open === 'function') {
        window.Ikeono.open();
        return;
      }
      var isHidden = ikPanel.hasAttribute('hidden');
      if (isHidden) {
        ikPanel.removeAttribute('hidden');
        ikFab.setAttribute('aria-expanded', 'true');
        syncIkeonoSmsHref();
      } else {
        closeIkeonoPanel();
      }
    });
  }

  if (ikClose) {
    ikClose.addEventListener('click', closeIkeonoPanel);
  }

  if (ikTopicsWrap) {
    qsa('.ik-topic', ikTopicsWrap).forEach(function (btn) {
      btn.addEventListener('click', function () {
        qsa('.ik-topic', ikTopicsWrap).forEach(function (b) {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
        ikUserTyped = false;
        var tpl = lang === 'es'
          ? (btn.getAttribute('data-ik-topic-es') || btn.getAttribute('data-ik-topic'))
          : btn.getAttribute('data-ik-topic');
        if (ikMsg && tpl) {
          ikMsg.value = tpl;
        }
        syncIkeonoSmsHref();
      });
    });
  }

  if (ikMsg) {
    ikMsg.addEventListener('input', function () {
      ikUserTyped = true;
      syncIkeonoSmsHref();
    });
  }

  document.addEventListener('click', function (e) {
    if (ikPanel && !ikPanel.hasAttribute('hidden') && ikRoot && !ikRoot.contains(e.target)) {
      closeIkeonoPanel();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeIkeonoPanel();
      closeReelModal();
    }
  });

  syncIkeonoSmsHref();

  /* ---------- 13B. Workshop Direct Ikeono Trigger, Ride Jump, Family 5-Tab Switcher & On-Demand Reel Modal ---------- */
  qsa('[data-ride-jump]').forEach(function (link) {
    link.addEventListener('click', function () {
      var r = link.getAttribute('data-ride-jump');
      if (!r) return;
      activeRide = r;
      qsa('#rideChips .chip').forEach(function (c) {
        c.setAttribute('aria-pressed', c.getAttribute('data-ride') === r ? 'true' : 'false');
      });
      renderFinder();
    });
  });

  function openLiveIkeonoWidget(messageBody) {
    if (document.getElementById('ikeono-wrapper') || document.getElementById('ikeono_webchat_widget')) {
      window.postMessage({
        type: 'OPEN_WIDGET',
        message_body: messageBody || '',
        location_id: '7412421b-e943-4ffc-842b-8400cf0a0adb',
      }, '*');
      return true;
    }
    if (window.Ikeono && typeof window.Ikeono.open === 'function') {
      window.Ikeono.open();
      return true;
    }
    return false;
  }

  qsa('[data-ws-ikeono]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var promptTxt = lang === 'es'
        ? (btn.getAttribute('data-ws-ikeono-es') || btn.getAttribute('data-ws-ikeono'))
        : btn.getAttribute('data-ws-ikeono');
      if (openLiveIkeonoWidget(promptTxt)) return;
      if (ikPanel && ikFab) {
        ikPanel.removeAttribute('hidden');
        ikFab.setAttribute('aria-expanded', 'true');
        if (ikTopicsWrap) {
          qsa('.ik-topic', ikTopicsWrap).forEach(function (tBtn, idx) {
            tBtn.setAttribute('aria-pressed', idx === 2 ? 'true' : 'false');
          });
        }
        if (ikMsg && promptTxt) {
          ikMsg.value = promptTxt;
          ikUserTyped = true;
          syncIkeonoSmsHref();
          setTimeout(function () { ikMsg.focus(); }, 50);
        }
        return;
      }
      // Fallback: open SMS directly to UBC Tampa text line
      var smsUrl = 'sms:+18139712277' + (promptTxt ? '?&body=' + encodeURIComponent(promptTxt) : '');
      window.location.href = smsUrl;
    });
  });

  // Family & Crew 5-Tab Switcher (#family)
  qsa('[data-fam-root]').forEach(function (famRoot) {
    var tabs = qsa('[data-fam-tab]', famRoot);
    var panels = qsa('[data-fam-panel]', famRoot);
    function selectFamTab(key, focusTab) {
      tabs.forEach(function (tBtn) {
        var active = tBtn.getAttribute('data-fam-tab') === key;
        tBtn.setAttribute('aria-selected', active ? 'true' : 'false');
        if (active && focusTab) tBtn.focus();
      });
      panels.forEach(function (pnl) {
        var active = pnl.getAttribute('data-fam-panel') === key;
        if (active) {
          pnl.removeAttribute('hidden');
          pnl.classList.add('is-active');
        } else {
          pnl.setAttribute('hidden', 'hidden');
          pnl.classList.remove('is-active');
        }
      });
    }
    tabs.forEach(function (tBtn, idx) {
      tBtn.addEventListener('click', function () {
        selectFamTab(tBtn.getAttribute('data-fam-tab'), false);
      });
      tBtn.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          var dir = e.key === 'ArrowRight' ? 1 : -1;
          var next = tabs[(idx + dir + tabs.length) % tabs.length];
          if (next) selectFamTab(next.getAttribute('data-fam-tab'), true);
        }
      });
    });
  });

  // Zero-Bloat On-Demand Instagram Reel Modal
  var reelModal = document.getElementById('ubcReelModal');
  var reelStage = document.getElementById('ubcReelStage');
  var reelTitleEl = document.getElementById('ubcReelTitle');
  var reelAcctEl = document.getElementById('ubcReelAcct');
  var reelCaptionEl = document.getElementById('ubcReelCaption');
  var reelExtLink = document.getElementById('ubcReelExtLink');
  var reelCloseBtn = document.getElementById('ubcReelCloseBtn');
  var lastReelTrigger = null;

  function closeReelModal() {
    if (!reelModal || reelModal.hasAttribute('hidden')) return;
    reelModal.setAttribute('hidden', 'hidden');
    if (reelStage) {
      reelStage.innerHTML = '';
      reelStage.style.backgroundImage = '';
    }
    if (document.body) document.body.style.overflow = '';
    if (lastReelTrigger && typeof lastReelTrigger.focus === 'function') {
      try { lastReelTrigger.focus(); } catch (e) {}
    }
    lastReelTrigger = null;
  }

  function openReelModal(triggerBtn) {
    if (!reelModal || !reelStage || !triggerBtn) return;
    var code = (triggerBtn.getAttribute('data-ubc-reel') || '').trim();
    var videoUrl = (triggerBtn.getAttribute('data-ubc-video') || '').trim();
    var posterUrl = (triggerBtn.getAttribute('data-ubc-poster') || '').trim();
    if (!code && !videoUrl) return;

    lastReelTrigger = triggerBtn;
    if (posterUrl) {
      reelStage.style.backgroundImage = 'linear-gradient(rgba(12,20,29,0.35), rgba(12,20,29,0.55)), url("' + posterUrl.replace(/"/g, '') + '")';
    } else {
      reelStage.style.backgroundImage = '';
    }
    var acct = triggerBtn.getAttribute('data-ubc-acct') || '@ubcbike.tampa';
    var titleTxt = lang === 'es'
      ? (triggerBtn.getAttribute('data-ubc-title-es') || triggerBtn.getAttribute('data-ubc-title') || 'UBC Video')
      : (triggerBtn.getAttribute('data-ubc-title') || 'UBC Video');
    var capTxt = lang === 'es'
      ? (triggerBtn.getAttribute('data-ubc-caption-es') || triggerBtn.getAttribute('data-ubc-caption') || '')
      : (triggerBtn.getAttribute('data-ubc-caption') || '');

    if (reelAcctEl) reelAcctEl.textContent = acct;
    if (reelTitleEl) reelTitleEl.textContent = titleTxt;
    if (reelCaptionEl && capTxt) reelCaptionEl.textContent = capTxt;
    if (reelExtLink) {
      reelExtLink.setAttribute(
        'href',
        code
          ? 'https://www.instagram.com/p/' + encodeURIComponent(code) + '/'
          : (acct === '@ubcbike.alafia' ? 'https://www.instagram.com/ubcbike.alafia/' : 'https://www.instagram.com/ubcbike.tampa/')
      );
    }

    if (videoUrl) {
      reelStage.innerHTML = '<video src="' + esc(videoUrl) + '" controls autoplay playsinline></video>';
    } else {
      var embedSrc = 'https://www.instagram.com/p/' + encodeURIComponent(code) + '/embed/';
      reelStage.innerHTML =
        '<iframe src="' + esc(embedSrc) + '" title="' + esc(titleTxt) + '" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="eager"></iframe>';
    }

    reelModal.removeAttribute('hidden');
    if (document.body) document.body.style.overflow = 'hidden';
    if (reelCloseBtn) {
      setTimeout(function () { reelCloseBtn.focus(); }, 40);
    }
  }

  document.addEventListener('click', function (e) {
    var reelTrigger = e.target && e.target.closest ? e.target.closest('[data-ubc-reel]') : null;
    if (reelTrigger) {
      e.preventDefault();
      openReelModal(reelTrigger);
      return;
    }
    var closeEl = e.target && e.target.closest ? e.target.closest('[data-ubc-reel-close]') : null;
    if (closeEl) {
      e.preventDefault();
      closeReelModal();
    }
  });

  /* ---------- 13b. Spanish dictionary for Shopify / Dawn strings ----------
     English is the store default. Strings rendered by Shopify/Dawn Liquid (buttons, cart, search,
     pickup, filters) have no data-es attribute, so in ES mode they are translated here by exact text
     and restored to the original English when switching back. */
  var UBC_ES = {
    'Sale': 'Oferta', 'Sold out': 'Agotado', 'Unavailable': 'No disponible', 'Regular price': 'Precio habitual',
    'Sale price': 'Precio de oferta', 'Unit price': 'Precio unitario', 'Vendor:': 'Proveedor:',
    'Add to cart': 'Agregar al carrito', 'Quantity': 'Cantidad', 'Share': 'Compartir',
    'Tax included.': 'Impuestos incluidos.', 'Shipping calculated at checkout.': 'Envío calculado al pagar.',
    'Pickup available at': 'Retiro disponible en', 'Pickup currently unavailable at': 'Retiro no disponible por ahora en',
    'Usually ready in 24 hours': 'Normalmente listo en 24 horas', 'Usually ready in 2 hours': 'Normalmente listo en 2 horas',
    'Usually ready in 2-4 days': 'Normalmente listo en 2-4 días', 'Usually ready in 5+ days': 'Normalmente listo en 5+ días',
    'Pickup available, usually ready in 24 hours': 'Retiro disponible, normalmente listo en 24 horas',
    'Pickup available, usually ready in 2 hours': 'Retiro disponible, normalmente listo en 2 horas',
    'Pickup available, usually ready in 2-4 days': 'Retiro disponible, normalmente listo en 2-4 días',
    'Pickup available, usually ready in 5+ days': 'Retiro disponible, normalmente listo en 5+ días',
    'Check availability at other stores': 'Ver disponibilidad en otras tiendas', 'View store information': 'Ver información de la tienda',
    'Your cart': 'Tu carrito', 'Your cart is empty': 'Tu carrito está vacío', 'Continue shopping': 'Seguir comprando',
    'Have an account?': '¿Tienes una cuenta?', 'Log in': 'Inicia sesión', 'to check out faster.': 'para pagar más rápido.',
    'Estimated total': 'Total estimado', 'Check out': 'Pagar', 'Product': 'Producto', 'Remove': 'Eliminar',
    'Taxes, discounts and shipping calculated at checkout.': 'Impuestos, descuentos y envío calculados al pagar.',
    'Taxes and shipping calculated at checkout': 'Impuestos y envío calculados al pagar',
    'Item added to your cart': 'Artículo agregado a tu carrito', 'View cart': 'Ver carrito',
    'Order special instructions': 'Instrucciones especiales del pedido',
    'Search': 'Buscar', 'Search results': 'Resultados de búsqueda', 'Sort by:': 'Ordenar por:', 'Filter:': 'Filtrar:',
    'Filter': 'Filtrar', 'Filter and sort': 'Filtrar y ordenar', 'Availability': 'Disponibilidad', 'In stock': 'En stock',
    'Out of stock': 'Agotado', 'Price': 'Precio', 'Remove all': 'Quitar todo', 'Clear': 'Borrar', 'Apply': 'Aplicar',
    'Relevance': 'Relevancia', 'Best selling': 'Más vendidos', 'Alphabetically, A-Z': 'Alfabético, A-Z',
    'Alphabetically, Z-A': 'Alfabético, Z-A', 'Price, low to high': 'Precio, menor a mayor',
    'Price, high to low': 'Precio, mayor a menor', 'Date, old to new': 'Fecha, más antiguos',
    'Date, new to old': 'Fecha, más nuevos', 'Load more': 'Cargar más',
    'Shop Location:': 'Tienda:', 'Both Stores': 'Ambas tiendas', 'Brand:': 'Marca:', 'Price:': 'Precio:', 'Sort:': 'Ordenar:',
    'Any Price': 'Cualquier precio', 'Under $50': 'Menos de $50', 'Featured': 'Destacados',
    'Price: High to Low': 'Precio: mayor a menor', 'Price: Low to High': 'Precio: menor a mayor',
    'Alphabetical: A – Z': 'Alfabético: A – Z', 'Newest Arrivals': 'Lo más nuevo', 'Clear all filters ×': 'Quitar filtros ×',
    'Live Inventory · UBC In-Store (Tampa & Alafia) + Available at Supplier Warehouse': 'Inventario en vivo · UBC en tienda (Tampa y Alafia) + disponible en bodega del proveedor',
    'In Store Today · UBC Tampa Showroom (2502 E Fletcher Ave)': 'En tienda hoy · UBC Tampa Showroom (2502 E Fletcher Ave)',
    'In Store Today · UBC Alafia River State Park (Lithia Trailhead)': 'En tienda hoy · UBC Alafia River State Park (Lithia Trailhead)',
    'All In-Stock': 'Todo en stock', 'All Bikes': 'Todas las bicis', 'Electric Bikes': 'Bicis eléctricas',
    'Road & Gravel': 'Ruta y gravel', 'Mountain Bikes': 'Bicis de montaña', 'Hybrid & Urban': 'Híbridas y urbanas',
    'Kids Bikes': 'Bicis para niños', 'Helmets': 'Cascos', 'Apparel': 'Ropa', 'Shoes': 'Zapatos',
    'Sunglasses': 'Gafas de sol', 'Tires': 'Llantas', 'Tubes': 'Cámaras', 'Parts': 'Repuestos', 'Saddles': 'Sillines',
    'Pedals': 'Pedales', 'Nutrition': 'Nutrición', 'Bottles & Cages': 'Botellas y portabotellas',
    'Accessories': 'Accesorios', 'Tools & Care': 'Herramientas y cuidado',
    'At Warehouse · Available to Order': 'En bodega · Disponible por pedido',
    'At Warehouse · Available by Order': 'En bodega · Disponible por pedido',
    'In-store pickup only · Tampa': 'Solo retiro en tienda · Tampa',
    '← All Departments': '← Todos los departamentos',
    'All Parts': 'Todos los repuestos',
    'All Tires & Tubes': 'Todas las llantas y cámaras',
    'All Hydration & Nutrition': 'Toda hidratación y nutrición',
    'Bike Service & Repair': 'Servicio y Reparación de Bicis',
    'Tune-Up Packages': 'Paquetes de Mantenimiento',
    'How To Find Us': 'Cómo Encontrarnos',
    'Get Directions': 'Cómo Llegar',
    'Contact Us': 'Contáctanos',
    'Financing': 'Financiamiento',
    'Ride Now. Pay Later.': 'Rueda Hoy. Paga Después.',
    'Your Financing Options': 'Tus Opciones de Financiamiento',
    "Buyer's Guide": 'Guía de Compra',
    'Bike Size Chart': 'Tabla de Tallas',
    'What is the UBC Difference?': '¿Qué es la Diferencia UBC?',
    '5 Reasons to Buy Your Next Bike at UBC': '5 Razones para Comprar tu Próxima Bici en UBC',
    'Apply Now': 'Solicitar Ahora',
    'Payment Calculator': 'Calculadora de Pagos',
    'Manage Account': 'Administrar Cuenta',
    /* Rentals, Financing, Workshop, Maps & Trade-In */
    'Inside Alafia River State Park': 'Dentro de Alafia River State Park',
    'Peak Season · 28 Trails': 'Temporada Alta · 28 Senderos',
    'Trailhead Shop & Rentals · Inside Alafia': 'Tienda y Rentas · Dentro de Alafia',
    'Book Bike Rental →': 'Reservar Bicicleta →',
    'Book Bike Rental': 'Reservar Bicicleta',
    'Primary Park · Open Live Map →': 'Mapa en Vivo →',
    'Approved Cases · Open Live Map →': 'Mapa en Vivo →',
    'Full Financing Details': 'Ver Detalles de Financiamiento',
    'Most Popular': 'Más Popular',
    '0% APR Promo': 'Promo 0% APR',
    '6 to 12 Months Special Financing': '6 a 12 Meses sin Intereses',
    'Split qualifying bikes, e-bikes and gear into equal monthly payments with 0% APR promotional financing via Synchrony Freedom to Ride.': 'Divide bicis, e-bikes y equipo elegibles en pagos mensuales iguales a 0% APR con Synchrony Freedom to Ride.',
    'Apply In-Store or Call': 'Solicitar en Tienda o Llamar',
    'No Credit Needed': 'Sin Crédito Tradicional',
    'Up to $5,000': 'Hasta $5,000',
    'Flexible Lease-to-Own': 'Lease-to-Own Flexible',
    'Fast mobile approvals up to $5,000 with payment schedules matched to your payday and early purchase savings options.': 'Aprobación rápida en el celular hasta $5,000 con pagos ajustados a tu quincena y ahorro por compra anticipada.',
    'Apply Online at Acima': 'Aplicar en Línea con Acima',
    'Instant Decision': 'Decisión al Instante',
    'Buy Now, Pay Later': 'Paga Después',
    'All Credit Welcome': 'Todo Crédito Bienvenido',
    'Ideal for bikes, electric scooters, accessories or major workshop builds — apply online in minutes with instant approval decisions.': 'Ideal para bicis, scooters eléctricos, accesorios o trabajos de taller — solicita en minutos con respuesta inmediata.',
    'Apply Online at Snap': 'Aplicar en Línea con Snap',
    'Instant Credit': 'Crédito Inmediato',
    'Bike Trade-In': 'Trade-In de Bicicletas',
    'Official Partner Valuation': 'Tasación Oficial de Socio',
    'Bring your current bike to our Tampa showroom for a transparent valuation and apply instant trade-in credit toward your upgrade.': 'Trae tu bici actual a nuestro showroom de Tampa para una tasación transparente y aplica crédito al instante en tu nueva bici.',
    'Value Your Trade-In': 'Cotizar mi Bici (Trade-In)',
    'Trade-In Your Used Bike': 'Cambia tu Bicicleta Usada (Trade-In)',
    'OFFICIAL BICYCLEBLUEBOOK.COM PARTNER / INSTANT IN-STORE CREDIT': 'SOCIO OFICIAL DE BICYCLEBLUEBOOK.COM / CRÉDITO INMEDIATO EN TIENDA',
    'Quick Turnaround': 'Entrega Rápida',
    'Multi-Brand Bay': 'Todas las Marcas',
    'Everyday & Campus Bikes': 'Bicis Diarias y Campus',
    'Flats, brakes, chains & safety checks.': 'Pinchazos, frenos, cadenas y seguridad.',
    'E-Bikes & Scooters': 'E-Bikes y Scooters',
    'Tires, hydraulic bleeds & diagnostics.': 'Llantas, purgado hidráulico y diagnóstico.',
    'Pro Carbon & Full MTB': 'Carbono Pro y MTB',
    'AXS, Di2, suspension & tubeless builds.': 'AXS, Di2, suspensión y tubeless.',
    'Tough & Custom Fixes': 'Retos y Restauración',
    'Hand-built wheels & vintage restorations.': 'Ruedas a mano y restauraciones clásicas.',
    'Tampa Pro Workshop · Since 1972': 'Taller Pro en Tampa · Desde 1972',
    '13–28+ Yrs Techs': 'Técnicos 13–28+ Años',
    'Maps & Trails': 'Mapas y Senderos',
    'TAMPA BAY RIDE GUIDE / LIVE GPS & PRINTABLE MAPS / SINCE 1972': 'GUÍA DE TAMPA BAY / MAPAS GPS Y DESCARGABLES / DESDE 1972',
    "Explore Tampa Bay's best mountain bike parks and paved greenways with live interactive GPS trail maps and difficulty filters, or save printable maps before you ride.": 'Explora los mejores parques de MTB y rutas pavimentadas de Tampa Bay con mapas GPS interactivos y filtros de dificultad, o descarga mapas para llevar.',
    'Alafia Interactive Map': 'Mapa Interactivo de Alafia',
    'Interactive Maps': 'Mapas Interactivos',
    'Downloadable Maps': 'Mapas Descargables',
    'Bike Rentals': 'Renta de Bicicletas',
    'Hours & Directions': 'Horarios y Ubicación',
    /* Black Friday 2026 Draft Theme */
    'Black Friday & Holiday Event': 'Evento Black Friday y Navidad',
    'Switch Doorbuster Deal': 'Cambiar Oferta Destacada',
    'Available Option / Size': 'Opción / Talla Disponible',
    'In stock · Ready today in Tampa': 'En stock · Lista hoy en Tampa',
    'Sold out in this size': 'Agotada en esta talla',
    'Black Friday': 'Black Friday',
    'Price': 'Precio',
    'Add to Cart': 'Agregar al Carrito',
    'Full Store →': 'Tienda →',
    'Alafia Rentals': 'Alafia',
    'Black Friday & Holiday Event · Live Tampa Inventory': 'Black Friday y Navidad · Inventario Real en Tampa',
    'Direct showroom markdowns on Black Friday 2026 bikes, e-bikes, helmets, cycling shoes, and pro parts — ready for same-day pickup in Tampa or free holiday hold until Dec 24.': 'Descuentos directos en tienda en bicis, e-bikes, cascos, zapatos y repuestos — listos para retirar hoy en Tampa o apartado gratis hasta el 24 de dic.',
    'Shop All Deals →': 'Ver Ofertas →',
    'Black Friday 2026 Clearance': 'Liquidación BF 2026',
    'Save Up to $3,500': 'Hasta $3,500 Off',
    'Bikes & E-Bikes': 'Bicis y E-Bikes',
    '40% – 60% Off': '40% – 60% Off',
    'Helmets & Shoes': 'Cascos y Zapatos',
    'Up to 58% Off': 'Hasta 58% Off',
    'Apparel & Pro Parts': 'Ropa y Repuestos',
    'Holiday Gifts': 'Regalos Navidad',
    'Deals Under $150': 'Menos de $150',
    'All Deals': 'Todas',
    'Black Friday 2026 Picks': 'Selección BF 2026',
    'Black Friday 2026': 'BF 2026',
    'Apparel & Parts': 'Ropa y Piezas',
    'Under $150': 'Menos de $150',
    'In Stock · Tampa': 'En Stock',
    'View Deal →': 'Ver →',
    'Show More Deals': 'Ver Más Ofertas',
    'View Black Friday 2026 Clearance →': 'Ver Liquidación BF 2026 →',
    'Beyond Black Friday · Full Tampa Showroom & Online Catalog': 'Más Allá de Black Friday · Catálogo Completo de UBC',
    'Shop All 20,000+ Items By Department': 'Explora los 20,000+ Artículos por Departamento',
    'Browse Full Store →': 'Toda la Tienda →',
    'E-Bikes': 'E-Bikes',
    'Helmets & Protection': 'Cascos',
    'Tires & Tubes': 'Llantas',
    'Parts & Drivetrain': 'Repuestos',
    'Lights, Bags & Locks': 'Luces y Candados',
    'Hydration & Bottles': 'Hidratación',
    'Apparel & Shoes': 'Ropa y Zapatos',
    'All Accessories': 'Accesorios',
    'Free Holiday Layaway · Until Dec 24': 'Apartado Navideño Gratis · Hasta Dic 24',
    'Lock In Black Friday Pricing. Pick Up Christmas Eve.': 'Asegura Precio Black Friday. Retira en Nochebuena.',
    'Shop Black Friday 2026 Bikes →': 'Ver Bicis Black Friday 2026 →',
    'Ask About Hold': 'Consultar Apartado',
    'Workshop Bonus & Rider Gifts': 'Bono de Taller y Regalos Ciclistas',
    '$25 Off Overhauls & Up to 60% Off Gifts': '$25 Off en Overhauls y Hasta 60% Off en Regalos',
    'Text the Shop (Ikeono)': 'Escribir a la Tienda (Ikeono)',
    'Authorized Dealer': 'Distribuidor Autorizado',
    'Full Factory Warranty': 'Garantía de Fábrica',
    'Every bike and part is 100% factory-authorized and backed by full manufacturer warranty support at UBC Tampa.': 'Cada bici y repuesto es 100% autorizado de fábrica y cuenta con garantía oficial del fabricante en UBC Tampa.',
    'Flexible Payments': 'Pagos Flexibles',
    '0% APR Financing': 'Financiamiento 0% APR',
    'Pro Assembly': 'Armado Profesional',
    'Lifetime Adjustments': 'Ajustes de por Vida',
    'Ready Today': 'Listo Hoy Mismo',
    'Same-Day Pickup': 'Retiro el Mismo Día',
    'In-Stock': 'En Stock ·',
    'Black Friday Deals': 'Ofertas Black Friday',
    'DEC 24': 'DIC 24',
    'Up to $3,500 OFF Black Friday 2026 Bikes · Up to 60% OFF Gear · Free Hold Until Dec 24 · Peak-Season Alafia Rentals': 'Hasta $3,500 OFF en Bicis Black Friday 2026 · Hasta 60% OFF en Equipo · Apartado Gratis hasta Dic 24 · Rentas Alafia',
    'Up to $3,500 OFF Black Friday 2026 Bikes': 'Hasta $3,500 OFF en Bicis Black Friday 2026',
    'Up to 60% OFF Gear · Free Hold Until Dec 24 · Peak-Season': 'Hasta 60% OFF en Equipo · Apartado Gratis hasta Dic 24 · Temporada Alta',
    'Ready-to-wrap rider gifts in stock at UBC Tampa': 'Regalos ciclistas listos para envolver en UBC Tampa',
    'SRAM AXS, Troy Lee Designs, Supacaz & tires': 'SRAM AXS, Troy Lee Designs, Supacaz y llantas',
    "Reserve any in-stock Black Friday 2026 bike or e-bike today at Black Friday markdowns up to $3,500 off. Manny & Ashton's mechanics assemble, safety-check, and store it hidden in our Tampa warehouse until you're ready.": 'Reserva hoy cualquier bici o e-bike Black Friday 2026 en stock con descuentos de hasta $3,500. Los mecánicos de Manny y Ashton la arman, revisan y guardan en nuestra bodega de Tampa hasta que estés listo.',
    'Pair 40%–60% off MIPS helmets, Sidi/Shimano shoes, and Troy Lee apparel with our Black Friday Workshop Bonus: $25 off Level 3 Overhauls, free drivetrain wash on Level 2, plus Alafia Trailhead Rental Passes.': 'Combina 40%–60% de descuento en cascos MIPS, zapatos Sidi/Shimano y ropa Troy Lee con nuestro Bono de Taller Black Friday: $25 de descuento en Overhaul Nivel 3, lavado de transmisión gratis en Nivel 2 y pases de renta en Alafia.',
    'Find an identical in-stock bike or gear item for less at an authorized dealer and we beat the difference by 10%.': 'Si encuentras una bici o accesorio idéntico en stock a menor precio en un distribuidor autorizado, mejoramos la diferencia en un 10%.',
    'Split your Black Friday bike or e-bike purchase into easy monthly payments with promotional 0% APR options.': 'Divide tu compra de bici o e-bike Black Friday en cómodos pagos mensuales con opciones promocionales 0% APR.',
    'Every bike bought at UBC Tampa is built by certified mechanics and includes free lifetime adjustments for the original owner.': 'Cada bici comprada en UBC Tampa es armada por mecánicos certificados e incluye ajustes gratis de por vida para el dueño original.',
    'Skip shipping delays — test ride and pick up in-stock Black Friday deals at 1220 E Fletcher Ave in Tampa.': 'Evita demoras de envío — pruébala y retira hoy tus ofertas Black Friday en stock en 1220 E Fletcher Ave, Tampa.',
    'Ashton · MTB & Road': 'Ashton · MTB y Ruta',
    'Manny · 47½+ Yrs': 'Manny · 47½+ Años'
  };
  var UBC_ES_RX = [
    [/^([\d,]+) results$/, '$1 resultados'], [/^([\d,]+) result$/, '$1 resultado'],
    [/^([\d,]+) products$/, '$1 productos'], [/^([\d,]+) product$/, '$1 producto'],
    [/^All Brands \((\d+)\)$/, 'Todas las marcas ($1)'],
    [/^At Warehouse · Ready in (\d+) days$/, 'En bodega · Listo en $1 días'],
    [/^Quantity \((\d+) in cart\)$/, 'Cantidad ($1 en el carrito)'],
    [/^SAVE \$(\d[\d,]*)$/, function (_, n) { return 'AHORRA $' + n; }],
    [/^Save \$(\d[\d,]*)$/, function (_, n) { return 'Ahorra $' + n; }],
    [/^Deal (\d+) of (\d+)$/, 'Oferta $1 de $2'],
    [/^Showing (\d+) of (\d+) In-Stock Deals$/, 'Mostrando $1 de $2 ofertas en stock'],
    [/^Shop All (\d+) Deals →$/, 'Ver $1 Ofertas →'],
    [/^All (\d+) Deals$/, '$1 Ofertas'],
    [/^Browse All (\d+) Black Friday Deals →$/, 'Ver Todas las $1 Ofertas Black Friday →'],
    [/^Black Friday 2026 Deal · (.+)$/, 'Oferta Black Friday 2026 · $1'],
    [/^-(\d+)% OFF · Save \$(\d[\d,]*)$/, function (_, p, n) { return '-' + p + '% OFF · Ahorra $' + n; }],
    [/^Call (.+)$/, 'Llamar $1']
  ];
  var ubcOrigText = typeof WeakMap === 'function' ? new WeakMap() : null;
  function ubcEsFor(key) {
    if (Object.prototype.hasOwnProperty.call(UBC_ES, key)) return UBC_ES[key];
    for (var i = 0; i < UBC_ES_RX.length; i++) {
      if (UBC_ES_RX[i][0].test(key)) return key.replace(UBC_ES_RX[i][0], UBC_ES_RX[i][1]);
    }
    return null;
  }
  function ubcTranslateTree(root, toEs) {
    if (!root || !ubcOrigText || !document.createTreeWalker) return;
    var walker = document.createTreeWalker(root, 4, null, false); // 4 = SHOW_TEXT
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentNode;
      if (!parent || parent.nodeType !== 1) continue;
      var tag = parent.nodeName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') continue;
      if (parent.closest && parent.closest('[data-es]')) continue; // handled by data-es
      if (toEs) {
        var raw = ubcOrigText.has(node) ? ubcOrigText.get(node) : node.nodeValue;
        var key = raw.replace(/\s+/g, ' ').trim();
        if (key.length < 2) continue;
        var es = ubcEsFor(key);
        if (es !== null) {
          if (!ubcOrigText.has(node)) ubcOrigText.set(node, raw);
          var want = raw.replace(raw.trim(), function () { return es; });
          if (node.nodeValue !== want) node.nodeValue = want;
        }
      } else if (ubcOrigText.has(node)) {
        if (node.nodeValue !== ubcOrigText.get(node)) node.nodeValue = ubcOrigText.get(node);
      }
    }
    if (root.querySelectorAll) {
      Array.prototype.forEach.call(root.querySelectorAll('input[placeholder]:not([data-es-placeholder])'), function (el) {
        if (el.getAttribute('data-en-ph') == null) el.setAttribute('data-en-ph', el.getAttribute('placeholder') || '');
        var enPh = el.getAttribute('data-en-ph');
        var esPh = ubcEsFor(enPh.trim());
        var wantPh = toEs && esPh !== null ? esPh : enPh;
        if (el.getAttribute('placeholder') !== wantPh) el.setAttribute('placeholder', wantPh);
      });
    }
  }

  /* ---------- 14. Bilingual EN / ES Switcher ---------- */
  function applyLanguage(nextLang) {
    lang = nextLang === 'es' ? 'es' : 'en';
    try { localStorage.setItem('ubc-lang', lang); } catch (e) {}

    qsa('.fb-lang button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-lang') === lang ? 'true' : 'false');
    });

    qsa('[data-es]').forEach(function (el) {
      if (el.dataset.en == null) el.dataset.en = el.innerHTML;
      el.innerHTML = lang === 'es' ? el.getAttribute('data-es') : el.dataset.en;
    });

    qsa('[data-es-placeholder]').forEach(function (el) {
      if (el.dataset.enPlaceholder == null) el.dataset.enPlaceholder = el.getAttribute('placeholder') || '';
      el.setAttribute('placeholder', lang === 'es' ? el.getAttribute('data-es-placeholder') : el.dataset.enPlaceholder);
    });

    ubcTranslateTree(document.body, lang === 'es');

    qsa('.plan-toggle').forEach(function (btn) {
      var card = btn.closest('.plan');
      var open = card && card.classList.contains('is-open');
      var attr = open ? (lang === 'es' ? 'data-less-es' : 'data-less') : (lang === 'es' ? 'data-more-es' : 'data-more');
      btn.textContent = btn.getAttribute(attr) || btn.textContent;
    });

    if (ikTopicsWrap && ikMsg && !ikUserTyped) {
      var activeTopic = qs('.ik-topic[aria-pressed="true"]', ikTopicsWrap);
      if (activeTopic) {
        var nextTpl = lang === 'es'
          ? (activeTopic.getAttribute('data-ik-topic-es') || activeTopic.getAttribute('data-ik-topic'))
          : activeTopic.getAttribute('data-ik-topic');
        if (nextTpl) ikMsg.value = nextTpl;
        syncIkeonoSmsHref();
      }
    }

    renderHeroSlide(heroIdx, true);
    renderNewArrivals();
    renderStockGrid();
    renderFinder();
    renderGearExplorer();
    renderStoreLocator();
    if (typeof applyEdition === 'function' && ED_META && ED_META[edition]) {
      applyEdition(edition, false);
    }
  }

  qsa('.fb-lang button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.getAttribute('data-lang') === 'es' ? 'es' : 'en';
      try { localStorage.setItem('ubc-lang', target); } catch (e) {}
      var loc = window.__ubcLocale;
      if (loc && loc.hasEs) {
        var curIsEs = (loc.current || '').toLowerCase().indexOf('es') === 0;
        var p = window.location.pathname || '/';
        if (target === 'es' && !curIsEs) {
          var esPath = p === '/' ? '/es' : (p === '/es' || p.indexOf('/es/') === 0 ? p : '/es' + p);
          window.location.href = esPath + window.location.search + window.location.hash;
          return;
        }
        if (target === 'en' && curIsEs) {
          var enPath = (p === '/es' || p === '/es/') ? '/' : p.replace(/^\/es(?=\/)/, '');
          window.location.href = (enPath || '/') + window.location.search + window.location.hash;
          return;
        }
      }
      applyLanguage(target);
    });
  });

  renderNewArrivals();
  renderStockGrid();
  renderFinder();
  renderGearExplorer();
  renderStoreLocator();

  function syncResponsiveAccordions() {
    var wide = window.innerWidth > 760;
    qsa('details.foot-acc').forEach(function (d) {
      if (wide) {
        d.setAttribute('open', '');
      } else if (!d.dataset.userToggled) {
        d.removeAttribute('open');
      }
    });
    var isStandaloneSl = !!(slRoot && slRoot.classList.contains('sl-sec--page'));
    qsa('details.sl-hours-acc').forEach(function (d) {
      if (isStandaloneSl && wide) {
        d.setAttribute('open', '');
      } else if (!d.dataset.userToggled) {
        d.removeAttribute('open');
      }
    });
  }
  qsa('details.foot-acc').forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (window.innerWidth <= 760) d.dataset.userToggled = '1';
    });
  });
  syncResponsiveAccordions();
  window.addEventListener('resize', syncResponsiveAccordions);

  if (slRoot) {
    var gmapsKey = (slRoot.getAttribute('data-gmaps-key') || '').trim();
    if (gmapsKey) bootVectorGoogleMaps(gmapsKey);
  }
  if (lang === 'es') applyLanguage('es');
  // The store's Shopify language is Spanish, so Liquid strings like the "Oferta" / "Agotado" badges are
  // rendered in Spanish. In English mode, switch the elements that carry an explicit data-en text.
  else qsa('[data-en][data-es]').forEach(function (el) { el.innerHTML = el.getAttribute('data-en'); });
  // Product cards loaded later (filters, sorting, pagination, recommendations) get the same language.
  if (window.MutationObserver) {
    var ubcLangTimer = null;
    new MutationObserver(function (muts) {
      var hasNew = muts.some(function (m) {
        return Array.prototype.some.call(m.addedNodes, function (n) {
          return n.nodeType === 1 && (n.hasAttribute && n.hasAttribute('data-es') || (n.querySelector && n.querySelector('[data-es]')));
        });
      });
      // In ES mode, any new content (filters, cart drawer, variant changes) also gets the dictionary.
      var hasText = lang === 'es' && muts.some(function (m) { return m.type === 'childList' && m.addedNodes.length > 0; });
      if (!hasNew && !hasText) return;
      clearTimeout(ubcLangTimer);
      ubcLangTimer = setTimeout(function () {
        if (lang === 'es') ubcTranslateTree(document.body, true);
        qsa('[data-es]').forEach(function (el) {
          if (el.dataset.en == null) el.dataset.en = el.innerHTML;
          var want = lang === 'es' ? el.getAttribute('data-es') : el.dataset.en;
          if (el.innerHTML !== want) el.innerHTML = want;
        });
      }, 150);
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ---------- Live Interactive Theme Edition Switcher (6 Distinct Seasonal Worlds) ---------- */
  var ED_META = {
    classic: {
      name: 'Classic',
      dot: '#CCBB8D',
      heroSlide: 0,
      topEn: '<b>Free shipping $50+</b> &middot; Walk-in repair workshop open all day in Tampa',
      topEs: '<b>Envío gratis $50+</b> &middot; Taller sin cita abierto todo el día en Tampa',
      navEn: 'Deals & New',
      navEs: 'Promos y Nuevo',
      heroEyeEn: '3-Generation Family Cycling Shop · Tampa Since 1972',
      heroEyeEs: '3 Generaciones en Familia · Bicis, Equipo, Piezas y Taller desde 1972',
      aprEn: 'Free Pickup · 0% APR Available',
      aprEs: 'Envío gratis $50+ · 0% APR',
      cta2En: 'Shop Deals & Gear',
      cta2Es: 'Promos, equipo y novedades',
      naEyeEn: 'Promos, Activities & Pro-Shop · 20,000+ Items',
      naEyeEs: 'Promos, Actividades y Tienda · 20,000+ Productos',
      naH2En: 'More than bikes. <em>Active promos &amp; fresh gear.</em>',
      naH2Es: 'Mucho más que bicis. <em>Promos y equipo hoy.</em>',
      promos: [
        { pill: ['Factory Warranty', 'Garantía Oficial'], kicker: ['Floor Stock', 'En Piso Hoy'], h3: ['Assembled Bikes & E-Bikes Ready Today', 'Bicis y E-Bikes Armadas Hoy'], p: ['Built and safety-checked by senior Tampa mechanics.', 'Armadas y ajustadas por mecánicos senior en Tampa.'], cta: ['Find Your Bike', 'Buscar Bici'] },
        { pill: ['Weekly Promos', 'Promos Activas'], kicker: ['Helmets & Fuel', 'Cascos y Nutrición'], h3: ['15% Off Road Helmets & Skratch Fuel', '15% Off Cascos MIPS e Hidratación'], p: ['5-star Virginia Tech helmets, GP5000 tires & hydration.', 'Cascos 5 estrellas, llantas GP5000 e hidratación real.'], cta: ['Shop Active Promos', 'Ver Ofertas'] },
        { pill: ['0% APR · Trade-In', '0% APR · Retoma'], kicker: ['Since 1972', 'Desde 1972'], h3: ['0% Promotional Financing & Bike Trade-In', 'Financiamiento 0% APR y Retoma'], p: ['Upgrade your ride today with instant BicycleBlueBook credit.', 'Estrena hoy aplicando tu bici actual como parte de pago.'], cta: ['See Financing', 'Ver Financiamiento'] }
      ]
    },
    black_friday: {
      name: 'Black Friday',
      dot: '#E04F33',
      heroSlide: 4,
      topEn: '<b>BLACK FRIDAY EVENT</b> &middot; Up to $500 Off bikes + 20% Off helmets &amp; gear',
      topEs: '<b>BLACK FRIDAY UBC</b> &middot; Hasta $500 Off en bicis + 20% Off equipo',
      navEn: 'Black Friday',
      navEs: 'Black Friday',
      heroEyeEn: 'Black Friday Event · Storewide Deals + Free Assembly',
      heroEyeEs: 'Black Friday UBC · Hasta $500 Off + Armado Gratis',
      aprEn: 'Black Friday Price · 0% APR',
      aprEs: 'Precio Black Friday · 0% APR',
      cta2En: 'See Black Friday Promos',
      cta2Es: 'Ver promos Black Friday',
      naEyeEn: 'Black Friday Event · Promos, Discounts & Storewide Picks',
      naEyeEs: 'Black Friday UBC · Promos, Descuentos y Destacados',
      naH2En: 'Black Friday deals. <em>Every department live.</em>',
      naH2Es: 'Ofertas Black Friday. <em>Toda la tienda activa.</em>',
      promos: [
        { pill: ['Up to $500 OFF', 'Hasta $500 Off'], kicker: ['Bikes & E-Bikes', 'Bicis y E-Bikes'], h3: ['In-Stock Turbo, Carbon & MTB Deals', 'Doorbusters en Ruta, Trail y Turbo'], p: ['Direct showroom markdowns + 0% APR financing & pro assembly.', 'Descuentos directos en piso + financiamiento 0% APR y armado pro.'], cta: ['See Bike Deals', 'Ver Bicis en Oferta'] },
        { pill: ['20% – 30% OFF', '20% – 30% Off'], kicker: ['Gear, Tires & Parts', 'Cascos, Llantas y Piezas'], h3: ['MIPS Helmets, GP5000 & Pro Saddles', 'Cascos MIPS, GP5000 y Accesorios'], p: ['Black Friday pricing on 5-star helmets, lights, fuel & OEM parts.', 'Precios Black Friday en cascos 5 estrellas, luces y nutrición.'], cta: ['Filter BF Deals', 'Filtrar Ofertas'] },
        { pill: ['$25 Workshop Bonus', 'Bono de Taller'], kicker: ['Walk-In Service', 'Sin Cita · Tampa'], h3: ['Free Drivetrain Wash or $25 Off Overhaul', 'Lavado Pro Gratis o $25 Off Overhaul'], p: ['Drop off any bike, scooter or e-bike this week — no appointment needed.', 'Trae tu bici, scooter o e-bike sin cita esta semana al taller.'], cta: ['Visit Workshop', 'Ir al Taller'] }
      ]
    },
    christmas: {
      name: 'Christmas',
      dot: '#C81E2B',
      heroSlide: 1,
      topEn: '<b>HOLIDAY GIFT EVENT</b> &middot; Assembled bikes, helmets &amp; gifts ready for Dec 25',
      topEs: '<b>ESPECIAL DE NAVIDAD</b> &middot; Bicis armadas y regalos listos para Dic 25',
      navEn: 'Holiday Gifts',
      navEs: 'Regalos Navidad',
      heroEyeEn: 'Holiday Gift Edition · Free Bike Hold & Rider Gifts Since 1972',
      heroEyeEs: 'Especial de Navidad · Apartado Gratis y Regalos Ciclistas',
      aprEn: 'Ready for Dec 25 · 0% APR',
      aprEs: 'Lista para Dic 25 · 0% APR',
      cta2En: 'Explore Holiday Promos',
      cta2Es: 'Ver regalos y promos',
      naEyeEn: 'Holiday Gift Hub · Promos, Free Bike Hold & Rider Gifts',
      naEyeEs: 'Navidad en UBC · Regalos, Apartados y Promos',
      naH2En: 'Holiday gift picks &amp; <em>festive promos.</em>',
      naH2Es: 'Regalos ciclistas y <em>promos de Navidad.</em>',
      promos: [
        { pill: ['Free Layaway', 'Apartado Gratis'], kicker: ['Hold Until Dec 24', 'Hasta Dic 24'], h3: ['Free Holiday Bike Hold & Assembly', 'Apartado Navideño y Armado Pro'], p: ['Pick their dream bike today; our crew builds and stores it until Christmas Eve.', 'Elige la bici hoy; la armamos y guardamos hasta Nochebuena.'], cta: ['Find Gift Bikes', 'Elegir Bici Regalo'] },
        { pill: ['Under $150 Gifts', 'Regalos < $150'], kicker: ['Stocking Stuffers', 'Ideas Ciclistas'], h3: ['MIPS Helmets, Lights, Tools & Hydration', 'Cascos MIPS, Luces, Herramientas y Más'], p: ['Curated rider gifts in stock for immediate Tampa pickup or shipping.', 'Regalos ciclistas en stock para retiro hoy en Tampa o envío.'], cta: ['Shop Rider Gifts', 'Ver Regalos'] },
        { pill: ['0% APR · 12 Mo', '0% APR · 12 Meses'], kicker: ['Holiday Financing', 'Financiamiento'], h3: ['Gift Today, Pay Over Time at 0% APR', 'Regala Hoy con 0% APR en Tienda'], p: ['Flexible holiday financing plus extended January size exchange.', 'Financiamiento flexible y cambio de talla extendido en enero.'], cta: ['Learn More', 'Más Información'] }
      ]
    },
    july_4: {
      name: 'July 4th',
      dot: '#2563EB',
      heroSlide: 2,
      topEn: '<b>JULY 4TH SUMMER EVENT</b> &middot; Storewide Markdowns + Special Discounts for Veterans &amp; Police',
      topEs: '<b>ESPECIAL 4 DE JULIO</b> &middot; Ofertas de Verano + Descuentos para Veteranos y Policías',
      navEn: 'July 4th Deals',
      navEs: 'Ofertas 4 Julio',
      heroEyeEn: 'July 4th Summer Event · Storewide Promos + Honoring Veterans & Police',
      heroEyeEs: 'Especial 4 de Julio · Promos de Verano + Descuentos a Veteranos y Policías',
      aprEn: 'Veterans & Police Discount · 0% APR',
      aprEs: 'Descuento Veteranos y Policías · 0% APR',
      cta2En: 'See July 4th Promos',
      cta2Es: 'Ver ofertas 4 de Julio',
      naEyeEn: 'July 4th Event · Summer Markdowns + Honoring Veterans & Police',
      naEyeEs: 'Especial 4 de Julio · Rebajas de Verano + Descuentos a Veteranos y Policías',
      naH2En: 'Summer promos &amp; <em>honoring Veterans &amp; Police.</em>',
      naH2Es: 'Promos de verano y <em>honor a Veteranos y Policías.</em>',
      promos: [
        { pill: ['Summer Sale', 'Rebajas Verano'], kicker: ['Bikes & E-Bikes', 'Bicis y E-Bikes'], h3: ['July 4th Floor Markdowns + 0% APR', 'Descuentos 4 de Julio en Piso + 0% APR'], p: ['Beat the Florida heat on a Specialized Turbo e-bike or carbon road build.', 'Rueda fresco este verano con descuentos directos en piso.'], cta: ['Shop Summer Bikes', 'Ver Bicis'] },
        { pill: ['Veterans & Police', 'Veteranos y Policías'], kicker: ['Founded by Manny · 1972', 'Fundada por Manny'], h3: ['In-Store Discounts for Veterans & Police', 'Descuento en Tienda a Veteranos y Policías'], p: ['Proudly Veteran-founded — show military, veteran or police ID in Tampa for honored savings.', 'Fundada por un veterano — presenta tu identificación militar o policial en Tampa para tu descuento.'], cta: ['Visit Showroom', 'Visitar Tienda'] },
        { pill: ['Alafia Trailhead', 'Parque Alafia'], kicker: ['Open Holiday Week', 'Abierto en Feriado'], h3: ['Rent Full-Suspension E-MTBs Inside Alafia', 'Alquila E-MTB Dentro del Parque Alafia'], p: ['Roll straight onto Moonscape & Bridges trails from our park shop.', 'Sal directo a los senderos desde nuestra tienda dentro del parque.'], cta: ['Reserve Rental', 'Ver Alquileres'] }
      ]
    },
    spring: {
      name: 'Spring',
      dot: '#F05243',
      heroSlide: 4,
      topEn: '<b>SPRING &amp; BIKE MONTH</b> &middot; Bayshore Miles, Alafia Trail Rentals &amp; Specialized Spring Sale',
      topEs: '<b>TEMPORADA DE PRIMAVERA</b> &middot; Bahía de Tampa, Alafia y Ofertas Specialized',
      navEn: 'Spring Sale',
      navEs: 'Primavera',
      heroEyeEn: 'Tampa Bay Spring Season · Specialized Spring Sale & Alafia Trail Rides',
      heroEyeEs: 'Primavera en Tampa Bay · Ofertas Specialized y Senderos Alafia',
      aprEn: 'Spring Special · 0% APR',
      aprEs: 'Oferta Primavera · 0% APR',
      cta2En: 'See Spring Sale',
      cta2Es: 'Ver ofertas de primavera',
      naEyeEn: 'Bike Month & Spring Event · Bayshore Road, Gravel & Alafia MTB',
      naEyeEs: 'Mes de la Bicicleta · Ruta en Bahía, Gravel y MTB en Alafia',
      naH2En: 'Fresh coastal miles. <em>Spring sale &amp; new builds.</em>',
      naH2Es: 'Clima ideal en Tampa. <em>Ofertas de primavera.</em>',
      promos: [
        { pill: ['Spring Sale', 'Oferta Primavera'], kicker: ['Road, Gravel & E-Bike', 'Ruta, Gravel y E-Bike'], h3: ['Specialized & Surly Spring Markdowns', 'Descuentos de Primavera en Piso'], p: ['Assembled carbon road, gravel & commuter e-bikes ready to roll today.', 'Bicis de carbono, gravel y e-bikes armadas listas para rodar hoy.'], cta: ['Browse Spring Bikes', 'Ver Bicis'] },
        { pill: ['Alafia Peak Season', 'Temporada Alafia'], kicker: ['Trailhead Rentals', 'Alquiler en Parque'], h3: ['Full-Suspension MTB & E-MTB Rentals', 'Alquiler de MTB y E-MTB en Alafia'], p: ['Best trail weather of the year — pick up right inside Alafia State Park.', 'El mejor clima del año en senderos directo desde nuestra sede Alafia.'], cta: ['Explore Alafia', 'Ver Alafia'] },
        { pill: ['Spring Tune-Up', 'Puesta a Punto'], kicker: ['Walk-In Workshop', 'Sin Cita · Tampa'], h3: ['Pre-Summer Drivetrain & Brake Tune-Up', 'Mantenimiento Completo de Primavera'], p: ['Get your bike dialed by Manny & Ashton — walk right in, all brands welcome.', 'Deja tu bici impecable sin cita previa en nuestro taller de Tampa.'], cta: ['See Tune-Ups', 'Ver Taller'] }
      ]
    },
    campus: {
      name: 'USF Campus',
      dot: '#F5C43E',
      heroSlide: 0,
      topEn: '<b>GO BULLS &middot; USF CAMPUS NEIGHBOR</b> &middot; 5 min away on E Fletcher Ave · Exclusive Student Discounts in Store',
      topEs: '<b>ESPECIAL USF TAMPA</b> &middot; A 5 min en Fletcher Ave · Descuentos para Estudiantes en tienda',
      navEn: 'USF Campus',
      navEs: 'Especial USF',
      heroEyeEn: 'USF Back to Campus · E-Bikes, Scooters & Student Discounts on E Fletcher Ave',
      heroEyeEs: 'Regreso a Clases USF · E-Bikes, Scooters y Descuento Estudiantil en Fletcher Ave',
      aprEn: 'Student Discount · Free Assembly',
      aprEs: 'Descuento Estudiantil · Armado Gratis',
      cta2En: 'See Campus Bundles',
      cta2Es: 'Ver combos universitarios',
      naEyeEn: 'USF Bulls Neighbor · 1220 E Fletcher Ave · Exclusive Student Discounts',
      naEyeEs: 'Vecinos de USF · 1220 E Fletcher Ave · Descuentos para Estudiantes',
      naH2En: 'Beat campus parking. <em>Ride to USF ready.</em>',
      naH2Es: 'Olvida el parqueo. <em>Llega rodando a USF.</em>',
      promos: [
        { pill: ['USF Student Perks', 'Descuento USF'], kicker: ['Valid Student ID', 'Con Carnet Estudiantil'], h3: ['Student Discount on Gear, Parts & Service', 'Descuento Estudiantil en Equipo y Taller'], p: ['Show your valid USF or student ID on E Fletcher Ave for instant savings on helmets, U-locks, lights & tune-ups.', 'Presenta tu carnet de USF o estudiante en Fletcher Ave para ahorrar en cascos, candados, luces y taller.'], cta: ['Shop Commuter Gear', 'Ver Equipo'] },
        { pill: ['USF Commuters', 'Movilidad USF'], kicker: ['E-Bikes & Scooters', 'E-Bikes y Scooters'], h3: ['Class-to-Dorm E-Bikes & Hybrids Ready Today', 'E-Bikes, Scooters e Híbridas en Stock'], p: ['Skip campus parking permits — test ride right down E Fletcher Ave.', 'Olvídate de permisos de parqueo — pruébalas hoy en Fletcher Ave.'], cta: ['Find Campus Ride', 'Elegir Bici'] },
        { pill: ['Same-Day Flat Fix', 'Pinchazos Hoy'], kicker: ['5 Min From USF', 'A 5 Min de USF'], h3: ['Walk-In Flat Tire & E-Scooter Repair All Day', 'Reparación Sin Cita de Bicis y Scooters'], p: ['Caught a flat before lecture? Walk right in — we service bikes & e-scooters.', '¿Pinchazo antes de clase? Pasa sin cita — reparamos bicis y scooters.'], cta: ['Workshop Info', 'Ver Taller'] }
      ]
    },
    veterans: {
      name: 'Veterans',
      dot: '#D8AE56',
      heroSlide: 2,
      topEn: '<b>HONORING VETERANS &amp; POLICE</b> &middot; Veteran-founded by Manny (1972) · Everyday Discounts for Veterans &amp; Police',
      topEs: '<b>HONOR A VETERANOS Y POLICÍAS</b> &middot; Fundada por Manny (Veterano) · Descuentos para Veteranos y Policías',
      navEn: 'Veterans & Police',
      navEs: 'Veteranos y Policías',
      heroEyeEn: 'Veteran-Founded by Manny Since 1972 · Honoring U.S. Veterans & Law Enforcement',
      heroEyeEs: 'Fundada por Manny (Veterano EE.UU.) desde 1972 · Honor a Veteranos y Policías',
      aprEn: 'Veterans & Police Discount · 0% APR',
      aprEs: 'Descuento Veteranos y Policías · 0% APR',
      cta2En: 'See Service Perks',
      cta2Es: 'Ver beneficios en tienda',
      naEyeEn: 'Service & Honor · Everyday In-Store Discounts for U.S. Veterans & Police',
      naEyeEs: 'Orgullo y Servicio · Descuentos en Tienda para Veteranos y Policías',
      naH2En: 'Veteran-founded pride. <em>Honoring Veterans &amp; Police.</em>',
      naH2Es: 'Fundada por un veterano. <em>Honor a Veteranos y Policías.</em>',
      promos: [
        { pill: ['U.S. Veterans', 'Veteranos EE.UU.'], kicker: ['Founded by Manny · 1972', 'Fundada por Manny'], h3: ['Military & Veteran In-Store Appreciation', 'Descuento Permanente a Veteranos y Militares'], p: ['As a Veteran-founded Tampa shop since 1972, Manny & our family proudly honor all U.S. Veterans & active-duty service members.', 'Como tienda fundada en 1972 por Manny (Veterano), honramos a todos los veteranos y militares activos con descuento en tienda.'], cta: ['Browse Bikes', 'Ver Bicis'] },
        { pill: ['Police & Officers', 'Policías'], kicker: ['Law Enforcement', 'Fuerzas del Orden'], h3: ['Everyday Police & Law Enforcement Discounts', 'Descuento Permanente a Policías en Tienda'], p: ['Special everyday in-store savings on gear, helmets, parts, accessories & priority walk-in repair bay service in Tampa.', 'Descuentos permanentes en tienda sobre cascos, accesorios, repuestos y atención prioritaria sin cita en nuestro taller.'], cta: ['Shop Pro-Shop', 'Ver Tienda'] },
        { pill: ['Walk-In Workshop', 'Taller Sin Cita'], kicker: ['Tampa & Alafia', 'Todas las Marcas'], h3: ['Assembled Floor Bikes & Same-Day Tune-Ups', 'Bicis Armadas Hoy y Taller Sin Cita'], p: ['Built and torque-checked by senior Tampa mechanics — backed by full factory warranty & 0% APR financing.', 'Armadas y ajustadas por mecánicos expertos en Tampa con garantía oficial de fábrica y financiamiento 0% APR.'], cta: ['Visit Workshop', 'Ver Taller'] }
      ]
    }
  };

  var edRoot = document.getElementById('ubcEditionSwitcher');
  var edLauncher = document.getElementById('ubcEdLauncher');
  var edMinimize = document.getElementById('ubcEdMinimize');
  var edActiveName = document.getElementById('ubcEdActiveName');
  var edActiveDot = document.getElementById('ubcEdActiveDot');

  function applyEdition(nextEd, persist) {
    if (!ED_META[nextEd]) return;
    edition = nextEd;
    if (document.body) {
      document.body.setAttribute('data-ubc-edition', nextEd);
    }
    if (persist !== false) {
      try { sessionStorage.setItem('ubc_edition_override', nextEd); } catch (e) {}
      try {
        if (window.history && window.history.replaceState) {
          var u = new URL(window.location.href);
          u.searchParams.set('edition', nextEd);
          window.history.replaceState({}, '', u.pathname + u.search + u.hash);
        }
      } catch (e) {}
    }

    var meta = ED_META[nextEd];
    var isEs = lang === 'es';

    var topOn = qs('#fbTopMsgs span.on') || qs('#fbTopMsgs span');
    if (topOn) {
      topOn.setAttribute('data-es', meta.topEs);
      topOn.innerHTML = isEs ? meta.topEs : meta.topEn;
    }

    var navAcc = qs('.fb-nav a.nav-accent span');
    if (navAcc) {
      navAcc.setAttribute('data-es', meta.navEs);
      navAcc.textContent = isEs ? meta.navEs : meta.navEn;
    }

    var heroEye = qs('#showCopy .eyebrow');
    if (heroEye) {
      heroEye.setAttribute('data-es', meta.heroEyeEs);
      heroEye.textContent = isEs ? meta.heroEyeEs : meta.heroEyeEn;
    }
    var aprEl = qs('#showCopy .apr-note');
    if (aprEl) {
      aprEl.setAttribute('data-es', meta.aprEs);
      aprEl.textContent = isEs ? meta.aprEs : meta.aprEn;
    }
    var cta2El = qs('#showSecondaryLink span');
    if (cta2El) {
      cta2El.setAttribute('data-es', meta.cta2Es);
      cta2El.textContent = isEs ? meta.cta2Es : meta.cta2En;
    }

    var naEye = qs('#new-arrivals .fb-sec-head .eyebrow');
    if (naEye) {
      naEye.setAttribute('data-es', meta.naEyeEs);
      naEye.textContent = isEs ? meta.naEyeEs : meta.naEyeEn;
    }
    var naH2 = qs('#new-arrivals .fb-sec-head .h2');
    if (naH2) {
      naH2.setAttribute('data-es', meta.naH2Es);
      naH2.innerHTML = isEs ? meta.naH2Es : meta.naH2En;
    }

    var pCards = qsa('#new-arrivals .promo-strip .promo-card');
    if (pCards.length === 3 && meta.promos) {
      var kIdx = isEs ? 1 : 0;
      pCards.forEach(function (cardEl, idx) {
        var pr = meta.promos[idx];
        if (!pr) return;
        var pillEl = qs('.promo-pill', cardEl);
        var kickEl = qs('.promo-kicker', cardEl);
        var h3El = qs('h3', cardEl);
        var pEl = qs('p', cardEl);
        var ctaEl = qs('.promo-cta span', cardEl);
        if (pillEl) pillEl.textContent = pr.pill[kIdx];
        if (kickEl) kickEl.textContent = pr.kicker[kIdx];
        if (h3El) h3El.textContent = pr.h3[kIdx];
        if (pEl) pEl.textContent = pr.p[kIdx];
        if (ctaEl) ctaEl.textContent = pr.cta[kIdx];
      });
    }

    if (edActiveName) edActiveName.textContent = meta.name;
    if (edActiveDot) edActiveDot.style.backgroundColor = meta.dot;
    if (edRoot) {
      qsa('.ubc-ed-btn', edRoot).forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-ubc-ed') === nextEd ? 'true' : 'false');
      });
    }

    var targetSlide = typeof meta.heroSlide === 'number' ? meta.heroSlide : heroIdx;
    if (persist !== false && !sysReducedMotion && document.body) {
      document.body.classList.remove('ubc-edition-anim');
      void document.body.offsetWidth;
      document.body.classList.add('ubc-edition-anim');
      if (targetSlide !== heroIdx) {
        renderHeroSlide(targetSlide, false, 1);
        resetHeroAuto();
      } else {
        renderHeroSlide(targetSlide, true);
      }
    } else {
      renderHeroSlide(targetSlide, true);
    }
    renderNewArrivals();
    renderStockGrid();
    renderFinder();
  }

  if (edRoot) {
    if (window.innerWidth <= 1120) {
      edRoot.classList.add('is-minimized');
      if (edLauncher) edLauncher.setAttribute('aria-expanded', 'false');
    }
    qsa('.ubc-ed-btn', edRoot).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.getAttribute('data-ubc-ed') || 'classic';
        applyEdition(target, true);
        if (window.innerWidth <= 1120) {
          edRoot.classList.add('is-minimized');
          if (edLauncher) edLauncher.setAttribute('aria-expanded', 'false');
        }
      });
    });
    if (edMinimize) {
      edMinimize.addEventListener('click', function () {
        edRoot.classList.add('is-minimized');
        if (edLauncher) edLauncher.setAttribute('aria-expanded', 'false');
      });
    }
    if (edLauncher) {
      edLauncher.addEventListener('click', function () {
        var willOpen = edRoot.classList.contains('is-minimized');
        edRoot.classList.toggle('is-minimized', !willOpen);
        edLauncher.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      });
    }
    applyEdition(edition, false);
  }
  window.ubcSetEdition = applyEdition;
})();
