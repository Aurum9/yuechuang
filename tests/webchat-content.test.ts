import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { resolve } from 'node:path';
import { createContext, Script } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { build } from 'vite';
import { WEBCHAT_ORIGIN, WEBCHAT_PORT, type WebChatPageCommand, type WebChatPageEvent } from '../src/webchat-shared.ts';

class Hub<Args extends unknown[]> {
  listeners: ((...args: Args) => unknown)[] = [];
  addListener = (listener: (...args: Args) => unknown) => { this.listeners.push(listener); };
  emit(...args: Args) { for (const listener of [...this.listeners]) listener(...args); }
}
const ID = 'webchat-content-vm-test', TOKEN_A = 'vm-private-token-A', TOKEN_B = 'vm-private-token-B';
let contentCode = '';
class Port {
  sent: WebChatPageEvent[] = []; disconnected = false;
  onMessage = new Hub<[unknown]>(); onDisconnect = new Hub<[]>();
  constructor(public name = WEBCHAT_PORT, public sender: Partial<chrome.runtime.MessageSender> | undefined = { id: ID, url: `chrome-extension://${ID}/background.js` }) {}
  postMessage(value: WebChatPageEvent) { if (!this.disconnected) this.sent.push(structuredClone(value)); }
  disconnect() { if (!this.disconnected) { this.disconnected = true; this.onDisconnect.emit(); } }
  command(value: unknown) { this.onMessage.emit(value); }
}
interface Call { url: string; init: RequestInit }
function fixture(origin = WEBCHAT_ORIGIN, topLevel = true) {
  const connected = new Hub<[Port]>();
  const pageEvents = new Map<string, () => void>();
  const calls: Call[] = [];
  const state = { identity: 'account-A', token: TOKEN_A, sessionStatus: 200, sessionHtml: false, modelStatus: 200, modelPayload: undefined as unknown, conversationStatus: 200, conversationError: undefined as unknown, holdConversation: false, aborted: 0 };
  const win = { top: undefined as unknown, addEventListener(name: string, callback: () => void) { pageEvents.set(name, callback); } };
  win.top = topLevel ? win : {};
  const context = createContext({
    window: win, location: { origin },
    chrome: { runtime: { id: ID, onConnect: connected } },
    AbortController, AbortSignal, DOMException, Response, ReadableStream, TextDecoder, TextEncoder,
    setTimeout, clearTimeout, crypto: { randomUUID },
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      assert.equal(new URL(url).origin, WEBCHAT_ORIGIN);
      assert.equal(init.credentials, 'include'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
      const headers = init.headers as Record<string, string>;
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === `${WEBCHAT_ORIGIN}/api/auth/session`) {
        assert.equal(headers.Authorization, undefined);
        if (state.sessionHtml) return new Response('<html>Unexpected page</html>', { headers: { 'Content-Type': 'text/html' } });
        return json({ accessToken: state.token, user: { id: state.identity, email: `${state.identity}@example.test` }, unexpected: state.token }, state.sessionStatus);
      }
      assert.equal(headers.Authorization, `Bearer ${state.token}`);
      if (url === `${WEBCHAT_ORIGIN}/backend-api/models`) return json(state.modelPayload ?? { models: [{ slug: 'test-model', title: 'VM model', credential: state.token }] }, state.modelStatus);
      assert.equal(url, `${WEBCHAT_ORIGIN}/backend-api/conversation`); assert.equal(init.method, 'POST');
      if (state.holdConversation) return new Promise<Response>((_resolve, reject) => {
        const abort = () => { state.aborted++; reject(new DOMException('Aborted', 'AbortError')); };
        if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
      });
      if (state.conversationStatus !== 200) return json(state.conversationError ?? { error: state.token, raw_private_error: state.token }, state.conversationStatus);
      const value = { conversation_id: 'conversation-1', message: { id: 'assistant-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [`测试回答 ${state.token}`] }, end_turn: true, status: 'finished_successfully' } };
      return new Response(`data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
  });
  const inject = () => new Script(contentCode, { filename: 'webchat-content.test-bundle.js' }).runInContext(context);
  inject();
  const connect = (port = new Port()) => { connected.emit(port); return port; };
  const postCount = () => calls.filter(call => call.init.method === 'POST').length;
  return { inject, connected, pageEvents, calls, state, connect, postCount };
}
async function settle() { for (let index = 0; index < 8; index++) await nextTurn(); }
async function waitFor(predicate: () => boolean) { const until = Date.now() + 3000; while (!predicate()) { if (Date.now() > until) throw new Error('VM response timeout'); await nextTurn(); } }
async function status(f: ReturnType<typeof fixture>) {
  const port = f.connect(); port.command({ type: 'status', id: randomUUID() });
  await waitFor(() => port.sent.length > 0); await settle(); return port;
}
function generate(port: Port, changes: Partial<Extract<WebChatPageCommand, { type: 'generate' }>> = {}) {
  const command = { type: 'generate', id: randomUUID(), model: 'test-model', messages: [{ role: 'user', content: '你好' }], ...changes };
  port.command(command); return command;
}
before(async () => {
  const output = await build({ configFile: false, publicDir: false, logLevel: 'silent', build: {
    write: false, minify: false, target: 'es2022', emptyOutDir: false,
    lib: { entry: resolve('src/webchat-content.ts'), formats: ['iife'], name: 'ReadingAssistantWebChatTest' },
    rollupOptions: { output: { inlineDynamicImports: true } }
  } });
  const bundles = Array.isArray(output) ? output : [output];
  for (const bundle of bundles) if ('output' in bundle) for (const item of bundle.output) if (item.type === 'chunk') contentCode += item.code;
  assert.ok(contentCode.length > 1000);
});

test('the real content entry runs only at the fixed top-level origin and injects idempotently', () => {
  for (const f of [fixture('https://elsewhere.test'), fixture('https://chatgpt.com.evil.test'), fixture(WEBCHAT_ORIGIN, false)]) {
    assert.equal(f.connected.listeners.length, 0); assert.equal(f.pageEvents.size, 0); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.inject(); f.inject();
  assert.equal(f.connected.listeners.length, 1); assert.deepEqual([...f.pageEvents.keys()], ['pagehide']);
  assert.equal(f.calls.length, 0);
});
test('the content Port rejects foreign senders and ignores unrelated names without any request', async () => {
  const f = fixture();
  for (const sender of [{ id: 'other' }, { id: ID, tab: { id: 4 } }, { id: ID, url: 'https://chatgpt.com/' }]) {
    const port = f.connect(new Port(WEBCHAT_PORT, sender as Partial<chrome.runtime.MessageSender>));
    assert.equal(port.disconnected, true);
    port.command({ type: 'status', id: 'request' });
  }
  const other = f.connect(new Port('ordinary-content-port')); other.command({ type: 'status', id: 'request' });
  await settle(); assert.equal(f.calls.length, 0);
});
test('status accesses only fixed session/models paths and never forwards or stores the token', async () => {
  const f = fixture(); const port = await status(f);
  assert.deepEqual(f.calls.map(call => call.url), [`${WEBCHAT_ORIGIN}/api/auth/session`, `${WEBCHAT_ORIGIN}/backend-api/models`]);
  assert.equal(port.sent[0].type, 'status');
  const event = port.sent[0] as Extract<WebChatPageEvent, { type: 'status' }>;
  assert.equal(event.status.state, 'ready'); assert.equal(event.status.accountLabel, 'account-A@example.test');
  assert.ok(!JSON.stringify(port.sent).includes(TOKEN_A)); assert.equal(f.postCount(), 0);
  port.disconnect();
});
test('a fresh document requires an explicit status check before generating and ignores supplied remote history', async () => {
  const f = fixture(); const port = f.connect();
  generate(port, { conversation: { id: 'old-account-conversation', parentId: 'old-parent' } });
  await waitFor(() => port.sent.length > 0);
  assert.deepEqual(port.sent[0].type, 'error');
  assert.equal((port.sent[0] as Extract<WebChatPageEvent, { type: 'error' }>).code, 'signedOut');
  assert.equal(f.postCount(), 0); assert.ok(!JSON.stringify(port.sent).includes(TOKEN_A));
});
test('generation uses the checked account, streams sanitized text and preserves OpenAI history intentionally', async () => {
  const f = fixture(); (await status(f)).disconnect(); const port = f.connect();
  generate(port); await waitFor(() => port.sent.some(event => event.type === 'done')); await settle();
  const post = f.calls.find(call => call.init.method === 'POST')!;
  const body = JSON.parse(post.init.body as string);
  assert.equal(body.history_and_training_disabled, false); assert.equal(body.model, 'test-model');
  assert.ok(port.sent.some(event => event.type === 'text' && event.text.includes('[已隐藏登录凭据]')));
  assert.ok(!JSON.stringify(port.sent).includes(TOKEN_A));
  assert.equal(f.postCount(), 1); port.disconnect();
});
test('changing the webpage account rejects the old conversation without a POST until checked again', async () => {
  const f = fixture(); (await status(f)).disconnect();
  f.state.identity = 'account-B'; f.state.token = TOKEN_B;
  const first = f.connect(); generate(first, { conversation: { id: 'account-A-conversation', parentId: 'account-A-parent' } });
  await waitFor(() => first.sent.length > 0); await settle();
  assert.equal((first.sent[0] as Extract<WebChatPageEvent, { type: 'error' }>).code, 'signedOut'); assert.equal(f.postCount(), 0);
  assert.ok(!JSON.stringify(first.sent).includes(TOKEN_A)); assert.ok(!JSON.stringify(first.sent).includes(TOKEN_B)); first.disconnect();
  const checked = await status(f); assert.equal((checked.sent[0] as Extract<WebChatPageEvent, { type: 'status' }>).status.accountLabel, 'account-B@example.test'); checked.disconnect();
  const second = f.connect(); generate(second); await waitFor(() => second.sent.some(event => event.type === 'done'));
  assert.equal(f.postCount(), 1); assert.ok(!JSON.stringify(second.sent).includes(TOKEN_B)); second.disconnect();
});
test('cancel, closing the Port and pagehide abort the actual in-flight fetch with no automatic retry', async () => {
  for (const action of ['cancel', 'disconnect', 'pagehide']) {
    const f = fixture(); (await status(f)).disconnect(); f.state.holdConversation = true;
    const port = f.connect(); const command = generate(port);
    await waitFor(() => f.postCount() === 1);
    if (action === 'cancel') port.command({ type: 'cancel', id: command.id });
    else if (action === 'disconnect') port.disconnect();
    else f.pageEvents.get('pagehide')!();
    await waitFor(() => f.state.aborted === 1); await settle();
    assert.equal(f.postCount(), 1);
    assert.ok(!port.sent.some(event => event.type === 'done')); assert.ok(!JSON.stringify(port.sent).includes(TOKEN_A));
    port.disconnect();
  }
});
test('unknown commands and malformed inputs cannot select other endpoints or start requests', async () => {
  const f = fixture(); const port = f.connect();
  for (const command of [null, {}, { type: 'fetch', id: 'request', url: 'https://elsewhere.test' }, { type: 'status', id: '../bad' }, { type: 'generate', id: 'request', model: 'bad model', messages: [{ role: 'user', content: 'hello' }] }]) port.command(command);
  await settle(); assert.equal(f.calls.length, 0); assert.equal(port.sent.length, 0); port.disconnect();
});
test('HTTP authentication, quota and generic refusal report safe stage and status without response-body details', async () => {
  const f = fixture(); f.state.sessionStatus = 401;
  let port = await status(f);
  assert.deepEqual(port.sent[0], { type: 'error', id: port.sent[0].id, code: 'signedOut', stage: 'session', httpStatus: 401 }); port.disconnect();
  f.state.sessionStatus = 200; (await status(f)).disconnect();
  for (const [httpStatus, expected] of [[429, 'quota'], [403, 'accessDenied'], [400, 'format']] as const) {
    f.state.conversationStatus = httpStatus; port = f.connect(); generate(port);
    await waitFor(() => port.sent.length > 0); await settle();
    assert.deepEqual(port.sent[0], { type: 'error', id: port.sent[0].id, code: expected, stage: 'conversation', httpStatus });
    assert.ok(!JSON.stringify(port.sent).includes(TOKEN_A)); port.disconnect();
  }
});
test('non-JSON login response reports format/session/200 and never invents a verification requirement', async () => {
  const f = fixture(); f.state.sessionHtml = true; const port = await status(f);
  assert.deepEqual(port.sent[0], { type: 'error', id: port.sent[0].id, code: 'format', stage: 'session', httpStatus: 200 });
  assert.equal(f.postCount(), 0); port.disconnect();
});
test('only explicit verification code changes a refusal classification and private fields remain inside the page', async () => {
  const f = fixture(); (await status(f)).disconnect(); f.state.conversationStatus = 403;
  for (const [code, expected] of [['verification_required', 'verificationRequired'], ['sentinel_required', 'accessDenied']] as const) {
    f.state.conversationError = { detail: { code, message: TOKEN_A, request_token: TOKEN_A } };
    const port = f.connect(); generate(port); await waitFor(() => port.sent.length > 0); await settle();
    assert.deepEqual(port.sent[0], { type: 'error', id: port.sent[0].id, code: expected, stage: 'conversation', httpStatus: 403 });
    assert.ok(!JSON.stringify(port.sent).includes(TOKEN_A)); port.disconnect();
  }
  assert.equal(f.postCount(), 2);
});
test('a malformed model list carries models/HTTP 200 while its original response stays private', async () => {
  const f = fixture(); f.state.modelPayload = { private: TOKEN_A };
  const port = await status(f);
  assert.deepEqual(port.sent[0], { type: 'error', id: port.sent[0].id, code: 'format', stage: 'models', httpStatus: 200 });
  assert.equal(f.postCount(), 0); assert.ok(!JSON.stringify(port.sent).includes(TOKEN_A)); port.disconnect();
});
