import { trustedPage } from './trusted-page';
import { WebChatFailure } from './webchat-protocol';
import { openWebAppLogin, requestWebApp } from './webchat-webapp';
import { WEBCHAT_ORIGIN, WEBCHAT_PORT, WEBCHAT_PAGE_PORT, type WebChatConfig, type WebChatConversation, type WebChatErrorCode, type WebChatFailureInfo, type WebChatInput, type WebChatPageCommand, type WebChatPageEvent, type WebChatStatus, type WebChatTransport, type WebChatView } from './webchat-shared';

const CONFIG_KEY = 'webChatConfig';
const OWNED_PAGE_KEY = 'webChatOwnedPage';
const ORIGINS = [`${WEBCHAT_ORIGIN}/*`];
const MAX_TEXT = 40_000;
export const WEBCHAT_TIMEOUTS = { status: 20_000, total: 120_000, pageTotal: 180_000, idle: 60_000 };
const errors: Record<WebChatErrorCode, string> = {
  signedOut: '请先在 ChatGPT 网页登录，再刷新连接状态。',
  verificationRequired: '请在 ChatGPT 网页完成验证后手动重试。',
  accessDenied: 'ChatGPT 网页接口拒绝了本次请求，请在官方网页确认能否正常对话。',
  quota: 'ChatGPT 当前额度不足，请在网页查看额度后手动重试。',
  network: 'ChatGPT 网页连接失败，请检查网络和已打开的网页后手动重试。',
  format: 'ChatGPT 网页响应格式发生变化，本次请求已停止。',
  interrupted: 'ChatGPT 标签页已关闭或跳转，本次请求已停止。',
  model: '所选 ChatGPT 模型当前不可用，请刷新模型列表后重新选择。',
  timeout: 'ChatGPT 网页响应超时，已停止请求，请手动重试。',
  pageBusy: 'ChatGPT 账号连接正在处理另一项请求，请稍后重试。',
  pageChanged: 'ChatGPT 连接页面已更新，本次请求已停止，请到设置重新检查账号。',
  pageUnsupported: 'ChatGPT 网页客户端暂不兼容，请刷新官网页面后重新检查账号。'
};
const unchecked = (): WebChatStatus => ({ state: 'unchecked', loggedIn: false, models: [], generation: 'unchecked' });
let cachedStatus: WebChatStatus = unchecked();
let conversation: { remote: WebChatConversation; messages: WebChatInput[] } | undefined;
let revision = 0;
let statusRevision = 0;
let initialized = false;
let onConfigChange = () => {};
let configWrites: Promise<unknown> = Promise.resolve();
let generation: AbortController | undefined;
const operations = new Set<AbortController>();
interface OwnedPage { tabId: number; documentId?: string; route?: string }
let ownedPage: OwnedPage | undefined;
let ownershipLoaded = false;
let ownershipRevision = 0;
let ownershipWrites: Promise<unknown> = Promise.resolve();
function rememberPage(value?: OwnedPage) {
  ++ownershipRevision; ownershipLoaded = true; ownedPage = value;
  const snapshot = value ? { ...value } : undefined;
  ownershipWrites = ownershipWrites.then(() => snapshot
    ? chrome.storage.session.set({ [OWNED_PAGE_KEY]: snapshot })
    : chrome.storage.session.remove(OWNED_PAGE_KEY)).catch(() => {});
}
async function restorePage(): Promise<OwnedPage | undefined> {
  if (!ownershipLoaded) {
    ownershipLoaded = true;
    const before = ownershipRevision;
    const value = (await chrome.storage.session.get(OWNED_PAGE_KEY))[OWNED_PAGE_KEY];
    if (before === ownershipRevision && plain(value) && Number.isInteger(value.tabId) && Number(value.tabId) >= 0
      && (value.documentId === undefined || identifier(value.documentId))
      && (value.route === undefined || typeof value.route === 'string' && pageRoute(`${WEBCHAT_ORIGIN}${value.route}`) === value.route)) {
      ownedPage = { tabId: Number(value.tabId), ...(value.documentId ? { documentId: String(value.documentId) } : {}), ...(value.route ? { route: String(value.route) } : {}) };
    }
  }
  return ownedPage;
}
class PageFailure extends Error {
  constructor(public readonly details: WebChatFailureInfo) { super(errors[details.code]); }
}
const failure = (code: WebChatErrorCode, details: Partial<Omit<WebChatFailureInfo, 'code'>> = {}) => new PageFailure({ stage: details.stage || 'conversation', ...(details.httpStatus !== undefined ? { httpStatus: details.httpStatus } : {}), code });
const aborted = () => new DOMException('Aborted', 'AbortError');
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const modelId = identifier;
function configValue(value: unknown, strict = false): WebChatConfig {
  if (!plain(value) || !['apiKey', 'chatgptWeb', 'chatgptOAuth'].includes(String(value.provider)) || value.provider === 'chatgptOAuth' && value.transport !== undefined || value.transport !== undefined && !['direct', 'page', 'webapp'].includes(String(value.transport)) || value.transport !== 'page' && (typeof value.model !== 'string' || value.model !== '' && !(value.provider === 'chatgptOAuth' ? /^[A-Za-z0-9_.:-]{1,160}$/.test(value.model) : modelId(value.model)))) {
    if (strict) throw new Error('连接方式或 ChatGPT 模型配置无效。');
    return { provider: 'apiKey', model: '' };
  }
  return { provider: value.provider as WebChatConfig['provider'], model: value.transport === 'page' ? 'follow-page' : value.model as string, ...(value.transport !== undefined ? { transport: value.transport as WebChatTransport } : {}) };
}
async function readConfig(): Promise<WebChatConfig> {
  return configValue((await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY]);
}
function validPage(url?: string): boolean {
  try { const value = new URL(url || ''); return value.origin === WEBCHAT_ORIGIN && !value.username && !value.password; }
  catch { return false; }
}
function pageRoute(url?: string): string | undefined {
  if (!validPage(url)) return;
  const pathname = new URL(url!).pathname;
  return pathname === '/' || /^\/c\/[A-Za-z0-9_-]{1,200}$/.test(pathname) ? pathname : undefined;
}
async function createOwnedPage(active = false): Promise<chrome.tabs.Tab> {
  const before = ownershipRevision;
  const tab = await chrome.tabs.create({ url: `${WEBCHAT_ORIGIN}/`, active });
  if (!Number.isInteger(tab?.id)) throw failure('pageChanged');
  if (before !== ownershipRevision) throw failure('pageChanged');
  rememberPage({ tabId: tab.id! });
  return tab;
}
async function ownedTab(): Promise<chrome.tabs.Tab | undefined> {
  const owned = await restorePage();
  if (!owned) return;
  try {
    const tab = await chrome.tabs.get(owned.tabId);
    if (ownedPage !== owned) return;
    const initialLoading = !owned.documentId && tab.status === 'loading' && pageRoute(tab.pendingUrl) === '/' && !validPage(tab.url);
    if (!initialLoading && (!validPage(tab.url) || !pageRoute(tab.url)) || tab.pendingUrl && !validPage(tab.pendingUrl)) { rememberPage(); return; }
    if (owned.route && pageRoute(tab.url) !== owned.route) { rememberPage(); return; }
    return tab;
  } catch { if (ownedPage === owned) rememberPage(); }
}
async function hasPermission(): Promise<boolean> { return chrome.permissions.contains({ origins: ORIGINS }); }
function requireCurrent(signal: AbortSignal) { if (signal.aborted) throw aborted(); }
function statusValue(value: unknown): WebChatStatus {
  if (!plain(value) || !['unchecked', 'ready', 'signedOut', 'missingTab', 'permissionRequired', 'verificationRequired', 'error'].includes(String(value.state)) || typeof value.loggedIn !== 'boolean' || !Array.isArray(value.models) || value.models.length > 100) throw failure('format');
  const models: WebChatStatus['models'] = [];
  for (const model of value.models) {
    if (!plain(model) || !modelId(model.id) || typeof model.label !== 'string' || model.label.length > 160 || /[\u0000-\u001f\u007f]/.test(model.label)) throw failure('format');
    if (!models.some(item => item.id === model.id)) models.push({ id: model.id, label: model.label });
  }
  if (value.state === 'ready' && !value.loggedIn) throw failure('format');
  const accountLabel = typeof value.accountLabel === 'string' && value.accountLabel.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value.accountLabel) ? value.accountLabel : undefined;
  return {
    state: value.state as WebChatStatus['state'], loggedIn: value.loggedIn, models, generation: 'unchecked',
    ...(accountLabel ? { accountLabel } : {}),
    ...(value.state === 'error' ? { error: errors.network } : {})
  };
}
function inputValue(value: WebChatInput[]): WebChatInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 41) throw new Error('对话内容无效或过长，本次没有发送。');
  let length = 0;
  const messages = value.map(item => {
    if (!plain(item) || !['system', 'user', 'assistant'].includes(String(item.role)) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > MAX_TEXT) throw new Error('对话内容无效或过长，本次没有发送。');
    length += item.content.length;
    return { role: item.role, content: item.content } as WebChatInput;
  });
  const history = messages.filter(item => item.role !== 'system');
  if (length > 200_000 || history.length % 2 !== 1 || history.some((item, index) => item.role !== (index % 2 ? 'assistant' : 'user'))) throw new Error('对话内容无效或过长，本次没有发送。');
  return messages;
}
async function frame(tabId: number) {
  const [tab, document] = await Promise.all([chrome.tabs.get(tabId), chrome.webNavigation.getFrame({ tabId, frameId: 0 })]);
  if (!validPage(tab.url) || tab.pendingUrl || tab.status === 'loading' || !document || !validPage(document.url) || !document.documentId || document.documentLifecycle && document.documentLifecycle !== 'active') throw failure('interrupted');
  return document.documentId;
}

/** A fresh, document-bound Port per operation. Tokens never enter this process. */
function pageRequest(command: WebChatPageCommand, signal: AbortSignal, onText?: (text: string) => void, transport: WebChatTransport = 'direct'): Promise<WebChatPageEvent> {
  if (transport === 'webapp') {
    if (command.type === 'cancel') return Promise.reject(failure('interrupted'));
    const own = new AbortController();
    const abort = () => own.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) own.abort();
    operations.add(own);
    return requestWebApp(command, own.signal, onText).catch(error => {
      if (error instanceof WebChatFailure) throw failure(error.code, { stage: error.stage, httpStatus: error.httpStatus });
      throw error;
    }).finally(() => { signal.removeEventListener('abort', abort); operations.delete(own); });
  }
  const own = new AbortController();
  operations.add(own);
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port | undefined;
    let tabId: number | undefined;
    let documentId: string | undefined;
    let route: string | undefined;
    let pageVersion: number | undefined;
    let complete = false;
    let ending = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const total = setTimeout(() => finish(failure('timeout', { stage: command.type === 'status' ? 'session' : 'conversation' })), command.type === 'status' ? WEBCHAT_TIMEOUTS.status : transport === 'page' ? WEBCHAT_TIMEOUTS.pageTotal : WEBCHAT_TIMEOUTS.total);
    const onAbort = () => finish(aborted());
    const close = () => {
      if (port) { try { port.postMessage({ type: 'cancel', id: command.id }); } catch { /* The document may have disappeared. */ } }
      signal.removeEventListener('abort', onAbort); own.signal.removeEventListener('abort', onAbort);
      clearTimeout(total); clearTimeout(idle); operations.delete(own);
      chrome.tabs.onUpdated.removeListener(onUpdated); chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.webNavigation.onCommitted.removeListener(onCommitted);
      chrome.permissions.onRemoved?.removeListener(onPermissionsRemoved);
      try { port?.disconnect(); } catch { /* Already closed. */ }
      own.abort();
    };
    function finish(error?: unknown, result?: WebChatPageEvent) {
      if (complete) return; complete = true; close();
      if (error && transport === 'page' && pageVersion === ownershipRevision && ownedPage?.tabId === tabId
        && !(error instanceof PageFailure && ['signedOut', 'verificationRequired'].includes(error.details.code))) rememberPage();
      if (error) reject(error); else resolve(result!);
    }
    function acceptRoute(url?: string) {
      if (transport !== 'page') return;
      const next = pageRoute(url);
      if (!next) throw failure('pageChanged');
      if (next === route) return;
      if (command.type === 'generate' && route === '/' && next.startsWith('/c/') && !('conversation' in command && command.conversation)) { route = next; return; }
      throw failure('pageChanged');
    }
    function onUpdated(id: number, info: chrome.tabs.OnUpdatedInfo) {
      if (id !== tabId) return;
      if (transport === 'direct') { if (info.url !== undefined || info.status === 'loading') finish(failure('interrupted')); return; }
      // Chrome also reports "loading" for history.pushState within the same
      // document. Route checks stay active here; committed document IDs, Port
      // lifetime and the final frame check distinguish an actual navigation.
      if (info.url !== undefined) { try { acceptRoute(info.url); } catch (error) { finish(error); } }
    }
    function onRemoved(id: number) { if (id === tabId) finish(failure('interrupted')); }
    function onCommitted(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) { if (details.tabId === tabId && details.frameId === 0 && documentId !== undefined && details.documentId !== documentId) finish(failure(transport === 'page' ? 'pageChanged' : 'interrupted')); }
    function onPermissionsRemoved() { void hasPermission().then(allowed => { if (!allowed) finish(new Error('请先在设置中授权 ChatGPT 域名。')); }).catch(() => finish(failure('network'))); }
    const assertDocument = async () => {
      requireCurrent(signal); requireCurrent(own.signal);
      if (complete || tabId === undefined || await frame(tabId) !== documentId) throw failure('interrupted');
      if (transport === 'page') acceptRoute((await chrome.tabs.get(tabId)).url);
      if (!await hasPermission()) throw new Error('请先在设置中授权 ChatGPT 域名。');
      requireCurrent(signal); requireCurrent(own.signal);
      if (complete) throw aborted();
    };
    const resetIdle = () => {
      if (command.type !== 'generate') return;
      clearTimeout(idle); idle = setTimeout(() => finish(failure('timeout')), WEBCHAT_TIMEOUTS.idle);
    };
    const receive = (value: unknown) => {
      if (complete || ending || !plain(value) || value.id !== command.id) return;
      try {
        if (value.type === 'error') {
          const code = typeof value.code === 'string' && Object.hasOwn(errors, value.code) ? value.code as WebChatErrorCode : 'format';
          const stage = ['session', 'models', 'conversation'].includes(String(value.stage)) ? value.stage as WebChatFailureInfo['stage'] : command.type === 'generate' ? 'conversation' : 'session';
          const httpStatus = Number.isInteger(value.httpStatus) && Number(value.httpStatus) >= 100 && Number(value.httpStatus) <= 599 ? Number(value.httpStatus) : undefined;
          finish(failure(code, { stage, ...(httpStatus !== undefined ? { httpStatus } : {}) })); return;
        }
        if (command.type === 'status') {
          if (value.type !== 'status') throw failure('format');
          const status = { ...statusValue(value.status), ...(transport === 'page' ? { transport, accountLabel: undefined, models: value.status && plain(value.status) && value.status.state === 'ready' ? [{ id: 'follow-page', label: '跟随官网当前模型' }] : [] } : {}) }; ending = true;
          void assertDocument().then(() => finish(undefined, { type: 'status', id: command.id, status })).catch(error => finish(error));
          return;
        }
        if (value.type === 'heartbeat' && transport === 'page') { resetIdle(); return; }
        if (value.type !== 'text' && value.type !== 'done' || typeof value.text !== 'string' || value.text.length > MAX_TEXT) throw failure('format');
        resetIdle();
        if (value.type === 'text') { onText?.(value.text); return; }
        if (!value.text.trim() || !plain(value.conversation) || !identifier(value.conversation.id) || !identifier(value.conversation.parentId)) throw failure('format');
        const result: WebChatPageEvent = { type: 'done', id: command.id, text: value.text, conversation: { id: value.conversation.id, parentId: value.conversation.parentId } };
        ending = true;
        void assertDocument().then(() => {
          if (transport === 'page') {
            if (route !== `/c/${result.conversation.id}`) throw failure('pageChanged');
            rememberPage({ tabId: tabId!, documentId, route });
          }
          finish(undefined, result);
        }).catch(error => finish(error));
      } catch (error) { finish(error instanceof Error && error.message === errors.format ? error : failure('format')); }
    };
    signal.addEventListener('abort', onAbort, { once: true }); own.signal.addEventListener('abort', onAbort, { once: true });
    chrome.tabs.onUpdated.addListener(onUpdated); chrome.tabs.onRemoved.addListener(onRemoved); chrome.webNavigation.onCommitted.addListener(onCommitted);
    chrome.permissions.onRemoved?.addListener(onPermissionsRemoved);
    void (async () => {
      requireCurrent(signal); requireCurrent(own.signal);
      if (!await hasPermission()) throw new Error('请先在设置中授权 ChatGPT 域名。');
      requireCurrent(signal); requireCurrent(own.signal);
      if (transport === 'page') {
        let tab = await ownedTab();
        requireCurrent(signal); requireCurrent(own.signal);
        if (command.type === 'generate') {
          if (command.conversation && (!tab || pageRoute(tab.url) !== `/c/${command.conversation.id}`)) throw failure('pageChanged');
          if (!command.conversation && (!tab || (pageRoute(tab.url) || pageRoute(tab.pendingUrl)) !== '/')) tab = await createOwnedPage();
        }
        if (!tab) throw new Error('请先打开阅窗专用的 ChatGPT 页面，再检查连接。');
        tabId = tab.id!; route = pageRoute(tab.url) || '/'; pageVersion = ownershipRevision;
        while (tab.status === 'loading' || tab.pendingUrl) {
          await new Promise(resolve => setTimeout(resolve, 100));
          requireCurrent(signal); requireCurrent(own.signal);
          tab = await chrome.tabs.get(tabId);
          if (validPage(tab.url)) acceptRoute(tab.url);
          else if (tab.status !== 'loading' || pageRoute(tab.pendingUrl) !== '/' || ownedPage?.documentId) throw failure('pageChanged');
        }
        documentId = await frame(tabId);
        const owned = await restorePage();
        if (!owned || owned.tabId !== tabId || owned.documentId && owned.documentId !== documentId) throw failure('pageChanged');
        rememberPage({ tabId, documentId, route });
        pageVersion = ownershipRevision;
      } else {
        const tabs = (await chrome.tabs.query({ url: ORIGINS })).filter(tab => Number.isInteger(tab.id) && validPage(tab.url) && (!tab.pendingUrl || validPage(tab.pendingUrl)));
        tabs.sort((left, right) => Number(!!right.active) - Number(!!left.active));
        if (!tabs.length) throw new Error('请先打开并登录 ChatGPT 网页，再刷新连接状态。');
        tabId = tabs[0].id!; documentId = await frame(tabId);
      }
      requireCurrent(signal); requireCurrent(own.signal);
      const injected = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [transport === 'page' ? 'webchat-page-content.js' : 'webchat-content.js'], world: 'ISOLATED' });
      if (injected.length !== 1 || injected[0].frameId !== 0 || injected[0].documentId !== documentId) throw failure('interrupted');
      await assertDocument();
      port = chrome.tabs.connect(tabId, { name: transport === 'page' ? WEBCHAT_PAGE_PORT : WEBCHAT_PORT, frameId: 0 });
      port.onMessage.addListener(receive);
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (!complete) finish(failure('interrupted')); });
      await assertDocument();
      resetIdle(); port.postMessage(command);
    })().catch(error => finish(error instanceof PageFailure || error instanceof DOMException && error.name === 'AbortError' ? error : error instanceof Error && ['请先在设置中授权 ChatGPT 域名。', '请先打开并登录 ChatGPT 网页，再刷新连接状态。', '请先打开阅窗专用的 ChatGPT 页面，再检查连接。'].includes(error.message) ? error : failure('network')));
  });
}

/** Reading status never opens a tab, contacts ChatGPT, or starts a model request. */
export async function getWebChatView(): Promise<WebChatView> {
  await configWrites;
  return { config: await readConfig(), status: structuredClone(cachedStatus) };
}
export async function refreshWebChat(): Promise<WebChatView> {
  // An explicit account check establishes a fresh identity boundary. A page may
  // have switched accounts since the previous status check or successful turn.
  conversation = undefined; generation?.abort(); onConfigChange();
  const config = await readConfig();
  const transport = config.transport || 'direct';
  const before = revision, refresh = ++statusRevision;
  const current = () => before === revision && refresh === statusRevision;
  try {
    if (!await hasPermission()) { if (current()) cachedStatus = { state: 'permissionRequired', loggedIn: false, models: [] }; }
    else if (transport !== 'webapp' && (transport === 'page' ? !await ownedTab() : !(await chrome.tabs.query({ url: ORIGINS })).some(tab => validPage(tab.url) && Number.isInteger(tab.id)))) { if (current()) cachedStatus = { state: 'missingTab', loggedIn: false, models: [], ...(transport === 'page' ? { transport } : {}) }; }
    else {
      const event = await pageRequest({ type: 'status', id: crypto.randomUUID() }, new AbortController().signal, undefined, transport);
      if (current() && event.type === 'status') {
        // This check reads identity and models only. It never proves generation
        // works, including after an earlier successful or failed conversation.
        cachedStatus = { ...event.status, generation: 'unchecked' };
        delete cachedStatus.lastFailure;
      }
    }
  } catch (error) {
    if (current()) {
      const message = error instanceof Error ? error.message : '';
      cachedStatus = message === errors.signedOut ? { state: 'signedOut', loggedIn: false, models: [], generation: 'unchecked' } : message === errors.verificationRequired ? { state: 'verificationRequired', loggedIn: false, models: [], generation: 'unchecked' } : { state: 'error', loggedIn: false, models: [], generation: 'unchecked', error: message === errors.timeout ? errors.timeout : error instanceof PageFailure ? errors[error.details.code] : errors.network };
      if (error instanceof PageFailure) cachedStatus.lastFailure = { ...error.details };
    }
  }
  if (current() && (transport === 'page' || transport === 'webapp')) cachedStatus = { ...cachedStatus, transport };
  return getWebChatView();
}
export function resetWebChatConversation(): void {
  conversation = undefined;
  generation?.abort();
  rememberPage();
}
export function saveWebChatConfig(config: WebChatConfig): Promise<WebChatView> {
  const value = configValue(config, true);
  const write = configWrites.then(async () => {
    const old = await readConfig();
    if (old.provider !== value.provider || old.model !== value.model || old.transport !== value.transport) {
      ++revision; resetWebChatConversation(); for (const operation of operations) operation.abort();
      cachedStatus = (old.transport || 'direct') !== (value.transport || 'direct') ? unchecked() : { ...cachedStatus, generation: 'unchecked' };
      delete cachedStatus.lastFailure;
      onConfigChange();
      await chrome.storage.local.set({ [CONFIG_KEY]: value });
    }
  });
  configWrites = write.catch(() => {});
  return write.then(getWebChatView);
}
export async function openChatgptLogin(): Promise<void> {
  if (!await hasPermission()) throw new Error('请先在设置中授权 ChatGPT 域名。');
  await configWrites;
  if ((await readConfig()).transport === 'webapp') { await openWebAppLogin(); return; }
  if ((await readConfig()).transport === 'page') {
    const existing = await ownedTab();
    if (existing?.id !== undefined) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      resetWebChatConversation();
      await createOwnedPage(true);
    }
    return;
  }
  const tabs = (await chrome.tabs.query({ url: ORIGINS })).filter(tab => Number.isInteger(tab.id) && validPage(tab.url) && (!tab.pendingUrl || validPage(tab.pendingUrl)));
  const existing = tabs.find(tab => tab.active) || tabs[0];
  if (existing?.id !== undefined) {
    const actual = await chrome.tabs.get(existing.id);
    if (!validPage(actual.url) || actual.pendingUrl && !validPage(actual.pendingUrl)) throw failure('interrupted');
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url: `${WEBCHAT_ORIGIN}/`, active: true });
}
export async function requestWebChat(messages: WebChatInput[], signal: AbortSignal, onText: (text: string) => void): Promise<string> {
  requireCurrent(signal);
  if (generation) throw new Error('已有 ChatGPT 网页请求正在运行，请等待完成或停止后重试。');
  const owner = new AbortController(); generation = owner;
  let transport: WebChatTransport = 'direct';
  const abort = () => owner.abort(); signal.addEventListener('abort', abort, { once: true });
  try {
    await configWrites; requireCurrent(owner.signal);
    const config = await readConfig(); requireCurrent(owner.signal);
    transport = config.transport || 'direct';
    if (config.provider !== 'chatgptWeb' || !config.model) throw new Error('请先选择 ChatGPT 网页连接和可用模型。');
    const input = inputValue(messages);
    const history = input.filter(message => message.role !== 'system');
    const previous = history.slice(0, -1);
    let reuse = conversation && conversation.messages.length === previous.length && previous.every((message, index) => message.role === conversation!.messages[index].role && message.content === conversation!.messages[index].content) ? conversation.remote : undefined;
    if (config.transport === 'page' && reuse && !await ownedTab()) reuse = undefined;
    requireCurrent(owner.signal);
    const result = await pageRequest({ type: 'generate', id: crypto.randomUUID(), model: config.model, messages: input, ...(reuse ? { conversation: { ...reuse } } : {}) }, owner.signal, onText, config.transport);
    requireCurrent(owner.signal);
    if (result.type !== 'done') throw failure('format');
    conversation = { remote: result.conversation, messages: [...history, { role: 'assistant', content: result.text }] };
    cachedStatus = transport === 'page'
      ? { state: 'ready', loggedIn: true, models: [{ id: 'follow-page', label: '跟随官网当前模型' }], transport, generation: 'working' }
      : { ...cachedStatus, generation: 'working' };
    delete cachedStatus.lastFailure;
    return result.text;
  } catch (error) {
    conversation = undefined;
    // User cancellation, local input validation and configuration changes do not
    // establish a server failure. Keep remote error metadata to a safe whitelist.
    if (!owner.signal.aborted && error instanceof PageFailure) {
      const details = error.details;
      cachedStatus = details.code === 'signedOut' && (details.stage === 'session' || transport === 'page' || transport === 'webapp')
        ? { state: 'signedOut', loggedIn: false, models: [], generation: 'blocked', lastFailure: { ...details }, ...(['page', 'webapp'].includes(transport) ? { transport } : {}) }
        : details.code === 'verificationRequired' && (transport === 'page' || transport === 'webapp')
        ? { state: 'verificationRequired', loggedIn: false, models: [], generation: 'blocked', lastFailure: { ...details }, transport }
        : { ...cachedStatus, generation: 'blocked', lastFailure: { ...details } };
    }
    throw error;
  }
  finally { signal.removeEventListener('abort', abort); if (generation === owner) generation = undefined; }
}
function trusted(sender: chrome.runtime.MessageSender): boolean {
  return trustedPage(sender, 'options.html') || sender.id === chrome.runtime.id && (!sender.origin || sender.origin === chrome.runtime.getURL('').replace(/\/$/, '')) && sender.url?.split('#')[0] === chrome.runtime.getURL('sidepanel.html') && (sender.frameId === undefined || sender.frameId === 0);
}
export function initializeWebChat(options: { onConfigChange?: () => void } = {}): void {
  if (options.onConfigChange) onConfigChange = options.onConfigChange;
  if (initialized) return; initialized = true;
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (!plain(message) || typeof message.type !== 'string' || !message.type.startsWith('webchat:')) return;
    if (!trusted(sender)) { respond({ ok: false, error: '仅设置页与侧边栏可操作 ChatGPT 网页连接。' }); return; }
    const run = async () => {
      switch (message.type) {
        case 'webchat:view': return getWebChatView();
        case 'webchat:refresh': return refreshWebChat();
        case 'webchat:config': return saveWebChatConfig(message.config as WebChatConfig);
        case 'webchat:open': await openChatgptLogin(); return getWebChatView();
        case 'webchat:reset': resetWebChatConversation(); return getWebChatView();
        default: throw new Error('未知的 ChatGPT 网页操作。');
      }
    };
    void run().then(view => respond({ ok: true, view })).catch(() => respond({ ok: false, error: 'ChatGPT 网页操作失败，请检查配置、权限和网页后手动重试。' }));
    return true;
  });
}
