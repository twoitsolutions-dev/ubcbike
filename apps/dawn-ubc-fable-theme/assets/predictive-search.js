class PredictiveSearch extends SearchForm {
  constructor() {
    super();
    this.cachedResults = {};
    this.predictiveSearchResults = this.querySelector('[data-predictive-search]');
    this.allPredictiveSearchInstances = document.querySelectorAll('predictive-search');
    this.isOpen = false;
    this.abortController = new AbortController();
    this.searchTerm = '';

    this.setupEventListeners();
  }

  setupEventListeners() {
    this.input.form.addEventListener('submit', this.onFormSubmit.bind(this));

    this.input.addEventListener('focus', this.onFocus.bind(this));
    this.addEventListener('focusout', this.onFocusOut.bind(this));
    this.addEventListener('keyup', this.onKeyup.bind(this));
    this.addEventListener('keydown', this.onKeydown.bind(this));
  }

  getQuery() {
    return this.input.value.trim();
  }

  onChange() {
    super.onChange();
    const newSearchTerm = this.getQuery();
    if (!this.searchTerm || !newSearchTerm.startsWith(this.searchTerm)) {
      // Remove the results when they are no longer relevant for the new search term
      // so they don't show up when the dropdown opens again
      this.querySelector('#predictive-search-results-groups-wrapper')?.remove();
    }

    // Update the term asap, don't wait for the predictive search query to finish loading
    this.updateSearchForTerm(this.searchTerm, newSearchTerm);

    this.searchTerm = newSearchTerm;

    if (!this.searchTerm.length) {
      this.close(true);
      return;
    }

    this.getSearchResults(this.searchTerm);
  }

  onFormSubmit(event) {
    if (!this.getQuery().length || this.querySelector('[aria-selected="true"] a')) event.preventDefault();
  }

  onFormReset(event) {
    super.onFormReset(event);
    if (super.shouldResetForm()) {
      this.searchTerm = '';
      this.abortController.abort();
      this.abortController = new AbortController();
      this.closeResults(true);
    }
  }

  onFocus() {
    const currentSearchTerm = this.getQuery();

    if (!currentSearchTerm.length) return;

    if (this.searchTerm !== currentSearchTerm) {
      // Search term was changed from other search input, treat it as a user change
      this.onChange();
    } else if (this.getAttribute('results') === 'true') {
      this.open();
    } else {
      this.getSearchResults(this.searchTerm);
    }
  }

  onFocusOut() {
    setTimeout(() => {
      if (!this.contains(document.activeElement)) this.close();
    });
  }

  onKeyup(event) {
    if (!this.getQuery().length) this.close(true);
    event.preventDefault();

    switch (event.code) {
      case 'ArrowUp':
        this.switchOption('up');
        break;
      case 'ArrowDown':
        this.switchOption('down');
        break;
      case 'Enter':
        this.selectOption();
        break;
    }
  }

  onKeydown(event) {
    // Prevent the cursor from moving in the input when using the up and down arrow keys
    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      event.preventDefault();
    }
  }

  updateSearchForTerm(previousTerm, newTerm) {
    const searchForTextElement = this.querySelector('[data-predictive-search-search-for-text]');
    const currentButtonText = searchForTextElement?.innerText;
    if (currentButtonText) {
      if (currentButtonText.match(new RegExp(previousTerm, 'g')).length > 1) {
        // The new term matches part of the button text and not just the search term, do not replace to avoid mistakes
        return;
      }
      const newButtonText = currentButtonText.replace(previousTerm, newTerm);
      searchForTextElement.innerText = newButtonText;
    }
  }

  switchOption(direction) {
    if (!this.getAttribute('open')) return;

    const moveUp = direction === 'up';
    const selectedElement = this.querySelector('[aria-selected="true"]');

    // Filter out hidden elements (duplicated page and article resources) thanks
    // to this https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/offsetParent
    const allVisibleElements = Array.from(this.querySelectorAll('li, button.predictive-search__item')).filter(
      (element) => element.offsetParent !== null
    );
    let activeElementIndex = 0;

    if (moveUp && !selectedElement) return;

    let selectedElementIndex = -1;
    let i = 0;

    while (selectedElementIndex === -1 && i <= allVisibleElements.length) {
      if (allVisibleElements[i] === selectedElement) {
        selectedElementIndex = i;
      }
      i++;
    }

    this.statusElement.textContent = '';

    if (!moveUp && selectedElement) {
      activeElementIndex = selectedElementIndex === allVisibleElements.length - 1 ? 0 : selectedElementIndex + 1;
    } else if (moveUp) {
      activeElementIndex = selectedElementIndex === 0 ? allVisibleElements.length - 1 : selectedElementIndex - 1;
    }

    if (activeElementIndex === selectedElementIndex) return;

    const activeElement = allVisibleElements[activeElementIndex];

    activeElement.setAttribute('aria-selected', true);
    if (selectedElement) selectedElement.setAttribute('aria-selected', false);

    this.input.setAttribute('aria-activedescendant', activeElement.id);
  }

  selectOption() {
    const selectedOption = this.querySelector('[aria-selected="true"] a, button[aria-selected="true"]');

    if (selectedOption) selectedOption.click();
  }

  getSearchResults(searchTerm) {
    const queryKey = searchTerm.replace(' ', '-').toLowerCase();
    this.setLiveRegionLoadingState();

    if (this.cachedResults[queryKey]) {
      this.renderSearchResults(this.cachedResults[queryKey]);
      const searchDeferred = this.dispatchSearchUpdateEvent(searchTerm);
      searchDeferred?.resolve({ totalCount: this.getTotalResultCount() });
      return;
    }

    const searchDeferred = this.dispatchSearchUpdateEvent(searchTerm);

    const fieldsParam = 'resources[type]=product,page,article,collection&resources[options][fields]=title,product_type,variants.title,variants.sku,variants.barcode,vendor';
    fetch(`${routes.predictive_search_url}?q=${encodeURIComponent(searchTerm)}&${fieldsParam}&section_id=predictive-search`, {
      signal: this.abortController.signal,
    })
      .then((response) => {
        if (!response.ok) {
          var error = new Error(response.status);
          this.close();
          throw error;
        }

        return response.text();
      })
      .then(async (text) => {
        const resultsMarkup = new DOMParser()
          .parseFromString(text, 'text/html')
          .querySelector('#shopify-section-predictive-search').innerHTML;
        // Save bandwidth keeping the cache in all instances synced
        this.allPredictiveSearchInstances.forEach((predictiveSearchInstance) => {
          predictiveSearchInstance.cachedResults[queryKey] = resultsMarkup;
        });
        this.renderSearchResults(resultsMarkup);
        await this.injectMpnMatches(searchTerm);

        searchDeferred?.resolve({ totalCount: this.getTotalResultCount() });
      })
      .catch((error) => {
        if (error?.code === 20) {
          // Code 20 means the call was aborted
          searchDeferred?.reject(error);
          return;
        }
        searchDeferred?.reject(error);
        this.close();
        throw error;
      });
  }

  getTotalResultCount() {
    return parseInt(this.predictiveSearchResults.querySelector('[data-total-results]')?.dataset.totalResults) || 0;
  }

  dispatchSearchUpdateEvent(query) {
    const { SearchUpdateEvent } = window.StandardEvents || {};
    if (!SearchUpdateEvent) return null;

    const deferred = SearchUpdateEvent.createPromise();
    this.dispatchEvent(
      new SearchUpdateEvent({
        search: { query },
        promise: deferred.promise,
      })
    );
    return deferred;
  }

  setLiveRegionLoadingState() {
    this.statusElement = this.statusElement || this.querySelector('.predictive-search-status');
    this.loadingText = this.loadingText || this.getAttribute('data-loading-text');

    this.setLiveRegionText(this.loadingText);
    this.setAttribute('loading', true);
  }

  setLiveRegionText(statusText) {
    this.statusElement.setAttribute('aria-hidden', 'false');
    this.statusElement.textContent = statusText;

    setTimeout(() => {
      this.statusElement.setAttribute('aria-hidden', 'true');
    }, 1000);
  }

  renderSearchResults(resultsMarkup) {
    this.predictiveSearchResults.innerHTML = resultsMarkup;
    this.setAttribute('results', true);

    this.setLiveRegionResults();
    this.open();
  }

  setLiveRegionResults() {
    this.removeAttribute('loading');
    this.setLiveRegionText(this.querySelector('[data-predictive-search-live-region-count-value]').textContent);
  }

  getResultsMaxHeight() {
    this.resultsMaxHeight =
      window.innerHeight - document.querySelector('.section-header')?.getBoundingClientRect().bottom;
    return this.resultsMaxHeight;
  }

  open() {
    this.predictiveSearchResults.style.maxHeight = this.resultsMaxHeight || `${this.getResultsMaxHeight()}px`;
    this.setAttribute('open', true);
    this.input.setAttribute('aria-expanded', true);
    this.isOpen = true;
  }

  async injectMpnMatches(searchTerm) {
    if (typeof window.__findUbcMpnMatches !== 'function') return;
    const matches = await window.__findUbcMpnMatches(searchTerm);
    if (!matches.length || !this.predictiveSearchResults) return;

    let list = this.predictiveSearchResults.querySelector('#predictive-search-results-products-list');
    if (!list) {
      const wrapper = this.predictiveSearchResults.querySelector('#predictive-search-results-groups-wrapper')
        || this.predictiveSearchResults.querySelector('.predictive-search__results-groups-wrapper')
        || this.predictiveSearchResults;
      const group = document.createElement('div');
      group.className = 'predictive-search__result-group';
      const heading = document.createElement('h2');
      heading.className = 'predictive-search__heading text-body caption-with-letter-spacing';
      heading.textContent = 'Products (SKU Match)';
      list = document.createElement('ul');
      list.id = 'predictive-search-results-products-list';
      list.className = 'predictive-search__results-list list-unstyled';
      list.setAttribute('role', 'group');
      group.appendChild(heading);
      group.appendChild(list);
      wrapper.prepend(group);
    }

    const existingHrefs = new Set(Array.from(list.querySelectorAll('a[href]')).map((a) => a.getAttribute('href').split('?')[0]));
    for (const m of matches) {
      const baseHref = `/products/${m.handle}`;
      if (existingHrefs.has(baseHref)) continue;
      existingHrefs.add(baseHref);

      const li = document.createElement('li');
      li.className = 'predictive-search__list-item';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');

      const a = document.createElement('a');
      a.href = m.vid ? `${baseHref}?variant=${m.vid}` : baseHref;
      a.className = 'predictive-search__item predictive-search__item--link-with-thumbnail link link--text';
      a.setAttribute('tabindex', '-1');

      if (m.image) {
        const img = document.createElement('img');
        img.className = 'predictive-search__image';
        img.src = m.image;
        img.alt = m.title;
        img.width = 50;
        img.height = 50;
        a.appendChild(img);
      }

      const content = document.createElement('div');
      content.className = 'predictive-search__item-content';

      const vendor = document.createElement('div');
      vendor.className = 'predictive-search__item-vendor caption-with-letter-spacing';
      vendor.textContent = `${m.vendor || 'UBC'} · SKU: ${m.mpn}`;
      content.appendChild(vendor);

      const title = document.createElement('p');
      title.className = 'predictive-search__item-heading h5';
      title.textContent = m.title;
      content.appendChild(title);

      if (m.priceFormatted) {
        const price = document.createElement('span');
        price.className = 'price';
        price.textContent = m.priceFormatted;
        content.appendChild(price);
      }

      a.appendChild(content);
      li.appendChild(a);
      list.prepend(li);
    }
    this.setAttribute('results', 'true');
    this.open();
  }

  close(clearSearchTerm = false) {
    this.closeResults(clearSearchTerm);
    this.isOpen = false;
  }

  closeResults(clearSearchTerm = false) {
    if (clearSearchTerm) {
      this.input.value = '';
      this.removeAttribute('results');
    }
    const selected = this.querySelector('[aria-selected="true"]');

    if (selected) selected.setAttribute('aria-selected', false);

    this.input.setAttribute('aria-activedescendant', '');
    this.removeAttribute('loading');
    this.removeAttribute('open');
    this.input.setAttribute('aria-expanded', false);
    this.resultsMaxHeight = false;
    this.predictiveSearchResults.removeAttribute('style');
  }
}

window.__findUbcMpnMatches = async function (rawTerm) {
  const clean = String(rawTerm || '').trim();
  const q = clean.toLowerCase();
  if (q.length < 3) return [];

  const padZeros = (str, len) => (str.length >= len ? str : '0'.repeat(len - str.length) + str);
  const candidateMap = new Map();

  // 1. Live Real-Time Shopify Storefront SKU + UPC / Barcode query (variants.sku & variants.barcode)
  if (!/\s/.test(clean) && /^[a-z0-9._/-]{3,40}$/i.test(clean)) {
    const clauses = [`variants.sku:${clean}*`, `variants.barcode:${clean}`];
    if (/^\d{8,15}$/.test(clean)) {
      const core = clean.replace(/^0+/, '');
      if (core.length >= 6) {
        for (const cand of [padZeros(core, 12), padZeros(core, 13), padZeros(core, 14), core]) {
          const bc = `variants.barcode:${cand}`;
          if (!clauses.includes(bc)) clauses.push(bc);
        }
      }
    }
    try {
      const sugUrl = `/search/suggest.json?q=${encodeURIComponent(clauses.join(' OR '))}&resources[type]=product&resources[limit]=8`;
      const sugRes = await fetch(sugUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const sugProds = sugRes?.resources?.results?.products || [];
      for (const sp of sugProds) {
        if (sp?.handle && !candidateMap.has(sp.handle)) {
          candidateMap.set(sp.handle, { handle: sp.handle, vid: null, mpn: clean });
        }
      }
    } catch {
      // ignore suggest failure
    }
  }

  // 2. Manufacturer Part Number (ubc.mpn) index fallback
  const url = window.routes && window.routes.ubc_sku_index_url;
  if (url) {
    try {
      if (!window.__ubcSkuIndexPromise) {
        window.__ubcSkuIndexPromise = fetch(url).then((r) => (r.ok ? r.json() : [])).catch(() => []);
      }
      const rows = await window.__ubcSkuIndexPromise;
      const partial = [];
      for (let i = 0; i < rows.length; i++) {
        const [mpn, handle, vid] = rows[i];
        const m = String(mpn || '').toLowerCase();
        if (!m || candidateMap.has(handle)) continue;
        if (m === q) {
          candidateMap.set(handle, { mpn: 'MPN ' + mpn, handle, vid });
        } else if (m.includes(q) && partial.length < 6) {
          partial.push({ mpn: 'MPN ' + mpn, handle, vid });
        }
        if (candidateMap.size >= 8) break;
      }
      for (const pt of partial) {
        if (candidateMap.size >= 8) break;
        if (!candidateMap.has(pt.handle)) candidateMap.set(pt.handle, pt);
      }
    } catch {
      // ignore index failure
    }
  }

  const picked = Array.from(candidateMap.values()).slice(0, 8);
  if (!picked.length) return [];

  const coreDigits = /^\d{8,15}$/.test(clean) ? clean.replace(/^0+/, '') : '';
  const products = await Promise.all(
    picked.map(async (item) => {
      try {
        const p = await fetch(`/products/${encodeURIComponent(item.handle)}.js`).then((r) => (r.ok ? r.json() : null));
        if (!p) return null;
        let matchedVar = null;
        if (Array.isArray(p.variants)) {
          if (item.vid) {
            matchedVar = p.variants.find((v) => String(v.id) === String(item.vid)) || null;
          }
          if (!matchedVar) {
            matchedVar = p.variants.find((v) => {
              const vSku = String(v.sku || '').toLowerCase();
              const vBc = String(v.barcode || '').trim();
              const vBcCore = vBc.replace(/^0+/, '');
              return (vSku && (vSku === q || vSku.indexOf(q) === 0))
                || (vBc && (vBc.toLowerCase() === q || (coreDigits && vBcCore === coreDigits)));
            }) || null;
          }
        }
        const activePrice = matchedVar && typeof matchedVar.price === 'number' ? matchedVar.price : p.price;
        const codeLabel = matchedVar && matchedVar.sku
          ? 'SKU ' + matchedVar.sku
          : matchedVar && matchedVar.barcode
            ? 'UPC ' + matchedVar.barcode
            : item.mpn;
        const fullTitle = matchedVar && matchedVar.title && matchedVar.title !== 'Default Title'
          ? `${p.title} — ${matchedVar.title}`
          : p.title;
        const vImg = matchedVar && matchedVar.featured_image && matchedVar.featured_image.src;
        return {
          mpn: codeLabel,
          handle: item.handle,
          vid: matchedVar ? String(matchedVar.id) : item.vid,
          title: fullTitle,
          vendor: p.vendor,
          image: vImg || p.featured_image || (p.images && p.images[0]) || '',
          priceFormatted: typeof activePrice === 'number' ? `$${(activePrice / 100).toFixed(2)}` : '',
        };
      } catch {
        return null;
      }
    })
  );
  return products.filter(Boolean);
};

customElements.define('predictive-search', PredictiveSearch);
