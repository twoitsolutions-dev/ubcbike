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

  function renderAutoSyncCard() {
    const s = state.summary || { rating: 0, totalReviews: 0 };
    const apiBadge = state.apiConfigured
      ? h('span.badge.ok', 'Auto-sync active (every 12h)')
      : h('span.badge.warn', 'Needs GOOGLE_PLACES_API_KEY on Hostinger');

    const inputs = {};
    const rows = state.sources.map((src) => {
      const placeIn = h('input', { type: 'text', value: src.placeId || '', placeholder: 'ChIJ... (Google Place ID)' });
      const urlIn = h('input', { type: 'url', value: src.googleMapsUrl || '', placeholder: 'https://www.google.com/maps/...' });
      inputs[src.locationKey] = { placeIn, urlIn, rating: src.rating || 0, totalReviews: src.totalReviews || 0 };

      return h('div.card', { style: { padding: '12px', background: 'var(--bg-soft, rgba(0,0,0,0.02))' } },
        h('div.row-between', { style: { marginBottom: '8px', flexWrap: 'wrap', gap: '8px' } },
          h('div',
            h('strong', src.name),
            h('div.small.muted', src.address)),
          h('div.small.muted',
            (src.totalReviews > 0 ? (src.rating + ' ★ · ' + src.totalReviews + ' reviews · ') : '') +
            'Last sync: ' + fmtDate(src.syncedAt))),
        h('div.grid.grid-2', { style: { gap: '10px' } },
          h('label.field', h('span.small.muted', 'Google Place ID'), placeIn),
          h('label.field', h('span.small.muted', 'Google Maps Link'), urlIn)));
    });

    const saveBtn = h('button.btn', {
      type: 'button',
      onclick: async () => {
        saveBtn.disabled = true;
        try {
          const sources = Object.keys(inputs).map((k) => ({
            locationKey: k,
            placeId: inputs[k].placeIn.value.trim(),
            rating: inputs[k].rating,
            totalReviews: inputs[k].totalReviews,
            googleMapsUrl: inputs[k].urlIn.value.trim(),
          }));
          await api.saveReviewSources(sources);
          toast('Place IDs saved', 'ok');
          await load();
        } catch (err) {
          toast(err.message || 'Save failed', 'bad');
        } finally {
          saveBtn.disabled = false;
        }
      },
    }, 'Save Place IDs');

    const syncBtn = h('button.btn.primary', {
      type: 'button',
      disabled: !state.apiConfigured,
      title: state.apiConfigured ? 'Pull the 5 newest Google reviews and rotate them on Shopify' : 'Add GOOGLE_PLACES_API_KEY in Hostinger first',
      onclick: async () => {
        syncBtn.disabled = true;
        try {
          const res = await api.syncGoogleReviews();
          toast('Synced & published ' + ((res.published && res.published.count) || 5) + ' newest Google reviews to Shopify', 'ok');
          await load();
        } catch (err) {
          toast(err.message || 'Google sync failed', 'bad');
        } finally {
          syncBtn.disabled = !state.apiConfigured;
        }
      },
    }, 'Sync & Publish Newest 5 Now');

    return card('1. Google Reviews Auto-Sync (5 Newest Rotating on Homepage)',
      h('div.stack-sm',
        h('div.row-between', { style: { flexWrap: 'wrap', gap: '12px' } },
          h('div.stack-xs',
            h('div.row', { style: { gap: '10px', alignItems: 'center' } },
              h('strong', { style: { fontSize: '20px' } }, s.totalReviews > 0 ? (s.rating + ' ★') : 'Waiting for Google API sync'),
              h('span.muted', s.totalReviews > 0 ? (s.totalReviews.toLocaleString() + ' total Google reviews') : 'Reads directly from Google Places API'),
              apiBadge),
            h('div.small.muted', 'Automatically fetches the 5 most recent Google reviews from Tampa & Alafia every 12 hours and updates the rotating carousel on UBC Dawn V34.')),
          h('div.row', { style: { gap: '8px', flexWrap: 'wrap' } }, saveBtn, syncBtn)),
        h('div.stack-sm', rows),
        !state.apiConfigured
          ? h('div.notice.info',
              'To enable automatic reading from Google: add ',
              h('code', 'GOOGLE_PLACES_API_KEY'),
              ' in Hostinger Node.js environment variables and save the Tampa & Alafia Google Place IDs above.')
          : null));
  }

  function renderLatestFiveCard() {
    const latest = state.reviews.filter((r) => !r.hidden).slice(0, 5);
    return card('2. Newest 5 Reviews Currently Rotating on Storefront (' + latest.length + ')',
      latest.length === 0
        ? h('div.notice.info', 'No Google reviews synced yet. Once GOOGLE_PLACES_API_KEY and Place IDs are set, the 5 newest reviews will appear here and rotate on the homepage.')
        : h('div.stack-xs', latest.map((r) => h('div.card', { style: { padding: '10px 12px' } },
            h('div.row-between', { style: { gap: '8px', flexWrap: 'wrap' } },
              h('div',
                h('strong', r.author_name),
                ' ',
                h('span', { style: { color: '#D97706' } }, starsText(r.rating)),
                ' ',
                h('span.badge', r.location_key === 'alafia' ? 'Alafia' : 'Tampa')),
              h('span.small.muted', r.relative_time || fmtDate(r.published_at))),
            h('p', { style: { margin: '6px 0 0', lineHeight: '1.45' } }, r.text)))));
  }

  function renderJudgemeCard() {
    return card('3. Judge.me Product Reviews (Verified Buyers)',
      h('div.stack-sm',
        h('p', { style: { margin: 0 } },
          'Judge.me handles individual product reviews from real buyers. Since it is already installed, make sure its App Embed is switched ON in ',
          h('strong', 'UBC Dawn V34'),
          '.'),
        h('div.row', { style: { gap: '10px', flexWrap: 'wrap' } },
          h('a.btn.primary', {
            href: 'https://admin.shopify.com/store/z5wxyn-uc/themes/194100855101/editor?context=apps',
            target: '_blank',
            rel: 'noopener',
          }, 'Enable Judge.me in UBC Dawn V34 ↗'),
          h('a.btn', {
            href: 'https://admin.shopify.com/store/z5wxyn-uc/apps/judge-me-reviews',
            target: '_blank',
            rel: 'noopener',
          }, 'Open Judge.me Settings ↗'))));
  }

  function draw() {
    mount(host,
      pageHead('Reviews & Social Proof', 'Automatic rotating Google Reviews (5 newest) + Judge.me product reviews.'),
      renderAutoSyncCard(),
      renderLatestFiveCard(),
      renderJudgemeCard());
  }

  await load();
  return host;
}
