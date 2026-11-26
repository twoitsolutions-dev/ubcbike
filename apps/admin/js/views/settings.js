import { h, mount } from '../ui/dom.js';
import { card, confirmDialog, pageHead, sectionTabs, toast } from '../ui/components.js';

export function settingsWorkspaceTabs(activeKey) {
  return sectionTabs([
    ['rules', 'Settings', '#/settings'],
    ['connections', 'Connections', '#/integrations'],
    ['activity', 'Activity & Logs', '#/activity'],
  ], activeKey);
}

export async function renderSettings(ctx) {
  const [s, sr] = await Promise.all([
    ctx.api.settings(),
    ctx.api.shippingRules ? ctx.api.shippingRules().catch(() => null) : Promise.resolve(null),
  ]);
  const canEdit = ctx.can('settings.manage');
  let activeSub = ctx.query.panel || 'rules';

  const subTabsHost = h('div');
  const bodyHost = h('div.stack');

  const num = (v, opts) => h('input', Object.assign({ type: 'number', value: String(v), disabled: !canEdit }, opts || {}));

  // ---- 1. Rules & Guardrails inputs ----
  const minM = num(Math.round(s.campaignRules.minMarginPct * 1000) / 10, { min: '0', max: '95', step: '0.5' });
  const warnM = num(Math.round(s.campaignRules.warnMarginPct * 1000) / 10, { min: '0', max: '95', step: '0.5' });
  const clamp = h('input', { type: 'checkbox', checked: !!s.campaignRules.clampToMinMargin, disabled: !canEdit });
  const physSafety = num(s.availability.physicalSafetyQty, { min: '0', max: '100' });
  const supSafety = num(s.availability.supplierSafetyQty, { min: '0', max: '100' });
  const maxAge = num(s.availability.maxOfferAgeHours, { min: '1', max: '720' });
  const handling = num(s.availability.handlingDays, { min: '0', max: '60' });
  const showUpcMatches = h('input', { type: 'checkbox', checked: s.availability.showUpcMatches !== false, disabled: !canEdit });

  // ---- 2. White-Label Branding inputs ----
  const b = s.branding || {};
  const bName = h('input', { type: 'text', value: b.brandName || 'University Bicycle Center', disabled: !canEdit, maxlength: '80' });
  const bSub = h('input', { type: 'text', value: b.subtitle || 'Commerce Hub · Since 1972', disabled: !canEdit, maxlength: '80' });
  const bLogo = h('input', { type: 'text', value: b.logoUrl || 'assets/ubc-logo-white.png', disabled: !canEdit, maxlength: '500' });
  const colorInput = (val) => h('input', { type: 'color', value: val, disabled: !canEdit, style: { width: '48px', padding: '2px', height: '36px', cursor: canEdit ? 'pointer' : 'default' } });
  const bNav = colorInput(b.navBg || '#14202D');
  const bAcc = colorInput(b.accent || '#213549');
  const bGold = colorInput(b.gold || '#CCBB8D');
  const bCoral = colorInput(b.coral || '#E04F33');
  const bSurf = h('select', { disabled: !canEdit },
    h('option', { value: 'slate', selected: (b.surfaceMode || 'slate') === 'slate' }, 'Clean Slate (#F8FAFC)'),
    h('option', { value: 'warm', selected: b.surfaceMode === 'warm' }, 'Warm Cream (#F6F4EC)'));

  const rulesErr = h('div');
  const saveCoreSettings = async (msg) => {
    mount(rulesErr);
    const body = {
      campaignRules: { minMarginPct: Number(minM.value) / 100, warnMarginPct: Number(warnM.value) / 100, clampToMinMargin: clamp.checked },
      availability: {
        physicalSafetyQty: Number(physSafety.value),
        supplierSafetyQty: Number(supSafety.value),
        maxOfferAgeHours: Number(maxAge.value),
        handlingDays: Number(handling.value),
        showUpcMatches: showUpcMatches.checked,
      },
      branding: {
        brandName: bName.value.trim() || 'Commerce Hub',
        subtitle: bSub.value.trim(),
        logoUrl: bLogo.value.trim() || 'assets/ubc-logo-white.png',
        navBg: bNav.value,
        accent: bAcc.value,
        gold: bGold.value,
        coral: bCoral.value,
        surfaceMode: bSurf.value,
      },
    };
    if (body.campaignRules.warnMarginPct < body.campaignRules.minMarginPct) {
      mount(rulesErr, h('div.notice.bad', 'The warning threshold must be at or above the minimum margin.'));
      return;
    }
    try {
      await ctx.api.saveSettings(body);
      toast(msg || 'Settings saved', 'ok');
      if (ctx.refreshNav) await ctx.refreshNav();
    } catch (e) { mount(rulesErr, h('div.notice.bad', e.message)); }
  };

  function renderRulesTab() {
    mount(bodyHost,
      h('div.grid.grid-2',
        card('Pricing & Margin Guardrails', h('div.stack',
          h('div.form-grid',
            h('label.field', 'Minimum margin (%)', minM, h('span.help', 'Default floor for campaigns and price edits')),
            h('label.field', 'Warning threshold (%)', warnM)),
          h('label.check', clamp, 'Raise prices to minimum margin instead of blocking'),
          h('div.notice.info', 'MAP cannot be disabled here. Below-MAP prices require an authorised MAP exception.'))),
        card('Availability & Lead Times', h('div.stack',
          h('div.form-grid',
            h('label.field', 'Physical safety stock', physSafety, h('span.help', 'Units held back from online')),
            h('label.field', 'Supplier safety qty', supSafety, h('span.help', 'Minimum supplier stock')),
            h('label.field', 'Max supplier feed age (h)', maxAge, h('span.help', 'Older data is ignored')),
            h('label.field', 'Handling days', handling, h('span.help', 'Added to supplier lead time')))))),
      card('Hub Modules', h('div.stack',
        h('label.check', showUpcMatches, h('strong', 'Enable standalone UPC Matches route'), h('span.small.muted', ' — UPC Matches is also available inside Reports → UPC & Shopify Sync')))),
      rulesErr,
      canEdit ? h('div.row', h('button.btn.primary', { type: 'button', onclick: () => saveCoreSettings('Rules saved') }, 'Save Rules')) : null);
  }

  function renderShippingTab() {
    if (!sr) {
      mount(bodyHost, card('Smart Dimensional Shipping', h('p.muted', 'Shipping settings are not available in this mode.')));
      return;
    }
    const boxes = sr.boxes || {};
    const med = boxes.medium || { name: 'Medium Box', lengthIn: 12, widthIn: 12, heightIn: 12, defaultWeightLb: 8, fallbackCents: 1295 };
    const bike = boxes.bike || { name: 'Bicycles', lengthIn: 40, widthIn: 12, heightIn: 26, defaultWeightLb: 50, fallbackCents: 14500 };
    const ebike = boxes.ebike || { name: 'E-Bike', lengthIn: 63, widthIn: 12, heightIn: 34, defaultWeightLb: 86, fallbackCents: 22500 };

    const sZip = h('input', { type: 'text', value: sr.originPostalCode || '33612', disabled: !canEdit, maxlength: '16' });
    const sState = h('input', { type: 'text', value: sr.originProvince || 'FL', disabled: !canEdit, maxlength: '10' });
    const sFee = num(Math.round((sr.handlingFeePct || 0.1) * 1000) / 10, { min: '0', max: '100', step: '0.5' });
    const sEasy = h('input', { type: 'password', value: sr.easypostApiKey || '', placeholder: 'EZAK... (optional for live UPS/USPS)', disabled: !canEdit });
    const sBlockUsps = h('input', { type: 'checkbox', checked: sr.blockUspsOnBikes !== false, disabled: !canEdit });
    const bikeFallback = num((bike.fallbackCents || 14500) / 100, { min: '0', max: '2000', step: '1' });
    const ebikeFallback = num((ebike.fallbackCents || 22500) / 100, { min: '0', max: '2000', step: '1' });
    const shipMsg = h('div');

    const boxRow = (title, dims, wt) => h('div.row-between', {
      style: { padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '8px' },
    }, h('strong', title), h('span.small.muted.mono', dims + ' · ' + wt));

    const testZip = h('input', { type: 'text', value: '90210', style: { width: '100px' } });
    const testKind = h('select', { style: { width: 'auto' } },
      h('option', { value: 'medium' }, 'Medium Box (Gear/Parts)'),
      h('option', { value: 'bike', selected: true }, 'Bicycle (40×12×26)'),
      h('option', { value: 'ebike' }, 'E-Bike (63×12×34)'));
    const testOut = h('div.stack-sm');

    mount(bodyHost,
      h('div.grid.grid-2',
        card('Origin, Carrier API & Fallback Rates', h('div.stack',
          h('div.form-grid',
            h('label.field', 'Origin ZIP', sZip),
            h('label.field', 'Origin State', sState),
            h('label.field', 'Handling Fee (%)', sFee),
            h('label.field', 'EasyPost API Key', sEasy, h('span.help', '$0/mo plan for live UPS/USPS quotes; keep buying labels in Pirate Ship')),
            h('label.field', 'Bike Base Rate ($)', bikeFallback),
            h('label.field', 'E-Bike Base Rate ($)', ebikeFallback)),
          h('label.check', sBlockUsps, 'Block USPS whenever cart contains a Bicycle or E-Bike'),
          shipMsg,
          canEdit ? h('div.row',
            h('button.btn.primary', {
              type: 'button',
              onclick: async () => {
                mount(shipMsg);
                try {
                  await ctx.api.saveShippingRules({
                    enabled: true,
                    originPostalCode: sZip.value.trim() || '33612',
                    originProvince: sState.value.trim() || 'FL',
                    originCountry: 'US',
                    handlingFeePct: Number(sFee.value) / 100,
                    blockUspsOnBikes: sBlockUsps.checked,
                    easypostApiKey: sEasy.value.trim(),
                    boxes: {
                      medium: med,
                      bike: Object.assign({}, bike, { fallbackCents: Math.round(Number(bikeFallback.value) * 100) }),
                      ebike: Object.assign({}, ebike, { fallbackCents: Math.round(Number(ebikeFallback.value) * 100) }),
                    },
                  });
                  toast('Shipping rules saved', 'ok');
                } catch (e) { mount(shipMsg, h('div.notice.bad', e.message)); }
              },
            }, 'Save Shipping Rules'),
            h('button.btn', {
              type: 'button',
              onclick: async () => {
                mount(shipMsg);
                try {
                  const res = await ctx.api.registerCarrierService({});
                  toast('CarrierService registered in Shopify!', 'ok');
                  mount(shipMsg, h('div.notice.ok', 'Active in Shopify: ' + res.carrierServiceId));
                } catch (e) {
                  mount(shipMsg, h('div.notice.bad', e.message + ' — Requires Carrier-Calculated Shipping (CCS) on your Shopify plan and write_shipping scope.'));
                }
              },
            }, sr.carrierServiceId ? '↻ Sync CarrierService in Shopify' : 'Register CarrierService in Shopify')) : null)),
        card('Box Packing Profiles & Rate Simulator', h('div.stack',
          h('div.stack-sm',
            boxRow(med.name, med.lengthIn + '×' + med.widthIn + '×' + med.heightIn + ' in', med.defaultWeightLb + ' lb'),
            boxRow(bike.name, bike.lengthIn + '×' + bike.widthIn + '×' + bike.heightIn + ' in', bike.defaultWeightLb + ' lb'),
            boxRow(ebike.name, ebike.lengthIn + '×' + ebike.widthIn + '×' + ebike.heightIn + ' in', ebike.defaultWeightLb + ' lb')),
          h('div.sep'),
          h('div.row', { style: { gap: '8px', alignItems: 'center' } },
            testKind,
            h('span.small.muted', 'to ZIP'),
            testZip,
            h('button.btn.sm', {
              type: 'button',
              onclick: async () => {
                mount(testOut, h('span.small.muted', 'Calculating…'));
                try {
                  const res = await ctx.api.testShippingRates({ postalCode: testZip.value.trim() || '90210', kind: testKind.value });
                  const rates = res.rates || [];
                  mount(testOut, rates.map((r) => h('div.row-between', { style: { padding: '8px 10px', background: 'var(--surface-2)', borderRadius: '8px' } },
                    h('span', h('strong', r.service_name), h('div.small.muted', r.description || '')),
                    h('strong.mono', '$' + (Number(r.total_price || 0) / 100).toFixed(2)))));
                } catch (e) { mount(testOut, h('div.notice.bad', e.message)); }
              },
            }, 'Simulate')),
          testOut))));
  }

  function renderBrandingTab() {
    const previewLogo = h('img', { src: bLogo.value || 'assets/ubc-logo-white.png', alt: '', style: { height: '24px', width: 'auto', objectFit: 'contain' } });
    const previewSub = h('div', { style: { fontSize: '10px', fontWeight: '700', letterSpacing: '0.08em', textTransform: 'uppercase', color: bGold.value } }, bSub.value || 'Commerce Hub');
    const previewBar = h('div', {
      style: {
        background: bNav.value,
        color: '#FEFDF3',
        padding: '16px',
        borderRadius: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
    },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', paddingBottom: '10px', borderBottom: '1px solid rgba(255,255,255,0.12)' } }, previewLogo, previewSub),
    h('div', { style: { padding: '7px 10px', borderRadius: '6px', background: bAcc.value, fontSize: '13px', fontWeight: '600' } }, 'Dashboard'),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12.5px', opacity: '0.85', padding: '4px 10px' } },
      h('span', 'Alerts / Action'),
      h('span', { style: { background: bCoral.value, color: '#fff', padding: '1px 7px', borderRadius: '999px', fontSize: '11px', fontWeight: '700' } }, '3')));

    const previewSurface = h('div', {
      style: {
        background: bSurf.value === 'warm' ? '#F6F4EC' : '#F8FAFC',
        padding: '14px',
        borderRadius: '12px',
        border: '1px solid var(--border)',
      },
    }, previewBar);

    const syncPreview = () => {
      previewBar.style.background = bNav.value;
      previewSub.textContent = bSub.value || 'Commerce Hub';
      previewSub.style.color = bGold.value;
      previewLogo.src = bLogo.value || 'assets/ubc-logo-white.png';
      previewSurface.style.background = bSurf.value === 'warm' ? '#F6F4EC' : '#F8FAFC';
      previewBar.children[1].style.background = bAcc.value;
      previewBar.children[2].children[1].style.background = bCoral.value;
    };
    [bName, bSub, bLogo, bNav, bAcc, bGold, bCoral, bSurf].forEach((el) => {
      el.addEventListener('input', syncPreview);
      el.addEventListener('change', syncPreview);
    });

    mount(bodyHost,
      h('div.grid.grid-2',
        card('Store Identity & Colors', h('div.stack',
          h('div.form-grid',
            h('label.field', 'Store / Brand Name', bName),
            h('label.field', 'Sidebar Subtitle', bSub),
            h('label.field', 'Logo URL (light SVG/PNG)', bLogo),
            h('label.field', 'Workspace Surface', bSurf)),
          h('div.row', { style: { gap: '16px', flexWrap: 'wrap' } },
            h('label.field', { style: { minWidth: '90px' } }, 'Sidebar', bNav),
            h('label.field', { style: { minWidth: '90px' } }, 'Accent', bAcc),
            h('label.field', { style: { minWidth: '90px' } }, 'Highlight', bGold),
            h('label.field', { style: { minWidth: '90px' } }, 'Action', bCoral)),
          rulesErr,
          canEdit ? h('div.row',
            h('button.btn.primary', { type: 'button', onclick: () => saveCoreSettings('Branding saved') }, 'Save Branding'),
            h('button.btn', {
              type: 'button',
              onclick: () => {
                bName.value = 'University Bicycle Center';
                bSub.value = 'Commerce Hub · Since 1972';
                bLogo.value = 'assets/ubc-logo-white.png';
                bNav.value = '#14202D';
                bAcc.value = '#213549';
                bGold.value = '#CCBB8D';
                bCoral.value = '#E04F33';
                bSurf.value = 'slate';
                syncPreview();
              },
            }, 'Reset to UBC Default')) : null)),
        card('Live White-Label Preview', previewSurface)));
  }

  function renderAccountTab() {
    const demoTools = ctx.system && ctx.system.mode === 'live'
      ? null
      : ctx.api.kind === 'demo' ? card('Demo Tools', h('div.stack',
        h('label.check', h('input', { type: 'checkbox', checked: ctx.api.outageOn(), onchange: (e) => { ctx.api.simulateOutage(e.target.checked); toast(e.target.checked ? 'Supplier outage simulated' : 'Supplier outage cleared'); } }),
          'Simulate a supplier connection outage'),
        h('div', h('button.btn.danger', {
          onclick: async () => {
            if (!(await confirmDialog({ title: 'Reset demo data?', message: 'All demo changes in this browser are discarded and the original demo dataset is restored.', confirmLabel: 'Reset demo data', danger: true }))) return;
            ctx.api.resetDemo();
            location.hash = '#/dashboard';
            location.reload();
          },
        }, 'Reset demo data')))) : card('Demo Data', h('p.small.muted', 'Server DEMO database: reset with `npm run db:reset-demo`.'));

    mount(bodyHost,
      card('Account & Permissions', h('dl.props',
        h('dt', 'Signed in as'), h('dd', ctx.me.user.name + ' (' + ctx.me.user.email + ')'),
        h('dt', 'Role'), h('dd', ctx.me.user.role),
        h('dt', 'Permissions'), h('dd', h('div.chips', ctx.me.permissions.map((p) => h('span.badge', p)))))),
      demoTools);
  }

  const SUB_TABS = [
    ['rules', 'Rules & Guardrails', renderRulesTab],
    ['shipping', 'Shipping & Boxes', renderShippingTab],
    ['branding', 'White-Label Branding', renderBrandingTab],
    ['account', 'Account & System', renderAccountTab],
  ];

  const drawSubTabs = () => {
    mount(subTabsHost, h('div.rep-subtabs', SUB_TABS.map(([id, label]) =>
      h('button.rep-subtab', {
        type: 'button',
        class: activeSub === id ? 'on' : '',
        onclick: () => {
          activeSub = id;
          drawSubTabs();
          const entry = SUB_TABS.find((t) => t[0] === activeSub) || SUB_TABS[0];
          entry[2]();
        },
      }, label))));
  };

  drawSubTabs();
  (SUB_TABS.find((t) => t[0] === activeSub) || SUB_TABS[0])[2]();

  return h('div.stack',
    pageHead('Settings & Sync', canEdit ? 'Rules, dimensional shipping, white-label branding & connections' : 'Read-only — changing rules requires an owner/admin'),
    settingsWorkspaceTabs('rules'),
    subTabsHost,
    bodyHost);
}
