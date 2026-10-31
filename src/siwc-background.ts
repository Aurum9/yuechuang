import { SSEParser } from './core';
import type { CompletionMessage } from './model';
import type { SearchUpdate } from './chat-shared';
import { getChatConnectionView, saveChatConnectionConfig } from './chat-connection';
import { trustedPage } from './trusted-page';
import { SIWC_API_ORIGIN, SIWC_HOST, type SiwcDiagnostic, type SiwcStatus, type SiwcView } from './siwc-shared';
import { parseSiwcModels, record, SiwcFailure, SiwcStream, siwcHttpFailure, siwcRequestBody, SIWC_ERRORS } from './siwc-protocol';
import { sanitizeChatDetails } from './chat-details';

const empty = (): SiwcStatus => ({ state: 'unchecked', loggedIn: false, planAuthorized: false, models: [], generation: 'unchecked' });
let status = empty();
let initialized = false;
let revision = 0;
let onChange = () => {};
let access: { accessToken: string; expiresAt: number; accountId: string } | undefined;
let accessPending: Promise<typeof access> | undefined;
let accessController: AbortController | undefined;
let login: { controller: AbortController; port?: chrome.runtime.Port } | undefined;
let checking: Promise<SiwcView> | undefined;

const safeLabel = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
function nativeError(code: unknown): SiwcFailure {
  if (['signedOut', 'signed_out', 'reauthRequired', 'reauth_required', 'invalid_grant'].includes(String(code))) return new SiwcFailure('signedOut');
  if (['planDenied', 'plan_denied', 'plan_not_authorized', 'planNotAuthorized'].includes(String(code))) return new SiwcFailure('planDenied');
  if (code === 'loginTimeout') return new SiwcFailure('timeout');
  if (code === 'accessDenied') return new SiwcFailure('authDenied');
  if (['identityValidationFailed', 'accountMismatch', 'clientMismatch'].includes(String(code))) return new SiwcFailure('identity');
  return new SiwcFailure('helper');
}

/** Each call owns a short-lived host process. No credential is persisted here. */
function nativeCall(command: string, signal?: AbortSignal, bound?: (port: chrome.runtime.Port) => void, payload: { newAccount?: boolean } = {}): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port | undefined;
    let finished = false;
    const id = crypto.randomUUID();
    const timer = setTimeout(() => finish(new SiwcFailure('timeout')), command === 'login' ? 310_000 : command === 'status' ? 40_000 : 90_000);
    const abort = () => finish(new DOMException('Aborted', 'AbortError'));
    const finish = (error?: unknown, result?: unknown) => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { port?.disconnect(); } catch { /* Chrome may have closed the host. */ }
      error ? reject(error) : resolve(result);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      port = chrome.runtime.connectNative(SIWC_HOST); bound?.(port);
      port.onMessage.addListener((value: unknown) => {
        if (!record(value) || value.id !== id) return;
        if (value.ok === true && record(value.result)) finish(undefined, value.result);
        else finish(nativeError(record(value.error) ? value.error.code : undefined));
      });
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; finish(new SiwcFailure('helperMissing')); });
      port.postMessage({ ...payload, id, command });
    } catch { finish(new SiwcFailure('helperMissing')); }
  });
}
function helperStatus(value: unknown): SiwcStatus {
  if (!record(value) || !['signedOut', 'ready', 'planDenied', 'reauthRequired'].includes(String(value.state)) || !safeLabel(value.version, 40)) throw new SiwcFailure('helper');
  const account = record(value.account) ? value.account : undefined;
  if (account && (!safeLabel(account.id) || !safeLabel(account.label) || typeof account.planAuthorized !== 'boolean')) throw new SiwcFailure('helper');
  const loggedIn = !!account && (value.state === 'ready' || value.state === 'planDenied');
  if (value.state === 'ready' && (!loggedIn || account?.planAuthorized !== true)) throw new SiwcFailure('helper');
  return { state: value.state as SiwcStatus['state'], loggedIn, planAuthorized: loggedIn && account?.planAuthorized === true, helperVersion: value.version,
    ...(account ? { accountId: account.id as string, accountLabel: account.label as string } : {}), loginPending: value.loginPending === true,
    models: [], generation: 'unchecked', ...(typeof value.remoteRevocationConfirmed === 'boolean' ? { remoteRevoked: value.remoteRevocationConfirmed } : {}) };
}
export function clearSiwcAccessToken(): void {
  ++revision; access = undefined; accessController?.abort(); accessController = undefined; accessPending = undefined;
  if (login) { const previous = login; login = undefined; previous.controller.abort(); status = { ...status, loginPending: false }; }
}
function failureState(error: unknown): void {
  const known = error instanceof SiwcFailure ? error : new SiwcFailure('network');
  if (known.code === 'signedOut' || known.code === 'planDenied' || known.code === 'helperMissing') {
    access = undefined;
    status = { ...empty(), state: known.code === 'signedOut' ? 'reauthRequired' : known.code, error: known.message };
  } else status = { ...status, state: known.code === 'permission' ? 'permissionRequired' : 'error', error: known.message };
}
async function permissions(): Promise<void> {
  if (!await chrome.permissions.contains({ origins: [`${SIWC_API_ORIGIN}/*`] })) throw new SiwcFailure('permission');
}
async function token(signal?: AbortSignal): Promise<NonNullable<typeof access>> {
  signal?.throwIfAborted();
  if (!status.loggedIn || !status.planAuthorized || !status.accountId) throw new SiwcFailure('signedOut');
  if (access && access.accountId === status.accountId && access.expiresAt > Date.now() + 60_000) return access;
  const before = revision;
  const accountId = status.accountId;
  if (!accessPending) {
    const controller = new AbortController(); accessController = controller;
    const pending = nativeCall('getAccessToken', controller.signal).then(value => {
      if (!record(value) || typeof value.accessToken !== 'string' || !/^[\x21-\x7e]{16,32000}$/.test(value.accessToken) || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() + 5_000 || value.accountId !== accountId) throw new SiwcFailure('helper');
      if (before !== revision) throw new DOMException('Aborted', 'AbortError');
      return access = { accessToken: value.accessToken, expiresAt: value.expiresAt, accountId };
    });
    accessPending = pending;
    void pending.finally(() => { if (accessPending === pending) { accessPending = undefined; accessController = undefined; } }).catch(() => {});
  }
  const owner = accessController;
  const abort = () => owner?.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const value = await accessPending;
    signal?.throwIfAborted();
    if (before !== revision || !value) throw new DOMException('Aborted', 'AbortError');
    return value;
  } finally { signal?.removeEventListener('abort', abort); }
}
async function models(): Promise<SiwcStatus['models']> {
  await permissions();
  const credential = await token();
  const response = await fetch(`${SIWC_API_ORIGIN}/v1/models`, { headers: { Authorization: `Bearer ${credential.accessToken}` }, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw siwcHttpFailure(response.status);
  const text = await response.text();
  if (text.length > 1_000_000) throw new SiwcFailure('format');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new SiwcFailure('format'); }
  return parseSiwcModels(value);
}
export async function getSiwcView(): Promise<SiwcView> { return { config: (await getChatConnectionView()).config, status: structuredClone(status) }; }
export async function refreshSiwc(notify = true): Promise<SiwcView> {
  if (checking) return checking;
  clearSiwcAccessToken(); if (notify) onChange();
  const before = revision;
  checking = (async () => {
    try {
      const next = helperStatus(await nativeCall('status'));
      if (before !== revision) return getSiwcView();
      status = next;
      if (next.planAuthorized) {
        const catalog = await models();
        if (before === revision) status = { ...next, models: catalog };
      }
    } catch (error) { if (before === revision) failureState(error); }
    return getSiwcView();
  })();
  try { return await checking; } finally { checking = undefined; }
}
export async function ensureSiwcReady(): Promise<SiwcView> {
  // Passive panel recovery must not replace or cancel an in-progress login.
  if (login || status.loginPending) return getSiwcView();
  return checking ?? (status.state === 'unchecked' ? refreshSiwc(false) : getSiwcView());
}
async function loginSiwc(newAccount = false): Promise<SiwcView> {
  if (login) throw new SiwcFailure('helper');
  await permissions();
  clearSiwcAccessToken(); onChange();
  const before = revision;
  const owner = { controller: new AbortController(), port: undefined as chrome.runtime.Port | undefined }; login = owner;
  status = { ...empty(), loginPending: true };
  try {
    const next = helperStatus(await nativeCall('login', owner.controller.signal, port => { owner.port = port; }, newAccount ? { newAccount: true } : {}));
    if (before === revision) {
      status = next;
      if (next.planAuthorized) {
        const catalog = await models();
        if (before === revision) status = { ...next, models: catalog };
      }
    }
  } catch (error) {
    if (before === revision && !owner.controller.signal.aborted) failureState(error);
    if (owner.controller.signal.aborted && before === revision) status = empty();
  } finally { if (login === owner) login = undefined; if (before === revision) status.loginPending = false; }
  return getSiwcView();
}
function cancelLogin(): void {
  const active = login;
  if (!active) return;
  try { active.port?.postMessage({ id: crypto.randomUUID(), command: 'cancelLogin' }); } catch { /* Disconnect also cancels the owned authorization. */ }
  active.controller.abort(); clearSiwcAccessToken(); status = empty(); onChange();
}
async function logoutSiwc(): Promise<SiwcView> {
  cancelLogin(); clearSiwcAccessToken(); onChange();
  const before = revision;
  try {
    const next = helperStatus(await nativeCall('logout'));
    if (before === revision) status = next;
  } catch (error) { if (before === revision) failureState(error); throw error instanceof SiwcFailure ? error : new SiwcFailure('helper'); }
  return getSiwcView();
}
/** Read only a bounded error shape, never expose provider prose or raw bodies. */
async function errorShape(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      const decoder = new TextDecoder(); let text = '', bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) { text += decoder.decode(); break; }
        bytes += chunk.value.byteLength;
        if (bytes > 16_384) return;
        text += decoder.decode(chunk.value, { stream: true });
      }
      try { return JSON.parse(text) as unknown; } catch { return; }
    };
    return await Promise.race([read(), new Promise<undefined>(resolve => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); resolve(undefined); }, 2000); })]);
  } catch { return; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

export async function requestSiwc(messages: CompletionMessage[], signal: AbortSignal, onText: (text: string) => void, onUpdate?: (update: SearchUpdate) => void): Promise<string> {
  signal.throwIfAborted();
  const view = await ensureSiwcReady();
  signal.throwIfAborted();
  if (view.config.provider !== 'chatgptOAuth' || view.status.state !== 'ready' || !view.status.models.some(item => item.id === view.config.model)) throw new SiwcFailure(view.status.planAuthorized ? 'model' : 'signedOut');
  await permissions();
  const before = revision;
  let diagnostic: SiwcDiagnostic = { stage: 'preflight' };
  const owner = new AbortController();
  const combined = AbortSignal.any([signal, owner.signal]);
  let timedOut = false;
  const expire = () => { timedOut = true; owner.abort(); };
  const total = setTimeout(expire, 120_000);
  let idle: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let requestStartedAt: number | undefined;
  let firstTokenSeen = false;
  const elapsed = () => requestStartedAt === undefined ? undefined : Math.round(performance.now() - requestStartedAt);
  const stream = new SiwcStream(text => {
    if (!firstTokenSeen && text.trim() && requestStartedAt !== undefined) {
      firstTokenSeen = true;
      const details = sanitizeChatDetails({ firstTokenMs: elapsed() });
      if (details) onUpdate?.({ details });
    }
    onText(text);
  }, onUpdate);
  try {
    const body = siwcRequestBody(view.config.model, messages);
    diagnostic.stage = 'helper';
    const credential = await token(combined);
    combined.throwIfAborted();
    diagnostic.stage = 'headers';
    idle = setTimeout(expire, 25_000);
    requestStartedAt = performance.now();
    const response = await fetch(`${SIWC_API_ORIGIN}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${credential.accessToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: combined });
    clearTimeout(idle);
    diagnostic.httpStatus = response.status;
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    diagnostic.contentType = !mime ? 'missing' : mime === 'text/event-stream' || mime === 'application/json' || mime === 'text/html' ? mime : 'other';
    if (!response.ok) throw siwcHttpFailure(response.status, await errorShape(response));
    // A real SIWC response can arrive without a visible Content-Type header.
    // In that case the existing SSE and Responses completion checks validate
    // the body; an explicit incompatible MIME type still stops the request.
    if (!response.body || !['text/event-stream', 'missing'].includes(diagnostic.contentType)) throw new SiwcFailure('format', 'nonEventStream');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser(data => {
      try { stream.accept(data); }
      finally { if (stream.lastDiagnostic) diagnostic = { ...diagnostic, ...stream.lastDiagnostic }; }
    });
    let size = 0;
    while (!stream.completed) {
      clearTimeout(idle); idle = setTimeout(expire, 60_000);
      const chunk = await reader.read();
      combined.throwIfAborted();
      if (before !== revision) throw new DOMException('Aborted', 'AbortError');
      if (chunk.done) { parser.push(decoder.decode(), true); break; }
      size += chunk.value.byteLength;
      if (size > 8_000_000) throw new SiwcFailure('format', 'streamTooLarge');
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
    diagnostic.stage = 'completion';
    const result = stream.finish();
    status = { ...status, generation: 'working' }; delete status.error; delete status.diagnostic;
    return result;
  } catch (error) {
    if (signal.aborted || before !== revision) throw new DOMException('Aborted', 'AbortError');
    const failure = timedOut ? new SiwcFailure('timeout') : error instanceof SiwcFailure ? error : new SiwcFailure('network');
    if (failure.code === 'signedOut') failureState(failure);
    status = { ...status, generation: 'blocked', error: failure.message, diagnostic: { ...diagnostic, reason: timedOut ? 'timeout' : failure.reason || 'unknown' } };
    throw failure;
  } finally {
    clearTimeout(total); clearTimeout(idle);
    if (requestStartedAt !== undefined && !signal.aborted && before === revision) {
      const details = sanitizeChatDetails({ durationMs: elapsed() });
      // Timing is best effort cleanup; a stale consumer must never replace
      // the original model failure or revive an already cancelled chat job.
      if (details) try { onUpdate?.({ details }); } catch { /* Preserve the request outcome. */ }
    }
    owner.abort(); await reader?.cancel().catch(() => {});
  }
}
function trusted(sender: chrome.runtime.MessageSender): boolean { return trustedPage(sender, 'options.html') || trustedPage(sender, 'sidepanel.html'); }
export function initializeSiwc(options: { onConfigChange?: () => void } = {}): void {
  if (options.onConfigChange) onChange = options.onConfigChange;
  if (initialized) return; initialized = true;
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (!record(message) || typeof message.type !== 'string' || !message.type.startsWith('siwc:')) return;
    if (!trusted(sender)) { respond({ ok: false, error: '仅设置页和侧边栏可操作 ChatGPT 官方登录。' }); return; }
    const run = async () => {
      switch (message.type) {
        case 'siwc:get': return getSiwcView();
        case 'siwc:refresh': return refreshSiwc();
        case 'siwc:login': return loginSiwc(message.newAccount === true);
        case 'siwc:cancel': cancelLogin(); return getSiwcView();
        case 'siwc:logout': return logoutSiwc();
        case 'siwc:save': {
          const config = message.config;
          if (!record(config) || config.provider !== 'chatgptOAuth' || typeof config.model !== 'string' || config.model !== '' && !status.models.some(item => item.id === config.model)) throw new SiwcFailure('model');
          await saveChatConnectionConfig({ provider: 'chatgptOAuth', model: config.model });
          return getSiwcView();
        }
        default: throw new SiwcFailure('helper');
      }
    };
    void run().then(view => respond({ ok: true, view })).catch(error => respond({ ok: false, error: error instanceof SiwcFailure ? error.message : SIWC_ERRORS.helper }));
    return true;
  });
}
