import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';

type Value = Record<string, unknown>;
const local: Value = {}, session: Value = {};
const listeners: ((message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => unknown)[] = [];
let changes = 0, writes = 0, failWrite = false;
const accountSecret = 'synthetic-account-credential';
const API_SETTINGS = { baseUrl: 'https://api.example.test/v1', model: 'vendor/model:v2.1', rememberKey: true };
function area(values: Value) { return {
  async setAccessLevel() {},
  async get(names: string | string[]) { return structuredClone(Object.fromEntries((Array.isArray(names) ? names : [names]).map(name => [name, values[name]]))); },
  async set(value: Value) { if (failWrite) throw new Error(accountSecret); writes++; Object.assign(values, structuredClone(value)); },
  async remove(name: string) { delete values[name]; }
}; }
const extensionId = 'connection-test';
Object.assign(globalThis, { chrome: {
  runtime: { id: extensionId, getURL: (name: string) => `chrome-extension://${extensionId}/${name}`, onMessage: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) },
    connectNative() { throw new Error('A settings save must never launch a helper'); } },
  storage: { local: area(local), session: area(session) },
  tabs: { create() { throw new Error('A settings save must never open a website'); } },
  permissions: { contains() { throw new Error('A settings save must never inspect website permissions'); } }
} });
globalThis.fetch = async () => { throw new Error('A settings save must never call a model or website'); };
const manager = await import('../src/chat-connection');
manager.initializeChatConnection({ onConfigChange: () => { changes++; } });
manager.initializeChatConnection();
const source = { id: extensionId, url: `chrome-extension://${extensionId}/options.html`, frameId: 0 };
async function message(type: string, payload: Value = {}, sender: chrome.runtime.MessageSender = source): Promise<Value> {
  return new Promise(resolve => { for (const listener of listeners) listener({ type, ...payload }, sender, resolve as (value: unknown) => void); });
}
beforeEach(() => {
  for (const key of Object.keys(local)) delete local[key];
  for (const key of Object.keys(session)) delete session[key];
  local.settings = structuredClone(API_SETTINGS); local.apiKey = accountSecret;
  session.apiKey = accountSecret; session.chatSession = { retained: true };
  writes = changes = 0; failWrite = false;
});

test('switching from an OAuth model with punctuation to API does not validate or store the unrelated model', async () => {
  local.webChatConfig = { provider: 'chatgptOAuth', model: 'gpt-6.1-terra' };
  const result = await message('connection:save', { config: { provider: 'apiKey', model: 'gpt-6.1-terra', transport: 'webapp', token: accountSecret } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.view, { config: { provider: 'apiKey', model: '' } });
  assert.deepEqual(local.webChatConfig, { provider: 'apiKey', model: '' });
  assert.deepEqual(local.settings, API_SETTINGS); assert.equal(local.apiKey, accountSecret);
  assert.equal(session.apiKey, accountSecret); assert.deepEqual(session.chatSession, { retained: true });
  assert.ok(!JSON.stringify(result).includes(accountSecret)); assert.equal(changes, 1);
});

test('API-only configurations need no selected account model and normalize stale website properties', async () => {
  local.webChatConfig = { provider: 'apiKey', model: 'stale/model:1.2', transport: 'page' };
  assert.deepEqual(await manager.getChatConnectionView(), { config: { provider: 'apiKey', model: '' } });
  assert.deepEqual(await manager.saveChatConnectionConfig({ provider: 'apiKey' }), { config: { provider: 'apiKey', model: '' } });
  assert.equal(changes, 0);
  assert.deepEqual(local.webChatConfig, { provider: 'apiKey', model: '' });
});

test('all retired website transports migrate once to an unconfigured subscription without switching billing', async () => {
  for (const transport of ['direct', 'page', 'webapp']) {
    local.webChatConfig = { provider: 'chatgptWeb', transport, model: 'legacy-model' };
    const before = writes;
    const views = await Promise.all([manager.getChatConnectionView(), manager.getChatConnectionView()]);
    assert.deepEqual(views, Array(2).fill({ config: { provider: 'chatgptOAuth', model: '' }, migration: 'webModeRemoved' }));
    assert.equal(writes, before + 1);
    assert.equal(local.apiKey, accountSecret); assert.deepEqual(local.settings, API_SETTINGS);
    assert.equal(session.apiKey, accountSecret);
  }
  assert.deepEqual(await manager.saveChatConnectionConfig({ provider: 'apiKey', model: '' }), { config: { provider: 'apiKey', model: '' } });
  assert.deepEqual(await manager.getChatConnectionView(), { config: { provider: 'apiKey', model: '' } });
});

test('subscription save preserves its supported model id and rejects retired providers or malformed models', async () => {
  assert.deepEqual(await manager.saveChatConnectionConfig({ provider: 'chatgptOAuth', model: 'gpt-6.1-terra' }), { config: { provider: 'chatgptOAuth', model: 'gpt-6.1-terra' } });
  for (const config of [{ provider: 'chatgptWeb', model: 'legacy' }, { provider: 'other' }, { provider: 'chatgptOAuth', model: '../bad' }, { provider: 'chatgptOAuth', model: 'gpt-valid', transport: 'webapp' }]) {
    assert.throws(() => manager.saveChatConnectionConfig(config));
  }
  assert.equal(writes, 1);
  assert.deepEqual(local.webChatConfig, { provider: 'chatgptOAuth', model: 'gpt-6.1-terra' });
});

test('migration reads and explicit saves are serialized so late reads cannot revert the chosen API', async () => {
  local.webChatConfig = { provider: 'chatgptWeb', transport: 'webapp', model: 'legacy' };
  const read = manager.getChatConnectionView();
  const save = manager.saveChatConnectionConfig({ provider: 'apiKey', model: '' });
  const final = manager.getChatConnectionView();
  assert.equal((await read).migration, 'webModeRemoved');
  await save;
  assert.deepEqual(await final, { config: { provider: 'apiKey', model: '' } });
  assert.equal(changes, 2);
});

test('connection storage failures are neutral and permit retry without account or website operations', async () => {
  local.webChatConfig = { provider: 'chatgptOAuth', model: 'gpt-6.1-terra' };
  failWrite = true;
  const result = await message('connection:save', { config: { provider: 'apiKey', model: '' } });
  assert.equal(result.ok, false); assert.match(String(result.error), /对话连接保存失败/);
  assert.ok(!JSON.stringify(result).includes(accountSecret)); assert.doesNotMatch(String(result.error), /网页/);
  assert.equal(changes, 0); assert.equal((local.webChatConfig as Value).provider, 'chatgptOAuth');
  failWrite = false;
  assert.equal((await message('connection:save', { config: { provider: 'apiKey', model: '' } })).ok, true);
});

test('only packaged top-level settings and sidebar can use the connection endpoints; legacy messages cannot reactivate web mode', async () => {
  assert.equal(listeners.length, 1);
  for (const sender of [{ ...source, id: 'other' }, { ...source, frameId: 1 }, { ...source, url: 'https://example.test/' }, { ...source, url: `chrome-extension://${extensionId}/options.html?invalid` }]) {
    assert.equal((await message('connection:save', { config: { provider: 'apiKey' } }, sender)).ok, false);
  }
  assert.equal(writes, 0);
  for (const type of ['webchat:view', 'webchat:config', 'webchat:open', 'webchat:refresh', 'webchat:reset']) {
    const result = await message(type, { config: { provider: 'chatgptWeb', model: 'legacy' } });
    assert.equal(result.ok, false); assert.match(String(result.error), /网页模式已移除/);
  }
  assert.equal(writes, 0);
  const sidebar = { ...source, url: `chrome-extension://${extensionId}/sidepanel.html#settings` };
  assert.equal((await message('connection:get', {}, sidebar)).ok, true);
  await nextTurn(); assert.equal(writes, 0);
});
