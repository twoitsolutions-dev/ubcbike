import { h, mount } from '../ui/dom.js';
import { card, pageHead, toast } from '../ui/components.js';

function starsText(n) {
  const k = Math.max(1, Math.min(5, Math.round(Number(n) || 5)));
  return '★'.repeat(k) + '☆'.repeat(5 - k);
}

function fmtDate(iso) {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString();
  } catch (e) {
    return String(iso);
  }
}

export async function renderReviews(ctx) {
  const { api } = ctx;
  const host = h('div.stack');

  let state = { apiConfigured: false, summary: { rating: 0, totalReviews: 0 }, sources: [], reviews: [] };

  async function load() {
    state = await api.reviews();
    draw();
  }

  function renderSummaryBanner() {
    const s = state.summary || { rating: 0, totalReviews: 0 };
    const apiBadge = state.apiConfigured
      ? h('span.badge.ok', 'Google Places API key connected')
      : h('span.badge.warn', 'Manual / Pending GOOGLE_PLACES_API_KEY');
    return h('div.row-between', { style: { flexWrap: 'wrap', gap: '12px' } },
      h('div.stack-xs',
        h('div.row', { style: { gap: '10px', alignItems: 'center' } },
          h('strong', { style: { fontSize: '20px' } }, s.totalReviews > 0 ? (s.rating + ' ★') : 'No rating synced yet'),
          h('span.muted', s.totalReviews > 0 ? (s.totalReviews.toLocaleString() + ' total Google reviews') : 'Add Place IDs or real reviews below'),
          apiBadge),
        h('div.small.muted', 'Only real Google reviews from Tampa & Alafia are stored and published to assets/ubc-reviews.json.')),
      h('div.row', { style: { gap: '8px', flexWrap: 'wrap' } },
        h('button.btn', {
          type: 'button',
          disabled: !state.apiConfigured,
          title: state.apiConfigured ? 'Fetch latest reviews from Google Places API' : 'Set GOOGLE_PLACES_API_KEY on Hostinger first',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              const res = await api.syncGoogleReviews();
              toast('Synced ' + (res.upsertedReviews || 0) + ' Google reviews from ' + (res.syncedLocations || 0) + ' location(s)', 'ok');
              await load();
            } catch (err) {
              toast(err.message || 'Google sync failed', 'bad');
            } finally {
              btn.disabled = !state.apiConfigured;
            }
          },
        }, 'Sync from Google'),
        h('button.btn.primary', {
          type: 'button',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              const res = await api.publishReviewsToShopify();
              toast('Published ' + res.count + ' reviews to ' + res.themesUpdated + ' Shopify theme(s)', 'ok');
            } catch (err) {
              toast(err.message || 'Publish failed', 'bad');
            } finally {
              btn.disabled = false;
            }
          },
        }, 'Publish to Shopify Theme')));
  }

  function renderSourcesCard() {
    const inputs = {};
    const rows = state.sources.map((src) => {
      const placeIn = h('input', { type: 'text', value: src.placeId || '', placeholder: 'ChIJ... (Google Place ID)' });
      const ratingIn = h('input', { type: 'number', step: '0.1', min: '0', max: '5', value: String(src.rating || 0) });
      const countIn = h('input', { type: 'number', step: '1', min: '0', value: String(src.totalReviews || 0) });
      const urlIn = h('input', { type: 'url', value: src.googleMapsUrl || '', placeholder: 'https://www.google.com/maps/...' });
      inputs[src.locationKey] = { placeIn, ratingIn, countIn, urlIn };

      return h('div.card', { style: { padding: '12px', background: 'var(--bg-soft, rgba(0,0,0,0.02))' } },
        h('div.row-between', { style: { marginBottom: '8px', flexWrap: 'wrap', gap: '8px' } },
          h('div', h('strong', src.name), h('div.small.muted', src.address)),
          h('span.small.muted', 'Last API sync: ' + fmtDate(src.syncedAt))),
        h('div.grid.grid-2', { style: { gap: '10px' } },
          h('label.field', h('span.small.muted', 'Google Place ID'), placeIn),
          h('label.field', h('span.small.muted', 'Google Maps Link'), urlIn),
          h('label.field', h('span.small.muted', 'Rating (e.g. 4.8)'), ratingIn),
          h('label.field', h('span.small.muted', 'Total Google Reviews'), countIn)));
    });

    const saveBtn = h('button.btn', {
      type: 'button',
      onclick: async () => {
        saveBtn.disabled = true;
        try {
          const sources = Object.keys(inputs).map((k) => ({
            locationKey: k,
            placeId: inputs[k].placeIn.value.trim(),
            rating: Number(inputs[k].ratingIn.value) || 0,
            totalReviews: Math.max(0, Math.round(Number(inputs[k].countIn.value) || 0)),
            googleMapsUrl: inputs[k].urlIn.value.trim(),
          }));
          await api.saveReviewSources(sources);
          toast('Google locations saved', 'ok');
          await load();
        } catch (err) {
          toast(err.message || 'Save failed', 'bad');
        } finally {
          saveBtn.disabled = false;
        }
      },
    }, 'Save Locations');

    return card('1. Google Business Locations (Tampa & Alafia)',
      h('div.stack-sm',
        renderSummaryBanner(),
        h('div.stack-sm', rows),
        h('div.row-between',
          h('span.small.muted', 'Find Place IDs at developers.google.com/maps/documentation/places/web-service/place-id'),
          saveBtn)));
  }

  function renderAddManualCard() {
    const locSel = h('select',
      h('option', { value: 'tampa' }, 'Tampa · Fletcher Ave'),
      h('option', { value: 'alafia' }, 'Alafia River State Park'));
    const authorIn = h('input', { type: 'text', placeholder: 'Customer name as shown on Google', required: true });
    const ratingSel = h('select',
      h('option', { value: '5' }, '5 stars'),
      h('option', { value: '4' }, '4 stars'),
      h('option', { value: '3' }, '3 stars'),
      h('option', { value: '2' }, '2 stars'),
      h('option', { value: '1' }, '1 star'));
    const timeIn = h('input', { type: 'text', placeholder: 'e.g. 2 weeks ago / Oct 2026' });
    const textIn = h('textarea', { rows: '3', placeholder: 'Paste exact verified review text from Google Maps…', required: true });

    const form = h('form.stack-sm', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api.addManualReview({
            locationKey: locSel.value,
            authorName: authorIn.value.trim(),
            rating: Number(ratingSel.value),
            relativeTime: timeIn.value.trim(),
            text: textIn.value.trim(),
            featured: true,
          });
          authorIn.value = '';
          timeIn.value = '';
          textIn.value = '';
          toast('Real review added — click Publish to Shopify Theme when ready', 'ok');
          await load();
        } catch (err) {
          toast(err.message || 'Could not add review', 'bad');
        }
      },
    },
    h('div.grid.grid-2', { style: { gap: '10px' } },
      h('label.field', h('span.small.muted', 'Store Location'), locSel),
      h('label.field', h('span.small.muted', 'Reviewer Name'), authorIn),
      h('label.field', h('span.small.muted', 'Stars'), ratingSel),
      h('label.field', h('span.small.muted', 'Date / Relative Time'), timeIn)),
    h('label.field', h('span.small.muted', 'Exact Google Review Text'), textIn),
    h('div.row-between',
      h('span.small.muted', 'Only paste real reviews from Google Maps (no fabricated testimonials).'),
      h('button.btn', { type: 'submit' }, '+ Add Verified Review')));

    return card('2. Add / Curate Google Reviews (' + state.reviews.length + ')',
      h('div.stack',
        form,
        state.reviews.length === 0
          ? h('div.notice.info', 'No reviews stored yet. Add your Google Place IDs + API key above, or paste real Google reviews here.')
          : h('div.stack-xs', state.reviews.map((r) => h('div.card', {
              style: { padding: '10px 12px', opacity: r.hidden ? '0.55' : '1' },
            },
            h('div.row-between', { style: { gap: '8px', flexWrap: 'wrap' } },
              h('div',
                h('strong', r.author_name),
                ' ',
                h('span', { style: { color: '#D97706' } }, starsText(r.rating)),
                ' ',
                h('span.badge', r.location_key === 'alafia' ? 'Alafia' : 'Tampa'),
                ' ',
                h('span.small.muted', r.relative_time || r.source)),
              h('div.row', { style: { gap: '6px' } },
                h('button.btn.sm', {
                  type: 'button',
                  onclick: async () => {
                    await api.updateReview(r.id, { featured: !r.featured });
                    await load();
                  },
                }, r.featured ? '★ Featured' : '☆ Feature'),
                h('button.btn.sm', {
                  type: 'button',
                  onclick: async () => {
                    await api.updateReview(r.id, { hidden: !r.hidden });
                    await load();
                  },
                }, r.hidden ? 'Show' : 'Hide'),
                h('button.btn.sm.danger', {
                  type: 'button',
                  onclick: async () => {
                    await api.deleteReview(r.id);
                    await load();
                  },
                }, 'Delete'))),
            h('p', { style: { margin: '6px 0 0', lineHeight: '1.45' } }, r.text))))));
  }

  function renderJudgemeCard() {
    return card('3. Judge.me Product Reviews (Verified Buyers)',
      h('div.stack-sm',
        h('p', { style: { margin: 0 } },
          'Google Reviews cover your two physical stores (Tampa & Alafia). For individual bikes, parts, and accessories on product pages, install ',
          h('strong', 'Judge.me Product Reviews'),
          ' (Free plan includes automatic post-purchase review emails, photo reviews, Verified Buyer badges, and Google SEO star snippets).'),
        h('ol', { style: { margin: '4px 0', paddingLeft: '20px', lineHeight: '1.6' } },
          h('li', 'Open Shopify App Store and install ', h('strong', 'Judge.me Product Reviews'), ' on ', h('code', 'z5wxyn-uc.myshopify.com'), '.'),
          h('li', 'Inside Judge.me onboarding, enable ', h('strong', 'App Embeds'), ' in the active theme (', h('strong', 'UBC Dawn V34'), ') so stars appear on collection & product cards automatically.'),
          h('li', 'Enable ', h('strong', 'Review Request Emails'), ' (send 7–10 days after fulfillment) and turn on ', h('strong', 'SEO Rich Snippets'), '.')),
        h('div.row', { style: { gap: '10px', flexWrap: 'wrap' } },
          h('a.btn.primary', {
            href: 'https://apps.shopify.com/judgeme',
            target: '_blank',
            rel: 'noopener',
          }, 'Open Judge.me on Shopify App Store ↗'),
          h('a.btn', {
            href: 'https://admin.shopify.com/store/z5wxyn-uc/themes/194100855101/editor?context=apps',
            target: '_blank',
            rel: 'noopener',
          }, 'Open UBC Dawn V34 App Embeds ↗'))));
  }

  function draw() {
    mount(host,
      pageHead('Reviews & Social Proof', 'Sync real Google Reviews for Tampa & Alafia into Shopify, and manage Judge.me product reviews.'),
      renderSourcesCard(),
      renderAddManualCard(),
      renderJudgemeCard());
  }

  await load();
  return host;
}
