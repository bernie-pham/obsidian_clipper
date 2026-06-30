// tests/fixtures.js
// Provides a `sidebarPage` fixture that opens the sidebar HTML as a file:// page
// in a Chromium instance with the extension loaded.

import { test as base, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');

export const test = base.extend({
  // One browser context per worker with the extension loaded
  extContext: [
    async ({}, use) => {
      const ctx = await chromium.launchPersistentContext('', {
        headless: false,
        args: [
          `--disable-extensions-except=${extensionRoot}`,
          `--load-extension=${extensionRoot}`,
          '--no-sandbox',
        ],
        viewport: { width: 400, height: 700 },
      });
      await use(ctx);
      await ctx.close();
    },
    { scope: 'worker' },
  ],

  // Opens the sidebar HTML as a local file with chrome.* APIs stubbed
  sidebarPage: async ({ extContext }, use) => {
    const sidebarPath = path.join(extensionRoot, 'sidebar', 'index.html');
    const page = await extContext.newPage();

    // Stub chrome.* APIs before the page script runs
    await page.addInitScript(() => {
      const storage = { _data: {} };

      window.chrome = {
        storage: {
          local: {
            get(keys, cb) {
              const result = {};
              const keyList = typeof keys === 'string' ? [keys] : Object.keys(keys);
              keyList.forEach(k => { result[k] = storage._data[k]; });
              if (cb) cb(result);
            },
            set(data, cb) {
              Object.assign(storage._data, data);
              if (cb) cb();
            },
          },
        },
        runtime: {
          onMessage: { addListener() {} },
          lastError: null,
          sendMessage(msg, cb) {
            // Default stub — returns error; individual tests override via page.evaluate
            if (cb) setTimeout(() => cb({ error: 'Extension runtime not available in test' }), 0);
          },
        },
        tabs: {
          create(opts) { window.__lastTabCreate = opts; },
        },
        contextMenus: { create() {} },
        sidePanel: { setPanelBehavior() {}, open() {} },
      };
    });

    await page.goto(`file://${sidebarPath}`);
    // Wait for init() to complete — it sets data-app-ready when all setup is done
    await page.waitForSelector('[data-app-ready]', { timeout: 10_000 });

    await use(page);
    await page.close();
  },
});

export { expect } from '@playwright/test';
