import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWebChatDiagnostics, validWebChatFailure, webChatDiagnosticSnapshot, webChatFailureText, webChatStatusText } from '../src/webchat-status-ui';
import type { WebChatView } from '../src/webchat-shared';

test('login and model access never imply a verified conversation', () => {
  assert.equal(webChatStatusText({ state: 'ready' }), '已登录，模型列表已读取；对话尚未验证');
  assert.equal(webChatStatusText({ state: 'ready', generation: 'unchecked' }), '已登录，模型列表已读取；对话尚未验证');
  assert.equal(webChatStatusText({ state: 'ready', generation: 'working' }), '已登录；最近一次对话成功');
  assert.equal(webChatStatusText({ state: 'ready', generation: 'blocked' }), '已登录；最近一次对话失败');
  assert.equal(webChatStatusText({ state: 'signedOut', generation: 'working' }), '请先在 ChatGPT 网页登录');
});

test('retired official-page transport asks users to update connection settings', () => {
  for (const status of [
    { state: 'ready' }, { state: 'ready', generation: 'unchecked' },
    { state: 'ready', generation: 'working' }, { state: 'ready', generation: 'blocked' },
    { state: 'missingTab', generation: 'working' }, { state: 'signedOut' },
  ] as const) {
    assert.equal(webChatStatusText({ ...status, transport: 'page' }), '旧版官网页面发送已停用，请更新连接设置');
  }
});

test('client connection failures explain recovery without reflecting page text', () => {
  assert.match(webChatFailureText({ stage: 'conversation', code: 'pageBusy', text: 'PRIVATE_DRAFT' }), /正在处理另一项请求/);
  assert.match(webChatFailureText({ stage: 'conversation', code: 'pageChanged' }), /连接页面已更新.*重新检查账号/);
  assert.match(webChatFailureText({ stage: 'session', code: 'pageUnsupported' }), /网页客户端暂不兼容/);
  assert.doesNotMatch(webChatFailureText({ stage: 'conversation', code: 'pageBusy', text: 'PRIVATE_DRAFT' }), /PRIVATE_/);
});

test('safe failure fields distinguish HTTP 403 from a verification challenge', () => {
  const text = webChatFailureText({ stage: 'conversation', httpStatus: 403, code: 'accessDenied', body: 'RAW_BODY_MUST_NOT_RENDER' });
  assert.match(text, /对话请求 · HTTP 403/);
  assert.match(text, /网页拒绝/);
  assert.doesNotMatch(text, /完成验证|RAW_BODY/);
  assert.match(webChatFailureText({ stage: 'session', httpStatus: 403, code: 'verificationRequired' }), /登录检查 · HTTP 403.*额外验证/);
  assert.match(webChatFailureText({ stage: 'models', httpStatus: 429, code: 'quota' }), /模型列表 · HTTP 429.*请求频率受限/);
});

test('diagnostic UI rejects unknown fields instead of reflecting their contents', () => {
  for (const value of [null, [], { stage: 'RAW_STAGE', code: 'network' }, { stage: 'session', code: 'RAW_CODE' }, { stage: 'conversation', code: 'network', httpStatus: 'RAW_STATUS' }, { stage: 'conversation', code: 'network', httpStatus: 403.5 }, { stage: 'conversation', code: 'network', httpStatus: 999 }, { stage: '__proto__', code: 'network' }, { stage: 'models', code: 'toString' }]) {
    assert.equal(validWebChatFailure(value), false);
    assert.equal(webChatFailureText(value), '');
  }
});

test('copyable connection diagnostics contain only the explicit status whitelist', () => {
  const view = {
    config: { provider: 'chatgptWeb', model: 'PRIVATE_MODEL' },
    status: {
      state: 'ready', loggedIn: true, generation: 'blocked', accountLabel: 'PRIVATE_ACCOUNT',
      models: [{ id: 'PRIVATE_MODEL', label: 'PRIVATE_MODEL_LABEL' }], error: 'PRIVATE_RAW_ERROR',
      lastFailure: { stage: 'conversation', httpStatus: 403, code: 'accessDenied', body: 'PRIVATE_BODY', token: 'PRIVATE_TOKEN' },
      input: 'PRIVATE_INPUT', answer: 'PRIVATE_ANSWER',
    },
  } as WebChatView;
  assert.deepEqual(webChatDiagnosticSnapshot(view, '0.7.1'), {
    version: '0.7.1', provider: 'chatgptWeb',
    status: { state: 'ready', loggedIn: true, generation: 'blocked', lastFailure: { stage: 'conversation', httpStatus: 403, code: 'accessDenied' } },
  });
  const text = formatWebChatDiagnostics(view, '0.7.1');
  assert.doesNotMatch(text, /PRIVATE_/);
  assert.match(text, /最近一次对话失败/);
  assert.match(text, /403/);
});

test('diagnostics explicitly report unverified conversations without a failure', () => {
  const view: WebChatView = { config: { provider: 'chatgptWeb', model: '' }, status: { state: 'ready', loggedIn: true, models: [] } };
  assert.deepEqual(webChatDiagnosticSnapshot(view, '0.7.1'), {
    version: '0.7.1', provider: 'chatgptWeb', status: { state: 'ready', loggedIn: true, generation: 'unchecked' },
  });
  assert.match(formatWebChatDiagnostics(view, '0.7.1'), /对话尚未验证/);
  assert.equal(webChatDiagnosticSnapshot(view, 'PRIVATE_VERSION').version, 'unknown');
});

test('official-page diagnostics add only the chosen fixed transport value', () => {
  const view = {
    config: { provider: 'chatgptWeb', transport: 'page', model: 'follow-page', private: 'PRIVATE_CONFIG' },
    status: {
      state: 'ready', loggedIn: true, transport: 'page', models: [{ id: 'follow-page', label: 'PRIVATE_MODEL' }],
      accountLabel: 'PRIVATE_ACCOUNT', input: 'PRIVATE_INPUT', generation: 'blocked',
      lastFailure: { stage: 'conversation', code: 'pageChanged', text: 'PRIVATE_TEXT' },
    },
  } as WebChatView;
  assert.deepEqual(webChatDiagnosticSnapshot(view, '0.8.0'), {
    version: '0.8.0', provider: 'chatgptWeb', transport: 'page',
    status: { state: 'ready', loggedIn: true, generation: 'blocked', lastFailure: { stage: 'conversation', code: 'pageChanged' } },
  });
  assert.doesNotMatch(formatWebChatDiagnostics(view, '0.8.0'), /PRIVATE_/);
  delete view.status.generation;
  assert.match(formatWebChatDiagnostics(view, '0.8.0'), /旧版官网页面发送已停用/);
  (view.config as { transport: string }).transport = 'PRIVATE_TRANSPORT';
  assert.equal(Object.hasOwn(webChatDiagnosticSnapshot(view, '0.8.0'), 'transport'), false);
});

test('webapp transport reports account readiness and preserves only safe diagnostic fields', () => {
  const view: WebChatView = {
    config: { provider: 'chatgptWeb', transport: 'webapp', model: 'PRIVATE_MODEL' },
    status: { state: 'ready', loggedIn: true, transport: 'webapp', models: [{ id: 'PRIVATE_MODEL', label: 'PRIVATE_LABEL' }], accountLabel: 'PRIVATE_ACCOUNT' },
  };
  assert.equal(webChatStatusText(view.status), '已登录，模型列表已读取；对话尚未验证');
  assert.deepEqual(webChatDiagnosticSnapshot(view, '0.8.1'), {
    version: '0.8.1', provider: 'chatgptWeb', transport: 'webapp',
    status: { state: 'ready', loggedIn: true, generation: 'unchecked' },
  });
  assert.doesNotMatch(formatWebChatDiagnostics(view, '0.8.1'), /PRIVATE_/);
  assert.match(formatWebChatDiagnostics(view, '0.8.1'), /登录和模型检查不验证对话能力/);
  view.status.generation = 'working';
  assert.equal(webChatStatusText(view.status), '已登录；最近一次对话成功');
  view.status.generation = 'blocked';
  assert.equal(webChatStatusText(view.status), '已登录；最近一次对话失败');
  assert.equal(webChatStatusText({ state: 'missingTab', transport: 'webapp' }), '账号连接尚未初始化，请到设置检查账号');
});
