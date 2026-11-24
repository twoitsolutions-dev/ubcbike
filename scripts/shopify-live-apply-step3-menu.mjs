// Step 5: Update Main Menu (gid://shopify/Menu/302116241725) on ubcbike.myshopify.com
// with the clean 3-level Shopify OS 2.0 collection tree while preserving Services, Rentals, Maps, Buyers Guide, About us.
import fs from 'node:fs/promises';
import { ShopifyAdminClient } from '../packages/integrations/dist/index.js';

const shopDomain = (process.env.UBC_LIVE_SHOPIFY_DOMAIN || '').trim();
const accessToken = (process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN || '').trim();
const client = new ShopifyAdminClient({
  shopDomain,
  accessToken,
  apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || '2026-10',
  plan: 'plus',
  writesEnabled: true,
});

// Fetch latest collections so every resourceId is exact (including newly created ones)
const colRes = await client.query(`{
  collections(first: 250) { nodes { id handle title } }
}`);
const colByHandle = new Map(colRes.nodes ? [] : (colRes.collections.nodes || []).map((c) => [c.handle, c.id]));

const colItem = (title, handle, children = []) => {
  const id = colByHandle.get(handle);
  if (!id) throw new Error(`Missing collection handle: ${handle}`);
  return {
    title,
    type: 'COLLECTION',
    resourceId: id,
    ...(children.length ? { items: children } : {}),
  };
};

const backup = JSON.parse(await fs.readFile('build/ubcbike-live-backup-2026-11-24T20-12-30-066Z.json', 'utf8'));
const oldMenu = backup.menus.find((m) => m.handle === 'main-menu');
if (!oldMenu) throw new Error('main-menu not found in backup');

const stripForInput = (item) => ({
  title: item.title,
  type: item.type,
  ...(item.resourceId ? { resourceId: item.resourceId } : { url: item.url }),
  ...(item.items?.length ? { items: item.items.map(stripForInput) } : {}),
});

const keepTop = oldMenu.items
  .filter((i) => !['SHOP', 'Sales & Closeouts'].includes(i.title))
  .map(stripForInput);

const shopNode = colItem('SHOP', 'all', [
  colItem('Bikes', 'bikes', [
    colItem('Road Bikes', 'road-bikes'),
    colItem('Mountain Bikes', 'mountain-bikes'),
    colItem('Electric Bikes', 'electric-bikes'),
    colItem('Commuter / Urban Bikes', 'commuter-urban-bikes'),
    colItem('Hybrid / Comfort / Fitness Bikes', 'hybrid-bikes'),
    colItem("Children's / Youth Bikes", 'kids-bikes'),
    colItem('BMX Bikes', 'bmx-bikes'),
  ]),
  colItem('Components', 'parts-components', [
    colItem('Brakes/Levers/Pads', 'brakes-levers'),
    colItem('Cables', 'cables'),
    colItem('Cassettes/Freewheels', 'cassettes-freewheels'),
    colItem('Chainrings', 'chainrings'),
    colItem('Chains', 'chains'),
    colItem('Cranksets', 'cranksets'),
    colItem('Derailleurs', 'derailleurs'),
    colItem('Forks', 'forks'),
    colItem('Groups', 'groupsets'),
    colItem('Handlebar Grips/Tape', 'grips-tape'),
    colItem('Handlebars', 'handlebars'),
    colItem('Headsets', 'headsets'),
    colItem('Pedals', 'pedals'),
    colItem('Saddles', 'saddles'),
    colItem('Seatposts', 'seatposts'),
    colItem('Shifters', 'shifters'),
    colItem('Stems', 'stems'),
    colItem('Tires/Tubes', 'tires-tubes'),
    colItem('Tires', 'bicycle-tires'),
    colItem('Tubes', 'tubes'),
    colItem('Wheels', 'wheels'),
    colItem('Other', 'other-components'),
  ]),
  colItem('Accessories', 'accessories-gear', [
    colItem('Car Racks', 'car-racks'),
    colItem('Electronics', 'electronics'),
    colItem('Eyewear', 'eyewear'),
    colItem('Fenders', 'fenders'),
    colItem('Helmets', 'helmets'),
    colItem('Hydration', 'hydration-nutrition'),
    colItem('Lighting', 'lighting'),
    colItem('Locks/Security', 'locks-security'),
    colItem('Nutrition', 'nutrition'),
    colItem('Packs/Racks/Baskets', 'packs-baskets'),
    colItem('Pumps/Inflation', 'pumps-inflation'),
    colItem('Tools/Maintenance', 'tools-workshop'),
    colItem('Other', 'other-accessories'),
  ]),
  colItem('Apparel', 'clothing', [
    colItem('Accessories', 'apparel-accessories'),
    colItem('Gloves', 'gloves'),
    colItem('Jerseys/Tops (Short Sleeve)', 'jerseys-short-sleeve'),
    colItem('Jerseys/Tops (Long Sleeve)', 'jerseys-long-sleeve'),
    colItem('Outerwear', 'outerwear'),
    colItem('Shorts/Bottoms', 'cycling-shorts-bottoms'),
    colItem('Socks', 'socks'),
    colItem('Shoes', 'cycling-shoes'),
  ]),
]);

const salesNode = colItem('Sales & Closeouts', 'sales-closeouts');
const nextItems = [shopNode, salesNode, ...keepTop];

const res = await client.mutate(`mutation($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, items: $items) {
    menu { id handle title items { title items { title } } }
    userErrors { field message }
  }
}`, {
  id: oldMenu.id,
  title: oldMenu.title,
  items: nextItems,
});

if (res.menuUpdate.userErrors?.length) {
  console.error('Menu update errors:', res.menuUpdate.userErrors);
  process.exit(1);
}
console.log('Main Menu updated successfully!');
console.log(res.menuUpdate.menu.items.map((i) => `${i.title} (${i.items?.length || 0} sub)`).join(', '));
