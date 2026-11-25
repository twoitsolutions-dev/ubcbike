import { h, mount } from '../ui/dom.js';
import { card, confirmDialog, pageHead, sectionTabs, toast } from '../ui/components.js';

export function settingsWorkspaceTabs(activeKey) {
  return sectionTabs([
    ['rules', 'Pricing & Stock Rules', '#/settings'],
    ['connections', 'Connections', '#/integrations'],
    ['activity', 'Activity & Logs', '#/activity'],
  ], activeKey);
}

export async function renderSettings(ctx) {
  const s = await ctx.api.settings();
  const canEdit = ctx.can('settings.manage');
  const num = (v, opts) => h('input', Object.assign({ type: 'number', value: String(v), disabled: !canEdit }, opts || {}));
  const minM = num(Math.round(s.campaignRules.minMarginPct * 1000) / 10, { min: '0', max: '95', step: '0.5' });
  const warnM = num(Math.round(s.campaignRules.warnMarginPct * 1000) / 10, { min: '0', max: '95', step: '0.5' });
  const clamp = h('input', { type: 'checkbox', checked: !!s.campaignRules.clampToMinMargin, disabled: !canEdit });
  const physSafety = num(s.availability.physicalSafetyQty, { min: '0', max: '100' });
  const supSafety = num(s.availability.supplierSafetyQty, { min: '0', max: '100' });
  const maxAge = num(s.availability.maxOfferAgeHours, { min: '1', max: '720' });
  const handling = num(s.availability.handlingDays, { min: '0', max: '60' });
  const showUpcMatches = h('input', { type: 'checkbox', checked: s.availability.showUpcMatches !== false, disabled: !canEdit });
  const b = s.branding || {};
  const bName = h('input', { type: 'text', value: b.brandName || 'University Bicycle Center', disabled: !canEdit, maxlength: '80' });
  const bSub = h('input', { type: 'text', value: b.subtitle || 'Commerce Hub · Since 1972', disabled: !canEdit, maxlength: '80' });
  const bLogo = h('input', { type: 'text', value: b.logoUrl || 'assets/ubc-logo-white.png', disabled: !canEdit, maxlength: '500' });
  const bNav = h('input', { type: 'color', value: b.navBg || '#14202D', disabled: !canEdit, style: { width: '52px', padding: '2px', height: '36px' } });
  const bAcc = h('input', { type: 'color', value: b.accent || '#213549', disabled: !canEdit, style: { width: '52px', padding: '2px', height: '36px' } });
  const bGold = h('input', { type: 'color', value: b.gold || '#CCBB8D', disabled: !canEdit, style: { width: '52px', padding: '2px', height: '36px' } });
  const bCoral = h('input', { type: 'color', value: b.coral || '#E04F33', disabled: !canEdit, style: { width: '52px', padding: '2px', height: '36px' } });
  const bSurf = h('select', { disabled: !canEdit },
    h('option', { value: 'slate', selected: (b.surfaceMode || 'slate') === 'slate' }, 'Clean Slate (#F8FAFC)'),
    h('option', { value: 'warm', selected: b.surfaceMode === 'warm' }, 'Warm Cream (#F6F4EC)'));
  const err = h('div');

  const save = h('button.btn.primary', {
    disabled: !canEdit,
    onclick: async () => {
      mount(err);
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
      if (body.campaignRules.warnMarginPct < body.campaignRules.minMarginPct) { mount(err, h('div.notice.bad', 'The warning threshold must be at or above the minimum margin.')); return; }
      try {
        await ctx.api.saveSettings(body);
        toast('Settings & branding saved', 'ok');
        if (ctx.refreshNav) await ctx.refreshNav();
      } catch (e) { mount(err, h('div.notice.bad', e.message)); }
    },
  }, 'Save settings');

  const resetBrand = canEdit ? h('button.btn', {
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
    },
  }, 'Reset to UBC Default') : null;

  const demoTools = ctx.system && ctx.system.mode === 'live'
    ? null
    : ctx.api.kind === 'demo' ? card('Demo tools', h('div.stack',
      h('label.check', h('input', { type: 'checkbox', checked: ctx.api.outageOn(), onchange: (e) => { ctx.api.simulateOutage(e.target.checked); toast(e.target.checked ? 'Supplier outage simulated: approvals and PO submissions will fail and retry' : 'Supplier outage cleared'); } }),
        'Simulate a supplier connection outage (to see retries, errors and exceptions)'),
      h('div', h('button.btn.danger', {
        onclick: async () => {
          if (!(await confirmDialog({ title: 'Reset demo data?', message: 'All demo changes (prices, promotions, orders, history) in this browser are discarded and the original demo dataset is restored.', confirmLabel: 'Reset demo data', danger: true }))) return;
          ctx.api.resetDemo();
          location.hash = '#/dashboard';
          location.reload();
        },
      }, 'Reset demo data')),
      h('p.small.muted', 'Demo data lives only in this browser. Nothing here touches Shopify, Lightspeed or any supplier.'))) : card('Demo data', h('p.small.muted', 'Server DEMO database: reset with `npm run db:reset-demo` (see docs/DEPLOYMENT.md).'));

  return h('div.stack',
    pageHead('Settings & Sync', canEdit ? 'Commercial guardrails, system connections & logs' : 'Read-only — changing rules requires an owner/admin'),
    settingsWorkspaceTabs('rules'),
    card('Promotion & Price Rules Guardrails', h('div.stack',
      h('div.form-grid',
        h('label.field', 'Minimum margin (%)', minM, h('span.help', 'Default floor for every campaign and manual price change')),
        h('label.field', 'Warning threshold (%)', warnM)),
      h('label.check', clamp, 'Default: raise prices to the minimum margin instead of blocking'),
      h('div.notice.info', 'MAP cannot be disabled here. Below-MAP prices require an authorised MAP exception per item.'))),
    card('Availability rules (catalog virtual offers)', h('div.form-grid',
      h('label.field', 'Physical safety stock (units)', physSafety, h('span.help', 'Kept back from online sale')),
      h('label.field', 'Supplier safety quantity', supSafety, h('span.help', 'Supplier must report more than this')),
      h('label.field', 'Max age of supplier data (hours)', maxAge, h('span.help', 'Older data is ignored')),
      h('label.field', 'Handling days at UBC', handling, h('span.help', 'Added to supplier lead time')))),
    card('Hub Modules', h('div.stack',
      h('label.check', showUpcMatches, h('strong', 'Show "UPC Matches" in Hub menu & dashboard'), h('span.small.muted', ' — uncheck anytime to hide the UPC Matches queue')))),
    card('White-Label Branding (Store Identity & Colors)', h('div.stack',
      h('div.form-grid',
        h('label.field', 'Store / Brand Name', bName),
        h('label.field', 'Sidebar Subtitle', bSub),
        h('label.field', 'Logo URL (white/light SVG or PNG)', bLogo),
        h('label.field', 'Workspace Surface', bSurf)),
      h('div.row', { style: { gap: '18px', flexWrap: 'wrap' } },
        h('label.field', { style: { minWidth: '110px' } }, 'Sidebar', bNav),
        h('label.field', { style: { minWidth: '110px' } }, 'Accent', bAcc),
        h('label.field', { style: { minWidth: '110px' } }, 'Highlight', bGold),
        h('label.field', { style: { minWidth: '110px' } }, 'Action / CTA', bCoral)),
      resetBrand ? h('div.row', resetBrand) : null)),
    err,
    h('div.row', save),
    demoTools,
    card('Account', h('dl.props',
      h('dt', 'Signed in as'), h('dd', ctx.me.user.name + ' (' + ctx.me.user.email + ')'),
      h('dt', 'Role'), h('dd', ctx.me.user.role),
      h('dt', 'Permissions'), h('dd', h('div.chips', ctx.me.permissions.map((p) => h('span.badge', p)))))));
}
