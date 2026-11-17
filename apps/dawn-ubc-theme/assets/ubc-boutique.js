/* UBC Boutique Modern — ES5 Progressive Interactive Controller
 * Powers:
 *  1. Boutique Hero Slider (01-04 rail + 3-bike thumbnail selector + hotspot pins)
 *  2. Argon-18 Style Dark Architectural Stage Slider
 *  3. Technologies & Spare Parts Circle Slider
 *  4. AJAX Circular Bag Quick-Add wired directly into Dawn's Cart Drawer + Cart Bubble
 */
(function () {
  'use strict';

  function qsa(sel, ctx) {
    return Array.prototype.slice.call((ctx || document).querySelectorAll(sel));
  }

  /* 1. Multi-Slide Interactive Switcher (Hero, Argon Dark Stage, Tech Circle, Shop Spotlight) */
  function bindDeck(rootAttr) {
    qsa('[' + rootAttr + ']').forEach(function (root) {
      if (root.hasAttribute('data-ub-bound')) return;
      root.setAttribute('data-ub-bound', '1');
      var slides = qsa('[data-ub-slide]', root);
      if (slides.length < 2) return;
      var current = 0;
      var triggers = qsa('[data-ub-go]', root);
      var prevBtns = qsa('[data-ub-prev]', root);
      var nextBtns = qsa('[data-ub-next]', root);

      function goTo(idx) {
        var next = (idx + slides.length) % slides.length;
        if (next === current) return;
        slides[current].hidden = true;
        slides[current].classList.remove('is-active');
        current = next;
        slides[current].hidden = false;
        slides[current].classList.add('is-active');

        triggers.forEach(function (btn) {
          var targetIdx = Number(btn.getAttribute('data-ub-go'));
          if (targetIdx === current) {
            btn.setAttribute('aria-current', 'true');
          } else {
            btn.removeAttribute('aria-current');
          }
        });
      }

      triggers.forEach(function (btn) {
        btn.addEventListener('click', function () {
          goTo(Number(btn.getAttribute('data-ub-go')));
        });
      });

      prevBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
          goTo(current - 1);
        });
      });

      nextBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
          goTo(current + 1);
        });
      });
    });
  }

  /* 2. AJAX Circular Bag Quick-Add -> Opens Dawn Cart Drawer */
  function bindQuickBagForms() {
    var rootUrl = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) ? window.Shopify.routes.root : '/';
    qsa('[data-ub-bag-form]').forEach(function (form) {
      if (!window.fetch || form.hasAttribute('data-ub-bound')) return;
      form.setAttribute('data-ub-bound', '1');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var idInput = form.querySelector('input[name="id"]');
        var btn = form.querySelector('button[type="submit"]');
        if (!idInput || !idInput.value) return;
        if (btn) btn.disabled = true;

        var drawer = document.querySelector('cart-drawer') || document.querySelector('cart-notification');
        var sections = ['cart-icon-bubble'];
        if (drawer && typeof drawer.getSectionsToRender === 'function') {
          sections = drawer.getSectionsToRender().map(function (s) { return s.id; });
        }

        fetch(rootUrl + 'cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            id: Number(idInput.value),
            quantity: 1,
            sections: sections.join(','),
            sections_url: window.location.pathname
          })
        })
          .then(function (r) { return r.json(); })
          .then(function (json) {
            if (drawer && typeof drawer.renderContents === 'function' && json && json.sections) {
              drawer.classList.remove('is-empty');
              drawer.renderContents(json);
            } else if (json && json.sections && json.sections['cart-icon-bubble']) {
              var bubble = document.getElementById('cart-icon-bubble');
              if (bubble) bubble.innerHTML = json.sections['cart-icon-bubble'];
            }
          })
          ['catch'](function () {
            form.submit();
          })
          .then(function () {
            if (btn) btn.disabled = false;
          });
      });
    });
  }

  function initBoutique() {
    bindDeck('data-ub-hero');
    bindDeck('data-ub-argon');
    bindDeck('data-ub-tech');
    bindDeck('data-ub-spotlight');
    bindQuickBagForms();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBoutique);
  } else {
    initBoutique();
  }
  document.addEventListener('shopify:section:load', initBoutique);
})();
