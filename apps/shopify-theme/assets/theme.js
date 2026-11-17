/* UBC Commerce theme — progressive enhancement only (ES5, no dependencies).
 * Every feature works without JS through native forms; JS adds:
 *  - mobile menu toggle
 *  - auto-submit of collection filters
 *  - variant selection with live price/availability & in-store pickup rules
 *  - AJAX add-to-cart via Shopify's Cart API (/cart/add.js)
 *  - lazy related products via the Section Rendering API
 */
(function () {
  'use strict';

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var toggle = qs('[data-menu-toggle]');
  var nav = qs('#SiteNav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  var filterForm = qs('[data-filter-form]');
  if (filterForm) {
    var timer = null;
    filterForm.addEventListener('change', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { filterForm.submit(); }, 300);
    });
  }

  var product = qs('[data-product]');
  if (product) {
    var dataEl = qs('[data-product-json]', product);
    var data = null;
    try { data = JSON.parse(dataEl.textContent); } catch (e) { data = null; }
    var form = qs('[data-product-form]', product);
    var idInput = qs('[data-variant-id]', product);
    var button = qs('[data-add-button]', product);
    var message = qs('[data-form-message]', product);
    var selects = qsa('select[data-option-index]', product);

    var currentVariant = function () {
      if (!data) return null;
      var chosen = selects.map(function (s) { return s.value; });
      for (var i = 0; i < data.variants.length; i++) {
        var v = data.variants[i];
        var match = true;
        for (var j = 0; j < chosen.length; j++) { if (v.options[j] !== chosen[j]) { match = false; break; } }
        if (match) return v;
      }
      return null;
    };

    var render = function () {
      var v = currentVariant();
      if (!v) return;
      idInput.value = v.id;
      var priceWrap = qs('[data-price] .price', product);
      var price = qs('[data-price] .price-current', product);
      var compareWrap = qs('[data-price] .price-compare', product);
      var compareVal = qs('[data-price-compare]', product);
      if (price) price.textContent = v.price;
      if (priceWrap) priceWrap.className = v.compare ? 'price price--sale' : 'price';
      if (compareWrap) compareWrap.hidden = !v.compare;
      if (compareVal && v.compare) compareVal.textContent = v.compare;
      var status = v.availability || (v.available && v.qty > 0 ? 'in_stock' : v.available ? 'special_order' : 'unavailable');
      var label = status === 'in_stock' ? data.labels.in_stock
        : status === 'special_order' ? (v.lead ? data.labels.special_order_days.replace('__DAYS__', v.lead) : data.labels.special_order)
        : data.labels.unavailable;
      var badge = qs('[data-availability]', product);
      if (badge) { badge.className = 'availability availability--' + status; badge.textContent = label; }
      var pickupBadge = qs('[data-click-collect]', product);
      if (pickupBadge) { pickupBadge.hidden = !v.pickup_only; }
      button.disabled = !v.available;
      button.textContent = v.available ? data.labels.add : data.labels.sold_out;
      if (window.history && window.history.replaceState) {
        var url = new URL(window.location.href);
        url.searchParams.set('variant', v.id);
        window.history.replaceState({}, '', url.toString());
      }
    };
    selects.forEach(function (s) { s.addEventListener('change', render); });

    if (form && window.fetch) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        button.disabled = true;
        message.textContent = '';
        fetch((window.Shopify && window.Shopify.routes ? window.Shopify.routes.root : '/') + 'cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ items: [{ id: Number(idInput.value), quantity: Number(qs('input[name=quantity]', form).value) || 1 }] })
        }).then(function (r) {
          return r.json().then(function (body) { if (!r.ok) throw new Error(body.description || body.message || 'Error'); return body; });
        }).then(function () {
          message.textContent = '✓';
          return fetch((window.Shopify && window.Shopify.routes ? window.Shopify.routes.root : '/') + 'cart.js').then(function (r) { return r.json(); });
        }).then(function (cart) {
          qsa('[data-cart-count]').forEach(function (el) { el.textContent = cart.item_count; });
          message.textContent = message.textContent + ' ' + (cart.item_count) + ' in cart';
        })['catch'](function (err) {
          message.textContent = err.message;
        }).then(function () { button.disabled = false; });
      });
    }
  }

  var rec = qs('[data-recommendations]');
  if (rec && window.fetch) {
    fetch(rec.getAttribute('data-url')).then(function (r) { return r.text(); }).then(function (html) {
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var inner = tmp.querySelector('.shopify-section');
      if (inner && inner.innerHTML.trim()) rec.innerHTML = inner.innerHTML;
    })['catch'](function () { /* optional */ });
  }
})();
