/** A reloaded extension can leave its old content script in an open document.
 * Chrome may throw before returning a Promise in that retired context. */
export function notifyBackground(message: unknown, onFailure?: () => void): void {
  const failed = () => {
    try { onFailure?.(); } catch { /* Cleanup must remain safe in a retired document. */ }
  };
  try { void chrome.runtime.sendMessage(message).catch(failed); }
  catch { failed(); }
}

/** Reading lastError acknowledges Chrome's disconnect error. Its accessor can
 * itself be unavailable during teardown; local UI cleanup must still run. */
export function consumeRuntimeLastError(): void {
  try { void chrome.runtime.lastError; }
  catch { /* The extension context has already been retired. */ }
}

export function isBackgroundSender(sender: chrome.runtime.MessageSender): boolean {
  try {
    const id = chrome.runtime.id;
    return typeof id === 'string' && id.length > 0 && sender.id === id && !sender.tab && (!sender.url || sender.url === chrome.runtime.getURL('background.js'));
  } catch { return false; }
}
