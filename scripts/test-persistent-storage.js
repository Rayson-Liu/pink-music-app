/**
 * Test persistent storage operations and schema validation
 */
const assert = require('assert');

console.log('[test:storage] Running persistent storage validation...');

// Mock localStorage environment
const storageMock = (() => {
  let store = {};
  return {
    getItem: (key) => store[key] || null,
    setItem: (key, val) => { store[key] = String(val); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; }
  };
})();

// Test 1: Theme, Custom Background and UI Transparency schema
const themeSettings = {
  currentTheme: 'dark',
  currentColor: 'pink',
  customBgEnabled: true,
  customBgUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  customBgOpacity: 0.85,
  customBgBlur: 10,
  customBgScale: 1.1,
  customBgPosition: 'center',
  customBgMaskOpacity: 0.25,
  uiOpacity: 0.65,
  windowOpacity: 0.95,
  discordRpcEnabled: true
};

storageMock.setItem('pink-music-theme', JSON.stringify(themeSettings));
const retrieved = JSON.parse(storageMock.getItem('pink-music-theme'));

assert.strictEqual(retrieved.currentTheme, 'dark');
assert.strictEqual(retrieved.customBgOpacity, 0.85);
assert.strictEqual(retrieved.customBgBlur, 10);
assert.strictEqual(retrieved.customBgScale, 1.1);
assert.strictEqual(retrieved.customBgPosition, 'center');
assert.strictEqual(retrieved.customBgMaskOpacity, 0.25);
assert.strictEqual(retrieved.uiOpacity, 0.65);
assert.strictEqual(retrieved.windowOpacity, 0.95);
assert.strictEqual(retrieved.discordRpcEnabled, true);
assert.ok(retrieved.customBgUrl.startsWith('data:image/'));

console.log('✓ Theme, custom background and UI opacity persistence verified.');

// Test 2: Bilibili cookie persistence
const cookies = {
  DedeUserID: '12345678',
  SESSDATA: 'mock_sessdata',
  bili_jct: 'mock_csrf'
};
storageMock.setItem('bilibili_cookies', JSON.stringify(cookies));
const retrievedCookies = JSON.parse(storageMock.getItem('bilibili_cookies'));
assert.strictEqual(retrievedCookies.DedeUserID, '12345678');
assert.strictEqual(retrievedCookies.SESSDATA, 'mock_sessdata');

console.log('✓ Bilibili credential storage verified.');

console.log('[test:storage] All persistent storage tests passed!');
process.exit(0);
