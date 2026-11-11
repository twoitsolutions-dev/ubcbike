import { renderDashboard } from './views/dashboard.js';
import { renderProducts, renderProductDetail } from './views/products.js';
import { renderInventory } from './views/inventory.js';
import { renderSuppliers } from './views/suppliers.js';
import { renderPricing } from './views/pricing.js';
import { renderPromotions, renderPromotionNew, renderPromotionDetail } from './views/promotions.js';
import { renderOrders, renderOrderDetail } from './views/orders.js';
import { renderPurchasing } from './views/purchasing.js';
import { renderStore } from './views/store.js';
import { renderIntegrations } from './views/integrations.js';
import { renderActivity } from './views/activity.js';
import { renderSettings } from './views/settings.js';

export const routes = [
  { path: '/dashboard', title: 'Dashboard', render: renderDashboard },
  { path: '/products', title: 'Products', render: renderProducts },
  { path: '/products/:id', title: 'Product', render: renderProductDetail },
  { path: '/inventory', title: 'Inventory', render: renderInventory },
  { path: '/suppliers', title: 'Suppliers', render: renderSuppliers },
  { path: '/pricing', title: 'Prices & margins', render: renderPricing },
  { path: '/promotions', title: 'Promotions', render: renderPromotions },
  { path: '/promotions/new', title: 'New promotion', render: renderPromotionNew },
  { path: '/promotions/:id', title: 'Promotion', render: renderPromotionDetail },
  { path: '/orders', title: 'Orders', render: renderOrders },
  { path: '/orders/:id', title: 'Order', render: renderOrderDetail },
  { path: '/purchasing', title: 'Supplier purchasing', render: renderPurchasing },
  { path: '/store', title: 'Store (simulated)', render: renderStore },
  { path: '/integrations', title: 'Integrations', render: renderIntegrations },
  { path: '/activity', title: 'History & errors', render: renderActivity },
  { path: '/settings', title: 'Settings', render: renderSettings },
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
