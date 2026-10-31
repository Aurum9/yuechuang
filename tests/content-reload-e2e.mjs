import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { startFixtures } from './fixtures/server.mjs';

// Isolated browser fixture: emulate the documented stale-context API failure.
// Production content source is bundled in memory; dist and the user's Chrome
// profile are never changed. No extension reload or real model call occurs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'test-results', 'content-reload');
await fs.mkdir(output, { recursive: true });
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  for (const entry of ['.cache/ms-playwright', '.browsers']) {
    const candidate = path.join(root, entry);
    try { if ((await fs.readdir(candidate)).some(name => name.startsWith('chromium-'))) { process.env.PLAYWRIGHT_BROWSERS_PATH = candidate; break; } } catch {}
  }
}
const { chromium } = await import('playwright');
const built = await build({ root, configFile: false, publicDir: false, logLevel: 'error', build: {
  write: false, minify: false,
  lib: { entry: path.join(root, 'src/content.ts'), formats: ['iife'], name: 'ReadingAssistant' },
  rollupOptions: { output: { inlineDynamicImports: true } },
} });
const bundle = (Array.isArray(built) ? built.flatMap(item => item.output) : built.output).find(item => item.type === 'chunk').code;
const fixtures = await startFixtures({ port: 0 });
const report = { date: new Date().toISOString(), mockOnly: true, actualExtensionReloadVerified: false, sourceBundledInMemory: true, distModified: false, checks: [], unexpectedNetwork: [] };
let browser;
async function check(name, operation) {
  await operation();
  report.checks.push({ name, result: 'pass' });
  process.stdout.write(`PASS ${name}\n`);
}
try {
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.route('**/*', route => {
    if (route.request().url().startsWith(fixtures.origin + '/')) return route.continue();
    report.unexpectedNetwork.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(() => {
    const mock = globalThis.__readerReload = {
      failure: '', messages: [], ports: [], errors: [], backgroundListeners: [],
      invalidate(mode) { this.failure = mode; for (const port of [...this.ports]) port.break(); },
    };
    addEventListener('error', event => mock.errors.push(event.message));
    addEventListener('unhandledrejection', event => mock.errors.push(String(event.reason?.message || event.reason)));
    const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    globalThis.chrome = { runtime: {
      id, getURL: value => 'chrome-extension://' + id + '/' + value,
      get lastError() { if (mock.failure === 'lastError') throw new Error('Extension context invalidated.'); return undefined; },
      onMessage: { addListener(listener) { mock.backgroundListeners.push(listener); } },
      sendMessage(message) {
        mock.messages.push(message);
        if (mock.failure === 'sync') throw new Error('Extension context invalidated.');
        if (mock.failure === 'async') return Promise.reject(new Error('Extension context invalidated.'));
        if (message.type === 'context:selection-eligible' || message.type === 'page:hello') return Promise.resolve({ ok: true, enabled: true });
        if (message.type === 'preview:open') return Promise.resolve({ ok: true, preview: { id: 'reload-preview', url: message.url } });
        return Promise.resolve({ ok: true });
      },
      connect() {
        const listeners = [];
        const port = {
          onMessage: { addListener() {} }, onDisconnect: { addListener(listener) { listeners.push(listener); } },
          postMessage() { if (mock.failure) throw new Error('Extension context invalidated.'); },
          disconnect() {}, break() { listeners.forEach(listener => listener()); },
        };
        mock.ports.push(port); return port;
      },
    } };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  async function fresh() {
    pageErrors.length = 0;
    await page.goto(fixtures.origin + '/context-tech');
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => __readerReload.messages.some(message => message.type === 'context:selection-eligible'));
  }
  async function selectToolbar() {
    await page.locator('#term-a').scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = await page.locator('#term-a').boundingBox(); assert.ok(box);
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('local-reader-selection-toolbar').waitFor({ state: 'visible' });
  }
  async function assertNoErrors() {
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => __readerReload.errors), []);
    assert.deepEqual(pageErrors, []);
  }
  async function openPreview() {
    const link = page.locator('#ctx-drag-link'); await link.scrollIntoViewIfNeeded();
    const box = await link.boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + 25, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + 110, box.y + box.height / 2 + 25, { steps: 14 });
    await page.locator('local-reader-preview iframe').waitFor(); await page.mouse.up();
  }
  await check('fixture exposes synchronous retired-context failure before a Promise is returned', async () => {
    await fresh();
    const error = await page.evaluate(() => {
      __readerReload.failure = 'sync';
      try { void chrome.runtime.sendMessage({ type: 'probe' }).catch(() => {}); return ''; }
      catch (error) { return error.message; }
    });
    assert.equal(error, 'Extension context invalidated.');
  });
  for (const mode of ['sync', 'async']) {
    await check(`active selection toolbar cleans up on scroll after ${mode} runtime failure`, async () => {
      await fresh(); await selectToolbar();
      await page.evaluate(mode => __readerReload.invalidate(mode), mode);
      await page.mouse.wheel(0, 180);
      await page.locator('local-reader-selection-toolbar').waitFor({ state: 'detached' });
      assert.ok(await page.evaluate(() => __readerReload.messages.some(message => message.type === 'context:selection-dismiss')));
      await assertNoErrors();
    });
    await check(`navigation eligibility and keyboard selection tolerate ${mode} runtime failure`, async () => {
      await fresh(); await selectToolbar();
      await page.evaluate(mode => { __readerReload.invalidate(mode); history.pushState({}, '', '#retired'); dispatchEvent(new PopStateEvent('popstate')); }, mode);
      await page.locator('local-reader-selection-toolbar').waitFor({ state: 'detached' });
      await page.keyboard.press('Control+Shift+ArrowRight');
      await assertNoErrors();
    });
    await check(`disconnected preview settings, open-tab and close tolerate ${mode} runtime failure`, async () => {
      await fresh(); await openPreview();
      await page.evaluate(mode => __readerReload.invalidate(mode), mode);
      await page.locator('local-reader-preview [data-reader-action="settings"]').click();
      await page.locator('local-reader-preview .status').filter({ hasText: '无法打开设置' }).waitFor();
      await page.locator('local-reader-preview [data-reader-action="open-tab"]').click();
      await page.locator('local-reader-preview [data-reader-action="close"]').click();
      await page.locator('local-reader-preview').waitFor({ state: 'detached' });
      await assertNoErrors();
    });
  }
  await check('context answer disconnect completes local cleanup when lastError getter throws', async () => {
    await fresh(); await selectToolbar();
    const result = await page.evaluate(() => {
      const captureId = document.querySelector('local-reader-selection-toolbar').dataset.captureId;
      let result;
      const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('background.js') };
      for (const listener of __readerReload.backgroundListeners) listener({ type: 'context:show', requestId: 'getter-test', captureId, mode: 'translate', selectionText: 'coherence', expanded: false }, sender, value => { result = value; });
      return result;
    });
    assert.deepEqual(result, { ok: true });
    await page.locator('local-reader-context .status[data-phase="reading"]').waitFor();
    await page.evaluate(() => __readerReload.invalidate('lastError'));
    await page.locator('local-reader-context .status[data-phase="interrupted"]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('local-reader-context').waitFor({ state: 'detached' });
    await assertNoErrors();
  });
  await check('link preview disconnect interrupts and closes when lastError getter throws', async () => {
    await fresh(); await openPreview();
    await page.evaluate(() => __readerReload.invalidate('lastError'));
    await page.locator('local-reader-preview .status[data-phase="interrupted"]').waitFor();
    await page.locator('local-reader-preview [data-reader-action="close"]').click();
    await page.locator('local-reader-preview').waitFor({ state: 'detached' });
    await assertNoErrors();
  });
  assert.equal(fixtures.getStats().totalRequestsSinceStart, 0);
  assert.deepEqual(report.unexpectedNetwork, []);
  report.passed = report.checks.length;
} catch (error) {
  report.error = error.message; process.exitCode = 1;
} finally {
  await browser?.close(); await fixtures.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
if (report.error) throw new Error(report.error);
process.stdout.write(`Content reload mock regression: ${report.passed} passed. No actual extension reload or real account/model requests.\n`);
