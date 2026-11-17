/* UBC Commerce theme — motion sections (ES5, no dependencies, progressive enhancement).
 * Roadster/editorial scroll progress · cinematic video toggle · interactive points ·
 * build carousel (3D ring) · 360° spin product · bundle add · fly-to-bag.
 * Integrates with Dawn: cart bubble, cart drawer/notification (see ubc-cart part).
 * Every section renders and works without this file; reduced motion keeps things still.
 */
(function () {
  'use strict';

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var raf = window.requestAnimationFrame || function (f) { return setTimeout(function () { f(Date.now()); }, 16); };
  var cartRoot = (window.Shopify && window.Shopify.routes ? window.Shopify.routes.root : '/');

  function onVisible(el, cb, margin) {
    if (!('IntersectionObserver' in window)) { cb(true); return; }
    new window.IntersectionObserver(function (entries) {
      entries.forEach(function (e) { cb(e.isIntersecting); });
    }, { rootMargin: margin || '0px' }).observe(el);
  }

  /* ---------- Cart integration with Dawn: refresh the bubble and open Dawn's drawer/notification when present */
  var dawnCart = function () { return document.querySelector('cart-drawer') || document.querySelector('cart-notification'); };
  var cartSections = function (single) {
    var cart = dawnCart();
    if (single && cart && cart.getSectionsToRender) return cart.getSectionsToRender().map(function (s) { return s.id; });
    return ['cart-icon-bubble'];
  };
  var bumpBubble = function () {
    var b = document.getElementById('cart-icon-bubble');
    if (!b || reduce) return;
    b.classList.remove('is-bump'); void b.offsetWidth; b.classList.add('is-bump');
  };
  var applyCart = function (json, single) {
    var cart = dawnCart();
    if (single && cart && cart.renderContents && json && json.sections) {
      try { cart.renderContents(json); bumpBubble(); return; } catch (e) { /* fall back to the bubble only */ }
    }
    var html = json && json.sections && json.sections['cart-icon-bubble'];
    var bubble = document.getElementById('cart-icon-bubble');
    if (html && bubble) {
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var inner = tmp.querySelector('.shopify-section');
      bubble.innerHTML = inner ? inner.innerHTML : tmp.innerHTML;
    }
    bumpBubble();
  };
  var postJSON = function (url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.status) throw new Error(j.description || j.message || 'Error'); return j; }); });
  };

  /* Quick add (UBC sections): native form post without JS, AJAX with JS. Fires 'ubc:added'. */
  qsa('[data-quick-add]').forEach(function (form) {
    if (!window.fetch) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = qs('[type=submit]', form);
      var msg = qs('[data-form-message]', form);
      var checked = qs('input[name=id]:checked', form) || qs('input[name=id]', form);
      var qty = qs('input[name=quantity]', form);
      if (!checked) return;
      btn.disabled = true;
      form.setAttribute('aria-busy', 'true');
      if (msg) msg.textContent = '';
      postJSON(cartRoot + 'cart/add.js', {
        id: Number(checked.value), quantity: qty ? Number(qty.value) || 1 : 1,
        sections: cartSections(true).join(','), sections_url: window.location.pathname
      }).then(function (json) {
        applyCart(json, true);
        if (msg) msg.textContent = form.getAttribute('data-added-label') || '';
        var ev;
        try { ev = new window.CustomEvent('ubc:added', { detail: { form: form } }); } catch (x) {
          ev = document.createEvent('CustomEvent'); ev.initCustomEvent('ubc:added', false, false, { form: form });
        }
        document.dispatchEvent(ev);
      })['catch'](function (err) {
        if (msg) msg.textContent = err.message;
      }).then(function () { btn.disabled = false; form.removeAttribute('aria-busy'); });
    });
  });

  /* ---------- Product showcase slider: arrows, thumbnails, keyboard, swipe. Without JS the first product shows. */
  qsa('[data-showcase]').forEach(function (root) {
    var slides = qsa('[data-slide]', root);
    if (slides.length < 2) return;
    var index = 0;
    var counter = qs('[data-showcase-current]', root);
    var thumbs = qsa('[data-showcase-go]', root);
    var show = function (n) {
      var next = (n + slides.length) % slides.length;
      if (next === index) return;
      slides[index].classList.remove('is-active');
      slides[index].hidden = true;
      index = next;
      slides[index].hidden = false;
      void slides[index].offsetWidth;
      slides[index].classList.add('is-active');
      if (counter) counter.textContent = (index < 9 ? '0' : '') + (index + 1);
      thumbs.forEach(function (t, i) { if (i === index) t.setAttribute('aria-current', 'true'); else t.removeAttribute('aria-current'); });
    };
    thumbs.forEach(function (t) { t.addEventListener('click', function () { show(Number(t.getAttribute('data-showcase-go'))); }); });
    var prev = qs('[data-showcase-prev]', root), next = qs('[data-showcase-next]', root);
    if (prev) prev.addEventListener('click', function () { show(index - 1); });
    if (next) next.addEventListener('click', function () { show(index + 1); });
    root.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') show(index - 1);
      if (e.key === 'ArrowRight') show(index + 1);
    });
    var startX = null;
    root.addEventListener('touchstart', function (e) { startX = e.touches[0].clientX; }, { passive: true });
    root.addEventListener('touchend', function (e) {
      if (startX === null) return;
      var dx = e.changedTouches[0].clientX - startX;
      startX = null;
      if (Math.abs(dx) > 40) show(index + (dx < 0 ? 1 : -1));
    });
  });

  /* ---------- Scroll progress (--p: 0 when the section top reaches the viewport top, 1 when it has scrolled away) */
  var progressEls = qsa('[data-scroll-progress]');
  if (progressEls.length && !reduce) {
    var ticking = false;
    var update = function () {
      ticking = false;
      var vh = window.innerHeight;
      progressEls.forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh) return;
        var p = clamp(-r.top / Math.max(1, r.height), 0, 1);
        el.style.setProperty('--p', p.toFixed(4));
        el.style.setProperty('--in', clamp((vh - r.top) / vh, 0, 1).toFixed(4));
      });
    };
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; raf(update); } }, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  /* ---------- Reveal once on enter */
  qsa('[data-reveal]').forEach(function (el) {
    if (reduce) { el.classList.add('is-revealed'); return; }
    el.classList.add('js-reveal');
    onVisible(el, function (v) { if (v) el.classList.add('is-revealed'); }, '0px 0px -20% 0px');
  });

  /* ---------- Cinematic video: pause button; reduced motion starts paused */
  qsa('.cine').forEach(function (root) {
    var video = qs('video', root);
    var btn = qs('[data-cine-toggle]', root);
    if (!video || !btn) return;
    var label = btn.getAttribute('aria-label');
    var set = function (paused) {
      btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
      root.classList.toggle('is-paused', paused);
    };
    if (reduce) { video.removeAttribute('autoplay'); video.pause(); set(true); }
    btn.addEventListener('click', function () {
      if (video.paused) { var pr = video.play(); if (pr && pr['catch']) pr['catch'](function () {}); set(false); } else { video.pause(); set(true); }
    });
    btn.setAttribute('aria-label', label);
    onVisible(root, function (v) {
      if (btn.getAttribute('aria-pressed') === 'true') return;
      if (v) { var pr = video.play(); if (pr && pr['catch']) pr['catch'](function () {}); } else { video.pause(); }
    });
  });

  /* ---------- Interactive points: zoom towards a part + exploded lens */
  qsa('[data-spots]').forEach(function (root) {
    var spots = qsa('[data-spot]', root);
    var notes = qsa('[data-spot-note]', root);
    var plane = qs('[data-spots-plane]', root);
    var stage = qs('[data-spots-stage]', root);
    var base = qs('[data-spots-base]', root);
    var lens = qs('[data-spots-lens]', root);
    var lensImg = qs('[data-spots-lens-img]', root);
    var lensName = qs('[data-spots-lens-name]', root);
    var lensSpec = qs('[data-spots-lens-spec]', root);
    var leader = qs('[data-spots-leader] line', root);
    var current = qs('[data-spots-current]', root);
    var hint = qs('[data-spots-hint]', root);
    if (!spots.length || !plane) return;
    root.classList.add('is-js');
    var active = -1;
    var ZOOM = 1.35, MAG = 3;

    var place = function () {
      if (active < 0 || !lens) return;
      var s = spots[active];
      var W = plane.clientWidth, H = plane.clientHeight;
      var px = Number(s.getAttribute('data-x')) / 100 * W, py = Number(s.getAttribute('data-y')) / 100 * H;
      var lw = lens.offsetWidth, lh = lensImg ? lensImg.offsetHeight : lens.offsetHeight;
      var gap = Math.max(40, W * 0.12);
      var lx = px < W / 2 ? px + gap : px - gap - lw;
      lx = clamp(lx, 8, W - lw - 8);
      var ly = clamp(py - lh / 2, 8, H - lens.offsetHeight - 8);
      lens.style.left = lx + 'px';
      lens.style.top = ly + 'px';
      var detail = s.getAttribute('data-detail');
      if (lensImg && detail) {
        lensImg.style.backgroundImage = 'url("' + detail + '")';
        lensImg.style.backgroundSize = 'contain';
        lensImg.style.backgroundPosition = 'center';
      } else if (lensImg && base) {
        var src = base.currentSrc || base.src;
        if (src) lensImg.style.backgroundImage = 'url("' + src + '")';
        lensImg.style.backgroundSize = (W * MAG) + 'px ' + (H * MAG) + 'px';
        lensImg.style.backgroundPosition = (-(px * MAG - lensImg.offsetWidth / 2)) + 'px ' + (-(py * MAG - lh / 2)) + 'px';
      }
      if (leader) {
        var ax = px < W / 2 ? lx : lx + lw;
        leader.setAttribute('x1', px); leader.setAttribute('y1', py);
        leader.setAttribute('x2', ax); leader.setAttribute('y2', ly + lh / 2);
      }
    };

    var show = function (i, focusSpot) {
      active = i;
      spots.forEach(function (s, j) {
        s.classList.toggle('is-active', j === i);
        s.setAttribute('aria-expanded', j === i ? 'true' : 'false');
      });
      notes.forEach(function (n) { n.classList.toggle('is-open', Number(n.getAttribute('data-spot-note')) === i); });
      root.classList.toggle('has-active', i >= 0);
      if (current) current.textContent = i >= 0 ? String(i + 1) : '—';
      if (hint) hint.hidden = i >= 0;
      if (i >= 0) {
        var s = spots[i];
        stage.style.transformOrigin = s.getAttribute('data-x') + '% ' + s.getAttribute('data-y') + '%';
        stage.style.setProperty('--z', reduce ? 1 : ZOOM);
        if (lensName) lensName.textContent = qs('.spot-label', s).textContent;
        if (lensSpec) { lensSpec.textContent = s.getAttribute('data-spec') || ''; lensSpec.hidden = !lensSpec.textContent; }
        place();
        if (lens) { lens.classList.remove('is-on'); void lens.offsetWidth; lens.classList.add('is-on'); }
        if (focusSpot) s.focus();
      } else {
        stage.style.setProperty('--z', 1);
        if (lens) lens.classList.remove('is-on');
      }
    };

    spots.forEach(function (s, i) {
      s.addEventListener('mouseenter', function () { s.classList.add('is-hover'); });
      s.addEventListener('mouseleave', function () { s.classList.remove('is-hover'); });
      s.addEventListener('click', function (e) { e.stopPropagation(); show(active === i ? -1 : i); });
    });
    stage.addEventListener('click', function () { if (active >= 0) show(-1); });
    var prev = qs('[data-spots-prev]', root), next = qs('[data-spots-next]', root);
    if (prev) prev.addEventListener('click', function () { show(active <= 0 ? spots.length - 1 : active - 1); });
    if (next) next.addEventListener('click', function () { show(active < 0 || active >= spots.length - 1 ? 0 : active + 1); });
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && active >= 0) { var s = spots[active]; show(-1); s.focus(); }
    });
    window.addEventListener('resize', place);
  });

  /* ---------- Build carousel: 3D ring (critically damped spring, depth scale + blur) */
  qsa('[data-ring]').forEach(function (root) {
    var stage = qs('[data-ring-stage]', root);
    var originals = qsa('[data-ring-body]', root);
    var n = originals.length;
    if (!stage || n < 2) return;
    var bodies = originals.slice();
    var copies = Math.ceil(8 / n);
    for (var c = 1; c < copies; c++) {
      originals.forEach(function (b) {
        var cl = b.cloneNode(true);
        cl.setAttribute('aria-hidden', 'true');
        cl.removeAttribute('data-shopify-editor-block');
        qsa('img', cl).forEach(function (im) { im.setAttribute('loading', 'lazy'); im.alt = ''; });
        stage.insertBefore(cl, qs('.ring-sweep', stage));
        bodies.push(cl);
      });
    }
    var N = bodies.length;
    var step = 2 * Math.PI / N;
    var K = 95, C = 2 * Math.sqrt(K);
    var index = 0, target = 0, cur = reduce ? 0 : -1.15, vel = 0;
    var W = 0, H = 0, mobile = false;
    var running = false, visible = false, dragging = false, playing = !reduce, engaged = false, hover = false;
    var timer = null, last = 0;
    var ticks = qsa('[data-ring-go]', root);
    var looks = qsa('[data-ring-look]', root);
    var live = qs('[data-ring-live]', root);
    var playBtn = qs('[data-ring-play]', root);
    root.classList.add('is-js');

    var measure = function () {
      W = stage.clientWidth; H = stage.clientHeight; mobile = W < 750;
    };
    var render = function () {
      var cx = 0.5 * W, R = (mobile ? 0.72 : 0.62) * W, P = (mobile ? 1.9 : 1.65) * W;
      var floor = H - 24, horizon = 0.36 * H;
      for (var a = 0; a < N; a++) {
        var phi = ((a - cur) * step) % (2 * Math.PI);
        if (phi > Math.PI) phi -= 2 * Math.PI;
        if (phi <= -Math.PI) phi += 2 * Math.PI;
        var z = R * (1 - Math.cos(phi));
        var persp = P / (P + z);
        var sl = Math.abs(phi) / step;
        var scale = persp * (1 + 0.08 * clamp(1 - sl, 0, 1));
        var x = cx + R * Math.sin(phi) * persp;
        var feet = horizon + (floor - horizon) * persp;
        var blur = sl <= 1 ? 1.8 * sl : Math.min(1.8 + (sl - 1) * 2, 6.5);
        var op = clamp((Math.cos(phi) + 0.55) / 0.3, 0, 1) * (sl < 0.5 ? 1 : 0.28 + 0.3 * clamp(1 - sl, 0, 1));
        var b = bodies[a];
        b.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + (-(H - feet)).toFixed(1) + 'px,0) translateX(-50%) scale(' + scale.toFixed(4) + ')';
        b.style.opacity = op.toFixed(3);
        b.style.zIndex = Math.round(scale * 1000);
        b.style.visibility = op < 0.01 ? 'hidden' : 'visible';
        var fade = clamp(sl, 0, 1);
        b.style.filter = (blur > 0.05 ? 'blur(' + blur.toFixed(1) + 'px) ' : '') + (fade > 0.05 ? 'grayscale(' + (0.8 * fade).toFixed(2) + ') brightness(' + (1 + 0.9 * fade).toFixed(2) + ') contrast(' + (1 - 0.45 * fade).toFixed(2) + ')' : '');
        b.style.pointerEvents = sl < 0.5 ? 'auto' : 'none';
      }
    };
    var loop = function (t) {
      var dt = last ? Math.min(0.034, (t - last) / 1000) : 1 / 60;
      last = t;
      if (!dragging) {
        var h = dt / 3;
        for (var i = 0; i < 3; i++) { var acc = -K * (cur - target) - C * vel; vel += acc * h; cur += vel * h; }
      }
      render();
      if (!dragging && Math.abs(cur - target) <= 0.0005 && Math.abs(vel) <= 0.0005) { cur = target; vel = 0; render(); running = false; last = 0; return; }
      raf(loop);
    };
    var kick = function () { if (!running && visible) { running = true; raf(loop); } };
    var restartBar = function () {
      ticks.forEach(function (t) { t.classList.remove('is-run'); });
      if (playing && ticks[index]) { void ticks[index].offsetWidth; ticks[index].classList.add('is-run'); }
      clearTimeout(timer);
      if (playing) timer = setTimeout(function () {
        if (playing && visible && !dragging && !hover && !engaged && !document.hidden) moveTo(Math.round(target) + 1); else restartBar();
      }, Number(root.getAttribute('data-speed')) || 5000);
    };
    var setIndex = function (i, silent) {
      var changed = i !== index;
      index = i;
      ticks.forEach(function (t, j) {
        if (j === i) t.setAttribute('aria-current', 'true'); else t.removeAttribute('aria-current');
        t.classList.toggle('is-past', j < i);
      });
      if (changed || silent) {
        looks.forEach(function (l) {
          var on = Number(l.getAttribute('data-ring-look')) === i;
          l.hidden = !on;
          l.classList.remove('is-in');
          if (on) { void l.offsetWidth; l.classList.add('is-in'); }
        });
        if (!silent && !reduce) { stage.classList.remove('is-sweep'); void stage.offsetWidth; stage.classList.add('is-sweep'); }
        if (!silent && live && ticks[i]) live.textContent = ticks[i].textContent.replace(/\s+/g, ' ').trim();
      }
      restartBar();
    };
    var moveTo = function (T) { target = T; setIndex(((T % n) + n) % n); kick(); };
    var go = function (i) { var d = ((i - index) % n + n) % n; if (d > n / 2) d -= n; moveTo(Math.round(target) + d); };
    var play = function (on) {
      playing = on;
      if (playBtn) playBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      root.classList.toggle('is-playing', on);
      restartBar();
    };

    var prevBtn = qs('[data-ring-prev]', root);
    var nextBtn = qs('[data-ring-next]', root);
    if (prevBtn) prevBtn.addEventListener('click', function () { moveTo(Math.round(target) - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { moveTo(Math.round(target) + 1); });
    ticks.forEach(function (t) { t.addEventListener('click', function () { go(Number(t.getAttribute('data-ring-go'))); }); });
    if (playBtn) playBtn.addEventListener('click', function () { if (!playing) engaged = false; play(!playing); });
    root.addEventListener('keydown', function (e) {
      if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') moveTo(Math.round(target) - 1);
      if (e.key === 'ArrowRight') moveTo(Math.round(target) + 1);
    });
    var panel = qs('.ring-panel', root);
    if (panel) {
      panel.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') hover = true; });
      panel.addEventListener('pointerleave', function () { hover = false; restartBar(); });
      panel.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('button,a,input,label')) { engaged = true; play(false); } });
    }

    var startX = 0, startT = 0, lastX = 0, lastTime = 0, v = 0;
    stage.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true; startX = lastX = e.clientX; startT = target; lastTime = Date.now(); v = 0;
      stage.classList.add('is-dragging');
      if (stage.setPointerCapture) stage.setPointerCapture(e.pointerId);
      kick();
    });
    stage.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var unit = Math.max(mobile ? 90 : 120, 0.3 * W);
      var now = Date.now();
      v = (lastX - e.clientX) / unit / Math.max(0.008, (now - lastTime) / 1000) * 0.6 + v * 0.4;
      lastX = e.clientX; lastTime = now;
      cur = startT + (startX - e.clientX) / unit;
    });
    var end = function () {
      if (!dragging) return;
      dragging = false;
      stage.classList.remove('is-dragging');
      var dest = Math.round(cur + clamp(v, -3, 3) * 0.25);
      vel = 0;
      moveTo(dest);
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);

    window.addEventListener('resize', function () { measure(); render(); });
    onVisible(root, function (vis) { visible = vis; if (vis) { measure(); kick(); restartBar(); } else clearTimeout(timer); });
    measure(); render();
    play(playing);
    setIndex(0, true);
  });

  /* ---------- Bundle add (several variants in one request) */
  qsa('[data-ring-bundle]').forEach(function (btn) {
    if (!window.fetch) return;
    btn.addEventListener('click', function () {
      var ids = btn.getAttribute('data-ring-bundle').split(',').filter(Boolean);
      var msg = btn.parentNode && qs('[data-form-message]', btn.parentNode);
      btn.disabled = true;
      postJSON(cartRoot + 'cart/add.js', {
        items: ids.map(function (id) { return { id: Number(id), quantity: 1 }; }),
        sections: 'cart-icon-bubble', sections_url: window.location.pathname
      }).then(function (json) { applyCart(json, false); if (msg) msg.textContent = btn.getAttribute('data-added-label') || ''; })
        ['catch'](function (err) { if (msg) msg.textContent = err.message; })
        .then(function () { btn.disabled = false; });
    });
  });

  /* ---------- Fly to bag + label roll after a quick add (event from theme.js) */
  document.addEventListener('ubc:added', function (e) {
    var form = e.detail && e.detail.form;
    if (!form || !form.hasAttribute('data-fly')) return;
    var add = qs('[data-spin-add]', form);
    if (add) { add.classList.add('is-added'); setTimeout(function () { add.classList.remove('is-added'); }, 1800); }
    var src = qs('[data-spin-still]', document);
    var bag = document.getElementById('cart-icon-bubble');
    if (reduce || !add || !bag || !src || !add.animate) return;
    var a = add.getBoundingClientRect(), b = bag.getBoundingClientRect();
    var card = document.createElement('div');
    card.className = 'fly-card';
    if (src.tagName === 'IMG') card.style.backgroundImage = 'url("' + (src.currentSrc || src.src) + '")';
    card.style.left = (a.left + a.width / 2 - 30) + 'px';
    card.style.top = (a.top - 40) + 'px';
    document.body.appendChild(card);
    var dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top - 40 + 40);
    card.animate([
      { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
      { transform: 'translate(' + dx * 0.5 + 'px,' + (dy * 0.5 - 120) + 'px) scale(.8) rotate(-8deg)', opacity: 1, offset: 0.5 },
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.18) rotate(-14deg)', opacity: 0.6 }
    ], { duration: 900, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'forwards' });
    setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 900);
  });

  /* ---------- 360° spin product */
  qsa('[data-spin]').forEach(function (root) {
    var stage = qs('[data-spin-stage]', root);
    var still = qs('[data-spin-still]', root);
    var canvas = qs('[data-spin-canvas]', root);
    var readout = qs('[data-spin-readout]', root);
    var dot = qs('[data-spin-dot]', root);
    var deg = qs('[data-spin-deg]', root);
    var views = qsa('[data-spin-view]', root);
    root.classList.add('spin--js');

    // Accordion: one open at a time
    var details = qsa('[data-spin-acc] details', root);
    details.forEach(function (d) {
      d.addEventListener('toggle', function () { if (d.open) details.forEach(function (o) { if (o !== d) o.open = false; }); });
    });

    // Sliding size highlight + live price
    var sizes = qs('[data-spin-sizes]', root);
    var hl = qs('[data-spin-hl]', root);
    var price = qs('.spin-price', root);
    var moveHl = function () {
      if (!sizes || !hl) return;
      var c = qs('input:checked', sizes);
      if (!c) { hl.style.opacity = '0'; return; }
      var lab = c.parentNode;
      hl.style.opacity = '1';
      hl.style.transform = 'translate(' + lab.offsetLeft + 'px,' + lab.offsetTop + 'px)';
      hl.style.width = lab.offsetWidth + 'px';
      hl.style.height = lab.offsetHeight + 'px';
      if (price && c.getAttribute('data-price')) price.firstChild.nodeValue = c.getAttribute('data-price') + ' ';
    };
    if (sizes && hl) {
      sizes.classList.add('has-slider');
      sizes.addEventListener('change', moveHl);
      window.addEventListener('resize', moveHl);
      moveHl();
    }

    // Save toggle (per browser only)
    var save = qs('[data-spin-save]', root);
    if (save) {
      var key = 'ubc-saved';
      var read = function () { try { return JSON.parse(window.localStorage.getItem(key) || '[]'); } catch (e) { return []; } };
      var handle = save.getAttribute('data-spin-save');
      var sync = function () { save.setAttribute('aria-pressed', read().indexOf(handle) >= 0 ? 'true' : 'false'); };
      save.addEventListener('click', function () {
        var list = read(), i = list.indexOf(handle);
        if (i >= 0) list.splice(i, 1); else list.push(handle);
        try { window.localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* private mode */ }
        save.setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
      });
      sync();
    }

    // Front/back views without a video: swap the photo
    var src = root.getAttribute('data-spin-src');
    if (!src) {
      root.classList.add('is-front');
      views.forEach(function (b) {
        b.addEventListener('click', function () {
          views.forEach(function (o) { o.classList.toggle('is-active', o === b); });
          if (still && still.tagName === 'IMG') { still.removeAttribute('srcset'); still.src = b.getAttribute('data-src'); }
          root.classList.toggle('is-front', Number(b.getAttribute('data-spin-view')) === 0);
        });
      });
      return;
    }

    // Turntable: scrub the clip; idle 3 s → it plays (turns) on its own
    var video = document.createElement('video');
    video.muted = true; video.loop = true; video.preload = 'auto';
    video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
    video.src = src;
    var ctx = canvas.getContext('2d');
    var ready = false, drag = false, lastMove = Date.now(), angle = 0, seeking = false, want = -1;
    var draw = function () {
      if (!ready) return;
      var cw = canvas.width, ch = canvas.height, vw = video.videoWidth, vh = video.videoHeight;
      var s = Math.max(cw / vw, ch / vh), w = vw * s, h = vh * s;
      ctx.drawImage(video, (cw - w) / 2, (ch - h) / 2, w, h);
    };
    var setAngle = function (a) {
      angle = ((a % 1) + 1) % 1;
      if (dot) dot.style.left = (angle * 100).toFixed(2) + '%';
      if (deg) { var d = Math.round(angle * 360) % 360; deg.textContent = (d < 10 ? '00' : d < 100 ? '0' : '') + d + '°'; }
      var front = (angle < 0.035 || angle > 0.965) && !drag && video.paused;
      root.classList.toggle('is-front', front);
    };
    var seek = function (a) {
      want = ((a % 1) + 1) % 1;
      if (seeking) return;
      seeking = true;
      video.currentTime = want * video.duration;
    };
    video.addEventListener('seeked', function () {
      seeking = false; draw(); setAngle(video.currentTime / video.duration);
      if (want >= 0 && Math.abs(want * video.duration - video.currentTime) > 0.05) seek(want); else want = -1;
    });
    video.addEventListener('loadeddata', function () {
      ready = true;
      canvas.width = Math.min(1080, video.videoWidth);
      canvas.height = Math.round(canvas.width * stage.clientHeight / Math.max(1, stage.clientWidth));
      root.classList.add('has-spin');
      if (readout) readout.hidden = false;
      draw(); setAngle(0);
    });
    var tick = function () {
      if (!video.paused && ready) { draw(); setAngle(video.currentTime / video.duration); }
      if (!reduce && !drag && video.paused && ready && Date.now() - lastMove > 3000 && want < 0) {
        var pr = video.play(); if (pr && pr['catch']) pr['catch'](function () {});
      }
      raf(tick);
    };
    var startX = 0, startA = 0;
    stage.addEventListener('pointerdown', function (e) {
      if (!ready || e.button !== 0 || (e.target.closest && e.target.closest('.spin-pin'))) return;
      drag = true; startX = e.clientX; startA = angle; lastMove = Date.now();
      video.pause();
      stage.classList.add('is-dragging');
      if (stage.setPointerCapture) stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', function (e) {
      lastMove = Date.now();
      if (!drag) return;
      seek(startA - (e.clientX - startX) / 900);
    });
    var stop = function () { if (!drag) return; drag = false; stage.classList.remove('is-dragging'); lastMove = Date.now(); setAngle(angle); };
    stage.addEventListener('pointerup', stop);
    stage.addEventListener('pointercancel', stop);
    root.addEventListener('pointermove', function () { lastMove = Date.now(); });
    views.forEach(function (b) {
      b.addEventListener('click', function () {
        views.forEach(function (o) { o.classList.toggle('is-active', o === b); });
        video.pause(); lastMove = Date.now(); seek(Number(b.getAttribute('data-spin-view')));
      });
    });
    raf(tick);
  });
})();
