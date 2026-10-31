import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSiwcModels, siwcRequestBody, SiwcFailure, SiwcStream, siwcHttpFailure } from '../src/siwc-protocol';
import { SIWC_DIAGNOSTIC_EVENTS, SIWC_DIAGNOSTIC_KEYS, SIWC_DIAGNOSTIC_REASONS } from '../src/siwc-shared';

test('official model catalog preserves account order and only visible models', () => {
  assert.deepEqual(parseSiwcModels({ models: [{ slug: 'private', visibility: 'hidden', display_name: 'Hidden' }, { slug: 'gpt-example', visibility: 'list', display_name: 'Example' }, { slug: 'gpt-example', visibility: 'list', display_name: 'Duplicate' }] }), [{ id: 'gpt-example', label: 'Example' }]);
  assert.throws(() => parseSiwcModels({ data: [{ id: 'api-key-model' }] }));
  assert.throws(() => parseSiwcModels({ models: [{ slug: '../redirect', visibility: 'list', display_name: 'Bad' }] }));
});
test('official request carries local context, instructions and required stateless flags', () => {
  const result = siwcRequestBody('gpt-example', [{ role: 'system', content: '请用中文。' }, { role: 'user', content: '一' }, { role: 'assistant', content: '二' }, { role: 'user', content: '三' }]);
  assert.deepEqual(result, { model: 'gpt-example', instructions: '请用中文。', input: [{ role: 'user', content: '一' }, { role: 'assistant', content: '二' }, { role: 'user', content: '三' }], stream: true, store: false, tools: [{ type: 'web_search' }], tool_choice: 'auto' });
  for (const field of ['messages', 'conversation', 'previous_response_id', 'temperature', 'max_output_tokens', 'max_tokens']) assert.ok(!(field in result));
  assert.throws(() => siwcRequestBody('gpt-example', [{ role: 'assistant', content: 'no user' }]));
});
test('a text delta, DONE or incomplete stream cannot pass as an official completed answer', () => {
  const stream = new SiwcStream(() => {});
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '片段' }));
  assert.throws(() => stream.finish(), (error: unknown) => error instanceof SiwcFailure && error.code === 'interrupted');
  assert.throws(() => stream.accept('[DONE]'));
  assert.throws(() => stream.accept(JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete' } })));
});
test('terminal response.completed uses the authoritative final text and verifies response identity', () => {
  const values: string[] = [], stream = new SiwcStream(text => values.push(text));
  stream.accept(JSON.stringify({ type: 'response.created', response: { id: 'response-1' } }));
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '草稿' }));
  stream.accept(JSON.stringify({ type: 'response.completed', response: { id: 'response-1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }] } }));
  assert.equal(stream.finish(), '完成'); assert.deepEqual(values, ['草稿', '完成']);
  const mismatch = new SiwcStream(() => {});
  mismatch.accept(JSON.stringify({ type: 'response.created', response: { id: 'one' } }));
  assert.throws(() => mismatch.accept(JSON.stringify({ type: 'response.completed', response: { id: 'two', status: 'completed' } })));
});
test('quota errors after a delta fail safely without exposing server prose', () => {
  const stream = new SiwcStream(() => {});
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '片段' }));
  assert.throws(() => stream.accept(JSON.stringify({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'SECRET' } } })), (error: unknown) => error instanceof SiwcFailure && error.code === 'quota' && !error.message.includes('SECRET'));
  assert.equal(stream.completed, false);
  assert.equal(siwcHttpFailure(401).code, 'signedOut'); assert.equal(siwcHttpFailure(403).code, 'denied');
});
test('output bounds and malformed terminal events stop generation', () => {
  const stream = new SiwcStream(() => {});
  assert.throws(() => stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(40_001) })), (error: unknown) => error instanceof SiwcFailure && error.code === 'output');
  assert.throws(() => new SiwcStream(() => {}).accept(JSON.stringify({ type: 'response.completed', response: { status: 'failed' } })));
});

test('preflight and model catalog failures expose fixed diagnostic reasons', () => {
  assert.throws(() => siwcRequestBody('gpt-example', [{ role: 'assistant', content: 'PRIVATE_REQUEST_CONTENT' }]), (error: unknown) => error instanceof SiwcFailure && error.code === 'format' && error.reason === 'requestInvalid' && !error.message.includes('PRIVATE_REQUEST_CONTENT'));
  assert.throws(() => parseSiwcModels({ PRIVATE_CATALOG_FIELD: 'PRIVATE_CATALOG_VALUE' }), (error: unknown) => error instanceof SiwcFailure && error.reason === 'modelCatalog' && !error.message.includes('PRIVATE_CATALOG'));
  assert.equal(siwcHttpFailure(403).reason, 'httpError');
});

test('stream format failures identify the precise structural reason', () => {
  const cases = [
    { reason: 'invalidJson', input: '{PRIVATE_INVALID_JSON', expected: { stage: 'event', jsonType: 'invalid' } },
    { reason: 'invalidEvent', input: JSON.stringify(['PRIVATE_ARRAY_VALUE']), expected: { stage: 'event', jsonType: 'array', eventType: 'other' } },
    { reason: 'invalidEvent', input: JSON.stringify({ type: 7 }), expected: { stage: 'event', jsonType: 'object', eventType: 'other' } },
    { reason: 'invalidDelta', input: JSON.stringify({ type: 'response.output_text.delta', delta: { private: 'PRIVATE_DELTA_VALUE' } }), expected: { stage: 'event', deltaType: 'object' } },
    { reason: 'terminalResponseMissing', input: JSON.stringify({ type: 'response.completed' }), expected: { stage: 'completion', responseType: 'undefined' } },
    { reason: 'terminalResponseMissing', input: JSON.stringify({ type: 'response.completed', response: null }), expected: { stage: 'completion', responseType: 'null' } },
    { reason: 'terminalStatus', input: JSON.stringify({ type: 'response.completed', response: { status: 'PRIVATE_STATUS' } }), expected: { stage: 'completion', responseStatus: 'other' } },
    { reason: 'terminalStatus', input: JSON.stringify({ type: 'response.completed', response: {} }), expected: { stage: 'completion', responseStatus: 'missing' } },
    { reason: 'emptyText', input: JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } }), expected: { stage: 'completion', responseStatus: 'completed' } },
    { reason: 'eventTooLarge', input: 'x'.repeat(1_000_001), expected: { stage: 'event' } },
  ] as const;
  for (const item of cases) {
    const stream = new SiwcStream(() => {});
    assert.throws(() => stream.accept(item.input), (error: unknown) => error instanceof SiwcFailure && error.code === 'format' && error.reason === item.reason, item.reason);
    assert.equal(stream.completed, false);
    assert.equal(stream.lastDiagnostic?.reason, item.reason);
    for (const [key, value] of Object.entries(item.expected)) assert.equal(stream.lastDiagnostic?.[key as keyof typeof stream.lastDiagnostic], value);
    assert.ok(!JSON.stringify(stream.lastDiagnostic).includes('PRIVATE_'));
  }
  const stream = new SiwcStream(() => {});
  stream.accept(JSON.stringify({ type: 'response.created', response: { id: 'PRIVATE_FIRST_ID' } }));
  assert.throws(() => stream.accept(JSON.stringify({ type: 'response.completed', response: { id: 'PRIVATE_SECOND_ID', status: 'completed' } })), (error: unknown) => error instanceof SiwcFailure && error.reason === 'responseChanged');
  assert.equal(stream.lastDiagnostic?.reason, 'responseChanged');
  assert.equal(stream.lastDiagnostic?.stage, 'completion');
  assert.ok(!JSON.stringify(stream.lastDiagnostic).includes('PRIVATE_'));
});

test('stream diagnostics retain only allowlisted structure and never server values, keys or content', () => {
  const stream = new SiwcStream(() => {});
  stream.accept(JSON.stringify({
    type: 'response.created', id: 'PRIVATE_EVENT_ID', message: 'PRIVATE_MESSAGE',
    PRIVATE_DYNAMIC_KEY: 'PRIVATE_DYNAMIC_VALUE', token: 'PRIVATE_TOKEN',
    response: { id: 'PRIVATE_RESPONSE_ID', object: 'PRIVATE_OBJECT_VALUE', status: 'queued', output: [{ content: 'PRIVATE_OUTPUT' }], PRIVATE_NESTED_KEY: 'PRIVATE_NESTED_VALUE' },
  }));
  assert.deepEqual(stream.lastDiagnostic, {
    stage: 'event', eventType: 'response.created', jsonType: 'object',
    eventKeys: ['type', 'response', 'message', 'id'], deltaType: 'undefined', responseType: 'object',
    responseKeys: ['status', 'output', 'id', 'object'], responseStatus: 'queued',
  });
  assert.ok(!JSON.stringify(stream.lastDiagnostic).includes('PRIVATE_'));
  stream.accept(JSON.stringify({ type: 'PRIVATE_UNKNOWN_EVENT_NAME', delta: 'PRIVATE_DELTA', response: { status: 'PRIVATE_STATUS' }, PRIVATE_KEY: 'PRIVATE_VALUE' }));
  assert.equal(stream.lastDiagnostic?.eventType, 'other');
  assert.equal(stream.lastDiagnostic?.deltaType, 'string');
  assert.equal(stream.lastDiagnostic?.responseStatus, 'other');
  assert.ok(!JSON.stringify(stream.lastDiagnostic).includes('PRIVATE_'));
  for (const key of stream.lastDiagnostic?.eventKeys ?? []) assert.ok((SIWC_DIAGNOSTIC_KEYS as readonly string[]).includes(key));
  assert.ok((SIWC_DIAGNOSTIC_EVENTS as readonly string[]).includes(stream.lastDiagnostic!.eventType!));
});

test('premature DONE and EOF are interrupted with streamEnded diagnostics', () => {
  for (const marker of ['[DONE]', ' [DONE]\n']) {
    const stream = new SiwcStream(() => {});
    stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: 'PRIVATE_PARTIAL_TEXT' }));
    assert.throws(() => stream.accept(marker), (error: unknown) => error instanceof SiwcFailure && error.code === 'interrupted' && error.reason === 'streamEnded');
    assert.equal(stream.completed, false);
    assert.deepEqual(stream.lastDiagnostic, { stage: 'stream', eventType: 'doneMarker', reason: 'streamEnded' });
    assert.equal(stream.text, 'PRIVATE_PARTIAL_TEXT');
  }
  const stream = new SiwcStream(() => {});
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: 'PRIVATE_PARTIAL_TEXT' }));
  assert.throws(() => stream.finish(), (error: unknown) => error instanceof SiwcFailure && error.reason === 'streamEnded');
  assert.equal(stream.lastDiagnostic?.stage, 'stream');
  assert.equal(stream.lastDiagnostic?.eventType, 'response.output_text.delta');
  assert.ok(!JSON.stringify(stream.lastDiagnostic).includes('PRIVATE_'));
  assert.ok((SIWC_DIAGNOSTIC_REASONS as readonly string[]).includes(stream.lastDiagnostic!.reason!));
});

test('terminal failure and output limits preserve their safe category and diagnostic reason', () => {
  const stream = new SiwcStream(() => {});
  assert.throws(() => stream.accept(JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'PRIVATE_PROVIDER_PROSE' } } })), (error: unknown) => error instanceof SiwcFailure && error.code === 'quota' && error.reason === 'terminalStatus' && !error.message.includes('PRIVATE_'));
  assert.equal(stream.lastDiagnostic?.responseStatus, 'failed');
  assert.equal(stream.lastDiagnostic?.reason, 'terminalStatus');
  assert.ok(!JSON.stringify(stream.lastDiagnostic).includes('PRIVATE_'));
  const oversized = new SiwcStream(() => {});
  assert.throws(() => oversized.accept(JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(40_001) })), (error: unknown) => error instanceof SiwcFailure && error.code === 'output' && error.reason === 'streamTooLarge');
  const completed = new SiwcStream(() => {});
  completed.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }] } }));
  const diagnostic = structuredClone(completed.lastDiagnostic);
  completed.accept('[DONE]');
  assert.equal(completed.finish(), 'Done');
  assert.deepEqual(completed.lastDiagnostic, diagnostic);
});

test('only actual search events drive progress and repeated call events do not inflate counts', () => {
  const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '我将搜索。' }));
  assert.equal(updates.length, 0);
  stream.accept(JSON.stringify({ type: 'response.web_search_call.in_progress', item_id: 'search-1', output_index: 0 }));
  stream.accept(JSON.stringify({ type: 'response.web_search_call.searching', item_id: 'search-1', output_index: 0 }));
  stream.accept(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: 'search-1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'PRIVATE_QUERY' } } }));
  assert.deepEqual(updates.map(value => value.search), [{ state: 'searching', calls: 1 }, { state: 'complete', calls: 1 }]);
  stream.accept(JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { id: 'search-2', type: 'web_search_call', status: 'in_progress', action: { type: 'open_page' } } }));
  assert.deepEqual(updates.at(-1).search, { state: 'reading', calls: 2 });
  stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }));
  assert.deepEqual(updates.at(-1).search, { state: 'complete', calls: 2 });
  assert.ok(!JSON.stringify(updates).includes('PRIVATE_QUERY'));
  assert.equal(stream.finish(), '我将搜索。');
});

test('authoritative final output supplies safe citation spans across Unicode text parts', () => {
  const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '一个较长的草稿' }));
  stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
    { id: 's', type: 'web_search_call', status: 'completed', action: { type: 'search' } },
    { type: 'message', role: 'assistant', content: [
      { type: 'output_text', text: '中文😀', annotations: [{ type: 'url_citation', start_index: 0, end_index: 2, url: 'https://example.test/one', title: '一', secret: 'PRIVATE_ANNOTATION' }] },
      { type: 'output_text', text: '资料', annotations: [
        { type: 'url_citation', start_index: 0, end_index: 2, url: 'https://example.test/two', title: '二' },
        { type: 'url_citation', start_index: 0, end_index: 2, url: 'javascript:alert(1)', title: '无效' },
        { type: 'url_citation', start_index: 0, end_index: 30, url: 'https://example.test/bad', title: '越界' },
      ] },
    ] },
  ] } }));
  assert.equal(stream.finish(), '中文😀资料');
  const citations = [...updates].reverse().find((value: any) => value.citations)?.citations;
  assert.deepEqual(citations, [
    { start: 0, end: 2, url: 'https://example.test/one', title: '一' },
    { start: 4, end: 6, url: 'https://example.test/two', title: '二' },
  ]);
  assert.ok(!JSON.stringify(updates).includes('PRIVATE_'));
});

test('a completed metadata-only snapshot preserves the greeting already delivered by this stream', () => {
  const values: string[] = [], stream = new SiwcStream(text => values.push(text));
  stream.accept(JSON.stringify({ type: 'response.created', response: { id: 'greeting' } }));
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '哈喽' }));
  stream.accept(JSON.stringify({ type: 'response.completed', response: { id: 'greeting', status: 'completed', error: null, output: [], model: 'actual-model', usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } }));
  assert.equal(stream.finish(), '哈喽');
  assert.ok(values.every(text => text === '哈喽'));
});

test('an explicitly empty assistant text snapshot clears a streamed draft and fails', () => {
  const stream = new SiwcStream(() => {});
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '尚未核实的草稿' }));
  assert.throws(() => stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] }] } })), (error: unknown) => error instanceof SiwcFailure && error.reason === 'emptyText');
  assert.equal(stream.completed, false); assert.equal(stream.text, '');
});

test('known auxiliary items and empty assistant content do not erase streamed text', () => {
  const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', output_index: 2, content_index: 0, item_id: 'answer', delta: '哈喽' }));
  stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', error: null, output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'PRIVATE_REASONING' }] },
    { type: 'web_search_call', id: 'search', status: 'completed', action: { type: 'search' } },
    { type: 'message', role: 'assistant', content: [] },
  ] } }));
  assert.equal(stream.finish(), '哈喽');
  assert.ok(!JSON.stringify(updates).includes('PRIVATE_REASONING'));
});

test('all documented text done events can supply an answer without deltas', () => {
  for (const event of [
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'answer', text: '完成' },
    { type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: 'answer', part: { type: 'output_text', text: '完成' } },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '完成' }] } },
  ]) {
    const stream = new SiwcStream(() => {});
    stream.accept(JSON.stringify(event));
    assert.equal(stream.completed, false);
    assert.throws(() => stream.finish());
    stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', error: null, output: [] } }));
    assert.equal(stream.finish(), '完成', event.type);
  }
});

test('repeated done events replace a part once and preserve its known citations', () => {
  const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
  const citation = { type: 'url_citation', start_index: 0, end_index: 2, url: 'https://example.test/source', title: '来源' };
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'answer', delta: '草稿' }));
  stream.accept(JSON.stringify({ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'answer', text: '资料' }));
  stream.accept(JSON.stringify({ type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: 'answer', part: { type: 'output_text', text: '资料', annotations: [citation] } }));
  stream.accept(JSON.stringify({ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'answer', text: '过时文字' }));
  stream.accept(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: 'answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '资料', annotations: [citation] }] } }));
  stream.accept(JSON.stringify({ type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: 'answer', part: { type: 'output_text', text: '过时文字', annotations: [] } }));
  stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } }));
  assert.equal(stream.finish(), '资料');
  assert.deepEqual(updates.at(-1), { citations: [{ start: 0, end: 2, url: 'https://example.test/source', title: '来源' }] });
});

test('done snapshots merge multiple parts in index order with offsets tied to their text', () => {
  const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
  stream.accept(JSON.stringify({ type: 'response.content_part.done', output_index: 3, content_index: 1, item_id: 'second', part: { type: 'output_text', text: '来源', annotations: [{ type: 'url_citation', start_index: 0, end_index: 2, url: 'https://example.test/two', title: '二' }] } }));
  stream.accept(JSON.stringify({ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'first', text: '中文😀' }));
  stream.accept(JSON.stringify({ type: 'response.output_text.done', output_index: 3, content_index: 0, item_id: 'second', text: '资料' }));
  stream.accept(JSON.stringify({ type: 'response.output_text.done', output_index: 3, content_index: 1, item_id: 'second', text: '来源' }));
  stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } }));
  assert.equal(stream.finish(), '中文😀资料来源');
  assert.deepEqual(updates.at(-1), { citations: [{ start: 6, end: 8, url: 'https://example.test/two', title: '二' }] });
});

test('a complete message snapshot replaces lower-level text and final canonical text replaces its citations', () => {
  const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
  stream.accept(JSON.stringify({ type: 'response.content_part.done', output_index: 0, content_index: 1, item_id: 'answer', part: { type: 'output_text', text: '应移除的旧片段', annotations: [] } }));
  stream.accept(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: 'answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '中间版本', annotations: [{ type: 'url_citation', start_index: 0, end_index: 2, url: 'https://example.test/old', title: '旧' }] }] } }));
  stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '最终正文', annotations: [] }] }] } }));
  assert.equal(stream.finish(), '最终正文');
  assert.deepEqual(updates.at(-1), { citations: [] });
});

test('final and done refusal text replace an earlier streamed draft', () => {
  const refusal = { type: 'refusal', refusal: '无法帮助处理该请求。' };
  for (const final of [true, false]) {
    const stream = new SiwcStream(() => {});
    stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '已经过时的草稿' }));
    if (!final) stream.accept(JSON.stringify({ type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: 'answer', part: refusal }));
    stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: final ? [{ type: 'message', role: 'assistant', content: [refusal] }] : [] } }));
    assert.equal(stream.finish(), refusal.refusal);
  }
  const incomplete = new SiwcStream(() => {});
  incomplete.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '过时草稿' }));
  incomplete.accept(JSON.stringify({ type: 'response.refusal.delta', delta: '不能' }));
  assert.throws(() => incomplete.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })));
  assert.equal(incomplete.completed, false);
});

test('unknown assistant content, roles and unsupported tool calls cannot complete a draft', () => {
  for (const item of [
    { type: 'message', role: 'assistant', content: [{ type: 'text', text: '未知格式' }] },
    { type: 'message', role: 'user', content: [{ type: 'output_text', text: '错误角色' }] },
    { type: 'function_call', name: 'PRIVATE_TOOL', arguments: 'PRIVATE_ARGUMENTS' },
    { type: 'custom_tool_call', input: 'PRIVATE_ARGUMENTS' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 42 }] },
  ]) {
    const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
    stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '草稿' }));
    assert.throws(() => stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [item], usage: { input_tokens: 9 } } })));
    assert.equal(stream.completed, false);
    assert.ok(updates.every(update => !update.details?.usage));
  }
  const stream = new SiwcStream(() => {});
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '草稿' }));
  stream.accept(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } }));
  assert.throws(() => stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })));
});

test('terminal errors override completed status and never publish final usage', () => {
  const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '哈喽' }));
  assert.throws(() => stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'PRIVATE_ERROR' }, output: [], usage: { input_tokens: 10 } } })), (error: unknown) => error instanceof SiwcFailure && error.code === 'quota' && !error.message.includes('PRIVATE_ERROR'));
  assert.equal(stream.completed, false);
  assert.ok(updates.every(update => !update.details?.usage));
});

test('the top-level text configuration and reasoning content never become an answer', () => {
  const stream = new SiwcStream(() => {});
  stream.accept(JSON.stringify({ type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: 'reasoning', part: { type: 'reasoning_text', text: 'PRIVATE_REASONING' } }));
  assert.throws(() => stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', text: { format: { type: 'text' } }, output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }] }] } })), (error: unknown) => error instanceof SiwcFailure && error.reason === 'emptyText');
  assert.equal(stream.text, '');
  const topLevel = new SiwcStream(() => {});
  assert.throws(() => topLevel.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', text: 'PRIVATE_UNSUPPORTED_TEXT', output: [] } })));
  assert.equal(topLevel.text, '');
});

test('completed part snapshots remain bounded and cannot mix conflicting item identities', () => {
  const mismatch = new SiwcStream(() => {});
  mismatch.accept(JSON.stringify({ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'first', text: '完成' }));
  assert.throws(() => mismatch.accept(JSON.stringify({ type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: 'different', part: { type: 'output_text', text: '其他回答' } })));
  const tooLong = new SiwcStream(() => {});
  assert.throws(() => tooLong.accept(JSON.stringify({ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'answer', text: 'x'.repeat(40_001) })), (error: unknown) => error instanceof SiwcFailure && error.code === 'output');
  const aggregate = new SiwcStream(() => {});
  aggregate.accept(JSON.stringify({ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'answer', text: 'x'.repeat(20_001) }));
  assert.throws(() => aggregate.accept(JSON.stringify({ type: 'response.output_text.done', output_index: 0, content_index: 1, item_id: 'answer', text: 'y'.repeat(20_000) })), (error: unknown) => error instanceof SiwcFailure && error.code === 'output');
  const tooMany = new SiwcStream(() => {});
  for (let index = 0; index < 1000; index++) tooMany.accept(JSON.stringify({ type: 'response.output_text.done', output_index: 0, content_index: index, item_id: 'first', text: '' }));
  assert.throws(() => tooMany.accept(JSON.stringify({ type: 'response.output_text.done', output_index: 1, content_index: 0, item_id: 'second', text: '' })));
});

test('done events still require a valid completed terminal before text and usage are successful', () => {
  for (const terminal of [
    { type: 'response.failed', response: { status: 'failed', usage: { input_tokens: 10 } } },
    { type: 'response.incomplete', response: { status: 'incomplete', usage: { input_tokens: 10 } } },
    { type: 'response.completed', response: { status: 'incomplete', usage: { input_tokens: 10 } } },
  ]) {
    const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
    stream.accept(JSON.stringify({ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'answer', text: '完整片段' }));
    assert.throws(() => stream.accept(JSON.stringify(terminal)));
    assert.equal(stream.completed, false);
    assert.ok(updates.every(update => !update.details?.usage));
  }
});

test('search errors use exact safe categories and never disclose provider error prose', () => {
  const codes = [
    ['subscription_sharing_unsupported_capability', 'unsupportedCapability'],
    ['subscription_sharing_user_not_eligible', 'policyDenied'],
    ['subscription_sharing_route_not_supported', 'policyDenied'],
    ['chatpass_v2_scope_not_authorized', 'policyDenied'],
    ['subscription_sharing_usage_unavailable', 'network'],
    ['subscription_sharing_usage_limit_exceeded', 'quota'],
  ];
  for (const [code, expected] of codes) {
    const payload = { error: { code, message: 'PRIVATE_ERROR_MESSAGE', param: 'PRIVATE_PARAM' } };
    const http = siwcHttpFailure(400, payload); assert.equal(http.code, expected); assert.ok(!http.message.includes('PRIVATE_'));
    const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
    stream.accept(JSON.stringify({ type: 'response.web_search_call.searching', item_id: 'search-1' }));
    assert.throws(() => stream.accept(JSON.stringify({ type: 'response.failed', response: payload })), (error: unknown) => error instanceof SiwcFailure && error.code === expected && !error.message.includes('PRIVATE_'));
    assert.deepEqual(updates.at(-1).search, { state: 'failed', calls: 1 });
  }
  assert.equal(siwcHttpFailure(400, { error: { code: 'UNKNOWN_CODE', message: 'web_search unavailable' } }).code, 'request');
});

test('successful terminal response publishes authoritative model and sanitized final usage only', () => {
  const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
  stream.accept(JSON.stringify({ type: 'response.created', response: { id: 'one', model: 'provisional-model', usage: { input_tokens: 999 } } }));
  assert.deepEqual(updates, [{ details: { model: 'provisional-model' } }]);
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '草稿' }));
  stream.accept(JSON.stringify({ type: 'response.completed', response: {
    id: 'one', status: 'completed', model: 'actual-model', privateSecret: 'PRIVATE',
    usage: { input_tokens: 9, output_tokens: 4, input_tokens_details: { cached_tokens: 0, privateSecret: 'PRIVATE' }, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 13, privateSecret: 'PRIVATE' },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }],
  } }));
  assert.equal(stream.finish(), '完成');
  assert.deepEqual(updates.filter(update => update.details), [
    { details: { model: 'provisional-model' } },
    { details: { model: 'actual-model', usage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 0, reasoningTokens: 2, totalTokens: 13 } } },
  ]);
  assert.ok(!JSON.stringify(updates).includes('PRIVATE'));
});

test('terminal usage preserves zero and missing values while dropping malformed individual counters', () => {
  const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
  stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '完成' }));
  stream.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: 'invalid model', usage: {
    input_tokens: 0, output_tokens: '5', input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: -1 }, total_tokens: 0,
  } } }));
  assert.deepEqual(updates, [{ details: { usage: { inputTokens: 0, cachedInputTokens: 0, totalTokens: 0 } } }]);
  const missing: any[] = [], noUsage = new SiwcStream(() => {}, update => missing.push(update));
  noUsage.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '完成' }));
  noUsage.accept(JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }));
  assert.deepEqual(missing, []);
});

test('failed, interrupted or empty terminal responses cannot publish partial usage as final usage', () => {
  for (const terminal of [
    { type: 'response.failed', response: { status: 'failed', usage: { input_tokens: 10 } } },
    { type: 'response.incomplete', response: { status: 'incomplete', usage: { input_tokens: 10 } } },
    { type: 'response.completed', response: { status: 'incomplete', usage: { input_tokens: 10 } } },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10 }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] }] } },
  ]) {
    const updates: any[] = [], stream = new SiwcStream(() => {}, update => updates.push(update));
    stream.accept(JSON.stringify({ type: 'response.created', response: { model: 'server-model', usage: { input_tokens: 5 } } }));
    stream.accept(JSON.stringify({ type: 'response.output_text.delta', delta: '片段' }));
    assert.throws(() => stream.accept(JSON.stringify(terminal)));
    assert.equal(stream.completed, false);
    assert.ok(updates.every(update => !update.details?.usage));
    assert.deepEqual(updates[0], { details: { model: 'server-model' } });
  }
});
