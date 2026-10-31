import { SSEParser } from './core';
import { knownWebFailure, pageCommand, parseWebModels, webConversationBody, webHttpFailure, WebChatFailure, WebChatStream } from './webchat-protocol';
import { WEBCHAT_ORIGIN, WEBCHAT_PORT, type WebChatFailureInfo, type WebChatPageCommand, type WebChatPageEvent } from './webchat-shared';

// Runs in Chrome's isolated extension world. No DOM or window message bridge is installed.
const scope = globalThis as typeof globalThis & { __readerWebChatInstalled?: boolean };
if (location.origin === WEBCHAT_ORIGIN && window === window.top && !scope.__readerWebChatInstalled) {
  scope.__readerWebChatInstalled = true;
  let verifiedIdentity: string | undefined;
  const active = new Set<AbortController>();
  window.addEventListener('pagehide', () => { for (const controller of active) controller.abort(); }, { once: true });
  async function fetchWeb(path: '/api/auth/session' | '/backend-api/models' | '/backend-api/conversation', signal: AbortSignal, token?: string, body?: unknown) {
    const stage = path === '/api/auth/session' ? 'session' : path === '/backend-api/models' ? 'models' : 'conversation';
    try {
      const response = await fetch(WEBCHAT_ORIGIN + path, {
      method: body ? 'POST' : 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: body ? 'text/event-stream' : 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (!response.ok) {
        let code = webHttpFailure(response.status);
        if (response.headers.get('content-type')?.includes('application/json')) {
          const data = await readJson(response, stage, 16_000).catch(() => undefined);
          code = knownWebFailure(data) ?? code;
        }
        throw new WebChatFailure(code, stage, response.status);
      }
      return response;
    } catch (error) {
      if (!signal.aborted && error instanceof WebChatFailure) throw error;
      const code = signal.aborted ? signal.reason instanceof WebChatFailure ? signal.reason.code : 'interrupted' : 'network';
      throw new WebChatFailure(code, stage);
    }
  }
  async function readJson(response: Response, stage: WebChatFailureInfo['stage'], limit = 256_000): Promise<Record<string, unknown>> {
    if (!response.headers.get('content-type')?.includes('application/json') || !response.body) throw new WebChatFailure('format', stage, response.status);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = '';
    try {
      while (true) {
        const item = await reader.read();
        text += decoder.decode(item.value, { stream: !item.done });
        if (text.length > limit) throw new WebChatFailure('format', stage, response.status);
        if (item.done) break;
      }
    } catch (error) {
      if (error instanceof WebChatFailure) throw error;
      throw new WebChatFailure('network', stage, response.status);
    } finally { await reader.cancel().catch(() => {}); }
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new WebChatFailure('format', stage, response.status); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WebChatFailure('format', stage, response.status);
    return value as Record<string, unknown>;
  }
  async function session(signal: AbortSignal) {
    const value = await readJson(await fetchWeb('/api/auth/session', signal), 'session');
    if (typeof value.accessToken !== 'string' || !value.accessToken.trim() || value.accessToken.length > 32_000) throw new WebChatFailure('signedOut', 'session');
    const user = value.user && typeof value.user === 'object' ? value.user as Record<string, unknown> : undefined;
    const label = user?.email ?? user?.name;
    const identity = user?.id ?? user?.email ?? user?.name;
    if (typeof identity !== 'string' || !identity || identity.length > 500) throw new WebChatFailure('signedOut', 'session');
    return { token: value.accessToken, identity, accountLabel: typeof label === 'string' ? label.slice(0, 160) : undefined };
  }
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== WEBCHAT_PORT) return;
    if (port.sender && (port.sender.id !== chrome.runtime.id || port.sender.tab || (port.sender.url && !port.sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)))) { port.disconnect(); return; }
    let task: { id: string; controller: AbortController } | undefined;
    let connected = true;
    const send = (event: WebChatPageEvent) => { if (connected) try { port.postMessage(event); } catch {} };
    port.onDisconnect.addListener(() => { connected = false; task?.controller.abort(); });
    port.onMessage.addListener((raw: unknown) => {
      const command = pageCommand(raw);
      if (!command) return;
      if (command.type === 'cancel') { if (task?.id === command.id) task.controller.abort(); return; }
      if (task) { send({ type: 'error', id: command.id, code: 'interrupted' }); return; }
      const controller = new AbortController(); task = { id: command.id, controller }; active.add(controller);
      const timeout = setTimeout(() => controller.abort(new WebChatFailure('timeout')), command.type === 'status' ? 20_000 : 120_000);
      void perform(command, controller, send).catch(error => {
        const code = controller.signal.reason instanceof WebChatFailure ? controller.signal.reason.code : controller.signal.aborted ? 'interrupted' : error instanceof WebChatFailure ? error.code : 'network';
        const stage = error instanceof WebChatFailure && error.stage ? error.stage : command.type === 'status' ? 'models' : 'conversation';
        const httpStatus = error instanceof WebChatFailure ? error.httpStatus : undefined;
        if (command.type === 'status') {
          verifiedIdentity = undefined;
        }
        send({ type: 'error', id: command.id, code, stage, ...(httpStatus !== undefined ? { httpStatus } : {}) });
      }).finally(() => { clearTimeout(timeout); active.delete(controller); if (task?.controller === controller) task = undefined; });
    });
  });
  async function perform(command: Exclude<WebChatPageCommand, { type: 'cancel' }>, controller: AbortController, send: (event: WebChatPageEvent) => void) {
    // Session credentials never leave this closure and are never written to extension storage.
    const { token, identity, accountLabel } = await session(controller.signal);
    if (command.type === 'status') {
      const response = await fetchWeb('/backend-api/models', controller.signal, token);
      let models;
      try { models = parseWebModels(await readJson(response, 'models')); }
      catch (error) {
        if (error instanceof WebChatFailure) throw new WebChatFailure(error.code, 'models', response.status);
        throw error;
      }
      verifiedIdentity = identity;
      send({ type: 'status', id: command.id, status: { state: 'ready', loggedIn: true, ...(accountLabel ? { accountLabel } : {}), models } });
      return;
    }
    if (!verifiedIdentity || verifiedIdentity !== identity) { verifiedIdentity = undefined; throw new WebChatFailure('signedOut', 'session'); }
    const response = await fetchWeb('/backend-api/conversation', controller.signal, token, webConversationBody(command, () => crypto.randomUUID()));
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new WebChatFailure('format', 'conversation', response.status);
    const clean = (text: string) => text.split(token).join('[已隐藏登录凭据]');
    const stream = new WebChatStream(text => send({ type: 'text', id: command.id, text: clean(text) }));
    const parser = new SSEParser(data => stream.accept(data));
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(new WebChatFailure('timeout')), 60_000); };
    try {
      resetIdle();
      while (true) {
        const item = await reader.read();
        if (controller.signal.aborted) throw new WebChatFailure('interrupted');
        if (item.value) { bytes += item.value.length; if (bytes > 4_000_000) throw new WebChatFailure('format'); resetIdle(); }
        parser.push(decoder.decode(item.value, { stream: !item.done }), item.done);
        if (item.done || stream.done) break;
      }
      const result = stream.finish();
      send({ type: 'done', id: command.id, text: clean(result.text), conversation: result.conversation });
    } catch (error) {
      if (error instanceof WebChatFailure) throw new WebChatFailure(error.code, 'conversation', response.status);
      throw error;
    } finally { clearTimeout(idle); await reader.cancel().catch(() => {}); }
  }
}
