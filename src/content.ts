import { waitForArticle } from './extract';
import { bootResearchReader } from './research-reader';
import { bootContextReading } from './context-content';
import { consumeRuntimeLastError, isBackgroundSender, notifyBackground } from './content-runtime';
import { createInlinePanel, type Phase } from './inline-ui';
import type { InlinePreview, PreviewCommand, PreviewEvent } from './shared';

const scope = globalThis as typeof globalThis & { __localReaderInlineV2?: boolean };
if (!scope.__localReaderInlineV2) {
  scope.__localReaderInlineV2 = true;
  bootResearchReader();
  bootContextReading();
  if (window === window.top) bootSource();
  else bootTargetFrame();
}

function bootSource(): void {
  let enabled = false;
  let knownUrl = location.href;
  let helloVersion = 0;
  let openingVersion = 0;
  let connectionVersion = 0;
  let active: InlinePreview | undefined;
  let revision = -1;
  let panel: ReturnType<typeof createInlinePanel> | undefined;
  let port: chrome.runtime.Port | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let navigationTimer: ReturnType<typeof setInterval> | undefined;
  let phase: Phase = 'ready';
  let progressLabel = '';
  let acceptsEvents = false;
  let currentRequest = '';
  const retiredRequests = new Set<string>();
  let drag: { url: string; x: number; y: number; triggered: boolean } | undefined;

  function stopHeartbeat(): void { if (heartbeat) clearInterval(heartbeat); heartbeat = undefined; }
  function setPhase(next: Phase, text: string): void {
    phase = next;
    panel?.setState(next, text);
    if (next !== 'reading' && next !== 'running') stopHeartbeat();
    else if (!heartbeat) heartbeat = setInterval(() => { if (phase === 'reading' || phase === 'running') send({ type: 'summary:status' }); }, 20_000);
  }
  function retireRequest(): void {
    if (currentRequest) retiredRequests.add(currentRequest);
    currentRequest = '';
    if (retiredRequests.size > 100) retiredRequests.delete(retiredRequests.values().next().value!);
  }
  function resetSummary(text = '原网页可直接阅读。点击“总结”后发送当前已加载正文。'): void {
    retireRequest(); acceptsEvents = false; progressLabel = '';
    panel?.setText(''); panel?.clearArticle(); panel?.setPlan(undefined, false);
    setPhase('ready', text);
  }
  function dropConnection(): void {
    ++connectionVersion; stopHeartbeat();
    const previous = port; port = undefined;
    try { previous?.disconnect(); } catch { /* The extension or document may have closed. */ }
  }
  function interrupted(): void {
    dropConnection(); acceptsEvents = false;
    if (panel) setPhase('interrupted', '摘要连接已中断。可手动重试；再次总结可能产生新的模型调用。');
  }
  function send(command: PreviewCommand): boolean {
    if (!port) return false;
    try { port.postMessage(command); return true; } catch { interrupted(); return false; }
  }
  function clearLocal(): void {
    ++openingVersion; dropConnection();
    panel?.remove(); panel = undefined; active = undefined; revision = -1;
    acceptsEvents = false; currentRequest = ''; retiredRequests.clear();
    phase = 'ready';
  }
  function closePreview(): void {
    const previous = active;
    send({ type: 'summary:stop' });
    const sent = send({ type: 'preview:close' });
    if (previous && !sent) notifyBackground({ type: 'preview:close', previewId: previous.id });
    clearLocal();
  }
  function ensurePanel(): ReturnType<typeof createInlinePanel> {
    return panel ??= createInlinePanel({
      summarize: () => { void startSummary(); },
      reread: () => { void startSummary(true); },
      confirm: () => { void startSummary(false, false, true); },
      stop: stopSummary, close: closePreview,
      openTab: () => {
        if (!active || send({ type: 'preview:open-tab' })) return;
        notifyBackground({ type: 'preview:open-tab', previewId: active.id });
      },
      settings: () => { notifyBackground({ type: 'settings:open' }, () => panel?.setState('error', '无法打开设置，请通过扩展图标进入。')); }
    });
  }
  async function hello(): Promise<boolean> {
    const version = ++helloVersion;
    const url = location.href;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'page:hello' }) as { ok: boolean; enabled?: boolean };
      if (version !== helloVersion || url !== location.href) return false;
      enabled = !!(result.ok && result.enabled);
      if (!enabled) { drag = undefined; closePreview(); }
      return enabled;
    } catch {
      if (version !== helloVersion) return false;
      enabled = false; drag = undefined;
      if (panel) interrupted();
      return false;
    }
  }
  async function openInline(url: string): Promise<void> {
    const version = ++openingVersion;
    dropConnection(); active = undefined; revision = -1; retiredRequests.clear(); currentRequest = '';
    const view = ensurePanel();
    view.prepare(url);
    resetSummary();
    try {
      const result = await chrome.runtime.sendMessage({ type: 'preview:open', url }) as { ok: boolean; preview?: InlinePreview; warning?: string; error?: string };
      if (version !== openingVersion || !panel || knownUrl !== location.href) {
        if (result.ok && result.preview) notifyBackground({ type: 'preview:close', previewId: result.preview.id });
        return;
      }
      if (!result.ok || !result.preview) { panel.setPage('error', result.error || '无法打开链接，请检查网站权限。'); setPhase('error', result.error || '链接预览打开失败。'); return; }
      active = result.preview;
      panel.load(active.id, active.url);
      if (result.warning) { panel.setPage('error', result.warning); setPhase('error', result.warning); }
      connectPreview(true);
    } catch {
      if (version !== openingVersion) return;
      panel?.setPage('error', '扩展连接已失效，请刷新来源页后重试。');
      interrupted();
    }
  }
  function connectPreview(allowAutomatic: boolean): boolean {
    if (!active) return false;
    const expected = active.id;
    const version = ++connectionVersion;
    let initial = true;
    let next: chrome.runtime.Port;
    try { next = chrome.runtime.connect({ name: 'preview' }); } catch { interrupted(); return false; }
    port = next;
    next.onMessage.addListener((message: PreviewEvent) => {
      if (port !== next || version !== connectionVersion || active?.id !== expected) return;
      if (knownUrl !== location.href) { sourceNavigation(); return; }
      if (message.type === 'preview:reset') { resetSummary('目标页面已变化。请按需总结新页面。'); return; }
      if (message.type === 'preview:init') {
        if (!initial || message.previewId !== expected) return;
        initial = false;
        revision = Math.max(revision, message.revision);
        panel?.setAutomatic(message.autoSummary);
        if (active) active.url = message.url;
        panel?.setTarget(undefined, message.url);
        if (message.interrupted) {
          if (phase !== 'reading' && phase !== 'running') {
            acceptsEvents = false;
            setPhase('interrupted', '上次摘要任务已中断。请手动重试，扩展不会自动重复发起请求。');
          }
        } else if (allowAutomatic && message.autoSummary && phase !== 'reading' && phase !== 'running') void startSummary(false, true);
        return;
      }
      if (message.type === 'preview:page') {
        if (message.previewId !== expected || message.revision < revision) return;
        if (revision >= 0 && message.revision > revision) resetSummary('目标页面已导航，旧摘要已清空。可手动总结当前页面。');
        revision = message.revision;
        if (active) active.url = message.url;
        panel?.setTarget(message.title, message.url);
        panel?.setPage(message.status, message.error);
        return;
      }
      if (!acceptsEvents) return;
      if (message.type === 'preview:article') { panel?.setArticle(message.article); return; }
      if (message.type === 'summary:plan') {
        panel?.setPlan(message.plan, message.needsConfirmation);
        if (message.needsConfirmation) setPhase('confirming', `长文预计需要 ${message.plan.requests} 次模型调用。确认后开始全文分段总结。`);
        return;
      }
      if (message.type === 'summary:progress') {
        if (phase !== 'reading' && phase !== 'running') return;
        const { stage, current, total } = message.progress;
        progressLabel = stage === 'reading' ? '正在读取目标页当前已加载正文…' : stage === 'section' ? `正在总结第 ${current} / ${total} 节…` : '正在整合各节摘要…';
        setPhase(stage === 'reading' ? 'reading' : 'running', progressLabel);
        return;
      }
      if (message.type !== 'summary:state' || retiredRequests.has(message.requestId)) return;
      if (currentRequest && currentRequest !== message.requestId && (phase === 'reading' || phase === 'running')) return;
      currentRequest = message.requestId;
      panel?.setText(message.text);
      if (message.status === 'reading') setPhase('reading', '正在读取目标页当前已加载正文…');
      if (message.status === 'running') setPhase('running', progressLabel || '正在生成中文摘要…');
      if (message.status === 'planned') setPhase('confirming', '长文分段计划已就绪，确认后开始模型调用。');
      if (message.status === 'done') setPhase('done', message.cached ? '摘要已完成 · 来自本次浏览器会话缓存' : '摘要已完成');
      if (message.status === 'cancelled') setPhase('cancelled', '已停止生成。原网页可继续阅读。');
      if (message.status === 'error') setPhase('error', message.error || '摘要生成失败，请检查接口设置后手动重试。');
    });
    next.onDisconnect.addListener(() => {
      if (port !== next || version !== connectionVersion) return;
      consumeRuntimeLastError(); interrupted();
    });
    return true;
  }
  async function startSummary(force = false, automatic = false, allowMultiple = false): Promise<void> {
    if (knownUrl !== location.href) { sourceNavigation(); return; }
    if (!enabled || !active || !panel) return;
    if (phase === 'reading' || (phase === 'running' && !force)) return;
    if (force && phase === 'running') stopSummary();
    retireRequest(); acceptsEvents = true; progressLabel = '';
    panel.setText(''); panel.setPlan(undefined, false);
    setPhase('reading', port ? '正在读取目标页当前已加载正文…' : '正在恢复摘要连接并读取正文…');
    if (!port && !connectPreview(false)) return;
    if (!send({ type: 'summary:start', force, automatic, allowMultiple })) interrupted();
  }
  function stopSummary(): void {
    retireRequest(); acceptsEvents = false;
    send({ type: 'summary:stop' }); panel?.setPlan(undefined, false);
    setPhase('cancelled', '已停止生成。原网页可继续阅读。');
  }
  function dragStart(event: DragEvent): void {
    drag = undefined;
    if (!enabled || !event.isTrusted || event.defaultPrevented || !event.dataTransfer?.types.includes('text/uri-list')) return;
    const path = event.composedPath();
    if (path.some(element => element instanceof Element && element.hasAttribute('data-local-reader-root'))) return;
    const anchor = path.find(element => element instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
    if (!anchor?.href) return;
    let target: URL;
    try { target = new URL(anchor.href); } catch { return; }
    if (!['https:', 'http:'].includes(target.protocol)) return;
    drag = { url: target.href, x: event.clientX, y: event.clientY, triggered: false };
  }
  function dragMove(event: DragEvent): void {
    if (!drag || !enabled || !event.isTrusted) return;
    if (!event.clientX && !event.clientY) return;
    if (event.clientX < 0 || event.clientY < 0 || event.clientX > innerWidth || event.clientY > innerHeight) return;
    if (!drag.triggered && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 28) { drag.triggered = true; void openInline(drag.url); }
    if (drag.triggered && event.type === 'dragover') { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'link'; }
  }
  document.addEventListener('dragstart', dragStart, true);
  document.addEventListener('drag', dragMove, true);
  document.addEventListener('dragover', dragMove, true);
  document.addEventListener('drop', event => { if (drag?.triggered) { event.preventDefault(); event.stopPropagation(); drag = undefined; } }, true);
  document.addEventListener('dragend', () => { drag = undefined; }, true);
  window.addEventListener('blur', () => { drag = undefined; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && panel) closePreview(); });
  chrome.runtime.onMessage.addListener((message: { type?: string; previewId?: string }, sender) => {
    if (!isBackgroundSender(sender)) return;
    if (message.type === 'preview:closed' && message.previewId === active?.id) clearLocal();
    if (message.type === 'permissions:changed') void hello();
  });
  function sourceNavigation(): void { ++helloVersion; knownUrl = location.href; drag = undefined; closePreview(); void hello(); }
  function watchNavigation(): void { navigationTimer = setInterval(() => { if (knownUrl !== location.href) sourceNavigation(); }, 400); }
  window.addEventListener('popstate', () => { if (knownUrl !== location.href) sourceNavigation(); });
  window.addEventListener('hashchange', () => { if (knownUrl !== location.href) sourceNavigation(); });
  window.addEventListener('pagehide', () => { ++helloVersion; drag = undefined; closePreview(); clearInterval(navigationTimer); navigationTimer = undefined; });
  window.addEventListener('pageshow', event => { if (event.persisted) { knownUrl = location.href; watchNavigation(); void hello(); } });
  watchNavigation(); void hello();
}

function bootTargetFrame(): void {
  let previewId: string | undefined;
  let knownUrl = location.href;
  let helloVersion = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let helloPending: Promise<unknown> | undefined;
  const requests = new Map<string, AbortController>();
  function cancelAll(): void { for (const controller of requests.values()) controller.abort(); requests.clear(); }
  async function hello(): Promise<void> {
    const version = ++helloVersion;
    let pending: Promise<unknown> | undefined;
    try {
      pending = chrome.runtime.sendMessage({ type: 'frame:hello', name: window.name });
      helloPending = pending;
      const result = await pending as { ok: boolean; previewId?: string };
      if (version === helloVersion) {
        previewId = result.ok ? result.previewId : undefined;
        if (previewId && !timer) watch();
        if (!previewId && timer) { clearInterval(timer); timer = undefined; }
      }
    } catch { if (version === helloVersion) previewId = undefined; }
    finally { if (pending && helloPending === pending) helloPending = undefined; }
  }
  chrome.runtime.onMessage.addListener((message: { type?: string; previewId?: string; requestId?: string }, sender, respond) => {
    if (!isBackgroundSender(sender)) return;
    if (message.type === 'permissions:changed') { cancelAll(); void hello(); return; }
    if (message.type === 'frame:cancel' && typeof message.requestId === 'string') { requests.get(message.requestId)?.abort(); requests.delete(message.requestId); return; }
    if (message.type !== 'frame:extract') return;
    if (typeof message.requestId !== 'string' || message.requestId.length > 200) { respond({ ok: false, reason: 'empty', message: '目标页面身份已变化，请重新读取。' }); return; }
    cancelAll();
    const requestId = message.requestId;
    const controller = new AbortController(); requests.set(requestId, controller);
    const url = location.href;
    void (async () => {
      // The worker can see the bound document just before the hello reply reaches it.
      if (helloPending) await helloPending.catch(() => {});
      if (!previewId || message.previewId !== previewId) return { ok: false, reason: 'empty', message: '目标页面身份已变化，请重新读取。' };
      return waitForArticle(controller.signal);
    })().then(result => {
      if (controller.signal.aborted || location.href !== url) respond({ ok: false, reason: 'empty', message: '正文读取已取消或页面已导航。' });
      else respond(result);
    }).catch(error => respond({ ok: false, reason: 'empty', message: controller.signal.aborted ? '正文读取已取消。' : error instanceof Error ? `正文读取失败：${error.message}` : '正文读取失败。' }))
      .finally(() => { if (requests.get(requestId) === controller) requests.delete(requestId); });
    return true;
  });
  const navigation = () => { if (location.href === knownUrl) return; knownUrl = location.href; cancelAll(); previewId = undefined; void hello(); };
  function watch(): void { timer = setInterval(navigation, 400); }
  window.addEventListener('popstate', navigation); window.addEventListener('hashchange', navigation);
  window.addEventListener('pagehide', () => { ++helloVersion; cancelAll(); clearInterval(timer); timer = undefined; });
  window.addEventListener('pageshow', event => { if (event.persisted) { knownUrl = location.href; watch(); void hello(); } });
  document.addEventListener('drop', event => { if (previewId && event.isTrusted && event.dataTransfer?.types.includes('text/uri-list')) { event.preventDefault(); event.stopPropagation(); } }, true);
  void hello();
}

