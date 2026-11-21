import { renderDashboard } from './views/dashboard.js?v=55';
import { renderReports } from './views/reports.js?v=60';
import { renderPipeline } from './views/pipeline.js?v=40';
import { renderProducts, renderProductDetail } from './views/products.js?v=54';
import { renderInventory } from './views/inventory.js?v=40';
import { renderSuppliers } from './views/suppliers.js?v=40';
import { renderPricing } from './views/pricing.js?v=40';
import { renderLightspeedSheet } from './views/lightspeed-sheet.js?v=2';
import { renderPromotions, renderPromotionNew, renderPromotionDetail } from './views/promotions.js?v=46';
import { renderOrders, renderOrderDetail } from './views/orders.js?v=40';
import { renderPurchasing } from './views/purchasing.js?v=40';
import { renderIntegrations } from './views/integrations.js?v=50';
import { renderActivity } from './views/activity.js?v=40';
import { renderSettings } from './views/settings.js?v=54';
import { renderUpcReview } from './views/upc-review.js?v=51';
import { renderHelp } from './views/help.js?v=65';

export const routes = [
  { path: '/dashboard', title: 'Dashboard', render: renderDashboard },
  { path: '/reports', title: 'Reports', render: renderReports },
  { path: '/pipeline', title: 'Vendor Catalogs · Feed Sync', render: renderPipeline },
  { path: '/products', title: 'Item Search', render: renderProducts },
  { path: '/products/:id', title: 'Item Details', render: renderProductDetail },
  { path: '/inventory', title: 'Item Search · In-Store Stock', render: renderInventory },
  { path: '/suppliers', title: 'Vendor Catalogs', render: renderSuppliers },
  { path: '/pricing', title: 'Item Search · Margins & MAP', render: renderPricing },
  { path: '/lightspeed-sheet', title: 'Item Search · Lightspeed Sheet', render: renderLightspeedSheet },
  { path: '/promotions', title: 'Promotions / Price Rules', render: renderPromotions },
  { path: '/promotions/new', title: 'New Promotion / Price Rule', render: renderPromotionNew },
  { path: '/promotions/:id', title: 'Promotion Details', render: renderPromotionDetail },
  { path: '/orders', title: 'Special Orders', render: renderOrders },
  { path: '/orders/:id', title: 'Special Order Details', render: renderOrderDetail },
  { path: '/purchasing', title: 'Purchase Orders (B2B)', render: renderPurchasing },
  { path: '/upc-matches', title: 'UPC Matches (Lightspeed ↔ Shopify)', render: renderUpcReview },
  { path: '/integrations', title: 'Settings & Sync · Connections', render: renderIntegrations },
  { path: '/activity', title: 'Settings & Sync · Activity & Logs', render: renderActivity },
  { path: '/settings', title: 'Settings & Sync', render: renderSettings },
  { path: '/help', title: 'Help & Guides', render: renderHelp },
];

export function matchRoute(hash) {
  const raw = hash.replace(/^#/, '') || '/dashboard';
  const [path, qstr] = raw.split('?');
  const query = {};
  (qstr || '').split('&').filter(Boolean).forEach((kv) => {
    const [k, v] = kv.split('=');
    query[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  const parts = path.split('/').filter(Boolean);
  for (const r of routes) {
    const rp = r.path.split('/').filter(Boolean);
    if (rp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rp.length; i++) {
      if (rp[i].charAt(0) === ':') params[rp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (rp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params, query };
  }
  return null;
}
