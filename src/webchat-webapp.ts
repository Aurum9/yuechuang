import { WEBCHAT_ORIGIN, type WebChatErrorCode, type WebChatPageCommand, type WebChatPageEvent } from './webchat-shared';
import { WebChatFailure } from './webchat-protocol';
import { NATIVE_WEBAPP_BRIDGE_VERSION } from './webchat-native-version';

const ORIGINS = [`${WEBCHAT_ORIGIN}/*`];
const MAX_TEXT = 40_000;
const originPage = (url?: string) => {
  try { const value = new URL(url || ''); return value.origin === WEBCHAT_ORIGIN && !value.username && !value.password; }
  catch { return false; }
};
const abortError = () => new DOMException('Aborted', 'AbortError');
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const codes = new Set<WebChatErrorCode>(['signedOut', 'verificationRequired', 'accessDenied', 'quota', 'network', 'format', 'interrupted', 'model', 'timeout', 'pageUnsupported', 'pageBusy', 'pageChanged']);
let proxyTabId: number | undefined;
let opening: Promise<chrome.tabs.Tab> | undefined;

/** This page only hosts the website's normal HTTP client. It never fills or reads a chat editor. */
async function proxyPage(active = false, signal?: AbortSignal): Promise<chrome.tabs.Tab> {
  const current = () => { if (signal?.aborted) throw abortError(); };
  current();
  if (!await chrome.permissions.contains({ origins: ORIGINS })) throw new WebChatFailure('accessDenied', 'session');
  current();
  if (proxyTabId !== undefined) {
    try {
      const existing = await chrome.tabs.get(proxyTabId);
      current();
      if (originPage(existing.url) || originPage(existing.pendingUrl)) {
        if (active) await chrome.tabs.update(existing.id!, { active: true });
        return existing;
      }
    } catch { /* A closed or navigated proxy is replaced on the next explicit operation. */ }
    proxyTabId = undefined;
  }
  const existing = (await chrome.tabs.query({ url: ORIGINS })).filter(tab => Number.isInteger(tab.id) && originPage(tab.url) && (!tab.pendingUrl || originPage(tab.pendingUrl)));
  current();
  existing.sort((left, right) => Number(!!right.pinned) - Number(!!left.pinned) || Number(!!right.active) - Number(!!left.active));
  if (existing[0]) {
    proxyTabId = existing[0].id;
    if (active) await chrome.tabs.update(proxyTabId!, { active: true });
    return existing[0];
  }
  opening ??= chrome.tabs.create({ url: `${WEBCHAT_ORIGIN}/`, active, pinned: !active });
  try {
    const tab = await opening;
    current();
    if (!Number.isInteger(tab.id)) throw new WebChatFailure('network', 'session');
    proxyTabId = tab.id;
    return tab;
  } finally { opening = undefined; }
}

export async function openWebAppLogin(): Promise<void> { await proxyPage(true); }

function eventValue(value: unknown, id: string): WebChatPageEvent {
  if (!plain(value) || value.id !== id || typeof value.type !== 'string') throw new WebChatFailure('format');
  if (value.type === 'heartbeat') return { type: 'heartbeat', id };
  if (value.type === 'error') {
    const code = typeof value.code === 'string' && codes.has(value.code as WebChatErrorCode) ? value.code as WebChatErrorCode : 'format';
    const stage = value.stage === 'session' || value.stage === 'models' || value.stage === 'client' || value.stage === 'requirements' ? value.stage : 'conversation';
    const httpStatus = Number.isInteger(value.httpStatus) && Number(value.httpStatus) >= 100 && Number(value.httpStatus) <= 599 ? Number(value.httpStatus) : undefined;
    return { type: 'error', id, code, stage, ...(httpStatus === undefined ? {} : { httpStatus }) };
  }
  if (value.type === 'status') {
    const status = value.status;
    if (!plain(status) || !['ready', 'signedOut', 'verificationRequired', 'error'].includes(String(status.state)) || typeof status.loggedIn !== 'boolean' || !Array.isArray(status.models) || status.models.length > 100 || status.state === 'ready' && !status.loggedIn) throw new WebChatFailure('format', 'session');
    const models = status.models.map(model => {
      if (!plain(model) || !validId(model.id) || typeof model.label !== 'string' || model.label.length > 160 || /[\u0000-\u001f\u007f]/.test(model.label)) throw new WebChatFailure('format', 'models');
      return { id: model.id, label: model.label };
    });
    const accountLabel = typeof status.accountLabel === 'string' && status.accountLabel.length <= 160 && !/[\u0000-\u001f\u007f]/.test(status.accountLabel) ? status.accountLabel : undefined;
    return { type: 'status', id, status: { state: status.state as 'ready' | 'signedOut' | 'verificationRequired' | 'error', loggedIn: status.loggedIn, models, generation: 'unchecked', transport: 'webapp', ...(accountLabel ? { accountLabel } : {}) } };
  }
  if ((value.type !== 'text' && value.type !== 'done') || typeof value.text !== 'string' || value.text.length > MAX_TEXT) throw new WebChatFailure('format');
  if (value.type === 'text') return { type: 'text', id, text: value.text };
  if (!value.text.trim() || !plain(value.conversation) || !validId(value.conversation.id) || !validId(value.conversation.parentId)) throw new WebChatFailure('format');
  return { type: 'done', id, text: value.text, conversation: { id: value.conversation.id, parentId: value.conversation.parentId } };
}

/** All values returned by the page are whitelisted; session and verification tokens stay in its closure. */
export async function requestWebApp(command: Exclude<WebChatPageCommand, { type: 'cancel' }>, signal: AbortSignal, onText?: (text: string) => void): Promise<WebChatPageEvent> {
  const stage = command.type === 'status' ? 'session' : 'conversation';
  if (signal.aborted) throw abortError();
  const deadline = Date.now() + (command.type === 'status' ? 30_000 : 180_000);
  let tabId: number | undefined;
  let documentId: string | undefined;
  let finished = false;
  let cancelled = false;
  let interruption: WebChatFailure | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let rejectBoundary!: (reason: unknown) => void;
  const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; });
  void boundary.catch(() => {});
  const bounded = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, boundary]);
  const hardDeadline = setTimeout(() => { rejectBoundary(new WebChatFailure('timeout', stage)); cancel(); }, deadline - Date.now());
  const interrupt = () => { interruption = new WebChatFailure('interrupted', stage); rejectBoundary(interruption); wake?.(); };
  const onRemoved = (id: number) => { if (id === tabId) interrupt(); };
  const onCommitted = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
    if (details.tabId === tabId && details.frameId === 0 && documentId && details.documentId !== documentId) interrupt();
  };
  const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => { if (id === tabId && info.url !== undefined && !originPage(info.url)) interrupt(); };
  const cancel = () => {
    wake?.();
    if (cancelled || finished || tabId === undefined || !documentId) return;
    cancelled = true;
    void chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'MAIN', func: (id: string) => {
      const bridge = (window as unknown as { __readerNativeWebappBridgeV3?: { cancel(id: string): unknown } }).__readerNativeWebappBridgeV3;
      bridge?.cancel(id);
    }, args: [command.id] }).catch(() => {});
  };
  const onAbort = () => { rejectBoundary(abortError()); cancel(); };
  const current = () => {
    if (signal.aborted) throw abortError();
    if (interruption) throw interruption;
    if (Date.now() >= deadline) throw new WebChatFailure('timeout', stage);
  };
  const wait = (milliseconds: number) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); if (wake === done) wake = undefined; resolve(); };
    wake = done; timer = setTimeout(done, milliseconds);
  });
  const assertDocument = async () => {
    current();
    const [tab, frame] = await bounded(Promise.all([chrome.tabs.get(tabId!), chrome.webNavigation.getFrame({ tabId: tabId!, frameId: 0 })]));
    current();
    if (!originPage(tab.url) || tab.pendingUrl && !originPage(tab.pendingUrl) || !frame || frame.documentId !== documentId || !originPage(frame.url) || frame.errorOccurred) throw new WebChatFailure('interrupted', stage);
    if (!await bounded(chrome.permissions.contains({ origins: ORIGINS }))) throw new WebChatFailure('accessDenied', stage);
    current();
  };
  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.webNavigation.onCommitted.addListener(onCommitted);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    let tab = await bounded(proxyPage(false, signal)); current(); tabId = tab.id!;
    while (tab.status === 'loading' || tab.pendingUrl || !originPage(tab.url)) {
      await bounded(wait(100)); current(); tab = await bounded(chrome.tabs.get(tabId));
      if (!originPage(tab.url) && !originPage(tab.pendingUrl)) throw new WebChatFailure('interrupted', stage);
    }
    const frame = await bounded(chrome.webNavigation.getFrame({ tabId, frameId: 0 })); current();
    if (!frame?.documentId || !originPage(frame.url) || frame.errorOccurred) throw new WebChatFailure('network', stage);
    documentId = frame.documentId;
    let injected: chrome.scripting.InjectionResult<unknown>[];
    try { injected = await bounded(chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'MAIN', files: ['webchat-native-client.js'] })); }
    catch (error) { current(); if (error instanceof WebChatFailure) throw error; throw new WebChatFailure('pageUnsupported', 'client'); }
    if (injected.length !== 1 || injected[0].documentId !== documentId || injected[0].frameId !== 0) throw new WebChatFailure('interrupted', stage);
    await assertDocument();
    const started = await bounded(chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'MAIN', func: (value: WebChatPageCommand, version: string) => {
      const bridge = (window as unknown as { __readerNativeWebappBridgeV3?: { version: string; start(command: WebChatPageCommand): unknown } }).__readerNativeWebappBridgeV3;
      return bridge?.version === version ? bridge.start(value) : false;
    }, args: [command, NATIVE_WEBAPP_BRIDGE_VERSION] }));
    current();
    if (started.length !== 1 || started[0].documentId !== documentId || !started[0].result) throw new WebChatFailure('pageUnsupported', 'client');
    let lastText = '';
    while (true) {
      await bounded(wait(350)); await assertDocument();
      const output: chrome.scripting.InjectionResult<unknown>[] = await bounded(chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'MAIN', func: (id: string) => {
        const bridge = (window as unknown as { __readerNativeWebappBridgeV3?: { poll(id: string): unknown } }).__readerNativeWebappBridgeV3;
        return bridge?.poll(id);
      }, args: [command.id] }));
      current();
      if (output.length !== 1 || output[0].documentId !== documentId || output[0].frameId !== 0) throw new WebChatFailure('interrupted', stage);
      const event = eventValue(output[0].result, command.id);
      if (event.type === 'heartbeat') continue;
      if (event.type === 'error') throw new WebChatFailure(event.code, event.stage || stage, event.httpStatus);
      if (event.type === 'text') {
        if (command.type !== 'generate') throw new WebChatFailure('format', stage);
        if (event.text !== lastText) { onText?.(event.text); lastText = event.text; }
        continue;
      }
      if (command.type === 'status' ? event.type !== 'status' : event.type !== 'done') throw new WebChatFailure('format', stage);
      await assertDocument(); finished = true; return event;
    }
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof WebChatFailure) throw error;
    throw new WebChatFailure('network', stage);
  } finally {
    cancel(); clearTimeout(timer); clearTimeout(hardDeadline); wake = undefined;
    chrome.tabs.onRemoved.removeListener(onRemoved); chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.webNavigation.onCommitted.removeListener(onCommitted); signal.removeEventListener('abort', onAbort);
  }
}
