import './panel-embed.css';

if (location.search === '?panel=1' && window.parent !== window) {
  let internalParent = false;
  try { internalParent = window.parent.location.href.split(/[?#]/)[0] === chrome.runtime.getURL('sidepanel.html'); } catch { /* A foreign page cannot host our privileged view. */ }
  if (internalParent) {
    document.documentElement.classList.add('panel-embedded');
    const targetOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
    const destinations: Record<string, string> = { 'options.html': 'settings', 'research.html': 'research', 'phrases.html': 'phrases' };
    document.addEventListener('click', event => {
      if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
      if (!link || link.getAttribute('href')?.startsWith('#')) return;
      let url: URL; try { url = new URL(link.href); } catch { return; }
      if (url.protocol !== 'chrome-extension:' || url.host !== chrome.runtime.id) return;
      const tab = destinations[url.pathname.slice(1)]; if (!tab) return;
      event.preventDefault(); event.stopImmediatePropagation();
      window.parent.postMessage({ type: 'reader:navigate', tab }, targetOrigin);
    }, true);
  }
}
