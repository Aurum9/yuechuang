import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtures } from './fixtures/server.mjs';
import { hashDirectory, buildFingerprint } from '../scripts/artifact-hashes.mjs';

// A real MV3 reload in a throwaway Chromium profile using production bytes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(root, process.env.CONTENT_EXTENSION_DIST || 'dist');
const files = await hashDirectory(directory);
const productionManifest = await fs.readFile(path.join(directory, 'manifest.json'), 'utf8');
const manifest = JSON.parse(productionManifest);
const bootstrapLoopback = !manifest.host_permissions?.length;
const expectFailure = process.env.CONTENT_EXPECT_INVALIDATED === '1';
const baseline = process.env.CONTENT_EXTENSION_BASELINE === '1' || expectFailure;
const output = path.join(root, 'test-results', 'content-extension-reload');
await fs.mkdir(output, { recursive: true });
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  for (const entry of ['.cache/ms-playwright', '.browsers']) {
    const candidate = path.join(root, entry);
    try { if ((await fs.readdir(candidate)).some(name => name.startsWith('chromium-'))) { process.env.PLAYWRIGHT_BROWSERS_PATH = candidate; break; } } catch {}
  }
}
const { chromium } = await import('playwright');
const fixtures = await startFixtures({ port: 0 });
const profile = await fs.mkdtemp(path.join(output, 'isolated-profile-'));
const testExtension = path.join(profile, 'test-extension');
const assertProfile = value => { const resolved = path.resolve(value); assert.ok(resolved.startsWith(output + path.sep) && resolved !== output, 'refusing to mutate outside test-results/content-extension-reload'); };
assertProfile(profile); assertProfile(testExtension);
const report = { date: new Date().toISOString(), version: manifest.version, mockOnly: true, actualExtensionReloadVerified: false, realAccountVerified: false, realModelVerified: false,
  baseline, expectedBaselineFailure: expectFailure, baselineFailureReproduced: false, actualRetiredContextVerified: false, checks: [], exceptions: [], pageErrors: [], network: [], unexpectedNetwork: [], nativeProbe: [],
  testedBuild: { fingerprint: buildFingerprint(files), testCopyRestored: false, unchangedAfterTest: false },
  notes: ['Real packaged content script and MV3 service worker. No runtime API mocks and no real account, helper or model invocation.', 'The isolated fixture allows only 127.0.0.1 traffic. All HTTP(S) traffic outside the loopback fixture is aborted.', 'The reload is chrome.runtime.reload() called in this test extension worker; no user Chrome profile is opened.'] };
let context, worker, extensionId;
const sessions = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message, timeout = 14000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await sleep(65);
  }
  throw new Error(message + (last ? ': ' + last.message : ''));
}
async function check(name, action) {
  await action(); report.checks.push({ name, result: 'pass' }); process.stdout.write(`PASS ${name}\n`);
}
async function liveWorker() {
  return until(async () => {
    for (const candidate of context.serviceWorkers()) {
      if (new URL(candidate.url()).hostname !== extensionId) continue;
      try {
        const ready = await candidate.evaluate(({ version, hosts }) => {
          const loaded = chrome.runtime.getManifest();
          return loaded.version === version && JSON.stringify(loaded.host_permissions) === hosts && globalThis.__retiringReloadProbe === undefined;
        }, { version: manifest.version, hosts: JSON.stringify(manifest.host_permissions) });
        if (ready) return candidate;
      } catch {}
    }
  }, 'reloaded production worker unavailable');
}
async function sourcePage(label) {
  const page = await context.newPage();
  const session = await context.newCDPSession(page), contexts = new Map();
  session.on('Runtime.executionContextCreated', event => contexts.set(event.context.id, event.context));
  session.on('Runtime.executionContextDestroyed', event => contexts.delete(event.executionContextId));
  session.on('Runtime.exceptionThrown', ({ exceptionDetails: detail }) => {
    report.exceptions.push({ label, text: detail.exception?.description?.slice(0, 2500) || detail.text, url: detail.url || detail.stackTrace?.callFrames[0]?.url || '', line: detail.lineNumber, contextId: detail.executionContextId });
  });
  page.on('pageerror', error => report.pageErrors.push({ label, message: error.message }));
  await session.send('Runtime.enable');
  sessions.push({ label, session, contexts });
  await page.goto(fixtures.origin + '/context-tech');
  await page.locator('#term-a').waitFor();
  await sleep(250);
  return page;
}
async function selectToolbar(page) {
  await page.bringToFront(); await page.locator('#term-a').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await page.locator('#term-a').boundingBox(); assert.ok(box);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('local-reader-selection-toolbar').waitFor({ state: 'visible' });
}
try {
  await fs.cp(directory, testExtension, { recursive: true });
  const manifestPath = path.join(testExtension, 'manifest.json');
  if (bootstrapLoopback) await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }));
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${testExtension}`, `--load-extension=${testExtension}`, '--no-first-run'] });
  context.setDefaultTimeout(6500);
  await context.route(/^https?:\/\//, route => {
    const url = route.request().url(); report.network.push(url);
    if (url.startsWith(fixtures.origin + '/')) return route.continue();
    report.unexpectedNetwork.push(url); return route.abort();
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  const settings = await context.newPage(); await settings.goto('chrome://extensions');
  await settings.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  if (bootstrapLoopback) {
    await fs.writeFile(manifestPath, productionManifest);
    await settings.evaluate(id => { void chrome.developerPrivate.reload(id); }, extensionId);
    worker = await liveWorker();
  }
  await settings.close();
  assert.deepEqual(await hashDirectory(testExtension), files);
  report.testedBuild.testCopyRestored = true;
  const granted = await worker.evaluate(() => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] }));
  assert.equal(granted, true, 'loopback permission is unavailable');
  const toolbar = await sourcePage('toolbar');
  const answer = await sourcePage('context-port');
  await selectToolbar(answer);
  await answer.locator('local-reader-selection-toolbar [data-selection-action="explain"]').click();
  await answer.locator('local-reader-context').waitFor({ state: 'visible' });
  const preview = await sourcePage('preview-port');
  await preview.bringToFront(); await preview.locator('#ctx-drag-link').scrollIntoViewIfNeeded();
  const link = await preview.locator('#ctx-drag-link').boundingBox(); assert.ok(link);
  await preview.mouse.move(link.x + 25, link.y + link.height / 2); await preview.mouse.down();
  await preview.mouse.move(link.x + 110, link.y + link.height / 2 + 25, { steps: 14 });
  await preview.locator('local-reader-preview iframe').waitFor(); await preview.mouse.up();
  await until(async () => await preview.locator('local-reader-preview .page-status').getAttribute('data-state') === 'ready', 'actual preview iframe did not become readable');
  await selectToolbar(toolbar);
  await check('real production content creates a selection toolbar and two live extension Ports without a model request', async () => {
    assert.equal(await toolbar.locator('local-reader-selection-toolbar').count(), 1);
    assert.equal(await answer.locator('local-reader-context').count(), 1);
    assert.equal(await preview.locator('local-reader-preview').count(), 1);
    assert.equal(fixtures.getStats().totalRequestsSinceStart, 0);
    assert.deepEqual(report.exceptions, []); assert.deepEqual(report.pageErrors, []);
  });
  await worker.evaluate(() => {
    // Chrome can reuse the DevTools target after the execution context is replaced.
    globalThis.__retiringReloadProbe = true;
    setTimeout(() => chrome.runtime.reload(), 0);
  });
  worker = await liveWorker();
  report.actualExtensionReloadVerified = true;
  await sleep(200);
  for (const { label, session, contexts } of sessions) {
    for (const context of contexts.values()) {
      if (!context.origin?.includes(extensionId) && !context.name?.includes(extensionId)) continue;
      try {
        const result = await session.send('Runtime.evaluate', { contextId: context.id, returnByValue: true, awaitPromise: true,
          expression: '(async () => { const result = {}; for (const key of ["id", "lastError"]) { try { result[key] = typeof chrome.runtime[key]; } catch (error) { result[key] = "throws: " + error.message; } } if (result.id === "undefined") { try { await chrome.runtime.sendMessage({ type: "reader:retired-context-probe" }); result.sendMessage = "resolved"; } catch (error) { result.sendMessage = "throws: " + error.message; } } return result; })()' });
        report.nativeProbe.push({ label, result: result.result.value });
      } catch { /* Chrome may have destroyed the exact retired context. */ }
    }
  }
  await check('a native retired content context rejects messaging after the actual reload', async () => {
    report.actualRetiredContextVerified = report.nativeProbe.some(item => /Extension context invalidated/i.test(item.result?.sendMessage || ''));
    assert.equal(report.actualRetiredContextVerified, true, 'no live retired content context was demonstrated');
  });
  await check('old source documents tolerate scroll, click, same-document navigation and Escape after a real extension reload', async () => {
    await toolbar.bringToFront(); await toolbar.mouse.wheel(0, 180); await toolbar.mouse.click(20, 20); await toolbar.keyboard.press('Escape');
    await toolbar.evaluate(() => { history.pushState({}, '', '#after-reload'); dispatchEvent(new PopStateEvent('popstate')); });
    await answer.bringToFront(); await answer.keyboard.press('Escape'); await answer.mouse.wheel(0, 120);
    await answer.evaluate(() => { history.pushState({}, '', '#after-reload'); dispatchEvent(new PopStateEvent('popstate')); });
    await preview.bringToFront();
    if (await preview.locator('local-reader-preview [data-reader-action="settings"]').isVisible()) await preview.locator('local-reader-preview [data-reader-action="settings"]').click();
    if (await preview.locator('local-reader-preview [data-reader-action="open-tab"]').isVisible()) await preview.locator('local-reader-preview [data-reader-action="open-tab"]').click();
    await preview.keyboard.press('Escape'); await preview.mouse.wheel(0, 120);
    await preview.evaluate(() => { history.pushState({}, '', '#after-reload'); dispatchEvent(new PopStateEvent('popstate')); });
    await sleep(550);
    assert.equal(fixtures.getStats().totalRequestsSinceStart, 0);
    assert.deepEqual(report.unexpectedNetwork, []);
  });
  await check(expectFailure ? 'baseline reproduces the native invalidated-context exception' : 'reload and all retired-content interactions emit no uncaught exception', async () => {
    const errors = [...report.exceptions.map(item => item.text), ...report.pageErrors.map(item => item.message)];
    report.baselineFailureReproduced = errors.some(message => /Extension context invalidated/i.test(message));
    if (expectFailure) assert.ok(errors.some(message => /Extension context invalidated/i.test(message)), 'expected baseline invalidated-context failure did not reproduce');
    else { assert.deepEqual(report.exceptions, []); assert.deepEqual(report.pageErrors, []); }
  });
  report.passed = report.checks.length;
} catch (error) {
  report.error = error.message; process.exitCode = 1; process.stderr.write(error.stack + '\n');
} finally {
  report.modelRequests = fixtures.getStats().totalRequestsSinceStart;
  await context?.close(); await fixtures.close();
  report.testedBuild.unchangedAfterTest = JSON.stringify(await hashDirectory(directory)) === JSON.stringify(files);
  const reportName = `${manifest.version}${baseline ? '-baseline' : ''}.json`;
  await fs.writeFile(path.join(output, reportName), JSON.stringify(report, null, 2) + '\n');
  assertProfile(profile); await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
