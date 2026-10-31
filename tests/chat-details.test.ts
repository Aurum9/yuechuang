import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeChatDetails } from '../src/chat-details';

test('response details preserve zero values and only explicitly supplied counters', () => {
  assert.deepEqual(sanitizeChatDetails({ model: 'gpt-6.1-terra:latest', durationMs: 0, firstTokenMs: 0, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 0 } }), {
    model: 'gpt-6.1-terra:latest', durationMs: 0, firstTokenMs: 0, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
  });
  assert.deepEqual(sanitizeChatDetails({ usage: { outputTokens: 5 } }), { usage: { outputTokens: 5 } });
  assert.deepEqual(sanitizeChatDetails({ usage: { cachedInputTokens: 2, reasoningTokens: 3 } }), { usage: { cachedInputTokens: 2, reasoningTokens: 3 } });
});

test('response details reject malformed numbers without coercion or invented defaults', () => {
  for (const value of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '0', false, null, undefined, {}, []]) {
    assert.equal(sanitizeChatDetails({ durationMs: value, firstTokenMs: value, usage: { inputTokens: value, outputTokens: value, cachedInputTokens: value, reasoningTokens: value, totalTokens: value } }), undefined);
  }
  assert.deepEqual(sanitizeChatDetails({ durationMs: Number.MAX_SAFE_INTEGER, usage: { inputTokens: Number.MAX_SAFE_INTEGER } }), { durationMs: Number.MAX_SAFE_INTEGER, usage: { inputTokens: Number.MAX_SAFE_INTEGER } });
});

test('response details drop unknown fields and invalid model slugs', () => {
  for (const value of [null, [], 'data', 1, {}, { usage: [] }, { usage: {} }, { privateSecret: 'PRIVATE' }]) assert.equal(sanitizeChatDetails(value), undefined);
  for (const model of ['', 'x'.repeat(161), '../model', 'model\n', 'model name', '<img>', '模型']) assert.equal(sanitizeChatDetails({ model }), undefined);
  assert.deepEqual(sanitizeChatDetails({ model: 'x'.repeat(160), responseId: 'PRIVATE', usage: { inputTokens: 3, privateSecret: 'PRIVATE' } }), { model: 'x'.repeat(160), usage: { inputTokens: 3 } });
});

test('response details remove breakdown counters exceeding their available parent totals', () => {
  assert.deepEqual(sanitizeChatDetails({ usage: { inputTokens: 2, cachedInputTokens: 3, outputTokens: 0, reasoningTokens: 1, totalTokens: 2 } }), { usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 } });
  assert.deepEqual(sanitizeChatDetails({ usage: { inputTokens: 3, cachedInputTokens: 3, outputTokens: 2, reasoningTokens: 2 } }), { usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 3, reasoningTokens: 2 } });
});
