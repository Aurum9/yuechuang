import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:https';
import { spawnSync } from 'node:child_process';
import { hashDirectory, buildFingerprint } from '../scripts/artifact-hashes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'test-results'), dist = path.join(root, 'dist');
const manifestText = await fs.readFile(path.join(dist, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText), version = manifest.version;
assert.match(version, /^\d+\.\d+\.\d+$/, 'Run this production Webapp acceptance suite against a versioned build');
const [html, runtime] = await Promise.all([
  fs.readFile(path.join(root, 'tests/fixtures/chatgpt-webapp.html'), 'utf8'),
  fs.readFile(path.join(root, 'tests/fixtures/chatgpt-webapp-runtime.js'), 'utf8'),
]);
const fakeToken = 'fixture-session-secret-NOT-REAL', fakeRequirements = 'fixture-requirements-secret-NOT-REAL', fakeProof = 'fixture-proof-secret-NOT-REAL';
const forbidden = [fakeToken, fakeRequirements, fakeProof];
const screenshots = path.join(output, `webchat-webapp-${version}`);
await fs.mkdir(screenshots, { recursive: true });
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) for (const candidate of ['.cache/ms-playwright', '.browsers']) {
  try { if ((await fs.readdir(path.join(root, candidate))).some(name => name.startsWith('chromium-'))) { process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, candidate); break; } } catch {}
}
const { chromium } = await import('playwright');
const testedFiles = await hashDirectory(dist);
const profile = await fs.mkdtemp(path.join(output, `webchat-webapp-${version}-profile-`)), extension = path.join(profile, 'test-extension');
const network = [], unexpected = [], requests = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let context, worker, extensionId, shell, settings, personal, initialProxy, fatal, fixtureServer;
let mode = 'snapshot', remoteSerial = 0, abortedStreams = 0;
let personalDocumentId, personalNavigations = 0;
const report = {
  extensionVersion: version, date: new Date().toISOString(), mockOnly: true, realAccountVerified: false, realModelVerified: false,
  checks: [], network, testedBuild: { fingerprint: buildFingerprint(testedFiles), files: testedFiles, unchangedAfterTest: false },
  testHarness: { productionWorkerWithoutTestEntry: true, productionSourceModified: false, testCopyRestored: false,
    trustedShellFormsAndButtonClicks: true, nativeActionClickVerified: false, nativeSidePanelSurfaceVerified: false,
    permissionBootstrap: 'Temporary test-copy manifest grants only chatgpt.com; exact production bytes are restored and Chrome reloads before feature checks.',
    networkMock: 'Loopback-only HTTPS answers chatgpt.com through isolated Chromium host-resolver rules, including inactive extension-created tabs. Other DNS is blocked. The temporary test certificate is trusted only in this isolated launch. The publicly loaded runtime module is a synthetic local stub with fixed fake headers and no challenge algorithm. No real account or credential is used.' },
  notes: ['All actions use production settings forms and chat buttons, with production background, MAIN client bridge and stream parser.',
    'This suite proves offline wiring and lifecycle behavior; current live ChatGPT client compatibility and account entitlements remain unverified.'],
};
async function until(predicate, description, timeout = 18000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    await sleep(60);
  }
  throw new Error(description + (last ? `: ${last.message}` : ''));
}
async function check(name, operation) {
  const start = Date.now();
  try {
    const evidence = await operation(); report.checks.push({ name, result: 'pass', milliseconds: Date.now() - start, ...(evidence ? { evidence } : {}) });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.checks.push({ name, result: 'fail', milliseconds: Date.now() - start, error: error.message });
    if (shell && !shell.isClosed()) await shell.screenshot({ path: path.join(screenshots, `failure-${report.checks.length}.png`), fullPage: true }).catch(() => {});
    throw error;
  }
}
function chatPages() { return context.pages().filter(page => page.url().startsWith('https://chatgpt.com/')); }
async function proxyTabs() { return worker.evaluate(() => chrome.tabs.query({ url: ['https://chatgpt.com/*'] })); }
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
async function refresh() {
  await select('settings'); await settings.locator('#webchat-refresh').click();
  await until(() => settings.locator('#webchat-refresh').isEnabled(), 'account check remained busy');
  return view();
}
const assistant = () => shell.locator('.chat-message[data-role="assistant"]');
async function begin(text) {
  await select('chat'); const count = await assistant().count();
  await shell.locator('#chat-input').fill(text);
  await until(() => shell.locator('#chat-send').isEnabled(), `send unavailable: ${text}`);
  await shell.locator('#chat-send').click(); await until(async () => await assistant().count() > count, 'new answer row missing');
}
async function finish(status = 'done') {
  const actual = await until(async () => { const value = await assistant().last().getAttribute('data-status'); return ['done', 'error', 'cancelled'].includes(value) ? value : undefined; }, `answer did not finish as ${status}`);
  assert.equal(actual, status, `expected ${status}, received ${actual}: ${await shell.locator('#chat-feedback').innerText()}`);
  await until(() => shell.locator('#chat-stop').isHidden(), 'chat remained running');
}
async function send(text, status = 'done') { await begin(text); await finish(status); }
async function clear() {
  await select('chat'); await shell.locator('#chat-new').click(); await shell.locator('#chat-clear-dialog').waitFor({ state: 'visible' });
  assert.match(await shell.locator('#chat-clear-description').innerText(), /OpenAI.*历史.*保留/);
  await shell.locator('#chat-clear-confirm').click(); await until(async () => await shell.locator('.chat-message').count() === 0, 'local history not cleared');
}
async function assertDraft() {
  assert.equal(personal.url(), 'https://chatgpt.com/c/personal-chat');
  assert.equal(await personal.locator('#draft').inputValue(), '用户正在写的私人草稿');
  assert.equal(await personal.locator('[data-message-author-role]').count(), 0, 'HTTP proxy must not create chat DOM');
  const lifecycle = await personal.evaluate(() => ({
    documentId: window.__fixtureLongLivedPageState?.documentId,
    oldVersion: window.__readerNativeWebappBridge?.version,
    oldConfigurable: Object.getOwnPropertyDescriptor(window, '__readerNativeWebappBridge')?.configurable,
    oldCalls: window.__fixtureLongLivedPageState?.calls,
  }));
  assert.equal(lifecycle.documentId, personalDocumentId, 'ordinary document must not be reloaded to replace the old bridge');
  assert.equal(lifecycle.oldVersion, 'reader-native-v2'); assert.equal(lifecycle.oldConfigurable, false);
  assert.deepEqual(lifecycle.oldCalls, { start: 0, poll: 0, cancel: 0 }, 'the retired bridge must never be used');
  assert.equal(personalNavigations, 0, 'ordinary page must not navigate while checking or sending');
}
function noSecrets(value) { for (const token of forbidden) assert.ok(!JSON.stringify(value).includes(token), 'fake credential escaped its intended request-local boundary'); }
function redactEvidence(value) {
  let serialized = JSON.stringify(value);
  for (const token of forbidden) serialized = serialized.split(token).join('[REDACTED_FIXTURE_CREDENTIAL]');
  return JSON.parse(serialized);
}
function validateCleanup(directory) {
  const actual = path.resolve(directory), allowed = path.resolve(output);
  assert.ok(actual !== allowed && actual.startsWith(allowed + path.sep), 'refusing cleanup outside test-results');
}
function sse(value) { return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`; }
function answerRoot(id, conversation, text, complete = false) {
  return { conversation_id: conversation, message: { id, author: { role: 'assistant' }, channel: 'final', recipient: 'all',
    content: { content_type: 'text', parts: [text] }, status: complete ? 'finished_successfully' : 'in_progress', end_turn: complete } };
}
try {
  const keyPath = path.join(profile, 'fixture-key.pem'), certPath = path.join(profile, 'fixture-cert.pem'), configPath = path.join(profile, 'fixture-openssl.cnf');
  await fs.writeFile(configPath, '[req]\ndistinguished_name = subject\nprompt = no\n[subject]\nCN = chatgpt.com\n');
  const certificate = spawnSync(process.env.OPENSSL_BIN || 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', configPath, '-subj', '/CN=chatgpt.com', '-addext', 'subjectAltName=DNS:chatgpt.com,IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { encoding: 'utf8', windowsHide: true });
  assert.equal(certificate.status, 0, `Cannot generate local certificate: ${certificate.error?.message || certificate.stderr}`);
  fixtureServer = createServer({ key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) }, async (request, response) => {
    const url = new URL(request.url, 'https://chatgpt.com');
    const event = { method: request.method, path: url.origin + url.pathname, mocked: true, transport: 'loopback-https' }; network.push(event);
    const json = (value, status = 200) => { event.httpStatus = status; response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      if (request.method === 'GET' && (url.pathname === '/' || /^\/c\/[\w-]+$/.test(url.pathname))) {
        event.httpStatus = 200; response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(html); return;
      }
      if (request.method === 'GET' && url.pathname === '/cdn/assets/633146.1234567890.js') {
        event.httpStatus = 200; response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); response.end(runtime); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/session') {
        json({ user: { id: 'fixture-user', email: 'mock-webapp@example.test' }, account: { id: 'fixture-account' }, accessToken: fakeToken }); return;
      }
      if (request.method === 'GET' && url.pathname === '/backend-api/models') {
        assert.equal(request.headers.authorization, `Bearer ${fakeToken}`);
        json({ models: [{ slug: 'webapp-model', title: `Mock Webapp ${fakeToken}` }, { slug: 'webapp-second', title: 'Second available model' }] }); return;
      }
      if (request.method === 'POST' && url.pathname === '/backend-api/sentinel/chat-requirements/prepare') {
        let body = ''; for await (const chunk of request) body += chunk;
        assert.deepEqual(JSON.parse(body), { p: 'fixture-normal-client-key' });
        assert.equal(request.headers.authorization, `Bearer ${fakeToken}`); json({ fixture: true, force_login: false }); return;
      }
      if (request.method === 'POST' && url.pathname === '/backend-api/f/conversation') {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw), currentMode = mode;
        assert.equal(request.headers.authorization, `Bearer ${fakeToken}`);
        assert.equal(request.headers['openai-sentinel-chat-requirements-token'], fakeRequirements);
        assert.equal(request.headers['openai-sentinel-proof-token'], fakeProof);
        const serial = requests.length + 1;
        requests.push({ body, mode: currentMode, clientHeadersVerified: true });
        if (currentMode === '403') { json({ private_error: fakeToken, code: 'fixture-refusal', proof: fakeProof }, 403); return; }
        if (currentMode === '401') { json({ code: 'force_login' }, 401); return; }
        const conversation = body.conversation_id || `fixture-conversation-${++remoteSerial}`, answerId = `fixture-assistant-${serial}`;
        const answer = currentMode === 'reflect' ? `**安全回答**\n\n${fakeToken} ${fakeRequirements} ${fakeProof} 已处理。` : `**账号回答**\n\n第 ${serial} 轮回答${currentMode === 'delta' ? '，通过 delta v1' : ''}。`;
        event.httpStatus = 200; response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        response.write('event: delta_encoding\ndata: "v1"\n\n');
        response.write(sse({ type: 'input_message', conversation_id: conversation, input_message: { id: body.messages.at(-1).id } }));
        if (currentMode === 'delta') response.write(sse({ p: '', o: 'add', v: answerRoot(answerId, conversation, '') }));
        else response.write(sse(answerRoot(answerId, conversation, '**账号回答**\n\n正在接收…')));
        if (currentMode === 'hang') { response.once('close', () => { if (!response.writableEnded) abortedStreams++; }); return; }
        const timer = setTimeout(() => {
          if (response.destroyed) return;
          if (currentMode === 'delta') {
            response.write(sse({ p: '/message/content/parts/0', o: 'append', v: '**账号回答**\n\n' }));
            response.write(sse({ v: `第 ${serial} 轮回答，通过 delta v1。` }));
            response.write(sse({ p: '', o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }, { p: '/message/end_turn', o: 'replace', v: true }] }));
          } else response.write(sse(answerRoot(answerId, conversation, answer, true)));
          response.end(sse('[DONE]'));
        }, 850);
        response.once('close', () => clearTimeout(timer)); return;
      }
      if (request.method === 'GET' && url.pathname === '/favicon.ico') { event.httpStatus = 204; response.writeHead(204); response.end(); return; }
      unexpected.push({ method: request.method, path: url.origin + url.pathname }); json({ code: 'fixture-unexpected-path' }, 403);
    } catch (error) {
      unexpected.push({ method: request.method, path: url.origin + url.pathname, error: 'Fixture request assertion failed' });
      if (!response.headersSent) json({ code: 'fixture-assertion-failed' }, 500); else response.end();
    }
  });
  await new Promise((resolve, reject) => { fixtureServer.once('error', reject); fixtureServer.listen(0, '127.0.0.1', resolve); });
  const address = fixtureServer.address(); assert.ok(address && typeof address !== 'string');
  report.testHarness.loopbackFixture = { hostname: 'chatgpt.com', ip: '127.0.0.1', port: address.port, realDnsBlocked: true };
  await fs.cp(dist, extension, { recursive: true }); const manifestPath = path.join(extension, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, host_permissions: ['https://chatgpt.com/*'] }));
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--no-proxy-server', '--ignore-certificate-errors', `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${address.port}, MAP * ~NOTFOUND, EXCLUDE localhost`] });
  context.setDefaultTimeout(8000); worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); extensionId = new URL(worker.url()).hostname;
  report.browser = context.browser().version(); await fs.writeFile(manifestPath, manifestText);
  const extensionsPage = await context.newPage(); await extensionsPage.goto('chrome://extensions');
  await extensionsPage.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await extensionsPage.evaluate(id => { void chrome.developerPrivate.reload(id); }, extensionId);
  worker = await until(async () => { for (const candidate of context.serviceWorkers()) try { if (new URL(candidate.url()).hostname === extensionId && await candidate.evaluate(() => chrome.runtime.getManifest().host_permissions === undefined)) return candidate; } catch {} }, 'production worker did not reload');
  await extensionsPage.close(); assert.deepEqual(await hashDirectory(extension), testedFiles); report.testHarness.testCopyRestored = true;
  shell = await context.newPage(); await shell.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await until(async () => !(await shell.locator('#chat-status').innerText()).includes('正在连接'), 'chat did not initialize');

  await check('production settings select a Webapp account with no transport picker or automatic traffic', async () => {
    await select('settings'); assert.equal(await settings.locator('#connection-api').isChecked(), true);
    await settings.locator('#connection-web').check(); assert.equal(await settings.locator('#webchat-transport').count(), 0);
    assert.equal(await settings.locator('#webchat-page-model').count(), 0); assert.equal(await settings.locator('#webchat-model').isDisabled(), true);
    await settings.locator('#save-connection').click(); await until(async () => (await settings.locator('#connection-feedback').innerText()).includes('检查账号'), 'unchecked model was incorrectly saved');
    assert.equal(network.length, 0); assert.equal(chatPages().length, 0); assert.equal((await view()).config.provider, 'apiKey');
    return { automaticNetworkRequests: 0, transportPicker: false, fakeFollowPageModel: false, uncheckedModelRejected: true };
  });
  await check('account check creates an inactive pinned proxy and reads real fixture model choices without generating', async () => {
    const result = await refresh(); assert.equal(result.config.transport, 'webapp'); assert.equal(result.status.state, 'ready');
    assert.equal(result.status.generation, 'unchecked'); assert.equal(result.status.loggedIn, true);
    assert.deepEqual(result.status.models.map(model => model.id), ['webapp-model', 'webapp-second']); noSecrets(result);
    const tabs = await proxyTabs(); assert.equal(tabs.length, 1); assert.equal(tabs[0].pinned, true); assert.equal(tabs[0].active, false); assert.equal(tabs[0].url, 'https://chatgpt.com/');
    initialProxy = await until(() => chatPages()[0], 'background proxy page was not exposed in test context');
    assert.equal(requests.length, 0); assert.equal(network.filter(item => item.path.endsWith('/sentinel/chat-requirements/prepare')).length, 0);
    return { backgroundProxy: true, pinned: true, active: false, modelCount: 2, generation: 'unchecked', conversationRequests: 0 };
  });
  await check('the production model control saves the selected account model without an API key', async () => {
    await settings.locator('#webchat-model').selectOption('webapp-model'); await settings.locator('#save-connection').click();
    await until(async () => (await view()).config.model === 'webapp-model', 'selected model did not save');
    assert.deepEqual((await view()).config, { provider: 'chatgptWeb', transport: 'webapp', model: 'webapp-model' });
    assert.equal(await settings.locator('#base-url').inputValue(), ''); assert.equal(await settings.locator('#api-key').inputValue(), '');
    await select('chat'); assert.equal(await shell.locator('#chat-setup').isHidden(), true);
    return { selectedModel: 'webapp-model', apiKeyRequired: false, apiConfigurationUntouched: true };
  });
  await check('checking the account reuses an existing ordinary page and preserves its route and user draft', async () => {
    personal = await context.newPage(); await personal.goto('https://chatgpt.com/c/personal-chat'); await personal.locator('#draft').fill('用户正在写的私人草稿');
    const initial = await personal.evaluate(() => ({
      state: window.__fixtureLongLivedPageState,
      scriptOrPreloadTags: document.querySelectorAll('script[src],link[rel~="modulepreload"][href]').length,
      runtimeTimings: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/cdn/assets/633146.')).length,
      publicImports: window.__reactRouterManifest?.entry?.imports,
      currentBridgePresent: Object.hasOwn(window, '__readerNativeWebappBridgeV3'),
    }));
    assert.equal(initial.state?.runtimeLoaded, true); assert.ok(initial.state.documentId);
    assert.equal(initial.scriptOrPreloadTags, 0); assert.equal(initial.runtimeTimings, 0);
    assert.deepEqual(initial.publicImports, ['/cdn/assets/633146.1234567890.js']);
    assert.equal(initial.currentBridgePresent, false, 'old bridge must predate production v3 injection');
    personalDocumentId = initial.state.documentId; personal.on('framenavigated', frame => { if (frame === personal.mainFrame()) personalNavigations++; });
    await initialProxy.close(); const before = context.pages().length; const result = await refresh();
    assert.equal(result.status.state, 'ready'); assert.equal(context.pages().length, before); assert.equal((await proxyTabs()).length, 1); await assertDraft();
    assert.equal(await personal.evaluate(() => window.__readerNativeWebappBridgeV3?.version), 'reader-native-v3');
    return { ordinaryTabReused: true, newChatPage: false, draftPreserved: true, routePreserved: true,
      oldNonConfigurableV2PredatesInjection: true, initialAssetTagsRemoved: true, initialResourceTimingsCleared: true,
      runtimeAlreadyLoaded: true, publicRouterManifestOnly: true, v3InstalledAlongsideV2: true, pageReloads: 0, retiredBridgeCalls: 0 };
  });
  await check('sidebar sends two turns through one HTTP conversation and handles a delta v1 answer', async () => {
    const before = context.pages().length; mode = 'snapshot'; await begin('第一轮：解释账号侧栏连接。');
    await until(async () => await assistant().last().getAttribute('data-status') === 'running' && (await assistant().last().innerText()).includes('正在接收'), 'streaming partial answer was not shown');
    await finish(); mode = 'delta'; await send('第二轮：继续说明。');
    assert.equal(requests.length, 2); assert.equal(requests[0].body.conversation_id, undefined);
    assert.equal(requests[1].body.conversation_id, 'fixture-conversation-1'); assert.equal(requests[1].body.parent_message_id, 'fixture-assistant-1');
    assert.match(requests[1].body.messages[0].content.parts[0], /第二轮：继续说明/);
    assert.match(await assistant().last().innerText(), /delta v1/); assert.equal(await assistant().last().locator('strong').innerText(), '账号回答');
    assert.equal(context.pages().length, before); await assertDraft(); assert.equal((await view()).status.generation, 'working');
    return { requests: 2, sameRemoteConversation: true, deltaV1Decoded: true, markdownRendered: true, newChatPages: 0, draftPreserved: true };
  });
  await check('a long-lived page upgrade checks the account and chats without reloading or invoking the immutable v2 bridge', async () => {
    await assertDraft(); assert.equal(requests.length, 2);
    const lifecycle = await personal.evaluate(() => ({
      currentVersion: window.__readerNativeWebappBridgeV3?.version,
      oldVersion: window.__readerNativeWebappBridge?.version,
      scriptOrPreloadTags: document.querySelectorAll('script[src],link[rel~="modulepreload"][href]').length,
      runtimeTimings: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/cdn/assets/633146.')).length,
    }));
    assert.deepEqual(lifecycle, { currentVersion: 'reader-native-v3', oldVersion: 'reader-native-v2', scriptOrPreloadTags: 0, runtimeTimings: 0 });
    assert.equal((await proxyTabs()).length, 1);
    assert.equal(network.filter(item => item.method === 'GET' && item.path === 'https://chatgpt.com/c/personal-chat').length, 1);
    return { accountReady: true, successfulTurns: 2, onlyPublicManifestHasRuntimePath: true,
      immutableV2Retained: true, retiredBridgeCalls: 0, v3Used: true, pageReloads: 0, routeChanges: 0, extraTabs: 0, draftPreserved: true };
  });
  await check('local new-chat keeps the proxy page and OpenAI history while starting a new remote conversation', async () => {
    const before = context.pages().length; await clear(); mode = 'snapshot'; await send('新话题：新的账号对话。');
    assert.equal(requests.length, 3); assert.equal(requests[2].body.conversation_id, undefined);
    assert.equal(context.pages().length, before); await assertDraft();
    assert.ok(!network.some(item => ['DELETE', 'PATCH'].includes(item.method)));
    return { newRemoteConversation: true, newChatPages: 0, historyDeleteRequests: 0, originalDraftPreserved: true };
  });
  await check('the production stop button aborts the active HTTP stream without operating the website editor', async () => {
    mode = 'hang'; const before = requests.length; await begin('停止这一轮测试。');
    await until(async () => requests.length === before + 1 && (await assistant().last().innerText()).includes('正在接收'), 'hanging stream did not reach the sidebar');
    await shell.locator('#chat-stop').click(); await finish('cancelled');
    await until(() => abortedStreams === 1, 'the active response stream was not aborted once'); await assertDraft();
    assert.equal(requests.length, before + 1);
    return { userStopClicked: true, httpStreamAborted: true, retries: 0, webpageDomActions: 0 };
  });
  await check('a generic 403 is shown as a refusal and never triggers retries or another transport', async () => {
    mode = '403'; const before = requests.length; await send('模拟接口拒绝。', 'error'); await sleep(900);
    assert.equal(requests.length, before + 1); await select('settings');
    const result = await view(); assert.equal(result.status.generation, 'blocked'); assert.equal(result.status.loggedIn, true);
    assert.deepEqual(result.status.lastFailure, { stage: 'conversation', httpStatus: 403, code: 'accessDenied' });
    await until(async () => (await settings.locator('#webchat-failure').innerText()).includes('HTTP 403'), 'settings did not refresh the HTTP 403 failure');
    noSecrets(result); await assertDraft();
    return { code: 'accessDenied', httpStatus: 403, loginRetained: true, attempts: 1, automaticRetries: 0, domFallback: false };
  });
  await check('copy diagnostics contains only safe Webapp failure fields after a user button click', async () => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']); await settings.locator('#webchat-copy-diagnostics').click();
    await until(async () => (await settings.locator('#connection-feedback').innerText()).includes('已复制连接诊断'), 'diagnostic copy did not complete');
    const clipboard = await until(async () => { const value = await shell.evaluate(() => navigator.clipboard.readText()); return value.includes('阅窗连接诊断') ? value : undefined; }, 'diagnostic clipboard was empty');
    assert.match(clipboard, /"transport": "webapp"/); assert.match(clipboard, /403/); assert.match(clipboard, /accessDenied/);
    noSecrets(clipboard); for (const privateValue of ['mock-webapp@example.test', 'webapp-model', '模拟接口拒绝', 'accessToken']) assert.ok(!clipboard.includes(privateValue));
    return { userCopied: true, webappTransportIncluded: true, safeFailureIncluded: true, accountAndConversationExcluded: true };
  });
  await check('an explicit manual retry succeeds and reflected fake credentials are redacted from the answer', async () => {
    mode = 'reflect'; const before = requests.length; await send('重新发送，验证脱敏。');
    assert.equal(requests.length, before + 1); const answer = await assistant().last().innerText();
    noSecrets(answer); assert.match(answer, /安全回答/); assert.match(answer, /已隐藏登录凭据/); assert.match(answer, /已隐藏请求凭据/);
    assert.equal((await view()).status.generation, 'working'); assert.equal((await view()).status.lastFailure, undefined); await assertDraft();
    return { explicitRetryAttempts: 1, generation: 'working', sessionTokenReflected: false, requestTokensReflected: false };
  });
  await check('an expired login clears Webapp readiness and requires an explicit account recheck before sending again', async () => {
    mode = '401'; const before = requests.length; await send('模拟登录失效。', 'error');
    await select('settings'); const failed = await view();
    assert.equal(failed.status.state, 'signedOut'); assert.equal(failed.status.loggedIn, false);
    assert.deepEqual(failed.status.models, []);
    assert.deepEqual(failed.status.lastFailure, { stage: 'conversation', httpStatus: 401, code: 'signedOut' });
    assert.equal(requests.length, before + 1);
    await select('chat'); assert.equal(await shell.locator('#chat-setup').isVisible(), true);
    mode = 'snapshot'; const checked = await refresh(); assert.equal(checked.status.state, 'ready');
    assert.equal(requests.length, before + 1, 'account recheck must not generate');
    await send('检查账号后再次发送。'); assert.equal(requests.length, before + 2); await assertDraft();
    return { expiredLoginClearsReady: true, automaticRetries: 0, recheckGenerates: false, manualSendRecovers: true };
  });
  await check('Webapp settings and chat fit 390 and 320 pixels without horizontal overflow', async () => {
    for (const width of [390, 320]) {
      await shell.setViewportSize({ width, height: 900 });
      for (const tab of ['settings', 'chat']) {
        const frame = await select(tab); await sleep(120);
        assert.equal(await shell.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        await shell.screenshot({ path: path.join(screenshots, `${tab}-${width}.png`), fullPage: true });
      }
    }
    return { widths: [390, 320], horizontalOverflow: false };
  });
  await check('production controls keep credentials out of UI storage and status while all traffic stays local and bytes unchanged', async () => {
    await select('settings'); await settings.locator('#webchat-copy-diagnostics').click();
    await until(async () => (await settings.locator('#connection-feedback').innerText()).includes('已复制连接诊断'), 'final diagnostics did not complete');
    const values = await shell.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null), text: document.body.innerText }));
    noSecrets(values); noSecrets(await view()); noSecrets(await settings.locator('body').innerText());
    assert.ok(!JSON.stringify(values).includes('accessToken')); assert.deepEqual(unexpected, []); assert.ok(network.every(item => item.mocked));
    assert.ok(requests.every(item => item.clientHeadersVerified)); assert.equal(network.filter(item => item.path.endsWith('/backend-api/conversation')).length, 0);
    assert.deepEqual(await hashDirectory(dist), testedFiles); assert.deepEqual(await hashDirectory(extension), testedFiles); await assertDraft();
    return { tokenInUi: false, tokenInStorage: false, tokenInView: false, liveAccountRequests: 0, currentClientEndpoint: true, legacyOrDomFallback: false, productionBytesUnchanged: true };
  });
} catch (error) {
  fatal = error; report.fatal = error.message;
  report.failureEvidence = redactEvidence({
    view: settings ? await view().catch(() => undefined) : undefined,
    feedback: shell && !shell.isClosed() ? await shell.locator('#chat-feedback').innerText().catch(() => '') : '',
    chatPageCount: context ? chatPages().length : 0, requestModes: requests.map(item => item.mode), unexpected,
  });
  noSecrets(report.failureEvidence); process.stdout.write(`FATAL ${error.message}\n${JSON.stringify(report.failureEvidence)}\n`);
} finally {
  if (context) await context.close().catch(() => {});
  if (fixtureServer) { fixtureServer.closeAllConnections(); await new Promise(resolve => fixtureServer.close(resolve)); }
  report.testedBuild.unchangedAfterTest = JSON.stringify(await hashDirectory(dist)) === JSON.stringify(testedFiles);
  if (!report.testedBuild.unchangedAfterTest) { report.fatal = 'Production dist changed during Webapp test'; fatal ??= new Error(report.fatal); }
  report.passed = report.checks.filter(check => check.result === 'pass').length; report.failed = report.checks.filter(check => check.result === 'fail').length;
  const passed = text => report.checks.some(check => check.result === 'pass' && check.name.includes(text));
  report.coverage = {
    independentConfiguration: passed('no transport picker'), loginAndActualModels: passed('account check creates'), noApiKeyRequired: passed('production model control'),
    backgroundPinnedProxy: passed('account check creates'), ordinaryDraftPreserved: passed('ordinary page') && passed('two turns'), remoteMultiTurn: passed('two turns'),
    longLivedPageUpgrade: passed('ordinary page') && passed('two turns') && passed('long-lived page upgrade'),
    deltaV1Stream: passed('delta v1 answer'), localClearKeepsRemoteHistory: passed('local new-chat'), clearDoesNotOpenChatPage: passed('local new-chat'),
    stopAbortsStream: passed('production stop button'), explicitFailureNoFallback: passed('generic 403'), safeCopiedDiagnostics: passed('copy diagnostics'),
    expiredLoginRequiresRecheck: passed('expired login clears'),
    tokenIsolation: passed('reflected fake credentials') && passed('credentials out of UI storage'), narrow390And320: passed('390 and 320'),
    productionBytesUnchanged: passed('bytes unchanged') && report.testedBuild.unchangedAfterTest,
  };
  report.screenshots = (await fs.readdir(screenshots)).filter(name => /^(chat|settings)-(320|390)\.png$/.test(name)).map(name => `test-results/webchat-webapp-${version}/${name}`);
  await fs.writeFile(path.join(output, `webchat-webapp-e2e-report-${version}.json`), JSON.stringify(report, null, 2) + '\n');
  validateCleanup(profile); await fs.rm(profile, { recursive: true, force: true });
  process.stdout.write(`Mock Webapp ${version} e2e: ${report.passed} passed, ${report.failed} failed. Live account compatibility remains unverified.\n`);
  if (fatal || report.failed) process.exitCode = 1;
}
