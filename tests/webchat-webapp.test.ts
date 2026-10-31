import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { openWebAppLogin, requestWebApp } from '../src/webchat-webapp.ts';
import { WEBCHAT_ORIGIN, type WebChatPageCommand } from '../src/webchat-shared.ts';
import { WebChatFailure } from '../src/webchat-protocol.ts';
import { NATIVE_WEBAPP_BRIDGE_VERSION } from '../src/webchat-native-version.ts';

type Command = Exclude<WebChatPageCommand, { type: 'cancel' }>;
type ScriptCall = {
  target: { tabId: number; documentIds?: string[]; frameIds?: number[] };
  world: string; files?: string[]; func?: (...args: never[]) => unknown; args?: unknown[];
};
class Hub<Args extends unknown[]> {
  listeners: ((...args: Args) => void)[] = [];
  addListener = (listener: (...args: Args) => void) => { this.listeners.push(listener); };
  removeListener = (listener: (...args: Args) => void) => { this.listeners = this.listeners.filter(item => item !== listener); };
  emit(...args: Args) { for (const listener of [...this.listeners]) listener(...args); }
}
const removed = new Hub<[number]>();
const updated = new Hub<[number, chrome.tabs.OnUpdatedInfo]>();
const committed = new Hub<[chrome.webNavigation.WebNavigationTransitionCallbackDetails]>();
const ORIGINS = [`${WEBCHAT_ORIGIN}/*`];
const command: Extract<Command, { type: 'generate' }> = {
  type: 'generate', id: 'request-1', model: 'account-model',
  messages: [{ role: 'user', content: '测试问题' }],
};
const statusCommand: Command = { type: 'status', id: 'request-1' };
const done = () => ({ type: 'done', id: command.id, text: '完整回答', conversation: { id: 'conversation-1', parentId: 'assistant-1' } });
const status = () => ({ type: 'status', id: command.id, status: { state: 'ready', loggedIn: true, models: [{ id: 'account-model', label: '账号模型' }] } });
let sequence = 0;
let tabs: chrome.tabs.Tab[];
let documentId: string;
let permitted: boolean;
let permissionCalls: unknown[];
let queries: unknown[];
let creates: chrome.tabs.CreateProperties[];
let updates: { id: number; changes: chrome.tabs.UpdateProperties }[];
let scripts: ScriptCall[];
let starts: Command[];
let cancellations: string[];
let polls: number;
let output: unknown[];
let active: Command | undefined;
let injectionHook: (() => Promise<void> | void) | undefined;
let createHook: (() => Promise<void> | void) | undefined;
let startHook: (() => Promise<void> | void) | undefined;
let pollHook: (() => Promise<void> | void) | undefined;
let resultDocument: string | undefined;
let resultFrame: number | undefined;
let bridgeVersion: string;

const tab = (id: number, url = `${WEBCHAT_ORIGIN}/c/unrelated-history`, extra: Partial<chrome.tabs.Tab> = {}) => ({ id, url, active: false, pinned: false, status: 'complete', ...extra }) as chrome.tabs.Tab;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let index = 0; index < 12; index++) await nextTurn(); }
async function until(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await nextTurn(); }
  throw new Error('Mock operation did not reach its expected boundary');
}
async function tick(context: TestContext, milliseconds = 350) { context.mock.timers.tick(milliseconds); await settle(); }
function rejectsCode(pending: Promise<unknown>, code: string, stage?: string) {
  return assert.rejects(pending, (error: unknown) => error instanceof WebChatFailure && error.code === code && (stage === undefined || error.stage === stage));
}
async function run(context: TestContext, value: Command = command, onText?: (text: string) => void) {
  const pending = requestWebApp(value, new AbortController().signal, onText);
  // Attach a rejection observer before advancing any controlled async boundary.
  void pending.catch(() => {});
  await until(() => starts.length > 0);
  await settle();
  const expectedPolls = Math.max(1, output.length);
  for (let index = 0; index < expectedPolls; index++) await tick(context);
  return pending;
}

beforeEach(context => {
  (context as TestContext).mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  sequence++;
  tabs = [tab(sequence * 100 + 7)]; documentId = `document-${sequence}`;
  permitted = true; permissionCalls = []; queries = []; creates = []; updates = []; scripts = [];
  starts = []; cancellations = []; polls = 0; output = []; active = undefined;
  injectionHook = undefined; createHook = undefined; startHook = undefined; pollHook = undefined;
  resultDocument = undefined; resultFrame = undefined;
  bridgeVersion = NATIVE_WEBAPP_BRIDGE_VERSION;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    permissions: { contains: async (request: unknown) => { permissionCalls.push(structuredClone(request)); assert.deepEqual(request, { origins: ORIGINS }); return permitted; } },
    tabs: {
      onRemoved: removed, onUpdated: updated,
      query: async (request: unknown) => { queries.push(structuredClone(request)); assert.deepEqual(request, { url: ORIGINS }); return structuredClone(tabs); },
      get: async (id: number) => { const value = tabs.find(item => item.id === id); if (!value) throw new Error('Closed tab'); return structuredClone(value); },
      create: async (changes: chrome.tabs.CreateProperties) => {
        creates.push(structuredClone(changes)); await createHook?.();
        const value = tab(sequence * 100 + 99, String(changes.url), { active: changes.active, pinned: changes.pinned }); tabs.push(value); return structuredClone(value);
      },
      update: async (id: number, changes: chrome.tabs.UpdateProperties) => { updates.push({ id, changes: structuredClone(changes) }); return structuredClone(tabs.find(item => item.id === id)); },
    },
    webNavigation: {
      onCommitted: committed,
      getFrame: async ({ tabId, frameId }: { tabId: number; frameId: number }) => { assert.equal(frameId, 0); return { documentId, url: tabs.find(item => item.id === tabId)?.url, errorOccurred: false }; },
    },
    scripting: { executeScript: async (info: ScriptCall) => {
      scripts.push(info);
      assert.equal(info.world, 'MAIN'); assert.deepEqual(info.target.documentIds, [documentId]);
      assert.equal(info.target.frameIds, undefined); assert.ok(tabs.some(item => item.id === info.target.tabId));
      const boundDocument = documentId;
      const result = (value?: unknown) => [{ frameId: resultFrame ?? 0, documentId: resultDocument ?? boundDocument, ...(value === undefined ? {} : { result: value }) }];
      if (info.files) { assert.deepEqual(info.files, ['webchat-native-client.js']); assert.equal(info.func, undefined); await injectionHook?.(); return result(); }
      assert.equal(typeof info.func, 'function');
      const body = String(info.func);
      assert.doesNotMatch(body, /querySelector|getElementById|innerHTML|textContent|contentEditable|\.click\(/, 'controller must not inspect or operate page DOM');
      if (body.includes('.start(')) {
        assert.equal(info.args?.length, 2); assert.equal(info.args[1], NATIVE_WEBAPP_BRIDGE_VERSION);
        const scope = globalThis as unknown as { window?: unknown }; const previous = scope.window;
        scope.window = { __readerNativeWebappBridgeV3: { version: bridgeVersion, start(value: Command) { active = structuredClone(value); starts.push(active); return true; } } };
        let started: unknown;
        try { started = (info.func as (...args: unknown[]) => unknown)(...info.args!); }
        finally { if (previous === undefined) delete scope.window; else scope.window = previous; }
        if (started) await startHook?.(); return result(started);
      }
      assert.deepEqual(info.args, [command.id]);
      if (body.includes('.cancel(')) { cancellations.push(String(info.args?.[0])); return result(); }
      assert.ok(body.includes('.poll(')); polls++; await pollHook?.();
      return result(output.length ? output.shift() : active?.type === 'status' ? status() : done());
    } },
  };
});

afterEach(() => {
  assert.equal(removed.listeners.length, 0, 'removed listener must be cleaned up');
  assert.equal(updated.listeners.length, 0, 'updated listener must be cleaned up');
  assert.equal(committed.listeners.length, 0, 'navigation listener must be cleaned up');
});

test('webapp requires permission for the fixed ChatGPT origin before selecting or injecting a tab', async () => {
  permitted = false;
  await rejectsCode(requestWebApp(statusCommand, new AbortController().signal), 'accessDenied', 'session');
  assert.deepEqual(permissionCalls, [{ origins: ORIGINS }]);
  assert.equal(queries.length + creates.length + updates.length + scripts.length, 0);
});

test('a stale bridge is rejected at the executable MAIN handshake before it can start a request', async () => {
  bridgeVersion = 'reader-native-v1';
  await rejectsCode(requestWebApp(command, new AbortController().signal), 'pageUnsupported', 'client');
  assert.equal(starts.length + polls, 0);
});

test('an incompatible installed client that fails reinjection reports a fixed client failure', async () => {
  injectionHook = () => { throw new Error('incompatible old bridge; private implementation details'); };
  await rejectsCode(requestWebApp(command, new AbortController().signal), 'pageUnsupported', 'client');
  assert.equal(starts.length + polls, 0);
});

for (const code of ['pageBusy', 'pageChanged'] as const) test(`native ${code} classification survives the controller boundary`, async context => {
  output = [{ type: 'error', id: command.id, code, stage: 'conversation', raw: 'private failure details' }];
  await rejectsCode(run(context), code, 'conversation');
  assert.equal(starts.length, 1);
});

test('webapp reuses a normal official tab without navigation or chat-editor DOM operations', async context => {
  const before = structuredClone(tabs);
  const event = await run(context, statusCommand);
  assert.equal(event.type, 'status'); assert.deepEqual(tabs, before);
  assert.deepEqual(creates, []); assert.deepEqual(updates, []);
  assert.deepEqual(queries, [{ url: ORIGINS }]);
  assert.equal(scripts.filter(item => item.files).length, 1);
  assert.ok(scripts.every(item => item.target.tabId === before[0].id && item.world === 'MAIN' && JSON.stringify(item.target.documentIds) === JSON.stringify([documentId])));
  assert.deepEqual(starts, [statusCommand]); assert.equal(cancellations.length, 0);
});

test('webapp rejects lookalike origins, credentials and an external pending navigation', async context => {
  tabs = [
    tab(sequence * 100 + 1, 'https://chatgpt.com.evil.test/'),
    tab(sequence * 100 + 2, 'https://user:password@chatgpt.com/'),
    tab(sequence * 100 + 3, `${WEBCHAT_ORIGIN}/`, { pendingUrl: 'https://example.test/' }),
    tab(sequence * 100 + 4, 'http://chatgpt.com/'),
    tab(sequence * 100 + 5, `${WEBCHAT_ORIGIN}/c/ordinary`),
  ];
  await run(context, statusCommand);
  assert.ok(scripts.every(item => item.target.tabId === sequence * 100 + 5));
  assert.equal(creates.length + updates.length, 0);
});

test('webapp prefers an existing pinned proxy without making it active', async context => {
  tabs = [tab(sequence * 100 + 1, `${WEBCHAT_ORIGIN}/`, { active: true }), tab(sequence * 100 + 2, `${WEBCHAT_ORIGIN}/`, { pinned: true })];
  await run(context, statusCommand);
  assert.equal(scripts[0].target.tabId, sequence * 100 + 2);
  assert.equal(creates.length + updates.length, 0);
});

test('webapp creates only an inactive pinned official proxy when no suitable tab exists', async context => {
  tabs = [];
  await run(context, statusCommand);
  assert.deepEqual(creates, [{ url: `${WEBCHAT_ORIGIN}/`, active: false, pinned: true }]);
  assert.equal(updates.length, 0); assert.equal(starts.length, 1);
});

test('an explicit login action can focus the official page without injecting or sending', async () => {
  await openWebAppLogin();
  assert.deepEqual(updates, [{ id: tabs[0].id!, changes: { active: true } }]);
  assert.equal(creates.length + scripts.length + starts.length, 0);
});

test('status crosses the controller boundary using only its explicit safe fields', async context => {
  output = [{ ...status(), token: 'PRIVATE_TOKEN', status: {
    ...status().status, accountLabel: 'reader@example.test', generation: 'working', transport: 'page',
    accessToken: 'PRIVATE_TOKEN', raw: 'PRIVATE_RAW', error: 'PRIVATE_ERROR',
    models: [{ id: 'account-model', label: '账号模型', secret: 'PRIVATE_MODEL_SECRET' }],
  } }];
  const event = await run(context, statusCommand);
  assert.deepEqual(event, { type: 'status', id: command.id, status: {
    state: 'ready', loggedIn: true, models: [{ id: 'account-model', label: '账号模型' }],
    generation: 'unchecked', transport: 'webapp', accountLabel: 'reader@example.test',
  } });
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_/);
});

test('stream updates are deduplicated and completion returns no private bridge fields', async context => {
  output = [
    { type: 'text', id: command.id, text: '部分回答', token: 'PRIVATE_TOKEN' },
    { type: 'text', id: command.id, text: '部分回答', raw: 'PRIVATE_RAW' },
    { ...done(), raw: 'PRIVATE_RAW', conversation: { ...done().conversation, token: 'PRIVATE_TOKEN' } },
  ];
  const received: string[] = [];
  const pending = requestWebApp(command, new AbortController().signal, text => received.push(text));
  await until(() => starts.length === 1); await settle();
  for (let index = 0; index < 3; index++) await tick(context);
  assert.deepEqual(await pending, done()); assert.deepEqual(received, ['部分回答']);
  assert.equal(starts.length, 1); assert.equal(cancellations.length, 0);
});

test('a bridge error exposes only its known code, stage and bounded HTTP status', async context => {
  output = [{ type: 'error', id: command.id, code: 'accessDenied', stage: 'conversation', httpStatus: 403, token: 'PRIVATE_TOKEN', message: 'PRIVATE_SERVER_BODY' }];
  await assert.rejects(run(context), (error: unknown) => {
    assert.ok(error instanceof WebChatFailure); assert.equal(error.code, 'accessDenied');
    assert.equal(error.stage, 'conversation'); assert.equal(error.httpStatus, 403);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_/); assert.doesNotMatch(error.message, /PRIVATE_/); return true;
  });
  assert.deepEqual(cancellations, [command.id]); assert.equal(starts.length, 1);
});

test('unrecognized error metadata becomes a fixed format failure without reflecting private values', async context => {
  output = [{ type: 'error', id: command.id, code: 'PRIVATE_CODE', stage: 'PRIVATE_STAGE', httpStatus: 999, message: 'PRIVATE_BODY' }];
  await assert.rejects(run(context), (error: unknown) => {
    assert.ok(error instanceof WebChatFailure); assert.equal(error.code, 'format');
    assert.equal(error.stage, 'conversation'); assert.equal(error.httpStatus, undefined);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_/); assert.doesNotMatch(error.message, /PRIVATE_/); return true;
  });
  assert.equal(starts.length, 1);
});

test('a mismatched request id cannot deliver another operation answer or trigger a retry', async context => {
  output = [{ ...done(), id: 'different-operation' }];
  await rejectsCode(run(context), 'format');
  assert.equal(starts.length, 1); assert.deepEqual(cancellations, [command.id]);
});

test('overlong streaming text is rejected before invoking the sidebar callback', async context => {
  output = [{ type: 'text', id: command.id, text: 'x'.repeat(40_001) }];
  const received: string[] = [];
  await rejectsCode(run(context, command, value => received.push(value)), 'format');
  assert.deepEqual(received, []); assert.equal(starts.length, 1);
});

test('completion cannot exceed the text bound or use an invalid conversation id', async context => {
  for (const malformed of [
    { ...done(), text: 'x'.repeat(40_001) },
    { ...done(), text: '   ' },
    { ...done(), conversation: { id: 'https://PRIVATE_TOKEN', parentId: 'assistant-1' } },
    { ...done(), conversation: { id: 'conversation-1', parentId: 'x'.repeat(201) } },
  ]) {
    const initial = starts.length; output = [malformed];
    const pending = requestWebApp(command, new AbortController().signal); const rejection = rejectsCode(pending, 'format');
    await until(() => starts.length > initial); await settle(); await tick(context); await rejection;
  }
  assert.equal(starts.length, 4, 'each manual call may start only one operation');
});

test('invalid account model data cannot masquerade as a ready connection', async context => {
  for (const malformed of [
    { ...status().status, loggedIn: false },
    { ...status().status, models: [{ id: 'model/PRIVATE', label: '模型' }] },
    { ...status().status, models: [{ id: 'model', label: 'bad\nlabel' }] },
    { ...status().status, models: Array.from({ length: 101 }, () => ({ id: 'model', label: '模型' })) },
  ]) {
    const initial = starts.length; output = [{ type: 'status', id: command.id, status: malformed }];
    const pending = requestWebApp(statusCommand, new AbortController().signal); const rejection = rejectsCode(pending, 'format');
    await until(() => starts.length > initial); await settle(); await tick(context); await rejection;
  }
});

test('an already aborted signal causes no permission, tab or injection work', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(requestWebApp(command, abort.signal), { name: 'AbortError' });
  assert.equal(permissionCalls.length + queries.length + creates.length + scripts.length, 0);
});

test('abort while a proxy is being created never starts or injects a conversation', async () => {
  tabs = []; const boundary = deferred(); createHook = () => boundary.promise;
  const abort = new AbortController();
  let settled = false;
  const pending = requestWebApp(command, abort.signal); const rejection = assert.rejects(pending, { name: 'AbortError' });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await until(() => creates.length === 1); abort.abort(); await settle();
  try { assert.equal(settled, true, 'abort must not wait for tabs.create to resolve'); }
  finally { boundary.resolve(); await rejection; }
  assert.equal(scripts.length + starts.length + cancellations.length, 0);
});

test('connected cancellation is document bound, sent once and never retries the prompt', async context => {
  const abort = new AbortController();
  const pending = requestWebApp(command, abort.signal); const rejection = assert.rejects(pending, { name: 'AbortError' });
  await until(() => starts.length === 1); await settle(); abort.abort(); await rejection; await settle();
  abort.abort(); await tick(context);
  assert.deepEqual(cancellations, [command.id]); assert.equal(starts.length, 1); assert.equal(polls, 0);
  assert.ok(scripts.every(item => item.target.documentIds?.[0] === documentId));
});

test('permission revoked during polling cancels before reading or accepting a response', async context => {
  const pending = requestWebApp(command, new AbortController().signal); const rejection = rejectsCode(pending, 'accessDenied', 'conversation');
  await until(() => starts.length === 1); await settle(); permitted = false; await tick(context); await rejection;
  assert.equal(polls, 0); assert.deepEqual(cancellations, [command.id]); assert.equal(starts.length, 1);
});

test('a committed replacement document interrupts promptly and rejects stale completion', async () => {
  const pending = requestWebApp(command, new AbortController().signal); const rejection = rejectsCode(pending, 'interrupted', 'conversation');
  await until(() => starts.length === 1); await settle();
  committed.emit({ tabId: tabs[0].id!, frameId: 1, documentId: 'unrelated-subframe' } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
  committed.emit({ tabId: tabs[0].id! + 1, frameId: 0, documentId: 'unrelated-tab' } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
  assert.equal(cancellations.length, 0);
  committed.emit({ tabId: tabs[0].id!, frameId: 0, documentId: 'replacement-document' } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
  await rejection; assert.equal(polls, 0); assert.deepEqual(cancellations, [command.id]);
});

test('same-document official route changes do not navigate, edit or cancel a request', async context => {
  const pending = requestWebApp(command, new AbortController().signal);
  await until(() => starts.length === 1); await settle();
  tabs[0].url = `${WEBCHAT_ORIGIN}/c/user-selected-route`;
  updated.emit(tabs[0].id!, { url: tabs[0].url });
  committed.emit({ tabId: tabs[0].id!, frameId: 0, documentId } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
  await tick(context); assert.deepEqual(await pending, done());
  assert.equal(creates.length + updates.length + cancellations.length, 0);
});

test('closing the proxy or leaving the official origin aborts without accepting queued output', async () => {
  for (const cause of ['removed', 'external'] as const) {
    const initial = starts.length;
    const pending = requestWebApp(command, new AbortController().signal); const rejection = rejectsCode(pending, 'interrupted');
    await until(() => starts.length > initial); await settle();
    if (cause === 'removed') removed.emit(tabs[0].id!);
    else updated.emit(tabs[0].id!, { url: 'https://example.test/' });
    await rejection;
  }
  assert.equal(starts.length, 2); assert.equal(polls, 0);
});

test('script injection results must belong to the exact top document', async () => {
  resultDocument = 'another-document';
  await rejectsCode(requestWebApp(command, new AbortController().signal), 'interrupted', 'conversation');
  assert.equal(starts.length + polls, 0); assert.equal(scripts.filter(item => item.files).length, 1);
});

test('heartbeats cannot extend the bounded 180-second generation deadline', async context => {
  output = Array.from({ length: 10 }, () => ({ type: 'heartbeat', id: command.id }));
  const pending = requestWebApp(command, new AbortController().signal); const rejection = rejectsCode(pending, 'timeout', 'conversation');
  await until(() => starts.length === 1); await settle();
  for (let index = 0; index < 4; index++) await tick(context, 40_000);
  assert.equal(cancellations.length, 0, 'heartbeats before the total deadline keep the operation pending');
  await tick(context, 20_350); await rejection;
  assert.equal(starts.length, 1); assert.deepEqual(cancellations, [command.id]);
});

test('the total deadline also bounds a Chrome API that never answers', async context => {
  const boundary = deferred(); injectionHook = () => boundary.promise;
  let settled = false;
  const pending = requestWebApp(command, new AbortController().signal);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejection = rejectsCode(pending, 'timeout', 'conversation');
  await until(() => scripts.some(item => item.files)); await settle();
  try {
    await tick(context, 180_350);
    assert.equal(settled, true, 'the total deadline must reject even while executeScript is pending');
  } finally {
    boundary.resolve(); await rejection;
  }
  assert.equal(starts.length, 0);
});
