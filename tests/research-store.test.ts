import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ResearchClaim, ResearchTask, SavedResearch } from '../src/research-shared.ts';

const local: Record<string, unknown> = {};
const calls = { get: [] as string[], set: [] as unknown[], access: [] as string[] };
let failNextWrite = false;
let delayed = false;
const wait = async () => { if (delayed) await new Promise(resolve => setTimeout(resolve, 2)); };
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      setAccessLevel: async ({ accessLevel }: { accessLevel: string }) => { assert.equal(accessLevel, 'TRUSTED_CONTEXTS'); calls.access.push('local'); },
      get: async (key: string) => {
        assert.equal(key, 'researchReports'); assert.deepEqual(calls.access, ['local', 'session']); calls.get.push(key);
        await wait(); return key in local ? { [key]: structuredClone(local[key]) } : {};
      },
      set: async (data: Record<string, unknown>) => {
        assert.deepEqual(Object.keys(data), ['researchReports']); assert.deepEqual(calls.access, ['local', 'session']);
        calls.set.push(structuredClone(data)); await wait();
        if (failNextWrite) { failNextWrite = false; throw new Error('QUOTA_BYTES storage unavailable'); }
        Object.assign(local, structuredClone(data));
      }
    },
    session: {
      setAccessLevel: async ({ accessLevel }: { accessLevel: string }) => { assert.equal(accessLevel, 'TRUSTED_CONTEXTS'); calls.access.push('session'); },
      get: async () => { throw new Error('must not read session or API Key'); },
      set: async () => { throw new Error('must not write session'); }
    },
    get sync() { throw new Error('must not use sync storage'); }
  }
};
const { saveResearchReport, listResearchReports, deleteResearchReport, MAX_SAVED_RESEARCH, MAX_SAVED_RESEARCH_BYTES } = await import('../src/research-store.ts');
const claim = (text = 'The source supports this claim.'): ResearchClaim => ({ text, citations: [{ sourceId: 'S1', finding: 0 }] });
function task(index = 0): ResearchTask {
  return {
    id: `task-${index}`, question: 'How does backpressure work?', urls: ['https://docs.test/backpressure'],
    sources: [{ id: 'S1', requestedUrl: 'https://docs.test/backpressure', url: 'https://docs.test/backpressure', title: 'Backpressure', status: 'done', findings: [{ point: 'Producers wait for demand.', quote: 'A producer waits until demand is available.' }], characters: 1200, notice: 'Read the available article text.' }],
    status: 'done', stage: 'Research complete', calls: 2, maxCalls: 6, createdAt: 1_700_000_000_000 + index, updatedAt: 1_700_000_000_100 + index,
    report: { overview: [claim()], comparisons: [claim('No other successful source is available.')], conclusion: [claim('Wait for demand.')] }
  };
}
function saved(index = 0): SavedResearch { const reportTask = task(index); return { id: `saved-${index}`, savedAt: reportTask.updatedAt + 100, task: reportTask }; }
beforeEach(() => {
  for (const key of Object.keys(local)) delete local[key];
  calls.get.length = 0; calls.set.length = 0; failNextWrite = false; delayed = false;
});

test('saves a complete report using only local report storage and an explicit nested field whitelist', async () => {
  local.apiKey = 'private-local-key'; local.settings = { model: 'private-model' };
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('must not use network'); };
  try {
    const clean = task();
    const injected = structuredClone(clean) as ResearchTask & Record<string, unknown>;
    injected.apiKey = 'injected-key'; injected.config = { apiKey: 'nested-key' }; injected.savedId = 'stale-saved-id';
    Object.assign(injected.sources[0], { apiKey: 'source-key', rawBody: 'private-body' });
    Object.assign(injected.sources[0].findings[0], { apiKey: 'finding-key' });
    Object.assign(injected.report!, { unexpected: 'unknown-report' });
    Object.assign(injected.report!.overview[0], { config: { key: 'claim-key' } });
    Object.assign(injected.report!.overview[0].citations[0], { apiKey: 'citation-key' });
    const result = await saveResearchReport(injected);
    assert.match(result.id, /^[0-9a-f-]{36}$/u); assert.ok(result.savedAt >= clean.updatedAt);
    assert.deepEqual(result.task, clean); assert.deepEqual(await listResearchReports(), [result]);
    const written = JSON.stringify(calls.set); for (const excluded of ['apiKey', 'config', 'private', 'injected', 'nested', 'stale-saved-id', 'source-key', 'finding-key', 'claim-key', 'citation-key', 'unknown-report', 'rawBody']) assert.ok(!written.includes(excluded), excluded);
    assert.equal(local.apiKey, 'private-local-key'); assert.deepEqual(local.settings, { model: 'private-model' });
    result.task.sources[0].findings[0].point = 'mutated result';
    assert.equal((await listResearchReports())[0].task.sources[0].findings[0].point, clean.sources[0].findings[0].point);
    const listed = await listResearchReports(); listed[0].task.report!.overview[0].citations[0].sourceId = 'mutated list';
    assert.equal((await listResearchReports())[0].task.report!.overview[0].citations[0].sourceId, 'S1');
  } finally { globalThis.fetch = originalFetch; }
});

test('task ID deduplicates repeated saves, preserving saved ID and refreshing sort order', async () => {
  const first = await saveResearchReport(task()); const second = await saveResearchReport(task(1));
  const changed = task(); changed.report!.conclusion = [claim('Updated supported conclusion.')];
  const update = await saveResearchReport(changed);
  assert.equal(update.id, first.id); assert.ok(update.savedAt > second.savedAt);
  assert.deepEqual((await listResearchReports()).map(entry => entry.id), [first.id, second.id]);
  assert.equal((await listResearchReports())[0].task.report!.conclusion[0].text, 'Updated supported conclusion.');
});

test('concurrent saves, updates and deletes are serialized, and list waits for acknowledged queue work', async () => {
  delayed = true;
  const previous = await saveResearchReport(task(19));
  const pending = Array.from({ length: 10 }, (_, index) => saveResearchReport(task(index)));
  const deleting = deleteResearchReport(previous.id);
  const changed = task(); changed.stage = 'Updated report';
  const updating = saveResearchReport(changed); const listing = listResearchReports();
  const results = await Promise.all(pending); await deleting; const updated = await updating; const entries = await listing;
  assert.equal(entries.length, 10); assert.equal(new Set(entries.map(entry => entry.id)).size, 10);
  assert.equal(updated.id, results[0].id); assert.equal(entries[0].task.stage, 'Updated report');
  assert.ok(entries.every(entry => entry.id !== previous.id));
  await deleteResearchReport('unknown-id'); assert.deepEqual(await listResearchReports(), entries);
});

test('queued saves copy their entire nested input before the caller can mutate it', async () => {
  delayed = true;
  const payload = task(); const expected = structuredClone(payload); const pending = saveResearchReport(payload);
  payload.question = 'mutated'; payload.urls[0] = 'https://other.test/'; payload.sources[0].findings[0].quote = 'mutated quote';
  payload.report!.overview[0].citations[0].finding = 3;
  assert.deepEqual((await pending).task, expected);
});

test('completed reports allow failed sources and empty comparisons, while citations still require successful evidence', async () => {
  const partial = task(); partial.urls.push('https://docs.test/unavailable');
  partial.sources.push({ id: 'S2', requestedUrl: partial.urls[1], title: '', status: 'error', findings: [], error: 'Page unavailable.' });
  partial.report!.comparisons = []; partial.report!.conclusion = [];
  assert.deepEqual((await saveResearchReport(partial)).task, partial);
  const loopback = task(1); loopback.urls[0] = 'http://localhost:4317/article'; loopback.sources[0].requestedUrl = loopback.urls[0]; loopback.sources[0].url = 'http://127.0.0.1:4317/redirect';
  assert.deepEqual((await saveResearchReport(loopback)).task, loopback);
  const canonical = task(2); canonical.urls[0] = 'https://DOCS.test:443/backpressure'; canonical.sources[0].requestedUrl = canonical.urls[0];
  assert.equal((await saveResearchReport(canonical)).task.urls[0], 'https://docs.test/backpressure');
});

test('invalid task fields, unfinished reports, source mismatches and dangling citations never modify storage', async () => {
  const original = await saveResearchReport(task()); const baseline = structuredClone(local.researchReports);
  const variants: Array<(value: ResearchTask) => void> = [
    value => { value.status = 'synthesizing'; }, value => { delete value.report; }, value => { value.report!.overview = []; },
    value => { value.question = ''; }, value => { value.question = 'x'.repeat(1501); }, value => { value.urls = []; },
    value => { value.urls[0] = 'https://user:password@docs.test/'; }, value => { value.urls[0] = 'http://remote.test/article'; },
    value => { value.urls[0] = 'javascript:alert(1)'; }, value => { value.urls[0] = 'https://docs.test/\narticle'; },
    value => { value.id = 'bad id'; }, value => { value.id = 'x'.repeat(101); }, value => { value.createdAt = -1; },
    value => { value.updatedAt = value.createdAt - 1; }, value => { value.calls = 3; }, value => { value.calls = 1.5; },
    value => { value.maxCalls = 5; }, value => { value.sources = []; }, value => { value.sources[0].status = 'reading'; },
    value => { value.sources[0].id = 'S2'; }, value => { value.sources[0].requestedUrl = 'https://other.test/'; },
    value => { value.sources[0].url = 'file:///private.txt'; }, value => { value.sources[0].title = 'x'.repeat(501); },
    value => { value.sources[0].characters = 1_000_001; }, value => { value.sources[0].notice = 'x'.repeat(2001); },
    value => { value.sources[0].findings = []; }, value => { value.sources[0].findings.push(...Array.from({ length: 4 }, () => structuredClone(value.sources[0].findings[0]))); },
    value => { value.sources[0].findings[0].point = 'x'.repeat(601); }, value => { value.sources[0].findings[0].quote = 'short'; },
    value => { value.sources[0].findings[0].quote = 'x'.repeat(401); }, value => { value.sources[0].status = 'error'; },
    value => { value.report!.overview[0].text = 'x'.repeat(1501); }, value => { value.report!.overview[0].citations = []; },
    value => { value.report!.overview[0].citations[0].sourceId = 'S2'; }, value => { value.report!.overview[0].citations[0].finding = 1; },
    value => { value.report!.overview[0].citations.push({ sourceId: 'S1', finding: 0 }); },
    value => { value.report!.conclusion = Array.from({ length: 9 }, () => claim()); },
    value => { value.report!.overview = new Array(1); }, value => { value.sources[0].findings = new Array(1); },
    value => { value.report!.overview[0].citations = new Array(1); }
  ];
  for (const invalid of [null, [], {}, 'text']) await assert.rejects(saveResearchReport(invalid as unknown as ResearchTask));
  for (const mutate of variants) { const invalid = task(1); mutate(invalid); await assert.rejects(saveResearchReport(invalid), mutate.toString()); }
  for (const invalid of ['', 'bad id', 'x'.repeat(101), 5]) await assert.rejects(deleteResearchReport(invalid as string));
  assert.deepEqual(local.researchReports, baseline); assert.equal(calls.set.length, 1); assert.deepEqual(await listResearchReports(), [original]);
});

test('20 report limit refuses new reports without eviction while updates and deletion remain available', async () => {
  local.researchReports = Array.from({ length: MAX_SAVED_RESEARCH }, (_, index) => saved(index));
  const baseline = structuredClone(local.researchReports);
  await assert.rejects(saveResearchReport(task(20)), /20.*上限/u);
  assert.deepEqual(local.researchReports, baseline); assert.equal(calls.set.length, 0);
  assert.equal((await saveResearchReport(task(0))).id, 'saved-0');
  await deleteResearchReport('saved-1'); await saveResearchReport(task(20));
  assert.equal((await listResearchReports()).length, MAX_SAVED_RESEARCH);
});

test('1.5 MiB limit measures UTF-8 multibyte contents and preserves old reports at capacity', async () => {
  function large(index: number): SavedResearch {
    const entry = saved(index);
    entry.task.urls = Array.from({ length: 5 }, (_, index) => `https://docs.test/source-${index}`);
    entry.task.sources = entry.task.urls.map((url, index) => ({
      id: `S${index + 1}`, requestedUrl: url, url, title: '中'.repeat(500), status: 'done', characters: 10000,
      findings: Array.from({ length: 4 }, () => ({ point: '中'.repeat(600), quote: '文'.repeat(400) })), notice: '范'.repeat(2000)
    }));
    const citations = entry.task.sources.flatMap(source => source.findings.map((_, index) => ({ sourceId: source.id, finding: index })));
    entry.task.report = Object.fromEntries(['overview', 'comparisons', 'conclusion'].map(key => [key, Array.from({ length: 8 }, () => ({ text: '据'.repeat(1500), citations: structuredClone(citations) }))])) as unknown as ResearchTask['report'];
    return entry;
  }
  const entries: SavedResearch[] = [];
  while (true) {
    const candidate = large(entries.length);
    if (new TextEncoder().encode(JSON.stringify({ researchReports: [...entries, candidate] })).byteLength > MAX_SAVED_RESEARCH_BYTES) break;
    entries.push(candidate);
  }
  assert.ok(entries.length < MAX_SAVED_RESEARCH && entries.length > 0);
  local.researchReports = entries; const baseline = JSON.stringify(entries);
  assert.ok(new TextEncoder().encode(baseline).byteLength > baseline.length);
  await assert.rejects(saveResearchReport(large(entries.length).task), /1.5 MiB.*上限/u);
  assert.equal(JSON.stringify(local.researchReports), baseline); assert.equal(calls.set.length, 0);
  await deleteResearchReport(entries[0].id); await saveResearchReport(large(entries.length).task);
  assert.equal((await listResearchReports()).length, entries.length);
});

test('corrupt or incompatible stored reports cannot be overwritten or deleted and can recover after repair', async () => {
  const valid = saved();
  const corruption: unknown[] = [null, {}, 'text', [null], [{ ...valid, id: 'bad id' }], [{ ...valid, savedAt: -1 }],
    [{ ...valid, extra: 'unknown' }], [{ ...valid, task: { ...valid.task, apiKey: 'injected-key' } }],
    [{ ...valid, task: { ...valid.task, sources: [{ ...valid.task.sources[0], extra: true }] } }],
    [valid, { ...saved(1), id: valid.id }], [valid, { ...valid, id: 'different-saved-id' }]];
  for (const data of corruption) {
    local.researchReports = data; const baseline = structuredClone(data);
    await assert.rejects(listResearchReports(), /损坏.*未覆盖/u);
    await assert.rejects(saveResearchReport(task(2)), /损坏.*未覆盖/u);
    await assert.rejects(deleteResearchReport(valid.id), /损坏.*未覆盖/u);
    assert.deepEqual(local.researchReports, baseline);
  }
  assert.equal(calls.set.length, 0);
  local.researchReports = [valid]; assert.deepEqual(await listResearchReports(), [valid]);
  await saveResearchReport(task(1)); assert.equal((await listResearchReports()).length, 2);
});

test('failed writes leave old data intact and do not poison subsequent queued saves or deletes', async () => {
  const first = await saveResearchReport(task()); const baseline = structuredClone(local.researchReports);
  failNextWrite = true;
  const failing = saveResearchReport(task(1)); const succeeding = saveResearchReport(task(2));
  await assert.rejects(failing, /QUOTA_BYTES/u); const second = await succeeding;
  assert.deepEqual((local.researchReports as SavedResearch[]).filter(entry => entry.id !== second.id), baseline);
  failNextWrite = true;
  const failingDelete = deleteResearchReport(first.id); const succeedingDelete = deleteResearchReport(second.id);
  await assert.rejects(failingDelete, /QUOTA_BYTES/u); await succeedingDelete;
  assert.deepEqual(await listResearchReports(), baseline);
});
