import { waitForArticle } from './extract';

/** Only the worker can request a read, addressed to an exact top-level document. */
export function bootResearchReader(): void {
  if (window !== window.top) return;
  const requests = new Map<string, AbortController>();
  const clear = () => { for (const request of requests.values()) request.abort(); requests.clear(); };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || (sender.url && sender.url !== chrome.runtime.getURL('background.js'))) return;
    if (message?.type === 'research:cancel') { if (typeof message.requestId === 'string') requests.get(message.requestId)?.abort(); return; }
    if (message?.type !== 'research:extract') return;
    if (typeof message.requestId !== 'string' || message.requestId.length > 100 || message.url !== location.href) { respond({ ok: false, message: '研究目标文档已变化。' }); return; }
    clear();
    const id = message.requestId, url = location.href, controller = new AbortController(); requests.set(id, controller);
    void waitForArticle(controller.signal).then(result => {
      if (controller.signal.aborted || location.href !== url) respond({ ok: false, message: '研究读取已停止或网页已导航。' });
      else respond(result);
    }, () => respond({ ok: false, message: '研究读取未完成，请重新开始任务。' }))
      .finally(() => { if (requests.get(id) === controller) requests.delete(id); });
    return true;
  });
  window.addEventListener('pagehide', clear);
}
