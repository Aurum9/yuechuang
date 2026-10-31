import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DEFAULT_SETTINGS } from '../src/shared.ts';
import type { ResearchTask } from '../src/research-shared.ts';

class Hub<T extends unknown[]> { listeners: ((...args: T) => unknown)[] = []; addListener(fn: (...args: T) => unknown) { this.listeners.push(fn); } emit(...args: T) { for (const fn of [...this.listeners]) fn(...args); } }
type Message = Record<string, unknown>;
type Reply = { ok: boolean; error?: string; task?: ResearchTask; [key: string]: unknown };
function gate() { let release!: () => void, reached!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), arrived: new Promise<void>(resolve => { reached = resolve; }), release: () => release(), reach: () => reached() }; }
type Gate = ReturnType<typeof gate>;
const ID = 'research-test', API = 'https://api.test/v1', KEY = 'research-unit-key-never-real';
const A = 'https://docs.test/a', B = 'https://docs.test/b';
const urls = [A, B];
const local: Record<string, unknown> = {}, session: Record<string, unknown> = {};
const granted = new Set<string>(), tabs = new Map<number, { id: number; url: string; status: string }>();
const created: string[] = [], removed: number[] = [], calls: { input: Message; signal: AbortSignal }[] = [], extracts: { options: { documentId: string }; url: string }[] = [];
const messages = new Hub<[Message, chrome.runtime.MessageSender, (reply: Reply) => void]>(), connects = new Hub<[chrome.runtime.Port]>(), permissionRemoved = new Hub<[chrome.permissions.Permissions]>();
let nextId = 100, fetchGate: Gate | undefined, createGate: Gate | undefined, configGate: Gate | undefined;
let missingB = false, redirected = false, cancelResearch: typeof import('../src/research-background.ts').cancelResearch;
const quotes = ['The cache rejects stale versions before serving a response.', 'The scheduler queues microtasks before the next task begins.'];
const bodyText = (url: string) => (url === A ? quotes[0] : quotes[1]) + ' This technical documentation contains implementation details and causal explanations for developers. '.repeat(6);
function area(values: Record<string, unknown>) { return { async setAccessLevel() {}, async get(keys: string | string[]) { return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in values).map(key => [key, values[key]]))); }, async set(data: Message) { Object.assign(values, structuredClone(data)); }, async remove(key: string) { delete values[key]; } }; }
const chromeMock = {
  runtime: { id: ID, getURL: (file: string) => `chrome-extension://${ID}/${file}`, onMessage: messages, onConnect: connects },
  storage: { local: area(local), session: area(session) },
  permissions: { onRemoved: permissionRemoved, async contains({ origins }: { origins: string[] }) { return origins.every(origin => granted.has(origin)); }, async getAll() { return { origins: [...granted] }; } },
  tabs: {
    async create({ url }: { url: string }) { const id = nextId++, target = { id, url: redirected ? 'https://other.test/unrequested' : url, status: 'complete' }; tabs.set(id, target); created.push(url); if (createGate) { const hold = createGate; createGate = undefined; hold.reach(); await hold.promise; } return structuredClone(target); },
    async get(id: number) { const tab = tabs.get(id); if (!tab) throw new Error('No tab'); return structuredClone(tab); },
    async remove(id: number) { removed.push(id); tabs.delete(id); },
    async sendMessage(id: number, message: Message, options: { documentId: string }) {
      if (message.type === 'research:cancel') return;
      assert.equal(message.type, 'research:extract'); const url = tabs.get(id)!.url;
      assert.equal(options.documentId, `doc-${id}`); extracts.push({ options, url });
      if (url === B && missingB) return { ok: false, message: 'Login required' };
      return { ok: true, article: { title: url === A ? 'Cache document' : 'Scheduler document', url, text: bodyText(url), originalLength: bodyText(url).length, truncated: false, coverage: 'visible' } };
    }
  },
  webNavigation: { async getFrame({ tabId }: { tabId: number }) { const tab = tabs.get(tabId); return tab ? { documentId: `doc-${tabId}`, url: tab.url, parentFrameId: -1, errorOccurred: false } : null; } },
  scripting: { async executeScript() { return []; } }
};
const sender = (overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({ id: ID, url: `chrome-extension://${ID}/research.html`, frameId: 0, documentId: 'research-page', tab: { id: 1 } as chrome.tabs.Tab, ...overrides });
function send(message: Message, source = sender()) { return new Promise<Reply>(resolve => messages.emit(message, source, resolve)); }
async function until(predicate: () => boolean, label: string) { const deadline = Date.now() + 2500; while (!predicate()) { if (Date.now() > deadline) throw new Error('Timeout: ' + label); await nextTurn(); } }
async function finished(id: string): Promise<ResearchTask> { const deadline = Date.now() + 2500; while (Date.now() < deadline) { const task = (await send({ type: 'research:status' })).task!; if (task.id === id && ['done','error','cancelled'].includes(task.status)) return task; await nextTurn(); } throw new Error('Task did not finish'); }
async function start(targets = urls): Promise<ResearchTask> { const reply = await send({ type: 'research:start', question: '比较实现方式与执行顺序', urls: targets }); assert.equal(reply.ok, true, reply.error); return reply.task!; }

before(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init!.body as string), input = JSON.parse(body.messages[1].content) as Message;
    calls.push({ input, signal: init!.signal as AbortSignal });
    if (fetchGate) { const hold = fetchGate; fetchGate = undefined; hold.reach(); await new Promise<void>((resolve, reject) => { hold.promise.then(resolve); init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); }); }
    const value = Array.isArray(input.sources)
      ? { overview: [{ text: '不同来源提供各自的实现证据。', citations: (input.sources as { sourceId: string }[]).map(source => ({ sourceId: source.sourceId, finding: 0 })) }], comparisons: [], conclusion: [] }
      : { findings: [{ point: '页面包含可核对的执行机制。', quote: input.url === A ? quotes[0] : quotes[1] }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const research = await import('../src/research-background.ts'); cancelResearch = research.cancelResearch;
  research.initializeResearch({ configurationReady: async () => { if (configGate) { const hold = configGate; configGate = undefined; hold.reach(); await hold.promise; } } });
});
beforeEach(async () => {
  cancelResearch(); fetchGate?.release(); createGate?.release(); configGate?.release(); fetchGate = createGate = configGate = undefined;
  for (let index = 0; index < 8; index++) await nextTurn();
  for (const key of Object.keys(local)) delete local[key]; for (const key of Object.keys(session)) delete session[key];
  local.settings = { ...DEFAULT_SETTINGS, baseUrl: API, model: 'research-test' }; session.apiKey = KEY;
  granted.clear(); granted.add('https://docs.test/*'); granted.add('https://api.test/*');
  tabs.clear(); created.length = removed.length = calls.length = extracts.length = 0; missingB = redirected = false;
  connects.emit({ name: 'research', sender: sender(), onMessage: new Hub<[Message]>(), onDisconnect: new Hub<[]>(), disconnect() {} } as unknown as chrome.runtime.Port);
});

test('research messages reject content scripts, settings, other extensions and nested pages before touching data', async () => {
  for (const source of [sender({ url: A }), sender({ url: `chrome-extension://${ID}/options.html` }), sender({ id: 'other' }), sender({ frameId: 1 }), sender({ url: `chrome-extension://${ID}/research.html?forged` })]) {
    for (const type of ['research:view','research:status','research:start','research:stop','research:save','research:delete']) assert.equal((await send({ type, question: 'test', urls }, source)).ok, false);
  }
  const view = await send({ type: 'research:view' }); assert.equal(view.hasKey, true); assert.ok(!JSON.stringify(view).includes(KEY));
  assert.equal(calls.length, 0); assert.equal(created.length, 0);
});
test('invalid, duplicate, excessive and ungranted input causes zero tabs and model requests', async () => {
  for (const target of [[], [A,A], Array.from({ length: 6 }, (_, index) => A + index), ['javascript:alert(1)'], ['http://private.test/'], ['https://ungranted.test/']]) assert.equal((await send({ type: 'research:start', question: '比较', urls: target })).ok, false);
  granted.delete('https://api.test/*'); assert.equal((await send({ type: 'research:view' })).settingsReady, false); assert.equal((await send({ type: 'research:start', question: '比较', urls })).ok, false);
  assert.equal(created.length, 0); assert.equal(calls.length, 0);
});
test('two documents use exact top documents, make three bounded requests and save only the completed authoritative report', async () => {
  const task = await finished((await start()).id);
  assert.equal(task.status, 'done'); assert.equal(task.calls, 3); assert.equal(calls.length, 3); assert.equal(tabs.size, 0);
  assert.deepEqual(task.sources.map(source => source.url), urls); assert.equal(extracts.length, 2);
  assert.ok(task.sources.every((source, index) => source.findings[0].quote === quotes[index]));
  assert.ok(!JSON.stringify(task).includes(KEY)); assert.equal(JSON.stringify(calls.map(call => call.input)).includes(KEY), false);
  const saved = await send({ type: 'research:save', id: task.id, task: { ...task, question: 'FORGED' } }); assert.equal(saved.ok, true, saved.error);
  const again = await send({ type: 'research:save', id: task.id }); assert.equal(again.ok, true, again.error);
  const reports = (await send({ type: 'research:view' })).reports as { id: string; task: ResearchTask }[];
  assert.equal(reports.length, 1); assert.equal(reports[0].task.question, task.question); assert.ok(!JSON.stringify(local.researchReports).includes(KEY));
  assert.equal((await send({ type: 'research:delete', id: reports[0].id })).ok, true); assert.equal((await send({ type: 'research:status' })).task?.savedId, undefined);
});
test('failed pages are excluded from synthesis, and over-budget pages make no calls', async () => {
  missingB = true; let task = await finished((await start()).id);
  assert.equal(task.status, 'done'); assert.equal(task.sources[1].status, 'error'); assert.match(task.error!, /1 个来源/); assert.equal(task.calls, 2);
  assert.deepEqual((calls.at(-1)!.input.sources as { sourceId: string }[]).map(source => source.sourceId), ['S1']);
  local.settings = { ...local.settings as object, inputBudgetTokens: 2048 }; calls.length = 0;
  task = await finished((await start()).id); assert.equal(task.status, 'error'); assert.equal(task.calls, 0); assert.equal(calls.length, 0);
  assert.equal((await send({ type: 'research:save', id: task.id })).ok, false);
});
test('stop cancels the active request, rejects old IDs and never advances to another page or report', async () => {
  const hold = gate(); fetchGate = hold; const task = await start(); await hold.arrived;
  assert.equal((await send({ type: 'research:stop', id: 'old-task' })).ok, false); assert.equal(calls[0].signal.aborted, false);
  assert.equal((await send({ type: 'research:stop', id: task.id })).ok, true); assert.equal(calls[0].signal.aborted, true);
  hold.release(); const stopped = await finished(task.id); assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.report, undefined);
  for (let index = 0; index < 8; index++) await nextTurn(); assert.equal(calls.length, 1); assert.equal(created.length, 1); assert.equal(tabs.size, 0);
});
test('cancellation during tab creation cleans the owned tab before any model call; unexpected navigation is kept unread', async () => {
  const hold = gate(); createGate = hold; const task = await start(); await hold.arrived;
  await send({ type: 'research:stop', id: task.id }); hold.release(); await until(() => tabs.size === 0, 'late created tab cleanup'); assert.equal(calls.length, 0);
  redirected = true; const final = await finished((await start([A])).id);
  assert.equal(final.status, 'error'); assert.equal(calls.length, 0); assert.equal(tabs.size, 1); assert.match(final.sources[0].error!, /跳转/);
});
test('configuration barrier and permission revocation stop pending work without paying again', async () => {
  const hold = gate(); configGate = hold; const pending = send({ type: 'research:start', question: '比较', urls }); await hold.arrived;
  cancelResearch('configuration changed'); hold.release(); assert.equal((await pending).ok, false); assert.equal(calls.length, 0); assert.equal(created.length, 0);
  const model = gate(); fetchGate = model; const task = await start(); await model.arrived;
  granted.delete('https://docs.test/*'); permissionRemoved.emit({ origins: ['https://docs.test/*'] }); model.release();
  assert.equal((await finished(task.id)).status, 'cancelled'); assert.equal(calls[0].signal.aborted, true); assert.equal(calls.length, 1);
});
test('closing a different research page keeps the task, while closing its owning page stops it', async () => {
  const hold = gate(); fetchGate = hold; const task = await start(); await hold.arrived;
  const first = new Hub<[]>(), second = new Hub<[]>();
  for (const [documentId, disconnect] of [['other-page', first], ['research-page', second]] as const) connects.emit({ name: 'research', sender: sender({ documentId }), onMessage: new Hub<[Message]>(), onDisconnect: disconnect, disconnect() {} } as unknown as chrome.runtime.Port);
  first.emit(); assert.equal(calls[0].signal.aborted, false); second.emit(); assert.equal(calls[0].signal.aborted, true); hold.release();
  assert.equal((await finished(task.id)).status, 'cancelled'); assert.equal(calls.length, 1);
});
test('closing the research page during configuration lookup prevents a late task from starting', async () => {
  const hold = gate(), disconnect = new Hub<[]>(); configGate = hold;
  connects.emit({ name: 'research', sender: sender(), onMessage: new Hub<[Message]>(), onDisconnect: disconnect, disconnect() {} } as unknown as chrome.runtime.Port);
  const pending = send({ type: 'research:start', question: '比较', urls }); await hold.arrived;
  disconnect.emit(); hold.release(); assert.equal((await pending).ok, false); assert.equal(calls.length, 0); assert.equal(created.length, 0);
});
