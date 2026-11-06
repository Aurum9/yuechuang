import { secureStorage } from './store';
import { trustedPage } from './trusted-page';
// Keep the old storage key so upgrades retain the selected supported provider.
import { CHAT_CONNECTION_CONFIG_KEY as CONFIG_KEY, type ChatConnectionConfig, type ChatConnectionView } from './chat-connection-shared';

const MIGRATION_KEY = 'chatConnectionMigration';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const modelId = (value: unknown): value is string => typeof value === 'string' && (value === '' || /^[A-Za-z0-9_.:-]{1,160}$/.test(value));
let queue: Promise<unknown> = Promise.resolve();
let initialized = false;
let onConfigChange = () => {};
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(async () => { await secureStorage; return operation(); });
  queue = next.catch(() => {});
  return next;
}
function configValue(value: unknown): ChatConnectionConfig {
  if (object(value) && value.provider === 'chatgptOAuth') return { provider: 'chatgptOAuth', model: modelId(value.model) ? value.model : '' };
  // Retired website credentials never opt the user into API Key billing.
  if (object(value) && value.provider === 'chatgptWeb') return { provider: 'chatgptOAuth', model: '' };
  return { provider: 'apiKey', model: '' };
}
function selectedConfig(value: unknown): ChatConnectionConfig {
  if (!object(value) || value.provider !== 'apiKey' && value.provider !== 'chatgptOAuth') throw new Error('请选择官方订阅或模型 API。');
  // API models belong to the main API settings. Ignore any stale website model
  // or transport that an older settings document might still submit.
  if (value.provider === 'apiKey') return { provider: 'apiKey', model: '' };
  if (!modelId(value.model) || value.transport !== undefined) throw new Error('官方订阅模型配置无效，请重新选择模型。');
  return { provider: 'chatgptOAuth', model: value.model };
}
async function readView(): Promise<ChatConnectionView> {
  const saved = await chrome.storage.local.get([CONFIG_KEY, MIGRATION_KEY]);
  const raw: unknown = saved[CONFIG_KEY];
  const config = configValue(raw);
  if (object(raw) && raw.provider === 'chatgptWeb') {
    await chrome.storage.local.set({ [CONFIG_KEY]: config, [MIGRATION_KEY]: 'webModeRemoved' });
    onConfigChange();
    return { config, migration: 'webModeRemoved' };
  }
  return { config, ...(saved[MIGRATION_KEY] === 'webModeRemoved' ? { migration: 'webModeRemoved' as const } : {}) };
}
export function getChatConnectionView(): Promise<ChatConnectionView> { return enqueue(readView); }
export function saveChatConnectionConfig(value: unknown, signal?: AbortSignal): Promise<ChatConnectionView> {
  const config = selectedConfig(value);
  return enqueue(async () => {
    const saved = await chrome.storage.local.get(CONFIG_KEY);
    const old = configValue(saved[CONFIG_KEY]);
    signal?.throwIfAborted();
    await chrome.storage.local.set({ [CONFIG_KEY]: config, [MIGRATION_KEY]: null });
    if (old.provider !== config.provider || old.model !== config.model) onConfigChange();
    return { config };
  });
}
export function initializeChatConnection(options: { onConfigChange?: () => void } = {}): void {
  if (options.onConfigChange) onConfigChange = options.onConfigChange;
  if (initialized) return;
  initialized = true;
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (!object(message) || typeof message.type !== 'string' || !['connection:get', 'connection:save'].includes(message.type) && !message.type.startsWith('webchat:')) return;
    if (!trustedPage(sender, 'options.html') && !trustedPage(sender, 'sidepanel.html')) {
      respond({ ok: false, error: '仅设置页与侧边栏可操作对话连接。' }); return;
    }
    if (message.type.startsWith('webchat:')) {
      respond({ ok: false, error: 'ChatGPT 网页模式已移除，请重新加载阅窗并选择官方订阅或模型 API。' }); return;
    }
    const saving = message.type === 'connection:save';
    let operation: Promise<ChatConnectionView>;
    try { operation = saving ? saveChatConnectionConfig(message.config) : getChatConnectionView(); }
    catch (error) { respond({ ok: false, error: error instanceof Error ? error.message : '对话连接配置无效。' }); return; }
    void operation.then(view => respond({ ok: true, view })).catch(() => respond({ ok: false,
      error: saving ? '对话连接保存失败，请检查扩展存储后重试。' : '对话连接读取失败，请重新加载扩展后重试。' }));
    return true;
  });
}
