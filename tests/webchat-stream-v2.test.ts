import test from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser } from '../src/core';
import { WebChatFailure } from '../src/webchat-protocol';
import { WebChatStreamV2 } from '../src/webchat-stream-v2';

const failure = (code: string) => (error: unknown) => error instanceof WebChatFailure && error.code === code;
const message = (text = '', extra: Record<string, unknown> = {}) => ({
  id: 'answer-current', author: { role: 'assistant', name: null }, channel: 'final', recipient: 'all',
  content: { content_type: 'text', parts: [text] }, status: 'in_progress', end_turn: false,
  metadata: {}, ...extra
});
const root = (text = '', extra: Record<string, unknown> = {}) => ({ conversation_id: 'conversation-current', message: message(text, extra), error: null });
const snapshot = (stream: WebChatStreamV2, value: Record<string, unknown> = root()) => stream.accept(JSON.stringify({ p: '', o: 'add', v: value }), 'delta');
const patch = (stream: WebChatStreamV2, p: string, o: string, v?: unknown) => stream.accept(JSON.stringify({ p, o, ...(v !== undefined ? { v } : {}) }), 'delta');
const complete = (stream: WebChatStreamV2) => patch(stream, '', 'patch', [
  { p: '/message/status', o: 'replace', v: 'finished_successfully' },
  { p: '/message/end_turn', o: 'replace', v: true },
  { p: '/message/metadata', o: 'append', v: { is_complete: true, finish_details: { type: 'stop' } } }
]);

// Synthetic, credential-free fixtures use the envelope shapes documented in
// public captures; no recorded account response is included in the repository.
test('delta v1 handles root snapshots, inherited string appends, and a completion batch', () => {
  const emitted: string[] = []; const stream = new WebChatStreamV2(text => emitted.push(text));
  stream.accept('"v1"', 'delta_encoding'); snapshot(stream);
  patch(stream, '/message/content/parts/0', 'append', '你');
  stream.accept('{"v":"好"}', 'delta'); stream.accept('{"v":"！"}', 'delta');
  complete(stream); stream.accept('{"type":"message_stream_complete"}'); stream.accept('[DONE]');
  assert.deepEqual(emitted, ['你', '你好', '你好！']);
  assert.deepEqual(stream.finish(), { text: '你好！', conversation: { id: 'conversation-current', parentId: 'answer-current' } });
});

test('legacy complete snapshots remain compatible and SSE framing can be fragmented at every character', () => {
  const stream = new WebChatStreamV2(() => {}); const parser = new SSEParser(data => stream.accept(data));
  const input = `event: delta_encoding\r\ndata: "v1"\r\n\r\ndata: ${JSON.stringify(root('完整回答', { end_turn: true, status: 'finished_successfully' }))}\r\n\r\ndata: [DONE]\r\n\r\n`;
  for (const char of input) parser.push(char); parser.push('', true);
  assert.equal(stream.finish().text, '完整回答');
});

test('replace, add and remove change only the intended text part', () => {
  const stream = new WebChatStreamV2(() => {}); snapshot(stream, root('旧答案'));
  patch(stream, '/message/content/parts/0', 'replace', '新答案');
  patch(stream, '/message/content/parts/1', 'add', '第二段');
  assert.equal(stream.text, '新答案\n第二段');
  patch(stream, '/message/content/parts/0', 'remove'); complete(stream);
  assert.equal(stream.finish().text, '第二段');
});

test('analysis, tool calls, system and user echoes never become the displayed answer', () => {
  const emitted: string[] = []; const stream = new WebChatStreamV2(text => emitted.push(text), { userMessageId: 'sent-user' });
  snapshot(stream, root('私有推理', { channel: 'analysis' }));
  snapshot(stream, root('工具参数', { channel: 'commentary', recipient: 'browser' }));
  snapshot(stream, root('工具结果', { author: { role: 'tool', name: 'browser' } }));
  snapshot(stream, root('系统内容', { author: { role: 'system' } }));
  snapshot(stream, root('用户输入', { id: 'sent-user', author: { role: 'user' } }));
  assert.deepEqual(emitted, []); assert.throws(() => stream.finish(), failure('interrupted'));
  snapshot(stream, root('最终回答', { id: 'final-current' })); complete(stream);
  assert.equal(stream.finish().text, '最终回答');
});

test('compiled UI is inert and only fallback Markdown is exposed for DIL messages', () => {
  const emitted: string[] = []; const stream = new WebChatStreamV2(text => emitted.push(text));
  snapshot(stream, root('{@body unsafeProgram()}', { metadata: { model_dil_v2: { code: 'globalThis.unsafeProgram()', constants: { token: 'ignored' }, fallbackMarkdown: '', fallbackMarkdownVersion: 1 } } }));
  patch(stream, '/message/metadata/model_dil_v2/code', 'replace', 'never_execute_this()');
  patch(stream, '/message/metadata/model_dil_v2/fallbackMarkdown', 'append', '**安全文本**');
  complete(stream);
  assert.deepEqual(emitted, ['**安全文本**']); assert.equal(stream.finish().text, '**安全文本**');
  assert.equal(JSON.stringify(stream).includes('never_execute_this'), false);
});

test('a completed DIL message without supported fallback text cannot claim success', () => {
  const stream = new WebChatStreamV2(() => {});
  snapshot(stream, root('{@body unsafeProgram()}', { metadata: { model_dil_v2: { code: 'untrusted' } }, end_turn: true, status: 'finished_successfully' }));
  stream.accept('[DONE]'); assert.equal(stream.text, ''); assert.throws(() => stream.finish(), failure('interrupted'));
});

test('an earlier completed message cannot complete the current unfinished message or tool phase', () => {
  for (const extra of [{ id: 'answer-next', end_turn: false }, { id: 'analysis-next', channel: 'analysis', end_turn: true }, { id: 'tool-next', author: { role: 'tool' }, end_turn: true }]) {
    const stream = new WebChatStreamV2(() => {}); snapshot(stream, root('前一条完整回答', { end_turn: true }));
    snapshot(stream, root('本条片段', extra)); stream.accept('[DONE]');
    assert.throws(() => stream.finish(), failure('interrupted'));
  }
});

test('an explicit end_turn false prevents finished_successfully from becoming a complete turn', () => {
  const stream = new WebChatStreamV2(() => {});
  snapshot(stream, root('等待工具', { status: 'finished_successfully', end_turn: false }));
  stream.accept('[DONE]'); assert.throws(() => stream.finish(), failure('interrupted'));
});

test('stream metadata, markers and DONE cannot substitute for an assistant completion snapshot', () => {
  const stream = new WebChatStreamV2(() => {}); snapshot(stream, root('还没写完'));
  for (const type of ['message_marker', 'message_stream_complete', 'conversation_detail_metadata']) stream.accept(JSON.stringify({ type, status: 'finished_successfully', end_turn: true }));
  stream.accept('[DONE]'); assert.throws(() => stream.finish(), failure('interrupted'));
});

test('request correlation rejects another conversation, an old assistant, or an unrelated user echo', () => {
  const wrongConversation = new WebChatStreamV2(() => {}, { conversationId: 'expected-conversation' });
  assert.throws(() => snapshot(wrongConversation), failure('format'));
  const changed = new WebChatStreamV2(() => {}); snapshot(changed);
  assert.throws(() => snapshot(changed, { ...root(), conversation_id: 'another-conversation' }), failure('format'));
  const replayed = new WebChatStreamV2(() => {}, { previousAssistantId: 'answer-current' });
  assert.throws(() => snapshot(replayed), failure('format'));
  const unrelated = new WebChatStreamV2(() => {}, { userMessageId: 'sent-user' });
  assert.throws(() => snapshot(unrelated, root('other input', { id: 'different-user', author: { role: 'user' } })), failure('format'));
  const inputEvent = new WebChatStreamV2(() => {}, { userMessageId: 'sent-user' });
  inputEvent.accept(JSON.stringify({ type: 'input_message', conversation_id: 'conversation-current', input_message: { id: 'sent-user', content: 'not retained' } }));
  snapshot(inputEvent, root('answer')); complete(inputEvent); assert.equal(inputEvent.finish().text, 'answer');
  const wrongInput = new WebChatStreamV2(() => {}, { userMessageId: 'sent-user' });
  assert.throws(() => wrongInput.accept(JSON.stringify({ type: 'input_message', input_message: { id: 'unrelated' } })), failure('format'));
});

test('hidden user settings have independent IDs and must not fail the current input correlation', () => {
  const emitted: string[] = [];
  const stream = new WebChatStreamV2(text => emitted.push(text), { userMessageId: 'sent-user' });
  snapshot(stream, root('本次输入', { id: 'sent-user', author: { role: 'user' } }));
  // Reduced from the 2026-10-29 live response's frame 11: the official stream
  // includes user_editable_context in a distinct transport channel.
  stream.accept(JSON.stringify({ c: 7, p: '', o: 'add', v: root('', {
    id: 'settings-context', author: { role: 'user' },
    content: { content_type: 'user_editable_context', user_instructions: 'private settings are never retained', user_profile: 'private profile is never retained' },
    metadata: { is_visually_hidden_from_conversation: true }
  }) }), 'delta');
  stream.accept(JSON.stringify({ c: 13, p: '', o: 'add', v: root('') }), 'delta');
  patch(stream, '/message/content/parts/0', 'append', '本轮答案'); complete(stream);
  assert.deepEqual(emitted, ['本轮答案']); assert.equal(stream.finish().text, '本轮答案');
  assert.equal(JSON.stringify(stream).includes('private settings'), false);
  assert.equal(JSON.stringify(stream).includes('private profile'), false);
});

test('nullable message conversation IDs may precede assignment and never erase a pinned conversation', () => {
  const stream = new WebChatStreamV2(() => {});
  snapshot(stream, { ...root('稍后分配会话'), conversation_id: null });
  assert.equal(stream.conversationId, '');
  patch(stream, '/conversation_id', 'replace', 'conversation-assigned'); complete(stream);
  assert.equal(stream.finish().conversation.id, 'conversation-assigned');
  snapshot(stream, { ...root('同一轮更新', { status: 'finished_successfully', end_turn: true }), conversation_id: null });
  assert.equal(stream.finish().conversation.id, 'conversation-assigned');
  assert.throws(() => patch(stream, '/conversation_id', 'replace', 'conversation-unrelated'), failure('format'));
});

test('a new thread with only null conversation IDs cannot become a completed remote context', () => {
  const stream = new WebChatStreamV2(() => {});
  snapshot(stream, { ...root('已写完但没有会话 ID', { status: 'finished_successfully', end_turn: true }), conversation_id: null });
  stream.accept('[DONE]'); assert.throws(() => stream.finish(), failure('interrupted'));
});

test('known server errors are fixed safe categories and permanently invalidate completion', () => {
  for (const [code, expected] of [['rate_limit_exceeded', 'quota'], ['invalid_token', 'signedOut'], ['sentinel_required', 'accessDenied'], ['arbitrary_private_error', 'format']]) {
    const stream = new WebChatStreamV2(() => {}); snapshot(stream, root('answer', { end_turn: true }));
    assert.throws(() => stream.accept(JSON.stringify({ error: { code, message: 'private server details' } })), failure(expected));
    assert.throws(() => stream.finish(), failure('interrupted'));
  }
  const patched = new WebChatStreamV2(() => {}); snapshot(patched);
  assert.throws(() => patch(patched, '/error', 'replace', { code: 'rate_limit_exceeded' }), failure('quota'));
});

test('unsupported encoding, malformed JSON and patches without an established context fail closed', () => {
  const fixtures: [string, string | undefined][] = [['"v2"', 'delta_encoding'], ['{bad', undefined], ['{"v":"unbound"}', 'delta'], ['{"p":"","o":"move","v":"x"}', 'delta'], ['{"p":"/message","o":"patch","v":"invalid"}', 'delta']];
  for (const [data, event] of fixtures) {
    const stream = new WebChatStreamV2(() => {});
    assert.throws(() => stream.accept(data, event), failure('format'));
  }
});

test('unknown metadata continuation stays in metadata and cannot be appended to answer text', () => {
  const stream = new WebChatStreamV2(() => {}); snapshot(stream, root('真实正文'));
  patch(stream, '/message/metadata/private/internal', 'append', 'ignored');
  stream.accept('{"v":"also ignored"}'); complete(stream);
  assert.equal(stream.finish().text, '真实正文');
});

test('prototype paths, invalid pointer escapes and excessive array parts are rejected', () => {
  for (const path of ['/message/__proto__/polluted', '/constructor/prototype/polluted', '/message/~2invalid', '/message/content/parts/100', '/message/content/parts/03']) {
    const stream = new WebChatStreamV2(() => {}); snapshot(stream);
    if (path.endsWith('/03') || path.endsWith('/100')) {
      // Unknown array indexes are rejected rather than silently accepted as metadata.
      assert.throws(() => patch(stream, path, 'add', 'bad'), failure('format'));
    } else assert.throws(() => patch(stream, path, 'add', 'bad'), failure('format'));
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const missing = new WebChatStreamV2(() => {});
  patch(missing, '/message/content/parts/0', 'append', 'no snapshot');
  assert.equal(missing.text, ''); assert.throws(() => missing.finish(), failure('interrupted'));
});

test('scoped patches use relative child paths and preserve the top-level continuation context', () => {
  const stream = new WebChatStreamV2(() => {}); snapshot(stream, root('初始'));
  patch(stream, '/message', 'patch', [
    { p: '/content/parts/0', o: 'append', v: '第一段' }
  ]);
  // The official decoder remembers the outer /message patch, not its last child.
  stream.accept(JSON.stringify({ v: [{ p: '/content/parts/0', o: 'append', v: '第二段' }] }));
  complete(stream); assert.equal(stream.finish().text, '初始第一段第二段');
});

test('delta transport channels have independent snapshots and cannot splice analysis into the answer', () => {
  const stream = new WebChatStreamV2(() => {}); snapshot(stream, root('主回答'));
  complete(stream);
  stream.accept(JSON.stringify({ c: 2, p: '', o: 'add', v: root('另一路推理', { id: 'analysis-other', channel: 'analysis' }) }));
  patch(stream, '/message/content/parts/0', 'append', '继续推理');
  assert.equal(stream.finish().text, '主回答');
  stream.accept(JSON.stringify({ c: 0, p: '/message/content/parts/0', o: 'append', v: '补充' }));
  assert.equal(stream.finish().text, '主回答补充');
  for (const channel of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const invalid = new WebChatStreamV2(() => {});
    assert.throws(() => invalid.accept(JSON.stringify({ c: channel, p: '', o: 'add', v: root() })), failure('format'));
  }
});

test('truncate and append-to-absent fields match the observed official delta operations', () => {
  const stream = new WebChatStreamV2(() => {}); snapshot(stream, root('原文有错误'));
  patch(stream, '/message/content/parts/0', 'truncate', 2);
  patch(stream, '/message/content/parts/0', 'append', '已修正');
  complete(stream); assert.equal(stream.finish().text, '原文已修正');
  const append = new WebChatStreamV2(() => {}); snapshot(append);
  patch(append, '/message/content/parts', 'append', '下一段'); complete(append);
  assert.equal(append.finish().text, '\n下一段');
});

test('hidden, errored or interrupted assistant messages never become completed answers', () => {
  for (const metadata of [{ is_error: true }, { is_visually_hidden_from_conversation: true }, { reasoning_status: 'complete' }, { finish_details: { type: 'interrupted' } }, { finish_details: { type: 'content_filter' } }]) {
    const stream = new WebChatStreamV2(() => {});
    snapshot(stream, root('partial', { status: 'finished_successfully', end_turn: true, metadata }));
    stream.accept('[DONE]'); assert.throws(() => stream.finish(), failure('interrupted'));
  }
  const unfinished = new WebChatStreamV2(() => {});
  snapshot(unfinished, root('partial', { end_turn: true, status: 'in_progress' }));
  unfinished.accept('[DONE]'); assert.throws(() => unfinished.finish(), failure('interrupted'));
});

test('output is capped at 40k characters and the cumulative UTF-8 wire budget is four MiB', () => {
  const text = new WebChatStreamV2(() => {}); snapshot(text, root('x'.repeat(40_000)));
  assert.throws(() => patch(text, '/message/content/parts/0', 'append', 'x'), failure('format'));
  const wire = new WebChatStreamV2(() => {});
  const ignored = JSON.stringify({ type: 'inert', ignored: 'x'.repeat(900_000) });
  for (let count = 0; count < 4; count++) wire.accept(ignored);
  assert.throws(() => wire.accept(ignored), failure('format'));
  const utf8 = new WebChatStreamV2(() => {});
  assert.throws(() => utf8.accept(JSON.stringify({ type: 'inert', ignored: '中'.repeat(360_000) })), failure('format'));
});
