import { pageCommand } from './webchat-protocol';
import { PageChatDriver, PageChatError, pageChatStatus } from './webchat-page-dom';
import { WEBCHAT_ORIGIN, type WebChatPageEvent } from './webchat-shared';

// Isolated content world only. All interaction goes through visible webpage controls.
// This bridge never reads sessions, cookies, tokens, app state or network responses.
const scope = globalThis as typeof globalThis & { __readerPageChatInstalled?: boolean };
if (location.origin === WEBCHAT_ORIGIN && window === window.top && !scope.__readerPageChatInstalled) {
  scope.__readerPageChatInstalled = true;
  const driver = new PageChatDriver();
  let active: { id: string; controller: AbortController } | undefined;
  window.addEventListener('pagehide', () => active?.controller.abort(new PageChatError('pageChanged')));
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'reader-chatgpt-page') return;
    const sender = port.sender;
    if (!sender || sender.id !== chrome.runtime.id || sender.tab || (sender.url && !sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`))) { port.disconnect(); return; }
    let connected = true;
    const send = (event: WebChatPageEvent) => { if (connected) try { port.postMessage(event); } catch {} };
    let own: { id: string; controller: AbortController } | undefined;
    port.onDisconnect.addListener(() => { connected = false; own?.controller.abort(); });
    port.onMessage.addListener((raw: unknown) => {
      const command = pageCommand(raw);
      if (!command) return;
      if (command.type === 'cancel') { if (own?.id === command.id) own.controller.abort(); return; }
      if (command.type === 'status') { send({ type: 'status', id: command.id, status: pageChatStatus(document) }); return; }
      if (active) { send({ type: 'error', id: command.id, code: 'pageBusy', stage: 'conversation' }); return; }
      const controller = new AbortController();
      own = active = { id: command.id, controller };
      const heartbeat = setInterval(() => send({ type: 'heartbeat', id: command.id }), 15_000);
      void driver.generate(command, { document, location, signal: controller.signal, onText: text => send({ type: 'text', id: command.id, text }) })
        .then(result => send({ type: 'done', id: command.id, ...result }))
        .catch(error => send({ type: 'error', id: command.id, code: error instanceof PageChatError ? error.code : 'pageUnsupported', stage: 'conversation' }))
        .finally(() => { clearInterval(heartbeat); if (active?.controller === controller) active = undefined; if (own?.controller === controller) own = undefined; });
    });
  });
}
