import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DEFAULT_SETTINGS } from '../src/shared.ts';
import { CONTEXT_MENU_EXPLAIN, CONTEXT_MENU_TRANSLATE, CONTEXT_PORT, type ContextSnapshot, type ContextState } from '../src/context-shared.ts';

class Hub<Args extends unknown[]> {
  listeners: ((...args: Args) => unknown)[] = [];
  addListener(listener: (...args: Args) => unknown) { this.listeners.push(listener); }
  emit(...args: Args) { for (const listener of [...this.listeners]) listener(...args); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function gate() { return { reached: deferred(), release: deferred() }; }
type Gate = ReturnType<typeof gate>;
type Message = Record<string, unknown>;
type Frame = { documentId: string; url: string; parentFrameId: number; errorOccurred: boolean };
const ID = 'context-reader-test', PAGE_URL = 'https://article.test/technical', API = 'https://model.test/v1', KEY = 'test-key-not-real';
const config = { ...DEFAULT_SETTINGS, baseUrl: API, model: 'context-test' };
const local: Record<string, unknown> = {}, session: Record<string, unknown> = {};
const frames = new Map<string, Frame>(), granted = new Set<string>();
const clicked = new Hub<[chrome.contextMenus.OnClickData, chrome.tabs.Tab | undefined]>(), connected = new Hub<[chrome.runtime.Port]>();
const runtimeMessage = new Hub<[Message, chrome.runtime.MessageSender, (reply: { ok: boolean; enabled?: boolean; error?: string; requestId?: string }) => void]>();
const removed = new Hub<[chrome.permissions.Permissions]>(), navigation = new Hub<[{ tabId: number; frameId: number; documentId?: string; url: string }]>(), history = new Hub<[{ tabId: number; frameId: number; documentId?: string; url: string }]>(), tabRemoved = new Hub<[number]>();
const calls: { url: string; init: RequestInit }[] = [], messages: { tabId: number; message: Message; options?: { documentId?: string } }[] = [], ports: PortMock[] = [], menus: { id?: string; contexts?: string[] }[] = [], unavailable: string[] = [];
const gates: Gate[] = [];
let captureGate: Gate | undefined, configGate: Gate | undefined, fetchGate: Gate | undefined, barrier: Gate | undefined;
let phraseWriteGate: Gate | undefined, phraseWriteError = false;
const openedTabs: { url: string }[] = [];
let capture: { ok: true; snapshot: ContextSnapshot } | { ok: false; message: string };
let autoConnect = true, unavailableReceiver = false, beforeRequests = 0;
let captureNonce: string | undefined;
let cancelContextTasks: (reason?: string) => void, initializeContextMenus: typeof import('../src/context-background.ts').initializeContextMenus, forgetSavedPhrase: typeof import('../src/context-background.ts').forgetSavedPhrase;
const key = (tabId: number, frameId: number) => `${tabId}:${frameId}`;
function paused() { const value = gate(); gates.push(value); return value; }
function snapshot(text = 'coherence', frameId = 0): ContextSnapshot { return { text, context: `Visible paragraph containing ${text}. NEAR_${text.toUpperCase()}_ONLY`, title: 'Technical article', url: frames.get(key(1, frameId))!.url, rect: { x: 50, y: 80, width: 90, height: 20 }, capturedAt: Date.now() }; }
function sender(frameId = 0, overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  const frame = frames.get(key(1, frameId))!;
  return { id: ID, documentId: frame.documentId, frameId, url: frame.url, tab: { id: 1, url: PAGE_URL, windowId: 2 } as chrome.tabs.Tab, ...overrides };
}
class PortMock {
  name = CONTEXT_PORT; sent: ContextState[] = []; disconnected = false;
  onMessage = new Hub<[Message]>(); onDisconnect = new Hub<[]>();
  constructor(public sender: chrome.runtime.MessageSender) { ports.push(this); }
  postMessage(state: ContextState) { if (this.disconnected) throw new Error('Disconnected'); this.sent.push(structuredClone(state)); }
  command(type: string, requestId = this.sent.at(-1)?.requestId) { this.onMessage.emit({ type, requestId }); }
  disconnect() { if (!this.disconnected) { this.disconnected = true; this.onDisconnect.emit(); } }
}
function connect(source = sender()) { const port = new PortMock(source); connected.emit(port as unknown as chrome.runtime.Port); return port; }
function area(data: Record<string, unknown>, name: string) { return {
  async setAccessLevel() {}, async get(keys: string | string[]) {
    const names = Array.isArray(keys) ? keys : [keys]; const result = structuredClone(Object.fromEntries(names.filter(item => item in data).map(item => [item, data[item]])));
    if (name === 'local' && names.includes('settings') && configGate) { const hold = configGate; configGate = undefined; hold.reached.resolve(); await hold.release.promise; }
    return result;
  }, async set(value: Record<string, unknown>) {
    if (name === 'local' && 'savedPhrases' in value) {
      if (phraseWriteGate) { const hold = phraseWriteGate; phraseWriteGate = undefined; hold.reached.resolve(); await hold.release.promise; }
      if (phraseWriteError) throw new Error('Storage quota exceeded');
    }
    Object.assign(data, structuredClone(value));
  }, async remove(keys: string | string[]) { for (const item of Array.isArray(keys) ? keys : [keys]) delete data[item]; }
}; }
const chromeMock = {
  runtime: { id: ID, getURL: (path: string) => `chrome-extension://${ID}/${path}`, lastError: undefined, onConnect: connected, onMessage: runtimeMessage },
  storage: { local: area(local, 'local'), session: area(session, 'session') },
  contextMenus: { onClicked: clicked, remove(_id: string, done: () => void) { done(); }, create(value: { id?: string; contexts?: string[] }, done: () => void) { menus.push(value); done(); return value.id; } },
  permissions: { onRemoved: removed, async contains({ origins }: { origins: string[] }) { return origins.every(origin => granted.has(origin)); } },
  tabs: { onRemoved: tabRemoved, async create(value: { url: string }) { openedTabs.push(value); return value; }, async sendMessage(tabId: number, value: Message, options?: { documentId?: string }) {
    messages.push(structuredClone({ tabId, message: value, options }));
    const frame = [...frames.entries()].find(([name, item]) => name.startsWith(`${tabId}:`) && item.documentId === options?.documentId);
    if (!frame || unavailableReceiver) throw new Error('No receiver');
    if (value.type === 'context:capture') {
      const result = value.captureId !== undefined && value.captureId !== captureNonce ? { ok: false, message: '当前划词快照已失效。' } : structuredClone(capture);
      if (captureGate) { const hold = captureGate; captureGate = undefined; hold.reached.resolve(); await hold.release.promise; }
      return result;
    }
    if (value.type === 'context:show' && autoConnect) connect(sender(Number(frame[0].split(':')[1])));
    return { ok: true };
  } },
  webNavigation: { onCommitted: navigation, onHistoryStateUpdated: history, onReferenceFragmentUpdated: new Hub<[]>(), async getFrame({ tabId, frameId }: { tabId: number; frameId: number }) { return structuredClone(frames.get(key(tabId, frameId))) ?? null; } },
  action: { async setBadgeText() {}, async setTitle() {} }
};
async function settle() { for (let index = 0; index < 8; index++) await nextTurn(); }
async function waitFor(predicate: () => boolean, description: string) { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timeout: ${description}`); await nextTurn(); } }
function click(text = 'coherence', frameId = 0, overrides: Partial<chrome.contextMenus.OnClickData> = {}, result?: typeof capture) {
  capture = result ?? { ok: true, snapshot: snapshot(text, frameId) };
  const info = { menuItemId: CONTEXT_MENU_EXPLAIN, editable: false, selectionText: text, frameId, pageUrl: PAGE_URL, ...(frameId ? { frameUrl: frames.get(key(1, frameId))!.url } : {}), ...overrides };
  clicked.emit(info, { id: 1, url: PAGE_URL, windowId: 2 } as chrome.tabs.Tab);
}
function runtime(input: Message, source = sender()) { return new Promise<{ ok: boolean; enabled?: boolean; error?: string; requestId?: string }>(resolve => runtimeMessage.emit(input, source, resolve)); }
function selection(text = 'coherence', frameId = 0, captureId = `capture-${text}`, source = sender(frameId)) {
  capture = { ok: true, snapshot: snapshot(text, frameId) }; captureNonce = captureId;
  return runtime({ type: 'context:selection-start', mode: 'translate', captureId }, source);
}
async function terminal(after = 0) { await waitFor(() => ports.slice(after).some(port => port.sent.some(state => ['done', 'error', 'cancelled'].includes(state.status))), 'terminal state'); return ports.at(-1)!; }
function last(port = ports.at(-1)!) { return port.sent.at(-1)!; }
function showMessages() { return messages.filter(item => item.message.type === 'context:show'); }

before(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    const input = JSON.parse(JSON.parse(init!.body as string).messages[1].content), output = `ANSWER_${input.selection}${input.existingCoreAnswer ? '_DETAILS' : ''}`;
    if (fetchGate) {
      const hold = fetchGate; fetchGate = undefined; hold.reached.resolve();
      await new Promise<void>((resolve, reject) => { hold.release.promise.then(resolve); init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
    }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  ({ cancelContextTasks, initializeContextMenus, forgetSavedPhrase } = await import('../src/context-background.ts'));
  await initializeContextMenus({ beforeRequest: () => { beforeRequests++; }, configurationReady: async () => { if (barrier) { const hold = barrier; barrier = undefined; hold.reached.resolve(); await hold.release.promise; } }, onUnavailable: reason => unavailable.push(reason) });
});
beforeEach(async () => {
  for (const hold of gates) hold.release.resolve(); gates.length = 0;
  captureGate = configGate = fetchGate = barrier = undefined;
  phraseWriteGate = undefined; phraseWriteError = false; openedTabs.length = 0;
  for (const port of ports) port.disconnect(); tabRemoved.emit(1); await settle();
  for (const name of Object.keys(local)) delete local[name]; for (const name of Object.keys(session)) delete session[name];
  local.settings = structuredClone(config); session.apiKey = KEY;
  frames.clear(); frames.set(key(1, 0), { documentId: 'top-document', url: PAGE_URL, parentFrameId: -1, errorOccurred: false });
  frames.set(key(1, 42), { documentId: 'preview-document', url: 'https://preview.test/article', parentFrameId: 0, errorOccurred: false });
  granted.clear(); for (const url of [PAGE_URL, API, 'https://preview.test/']) granted.add(new URL(url).origin + '/*');
  calls.length = messages.length = ports.length = unavailable.length = 0; beforeRequests = 0; autoConnect = true; unavailableReceiver = false;
  captureNonce = undefined;
});

test('selection-only native menus initialize idempotently and leave other menu entries untouched', async () => {
  await initializeContextMenus(); await initializeContextMenus();
  assert.deepEqual(menus.map(menu => menu.id), [CONTEXT_MENU_EXPLAIN, CONTEXT_MENU_TRANSLATE]);
  assert.ok(menus.every(menu => JSON.stringify(menu.contexts) === '["selection"]'));
  assert.equal(clicked.listeners.length, 1);
});

test('menu reads and shows the exact clicked document, then sends only selected text and nearby paragraph to the model', async () => {
  click('coherence', 42); const port = await terminal();
  assert.equal(last(port).status, 'done'); assert.equal(calls.length, 1); assert.equal(beforeRequests, 1);
  assert.ok(messages.every(item => item.options?.documentId === 'preview-document'));
  const input = JSON.parse(JSON.parse(calls[0].init.body as string).messages[1].content);
  assert.equal(input.selection, 'coherence'); assert.match(input.paragraphContext, /NEAR_COHERENCE_ONLY/);
  assert.ok(!JSON.stringify(messages).includes(KEY)); assert.ok(!JSON.stringify(port.sent).includes(KEY));
  assert.equal(calls[0].url, API + '/chat/completions');
});

test('signed-out ChatGPT selection reports the login requirement without spending the saved API Key', async () => {
  local.webChatConfig = { provider: 'chatgptOAuth', model: 'gpt-example' };
  click('product', 0, { menuItemId: CONTEXT_MENU_TRANSLATE });
  const port = await terminal();
  assert.equal(last(port).status, 'error');
  assert.match(last(port).error!, /登录 ChatGPT/);
  assert.equal(calls.length, 0);
});

test('no model request occurs without the answer Port, and fake/stale/wrong-frame ports are rejected', async () => {
  autoConnect = false; click(); await waitFor(() => showMessages().length === 1, 'show without port'); await settle();
  for (const source of [sender(42), sender(0, { id: 'other' }), sender(0, { documentId: 'stale-document' }), sender(0, { url: 'https://forged.test/' })]) {
    const port = connect(source); await waitFor(() => port.disconnected, 'reject port');
  }
  assert.equal(calls.length, 0); assert.equal(beforeRequests, 0);
  const port = connect(); await waitFor(() => last(port)?.status === 'done', 'valid port'); assert.equal(calls.length, 1);
});

test('a menu from the previous top or iframe URL is refused before capture/model and displays a nearby error', async () => {
  for (const frameId of [0, 42]) {
    click('coherence', frameId, frameId ? { frameUrl: 'https://preview.test/previous' } : { pageUrl: 'https://article.test/previous' });
    await terminal(ports.length); await settle();
    assert.equal(last().status, 'error'); assert.match(last().error!, /导航/);
  }
  assert.equal(messages.filter(item => item.message.type === 'context:capture').length, 0); assert.equal(calls.length, 0);
});

test('empty, missing, mismatched and expired selections become readable errors with zero model calls', async () => {
  const cases: [string, typeof capture][] = [
    ['', { ok: false, message: 'empty' }],
    ['coherence', { ok: false, message: '选区已消失' }],
    ['coherence', { ok: true, snapshot: snapshot('different') }],
    ['coherence', { ok: true, snapshot: snapshot('coherence') }]
  ];
  cases[3][1] = { ok: true, snapshot: { ...snapshot(), capturedAt: Date.now() - 61_000 } };
  for (const [selection, captured] of cases) { const count = ports.length; click(selection, 0, {}, captured); await terminal(count); assert.equal(last().status, 'error'); }
  assert.equal(calls.length, 0);
});

test('an ungranted or uninjected page reports its failure without a paid request', async () => {
  granted.delete(new URL(PAGE_URL).origin + '/*'); click(); await waitFor(() => unavailable.length === 1, 'permission failure visible');
  assert.match(unavailable[0], /权限/); assert.equal(calls.length, 0);
  granted.add(new URL(PAGE_URL).origin + '/*'); unavailableReceiver = true; click(); await waitFor(() => unavailable.length === 2, 'receiver failure visible'); assert.equal(calls.length, 0);
});

test('rapid A/B menu clicks invalidate pending capture A before B completes; late A never overwrites B', async () => {
  const hold = paused(); captureGate = hold; click('coherence'); await hold.reached.promise;
  click('microtasks'); const port = await terminal(); assert.match(last(port).text, /microtasks/);
  hold.release.resolve(); await settle(); assert.equal(calls.length, 1); assert.equal(showMessages().length, 1);
  assert.match(last(port).text, /microtasks/); assert.doesNotMatch(last(port).text, /coherence/);
});

test('a new selection aborts the old model stream and old Port controls cannot alter the new answer', async () => {
  const hold = paused(); fetchGate = hold; click('coherence'); await hold.reached.promise;
  const first = ports[0], oldId = last(first).requestId;
  click('microtasks'); const second = await terminal(1);
  assert.equal(calls[0].init.signal?.aborted, true); assert.equal(last(second).status, 'done');
  assert.match(last(second).text, /microtasks/); assert.doesNotMatch(last(second).text, /coherence/);
  first.command('context:stop', oldId); first.command('context:retry', oldId); first.command('context:close', oldId);
  hold.release.resolve(); await settle(); assert.equal(calls.length, 2); assert.equal(last(second).status, 'done'); assert.equal(second.disconnected, false);
});

test('switching between source and iframe closes the old document card and rejects its stale Port controls', async () => {
  click('coherence', 0); const first = await terminal(); const firstId = last(first).requestId;
  click('resilience', 42); const second = await terminal(1); const secondId = last(second).requestId;
  assert.equal(first.disconnected, true);
  assert.ok(messages.some(item => item.message.type === 'context:closed' && item.message.requestId === firstId && item.options?.documentId === 'top-document'));
  assert.match(last(second).text, /resilience/); assert.equal(second.disconnected, false);
  first.command('context:retry', firstId); await settle(); assert.equal(calls.length, 2);
  click('microtasks', 0); const third = await terminal(2);
  assert.equal(second.disconnected, true);
  assert.ok(messages.some(item => item.message.type === 'context:closed' && item.message.requestId === secondId && item.options?.documentId === 'preview-document'));
  second.command('context:retry', secondId); second.command('context:close', secondId); await settle();
  assert.equal(calls.length, 3); assert.match(last(third).text, /microtasks/); assert.equal(third.disconnected, false);
});

test('clearing Key or cancelling during configuration read prevents stale credentials from reaching fetch', async () => {
  const hold = paused(); configGate = hold; click(); await hold.reached.promise;
  cancelContextTasks('Key已清除'); delete session.apiKey; hold.release.resolve(); await settle();
  assert.equal(calls.length, 0); assert.equal(last().status, 'cancelled');
  const nextCount = ports.length; click('microtasks'); await terminal(nextCount); assert.equal(last().status, 'error'); assert.match(last().error!, /API Key/); assert.equal(calls.length, 0);
});

test('configuration-write barrier blocks new lookups until settings settle; cancellation at save completion prevents payment', async () => {
  const hold = paused(); barrier = hold; click(); await hold.reached.promise;
  assert.equal(calls.length, 0); local.settings = { ...config, baseUrl: 'https://new-model.test/v1' }; cancelContextTasks('配置已保存'); hold.release.resolve(); await settle();
  assert.equal(calls.length, 0); assert.equal(last().status, 'cancelled');
});

test('stop aborts the fetch; retry uses a new ID, and delayed old-ID commands cannot stop the replacement', async () => {
  const hold = paused(); fetchGate = hold; click(); await hold.reached.promise;
  const first = ports.at(-1)!, oldId = last(first).requestId; first.command('context:stop'); await waitFor(() => last(first).status === 'cancelled', 'stop');
  assert.equal(calls[0].init.signal?.aborted, true); first.command('context:retry'); const second = await terminal(1);
  assert.notEqual(last(second).requestId, oldId); assert.equal(last(second).status, 'done'); assert.equal(calls.length, 2);
  first.command('context:close', oldId); second.command('context:stop', oldId); await settle(); assert.equal(last(second).status, 'done');
  second.command('context:status'); await settle(); assert.equal(last(second).status, 'done'); hold.release.resolve();
});

test('translation expansion is one extra bilingual-example call and keeps core and details in separate fields', async () => {
  click('microtasks', 42, { menuItemId: CONTEXT_MENU_TRANSLATE }); const first = await terminal(); const core = last(first).text;
  assert.equal(last(first).canExpand, true); first.command('context:expand'); const second = await terminal(1);
  assert.equal(calls.length, 2); assert.equal(last(second).expanded, true); assert.equal(last(second).canExpand, false);
  assert.ok(last(second).text.startsWith(core)); assert.match(last(second).text, /双语例句/);
  assert.equal(last(second).coreText, core); assert.equal(last(second).detailsText, 'ANSWER_microtasks_DETAILS'); assert.equal(last(second).exampleKind, 'bilingual');
  const body = JSON.parse(calls[1].init.body as string); assert.equal(JSON.parse(body.messages[1].content).existingCoreAnswer, core); assert.match(body.messages[0].content, /1—2组双语例句/);
  second.command('context:expand'); await settle(); assert.equal(calls.length, 2);
});

test('navigation and permission revocation stop pending requests, close their exact document UI and discard stale commands', async () => {
  let hold = paused(); fetchGate = hold; click('coherence', 42); await hold.reached.promise;
  frames.set(key(1, 42), { documentId: 'new-preview', url: 'https://preview.test/new', parentFrameId: 0, errorOccurred: false }); navigation.emit({ tabId: 1, frameId: 42, documentId: 'new-preview', url: 'https://preview.test/new' }); await settle();
  assert.equal(calls[0].init.signal?.aborted, true); assert.equal(ports[0].disconnected, true); assert.ok(messages.some(item => item.message.type === 'context:closed' && item.options?.documentId === 'preview-document'));
  hold.release.resolve(); hold = paused(); fetchGate = hold; click('microtasks'); await hold.reached.promise;
  granted.delete(new URL(API).origin + '/*'); removed.emit({ origins: [new URL(API).origin + '/*'] }); await settle();
  assert.equal(calls[1].init.signal?.aborted, true); assert.equal(ports.at(-1)?.disconnected, true); const count = calls.length; ports.at(-1)?.command('context:retry'); await settle(); assert.equal(calls.length, count); hold.release.resolve();
});

test('same-document history navigation and answer Port disconnection stop work and release the prior snapshot', async () => {
  const hold = paused(); fetchGate = hold; click(); await hold.reached.promise;
  frames.set(key(1, 0), { documentId: 'top-document', url: PAGE_URL + '?route=other', parentFrameId: -1, errorOccurred: false }); history.emit({ tabId: 1, frameId: 0, documentId: 'top-document', url: PAGE_URL + '?route=other' }); await settle();
  assert.equal(calls[0].init.signal?.aborted, true); assert.equal(ports[0].disconnected, true); hold.release.resolve();
  frames.set(key(1, 0), { documentId: 'top-document', url: PAGE_URL, parentFrameId: -1, errorOccurred: false }); click('microtasks'); const port = await terminal(1); port.disconnect(); await settle();
  const replacement = connect(); await waitFor(() => replacement.disconnected, 'snapshot discarded after disconnect'); assert.equal(calls.length, 2);
});

test('toolbar eligibility only returns authorized document status; no selection/model work occurs', async () => {
  assert.deepEqual(await runtime({ type: 'context:selection-eligible' }), { ok: true, enabled: true });
  assert.deepEqual(await runtime({ type: 'context:selection-eligible' }, sender(42)), { ok: true, enabled: true });
  for (const source of [sender(0, { id: 'forged' }), sender(0, { documentId: 'old-doc' }), sender(0, { url: 'https://wrong.test/' })]) assert.deepEqual(await runtime({ type: 'context:selection-eligible' }, source), { ok: true, enabled: false });
  granted.delete(new URL(PAGE_URL).origin + '/*'); assert.deepEqual(await runtime({ type: 'context:selection-eligible' }), { ok: true, enabled: false });
  assert.equal(messages.length, 0); assert.equal(calls.length, 0);
});

test('toolbar start sends a nonce-only capture to the exact selected frame and preserves it in show/retry/details', async () => {
  assert.equal((await selection('coherence', 42, 'native-selection-A')).ok, true); const first = await terminal();
  const extraction = messages.find(item => item.message.type === 'context:capture')!;
  assert.equal(extraction.options?.documentId, 'preview-document'); assert.equal(extraction.message.captureId, 'native-selection-A'); assert.equal(extraction.message.selectedText, undefined);
  assert.equal(showMessages().at(-1)?.message.captureId, 'native-selection-A'); assert.equal(last(first).coreText, 'ANSWER_coherence'); assert.equal(last(first).detailsText, '');
  first.command('context:expand'); const second = await terminal(1); assert.equal(showMessages().at(-1)?.message.captureId, 'native-selection-A'); assert.equal(last(second).exampleKind, 'bilingual');
  second.command('context:retry'); await terminal(2); assert.equal(showMessages().at(-1)?.message.captureId, 'native-selection-A'); assert.equal(calls.length, 3);
});

test('forged toolbar identities and a stale capture nonce never call the model or replace a valid live task', async () => {
  const hold = paused(); fetchGate = hold; click('coherence'); await hold.reached.promise;
  for (const source of [sender(0, { id: 'forged' }), sender(0, { documentId: 'old-doc' }), sender(0, { url: 'https://wrong.test/' })]) assert.equal((await runtime({ type: 'context:selection-start', mode: 'translate', captureId: 'bad' }, source)).ok, false);
  assert.equal(calls.length, 1); assert.equal(calls[0].init.signal?.aborted, false);
  hold.release.resolve(); await terminal();
  capture = { ok: true, snapshot: snapshot('microtasks') }; captureNonce = 'current-nonce';
  assert.equal((await runtime({ type: 'context:selection-start', mode: 'translate', captureId: 'old-nonce' })).ok, false);
  await terminal(1); assert.equal(calls.length, 1); assert.equal(last().status, 'error'); assert.match(last().error!, /失效/);
});

test('dismiss cancels a pending capture before payment; old selection IDs cannot close the replacement', async () => {
  const hold = paused(); captureGate = hold; const first = selection('coherence', 0, 'capture-A'); await hold.reached.promise;
  await runtime({ type: 'context:selection-dismiss', captureId: 'capture-A' });
  assert.equal((await selection('microtasks', 0, 'capture-B')).ok, true); const port = await terminal();
  await runtime({ type: 'context:selection-dismiss', captureId: 'capture-A' }); await runtime({ type: 'context:selection-dismiss', captureId: 'capture-B', requestId: 'old-request' });
  assert.equal(port.disconnected, false); assert.equal(last(port).status, 'done');
  hold.release.resolve(); assert.equal((await first).ok, false); await settle(); assert.equal(calls.length, 1); assert.match(last(port).coreText, /microtasks/);
  await runtime({ type: 'context:selection-dismiss', captureId: 'capture-B', requestId: last(port).requestId }); assert.equal(port.disconnected, true);
});

test('dismiss during the initial browser lookup prevents capture, UI and model calls', async () => {
  const starting = selection('coherence', 0, 'pending-lookup');
  await runtime({ type: 'context:selection-dismiss', captureId: 'pending-lookup' });
  assert.equal((await starting).ok, false); await settle();
  assert.equal(messages.length, 0); assert.equal(calls.length, 0); assert.equal(ports.length, 0);
});

test('a dismiss carrying an older request ID cannot cancel a newer pending browser lookup', async () => {
  const starting = selection('coherence', 0, 'new-pending-lookup');
  await runtime({ type: 'context:selection-dismiss', captureId: 'new-pending-lookup', requestId: 'older-request-id' });
  assert.equal((await starting).ok, true); const port = await terminal();
  assert.equal(last(port).status, 'done'); assert.equal(calls.length, 1);
});

test('toolbar capture tokens cannot cross frame/document identities or accept a snapshot from another URL', async () => {
  for (const source of [sender(42, { documentId: 'top-document' }), sender(0, { frameId: 42 }), sender(42, { url: PAGE_URL })]) {
    assert.equal((await selection('coherence', 42, 'frame-nonce', source)).ok, false);
  }
  assert.equal(messages.length, 0); assert.equal(calls.length, 0);
  capture = { ok: true, snapshot: snapshot('coherence', 42) }; captureNonce = 'frame-nonce';
  assert.equal((await runtime({ type: 'context:selection-start', mode: 'translate', captureId: 'frame-nonce' }, sender(0))).ok, false);
  await terminal(); assert.equal(last().status, 'error'); assert.match(last().error!, /导航/); assert.equal(calls.length, 0);
  assert.equal(messages.find(item => item.message.type === 'context:capture')?.options?.documentId, 'top-document');
});

test('long translation has no example expansion even if a stale UI sends the expand command', async () => {
  click('A complete paragraph with context. '.repeat(10), 0, { menuItemId: CONTEXT_MENU_TRANSLATE }); const port = await terminal();
  assert.equal(last(port).status, 'done'); assert.equal(last(port).exampleKind, undefined); assert.equal(last(port).canExpand, false);
  port.command('context:expand'); await settle(); assert.equal(calls.length, 1); assert.equal(ports.length, 1);
});

test('save takes the authoritative iframe snapshot, deduplicates and updates examples without a model call', async () => {
  await selection('resilience', 42); const first = await terminal();
  first.onMessage.emit({ type: 'context:save', requestId: last(first).requestId, text: 'FORGED', coreText: 'FORGED' });
  first.command('context:save');
  await waitFor(() => last(first).saved === true, 'saved phrase');
  const saved = local.savedPhrases as Record<string, unknown>[];
  assert.equal(saved.length, 1); assert.equal(saved[0].text, 'resilience');
  assert.equal(saved[0].sourceUrl, 'https://preview.test/article'); assert.equal(saved[0].sourceTitle, 'Technical article');
  assert.equal(saved[0].coreText, 'ANSWER_resilience'); assert.match(String(saved[0].context), /NEAR_RESILIENCE_ONLY/);
  assert.ok(!JSON.stringify(saved).includes(KEY)); assert.equal(calls.length, 1);
  const id = saved[0].id;
  first.command('context:expand'); const second = await terminal(1);
  assert.equal(last(second).savedId, id); assert.equal(last(second).saved, undefined);
  second.command('context:save'); await waitFor(() => last(second).saved === true, 'updated saved examples');
  const updated = local.savedPhrases as Record<string, unknown>[];
  assert.equal(updated.length, 1); assert.equal(updated[0].id, id);
  assert.equal(updated[0].detailsText, 'ANSWER_resilience_DETAILS'); assert.equal(updated[0].exampleKind, 'bilingual');
  assert.equal(calls.length, 2);
});

test('unfinished, stopped and stale answer controls cannot save or open a collection tab', async () => {
  const hold = paused(); fetchGate = hold; click(); await hold.reached.promise;
  const first = ports.at(-1)!; first.command('context:save'); await settle(); assert.equal(local.savedPhrases, undefined);
  first.command('context:stop'); await waitFor(() => last(first).status === 'cancelled', 'stop before save');
  first.command('context:save'); await settle(); assert.equal(local.savedPhrases, undefined);
  hold.release.resolve(); click('microtasks', 42); const second = await terminal(1);
  first.command('context:save'); first.command('context:open-phrases'); await settle();
  assert.equal(local.savedPhrases, undefined); assert.equal(openedTabs.length, 0);
  second.command('context:open-phrases'); await waitFor(() => openedTabs.length === 1, 'open collection');
  assert.deepEqual(openedTabs, [{ url: `chrome-extension://${ID}/phrases.html` }]); assert.equal(calls.length, 2);
});

test('a failed phrase write keeps the completed answer and permits explicit retry without paying again', async () => {
  click(); const port = await terminal(); phraseWriteError = true; port.command('context:save');
  await waitFor(() => !!last(port).saveError, 'storage failure');
  assert.equal(last(port).status, 'done'); assert.equal(last(port).saving, false); assert.equal(last(port).saved, undefined);
  assert.equal(local.savedPhrases, undefined); assert.equal(last(port).coreText, 'ANSWER_coherence');
  phraseWriteError = false; port.command('context:save'); await waitFor(() => last(port).saved === true, 'retry phrase write');
  assert.equal(last(port).saveError, undefined); assert.equal((local.savedPhrases as unknown as unknown[]).length, 1); assert.equal(calls.length, 1);
});

test('a delayed explicitly clicked save cannot mark a replacement answer as saved', async () => {
  click(); const first = await terminal(), hold = paused(); phraseWriteGate = hold;
  first.command('context:save'); await hold.reached.promise;
  click('microtasks', 42); const second = await terminal(1); hold.release.resolve(); await settle();
  assert.equal((local.savedPhrases as Record<string, unknown>[])[0].text, 'coherence');
  assert.equal(last(second).saved, undefined); assert.equal(last(second).savedId, undefined);
  assert.equal(last(second).coreText, 'ANSWER_microtasks'); assert.equal(calls.length, 2);
});

test('deleting a saved entry restores the current card save action without another model call', async () => {
  click(); const port = await terminal(); port.command('context:save');
  await waitFor(() => last(port).saved === true, 'initial save');
  const id = last(port).savedId!;
  await (await import('../src/phrases.ts')).deletePhrase(id); forgetSavedPhrase(id);
  assert.equal(last(port).saved, false); assert.equal(last(port).savedId, undefined);
  port.command('context:save'); await waitFor(() => last(port).saved === true, 'save after delete');
  assert.notEqual(last(port).savedId, id); assert.equal((local.savedPhrases as unknown[]).length, 1); assert.equal(calls.length, 1);
});
