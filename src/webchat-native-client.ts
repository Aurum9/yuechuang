import { SSEParser } from './core';
import { knownWebFailure, pageCommand, parseWebModels, validWebId, webHttpFailure, WebChatFailure } from './webchat-protocol';
import { WebChatStreamV2 } from './webchat-stream-v2';
import { discoverNativeRuntimeUrl } from './webchat-runtime-discovery';
import { NATIVE_WEBAPP_BRIDGE_VERSION } from './webchat-native-version';
import { WEBCHAT_ORIGIN, type WebChatErrorCode, type WebChatFailureInfo, type WebChatPageCommand, type WebChatPageEvent } from './webchat-shared';

type Command = Exclude<WebChatPageCommand, { type: 'cancel' }>;
type Generate = Extract<Command, { type: 'generate' }>;
type ObjectValue = Record<string, unknown>;
type RequestOptions = {
  requestBody?: unknown;
  additionalHeaders?: Record<string, string>;
  signal: AbortSignal;
  retry: 'never';
  cache: 'no-store';
  expectedIdentity: { accountId: string; userId: string };
};
export interface NativeWebappRuntime {
  request: {
    safeGet(path: '/models', options: RequestOptions): Promise<unknown>;
    safePost(path: '/sentinel/chat-requirements/prepare', options: RequestOptions): Promise<unknown>;
    postResponse(path: '/f/conversation', options: RequestOptions): Promise<Response>;
  };
  integrity: { f(callback: (key: string) => Promise<unknown>): Promise<unknown> };
}
export interface NativeWebappBridge {
  readonly version: typeof NATIVE_WEBAPP_BRIDGE_VERSION;
  start(command: unknown): boolean;
  poll(id: string): WebChatPageEvent;
  cancel(id: string): void;
}
export interface NativeWebappDependencies {
  loadRuntime(): Promise<NativeWebappRuntime>;
  fetchSession(url: string, init: RequestInit): Promise<Response>;
  uuid(): string;
  timezone(): string;
  timezoneOffset(): number;
  now?(): number;
  watchLifecycle?(listener: (reason: 'pageChanged' | 'signedOut') => void): void;
}
type Session = { identity: string; userId: string; accountId: string; accountLabel?: string; token?: string };
type Task = {
  command: Command;
  controller: AbortController;
  event?: WebChatPageEvent;
  totalTimer: ReturnType<typeof setTimeout>;
};
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const LIMIT = 4 * 1024 * 1024;
const TERMINAL_MS = 30_000;
const HEADER_NAMES = new Set([
  'OpenAI-Sentinel-Chat-Requirements-Prepare-Token', 'OpenAI-Sentinel-Chat-Requirements-Token',
  'OpenAI-Sentinel-Proof-Token', 'OpenAI-Sentinel-Token', 'OpenAI-Sentinel-Turnstile-Token', 'OAI-Telemetry'
]);

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function statusNumber(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599 ? value as number : undefined;
}
function classify(error: unknown, stage: WebChatFailureInfo['stage'], signal?: AbortSignal): WebChatFailure {
  if (signal?.aborted) return signal.reason instanceof WebChatFailure ? signal.reason : new WebChatFailure('interrupted', stage);
  if (error instanceof WebChatFailure) return error;
  const status = object(error) ? statusNumber(error.status) ?? statusNumber(error.responseStatus) : undefined;
  const code = object(error) ? error.errorCode ?? error.code : undefined;
  let failure: WebChatErrorCode | undefined;
  if (code === 'force_login' || code === 'account_mismatch' || code === 'identity_changed' || code === 'account_changed') failure = 'signedOut';
  else if (['captcha_required', 'challenge_required', 'verification_required', 'interaction_required', 'turnstile_required'].includes(String(code))) failure = 'verificationRequired';
  else failure = knownWebFailure({ code });
  return new WebChatFailure(failure ?? (status ? webHttpFailure(status) : 'network'), stage, status);
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<ObjectValue> {
  if (!response.ok) throw new WebChatFailure(webHttpFailure(response.status), 'session', response.status);
  if (!response.headers.get('content-type')?.includes('application/json') || !response.body) throw new WebChatFailure('format', 'session', response.status);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ''; let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      bytes += next.value?.byteLength ?? 0;
      if (bytes > 256_000) throw new WebChatFailure('format', 'session', response.status);
      text += decoder.decode(next.value, { stream: !next.done });
      if (next.done) break;
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new WebChatFailure('format', 'session', response.status); }
    if (!object(value)) throw new WebChatFailure('format', 'session', response.status);
    return value;
  } finally { await reader.cancel().catch(() => {}); }
}

const identityId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 500 && !/[\u0000-\u001f\u007f]/.test(value);
/** Decode only identity fields from the already returned session token, in this page closure. */
function sessionClaims(token?: string): { accountId?: string; userId?: string } {
  if (!token) return {};
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return {};
    const payload: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))));
    const claims = object(payload) && object(payload['https://api.openai.com/auth']) ? payload['https://api.openai.com/auth'] : undefined;
    if (!claims) return {};
    const accountId = claims.chatgpt_account_id ?? claims.account_id;
    const userId = claims.user_id ?? claims.chatgpt_user_id;
    return { ...(identityId(accountId) ? { accountId } : {}), ...(identityId(userId) ? { userId } : {}) };
  } catch { return {}; }
}

/**
 * MAIN-world adapter for the currently loaded official client. No DOM editing,
 * credential bridge, arbitrary URL proxy, challenge implementation or retries.
 * Dependencies are injectable for offline tests; the installed bridge uses the
 * fixed same-origin runtime and session URL below.
 */
export function createNativeWebappBridge(deps: NativeWebappDependencies): NativeWebappBridge {
  let active: Task | undefined;
  let verifiedIdentity: string | undefined;
  let verifiedModels = new Set<string>();
  let ownedConversation: { id: string; parentId: string } | undefined;
  const terminal = new Map<string, { event: WebChatPageEvent; expires: number }>();
  const now = deps.now ?? Date.now;
  deps.watchLifecycle?.(reason => {
    verifiedIdentity = undefined; verifiedModels.clear(); ownedConversation = undefined;
    active?.controller.abort(new WebChatFailure(reason, reason === 'signedOut' ? 'session' : 'conversation'));
  });
  const sweep = () => {
    for (const [id, result] of terminal) if (result.expires <= now()) terminal.delete(id);
    while (terminal.size > 8) terminal.delete(terminal.keys().next().value!);
  };
  const remember = (event: WebChatPageEvent) => { terminal.set(event.id, { event, expires: now() + TERMINAL_MS }); sweep(); };
  async function session(signal: AbortSignal): Promise<Session> {
    let value: ObjectValue;
    try {
      value = await boundedJson(await deps.fetchSession(WEBCHAT_ORIGIN + '/api/auth/session', {
        method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', signal,
        headers: { Accept: 'application/json' }
      }), signal);
    } catch (error) { throw classify(error, 'session', signal); }
    const user = object(value.user) ? value.user : undefined;
    const userId = user?.id;
    if (!identityId(userId)) throw new WebChatFailure('signedOut', 'session');
    const account = object(value.account) ? value.account : undefined;
    const sessionAccountId = identityId(account?.id) ? account.id : undefined;
    const label = user?.email ?? user?.name;
    const token = typeof value.accessToken === 'string' && value.accessToken.length > 0 && value.accessToken.length <= 32_000 ? value.accessToken : undefined;
    const claims = sessionClaims(token);
    if (claims.userId && claims.userId !== userId || sessionAccountId && claims.accountId && sessionAccountId !== claims.accountId) throw new WebChatFailure('signedOut', 'session');
    const accountId = sessionAccountId ?? claims.accountId;
    // The normal client may hold an auth cache independent of cookie session.
    // Never submit local text unless its actual request is bound to both IDs.
    if (!accountId) throw new WebChatFailure('signedOut', 'session');
    const accountLabel = typeof label === 'string' ? label.slice(0, 160) : undefined;
    // Only minimal identity claims and accidental reflected output use this
    // token. It never authenticates a request or leaves this page closure.
    return { userId, accountId, identity: JSON.stringify([userId, accountId]), accountLabel, token };
  }
  const clean = (text: string, current: Session) => current.token ? text.split(current.token).join('[已隐藏登录凭据]') : text;
  const assertBound = (current: Session) => {
    if (!verifiedIdentity || verifiedIdentity !== current.identity) {
      verifiedIdentity = undefined; verifiedModels.clear(); ownedConversation = undefined;
      throw new WebChatFailure('signedOut', 'session');
    }
  };
  function options(signal: AbortSignal, current: Session): RequestOptions {
    return { signal, retry: 'never', cache: 'no-store', expectedIdentity: { accountId: current.accountId, userId: current.userId } };
  }
  function body(command: Generate) {
    // A new remote thread receives local history as quoted user context, rather
    // than claiming those local assistant messages were authored by ChatGPT.
    const last = command.messages.at(-1)!;
    const labels = { system: '本地助手说明', user: '用户消息', assistant: '本地历史回答' };
    const content = command.conversation || command.messages.length === 1 ? last.content :
      `以下内容由本地侧栏提供，包含已有对话上下文。请参考这些内容，回答最后一条用户消息。\n\n${command.messages.map(message => `【${labels[message.role]}】\n${message.content}`).join('\n\n')}`;
    if (content.length > 200_000) throw new WebChatFailure('format', 'conversation');
    const messages = [{ id: deps.uuid(), author: { role: 'user' }, content: { content_type: 'text', parts: [content] } }];
    const userMessageId = messages.at(-1)?.id;
    if (!validWebId(userMessageId)) throw new WebChatFailure('format', 'conversation');
    const timezone = deps.timezone(); const offset = deps.timezoneOffset();
    if (typeof timezone !== 'string' || !timezone || timezone.length > 100 || !Number.isFinite(offset) || Math.abs(offset) > 24 * 60) throw new WebChatFailure('format', 'conversation');
    return {
      userMessageId,
      value: {
        action: 'next', messages, model: command.model,
        parent_message_id: command.conversation?.parentId ?? deps.uuid(),
        ...(command.conversation ? { conversation_id: command.conversation.id } : {}),
        timezone, timezone_offset_min: offset, is_do_not_remember: false,
        supported_encodings: ['v1'], local_function_names: [], client_prepare_state: 'none'
      }
    };
  }
  async function perform(task: Task): Promise<WebChatPageEvent> {
    const command = task.command; const signal = task.controller.signal;
    const current = await session(signal);
    if (command.type === 'generate') assertBound(current);
    let runtime: NativeWebappRuntime;
    try { runtime = await deps.loadRuntime(); }
    catch { throw new WebChatFailure('pageUnsupported', 'client'); }
    signal.throwIfAborted();
    if (command.type === 'status') {
      let models;
      try { models = parseWebModels(await runtime.request.safeGet('/models', options(signal, current))); }
      catch (error) { throw classify(error, 'models', signal); }
      const latest = await session(signal);
      if (latest.identity !== current.identity) throw new WebChatFailure('signedOut', 'session');
      if (verifiedIdentity !== current.identity) ownedConversation = undefined;
      verifiedIdentity = current.identity;
      models = models.map(model => ({ id: model.id, label: clean(model.label, current) }));
      verifiedModels = new Set(models.map(model => model.id));
      return { type: 'status', id: command.id, status: {
        transport: 'webapp', state: 'ready', loggedIn: true, models,
        ...(current.accountLabel ? { accountLabel: clean(current.accountLabel, current) } : {})
      } };
    }
    if (!verifiedModels.has(command.model)) throw new WebChatFailure('model', 'models');
    if (command.conversation && (!ownedConversation || ownedConversation.id !== command.conversation.id || ownedConversation.parentId !== command.conversation.parentId)) throw new WebChatFailure('pageChanged', 'conversation');
    ownedConversation = undefined;
    const requestBody = body(command);
    const requestOptions = options(signal, current);
    let integrity: unknown;
    try {
      integrity = await runtime.integrity.f(key => {
        signal.throwIfAborted(); assertBound(current);
        if (typeof key !== 'string' || !key || key.length > 256_000) throw new WebChatFailure('format', 'requirements');
        return runtime.request.safePost('/sentinel/chat-requirements/prepare', {
          ...requestOptions, requestBody: { p: key },
          additionalHeaders: { 'X-OpenAI-Expected-Account-Id': current.accountId }
        });
      });
    } catch (error) { throw classify(error, 'requirements', signal); }
    signal.throwIfAborted(); assertBound(current);
    if (!object(integrity) || !object(integrity.chatRequirements) || !object(integrity.headers)) throw new WebChatFailure('format', 'conversation');
    if (integrity.chatRequirements.force_login === true) throw new WebChatFailure('signedOut', 'session');
    const headers: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(integrity.headers)) {
      if (!HEADER_NAMES.has(name) || typeof value !== 'string' || !value || value.length > 256_000) throw new WebChatFailure('format', 'conversation');
      headers[name] = value;
    }
    if (!headers['OpenAI-Sentinel-Chat-Requirements-Token'] && !headers['OpenAI-Sentinel-Chat-Requirements-Prepare-Token']) throw new WebChatFailure('verificationRequired', 'conversation');
    const latest = await session(signal); assertBound(latest);
    let response: Response;
    try {
      response = await runtime.request.postResponse('/f/conversation', {
        ...requestOptions, additionalHeaders: headers, requestBody: requestBody.value
      });
    } catch (error) { throw classify(error, 'conversation', signal); }
    if (!response.ok) throw new WebChatFailure(webHttpFailure(response.status), 'conversation', response.status);
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new WebChatFailure('format', 'conversation', response.status);
    const cleanAnswer = (text: string) => {
      let result = clean(clean(text, current), latest);
      for (const [name, value] of Object.entries(headers)) if (name.startsWith('OpenAI-Sentinel-')) result = result.split(value).join('[已隐藏请求凭据]');
      return result;
    };
    const stream = new WebChatStreamV2(text => { task.event = { type: 'text', id: command.id, text: cleanAnswer(text) }; }, {
      conversationId: command.conversation?.id, previousAssistantId: command.conversation?.parentId, userMessageId: requestBody.userMessageId
    });
    const parser = new SSEParser(data => stream.accept(data));
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let wire = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => task.controller.abort(new WebChatFailure('timeout', 'conversation')), 60_000); };
    const abortRead = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abortRead, { once: true });
    try {
      resetIdle();
      for (;;) {
        signal.throwIfAborted();
        const next = await reader.read(); signal.throwIfAborted();
        wire += next.value?.byteLength ?? 0;
        if (wire > LIMIT) throw new WebChatFailure('format', 'conversation', response.status);
        if (next.value?.byteLength) resetIdle();
        parser.push(decoder.decode(next.value, { stream: !next.done }), next.done);
        if (next.done || stream.done) break;
      }
      const result = stream.finish();
      const finalSession = await session(signal); assertBound(finalSession);
      ownedConversation = result.conversation;
      return { type: 'done', id: command.id, text: clean(cleanAnswer(result.text), finalSession), conversation: result.conversation };
    } finally {
      clearTimeout(idle); signal.removeEventListener('abort', abortRead); await reader.cancel().catch(() => {});
    }
  }
  const bridge: NativeWebappBridge = {
    version: NATIVE_WEBAPP_BRIDGE_VERSION,
    start(raw) {
      sweep();
      const command = pageCommand(raw);
      if (!command) return false;
      if (command.type === 'cancel') { bridge.cancel(command.id); return true; }
      if (active || terminal.has(command.id)) {
        if (active?.command.id !== command.id && !terminal.has(command.id)) remember({ type: 'error', id: command.id, code: 'pageBusy', stage: command.type === 'status' ? 'models' : 'conversation' });
        return active?.command.id === command.id || terminal.has(command.id);
      }
      const controller = new AbortController();
      const task: Task = {
        command, controller,
        totalTimer: setTimeout(() => controller.abort(new WebChatFailure('timeout', command.type === 'status' ? 'session' : 'conversation')), command.type === 'status' ? 20_000 : 120_000)
      };
      active = task;
      void abortable(perform(task), controller.signal).then(event => {
        if (controller.signal.aborted) throw classify(undefined, command.type === 'status' ? 'session' : 'conversation', controller.signal);
        remember(event);
      }).catch(error => {
        const failure = classify(error, command.type === 'status' ? 'models' : 'conversation', controller.signal);
        if (command.type === 'status' || failure.code === 'signedOut') { verifiedIdentity = undefined; verifiedModels.clear(); }
        ownedConversation = undefined;
        remember({ type: 'error', id: command.id, code: failure.code, stage: failure.stage, ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}) });
      }).finally(() => { clearTimeout(task.totalTimer); if (active === task) active = undefined; });
      return true;
    },
    poll(id) {
      sweep();
      const done = terminal.get(id); if (done) return done.event;
      if (active?.command.id === id) {
        const event = active.event; active.event = undefined;
        return event ?? { type: 'heartbeat', id };
      }
      return { type: 'error', id, code: 'interrupted', stage: 'conversation' };
    },
    cancel(id) { if (active?.command.id === id) { ownedConversation = undefined; active.controller.abort(new WebChatFailure('interrupted', 'conversation')); } }
  };
  return bridge;
}

async function officialRuntime(): Promise<NativeWebappRuntime> {
  const manifest = (window as unknown as { __reactRouterManifest?: unknown }).__reactRouterManifest;
  const entry = object(manifest) && object(manifest.entry) ? manifest.entry : undefined;
  const runtimeUrl = discoverNativeRuntimeUrl({
    pageUrl: location.href,
    documentResources: (function* () {
      for (const element of document.querySelectorAll('script[src],link[rel~="modulepreload"][href]')) {
        yield element.getAttribute(element.tagName.toLowerCase() === 'script' ? 'src' : 'href');
      }
    })(),
    manifestImports: entry?.imports,
    performanceResources: performance.getEntriesByType('resource')
  });
  if (!runtimeUrl) throw new WebChatFailure('pageUnsupported', 'session');
  try {
    const runtime: unknown = await import(/* @vite-ignore */ runtimeUrl);
    if (!object(runtime) || typeof runtime.__webpack_require__ !== 'function') throw new WebChatFailure('pageUnsupported', 'session');
    const requireModule = runtime.__webpack_require__ as (name: string) => unknown;
    const transport = requireModule('Kwur'); const integrity = requireModule('lXEa');
    if (!object(transport) || !object(transport.Request) || !object(integrity) || typeof integrity.f !== 'function' ||
      ['safeGet', 'safePost', 'postResponse'].some(name => typeof (transport.Request as ObjectValue)[name] !== 'function')) throw new WebChatFailure('pageUnsupported', 'session');
    return { request: transport.Request as unknown as NativeWebappRuntime['request'], integrity: integrity as unknown as NativeWebappRuntime['integrity'] };
  } catch (error) {
    if (error instanceof WebChatFailure) throw error;
    throw new WebChatFailure('pageUnsupported', 'session');
  }
}

declare global { interface Window { __readerNativeWebappBridgeV3?: NativeWebappBridge } }
/** The versioned property leaves older non-configurable bridges and user drafts intact. */
export function installNativeWebappBridge(target: Pick<Window, '__readerNativeWebappBridgeV3'>, deps: NativeWebappDependencies): NativeWebappBridge {
  const existing = target.__readerNativeWebappBridgeV3;
  if (existing) {
    if (existing.version !== NATIVE_WEBAPP_BRIDGE_VERSION) throw new WebChatFailure('pageUnsupported', 'client');
    return existing;
  }
  const bridge = createNativeWebappBridge(deps);
  Object.defineProperty(target, '__readerNativeWebappBridgeV3', { value: bridge, enumerable: false, configurable: false, writable: false });
  return bridge;
}
if (typeof window !== 'undefined' && location.origin === WEBCHAT_ORIGIN && window === window.top) {
  installNativeWebappBridge(window, {
    loadRuntime: officialRuntime, fetchSession: (url, init) => fetch(url, init), uuid: () => crypto.randomUUID(),
    timezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone, timezoneOffset: () => new Date().getTimezoneOffset(),
    watchLifecycle: listener => {
      window.addEventListener('pagehide', () => listener('pageChanged'), { once: true });
      window.addEventListener('codex-browser-auth-context-changed', () => listener('signedOut'));
    }
  });
}
