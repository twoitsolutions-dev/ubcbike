// Syntax gate for code that runs in browsers (incl. older iOS Safari):
// ecmaVersion 2020 makes ESLint reject newer syntax (??=, top-level await, class fields, #private...).
const browserGlobals = Object.fromEntries([
  'window', 'document', 'location', 'history', 'navigator', 'fetch', 'Response', 'Request', 'Headers', 'URL', 'URLSearchParams', 'Blob',
  'FileReader', 'Node', 'Event', 'CustomEvent', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'localStorage',
  'sessionStorage', 'requestAnimationFrame', 'performance', 'Intl', 'globalThis',
].map((g) => [g, 'readonly']));

export default [
  {
    files: ['apps/admin/js/**/*.js', 'apps/shopify-theme/assets/*.js'],
    languageOptions: { ecmaVersion: 2020, sourceType: 'module', globals: browserGlobals },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'no-dupe-keys': 'error', 'no-unreachable': 'error' },
  },
  { files: ['apps/admin/js/boot-check.js', 'apps/shopify-theme/assets/*.js'], languageOptions: { ecmaVersion: 5, sourceType: 'script' } },
];
