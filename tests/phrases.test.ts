import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PhraseInput, SavedPhrase } from '../src/phrases.ts';

const local: Record<string, unknown> = {};
const calls: { localGet: unknown[]; localSet: unknown[]; access: string[] } = { localGet: [], localSet: [], access: [] };
let failNextWrite = false;
let delayStorage = false;
const wait = async () => { if (delayStorage) await new Promise(resolve => setTimeout(resolve, 2)); };
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      setAccessLevel: async ({ accessLevel }: { accessLevel: string }) => { assert.equal(accessLevel, 'TRUSTED_CONTEXTS'); calls.access.push('local'); },
      get: async (key: string) => {
        calls.localGet.push(key); assert.equal(key, 'savedPhrases'); assert.deepEqual(calls.access, ['local', 'session']);
        await wait(); return key in local ? { [key]: structuredClone(local[key]) } : {};
      },
      set: async (data: Record<string, unknown>) => {
        assert.deepEqual(Object.keys(data), ['savedPhrases']); assert.deepEqual(calls.access, ['local', 'session']);
        calls.localSet.push(structuredClone(data)); await wait();
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
const { savePhrase, listPhrases, deletePhrase, MAX_SAVED_PHRASES, MAX_SAVED_PHRASE_BYTES, MAX_PHRASE_ANSWER } = await import('../src/phrases.ts');

function input(overrides: Partial<PhraseInput> = {}): PhraseInput {
  return {
    text: 'eventual consistency', context: 'The replicas provide eventual consistency.', sourceTitle: 'Distributed systems',
    sourceUrl: 'https://article.test/technical#replicas', mode: 'explain', coreText: '最终一致性：各副本经过一段时间趋于一致。', detailsText: '', exampleKind: 'usage', ...overrides
  };
}
function stored(index: number, overrides: Partial<SavedPhrase> = {}): SavedPhrase {
  return { ...input({ text: `term ${index}` }), id: `record-${index}`, createdAt: 1_700_000_000_000 + index, updatedAt: 1_700_000_000_000 + index, ...overrides };
}
beforeEach(() => {
  for (const key of Object.keys(local)) delete local[key];
  calls.localGet.length = 0; calls.localSet.length = 0; failNextWrite = false; delayStorage = false;
});

test('saves the complete phrase locally without reading or copying settings, keys or unknown fields', async () => {
  local.apiKey = 'secret-key'; local.settings = { model: 'private-model' };
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('must not use network'); };
  try {
    const payload = { ...input({ detailsText: '例：修改头像后，各设备可能延迟显示新头像。' }), apiKey: 'injected-secret', unexpected: 'drop-me' };
    const result = await savePhrase(payload);
    assert.equal(result.created, true); assert.match(result.entry.id, /^[0-9a-f-]{36}$/u);
    assert.equal(result.entry.createdAt, result.entry.updatedAt);
    assert.deepEqual(result.entry, { ...input({ detailsText: payload.detailsText }), id: result.entry.id, createdAt: result.entry.createdAt, updatedAt: result.entry.updatedAt });
    assert.deepEqual(await listPhrases(), [result.entry]);
    assert.equal(local.apiKey, 'secret-key'); assert.deepEqual(local.settings, { model: 'private-model' });
    assert.ok(!JSON.stringify(calls.localSet).includes('secret'));
    assert.ok(!JSON.stringify(calls.localSet).includes('drop-me'));
    result.entry.coreText = 'outside mutation'; assert.notEqual((await listPhrases())[0].coreText, result.entry.coreText);
    const listed = await listPhrases(); listed[0].context = 'outside mutation'; assert.notEqual((await listPhrases())[0].context, listed[0].context);
  } finally { globalThis.fetch = originalFetch; }
});

test('normalized selection, canonical URL and mode identify updates; IDs and creation time survive', async () => {
  const first = await savePhrase(input({ text: '  eventual\n consistency  ', sourceUrl: 'https://ARTICLE.test:443/technical#replicas', detailsText: 'EXISTING_DETAILS' }));
  await savePhrase(input({ text: 'other term' }));
  const repeated = await savePhrase(input({ coreText: 'UPDATED_CORE', context: 'UPDATED_CONTEXT', sourceTitle: 'UPDATED_TITLE', exampleKind: undefined }));
  assert.equal(repeated.created, false); assert.equal(repeated.entry.id, first.entry.id);
  assert.equal(repeated.entry.createdAt, first.entry.createdAt); assert.ok(repeated.entry.updatedAt > first.entry.updatedAt);
  assert.equal(repeated.entry.detailsText, 'EXISTING_DETAILS'); assert.equal(repeated.entry.exampleKind, 'usage');
  assert.equal(repeated.entry.coreText, 'UPDATED_CORE'); assert.equal(repeated.entry.context, 'UPDATED_CONTEXT'); assert.equal(repeated.entry.sourceTitle, 'UPDATED_TITLE');
  assert.equal((await listPhrases())[0].id, first.entry.id);
  const updated = await savePhrase(input({ detailsText: 'NEW_DETAILS' })); assert.equal(updated.entry.detailsText, 'NEW_DETAILS');
  assert.equal((await savePhrase(input({ mode: 'translate', exampleKind: 'bilingual' }))).created, true);
  assert.equal((await savePhrase(input({ sourceUrl: 'https://article.test/other' }))).created, true);
  assert.equal((await listPhrases()).length, 4);
});

test('concurrent writes and deletes preserve every acknowledged mutation and list awaits queued work', async () => {
  delayStorage = true;
  const first = await savePhrase(input({ text: 'to delete' }));
  const pending = Array.from({ length: 12 }, (_, index) => savePhrase(input({ text: `parallel ${index}` })));
  const deletion = deletePhrase(first.entry.id);
  const update = savePhrase(input({ text: 'parallel 0', coreText: 'LATEST_ANSWER' }));
  const list = listPhrases();
  const results = await Promise.all(pending); await deletion; const last = await update;
  const entries = await list;
  assert.equal(entries.length, 12); assert.equal(entries[0].id, last.entry.id); assert.equal(entries[0].coreText, 'LATEST_ANSWER');
  assert.equal(last.entry.id, results[0].entry.id); assert.ok(entries.every(entry => entry.id !== first.entry.id));
  assert.equal(new Set(entries.map(entry => entry.id)).size, 12);
  await deletePhrase('unknown-id'); assert.deepEqual(await listPhrases(), entries);
});

test('pending writes snapshot their input before callers can mutate it', async () => {
  delayStorage = true;
  const payload = input(); const pending = savePhrase(payload); payload.text = 'MUTATED'; payload.coreText = 'MUTATED';
  const { entry } = await pending;
  assert.equal(entry.text, 'eventual consistency'); assert.notEqual(entry.coreText, 'MUTATED');
});

test('invalid payloads, schemes, credentials and length limits reject without modifying existing data', async () => {
  const original = await savePhrase(input()); const bytes = JSON.stringify(local.savedPhrases);
  const invalid: unknown[] = [null, [], {}, ...[
    { text: '' }, { text: ' \n ' }, { text: 'x'.repeat(6001) }, { text: 4 }, { context: 'x'.repeat(10001) }, { context: null },
    { sourceTitle: 'x'.repeat(501) }, { sourceTitle: false }, { sourceUrl: 'x'.repeat(8193) },
    { sourceUrl: 'javascript:alert(1)' }, { sourceUrl: 'file:///private.txt' }, { sourceUrl: 'ftp://remote.test/page' },
    { sourceUrl: 'https://user:password@article.test/' }, { sourceUrl: 'https://article.test/\npage' },
    { mode: 'search' }, { coreText: '' }, { coreText: 'x'.repeat(MAX_PHRASE_ANSWER + 1) }, { detailsText: 'x'.repeat(MAX_PHRASE_ANSWER + 1) },
    { detailsText: null }, { exampleKind: 'unknown' }, { mode: 'explain', exampleKind: 'bilingual' }, { mode: 'translate', exampleKind: 'usage' }
  ].map(overrides => ({ ...input(), ...overrides }))];
  for (const payload of invalid) await assert.rejects(savePhrase(payload as PhraseInput));
  for (const id of ['', 'bad id', 'x'.repeat(101), 5]) await assert.rejects(deletePhrase(id as string));
  assert.equal(JSON.stringify(local.savedPhrases), bytes); assert.equal(calls.localSet.length, 1);
  assert.deepEqual(await listPhrases(), [original.entry]);
  for (const sourceUrl of ['http://localhost:4317/article', 'http://127.0.0.1:4317/article', 'http://remote.test/page']) assert.equal((await savePhrase(input({ sourceUrl }))).created, true);
});

test('500 entry limit rejects new entries without eviction while updates and deletes remain usable', async () => {
  local.savedPhrases = Array.from({ length: MAX_SAVED_PHRASES }, (_, index) => stored(index));
  const baseline = JSON.stringify(local.savedPhrases);
  await assert.rejects(savePhrase(input()), /500.*上限/u);
  assert.equal(JSON.stringify(local.savedPhrases), baseline); assert.equal(calls.localSet.length, 0);
  const result = await savePhrase(input({ text: 'term 0', coreText: 'UPDATED' }));
  assert.equal(result.created, false); assert.equal((await listPhrases()).length, MAX_SAVED_PHRASES);
  await deletePhrase('record-1'); assert.equal((await savePhrase(input())).created, true);
  assert.equal((await listPhrases()).length, MAX_SAVED_PHRASES);
});

test('UTF-8 byte limit counts multibyte text and never evicts old entries', async () => {
  const large = input({ coreText: '中'.repeat(MAX_PHRASE_ANSWER), detailsText: '文'.repeat(MAX_PHRASE_ANSWER) });
  const bytes: SavedPhrase[] = [];
  while (true) {
    const next = stored(bytes.length, { ...large, text: `large ${bytes.length}` });
    if (new TextEncoder().encode(JSON.stringify({ savedPhrases: [...bytes, next] })).byteLength > MAX_SAVED_PHRASE_BYTES) break;
    bytes.push(next);
  }
  local.savedPhrases = bytes; const baseline = JSON.stringify(local.savedPhrases);
  assert.ok(bytes.length < MAX_SAVED_PHRASES);
  assert.ok(new TextEncoder().encode(baseline).byteLength > baseline.length);
  await assert.rejects(savePhrase({ ...large, text: 'another large phrase' }), /6 MiB.*上限/u);
  assert.equal(JSON.stringify(local.savedPhrases), baseline); assert.equal(calls.localSet.length, 0);
  await deletePhrase(bytes[0].id); assert.equal((await savePhrase({ ...large, text: 'another large phrase' })).created, true);
});

test('damaged storage is refused by every operation and can recover after external repair', async () => {
  const valid = stored(0);
  const corrupted: unknown[] = [null, {}, 'text', [null], [{ ...valid, coreText: null }], [{ ...valid, createdAt: -1 }],
    [{ ...valid, updatedAt: valid.createdAt - 1 }], [{ ...valid, id: 'invalid id' }], [{ ...valid, extraUnknownField: 'unrecognized' }],
    [valid, { ...stored(1), id: valid.id }], [valid, { ...valid, id: 'different-id' }]];
  for (const data of corrupted) {
    local.savedPhrases = data; const before = structuredClone(data);
    await assert.rejects(listPhrases(), /损坏.*未覆盖/u);
    await assert.rejects(savePhrase(input()), /损坏.*未覆盖/u);
    await assert.rejects(deletePhrase(valid.id), /损坏.*未覆盖/u);
    assert.deepEqual(local.savedPhrases, before);
  }
  assert.equal(calls.localSet.length, 0);
  local.savedPhrases = [valid]; assert.deepEqual(await listPhrases(), [valid]);
  assert.equal((await savePhrase(input())).created, true);
});

test('failed storage writes preserve original data and do not poison later queued saves or deletes', async () => {
  const first = await savePhrase(input()); const baseline = structuredClone(local.savedPhrases);
  failNextWrite = true;
  const failed = savePhrase(input({ text: 'will fail' }));
  const succeeded = savePhrase(input({ text: 'will succeed' }));
  await assert.rejects(failed, /QUOTA_BYTES/u); const second = await succeeded;
  assert.deepEqual((local.savedPhrases as SavedPhrase[]).filter(entry => entry.id !== second.entry.id), baseline);
  failNextWrite = true;
  const failedDelete = deletePhrase(first.entry.id); const successfulDelete = deletePhrase(second.entry.id);
  await assert.rejects(failedDelete, /QUOTA_BYTES/u); await successfulDelete;
  assert.deepEqual(await listPhrases(), baseline);
});
