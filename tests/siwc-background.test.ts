import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompletionMessage } from '../src/model';
import { SiwcFailure } from '../src/siwc-protocol';

type Loose = Record<string, any>;
class Hub { listeners: ((...args: any[]) => any)[] = []; addListener = (fn: (...args: any[]) => any) => { this.listeners.push(fn); }; emit(...args: any[]) { for (const fn of this.listeners) fn(...args); } }
const listener = new Hub();
const connected = new Hub();
const local: Loose = {}, session: Loose = {};
const nativeCommands: string[] = [], requests: { url: string; init: RequestInit }[] = [];
const nativeSecret = 'siwc-synthetic-access-token-DO-NOT-USE';
const account = { id: 'account-1', label: 'Synthetic account', planAuthorized: true };
let nativeStatus: Loose = { version: '0.1.0', state: 'ready', account, accounts: [account], loginPending: false };
let failStream = false, permission = true;
let holdLogin: ((value: unknown) => void) | undefined;
let portCount = 0;
let holdCredential = false;
let failLogout = false;
let malformedTerminal = false;
let customResponse: (() => Response) | undefined;
let holdModels: Promise<void> | undefined;
const extensionId = 'a'.repeat(32);
const api = {
  runtime: {
    id: extensionId, getURL: (file: string) => `chrome-extension://${extensionId}/${file}`, onMessage: listener, onConnect: connected,
    connectNative: (host: string) => {
      assert.equal(host, 'com.yuechuang.helper'); portCount++;
      const onMessage = new Hub(), onDisconnect = new Hub(); let closed = false;
      return { onMessage, onDisconnect, disconnect: () => { if (!closed) { closed = true; portCount--; onDisconnect.emit(); } },
        postMessage: ({ id, command }: Loose) => {
          nativeCommands.push(command);
          if (command === 'getAccessToken' && holdCredential) return;
          if (command === 'login') { holdLogin = value => { if (!closed) onMessage.emit({ id, ok: true, result: value }); }; return; }
          queueMicrotask(() => {
            if (command === 'logout' && failLogout) { if (!closed) onMessage.emit({ id, ok: false, error: { code: 'internalError', message: nativeSecret } }); return; }
            const result = command === 'getAccessToken' ? { accessToken: nativeSecret, expiresAt: Date.now() + 3600_000, accountId: 'account-1' } : command === 'logout' ? { version: '0.1.0', state: 'signedOut', remoteRevocationConfirmed: false } : nativeStatus;
            if (!closed) onMessage.emit({ id, ok: true, result });
          });
        } };
    },
  },
  storage: {
    local: { setAccessLevel: async () => {}, get: async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, structuredClone(local[name])])), set: async (value: Loose) => Object.assign(local, structuredClone(value)) },
    session: { setAccessLevel: async () => {}, get: async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, structuredClone(session[name])])), set: async (value: Loose) => Object.assign(session, structuredClone(value)), remove: async (key: string) => { delete session[key]; } },
  },
  permissions: { contains: async () => permission },
};
Object.assign(globalThis, { chrome: api });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input); requests.push({ url, init });
  assert.equal((init.headers as Loose).Authorization, `Bearer ${nativeSecret}`);
  assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
  if (url === 'https://api.openai.com/v1/models') { await holdModels; return Response.json({ models: [{ slug: 'gpt-example', display_name: 'Example', visibility: 'list' }] }); }
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal((init.headers as Loose).Accept, 'text/event-stream');
  if (customResponse) return customResponse();
  const events = [{ type: 'response.created', response: { id: 'response-1' } }, { type: 'response.output_text.delta', delta: '连接成功' }, failStream ? { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: nativeSecret } } } : { type: 'response.completed', response: { id: 'response-1', status: malformedTerminal ? 'unknown-private-value' : 'completed', privateSecret: nativeSecret } }];
  return new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
};
const manager = await import('../src/siwc-background');
manager.initializeSiwc(); manager.initializeSiwc();
const sender = { id: extensionId, url: `chrome-extension://${extensionId}/options.html`, origin: `chrome-extension://${extensionId}`, frameId: 0 };
function message(type: string, payload: Loose = {}, source: Loose = sender): Promise<Loose> {
  return new Promise(resolve => { for (const fn of listener.listeners) fn({ type, ...payload }, source, resolve); });
}
const messages: CompletionMessage[] = [{ role: 'system', content: '用中文。' }, { role: 'user', content: '测试' }];

test('passive views launch no helper and foreign pages cannot invoke authentication', async () => {
  assert.equal(listener.listeners.length, 1);
  const view = await message('siwc:get'); assert.equal(view.view.status.state, 'unchecked'); assert.equal(nativeCommands.length, 0);
  for (const source of [{ ...sender, id: 'other' }, { ...sender, url: 'https://example.test/' }, { ...sender, frameId: 2 }, { ...sender, origin: 'https://example.test' }]) assert.equal((await message('siwc:login', {}, source)).ok, false);
  assert.equal(nativeCommands.length, 0); assert.equal(requests.length, 0);
});
test('verified identity without plan permission makes no API request', async () => {
  nativeStatus = { ...nativeStatus, state: 'planDenied', account: { ...account, planAuthorized: false } };
  const result = await message('siwc:refresh');
  assert.equal(result.view.status.loggedIn, true); assert.equal(result.view.status.planAuthorized, false); assert.equal(result.view.status.state, 'planDenied');
  assert.equal(requests.length, 0); assert.equal(portCount, 0);
});
test('official account check reads models without generating and config stores no secrets', async () => {
  nativeStatus = { ...nativeStatus, state: 'ready', account };
  const result = await message('siwc:refresh'); assert.equal(result.view.status.state, 'ready'); assert.equal(result.view.status.generation, 'unchecked');
  assert.deepEqual(requests.map(item => item.url), ['https://api.openai.com/v1/models']);
  const saved = await message('siwc:save', { config: { provider: 'chatgptOAuth', model: 'gpt-example', accessToken: 'ignored' } });
  assert.equal(saved.ok, true); assert.deepEqual(local.webChatConfig, { provider: 'chatgptOAuth', model: 'gpt-example' });
  assert.ok(!JSON.stringify([saved, local, session]).includes(nativeSecret)); assert.equal(portCount, 0);
});
test('chat calls only public Responses and establishes success after terminal completion', async () => {
  const parts: string[] = [];
  const output = await manager.requestSiwc(messages, new AbortController().signal, text => parts.push(text));
  assert.equal(output, '连接成功'); assert.equal(parts.at(-1), output);
  assert.equal((await manager.getSiwcView()).status.generation, 'working');
  const request = requests.at(-1)!; const body = JSON.parse(request.init.body as string);
  assert.equal(body.instructions, '用中文。'); assert.equal(body.store, false); assert.equal(body.stream, true); assert.ok(!body.messages);
  assert.equal(portCount, 0); assert.ok(!JSON.stringify([local, session, await manager.getSiwcView()]).includes(nativeSecret));
});
test('partial usage failure does not retry or report success, secrets never enter diagnostics', async () => {
  failStream = true; const count = requests.length;
  await assert.rejects(manager.requestSiwc(messages, new AbortController().signal, () => {}), (error: unknown) => error instanceof SiwcFailure && error.code === 'quota' && !error.message.includes(nativeSecret));
  assert.equal(requests.length, count + 1); assert.equal((await manager.getSiwcView()).status.generation, 'blocked');
  assert.ok(!JSON.stringify(await manager.getSiwcView()).includes(nativeSecret)); failStream = false;
});
test('login cancellation works while authorization is pending and closes the native port', async () => {
  const pending = message('siwc:login');
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal((await manager.getSiwcView()).status.loginPending, true);
  const cancelled = await message('siwc:cancel'); await pending;
  assert.equal(cancelled.view.status.loginPending, undefined); assert.equal(portCount, 0);
  holdLogin?.(nativeStatus); assert.equal((await manager.getSiwcView()).status.loggedIn, false);
});
test('missing API permission performs no model call and logout reports unconfirmed remote revoke', async () => {
  permission = false; const count = requests.length;
  const view = await message('siwc:refresh'); assert.equal(view.view.status.state, 'permissionRequired'); assert.equal(requests.length, count);
  const out = await message('siwc:logout'); assert.equal(out.view.status.state, 'signedOut'); assert.equal(out.view.status.remoteRevoked, false); assert.equal(portCount, 0);
});
test('real chat controller routes two local turns through the official API without any website or API key', async () => {
  permission = true; await manager.refreshSiwc();
  const { initializeChat } = await import('../src/chat-background'); await initializeChat();
  const onMessage = new Hub(), onDisconnect = new Hub(), sent: Loose[] = [];
  const port = { name: 'chat', sender: { ...sender, url: `chrome-extension://${extensionId}/sidepanel.html` }, onMessage, onDisconnect, postMessage: (value: Loose) => sent.push(structuredClone(value)), disconnect: () => onDisconnect.emit() };
  connected.emit(port);
  const until = async (fn: () => boolean) => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('chat controller did not finish'); };
  await until(() => sent.at(-1)?.settingsReady === true);
  assert.equal(sent.at(-1)?.connection, 'chatgptOAuth');
  onMessage.emit({ type: 'chat:send', text: '第一问' });
  await until(() => sent.at(-1)?.status === 'idle' && sent.at(-1)?.messages.length === 2);
  onMessage.emit({ type: 'chat:send', text: '第二问' });
  await until(() => sent.at(-1)?.status === 'idle' && sent.at(-1)?.messages.length === 4);
  const body = JSON.parse(requests.at(-1)!.init.body as string);
  assert.deepEqual(body.input.map((item: Loose) => item.role), ['user', 'assistant', 'user']);
  assert.equal(body.input[0].content, '第一问'); assert.equal(body.input[2].content, '第二问');
  assert.equal(sent.at(-1)?.siwcStatus.generation, 'working');
  assert.ok(!JSON.stringify([sent, local, session]).includes(nativeSecret));
  port.disconnect();
});
test('stopping while waiting for a native credential closes its host without sending a model request', async () => {
  manager.clearSiwcAccessToken(); holdCredential = true;
  const count = requests.length, controller = new AbortController();
  const pending = manager.requestSiwc(messages, controller.signal, () => {});
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(portCount, 1);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(portCount, 0); assert.equal(requests.length, count); holdCredential = false;
});
test('changing configuration cancels an outstanding login and clears the pending flag', async () => {
  const pending = message('siwc:login');
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal((await manager.getSiwcView()).status.loginPending, true);
  manager.clearSiwcAccessToken(); await pending;
  assert.equal((await manager.getSiwcView()).status.loginPending, false); assert.equal(portCount, 0);
});
test('a failed native logout cannot claim local credentials were cleared', async () => {
  failLogout = true;
  const result = await message('siwc:logout');
  assert.equal(result.ok, false); assert.ok(!result.error.includes(nativeSecret));
  assert.notEqual((await manager.getSiwcView()).status.state, 'signedOut');
  failLogout = false;
});
test('format diagnostics pinpoint terminal shape without server text, identifiers or credentials', async () => {
  await manager.refreshSiwc(); malformedTerminal = true;
  await assert.rejects(manager.requestSiwc(messages, new AbortController().signal, () => {}), (error: unknown) => error instanceof SiwcFailure && error.code === 'format');
  const view = await manager.getSiwcView();
  assert.equal(view.status.diagnostic?.stage, 'completion'); assert.equal(view.status.diagnostic?.reason, 'terminalStatus');
  assert.equal(view.status.diagnostic?.httpStatus, 200); assert.equal(view.status.diagnostic?.contentType, 'text/event-stream');
  assert.equal(view.status.diagnostic?.eventType, 'response.completed'); assert.equal(view.status.diagnostic?.responseStatus, 'other');
  assert.ok(!JSON.stringify(view.status.diagnostic).includes('unknown-private-value'));
  assert.ok(!JSON.stringify(view.status.diagnostic).includes('response-1'));
  assert.ok(!JSON.stringify(view.status.diagnostic).includes('privateSecret'));
  assert.ok(!JSON.stringify(view.status.diagnostic).includes(nativeSecret)); malformedTerminal = false;
});

// Byte streams avoid Response(string)'s automatic text/plain header. Splitting
// every few bytes also exercises the real decoder across UTF-8/SSE boundaries.
function responseWithoutType(text: string): Response {
  const bytes = new TextEncoder().encode(text); let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + 7)); offset = Math.min(bytes.length, offset + 7);
    },
  }));
}
const sse = (...events: Loose[]) => events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('');
const completed = { type: 'response.completed', response: { id: 'synthetic-response', status: 'completed' } };

test('HTTP 200 with no Content-Type accepts a valid chunked Responses stream through completion', async () => {
  await manager.refreshSiwc();
  customResponse = () => responseWithoutType('\ufeff: keepalive\r\n\r\n' + sse(
    { type: 'response.created', response: { id: 'synthetic-response', status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: '连接测试成功。' }, completed,
  ));
  try {
    const count = requests.length, parts: string[] = [];
    assert.equal(await manager.requestSiwc(messages, new AbortController().signal, text => parts.push(text)), '连接测试成功。');
    assert.equal(parts.at(-1), '连接测试成功。'); assert.equal(requests.length, count + 1);
    const view = await manager.getSiwcView(); assert.equal(view.status.generation, 'working'); assert.equal(view.status.diagnostic, undefined);
  } finally { customResponse = undefined; }
});

test('missing Content-Type does not accept HTML, plain JSON or empty HTTP 200 bodies as answers', async () => {
  for (const body of ['<!doctype html><h1>PRIVATE_GATEWAY_PAGE</h1>', JSON.stringify({ output_text: 'PRIVATE_JSON_ANSWER', status: 'completed' }), '']) {
    customResponse = () => responseWithoutType(body);
    try {
      const count = requests.length, parts: string[] = [];
      await assert.rejects(manager.requestSiwc(messages, new AbortController().signal, text => parts.push(text)), (error: unknown) => error instanceof SiwcFailure && error.reason === 'streamEnded');
      assert.equal(parts.length, 0); assert.equal(requests.length, count + 1);
      const view = await manager.getSiwcView(); assert.equal(view.status.generation, 'blocked');
      assert.equal(view.status.diagnostic?.contentType, 'missing'); assert.equal(view.status.diagnostic?.httpStatus, 200);
      assert.ok(!JSON.stringify(view).includes('PRIVATE_'));
    } finally { customResponse = undefined; }
  }
});

test('missing Content-Type preserves terminal quota failures and partial text without retry', async () => {
  customResponse = () => responseWithoutType(sse(
    { type: 'response.output_text.delta', delta: '已收到的片段' },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: nativeSecret } } },
  ));
  try {
    const count = requests.length, parts: string[] = [];
    await assert.rejects(manager.requestSiwc(messages, new AbortController().signal, text => parts.push(text)), (error: unknown) => error instanceof SiwcFailure && error.code === 'quota');
    assert.equal(parts.at(-1), '已收到的片段'); assert.equal(requests.length, count + 1);
    const view = await manager.getSiwcView(); assert.equal(view.status.generation, 'blocked'); assert.equal(view.status.diagnostic?.contentType, 'missing');
    assert.equal(view.status.diagnostic?.eventType, 'response.failed'); assert.ok(!JSON.stringify(view).includes(nativeSecret));
  } finally { customResponse = undefined; }
});

test('missing Content-Type still requires response.completed and a valid terminal status', async () => {
  for (const terminal of ['', sse({ type: 'response.completed', response: { status: 'failed' } })]) {
    customResponse = () => responseWithoutType(sse({ type: 'response.output_text.delta', delta: '片段' }) + terminal);
    try {
      const count = requests.length;
      await assert.rejects(manager.requestSiwc(messages, new AbortController().signal, () => {}), (error: unknown) => error instanceof SiwcFailure && error.reason === (terminal ? 'terminalStatus' : 'streamEnded'));
      assert.equal(requests.length, count + 1); assert.equal((await manager.getSiwcView()).status.generation, 'blocked');
    } finally { customResponse = undefined; }
  }
});

test('an explicitly incompatible Content-Type remains rejected before any body read', async () => {
  for (const type of ['text/html', 'application/json', 'text/plain']) {
    let reads = 0;
    customResponse = () => {
      const response = new Response(new Uint8Array(), { headers: { 'Content-Type': type } });
      Object.defineProperty(response, 'body', { get() { return { getReader() { reads++; throw new Error('must not read'); } }; } });
      return response;
    };
    try {
      await assert.rejects(manager.requestSiwc(messages, new AbortController().signal, () => {}), (error: unknown) => error instanceof SiwcFailure && error.code === 'format' && error.reason === 'nonEventStream');
      assert.equal(reads, 0); assert.equal((await manager.getSiwcView()).status.diagnostic?.stage, 'headers');
    } finally { customResponse = undefined; }
  }
});

test('opening or reconnecting chat during an assistant refresh waits for the current model check', async () => {
  let release!: () => void;
  holdModels = new Promise<void>(resolve => { release = resolve; });
  const callsBefore = requests.length, commandsBefore = nativeCommands.length;
  const refreshing = manager.refreshSiwc();
  try {
    for (let i = 0; requests.length === callsBefore && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(requests.length, callsBefore + 1);
    assert.equal((await manager.getSiwcView()).status.state, 'ready');
    assert.deepEqual((await manager.getSiwcView()).status.models, []);
    let settled = false;
    const ready = manager.ensureSiwcReady().then(view => { settled = true; return view; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'a reconnect must not treat the in-progress empty model catalog as final');
    release();
    const [view, current] = await Promise.all([ready, refreshing]);
    assert.equal(view.status.state, 'ready'); assert.deepEqual(view.status.models, current.status.models);
    assert.equal(view.status.models[0].id, 'gpt-example'); assert.equal(requests.length, callsBefore + 1);
    assert.deepEqual(nativeCommands.slice(commandsBefore), ['status', 'getAccessToken']);
  } finally { release(); holdModels = undefined; await refreshing; }
});

test('passive chat recovery during official authorization cannot cancel or replace the pending login', async () => {
  const pending = message('siwc:login');
  const onMessage = new Hub(), onDisconnect = new Hub(), sent: Loose[] = [];
  const port = { name: 'chat', sender: { ...sender, url: `chrome-extension://${extensionId}/sidepanel.html` }, onMessage, onDisconnect, postMessage: (value: Loose) => sent.push(structuredClone(value)), disconnect: () => onDisconnect.emit() };
  try {
    for (let i = 0; !(await manager.getSiwcView()).status.loginPending && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal((await manager.getSiwcView()).status.loginPending, true);
    const commandsBefore = nativeCommands.length, callsBefore = requests.length;
    const views = await Promise.all([manager.ensureSiwcReady(), manager.ensureSiwcReady()]);
    assert.ok(views.every(view => view.status.loginPending === true));
    connected.emit(port); onMessage.emit({ type: 'chat:status' });
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.at(-1)?.siwcStatus.loginPending, true);
    assert.equal(nativeCommands.length, commandsBefore); assert.equal(requests.length, callsBefore);
    assert.equal(portCount, 1);
    holdLogin?.(nativeStatus);
    const result = await pending;
    assert.equal(result.ok, true); assert.equal(result.view.status.state, 'ready');
    assert.equal(result.view.status.loginPending, false); assert.equal(portCount, 0);
  } finally { port.disconnect(); await message('siwc:cancel'); await pending; }
});

test('official chat automatically offers search and checkpoints only safe progress and citations', async () => {
  await manager.refreshSiwc();
  const { CHAT_SESSION_KEY } = await import('../src/chat-shared');
  const onMessage = new Hub(), onDisconnect = new Hub(), sent: Loose[] = [];
  const port = { name: 'chat', sender: { ...sender, url: `chrome-extension://${extensionId}/sidepanel.html` }, onMessage, onDisconnect, postMessage: (value: Loose) => sent.push(structuredClone(value)), disconnect: () => onDisconnect.emit() };
  const wait = async (predicate: () => boolean) => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw new Error('search chat state not reached'); };
  customResponse = () => new Response(sse(
    { type: 'response.web_search_call.searching', item_id: 'search-1', output_index: 0 },
    { type: 'response.output_text.delta', delta: '这是可核实的资料。' },
    { type: 'response.completed', response: { status: 'completed', output: [
      { id: 'search-1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'PRIVATE_QUERY' } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '这是可核实的资料。', annotations: [
        { type: 'url_citation', start_index: 0, end_index: 4, url: 'https://example.test/source', title: '资料来源', accessToken: nativeSecret },
        { type: 'url_citation', start_index: 0, end_index: 4, url: 'javascript:alert(1)', title: '无效来源' },
      ] }] },
    ] } },
  ), { headers: { 'Content-Type': 'text/event-stream' } });
  connected.emit(port);
  try {
    await wait(() => sent.at(-1)?.settingsReady === true);
    const before = requests.length, previous = sent.at(-1)?.requestId;
    onMessage.emit({ type: 'chat:send', text: '请查阅最新资料' });
    await wait(() => sent.at(-1)?.requestId !== previous && sent.at(-1)?.status === 'idle');
    assert.equal(requests.length, before + 1);
    const body = JSON.parse(requests.at(-1)!.init.body as string);
    assert.deepEqual(body.tools, [{ type: 'web_search' }]); assert.equal(body.tool_choice, 'auto');
    assert.ok(sent.some(state => state.messages.at(-1)?.search?.state === 'searching'));
    const answer = sent.at(-1)!.messages.at(-1);
    assert.deepEqual(answer.search, { state: 'complete', calls: 1 });
    assert.deepEqual(answer.citations, [{ start: 0, end: 4, url: 'https://example.test/source', title: '资料来源' }]);
    assert.deepEqual(session[CHAT_SESSION_KEY].messages.at(-1).citations, answer.citations);
    assert.ok(!JSON.stringify([sent, session[CHAT_SESSION_KEY]]).includes(nativeSecret));
    assert.ok(!JSON.stringify([sent, session[CHAT_SESSION_KEY]]).includes('PRIVATE_QUERY'));
  } finally { customResponse = undefined; port.disconnect(); }
});

test('unsupported search capability reports the fixed admission error without automatic retry or logout', async () => {
  customResponse = () => Response.json({ error: { code: 'subscription_sharing_unsupported_capability', param: 'tools[0].type', message: nativeSecret } }, { status: 400 });
  try {
    const count = requests.length;
    await assert.rejects(manager.requestSiwc(messages, new AbortController().signal, () => {}), (error: unknown) => error instanceof SiwcFailure && error.code === 'unsupportedCapability' && !error.message.includes(nativeSecret));
    const view = await manager.getSiwcView();
    assert.equal(requests.length, count + 1); assert.equal(view.status.loggedIn, true); assert.equal(view.status.generation, 'blocked');
    assert.equal(view.status.diagnostic?.httpStatus, 400); assert.ok(!JSON.stringify(view).includes(nativeSecret));
  } finally { customResponse = undefined; }
});

test('official request records monotonic local timings and preserves authoritative model usage patches', async () => {
  await manager.refreshSiwc();
  const previousPerformance = globalThis.performance;
  let clock = 1000;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clock } });
  customResponse = () => {
    clock = 1100;
    return new Response(sse(
      { type: 'response.created', response: { model: 'provisional-model' } },
      { type: 'response.output_text.delta', delta: '草稿' },
      { type: 'response.completed', response: { status: 'completed', model: 'actual-model', usage: { input_tokens: 7, output_tokens: 0, total_tokens: 7 }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }] } },
    ), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const updates: Loose[] = [], merged: Loose = {};
    assert.equal(await manager.requestSiwc(messages, new AbortController().signal, text => { clock = text === '草稿' ? 1200 : 1400; }, update => {
      updates.push(structuredClone(update));
      if (update.details) Object.assign(merged, update.details, update.details.usage ? { usage: { ...merged.usage, ...update.details.usage } } : {});
    }), '完成');
    assert.deepEqual(merged, { model: 'actual-model', firstTokenMs: 100, usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 }, durationMs: 400 });
    assert.equal(updates.filter(update => update.details?.firstTokenMs !== undefined).length, 1, 'canonical final text cannot reset first-token timing');
    assert.deepEqual(updates.at(-1), { details: { durationMs: 400 } });
  } finally { Object.defineProperty(globalThis, 'performance', { configurable: true, value: previousPerformance }); customResponse = undefined; }
});

test('failed requests may report duration but never successful usage, and timing cleanup preserves failures', async () => {
  await manager.refreshSiwc();
  const updates: Loose[] = [];
  customResponse = () => new Response(sse(
    { type: 'response.created', response: { model: 'server-model', usage: { input_tokens: 900 } } },
    { type: 'response.output_text.delta', delta: '片段' },
    { type: 'response.failed', response: { status: 'failed', usage: { input_tokens: 999 }, error: { code: 'subscription_sharing_usage_limit_exceeded' } } },
  ), { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    await assert.rejects(manager.requestSiwc(messages, new AbortController().signal, () => {}, update => {
      updates.push(structuredClone(update));
      if (update.details?.durationMs !== undefined) throw new Error('stale consumer cleanup');
    }), (error: unknown) => error instanceof SiwcFailure && error.code === 'quota');
    assert.ok(updates.some(update => Number.isSafeInteger(update.details?.durationMs)));
    assert.ok(updates.every(update => !update.details?.usage));
  } finally { customResponse = undefined; }
});

test('user cancellation cannot receive final timing or usage updates after its abort', async () => {
  await manager.refreshSiwc();
  const controller = new AbortController(), updates: Loose[] = [];
  customResponse = () => new Response(sse(
    { type: 'response.created', response: { model: 'server-model' } },
    { type: 'response.output_text.delta', delta: '片段' },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 8 } } },
  ), { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    await assert.rejects(manager.requestSiwc(messages, controller.signal, () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    }, update => updates.push(structuredClone(update))), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    assert.ok(updates.some(update => update.details?.model === 'server-model'));
    assert.ok(updates.every(update => update.details?.durationMs === undefined && !update.details?.usage));
  } finally { customResponse = undefined; }
});

test('a preflight failure cannot report a made-up model request duration', async () => {
  permission = false;
  const updates: Loose[] = [], count = requests.length;
  try {
    await assert.rejects(manager.requestSiwc(messages, new AbortController().signal, () => {}, update => updates.push(update)), (error: unknown) => error instanceof SiwcFailure && error.code === 'permission');
    assert.equal(requests.length, count); assert.deepEqual(updates, []);
  } finally { permission = true; }
});
