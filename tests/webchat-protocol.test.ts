import test from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser } from '../src/core';
import { knownWebFailure, pageCommand, parseWebModels, webConversationBody, webHttpFailure, WebChatFailure, WebChatStream } from '../src/webchat-protocol';

const command = { type: 'generate' as const, id: 'request-1', model: 'web-model', messages: [{ role: 'system' as const, content: '请用中文。' }, { role: 'user' as const, content: '说明闭包' }] };
const snapshot = (text: string, extra = {}) => JSON.stringify({ conversation_id: 'conversation-1', message: { id: 'assistant-1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] }, ...extra } });
const fails = (code: string) => (error: unknown) => error instanceof WebChatFailure && error.code === code;

test('Web page commands copy a bounded whitelist and reject arbitrary network commands', () => {
  assert.deepEqual(pageCommand({ ...command, url: 'https://other.example', token: 'secret' }), command);
  for (const value of [{ type: 'fetch', id: '1', url: '/api' }, { ...command, model: '../other' }, { ...command, messages: [{ role: 'developer', content: 'x' }] }, { ...command, messages: [{ role: 'user', content: 'x'.repeat(200_001) }] }, { ...command, messages: [{ role: 'assistant', content: 'x' }] }, { ...command, conversation: { id: 'bad/id', parentId: 'valid' } }]) assert.equal(pageCommand(value), undefined);
  assert.deepEqual(pageCommand({ type: 'cancel', id: 'request-1', url: '/ignored' }), { type: 'cancel', id: 'request-1' });
});
test('Web models keep only bounded identifiers and display labels', () => {
  assert.deepEqual(parseWebModels({ models: [{ slug: 'auto', title: 'Auto', token: 'secret' }, { slug: 'auto', title: 'duplicate' }, { id: 'gpt-5', display_name: 'GPT-5' }, { slug: '/bad', title: 'bad' }, null] }), [{ id: 'auto', label: 'Auto' }, { id: 'gpt-5', label: 'GPT-5' }]);
  assert.throws(() => parseWebModels({ models: [] }), fails('model'));
  assert.throws(() => parseWebModels({ error: 'secret' }), fails('format'));
});
test('New Web thread carries completed context; continuation sends only latest user turn', () => {
  let id = 0; const uuid = () => `uuid-${++id}`;
  const first = webConversationBody(command, uuid);
  assert.equal(first.history_and_training_disabled, false);
  assert.equal(first.messages[0].content.parts[0], '请用中文。\n\n说明闭包');
  assert.equal('conversation_id' in first, false);
  const followup = webConversationBody({ ...command, messages: [...command.messages, { role: 'assistant', content: '闭包……' }, { role: 'user', content: '举个例子' }], conversation: { id: 'conversation-1', parentId: 'assistant-1' } }, uuid);
  assert.equal(followup.conversation_id, 'conversation-1');
  assert.equal(followup.parent_message_id, 'assistant-1');
  assert.equal(followup.messages.length, 1);
  assert.deepEqual(followup.messages[0].content.parts, ['举个例子']);
});
test('Web SSE snapshot updates replace text and retain real conversation metadata', () => {
  const values: string[] = []; const stream = new WebChatStream(value => values.push(value)); const parser = new SSEParser(data => stream.accept(data));
  const input = `data: ${snapshot('你')}\r\n\r\ndata: ${snapshot('你好', { status: 'finished_successfully', end_turn: true })}\r\n\r\ndata: [DONE]\r\n\r\n`;
  for (const char of input) parser.push(char); parser.push('', true);
  assert.deepEqual(values, ['你', '你好']);
  assert.deepEqual(stream.finish(), { text: '你好', conversation: { id: 'conversation-1', parentId: 'assistant-1' } });
});
test('Web SSE errors, unsupported output and truncated streams cannot become completed context', () => {
  const stream = new WebChatStream(() => {}); stream.accept(snapshot('片段'));
  assert.throws(() => stream.finish(), fails('interrupted'));
  assert.throws(() => stream.accept('{bad'), fails('format'));
  assert.throws(() => stream.accept(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'secret' } })), fails('quota'));
  assert.throws(() => stream.accept(JSON.stringify({ error: { code: 'sentinel_required' } })), fails('accessDenied'));
  assert.throws(() => stream.accept(snapshot('x'.repeat(40_001))), fails('format'));
  const unsupported = new WebChatStream(() => {}); unsupported.accept(JSON.stringify({ websocket_url: 'wss://private' })); unsupported.accept('[DONE]');
  assert.throws(() => unsupported.finish(), fails('interrupted'));
});
test('Web HTTP errors map to fixed safe categories with no automatic fallback', () => {
  assert.equal(webHttpFailure(401), 'signedOut'); assert.equal(webHttpFailure(403), 'accessDenied');
  assert.equal(webHttpFailure(429), 'quota'); assert.equal(webHttpFailure(404), 'format'); assert.equal(webHttpFailure(503), 'network');
});
test('only known structured error codes justify a cause; server prose and unknown codes stay unclassified', () => {
  assert.equal(knownWebFailure({ detail: 'private prose says verification required' }), undefined);
  assert.equal(knownWebFailure({ error: { code: 'my_auth_secret_quota', message: 'private' } }), undefined);
  assert.equal(knownWebFailure({ error: { code: 'verification_required', message: 'private' } }), 'verificationRequired');
  assert.equal(knownWebFailure({ detail: { code: 'proof_of_work_required' } }), 'accessDenied');
  assert.equal(knownWebFailure({ code: 'model_not_available' }), 'model');
  assert.equal(knownWebFailure({ error: { type: 'insufficient_quota' } }), 'quota');
});
test('Web completion belongs to the current assistant snapshot, never a previous message', () => {
  const stream = new WebChatStream(() => {});
  stream.accept(snapshot('已完成的旧消息', { status: 'finished_successfully', end_turn: true }));
  stream.accept(snapshot('新消息片段', { id: 'assistant-2', status: 'in_progress', end_turn: false }));
  assert.throws(() => stream.finish(), fails('interrupted'));
  const same = new WebChatStream(() => {});
  same.accept(snapshot('先前已完成', { end_turn: true })); same.accept(snapshot('重新生成中', { end_turn: false }));
  assert.throws(() => same.finish(), fails('interrupted'));
  const pending = new WebChatStream(() => {});
  pending.accept(snapshot('等待工具完成', { status: 'finished_successfully', end_turn: false })); pending.accept('[DONE]');
  assert.throws(() => pending.finish(), fails('interrupted'));
});
