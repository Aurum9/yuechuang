import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHAT_OUTPUT } from '../src/chat-shared';
import { MAX_CHAT_CITATIONS, sanitizeChatCitations, sanitizeChatSearch } from '../src/chat-search';

const citation = (extra: Record<string, unknown> = {}) => ({ start: 0, end: 3, url: 'https://example.test/evidence', title: '来源', ...extra });

test('old chats and malformed search metadata remain optional without exceptions', () => {
  for (const value of [undefined, null, '', 0, [], {}, { citations: [] }]) {
    assert.deepEqual(sanitizeChatCitations(value, 3), []);
    assert.equal(sanitizeChatSearch(value), undefined);
  }
  assert.deepEqual(sanitizeChatCitations([null, false, [], {}, citation()], 3), [citation()]);
});

test('citation whitelist copies only bounded source data and leaves the input unchanged', () => {
  const input = citation({ token: 'PRIVATE_TOKEN', rawBody: 'PRIVATE_BODY', target: '_self', html: '<img src=x>', extra: { secret: true } });
  const result = sanitizeChatCitations([input], 3);
  assert.deepEqual(result, [citation()]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  result[0].title = '修改';
  assert.equal(input.title, '来源');
  assert.equal(typeof (input as Record<string, unknown>).extra, 'object');
});

test('source links reject executable schemes, credentials, relative URLs and raw URL controls', () => {
  const invalid = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'file:///C:/private.txt', 'blob:https://example.test/id', 'chrome://settings/',
    'chrome-extension://extension/options.html', 'ftp://example.test/file',
    '//example.test/evidence', '/evidence', 'not-a-url',
    'https://user:password@example.test/evidence', 'https://user@example.test/evidence',
    ' https://example.test/evidence', 'https://example.test/a b',
    'https://example.test/\nsecret', 'https://example.test/\tsecret',
    'https://example.test/\u0000secret', 'https://example.test/\u007fsecret',
    `https://example.test/${'a'.repeat(2048)}`,
  ];
  for (const url of invalid) assert.deepEqual(sanitizeChatCitations([citation({ url })], 3), [], url);
  assert.deepEqual(sanitizeChatCitations([citation({ url: 'HTTP://EXAMPLE.TEST:80/evidence' })], 3), [citation({ url: 'http://example.test/evidence' })]);
  assert.deepEqual(sanitizeChatCitations([citation({ url: 'https://example.test/证据?q=%3Cscript%3E#段落' })], 3), [citation({ url: new URL('https://example.test/证据?q=%3Cscript%3E#段落').href })]);
});

test('markup in a citation title stays literal data while controls and excess title size are removed', () => {
  const markup = '<img src=x onerror="alert(1)"> [link](javascript:alert(1)) **来源**';
  const result = sanitizeChatCitations([citation({ title: `\u0000\t ${markup}\r\n\u007f` })], 3);
  assert.equal(result[0].title, markup);
  assert.deepEqual(Object.keys(result[0]), ['start', 'end', 'url', 'title']);
  assert.equal(sanitizeChatCitations([citation({ title: '字'.repeat(301) })], 3)[0].title, '字'.repeat(300));
  for (const title of ['', ' \n\t ', null, 9, { html: markup }]) {
    assert.equal(sanitizeChatCitations([citation({ title })], 3)[0].title, 'example.test');
  }
});

test('citation spans require finite integer ranges within the exact text bounds', () => {
  const invalid = [
    { start: -1 }, { start: 0.5 }, { start: '0' }, { start: NaN }, { start: Infinity },
    { end: 0 }, { start: 2, end: 2 }, { start: 3, end: 2 }, { end: 4 },
    { end: 1.5 }, { end: '3' }, { end: NaN }, { end: Infinity }, { end: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const range of invalid) assert.deepEqual(sanitizeChatCitations([citation(range)], 3), [], JSON.stringify(range));
  for (const length of [-1, 0, 2, 3.1, NaN, Infinity, MAX_CHAT_OUTPUT + 1]) {
    assert.deepEqual(sanitizeChatCitations([citation()], length), []);
  }
  assert.deepEqual(sanitizeChatCitations([citation({ end: MAX_CHAT_OUTPUT })], MAX_CHAT_OUTPUT), [citation({ end: MAX_CHAT_OUTPUT })]);
});

test('source spans preserve caller-normalized Unicode positions without counting text as ASCII', () => {
  const text = '中文😀证据';
  assert.equal(text.length, 6);
  const input = [citation({ start: 4, end: 6, title: '证据' }), citation({ start: 0, end: 2, title: '中文' })];
  const result = sanitizeChatCitations(input, text.length);
  assert.equal(text.slice(result[0].start, result[0].end), '中文');
  assert.equal(text.slice(result[1].start, result[1].end), '证据');
  assert.deepEqual(sanitizeChatCitations([citation({ start: 4, end: 7 })], text.length), []);
  // This cleaner receives a length, so conversion from provider character
  // offsets and surrogate-boundary checks belong to the stream/UI layer.
});

test('citation duplicates normalize URLs, retain distinct ranges and sort deterministically', () => {
  const inputs = [
    citation({ start: 5, end: 8 }), citation({ url: 'HTTPS://EXAMPLE.TEST:443/evidence' }),
    citation({ title: '同一引用的重复标题' }), citation({ end: 2 }),
    citation({ url: 'https://second.test/evidence' }),
  ];
  assert.deepEqual(sanitizeChatCitations(inputs, 8), [
    citation({ end: 2 }), citation(), citation({ url: 'https://second.test/evidence' }), citation({ start: 5, end: 8 }),
  ]);
});

test('citation count and inspected input size stay bounded', () => {
  const many = Array.from({ length: MAX_CHAT_CITATIONS + 20 }, (_, index) => citation({ url: `https://example.test/${index}` }));
  const result = sanitizeChatCitations(many, 3);
  assert.equal(result.length, MAX_CHAT_CITATIONS);
  assert.equal(result[0].url, 'https://example.test/0');
  assert.equal(result.at(-1)!.url, `https://example.test/${MAX_CHAT_CITATIONS - 1}`);
  assert.deepEqual(sanitizeChatCitations([...Array(1000).fill(null), citation()], 3), []);
});

test('search status accepts exact states and integer counts, stripping unrelated response data', () => {
  for (const state of ['searching', 'reading', 'complete', 'failed'] as const) {
    assert.deepEqual(sanitizeChatSearch({ state, calls: 1, query: 'PRIVATE_QUERY', tool: { token: 'PRIVATE_TOKEN' } }), { state, calls: 1 });
  }
  assert.deepEqual(sanitizeChatSearch({ state: 'complete', calls: 1000 }), { state: 'complete', calls: 1000 });
  for (const calls of [undefined, 0, -1, 1.1, '1', NaN, Infinity, 1001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(sanitizeChatSearch({ state: 'searching', calls }), undefined);
  }
  for (const state of ['done', 'failed\n', '', undefined, null, 1, {}, new String('searching')]) {
    assert.equal(sanitizeChatSearch({ state, calls: 1 }), undefined);
  }
});
