import test from 'node:test';
import assert from 'node:assert/strict';
import type { SiwcView } from '../src/siwc-shared';
import { formatSiwcDiagnostics, sanitizeSiwcDiagnostic, siwcDiagnosticSnapshot, siwcDiagnosticText } from '../src/siwc-diagnostics';

test('official diagnostic copies fixed structural fields and discards private extras', () => {
  const view = {
    config: { provider: 'chatgptOAuth', model: 'SECRET-model' },
    status: {
      state: 'ready', loggedIn: true, planAuthorized: true, generation: 'blocked', accountId: 'SECRET-account', accountLabel: 'SECRET-person', helperVersion: 'SECRET-helper',
      accessToken: 'SECRET-token', error: 'SECRET-server-prose', models: [{ id: 'SECRET-model', label: 'SECRET-model-label' }],
      diagnostic: {
        stage: 'event', reason: 'invalidDelta', httpStatus: 200, contentType: 'text/event-stream', eventType: 'response.output_text.delta', jsonType: 'object', deltaType: 'object', responseType: 'undefined',
        eventKeys: ['type', 'SECRET-field', 'delta', 'type'], responseKeys: ['status', 'SECRET-token', 'output'], responseStatus: 'missing',
        delta: 'SECRET-content', response: { accessToken: 'SECRET-token' }, message: 'SECRET-message',
      },
    },
  } as unknown as SiwcView;
  assert.deepEqual(siwcDiagnosticSnapshot(view, '0.10.1'), {
    version: '0.10.1', provider: 'chatgptOAuth', state: 'ready', loggedIn: true, planAuthorized: true, generation: 'blocked',
    diagnostic: { stage: 'event', reason: 'invalidDelta', httpStatus: 200, contentType: 'text/event-stream', eventType: 'response.output_text.delta', jsonType: 'object', deltaType: 'object', responseType: 'undefined', responseStatus: 'missing', eventKeys: ['type', 'delta'], responseKeys: ['status', 'output'] },
  });
  assert.ok(!formatSiwcDiagnostics(view, '0.10.1').includes('SECRET'));
  assert.equal(siwcDiagnosticText(view.status.diagnostic), '流式事件 · HTTP 200：文本片段结构不符合要求');
});

test('diagnostic enums reject arbitrary strings, whitespace, invalid types and invalid HTTP values', () => {
  for (const stage of ['event\nSECRET', 'SECRET', '', null]) assert.equal(sanitizeSiwcDiagnostic({ stage }), undefined);
  const safe = sanitizeSiwcDiagnostic({ stage: 'headers', reason: 'SECRET', httpStatus: 200.1, contentType: 'application/json; SECRET', eventType: 'response.completed\nSECRET', jsonType: 'SECRET', deltaType: {}, responseType: 'string\nSECRET', responseStatus: 'SECRET', eventKeys: ['SECRET', 'status'], responseKeys: ['SECRET'] });
  assert.deepEqual(safe, { stage: 'headers', eventKeys: ['status'], responseKeys: [] });
  for (const httpStatus of [0, 99, 600, Infinity, '200']) assert.equal(sanitizeSiwcDiagnostic({ stage: 'headers', httpStatus })?.httpStatus, undefined);
  assert.equal(siwcDiagnosticText({ stage: 'SECRET', reason: 'invalidJson' }), '');
});

test('malformed state and version never enter the clipboard output', () => {
  const malformed = { status: { state: 'SECRET', generation: 'SECRET', loggedIn: 'SECRET', planAuthorized: 'SECRET' } } as unknown as SiwcView;
  assert.deepEqual(siwcDiagnosticSnapshot(malformed, '0.10.1\nSECRET'), { version: 'unknown', provider: 'chatgptOAuth', state: 'unknown', loggedIn: false, planAuthorized: false, generation: 'unchecked' });
  assert.ok(!formatSiwcDiagnostics(malformed, 'SECRET').includes('SECRET'));
  assert.deepEqual(sanitizeSiwcDiagnostic({ stage: 'stream', eventKeys: Array(1000).fill('status') }), { stage: 'stream', eventKeys: ['status'] });
});
