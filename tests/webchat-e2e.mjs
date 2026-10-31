import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashDirectory, buildFingerprint } from '../scripts/artifact-hashes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'test-results');
const productionDirectory = path.join(root, 'dist');
const productionManifest = await fs.readFile(path.join(productionDirectory, 'manifest.json'), 'utf8');
const manifest = JSON.parse(productionManifest);
const version = manifest.version;
const screenshots = path.join(output, `webchat-${version}`);
await fs.mkdir(screenshots, { recursive: true });
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  for (const directory of ['.cache/ms-playwright', '.browsers']) {
    const candidate = path.join(root, directory);
    try { if ((await fs.readdir(candidate)).some(name => name.startsWith('chromium-'))) { process.env.PLAYWRIGHT_BROWSERS_PATH = candidate; break; } } catch {}
  }
}
const { chromium } = await import('playwright');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 18000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    await sleep(65);
  }
  throw new Error(description + (last ? `: ${last.message}` : ''));
}
function assertTestDirectory(directory) {
  const actual = path.resolve(directory), allowed = path.resolve(output);
  assert.ok(actual !== allowed && actual.startsWith(allowed + path.sep), 'refusing to clean outside test-results');
}
const testedFiles = await hashDirectory(productionDirectory);
const profile = await fs.mkdtemp(path.join(output, `webchat-${version}-profile-`));
const testExtension = path.join(profile, 'test-extension');
assertTestDirectory(profile); assertTestDirectory(testExtension);
const fakeToken = 'mock-openai-session-token-do-not-use';
const firstConversation = '11111111-1111-4111-8111-111111111111';
const nextConversation = '33333333-3333-4333-8333-333333333333';
const requests = [], unexpected = [];
let loggedIn = false, failConversation = false, sessionCalls = 0, modelCalls = 0, conversationFailureStatus = 403;
let conversationFailureBody = { detail: 'verification required' };
let incompatibleConversation = false;
let context, worker, shell, settings, extensionId, fatal;
const report = {
  extensionVersion: version, date: new Date().toISOString(), mockOnly: true, realAccountVerified: false, realModelVerified: false,
  checks: [], network: [], testedBuild: { fingerprint: buildFingerprint(testedFiles), files: testedFiles, unchangedAfterTest: false },
  testHarness: { productionWorkerWithoutTestEntry: true, productionSourceModified: false, testCopyRestored: false, trustedShellFormsAndButtonClicks: true,
    nativeActionClickVerified: false, nativeSidePanelSurfaceVerified: false,
    permissionBootstrap: 'Only the temporary test-copy manifest initially grants chatgpt.com. Exact production bytes are restored and the extension reloaded before feature checks.',
    networkMock: 'Playwright fulfills every chatgpt.com navigation/session/models/conversation request locally and aborts all other HTTP(S) traffic. No real account is used.' },
  notes: ['Login means a locally fulfilled ChatGPT page plus mocked auth/session; this test does not prove current live OpenAI web endpoints or account entitlements.',
    'Conversation responses use deterministic SSE. Tests drive production settings and shell controls; native toolbar clicking is outside this headless harness.']
};
async function check(name, operation) {
  const start = Date.now(), before = requests.length;
  try {
    const evidence = await operation();
    report.checks.push({ name, result: 'pass', milliseconds: Date.now() - start, conversationRequests: requests.length - before, ...(evidence ? { evidence } : {}) });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.checks.push({ name, result: 'fail', milliseconds: Date.now() - start, error: error.message });
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
    if (shell && !shell.isClosed()) await shell.screenshot({ path: path.join(screenshots, `failure-${report.checks.length}.png`), fullPage: true }).catch(() => {});
    throw error;
  }
}
async function launch(directory) {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: process.env.HEADED !== '1', viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`, '--no-first-run'] });
  context.setDefaultTimeout(8000);
  await context.route(/^https?:\/\//, async route => {
    const request = route.request(), url = new URL(request.url());
    report.network.push({ method: request.method(), url: url.origin + url.pathname, mocked: true });
    if (url.hostname !== 'chatgpt.com') { unexpected.push(url.origin + url.pathname); await route.abort('blockedbyclient'); return; }
    const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/api/auth/session') {
      sessionCalls++;
      await json(loggedIn ? { accessToken: fakeToken, expires: '2099-01-01T00:00:00.000Z', user: { name: '本地测试账号', email: 'mock@example.test' } } : {});
      return;
    }
    if (url.pathname === '/backend-api/models') { modelCalls++; await json({ models: [{ slug: 'web-model', title: 'Mock Web' }] }); return; }
    if (url.pathname === '/backend-api/conversation') {
      const body = request.postDataJSON();
      requests.push({ body, bearerTokenMatches: request.headers().authorization === `Bearer ${fakeToken}` });
      if (failConversation) { await route.fulfill({ status: conversationFailureStatus, contentType: 'application/json', body: JSON.stringify(conversationFailureBody) }); return; }
      if (incompatibleConversation) { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ raw_private_error: fakeToken }) }); return; }
      const conversation = body.conversation_id || (requests.length < 3 ? firstConversation : nextConversation);
      const id = requests.length === 1 ? '22222222-2222-4222-8222-222222222222' : requests.length === 2 ? '44444444-4444-4444-8444-444444444444' : '55555555-5555-4555-8555-555555555555';
      const event = { message: { id, author: { role: 'assistant' }, content: { content_type: 'text', parts: [`**网页回答**\n\n第 ${requests.length} 轮回答。`] }, status: 'finished_successfully', end_turn: true }, conversation_id: conversation };
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n` });
      return;
    }
    if (request.isNavigationRequest()) { await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><title>本地模拟 ChatGPT</title></head><body><h1>本地模拟登录页</h1><p>所有请求由测试本地接管，没有真实账号。</p></body></html>' }); return; }
    await route.fulfill({ status: 404, body: 'Mock endpoint not found' });
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  report.browser = context.browser().version();
}
async function select(tab) {
  await shell.locator(`#tab-${tab}`).click();
  if (tab === 'chat') return shell;
  const frame = await until(async () => (await shell.locator(`#frame-${tab}`).elementHandle())?.contentFrame(), 'settings frame missing');
  await until(() => frame.locator('#save-connection').isEnabled(), 'connection controls unavailable');
  settings = frame;
  return frame;
}
async function view() {
  const result = await settings.evaluate(() => chrome.runtime.sendMessage({ type: 'webchat:view' }));
  assert.equal(result.ok, true, result.error);
  return result.view;
}
async function refresh() {
  const before = sessionCalls;
  await settings.locator('#webchat-refresh').click();
  await until(async () => sessionCalls > before && await settings.locator('#webchat-refresh').isEnabled(), 'login refresh did not finish');
  return view();
}
const assistant = () => shell.locator('.chat-message[data-role="assistant"]');
async function send(text, expected = 'done') {
  await select('chat');
  const before = await assistant().count();
  await shell.locator('#chat-input').fill(text);
  await until(() => shell.locator('#chat-send').isEnabled(), 'web chat send unavailable');
  await shell.locator('#chat-send').click();
  await until(async () => await assistant().count() > before && await assistant().last().getAttribute('data-status') === expected, `web chat did not finish as ${expected}`);
  await until(() => shell.locator('#chat-stop').isHidden(), 'chat remained running');
}
async function clear() {
  await shell.locator('#chat-new').click();
  await shell.locator('#chat-clear-dialog').waitFor({ state: 'visible' });
  assert.match(await shell.locator('#chat-clear-description').innerText(), /OpenAI.*历史.*保留/);
  await shell.locator('#chat-clear-confirm').click();
  await until(async () => await shell.locator('.chat-message').count() === 0, 'local chat not cleared');
}
try {
  await fs.cp(productionDirectory, testExtension, { recursive: true });
  const manifestPath = path.join(testExtension, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, host_permissions: ['https://chatgpt.com/*'] }));
  await launch(testExtension);
  await fs.writeFile(manifestPath, productionManifest);
  const browserSettings = await context.newPage();
  await browserSettings.goto('chrome://extensions');
  await browserSettings.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await browserSettings.evaluate(id => { void chrome.developerPrivate.reload(id); }, extensionId);
  worker = await until(async () => {
    for (const candidate of context.serviceWorkers()) {
      try { if (new URL(candidate.url()).hostname === extensionId && await candidate.evaluate(() => chrome.runtime.getManifest().host_permissions === undefined)) return candidate; } catch {}
    }
  }, 'restored production worker unavailable');
  await browserSettings.close();
  assert.deepEqual(await hashDirectory(testExtension), testedFiles);
  report.testHarness.testCopyRestored = true;
  shell = await context.newPage(); await shell.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await until(async () => !(await shell.locator('#chat-status').innerText()).includes('正在连接'), 'shell did not initialize');
  await check('default API configuration remains available and switching the independent Web form makes no model call', async () => {
    await select('settings');
    assert.equal(await settings.locator('#connection-api').isChecked(), true);
    assert.equal(await settings.locator('#base-url').isEnabled(), true);
    assert.equal(await settings.locator('#save-settings').isEnabled(), true);
    await settings.locator('#connection-web').check();
    await settings.locator('#webchat-transport').selectOption('direct');
    assert.equal(await settings.locator('#webchat-details').isVisible(), true);
    assert.equal(requests.length, 0); assert.equal(sessionCalls, 0);
    assert.match(await settings.locator('.connection-scope').innerText(), /跨页研究.*API/);
    return { defaultProvider: 'apiKey', independentApiForm: true, automaticRequests: 0 };
  });
  await check('trusted login controls open the official tab and show signed-out state without exposing credentials or sending a conversation', async () => {
    const before = (await context.pages()).length;
    await settings.locator('#webchat-open').click();
    await until(async () => (await context.pages()).some(page => page.url().startsWith('https://chatgpt.com')), 'official ChatGPT tab not opened');
    const status = await refresh();
    assert.equal(status.status.state, 'signedOut'); assert.equal(status.status.loggedIn, false);
    assert.match(await settings.locator('#webchat-status').innerText(), /登录/);
    assert.equal(requests.length, 0);
    assert.ok((await context.pages()).length >= before);
    return { officialOrigin: 'https://chatgpt.com', signedOutShown: true, conversationRequests: 0 };
  });
  await check('mocked login discovers account models and selects Web without any API Key or charged generation', async () => {
    loggedIn = true;
    const status = await refresh();
    assert.equal(status.status.state, 'ready'); assert.equal(status.status.loggedIn, true);
    assert.equal(status.status.generation, 'unchecked');
    assert.match(await settings.locator('#webchat-status').innerText(), /对话尚未验证/);
    assert.doesNotMatch(await settings.locator('#webchat-status').innerText(), /已连接/);
    assert.equal(await settings.locator('#webchat-model').inputValue(), 'web-model');
    assert.match(await settings.locator('#webchat-account').innerText(), /本地测试账号|mock@example/);
    await settings.locator('#save-connection').click();
    await until(async () => (await view()).config.provider === 'chatgptWeb', 'Web provider not saved');
    const api = await settings.evaluate(() => chrome.runtime.sendMessage({ type: 'settings:get' }));
    assert.equal(api.hasKey, false); assert.equal(requests.length, 0); assert.ok(modelCalls >= 1);
    await select('chat');
    await until(() => shell.locator('#chat-setup').isHidden(), 'Web configuration still requests API Key');
    assert.match(await shell.locator('#chat-connection').innerText(), /ChatGPT/);
    return { actualModelList: ['web-model'], apiKeyConfigured: false, generationRequests: 0 };
  });
  await check('Web chat renders Markdown and continues one remote conversation across two genuine sends', async () => {
    await send('请解释网页接入。'); await send('继续解释本机存储。');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.model, 'web-model');
    assert.equal(requests[0].body.conversation_id, undefined);
    assert.equal(requests[1].body.conversation_id, firstConversation);
    assert.equal(requests[1].body.parent_message_id, '22222222-2222-4222-8222-222222222222');
    assert.ok(requests.every(request => request.bearerTokenMatches));
    assert.equal(await assistant().last().locator('strong').innerText(), '网页回答');
    assert.equal((await view()).status.generation, 'working');
    assert.match(await shell.locator('#chat-status').innerText(), /最近一次对话成功/);
    return { requests: 2, remoteConversationContinued: true, parentIdUsed: true, markdownRendered: true, apiFallback: false };
  });
  await check('local new-chat confirmation preserves OpenAI history and makes the next send start a new remote conversation', async () => {
    await clear(); await send('新的话题。');
    assert.equal(requests.length, 3);
    assert.equal(requests[2].body.conversation_id, undefined);
    assert.notEqual(requests[2].body.parent_message_id, '44444444-4444-4444-8444-444444444444');
    return { newRemoteConversation: true, remoteDeleteRequests: 0, logoutRequests: 0 };
  });
  await check('generic 403 refusal updates chat and settings without inventing verification, retrying or falling back', async () => {
    const before = requests.length; failConversation = true;
    await send('触发一次模拟验证失败。', 'error');
    await sleep(300);
    assert.equal(requests.length, before + 1);
    const feedback = await shell.locator('#chat-feedback').innerText();
    assert.match(feedback, /对话请求 · HTTP 403/); assert.match(feedback, /拒绝/); assert.doesNotMatch(feedback, /完成验证/);
    assert.match(await shell.locator('#chat-status').innerText(), /最近一次对话失败/);
    await select('settings'); assert.equal((await view()).config.provider, 'chatgptWeb');
    await until(async () => (await settings.locator('#webchat-status').innerText()).includes('最近一次对话失败'), 'settings still claims connection success after failed chat');
    const status = (await view()).status;
    assert.equal(status.state, 'ready'); assert.equal(status.loggedIn, true); assert.equal(status.generation, 'blocked');
    assert.deepEqual(status.lastFailure, { stage: 'conversation', httpStatus: 403, code: 'accessDenied' });
    return { status: 403, requestCount: 1, automaticRetries: 0, apiFallbackRequests: 0 };
  });
  await check('copy diagnostics preserves only safe failure fields and excludes account, model, conversation and tokens', async () => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await shell.bringToFront();
    await settings.locator('#webchat-copy-diagnostics').click();
    await until(async () => (await settings.locator('#connection-feedback').innerText()).includes('已复制连接诊断'), 'diagnostic copy did not complete');
    const clipboard = await until(async () => { const value = await shell.evaluate(() => navigator.clipboard.readText()); return value.includes('阅窗连接诊断') ? value : undefined; }, 'diagnostic clipboard remained empty');
    assert.match(clipboard, /阅窗连接诊断/); assert.match(clipboard, /403/); assert.match(clipboard, /accessDenied/);
    for (const forbidden of [fakeToken, 'mock@example', 'web-model', 'raw_private_error', '触发一次模拟验证失败', 'accessToken']) assert.ok(!clipboard.includes(forbidden));
    return { userClickedCopy: true, phase: 'conversation', httpStatus: 403, privateFieldsExcluded: true };
  });
  await check('refresh checks only login and models and never upgrades an untested chat to working', async () => {
    const before = requests.length, status = await refresh();
    assert.equal(status.status.generation, 'unchecked'); assert.equal(status.status.lastFailure, undefined); assert.equal(requests.length, before);
    assert.match(await settings.locator('#webchat-status').innerText(), /对话尚未验证/);
    return { conversationRequests: 0, generation: 'unchecked' };
  });
  await check('explicit verification and quota errors keep their own safe causes and one manual request each', async () => {
    for (const [httpStatus, code, expected] of [[403, 'verification_required', 'verificationRequired'], [429, 'quota_exceeded', 'quota']]) {
      conversationFailureStatus = httpStatus; conversationFailureBody = { detail: { code, message: fakeToken } };
      const before = requests.length; await send('模拟明确的受限原因。', 'error');
      assert.equal(requests.length, before + 1); await select('settings');
      assert.deepEqual((await view()).status.lastFailure, { stage: 'conversation', httpStatus, code: expected });
    }
    return { verificationHasExplicitCode: true, quotaIsSeparate: true, automaticRetries: 0 };
  });
  await check('a 200 response with an incompatible conversation body stays failed and keeps its actual HTTP status', async () => {
    failConversation = false; incompatibleConversation = true;
    const before = requests.length; await send('模拟不兼容响应。', 'error'); await select('settings');
    assert.equal(requests.length, before + 1);
    assert.deepEqual((await view()).status.lastFailure, { stage: 'conversation', httpStatus: 200, code: 'format' });
    assert.match(await settings.locator('#webchat-failure').innerText(), /HTTP 200/);
    return { generation: 'blocked', responseFormat: 'unsupported', httpStatus: 200 };
  });
  await check('credentials never enter extension UI, settings responses, local storage, or session checkpoints', async () => {
    const values = await shell.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null), text: document.body.innerText }));
    const status = await view();
    assert.ok(!JSON.stringify(values).includes(fakeToken));
    assert.ok(!JSON.stringify(status).includes(fakeToken));
    assert.ok(!(await settings.locator('body').innerText()).includes(fakeToken));
    assert.ok(!JSON.stringify(values).includes('accessToken'));
    return { tokenInUi: false, tokenInStorage: false, tokenInView: false };
  });
  await check('Web settings and chat render at 390 and 320 without horizontal overflow', async () => {
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
  await check('all account traffic is locally mocked and exact production build bytes remain untouched', async () => {
    assert.deepEqual(unexpected, []);
    assert.deepEqual(await hashDirectory(productionDirectory), testedFiles);
    assert.deepEqual(await hashDirectory(testExtension), testedFiles);
    return { liveAccountRequests: 0, realAccountVerified: false, productionBytesUnchanged: true };
  });
} catch (error) { fatal = error; report.fatal = error.message; process.stdout.write(`FATAL ${error.message}\n`); }
finally {
  if (context) await context.close().catch(() => {});
  report.testedBuild.unchangedAfterTest = JSON.stringify(await hashDirectory(productionDirectory)) === JSON.stringify(testedFiles);
  if (!report.testedBuild.unchangedAfterTest) { report.fatal = 'Production dist changed during Web chat test'; fatal ??= new Error(report.fatal); }
  report.passed = report.checks.filter(check => check.result === 'pass').length;
  report.failed = report.checks.filter(check => check.result === 'fail').length;
  const passed = part => report.checks.some(check => check.result === 'pass' && check.name.includes(part));
  report.coverage = { independentConfiguration: passed('default API'), loginAndActualModels: passed('mocked login'), signedOutState: passed('trusted login'),
    noApiKeyRequired: passed('mocked login'), remoteMultiTurn: passed('Web chat renders'), localClearKeepsRemoteHistory: passed('local new-chat'),
    explicitFailureNoFallback: passed('generic 403 refusal'), generationStates: passed('mocked login') && passed('Web chat renders') && passed('generic 403 refusal'),
    safeCopiedDiagnostics: passed('copy diagnostics'), refreshDoesNotVerifyChat: passed('refresh checks only'), explicitCausesAndFormat: passed('explicit verification and quota') && passed('a 200 response'),
    tokenIsolation: passed('credentials never'), narrow390And320: passed('Web settings and chat'),
    productionBytesUnchanged: passed('all account traffic') && report.testedBuild.unchangedAfterTest };
  report.screenshots = (await fs.readdir(screenshots)).filter(name => name.endsWith('.png')).map(name => `test-results/webchat-${version}/${name}`);
  await fs.writeFile(path.join(output, `webchat-e2e-report-${version}.json`), JSON.stringify(report, null, 2) + '\n');
  assertTestDirectory(profile); await fs.rm(profile, { recursive: true, force: true });
  process.stdout.write(`Mock Web chat ${version} e2e: ${report.passed} passed, ${report.failed} failed. Live OpenAI account and endpoint compatibility remain unverified.\n`);
  if (fatal || report.failed) process.exitCode = 1;
}
