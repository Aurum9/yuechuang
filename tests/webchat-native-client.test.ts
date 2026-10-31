import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeWebappBridge, installNativeWebappBridge, type NativeWebappDependencies, type NativeWebappRuntime } from '../src/webchat-native-client.ts';
import { NATIVE_WEBAPP_BRIDGE_VERSION } from '../src/webchat-native-version.ts';
import { WebChatFailure } from '../src/webchat-protocol.ts';
import type { WebChatPageEvent } from '../src/webchat-shared.ts';

const record = (value: unknown) => value as Record<string, unknown>;
type RequestOptions = Parameters<NativeWebappRuntime['request']['postResponse']>[1];
const generate = (id = 'generate-1') => ({ type: 'generate', id, model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] });

function fixture() {
  let userId = 'user-1'; let serial = 0;
  let sessionAccount: string | undefined = 'account-1'; let token = 'session-secret-token';
  let runtimeIdentity: { accountId: string; userId: string } | undefined;
  let lifecycle: ((reason: 'pageChanged' | 'signedOut') => void) | undefined;
  const calls: { path: string; options?: RequestOptions }[] = [];
  let response: (options: RequestOptions) => Promise<Response> = async options => answer(options, 'Test answer');
  let integrityFailure: unknown;
  const assertIdentity = (options: RequestOptions) => {
    assert.ok(options.expectedIdentity, 'every normal-client request must bind the actual authenticated identity');
    if (runtimeIdentity && (runtimeIdentity.accountId !== options.expectedIdentity.accountId || runtimeIdentity.userId !== options.expectedIdentity.userId)) throw { status: 409, errorCode: 'account_changed' };
  };
  const runtime: NativeWebappRuntime = {
    request: {
      async safeGet(path, options) { calls.push({ path, options }); assertIdentity(options); return { models: [{ slug: 'gpt-test', title: 'Test session-secret-token' }] }; },
      async safePost(path, options) { calls.push({ path, options }); assertIdentity(options); return { prepare_token: 'requirements-secret' }; },
      async postResponse(path, options) { calls.push({ path, options }); assertIdentity(options); return response(options); }
    },
    integrity: {
      async f(callback) {
        if (integrityFailure) throw integrityFailure;
        const prepared = await callback('normal-client-key');
        assert.equal(record(prepared).prepare_token, 'requirements-secret');
        return {
          chatRequirements: prepared,
          headers: { 'OpenAI-Sentinel-Chat-Requirements-Prepare-Token': 'requirements-secret', 'OpenAI-Sentinel-Proof-Token': 'proof-secret' }
        };
      }
    }
  };
  const deps: NativeWebappDependencies = {
    async loadRuntime() { return runtime; },
    async fetchSession(url, init) {
      assert.equal(url, 'https://chatgpt.com/api/auth/session');
      assert.equal(init.credentials, 'include');
      return new Response(JSON.stringify({ user: { id: userId, email: `${userId}@example.test` }, ...(sessionAccount ? { account: { id: sessionAccount } } : {}), accessToken: token }), { headers: { 'Content-Type': 'application/json' } });
    },
    uuid: () => `generated-${++serial}`, timezone: () => 'Asia/Shanghai', timezoneOffset: () => -480,
    watchLifecycle(listener) { lifecycle = listener; }
  };
  return {
    bridge: createNativeWebappBridge(deps), calls, deps,
    setUser(id: string) { userId = id; },
    setResponse(value: typeof response) { response = value; },
    setIntegrityFailure(value: unknown) { integrityFailure = value; },
    setSessionAccount(value?: string) { sessionAccount = value; },
    setToken(value: string) { token = value; },
    setRuntimeIdentity(value: { accountId: string; userId: string }) { runtimeIdentity = value; },
    lifecycle(reason: 'pageChanged' | 'signedOut') { lifecycle?.(reason); }
  };
}
function identityToken(claims: Record<string, unknown>) {
  return `fixture-header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': claims })).toString('base64url')}.fixture-signature`;
}
function answer(options: RequestOptions, text: string, complete = true) {
  const body = record(options.requestBody);
  const messages = body.messages as { id: string }[];
  const input = messages.at(-1)!.id;
  const conversation = typeof body.conversation_id === 'string' ? body.conversation_id : 'conversation-1';
  return new Response([
    `event: delta_encoding\ndata: "v1"\n\n`,
    `data: ${JSON.stringify({ type: 'input_message', conversation_id: conversation, input_message: { id: input } })}\n\n`,
    `data: ${JSON.stringify({ conversation_id: conversation, message: { id: 'assistant-' + input, author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] }, status: complete ? 'finished_successfully' : 'in_progress', end_turn: complete } })}\n\n`,
    'data: [DONE]\n\n'
  ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}
async function finished(bridge: ReturnType<typeof createNativeWebappBridge>, id: string) {
  const events: WebChatPageEvent[] = [];
  for (let count = 0; count < 100; count++) {
    const event = bridge.poll(id); events.push(event);
    assert.equal(event.id, id);
    if (event.type === 'status' || event.type === 'done' || event.type === 'error') return { event, events };
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('Fixture operation did not finish');
}
async function checkStatus(f: ReturnType<typeof fixture>) {
  assert.equal(f.bridge.start({ type: 'status', id: 'status-1' }), true);
  const result = await finished(f.bridge, 'status-1'); assert.equal(result.event.type, 'status'); return result;
}

test('normal-client status verifies session and models without exposing credentials or claiming generation', async () => {
  const f = fixture(); const { event, events } = await checkStatus(f);
  assert.equal(event.type, 'status');
  if (event.type !== 'status') return;
  assert.equal(event.status.state, 'ready');
  assert.equal(event.status.transport, 'webapp');
  assert.equal(event.status.generation, undefined);
  assert.equal(event.status.accountLabel, 'user-1@example.test');
  assert.equal(event.status.models[0].label, 'Test [已隐藏登录凭据]');
  assert.equal(JSON.stringify(events).includes('session-secret-token'), false);
  assert.deepEqual(f.calls.map(call => call.path), ['/models']);
  assert.equal(f.calls[0].options?.retry, 'never');
});

test('generation uses the official preflight callback once and sends an unprepared v1 request', async () => {
  const f = fixture(); await checkStatus(f);
  f.setResponse(async options => answer(options, 'session-secret-token requirements-secret proof-secret answer'));
  assert.equal(f.bridge.start(generate()), true);
  const { event, events } = await finished(f.bridge, 'generate-1');
  assert.equal(event.type, 'done');
  if (event.type !== 'done') return;
  assert.equal(event.text, '[已隐藏登录凭据] [已隐藏请求凭据] [已隐藏请求凭据] answer');
  assert.equal(JSON.stringify(events).includes('session-secret-token'), false);
  assert.equal(JSON.stringify(events).includes('requirements-secret'), false);
  assert.equal(JSON.stringify(events).includes('proof-secret'), false);
  assert.deepEqual(f.calls.map(call => call.path), ['/models', '/sentinel/chat-requirements/prepare', '/f/conversation']);
  const preflight = f.calls[1].options!;
  assert.deepEqual(preflight.requestBody, { p: 'normal-client-key' });
  assert.deepEqual(preflight.additionalHeaders, { 'X-OpenAI-Expected-Account-Id': 'account-1' });
  const sent = f.calls[2].options!; const body = record(sent.requestBody);
  assert.equal(sent.retry, 'never'); assert.equal(sent.cache, 'no-store');
  assert.deepEqual(sent.expectedIdentity, { accountId: 'account-1', userId: 'user-1' });
  assert.deepEqual(body.supported_encodings, ['v1']);
  assert.equal(body.client_prepare_state, 'none');
  assert.equal(body.timezone, 'Asia/Shanghai'); assert.equal(body.timezone_offset_min, -480);
  assert.equal(body.model, 'gpt-test');
  assert.equal(record(sent.additionalHeaders).Authorization, undefined);
  assert.equal(record(sent.additionalHeaders)['x-oai-mcp-form-version'], undefined);
});

test('new remote threads quote complete local history inside one user message', async () => {
  const f = fixture(); await checkStatus(f);
  f.bridge.start({ ...generate(), messages: [
    { role: 'system', content: 'Local reading instructions' },
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier local answer' },
    { role: 'user', content: 'New question' }
  ] });
  const { event } = await finished(f.bridge, 'generate-1'); assert.equal(event.type, 'done');
  const messages = record(f.calls.find(call => call.path === '/f/conversation')!.options!.requestBody).messages as { author: { role: string }; content: { parts: string[] } }[];
  assert.equal(messages.length, 1); assert.equal(messages[0].author.role, 'user');
  for (const content of ['Local reading instructions', 'Earlier question', 'Earlier local answer', 'New question']) assert.equal(messages[0].content.parts[0].includes(content), true);
});

test('an owned continuation sends only its latest user message', async () => {
  const f = fixture(); await checkStatus(f);
  f.bridge.start(generate()); const first = (await finished(f.bridge, 'generate-1')).event;
  assert.equal(first.type, 'done'); if (first.type !== 'done') return;
  await new Promise<void>(resolve => setImmediate(resolve));
  f.bridge.start({ ...generate('generate-2'), conversation: first.conversation, messages: [
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Follow-up question' }
  ] });
  const result = await finished(f.bridge, 'generate-2'); assert.equal(result.event.type, 'done');
  const body = record(f.calls.filter(call => call.path === '/f/conversation')[1].options!.requestBody);
  const messages = body.messages as { author: { role: string }; content: { parts: string[] } }[];
  assert.equal(messages.length, 1); assert.equal(messages[0].author.role, 'user');
  assert.deepEqual(messages[0].content.parts, ['Follow-up question']);
  assert.equal(body.conversation_id, first.conversation.id);
  assert.equal(body.parent_message_id, first.conversation.parentId);
});

test('a generation without a successful status does not run preflight or send', async () => {
  const f = fixture(); f.bridge.start(generate()); const { event } = await finished(f.bridge, 'generate-1');
  assert.equal(event.type, 'error'); if (event.type === 'error') assert.equal(event.code, 'signedOut');
  assert.deepEqual(f.calls, []);
});

test('account changes between status and sending require a fresh status', async () => {
  const f = fixture(); await checkStatus(f); f.setUser('user-2');
  f.bridge.start(generate()); const { event } = await finished(f.bridge, 'generate-1');
  assert.equal(event.type, 'error'); if (event.type === 'error') assert.equal(event.code, 'signedOut');
  assert.deepEqual(f.calls.map(call => call.path), ['/models']);
});

test('session token identity binds requests when the session omits its account object', async () => {
  const f = fixture(); f.setSessionAccount();
  const token = identityToken({ chatgpt_account_id: 'token-account', user_id: 'user-1' });
  f.setToken(token); await checkStatus(f);
  f.bridge.start(generate()); const { event, events } = await finished(f.bridge, 'generate-1');
  assert.equal(event.type, 'done');
  for (const call of f.calls) assert.deepEqual(call.options?.expectedIdentity, { accountId: 'token-account', userId: 'user-1' });
  assert.equal(JSON.stringify(events).includes(token), false);
});

test('a missing account identity refuses status before any authenticated client request', async () => {
  for (const token of ['opaque-session-token', 'broken.payload.signature', identityToken({ user_id: 'user-1' })]) {
    const f = fixture(); f.setSessionAccount(); f.setToken(token);
    f.bridge.start({ type: 'status', id: 'status-missing-account' });
    const { event } = await finished(f.bridge, 'status-missing-account');
    assert.equal(event.type, 'error'); if (event.type === 'error') { assert.equal(event.code, 'signedOut'); assert.equal(event.stage, 'session'); }
    assert.deepEqual(f.calls, []);
  }
});

test('inconsistent session and token user or account claims fail before models are read', async () => {
  for (const claims of [{ chatgpt_account_id: 'account-1', user_id: 'other-user' }, { account_id: 'other-account', chatgpt_user_id: 'user-1' }]) {
    const f = fixture(); f.setToken(identityToken(claims));
    f.bridge.start({ type: 'status', id: 'status-inconsistent-identity' });
    const { event } = await finished(f.bridge, 'status-inconsistent-identity');
    assert.equal(event.type, 'error'); if (event.type === 'error') assert.equal(event.code, 'signedOut');
    assert.deepEqual(f.calls, []);
  }
});

test('a stale official auth cache blocks before conversation POST and clears verified identity', async () => {
  const f = fixture(); await checkStatus(f);
  f.setRuntimeIdentity({ accountId: 'other-account', userId: 'other-user' });
  f.bridge.start(generate()); const { event } = await finished(f.bridge, 'generate-1');
  assert.equal(event.type, 'error');
  if (event.type === 'error') { assert.equal(event.code, 'signedOut'); assert.equal(event.httpStatus, 409); }
  assert.equal(f.calls.filter(call => call.path === '/f/conversation').length, 0);
  const callCount = f.calls.length;
  await new Promise<void>(resolve => setImmediate(resolve));
  f.bridge.start(generate('generate-after-identity-failure'));
  const retry = await finished(f.bridge, 'generate-after-identity-failure');
  assert.equal(retry.event.type, 'error'); if (retry.event.type === 'error') assert.equal(retry.event.code, 'signedOut');
  assert.equal(f.calls.length, callCount, 'a later send requires a fresh successful account check');
});

test('an account_changed failure at the actual send also invalidates the verified account', async () => {
  const f = fixture(); await checkStatus(f);
  f.setResponse(async () => { throw { status: 409, errorCode: 'account_changed' }; });
  f.bridge.start(generate()); const { event } = await finished(f.bridge, 'generate-1');
  assert.equal(event.type, 'error'); if (event.type === 'error') assert.equal(event.code, 'signedOut');
  const count = f.calls.length;
  await new Promise<void>(resolve => setImmediate(resolve));
  f.bridge.start(generate('generate-after-send-identity-failure'));
  const later = await finished(f.bridge, 'generate-after-send-identity-failure');
  assert.equal(later.event.type, 'error'); if (later.event.type === 'error') assert.equal(later.event.code, 'signedOut');
  assert.equal(f.calls.length, count);
});

test('reinjecting a compatible bridge preserves its state while an old non-configurable bridge refuses use', () => {
  const f = fixture(); const target: Pick<Window, '__readerNativeWebappBridgeV3'> = {};
  const installed = installNativeWebappBridge(target, f.deps);
  assert.equal(installed.version, NATIVE_WEBAPP_BRIDGE_VERSION);
  assert.equal(installNativeWebappBridge(target, f.deps), installed);
  assert.equal(Object.getOwnPropertyDescriptor(target, '__readerNativeWebappBridgeV3')?.configurable, false);
  let oldStarts = 0;
  const old = { version: 'reader-native-v1', start() { oldStarts++; return true; } };
  const oldTarget: Pick<Window, '__readerNativeWebappBridgeV3'> = {};
  Object.defineProperty(oldTarget, '__readerNativeWebappBridgeV3', { value: old, configurable: false });
  assert.throws(() => installNativeWebappBridge(oldTarget, f.deps), (error: unknown) => error instanceof WebChatFailure && error.code === 'pageUnsupported' && error.stage === 'client');
  assert.equal(oldStarts, 0); assert.equal(oldTarget.__readerNativeWebappBridgeV3, old);
});

test('upgrading a long-lived page installs v3 alongside an immutable v2 without touching the old bridge', () => {
  const f = fixture(); const target: Pick<Window, '__readerNativeWebappBridgeV3'> = {};
  let oldCalls = 0;
  const old = { version: 'reader-native-v2', start() { oldCalls++; throw new Error('old bridge must remain unused'); } };
  Object.defineProperty(target, '__readerNativeWebappBridge', { value: old, configurable: false, writable: false });
  const current = installNativeWebappBridge(target, f.deps);
  assert.equal(current.version, 'reader-native-v3');
  assert.equal(installNativeWebappBridge(target, f.deps), current);
  assert.equal(Object.getOwnPropertyDescriptor(target, '__readerNativeWebappBridge')?.value, old);
  assert.equal(oldCalls, 0);
});

test('foreign conversation associations are rejected before preflight', async () => {
  const f = fixture(); await checkStatus(f);
  f.bridge.start({ ...generate(), conversation: { id: 'some-other-conversation', parentId: 'some-other-assistant' } });
  const { event } = await finished(f.bridge, 'generate-1');
  assert.equal(event.type, 'error'); if (event.type === 'error') assert.equal(event.code, 'pageChanged');
  assert.deepEqual(f.calls.map(call => call.path), ['/models']);
});

test('stream closure and DONE without a completed assistant are reported as interrupted', async () => {
  const f = fixture(); await checkStatus(f); f.setResponse(async options => answer(options, 'unfinished', false));
  f.bridge.start(generate()); const { event } = await finished(f.bridge, 'generate-1');
  assert.equal(event.type, 'error'); if (event.type === 'error') assert.equal(event.code, 'interrupted');
  assert.equal(f.calls.filter(call => call.path === '/f/conversation').length, 1);
});

test('known interactive verification failures stop before the conversation request', async () => {
  const f = fixture(); await checkStatus(f);
  f.setIntegrityFailure({ errorCode: 'captcha_required', status: 403, message: 'secret raw server response' });
  f.bridge.start(generate()); const { event } = await finished(f.bridge, 'generate-1');
  assert.equal(event.type, 'error');
  if (event.type === 'error') { assert.equal(event.code, 'verificationRequired'); assert.equal(event.httpStatus, 403); }
  assert.equal(JSON.stringify(event).includes('raw server'), false);
  assert.deepEqual(f.calls.map(call => call.path), ['/models']);
});

test('cancellation aborts the actual request signal and releases the single active slot', async () => {
  const f = fixture(); await checkStatus(f);
  let started: (() => void) | undefined; const sending = new Promise<void>(resolve => { started = resolve; });
  let signal: AbortSignal | undefined;
  f.setResponse(async options => { signal = options.signal; started?.(); return new Promise<Response>(() => {}); });
  f.bridge.start(generate()); await sending;
  f.bridge.cancel('generate-1');
  const { event } = await finished(f.bridge, 'generate-1');
  assert.equal(signal?.aborted, true);
  assert.equal(event.type, 'error'); if (event.type === 'error') assert.equal(event.code, 'interrupted');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.bridge.start({ type: 'status', id: 'status-after-cancel' }), true);
  assert.equal((await finished(f.bridge, 'status-after-cancel')).event.type, 'status');
});

test('duplicate start and terminal polling do not submit another model request', async () => {
  const f = fixture(); await checkStatus(f);
  assert.equal(f.bridge.start(generate()), true); assert.equal(f.bridge.start(generate()), true);
  const { event } = await finished(f.bridge, 'generate-1'); assert.equal(event.type, 'done');
  assert.equal(f.bridge.start(generate()), true); assert.equal(f.bridge.poll('generate-1').type, 'done');
  assert.equal(f.calls.filter(call => call.path === '/f/conversation').length, 1);
});

test('official auth context changes invalidate the verified identity', async () => {
  const f = fixture(); await checkStatus(f); f.lifecycle('signedOut');
  f.bridge.start(generate()); const { event } = await finished(f.bridge, 'generate-1');
  assert.equal(event.type, 'error'); if (event.type === 'error') assert.equal(event.code, 'signedOut');
  assert.equal(f.calls.filter(call => call.path === '/f/conversation').length, 0);
});

test('missing current official runtime is an explicit unsupported-client failure', async () => {
  const f = fixture();
  f.setIntegrityFailure(new WebChatFailure('pageUnsupported', 'conversation'));
  await checkStatus(f); f.bridge.start(generate());
  const { event } = await finished(f.bridge, 'generate-1');
  assert.equal(event.type, 'error'); if (event.type === 'error') assert.equal(event.code, 'pageUnsupported');
});
