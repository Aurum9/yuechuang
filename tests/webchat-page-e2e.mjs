import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:https';
import { spawnSync } from 'node:child_process';
import { hashDirectory, buildFingerprint } from '../scripts/artifact-hashes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'test-results');
const dist = path.join(root, 'dist');
const manifestText = await fs.readFile(path.join(dist, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText), version = manifest.version;
const html = await fs.readFile(path.join(root, 'tests/fixtures/chatgpt-page.html'), 'utf8');
const screenshots = path.join(output, `webchat-page-${version}`);
await fs.mkdir(screenshots, { recursive: true });
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) for (const candidate of ['.cache/ms-playwright', '.browsers']) {
  try { if ((await fs.readdir(path.join(root, candidate))).some(name => name.startsWith('chromium-'))) { process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, candidate); break; } } catch {}
}
const { chromium } = await import('playwright');
const testedFiles = await hashDirectory(dist);
const profile = await fs.mkdtemp(path.join(output, `webchat-page-${version}-profile-`));
const extension = path.join(profile, 'test-extension');
const network = [], unexpected = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let context, worker, extensionId, shell, settings, personal, dedicated, fatal, fixtureServer;
const report = {
  extensionVersion: version, date: new Date().toISOString(), mockOnly: true, realAccountVerified: false, realModelVerified: false,
  checks: [], network, testedBuild: { fingerprint: buildFingerprint(testedFiles), files: testedFiles, unchangedAfterTest: false },
  testHarness: { productionWorkerWithoutTestEntry: true, productionSourceModified: false, testCopyRestored: false,
    trustedShellFormsAndButtonClicks: true, nativeActionClickVerified: false, nativeSidePanelSurfaceVerified: false,
    permissionBootstrap: 'Temporary test-copy manifest grants only chatgpt.com; exact production bytes are restored and Chrome reloads the extension before all feature checks.',
    networkMock: 'A loopback-only HTTPS fixture server answers chatgpt.com via isolated-browser host-resolver rules, including inactive extension-created tabs. Other DNS is blocked. A temporary self-signed test certificate is trusted only by this isolated Chromium launch. No real account, login credentials or private API response is used.' },
  notes: ['Tests exercise production settings, chat UI, background worker and isolated content bridge against a local webpage fixture.',
    'These checks verify DOM ownership, lifecycle and absence of private endpoint requests, and do not prove current live ChatGPT DOM compatibility or account entitlements.']
};
async function until(predicate, description, timeout = 18000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    await sleep(70);
  }
  throw new Error(description + (last ? `: ${last.message}` : ''));
}
async function check(name, operation) {
  const start = Date.now();
  try {
    const evidence = await operation();
    report.checks.push({ name, result: 'pass', milliseconds: Date.now() - start, ...(evidence ? { evidence } : {}) });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.checks.push({ name, result: 'fail', milliseconds: Date.now() - start, error: error.message });
    if (shell && !shell.isClosed()) await shell.screenshot({ path: path.join(screenshots, `failure-${report.checks.length}.png`), fullPage: true }).catch(() => {});
    throw error;
  }
}
function chatPages() { return context.pages().filter(page => page !== personal && page.url().startsWith('https://chatgpt.com/')); }
async function fixtureState(page) { return page.evaluate(() => ({ ...window.fixture, editor: document.querySelector('[role="textbox"]')?.innerText })); }
async function select(tab) {
  await shell.locator(`#tab-${tab}`).click();
  if (tab === 'chat') return shell;
  settings = await until(async () => (await shell.locator('#frame-settings').elementHandle())?.contentFrame(), 'settings frame missing');
  await until(() => settings.locator('#save-connection').isEnabled(), 'settings form unavailable');
  return settings;
}
async function view() {
  const result = await settings.evaluate(() => chrome.runtime.sendMessage({ type: 'webchat:view' }));
  assert.equal(result.ok, true, result.error); return result.view;
}
async function openOwned() {
  const previous = new Set(context.pages());
  await settings.locator('#webchat-open').click();
  await until(() => settings.locator('#webchat-open').isEnabled(), 'open official control remained busy');
  const added = await until(() => chatPages().find(page => !previous.has(page)), 'dedicated ChatGPT page not created');
  await added.waitForLoadState('domcontentloaded');
  return added;
}
async function refresh() {
  await settings.locator('#webchat-refresh').click();
  await until(() => settings.locator('#webchat-refresh').isEnabled(), 'page check did not finish');
  return view();
}
const assistant = () => shell.locator('.chat-message[data-role="assistant"]');
async function begin(text) {
  await select('chat');
  const count = await assistant().count();
  await shell.locator('#chat-input').fill(text);
  await until(() => shell.locator('#chat-send').isEnabled(), `chat send unavailable: ${text}`);
  await shell.locator('#chat-send').click();
  await until(async () => await assistant().count() > count, 'new answer row missing');
}
async function finish(status = 'done') {
  const actual = await until(async () => {
    const value = await assistant().last().getAttribute('data-status');
    return ['done', 'error', 'cancelled'].includes(value) ? value : undefined;
  }, `answer did not finish as ${status}`);
  assert.equal(actual, status, `expected ${status}, received ${actual}: ${await shell.locator('#chat-feedback').innerText()}`);
  await until(() => shell.locator('#chat-stop').isHidden(), 'chat remained running');
}
async function send(text, status = 'done') { await begin(text); await finish(status); }
async function clear() {
  await select('chat'); await shell.locator('#chat-new').click();
  await shell.locator('#chat-clear-dialog').waitFor({ state: 'visible' });
  assert.match(await shell.locator('#chat-clear-description').innerText(), /OpenAI.*历史.*保留/);
  await shell.locator('#chat-clear-confirm').click();
  await until(async () => await shell.locator('.chat-message').count() === 0, 'local history not cleared');
}
function validateCleanup(directory) {
  const actual = path.resolve(directory), allowed = path.resolve(output);
  assert.ok(actual !== allowed && actual.startsWith(allowed + path.sep), 'refusing cleanup outside test-results');
}
try {
  const keyPath = path.join(profile, 'fixture-key.pem'), certPath = path.join(profile, 'fixture-cert.pem'), configPath = path.join(profile, 'fixture-openssl.cnf');
  await fs.writeFile(configPath, '[req]\ndistinguished_name = subject\nprompt = no\n[subject]\nCN = chatgpt.com\n');
  const certificate = spawnSync(process.env.OPENSSL_BIN || 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', configPath, '-subj', '/CN=chatgpt.com', '-addext', 'subjectAltName=DNS:chatgpt.com,IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { encoding: 'utf8', windowsHide: true });
  assert.equal(certificate.status, 0, `Cannot generate local test certificate: ${certificate.error?.message || certificate.stderr}`);
  fixtureServer = createServer({ key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) }, (request, response) => {
    const url = new URL(request.url, 'https://chatgpt.com');
    network.push({ method: request.method, path: url.origin + url.pathname, mocked: true, transport: 'loopback-https' });
    if (request.method === 'GET' && (url.pathname === '/' || /^\/c\/[\w-]+$/.test(url.pathname))) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(html); }
    else if (request.method === 'GET' && url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); }
    else { unexpected.push({ method: request.method, path: url.origin + url.pathname }); response.writeHead(403); response.end('Local fixture blocks this path'); }
  });
  await new Promise((resolve, reject) => { fixtureServer.once('error', reject); fixtureServer.listen(0, '127.0.0.1', resolve); });
  const address = fixtureServer.address();
  assert.ok(address && typeof address !== 'string');
  report.testHarness.loopbackFixture = { hostname: 'chatgpt.com', ip: '127.0.0.1', port: address.port, realDnsBlocked: true };
  await fs.cp(dist, extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, host_permissions: ['https://chatgpt.com/*'] }));
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--no-proxy-server', '--ignore-certificate-errors', `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${address.port}, MAP * ~NOTFOUND, EXCLUDE localhost`] });
  context.setDefaultTimeout(8000);
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  report.browser = context.browser().version();
  await fs.writeFile(manifestPath, manifestText);
  const extensionsPage = await context.newPage(); await extensionsPage.goto('chrome://extensions');
  await extensionsPage.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await extensionsPage.evaluate(id => { void chrome.developerPrivate.reload(id); }, extensionId);
  worker = await until(async () => {
    for (const candidate of context.serviceWorkers()) try {
      if (new URL(candidate.url()).hostname === extensionId && await candidate.evaluate(() => chrome.runtime.getManifest().host_permissions === undefined)) return candidate;
    } catch {}
  }, 'production worker did not reload');
  await extensionsPage.close();
  assert.deepEqual(await hashDirectory(extension), testedFiles); report.testHarness.testCopyRestored = true;
  shell = await context.newPage(); await shell.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await until(async () => !(await shell.locator('#chat-status').innerText()).includes('正在连接'), 'chat did not initialize');

  await check('real shell settings select independent page transport without sending or fetching private endpoints', async () => {
    await select('settings'); assert.equal(await settings.locator('#connection-api').isChecked(), true);
    await settings.locator('#connection-web').check(); await settings.locator('#webchat-transport').selectOption('page');
    assert.equal(await settings.locator('#webchat-page-model').isVisible(), true);
    await settings.locator('#save-connection').click();
    await until(async () => (await view()).config.transport === 'page', 'page transport not saved');
    assert.deepEqual((await view()).config, { provider: 'chatgptWeb', model: 'follow-page', transport: 'page' });
    assert.equal(network.length, 0); assert.equal(chatPages().length, 0);
    return { apiKeyRequired: false, mode: 'page', model: 'follow-page', automaticNetworkRequests: 0 };
  });
  await check('the trusted open button creates an owned page and leaves the user existing conversation and draft untouched', async () => {
    personal = await context.newPage(); await personal.goto('https://chatgpt.com/c/personal-chat');
    await personal.locator('[role="textbox"]').fill('用户正在写的私人草稿');
    dedicated = await openOwned();
    assert.notEqual(dedicated, personal); assert.equal(dedicated.url(), 'https://chatgpt.com/');
    const result = await refresh(); assert.equal(result.status.state, 'ready'); assert.equal(result.status.generation, 'unchecked');
    assert.deepEqual(result.status.models, [{ id: 'follow-page', label: '跟随官网当前模型' }]);
    assert.equal((await fixtureState(personal)).editor, '用户正在写的私人草稿'); assert.equal(personal.url(), 'https://chatgpt.com/c/personal-chat');
    return { dedicatedPageCreated: true, personalPageSelected: false, readinessDoesNotClaimGeneration: true };
  });
  await check('sidepanel sends and streams two turns through one owned webpage conversation', async () => {
    await send('第一轮：解释网页发送。'); await send('第二轮：继续说明。');
    const state = await fixtureState(dedicated);
    assert.deepEqual(state.sends, ['第一轮：解释网页发送。', '第二轮：继续说明。']);
    assert.match(dedicated.url(), /^https:\/\/chatgpt\.com\/c\/fixture-/);
    assert.equal(chatPages().length, 1);
    assert.match(await assistant().last().innerText(), /网页回答/); assert.equal(await assistant().last().locator('strong').innerText(), '网页回答');
    assert.equal((await view()).status.generation, 'working');
    return { sends: 2, sameOwnedPage: true, sameConversation: true, markdownRendered: true, privateRequests: 0 };
  });
  await check('clearing local history preserves the completed OpenAI page and starts a fresh owned page automatically', async () => {
    const previous = dedicated, previousURL = previous.url(), before = new Set(chatPages());
    await clear(); await send('新话题：新的对话。');
    dedicated = await until(() => chatPages().find(page => !before.has(page)), 'new chat did not allocate a fresh page');
    assert.notEqual(dedicated.url(), previousURL); assert.equal(previous.url(), previousURL);
    assert.equal((await fixtureState(previous)).sends.length, 2); assert.equal((await fixtureState(dedicated)).sends.length, 1);
    return { previousHistoryPreserved: true, freshOwnedPage: true, remoteDeleteRequests: 0 };
  });
  await check('the sidepanel stop control stops only the positively owned active webpage turn', async () => {
    await dedicated.evaluate(() => { window.fixture.mode = 'hang'; });
    await begin('停止这一轮测试。');
    await until(async () => await dedicated.locator('button[aria-label="停止"]').isVisible() && await assistant().last().getAttribute('data-status') === 'running', 'owned turn did not start');
    await shell.locator('#chat-stop').click(); await finish('cancelled');
    await until(async () => (await fixtureState(dedicated)).stops === 1, 'owned webpage did not receive exactly one stop');
    assert.equal((await fixtureState(personal)).stops, 0); assert.equal((await fixtureState(dedicated)).sends.length, 2);
    return { ownedStopClicks: 1, personalStopClicks: 0, repeatedSendClicks: 0 };
  });
  await check('a dedicated webpage user draft is preserved and rejects a conflicting sidepanel send', async () => {
    const before = new Set(chatPages()); await send('取消后重新正常发送。');
    dedicated = await until(() => chatPages().find(page => !before.has(page)), 'cancel recovery did not create fresh owned page');
    await dedicated.locator('[role="textbox"]').fill('这段官网草稿必须保留');
    const old = (await fixtureState(dedicated)).sends.length;
    await send('不应覆盖官网草稿。', 'error');
    assert.equal((await fixtureState(dedicated)).editor, '这段官网草稿必须保留'); assert.equal((await fixtureState(dedicated)).sends.length, old);
    assert.match(await shell.locator('#chat-feedback').innerText(), /草稿|附件|正在生成/);
    return { draftPreserved: true, sendClicksWhileDraftPresent: 0, userActionRequired: true };
  });
  await check('closing an owned page allows the next manual sidepanel send to recover with a fresh background page', async () => {
    await select('settings'); const closing = await openOwned(); await refresh(); await closing.close();
    const before = new Set(chatPages()); await send('关闭专用页后继续。');
    dedicated = await until(() => chatPages().find(page => !before.has(page)), 'closed-page recovery did not create another page');
    assert.equal((await fixtureState(dedicated)).sends.length, 1);
    assert.equal((await fixtureState(personal)).editor, '用户正在写的私人草稿'); assert.equal((await fixtureState(personal)).sends.length, 0);
    return { manualSendRecovered: true, personalTabUntouched: true, privateApiFallback: false };
  });
  await check('page mode settings and chat fit 390 and 320 pixels without horizontal overflow', async () => {
    for (const width of [390, 320]) {
      await shell.setViewportSize({ width, height: 900 });
      for (const tab of ['settings', 'chat']) {
        const frame = await select(tab); await sleep(100);
        assert.equal(await shell.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        await shell.screenshot({ path: path.join(screenshots, `${tab}-${width}.png`), fullPage: true });
      }
    }
    return { widths: [390, 320], horizontalOverflow: false };
  });
  await check('DOM transport never requests session, models or private conversation endpoints and preserves exact production bytes', async () => {
    assert.deepEqual(unexpected, []); assert.ok(network.every(request => request.method === 'GET' && !/\/(api|backend-api)\//.test(request.path)));
    assert.equal((await fixtureState(personal)).editor, '用户正在写的私人草稿'); assert.equal((await fixtureState(personal)).sends.length, 0);
    assert.deepEqual(await hashDirectory(dist), testedFiles); assert.deepEqual(await hashDirectory(extension), testedFiles);
    return { liveAccountRequests: 0, sessionRequests: 0, modelRequests: 0, privateConversationRequests: 0, personalTabUntouched: true, productionBytesUnchanged: true };
  });
} catch (error) {
  fatal = error; report.fatal = error.message;
  report.failureEvidence = {
    view: settings ? await view().catch(() => undefined) : undefined,
    feedback: shell && !shell.isClosed() ? await shell.locator('#chat-feedback').innerText().catch(() => '') : '',
    pageFixtures: context ? await Promise.all(chatPages().map(async page => ({ url: page.url(), fixture: await fixtureState(page).catch(() => undefined) }))) : [],
    owned: shell && !shell.isClosed() ? await shell.evaluate(async () => (await chrome.storage.session.get('webChatOwnedPage')).webChatOwnedPage).catch(() => undefined) : undefined
  };
  process.stdout.write(`FATAL ${error.message}\n${JSON.stringify(report.failureEvidence)}\n`);
}
finally {
  if (context) await context.close().catch(() => {});
  if (fixtureServer) { fixtureServer.closeAllConnections(); await new Promise(resolve => fixtureServer.close(resolve)); }
  report.testedBuild.unchangedAfterTest = JSON.stringify(await hashDirectory(dist)) === JSON.stringify(testedFiles);
  if (!report.testedBuild.unchangedAfterTest) { report.fatal = 'Production dist changed during webpage test'; fatal ??= new Error(report.fatal); }
  report.passed = report.checks.filter(check => check.result === 'pass').length;
  report.failed = report.checks.filter(check => check.result === 'fail').length;
  const passed = text => report.checks.some(check => check.result === 'pass' && check.name.includes(text));
  report.coverage = { domOnlyNoPrivateRequests: passed('DOM transport never'), backgroundOwnedTab: passed('trusted open button'), realShellControls: passed('real shell settings') && passed('sidepanel sends'),
    remoteMultiTurn: passed('sidepanel sends'), clearStartsFreshPage: passed('clearing local history'), draftPreserved: passed('user draft'), stopOwnedTurn: passed('sidepanel stop control'),
    closedPageRecovery: passed('closing an owned page'), otherTabsUntouched: passed('DOM transport never') && passed('trusted open button'), narrow390And320: passed('fit 390 and 320'),
    productionBytesUnchanged: passed('exact production bytes') && report.testedBuild.unchangedAfterTest };
  report.screenshots = (await fs.readdir(screenshots)).filter(name => /^(chat|settings)-(320|390)\.png$/.test(name)).map(name => `test-results/webchat-page-${version}/${name}`);
  await fs.writeFile(path.join(output, `webchat-page-e2e-report-${version}.json`), JSON.stringify(report, null, 2) + '\n');
  validateCleanup(profile); await fs.rm(profile, { recursive: true, force: true });
  process.stdout.write(`Mock webpage ${version} e2e: ${report.passed} passed, ${report.failed} failed. Live account compatibility remains unverified.\n`);
  if (fatal || report.failed) process.exitCode = 1;
}
