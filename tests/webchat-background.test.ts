import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WEBCHAT_ORIGIN, WEBCHAT_PORT, WEBCHAT_PAGE_PORT, type WebChatInput, type WebChatPageCommand } from '../src/webchat-shared.ts';

class Hub<Args extends unknown[]> {
  listeners: ((...args: Args) => unknown)[] = [];
  addListener = (listener: (...args: Args) => unknown) => { this.listeners.push(listener); };
  removeListener = (listener: (...args: Args) => unknown) => { this.listeners = this.listeners.filter(item => item !== listener); };
  emit(...args: Args) { for (const listener of [...this.listeners]) listener(...args); }
}
type Loose = Record<string, unknown>;
const ID = 'webchat-test';
const store: Loose = {};
const sessionStore: Loose = {};
const runtimeMessages = new Hub<[Loose, chrome.runtime.MessageSender, (response: unknown) => void]>();
const updated = new Hub<[number, chrome.tabs.OnUpdatedInfo]>();
const removed = new Hub<[number]>();
const committed = new Hub<[chrome.webNavigation.WebNavigationTransitionCallbackDetails]>();
const permissionRemoved = new Hub<[chrome.permissions.Permissions]>();
let permitted = true, documentId = 'document-1', injected = 0, created = 0, focused = 0, configChanges = 0;
let tabs: chrome.tabs.Tab[] = [];
let injection: (() => Promise<void> | void) | undefined;
let frameRead: (() => Promise<void> | void) | undefined;
let creation: ((tab: chrome.tabs.Tab) => void) | undefined;
const ports: MockPort[] = [];
const injectionFiles: string[] = [];
const createdOptions: chrome.tabs.CreateProperties[] = [];
const commands: WebChatPageCommand[] = [];
const config = { provider: 'chatgptWeb' as const, model: 'test-model' };
const ready = { state: 'ready', loggedIn: true, accountLabel: 'reader@example.test', models: [{ id: 'test-model', label: '测试模型' }], generation: 'unchecked' };
let response: (port: MockPort, command: WebChatPageCommand) => void;
let manager: typeof import('../src/webchat-background.ts');
class MockPort {
  constructor(public name = WEBCHAT_PORT, public tabId = 7) {}
  disconnected = false;
  onMessage = new Hub<[unknown]>(); onDisconnect = new Hub<[]>();
  postMessage(command: WebChatPageCommand) { commands.push(structuredClone(command)); if (command.type !== 'cancel') queueMicrotask(() => response(this, command)); }
  disconnect() { if (!this.disconnected) { this.disconnected = true; this.onDisconnect.emit(); } }
  event(event: unknown) { this.onMessage.emit(event); }
}
const sender = (change: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({ id: ID, origin: `chrome-extension://${ID}`, frameId: 0, url: `chrome-extension://${ID}/sidepanel.html`, ...change });
const normal = (port: MockPort, command: WebChatPageCommand) => {
  if (command.type === 'status') port.event({ type: 'status', id: command.id, status: { ...ready, accessToken: 'must-never-be-returned', error: 'secret-error' }, unknown: 'must-never-be-returned' });
  else if (command.type === 'generate') {
    port.event({ type: 'text', id: command.id, text: '完整回答' });
    if (port.name === WEBCHAT_PAGE_PORT) {
      const tab = tabs.find(item => item.id === port.tabId)!;
      tab.url = `${WEBCHAT_ORIGIN}/c/conversation-1`;
      updated.emit(port.tabId, { url: tab.url });
    }
    port.event({ type: 'done', id: command.id, text: '完整回答', conversation: { id: 'conversation-1', parentId: 'assistant-1', token: 'must-never-be-returned' } });
  }
};
const input = (text = '你好') => [{ role: 'system' as const, content: '请用中文回答' }, { role: 'user' as const, content: text }];
const generate = (messages: WebChatInput[] = input(), signal = new AbortController().signal, onText: (text: string) => void = () => {}) => manager.requestWebChat(messages, signal, onText);
async function settle() { for (let index = 0; index < 8; index++) await nextTurn(); }
async function waitFor(predicate: () => boolean) { const until = Date.now() + 2000; while (!predicate()) { if (Date.now() > until) throw new Error('Timed out waiting for Port'); await nextTurn(); } }
async function message(command: Loose, source = sender()) { return new Promise<unknown>((resolve, reject) => { runtimeMessages.emit(command, source, resolve); setTimeout(() => reject(new Error('Missing runtime response')), 500).unref(); }); }
function generateCommands() { return commands.filter(command => command.type === 'generate') as Extract<WebChatPageCommand, { type: 'generate' }>[]; }

before(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: ID, getURL: (file: string) => `chrome-extension://${ID}/${file}`, onMessage: runtimeMessages },
    permissions: { onRemoved: permissionRemoved, contains: async (request: unknown) => { assert.deepEqual(request, { origins: [`${WEBCHAT_ORIGIN}/*`] }); return permitted; } },
    storage: { local: {
      get: async (key: string) => structuredClone({ [key]: store[key] }),
      set: async (value: Loose) => { assert.deepEqual(Object.keys(value), ['webChatConfig']); Object.assign(store, structuredClone(value)); }
    }, session: {
      get: async (key: string) => structuredClone({ [key]: sessionStore[key] }),
      set: async (value: Loose) => { assert.deepEqual(Object.keys(value), ['webChatOwnedPage']); Object.assign(sessionStore, structuredClone(value)); },
      remove: async (key: string) => { assert.equal(key, 'webChatOwnedPage'); delete sessionStore[key]; }
    } },
    tabs: {
      onUpdated: updated, onRemoved: removed,
      query: async (request: unknown) => { assert.deepEqual(request, { url: [`${WEBCHAT_ORIGIN}/*`] }); return structuredClone(tabs); },
      get: async (id: number) => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('tab missing'); return structuredClone(tab); },
      connect: (id: number, info: { name: string; frameId: number }) => { assert.ok(tabs.some(tab => tab.id === id)); assert.ok([WEBCHAT_PORT, WEBCHAT_PAGE_PORT].includes(info.name)); assert.equal(info.frameId, 0); const port = new MockPort(info.name, id); ports.push(port); return port; },
      create: async (info: chrome.tabs.CreateProperties) => { assert.equal(info.url, `${WEBCHAT_ORIGIN}/`); created++; createdOptions.push(info); const tab = { id: 100 + created, windowId: 4, url: info.url, active: info.active, status: 'complete' } as chrome.tabs.Tab; tabs.push(tab); creation?.(tab); return structuredClone(tab); },
      update: async (id: number, info: unknown) => { assert.ok(tabs.some(tab => tab.id === id)); assert.deepEqual(info, { active: true }); focused++; }
    },
    windows: { update: async (id: number, info: unknown) => { assert.equal(id, 4); assert.deepEqual(info, { focused: true }); } },
    webNavigation: { onCommitted: committed, getFrame: async (info: { tabId: number; frameId: number }) => { assert.equal(info.frameId, 0); await frameRead?.(); return { url: tabs.find(tab => tab.id === info.tabId)?.url, documentId, documentLifecycle: 'active' }; } },
    scripting: { executeScript: async (info: { target: { tabId: number; frameIds: number[] }; files: string[]; world: string }) => {
      assert.ok(tabs.some(tab => tab.id === info.target.tabId)); assert.deepEqual(info.target.frameIds, [0]); assert.equal(info.world, 'ISOLATED'); assert.ok(['webchat-content.js', 'webchat-page-content.js'].includes(info.files[0]));
      injectionFiles.push(info.files[0]);
      injected++; const original = documentId; await injection?.(); return [{ frameId: 0, documentId: original }];
    } }
  };
  manager = await import('../src/webchat-background.ts');
  assert.equal(runtimeMessages.listeners.length, 0, 'module import is inert');
  manager.initializeWebChat({ onConfigChange: () => { configChanges++; } });
  manager.initializeWebChat(); assert.equal(runtimeMessages.listeners.length, 1);
});
beforeEach(async () => {
  manager.resetWebChatConversation(); await settle();
  permitted = true; documentId = 'document-1'; tabs = [{ id: 7, windowId: 4, url: `${WEBCHAT_ORIGIN}/c/open`, active: true } as chrome.tabs.Tab];
  injection = frameRead = creation = undefined; response = normal;
  await manager.saveWebChatConfig(config);
  await manager.saveWebChatConfig({ provider: 'apiKey', model: '' });
  injected = created = focused = configChanges = 0; ports.length = commands.length = injectionFiles.length = createdOptions.length = 0;
});

test('default and cached views read one local config and never contact a page or create a tab', async () => {
  assert.deepEqual(await manager.getWebChatView(), { config: { provider: 'apiKey', model: '' }, status: { state: 'unchecked', loggedIn: false, models: [], generation: 'unchecked' } });
  assert.equal(injected, 0); assert.equal(created, 0); assert.equal(commands.length, 0);
  store.webChatConfig = { provider: 'bogus', model: 'secret' };
  assert.deepEqual((await manager.getWebChatView()).config, { provider: 'apiKey', model: '' });
});
test('missing permission and missing tab refreshes do not inject, request or open anything', async () => {
  permitted = false;
  assert.equal((await manager.refreshWebChat()).status.state, 'permissionRequired');
  await assert.rejects(manager.openChatgptLogin(), /授权/);
  permitted = true; tabs = [];
  assert.equal((await manager.refreshWebChat()).status.state, 'missingTab');
  assert.equal(injected, 0); assert.equal(created, 0); assert.equal(commands.length, 0);
});
test('explicit refresh uses one document-bound status Port, strips unknown fields and caches the view', async () => {
  const view = await manager.refreshWebChat();
  assert.deepEqual(view.status, ready); assert.equal(injected, 1);
  assert.equal(commands.filter(item => item.type === 'status').length, 1);
  assert.equal(generateCommands().length, 0); assert.ok(ports[0].disconnected);
  const snapshot = JSON.stringify(await manager.getWebChatView());
  assert.ok(!snapshot.includes('secret')); assert.ok(!snapshot.includes('must-never-be-returned'));
  assert.equal(injected, 1); assert.equal(created, 0);
});
test('only the explicit login operation focuses an existing tab or opens a new foreground tab', async () => {
  await manager.openChatgptLogin(); assert.equal(focused, 1); assert.equal(created, 0);
  tabs = []; await manager.openChatgptLogin(); assert.equal(created, 1); assert.equal(injected, 0);
});
test('configuration validates a minimal whitelist, calls cancellation only on changes and never stores tokens', async () => {
  await manager.saveWebChatConfig({ ...config, accessToken: 'secret' } as typeof config);
  assert.deepEqual(store.webChatConfig, config); assert.equal(configChanges, 1);
  await manager.saveWebChatConfig(config); assert.equal(configChanges, 1);
  assert.throws(() => manager.saveWebChatConfig({ provider: 'chatgptWeb', model: 'bad\nmodel' }), /配置无效/);
});
test('only exact trusted settings and top-level panel documents can operate the manager', async () => {
  for (const source of [sender({ id: 'foreign' }), sender({ frameId: 1 }), sender({ origin: 'https://site.test' }), sender({ url: `chrome-extension://${ID}/sidepanel.html?panel=1` }), sender({ url: 'https://chatgpt.com/' }), sender({ url: `chrome-extension://${ID}/research.html` }), sender({ frameId: 3, url: `chrome-extension://${ID}/options.html?panel=1&extra=1` })]) {
    assert.deepEqual(await message({ type: 'webchat:open' }, source), { ok: false, error: '仅设置页与侧边栏可操作 ChatGPT 网页连接。' });
  }
  for (const source of [sender(), sender({ url: `chrome-extension://${ID}/options.html` }), sender({ frameId: 3, url: `chrome-extension://${ID}/options.html?panel=1` })]) assert.equal((await message({ type: 'webchat:view' }, source) as Loose).ok, true);
  assert.equal(created + focused + injected, 0);
});
test('successful next turns reuse conversation only for an exact completed user/assistant prefix', async () => {
  await manager.saveWebChatConfig(config);
  assert.equal(await generate(), '完整回答');
  const next = [...input(), { role: 'assistant' as const, content: '完整回答' }, { role: 'user' as const, content: '再说一点' }];
  await generate(next);
  assert.equal(generateCommands()[0].conversation, undefined);
  assert.deepEqual(generateCommands()[1].conversation, { id: 'conversation-1', parentId: 'assistant-1' });
  assert.ok(!JSON.stringify(generateCommands()).includes('must-never-be-returned'));
  await generate(input('另一个会话'));
  assert.equal(generateCommands()[2].conversation, undefined);
  assert.deepEqual(Object.keys(store), ['webChatConfig']);
});
test('failures and explicit reset drop the remote conversation before the next request', async () => {
  await manager.saveWebChatConfig(config); await generate();
  response = (port, command) => { if (command.type === 'generate') port.event({ type: 'error', id: command.id, code: 'quota', error: 'secret access token' }); };
  const next = [...input(), { role: 'assistant' as const, content: '完整回答' }, { role: 'user' as const, content: '再说一点' }];
  await assert.rejects(generate(next), /额度不足/);
  response = normal; await generate(next);
  assert.equal(generateCommands()[2].conversation, undefined);
  manager.resetWebChatConversation(); await generate(next);
  assert.equal(generateCommands()[3].conversation, undefined);
});
test('abort sends only cancellation, disconnects the owned Port and never retries', async () => {
  await manager.saveWebChatConfig(config); response = () => {};
  const controller = new AbortController(); const pending = generate(input(), controller.signal); const rejected = assert.rejects(pending, { name: 'AbortError' });
  await waitFor(() => generateCommands().length === 1); controller.abort(); await rejected;
  assert.ok(ports[0].disconnected); assert.equal(commands.at(-1)?.type, 'cancel'); assert.equal(generateCommands().length, 1);
  assert.equal(updated.listeners.length + removed.listeners.length + committed.listeners.length, 0);
});
test('tab navigation, reload and closing cancel a generation and prevent stale output', async () => {
  await manager.saveWebChatConfig(config);
  for (const navigate of [() => updated.emit(7, { status: 'loading' }), () => removed.emit(7), () => committed.emit({ tabId: 7, frameId: 0, documentId: 'new-document' } as chrome.webNavigation.WebNavigationTransitionCallbackDetails)]) {
    response = () => {}; const count = generateCommands().length;
    const pending = generate(); const rejected = assert.rejects(pending, /关闭或跳转/);
    await waitFor(() => generateCommands().length > count); navigate(); await rejected;
    const port = ports.at(-1)!; const command = generateCommands().at(-1)!;
    port.event({ type: 'done', id: command.id, text: '迟到', conversation: { id: 'late', parentId: 'late' } });
    assert.ok(port.disconnected);
  }
});
test('document or origin changes during injection prevent the bridge from sending a request', async () => {
  await manager.saveWebChatConfig(config);
  injection = () => { documentId = 'new-document'; };
  await assert.rejects(generate(), /关闭或跳转/); assert.equal(generateCommands().length, 0);
  documentId = 'document-1'; injection = () => { tabs[0].url = 'https://elsewhere.test/'; };
  await assert.rejects(generate(), /关闭或跳转/); assert.equal(generateCommands().length, 0);
});
test('wrong event ids are ignored while malformed or oversized matching events stop safely', async () => {
  await manager.saveWebChatConfig(config);
  response = (port, command) => { if (command.type === 'generate') { port.event({ type: 'error', id: 'wrong-id', code: 'quota' }); normal(port, command); } };
  assert.equal(await generate(), '完整回答');
  response = (port, command) => { if (command.type === 'generate') port.event({ type: 'text', id: command.id, text: 'x'.repeat(40_001), token: 'secret' }); };
  await assert.rejects(generate(), /响应格式/);
  response = (port, command) => { if (command.type === 'generate') port.event({ type: 'done', id: command.id, text: 'ok', conversation: { id: 'https://evil', parentId: 'bad' } }); };
  await assert.rejects(generate(), /响应格式/);
});
test('an active request blocks duplicates and explicit status refresh cancels it before using its own Port', async () => {
  await manager.saveWebChatConfig(config); response = (port, command) => { if (command.type === 'status') normal(port, command); };
  const owner = new AbortController(); const pending = generate(input(), owner.signal); const rejected = assert.rejects(pending, { name: 'AbortError' });
  await waitFor(() => generateCommands().length === 1);
  await assert.rejects(generate(), /正在运行/);
  assert.equal((await manager.refreshWebChat()).status.state, 'ready');
  assert.equal(ports.length, 2); assert.equal(generateCommands().length, 1);
  await rejected; assert.ok(ports[0].disconnected);
});
test('configuration changes abort generation while retaining the refreshed account/model selection', async () => {
  await manager.saveWebChatConfig(config); await manager.refreshWebChat(); response = () => {};
  const pending = generate(); const rejected = assert.rejects(pending, { name: 'AbortError' });
  await waitFor(() => generateCommands().length === 1);
  const view = await manager.saveWebChatConfig({ provider: 'apiKey', model: '' }); await rejected;
  assert.deepEqual(view.status, ready); assert.equal(generateCommands().length, 1);
});
test('status and generation have bounded timeouts and never retry or leak raw page failures', async () => {
  await manager.saveWebChatConfig(config); response = () => {};
  const limits = { ...manager.WEBCHAT_TIMEOUTS };
  Object.assign(manager.WEBCHAT_TIMEOUTS, { status: 20, total: 30, idle: 15 });
  try {
    const view = await manager.refreshWebChat(); assert.match(view.status.error!, /超时/);
    await assert.rejects(generate(), /超时/); assert.equal(generateCommands().length, 1);
    response = (port, command) => port.event({ type: 'error', id: command.id, code: 'untrusted raw token', message: 'access-token-secret' });
    await assert.rejects(generate(), error => error instanceof Error && /响应格式/.test(error.message) && !error.message.includes('secret'));
  } finally { Object.assign(manager.WEBCHAT_TIMEOUTS, limits); }
});
test('invalid inputs and unavailable permission are rejected before any conversation request', async () => {
  await manager.saveWebChatConfig(config);
  await assert.rejects(generate(input('x'.repeat(40_001))), /内容无效或过长/);
  permitted = false; await assert.rejects(generate(), /授权/);
  assert.equal(generateCommands().length, 0); assert.equal(created, 0);
});
test('permission revocation stops an in-flight request and removes its operation listeners', async () => {
  await manager.saveWebChatConfig(config); response = () => {};
  const pending = generate(); const rejected = assert.rejects(pending, /授权/);
  await waitFor(() => generateCommands().length === 1);
  permitted = false; permissionRemoved.emit({ origins: [`${WEBCHAT_ORIGIN}/*`] });
  await rejected; assert.ok(ports[0].disconnected); assert.equal(generateCommands().length, 1);
  assert.equal(permissionRemoved.listeners.length, 0);
});
test('navigation during the initial document lookup prevents even content-script injection', async () => {
  await manager.saveWebChatConfig(config);
  frameRead = () => { updated.emit(7, { status: 'loading' }); };
  await assert.rejects(generate(), /关闭或跳转/);
  assert.equal(injected, 0); assert.equal(commands.length, 0);
});
test('an older status response cannot overwrite a newer explicit refresh', async () => {
  const held: { port: MockPort; command: WebChatPageCommand }[] = [];
  response = (port, command) => { held.push({ port, command }); };
  const first = manager.refreshWebChat(); await waitFor(() => held.length === 1);
  const second = manager.refreshWebChat(); await waitFor(() => held.length === 2);
  normal(held[1].port, held[1].command); assert.equal((await second).status.state, 'ready');
  held[0].port.event({ type: 'status', id: held[0].command.id, status: { state: 'signedOut', loggedIn: false, models: [] } });
  assert.equal((await first).status.state, 'ready');
});
test('an explicit account refresh clears a previously successful remote conversation association', async () => {
  await manager.saveWebChatConfig(config); await generate();
  const changesBefore = configChanges;
  await manager.refreshWebChat(); assert.equal(configChanges, changesBefore + 1);
  const next = [...input(), { role: 'assistant' as const, content: '完整回答' }, { role: 'user' as const, content: '换账号后继续' }];
  await generate(next);
  assert.equal(generateCommands()[1].conversation, undefined);
});

test('login and model refresh never establish generation capability even if a page claims it', async () => {
  response = (port, command) => {
    if (command.type === 'status') port.event({ type: 'status', id: command.id, status: { ...ready, generation: 'working', lastFailure: { stage: 'conversation', code: 'network', raw: 'secret' } } });
  };
  const view = await manager.refreshWebChat();
  assert.equal(view.status.state, 'ready'); assert.equal(view.status.loggedIn, true);
  assert.equal(view.status.generation, 'unchecked'); assert.equal(view.status.lastFailure, undefined);
  assert.equal(generateCommands().length, 0);
});

test('a refused generation preserves login and models but records only safe failure diagnostics', async () => {
  await manager.saveWebChatConfig(config); await manager.refreshWebChat();
  response = (port, command) => {
    if (command.type === 'generate') port.event({ type: 'error', id: command.id, code: 'accessDenied', stage: 'conversation', httpStatus: 403, body: 'access-token-secret', message: 'private account response', authorization: 'Bearer secret' });
  };
  await assert.rejects(generate(), error => error instanceof Error && /拒绝/.test(error.message) && !/验证|secret|private/.test(error.message));
  const status = (await manager.getWebChatView()).status;
  assert.equal(status.state, 'ready'); assert.equal(status.loggedIn, true);
  assert.deepEqual(status.models, ready.models); assert.equal(status.accountLabel, ready.accountLabel);
  assert.equal(status.generation, 'blocked');
  assert.deepEqual(status.lastFailure, { stage: 'conversation', httpStatus: 403, code: 'accessDenied' });
  assert.equal(generateCommands().length, 1); assert.ok(!JSON.stringify(status).includes('secret'));
});

test('only completed generation establishes working capability and a manual retry can recover from blocked', async () => {
  await manager.saveWebChatConfig(config); await manager.refreshWebChat(); await generate();
  assert.equal((await manager.getWebChatView()).status.generation, 'working');
  response = (port, command) => { if (command.type === 'generate') port.event({ type: 'error', id: command.id, code: 'quota', stage: 'conversation', httpStatus: 429 }); };
  await assert.rejects(generate(), /额度/);
  assert.equal((await manager.getWebChatView()).status.generation, 'blocked');
  assert.equal(generateCommands().length, 2, 'failure must not trigger retries');
  response = normal; await generate(input('明确手动再试'));
  const status = (await manager.getWebChatView()).status;
  assert.equal(status.generation, 'working'); assert.equal(status.lastFailure, undefined);
  assert.equal(generateCommands().length, 3);
});

test('refresh after blocked checks login only and clears the old generation failure without claiming recovery', async () => {
  await manager.saveWebChatConfig(config); await manager.refreshWebChat();
  response = (port, command) => { if (command.type === 'generate') port.event({ type: 'error', id: command.id, code: 'format', stage: 'conversation' }); };
  await assert.rejects(generate(), /响应格式/);
  response = normal; const view = await manager.refreshWebChat();
  assert.equal(view.status.generation, 'unchecked'); assert.equal(view.status.lastFailure, undefined);
  assert.equal(view.status.loggedIn, true); assert.equal(generateCommands().length, 1);
});

test('session expiration during send clears identity while conversation denial leaves login intact', async () => {
  await manager.saveWebChatConfig(config); await manager.refreshWebChat();
  response = (port, command) => { if (command.type === 'generate') port.event({ type: 'error', id: command.id, code: 'signedOut', stage: 'session', httpStatus: 401 }); };
  await assert.rejects(generate(), /登录/);
  const status = (await manager.getWebChatView()).status;
  assert.equal(status.state, 'signedOut'); assert.equal(status.loggedIn, false); assert.deepEqual(status.models, []);
  assert.equal(status.generation, 'blocked'); assert.deepEqual(status.lastFailure, { stage: 'session', httpStatus: 401, code: 'signedOut' });
});

test('unsupported page diagnostics cannot smuggle arbitrary text into a cached failure', async () => {
  await manager.saveWebChatConfig(config); await manager.refreshWebChat();
  response = (port, command) => { if (command.type === 'generate') port.event({ type: 'error', id: command.id, code: 'accessDenied', stage: 'private-secret', httpStatus: 999, message: 'secret' }); };
  await assert.rejects(generate(), /拒绝/);
  const status = (await manager.getWebChatView()).status;
  assert.deepEqual(status.lastFailure, { stage: 'conversation', code: 'accessDenied' });
  assert.ok(!JSON.stringify(status).includes('secret'));
});

test('changing the selected model invalidates prior generation success without discarding account models', async () => {
  await manager.saveWebChatConfig(config); await manager.refreshWebChat(); await generate();
  assert.equal((await manager.getWebChatView()).status.generation, 'working');
  const view = await manager.saveWebChatConfig({ provider: 'chatgptWeb', model: 'another-model' });
  assert.equal(view.status.generation, 'unchecked'); assert.equal(view.status.lastFailure, undefined);
  assert.equal(view.status.loggedIn, true); assert.deepEqual(view.status.models, ready.models);
  assert.equal(generateCommands().length, 1);
});
test('a failed model refresh retains its safe HTTP 200 format diagnosis and never generates', async () => {
  response = (port, command) => {
    if (command.type === 'status') port.event({ type: 'error', id: command.id, code: 'format', stage: 'models', httpStatus: 200, message: 'private response' });
  };
  const view = await manager.refreshWebChat();
  assert.equal(view.status.state, 'error'); assert.equal(view.status.generation, 'unchecked');
  assert.deepEqual(view.status.lastFailure, { stage: 'models', httpStatus: 200, code: 'format' });
  assert.equal(generateCommands().length, 0); assert.ok(!JSON.stringify(view).includes('private response'));
});

const pageConfig = { provider: 'chatgptWeb' as const, transport: 'page' as const, model: 'follow-page' };
test('page transport canonicalizes its model and rejects unknown transport settings', async () => {
  const view = await manager.saveWebChatConfig({ provider: 'chatgptWeb', transport: 'page' } as typeof pageConfig);
  assert.deepEqual(view.config, pageConfig); assert.deepEqual(store.webChatConfig, pageConfig);
  assert.throws(() => manager.saveWebChatConfig({ ...pageConfig, transport: 'untrusted' } as never), /配置无效/);
  assert.equal(injected + created, 0);
});
test('page status checks never claim or inject another existing ChatGPT tab', async () => {
  await manager.saveWebChatConfig(pageConfig);
  const view = await manager.refreshWebChat();
  assert.equal(view.status.state, 'missingTab'); assert.equal(view.status.transport, 'page');
  assert.equal(injected + created + focused, 0); assert.equal(commands.length, 0);
  assert.equal(tabs[0].url, `${WEBCHAT_ORIGIN}/c/open`);
});
test('explicit page open creates a dedicated foreground tab and DOM status cannot claim generation success', async () => {
  await manager.saveWebChatConfig(pageConfig); await manager.openChatgptLogin();
  assert.equal(created, 1); assert.equal(focused, 0); assert.equal(createdOptions[0].active, true);
  const view = await manager.refreshWebChat();
  assert.equal(view.status.state, 'ready'); assert.equal(view.status.transport, 'page');
  assert.equal(view.status.generation, 'unchecked'); assert.equal(view.status.accountLabel, undefined);
  assert.deepEqual(view.status.models, [{ id: 'follow-page', label: '跟随官网当前模型' }]);
  assert.deepEqual(injectionFiles, ['webchat-page-content.js']); assert.equal(ports[0].name, WEBCHAT_PAGE_PORT);
  assert.notEqual(ports[0].tabId, 7); assert.equal(generateCommands().length, 0);
  await settle(); assert.deepEqual(sessionStore.webChatOwnedPage, { tabId: 101, documentId, route: '/' });
});
test('page send automatically creates an inactive owned tab and binds completion to its actual SPA route', async () => {
  await manager.saveWebChatConfig(pageConfig);
  assert.equal(await generate(), '完整回答');
  assert.equal(created, 1); assert.equal(createdOptions[0].active, false);
  assert.notEqual(ports[0].tabId, 7); assert.equal(ports[0].name, WEBCHAT_PAGE_PORT);
  assert.equal(tabs[0].url, `${WEBCHAT_ORIGIN}/c/open`);
  assert.deepEqual(injectionFiles, ['webchat-page-content.js']);
  await settle();
  assert.deepEqual(sessionStore.webChatOwnedPage, { tabId: 101, documentId, route: '/c/conversation-1' });
  assert.ok(!JSON.stringify(sessionStore).includes('完整回答')); assert.ok(!JSON.stringify(sessionStore).includes('secret'));
});
test('a completed first page send without a prior refresh establishes actual readiness and successful generation', async () => {
  await manager.saveWebChatConfig(pageConfig);
  assert.equal((await manager.getWebChatView()).status.state, 'unchecked');
  assert.equal(await generate(), '完整回答');
  assert.deepEqual((await manager.getWebChatView()).status, {
    state: 'ready', loggedIn: true, models: [{ id: 'follow-page', label: '跟随官网当前模型' }], transport: 'page', generation: 'working'
  });
  assert.equal(commands.filter(command => command.type === 'status').length, 0);
  assert.equal(generateCommands().length, 1);
});
test('Chrome same-document history loading and URL in one update preserve the owned first turn and continuation', async () => {
  await manager.saveWebChatConfig(pageConfig);
  response = (port, command) => {
    if (command.type !== 'generate') return normal(port, command);
    const tab = tabs.find(item => item.id === port.tabId)!;
    tab.url = `${WEBCHAT_ORIGIN}/c/conversation-1`; tab.status = 'loading';
    updated.emit(port.tabId, { status: 'loading', url: tab.url });
    // A history update keeps the same top document; Chrome completes it without
    // a committed navigation. The final document check still runs on completion.
    setTimeout(() => { tab.status = 'complete'; updated.emit(port.tabId, { status: 'complete' }); normal(port, command); }, 5);
  };
  assert.equal(await generate(), '完整回答');
  const next = [...input(), { role: 'assistant' as const, content: '完整回答' }, { role: 'user' as const, content: '继续' }];
  assert.equal(await generate(next), '完整回答');
  assert.equal(created, 1); assert.equal(generateCommands().length, 2);
  assert.deepEqual(generateCommands()[1].conversation, { id: 'conversation-1', parentId: 'assistant-1' });
  assert.equal((await manager.getWebChatView()).status.generation, 'working');
});
test('page loading cannot conceal a committed replacement document or allow its stale completion', async () => {
  await manager.saveWebChatConfig(pageConfig); response = () => {};
  const pending = generate(); const rejected = assert.rejects(pending, /连接页面已更新/);
  await waitFor(() => generateCommands().length === 1);
  const port = ports.at(-1)!, command = generateCommands()[0];
  updated.emit(port.tabId, { status: 'loading', url: `${WEBCHAT_ORIGIN}/` });
  documentId = 'replacement-document';
  committed.emit({ tabId: port.tabId, frameId: 0, documentId } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
  await rejected; await settle();
  port.event({ type: 'done', id: command.id, text: '迟到', conversation: { id: 'conversation-1', parentId: 'assistant-1' } });
  assert.ok(port.disconnected); assert.equal(sessionStore.webChatOwnedPage, undefined);
  assert.equal(generateCommands().length, 1);
});
test('new owned pages wait through their trusted initial blank pending navigation before injection', async () => {
  await manager.saveWebChatConfig(pageConfig);
  creation = tab => {
    tab.url = ''; tab.pendingUrl = `${WEBCHAT_ORIGIN}/`; tab.status = 'loading';
    setTimeout(() => { tab.url = `${WEBCHAT_ORIGIN}/`; delete tab.pendingUrl; tab.status = 'complete'; updated.emit(tab.id!, { url: tab.url, status: 'complete' }); }, 130);
  };
  assert.equal(await generate(), '完整回答'); assert.equal(created, 1); assert.equal(injected, 1);
  assert.equal(generateCommands().length, 1); assert.equal(ports[0].tabId, 101);
});
test('a cancelled new-tab creation cannot restore ownership after reset', async () => {
  await manager.saveWebChatConfig(pageConfig);
  creation = () => manager.resetWebChatConversation();
  await assert.rejects(generate(), { name: 'AbortError' }); await settle();
  assert.equal(created, 1); assert.equal(injected, 0); assert.equal(generateCommands().length, 0);
  assert.equal(sessionStore.webChatOwnedPage, undefined);
});
test('an owned page with a replaced document is rejected before any generate command', async () => {
  await manager.saveWebChatConfig(pageConfig); await manager.openChatgptLogin(); await manager.refreshWebChat();
  documentId = 'reloaded-document';
  await assert.rejects(generate(), /连接页面已更新/); await settle();
  assert.equal(generateCommands().length, 0); assert.equal(sessionStore.webChatOwnedPage, undefined);
  response = normal; await generate(); assert.equal(created, 2); assert.equal(generateCommands().length, 1);
});
test('opening a valid owned page focuses it without resetting conversation or creating another tab', async () => {
  await manager.saveWebChatConfig(pageConfig); await generate();
  await manager.openChatgptLogin(); assert.equal(created, 1); assert.equal(focused, 1);
  const next = [...input(), { role: 'assistant' as const, content: '完整回答' }, { role: 'user' as const, content: '继续' }];
  await generate(next); assert.equal(created, 1);
  assert.deepEqual(generateCommands()[1].conversation, { id: 'conversation-1', parentId: 'assistant-1' });
});
test('page signed-out errors clear cached login and preserve the dedicated page for manual login', async () => {
  await manager.saveWebChatConfig(pageConfig); await manager.openChatgptLogin(); await manager.refreshWebChat();
  response = (port, command) => { if (command.type === 'generate') port.event({ type: 'error', id: command.id, code: 'signedOut', stage: 'conversation' }); };
  await assert.rejects(generate(), /登录/); await settle();
  const view = await manager.getWebChatView(); assert.equal(view.status.loggedIn, false); assert.equal(view.status.state, 'signedOut');
  assert.equal(view.status.transport, 'page'); assert.deepEqual(view.status.models, []);
  assert.ok(sessionStore.webChatOwnedPage);
  await manager.openChatgptLogin(); assert.equal(created, 1); assert.equal(focused, 1);
  assert.equal(generateCommands().length, 1);
});
test('page continuation reuses only an exact completed local prefix and starts unrelated chats in fresh tabs', async () => {
  await manager.saveWebChatConfig(pageConfig); await generate();
  const next = [...input(), { role: 'assistant' as const, content: '完整回答' }, { role: 'user' as const, content: '继续' }];
  await generate(next);
  assert.equal(created, 1); assert.deepEqual(generateCommands()[1].conversation, { id: 'conversation-1', parentId: 'assistant-1' });
  assert.equal(ports[0].tabId, ports[1].tabId);
  await generate(input('全新问题'));
  assert.equal(created, 2); assert.equal(generateCommands()[2].conversation, undefined);
  assert.notEqual(ports[1].tabId, ports[2].tabId);
});
test('page reset leaves the old conversation intact and next send creates a new owned page', async () => {
  await manager.saveWebChatConfig(pageConfig); await generate(); const previous = ports[0].tabId;
  manager.resetWebChatConversation(); await settle(); assert.equal(sessionStore.webChatOwnedPage, undefined);
  await generate(); assert.equal(created, 2); assert.notEqual(ports[1].tabId, previous);
  assert.equal(tabs.find(tab => tab.id === previous)!.url, `${WEBCHAT_ORIGIN}/c/conversation-1`);
  assert.equal((await manager.getWebChatView()).status.generation, 'working');
});
test('page failures detach ownership and never retry a user message through either transport', async () => {
  await manager.saveWebChatConfig(pageConfig);
  response = (port, command) => { if (command.type === 'generate') port.event({ type: 'error', id: command.id, code: 'pageBusy', stage: 'conversation', message: 'private draft' }); };
  await assert.rejects(generate(), /正在处理另一项请求/); await settle();
  assert.equal(generateCommands().length, 1); assert.equal(created, 1); assert.equal(sessionStore.webChatOwnedPage, undefined);
  assert.deepEqual((await manager.getWebChatView()).status.lastFailure, { stage: 'conversation', code: 'pageBusy' });
  response = normal; await generate(input('手动重试'));
  assert.equal(created, 2); assert.equal(generateCommands().length, 2);
  assert.ok(ports.every(port => port.name === WEBCHAT_PAGE_PORT));
});
test('page route changes to another conversation cancel the current operation and reject stale completion', async () => {
  await manager.saveWebChatConfig(pageConfig); await generate(); response = () => {};
  const next = [...input(), { role: 'assistant' as const, content: '完整回答' }, { role: 'user' as const, content: '继续' }];
  const pending = generate(next); const rejected = assert.rejects(pending, /连接页面已更新/);
  await waitFor(() => generateCommands().length === 2);
  const port = ports.at(-1)!; const command = generateCommands().at(-1)!;
  tabs.find(tab => tab.id === port.tabId)!.url = `${WEBCHAT_ORIGIN}/c/another`;
  updated.emit(port.tabId, { url: `${WEBCHAT_ORIGIN}/c/another` }); await rejected; await settle();
  port.event({ type: 'done', id: command.id, text: '迟到', conversation: { id: 'another', parentId: 'late' } });
  assert.ok(port.disconnected); assert.equal(sessionStore.webChatOwnedPage, undefined);
  assert.equal(generateCommands().length, 2);
});
test('page completion cannot report an id belonging to a different URL', async () => {
  await manager.saveWebChatConfig(pageConfig);
  response = (port, command) => { if (command.type === 'generate') port.event({ type: 'done', id: command.id, text: '回答', conversation: { id: 'unrelated', parentId: 'assistant' } }); };
  await assert.rejects(generate(), /连接页面已更新/); assert.equal(generateCommands().length, 1);
});
test('closing an owned page between turns reconstructs context once in a new background tab', async () => {
  await manager.saveWebChatConfig(pageConfig); await manager.openChatgptLogin(); await manager.refreshWebChat(); await generate();
  const closed = ports.at(-1)!.tabId; tabs = tabs.filter(tab => tab.id !== closed); removed.emit(closed);
  const next = [...input(), { role: 'assistant' as const, content: '完整回答' }, { role: 'user' as const, content: '继续' }];
  await generate(next); assert.equal(created, 2); assert.equal(createdOptions[1].active, false);
  assert.equal(generateCommands()[1].conversation, undefined); assert.deepEqual(generateCommands()[1].messages, next);
  assert.equal((await manager.getWebChatView()).status.state, 'ready');
});
test('page heartbeat keeps the Port alive during long computation but never extends the total timeout', async () => {
  await manager.saveWebChatConfig(pageConfig); const limits = { ...manager.WEBCHAT_TIMEOUTS };
  Object.assign(manager.WEBCHAT_TIMEOUTS, { pageTotal: 90, idle: 30 });
  let pulse: ReturnType<typeof setInterval> | undefined;
  response = (port, command) => { if (command.type === 'generate') pulse = setInterval(() => port.event({ type: 'heartbeat', id: command.id }), 10); };
  const start = Date.now();
  try {
    await assert.rejects(generate(), /超时/);
    assert.ok(Date.now() - start >= 65, 'heartbeats must prevent the short idle timeout');
    assert.ok(Date.now() - start < 500, 'heartbeats must not extend the total timeout');
    assert.equal(generateCommands().length, 1);
  } finally { clearInterval(pulse); Object.assign(manager.WEBCHAT_TIMEOUTS, limits); }
});
test('page refresh reads the owned DOM but next generation starts fresh after dropping remote continuation', async () => {
  await manager.saveWebChatConfig(pageConfig); await generate(); await manager.refreshWebChat();
  const next = [...input(), { role: 'assistant' as const, content: '完整回答' }, { role: 'user' as const, content: '继续' }];
  await generate(next); assert.equal(created, 2); assert.equal(generateCommands()[1].conversation, undefined);
});
