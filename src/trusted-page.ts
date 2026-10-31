/** Only packaged, non-web-accessible extension documents can use these APIs. */
export function trustedPage(sender: chrome.runtime.MessageSender, file: string): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
  if (sender.origin && sender.origin !== extensionOrigin) return false;
  const url = sender.url?.split('#')[0];
  if (url === chrome.runtime.getURL(file)) return sender.frameId === undefined || sender.frameId === 0;
  // The panel embeds exactly these packaged pages with a fixed query. They are
  // not web-accessible resources; their frames retain their own narrow role.
  return url === chrome.runtime.getURL(`${file}?panel=1`);
}
