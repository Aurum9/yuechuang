import { CONTEXT_PORT, MAX_CONTEXT_PARAGRAPHS, MAX_CONTEXT_SELECTION, MAX_CONTEXT_TITLE, normalizeContextSelection, type ContextCaptureMessage, type ContextCaptureResult, type ContextCommand, type ContextMode, type ContextPanelPin, type ContextRect, type ContextShowMessage, type ContextSnapshot, type ContextState } from './context-shared';
import { createContextPanel } from './context-ui';
import { createSelectionToolbar } from './selection-toolbar';
import { consumeRuntimeLastError, isBackgroundSender, notifyBackground } from './content-runtime';

const SNAPSHOT_LIFETIME = 60_000;
const EXCLUDED = 'script,style,noscript,template,iframe,svg,canvas,form,input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="searchbox"],[hidden],[aria-hidden="true"],[data-local-reader-root],.CodeMirror,.monaco-editor,.ace_editor,[data-slate-editor],[data-lexical-editor]';
const PARAGRAPH = 'p,li,blockquote,pre,td,th,dd,dt,h1,h2,h3,h4,h5,h6,[role="paragraph"]';
const CONTAINER = /^(?:HTML|BODY|ARTICLE|MAIN|SECTION|HEADER|FOOTER|NAV|ASIDE)$/;
type Captured = { result: ContextCaptureResult; url: string; capturedAt: number };
type SelectionIdentity = { start: Node; startOffset: number; end: Node; endOffset: number; text: string };
type ToolbarCapture = { id: string; snapshot: ContextSnapshot; identity: SelectionIdentity };

/** The cached text must match the native menu's own selectedText exactly after whitespace normalization. */
export function usableContextCapture(capture: Captured | undefined, selectedText: string, url: string, now = Date.now()): ContextCaptureResult {
  if (!selectedText.trim()) return { ok: false, message: '请先选择要解释或翻译的文字，再打开右键菜单。' };
  if (selectedText.length > MAX_CONTEXT_SELECTION) return { ok: false, message: `选中文字超过 ${MAX_CONTEXT_SELECTION.toLocaleString()} 字符，请选择更短的句子或段落。` };
  if (!capture || capture.url !== url || now < capture.capturedAt || now - capture.capturedAt > SNAPSHOT_LIFETIME) return { ok: false, message: '该选区已失效，请重新选择文字并打开右键菜单。' };
  if (!capture.result.ok) return capture.result;
  if (normalizeContextSelection(capture.result.snapshot.text) !== normalizeContextSelection(selectedText)) return { ok: false, message: '选区已变化，请重新选择文字并打开右键菜单。' };
  return { ok: true, snapshot: { ...capture.result.snapshot, rect: { ...capture.result.snapshot.rect } } };
}

/** Boot once in every authorized document, including the real preview iframe. */
export function bootContextReading(): void {
  const scope = globalThis as typeof globalThis & { __localReaderContextV2?: boolean };
  if (scope.__localReaderContextV2) return;
  scope.__localReaderContextV2 = true;
  let knownUrl = location.href;
  let lastCapture: Captured | undefined;
  let selected: ToolbarCapture | undefined;
  let trackedSelection: SelectionIdentity | undefined;
  let toolbar: ReturnType<typeof createSelectionToolbar> | undefined;
  let menuRect: ContextRect = { x: 20, y: 20, width: 0, height: 0 };
  let panel: ReturnType<typeof createContextPanel> | undefined;
  let panelPin: ContextPanelPin | undefined;
  let port: chrome.runtime.Port | undefined;
  let currentId = '';
  let generation = 0;
  let gestureVersion = 0;
  let stopped = false;
  let pointerSelecting = false;
  let dragging = false;
  let suppressUntil = 0;
  let enabled = false;
  let toolbarHiddenForDocument = false;
  let eligibilityVersion = 0;
  let eligibilityPending: Promise<void> | undefined;
  let shownCaptureId: string | undefined;
  let navigationTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function stopHeartbeat(): void { if (heartbeat) clearInterval(heartbeat); heartbeat = undefined; }
  function clearLocal(): void {
    ++generation; currentId = ''; stopped = false; stopHeartbeat();
    const previous = port; port = undefined;
    try { previous?.disconnect(); } catch { /* The worker may have stopped. */ }
    panel?.remove(); panel = undefined;
  }
  function removeToolbar(): void { toolbar?.remove(); toolbar = undefined; }
  function dismissSelection(): void {
    const captureId = selected?.id;
    ++gestureVersion; selected = undefined; trackedSelection = undefined; lastCapture = undefined;
    removeToolbar();
    if (captureId && (!currentId || captureId !== shownCaptureId)) notifyBackground({ type: 'context:selection-dismiss', captureId });
  }
  function dismissAll(): void {
    const requestId = currentId;
    const captureId = shownCaptureId;
    dismissSelection(); clearLocal(); shownCaptureId = undefined;
    if (requestId) notifyBackground({ type: 'context:selection-dismiss', requestId, captureId });
  }
  function invalidateSelection(): void {
    if (panel) dismissSelection();
    else dismissAll();
  }
  async function savePin(pin: ContextPanelPin | null): Promise<boolean> {
    panelPin = pin ?? undefined;
    try { return !!(await chrome.runtime.sendMessage({ type: 'context:panel-pin', pin }))?.ok; }
    catch { return false; }
  }
  function refreshEligibility(): Promise<void> {
    const version = ++eligibilityVersion;
    const url = location.href;
    const pending = (async () => {
      try {
        const result = await chrome.runtime.sendMessage({ type: 'context:selection-eligible' }) as { ok?: boolean; enabled?: boolean };
        if (version !== eligibilityVersion || location.href !== url) return;
        enabled = !!(result?.ok && result.enabled);
      } catch { if (version === eligibilityVersion) enabled = false; }
      if (!enabled) dismissAll();
    })();
    eligibilityPending = pending;
    const clearPending = () => { if (eligibilityPending === pending) eligibilityPending = undefined; };
    void pending.then(clearPending, clearPending);
    return pending;
  }
  function navigation(): void {
    if (location.href === knownUrl) return;
    knownUrl = location.href; enabled = false; pointerSelecting = false; dismissAll(); void refreshEligibility();
  }
  function isReaderEvent(event: Event, root?: string): boolean {
    return event.composedPath().some(node => node instanceof Element &&
      (root ? node.getAttribute('data-local-reader-root') === root : node.hasAttribute('data-local-reader-root')));
  }
  async function finishSelection(point?: { x: number; y: number }): Promise<void> {
    navigation();
    if (toolbarHiddenForDocument || dragging || Date.now() < suppressUntil) return;
    const version = ++gestureVersion;
    const result = captureContextSelection(document, Date.now(), point);
    const identity = selectionIdentity(document);
    if (!result.ok || !identity) { invalidateSelection(); return; }
    try { if (eligibilityPending) await eligibilityPending; }
    catch { return; }
    if (!enabled || version !== gestureVersion || !sameSelection(identity, document) || location.href !== result.snapshot.url) return;
    // No model or content upload occurs here. The nonce identifies exactly this
    // completed gesture; a later click authorizes the background to request it.
    const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), word => word.toString(16).padStart(8, '0')).join('');
    selected = { id, snapshot: result.snapshot, identity };
    trackedSelection = identity; menuRect = result.snapshot.rect;
    removeToolbar();
    toolbar = createSelectionToolbar(id, result.snapshot.rect, {
      start: mode => { void startSelection(mode); },
      hidePage: () => { toolbarHiddenForDocument = true; dismissAll(); },
      hideSite: async () => {
        const response = await chrome.runtime.sendMessage({ type: 'context:toolbar-hide-site' });
        if (!response?.ok) throw new Error('隐藏网站失败，请重试。');
        dismissAll();
        void refreshEligibility();
      }
    });
  }
  async function startSelection(mode: ContextMode): Promise<void> {
    const capture = selected;
    if (!capture || !enabled || !sameSelection(capture.identity, document) || capture.snapshot.url !== location.href) { invalidateSelection(); return; }
    removeToolbar();
    try {
      const result = await chrome.runtime.sendMessage({ type: 'context:selection-start', mode, captureId: capture.id }) as { ok?: boolean; error?: string; message?: string };
      if (selected !== capture || currentId || result?.ok) return;
      localFailure(mode, capture.snapshot, result?.error || result?.message || '无法连接阅窗，请重新选择文字后重试。');
    } catch {
      if (selected === capture && !currentId) localFailure(mode, capture.snapshot, '扩展连接已中断，请刷新页面后重试。');
    }
  }
  function localFailure(mode: ContextMode, snapshot: ContextSnapshot, error: string): void {
    clearLocal();
    panel = createContextPanel({ type: 'context:show', requestId: `local-${selected?.id ?? ''}`, mode, snapshot, error, expanded: false, pin: panelPin }, menuRect, { savePin, command: type => {
      if (type === 'context:close') dismissAll();
      else if (type === 'context:retry') { panel?.remove(); panel = undefined; void startSelection(mode); }
    } });
  }
  document.addEventListener('pointerdown', event => {
    if (!event.isTrusted || panel?.contains(event) || isReaderEvent(event, 'selection-toolbar')) return;
    if (panel && !panel.isPinned()) dismissAll();
    if (event.button !== 0 || isReaderEvent(event)) return;
    pointerSelecting = true; invalidateSelection();
  }, true);
  document.addEventListener('pointerup', event => {
    if (!event.isTrusted || event.button !== 0 || !pointerSelecting) return;
    pointerSelecting = false;
    if (isReaderEvent(event) || dragging || Date.now() < suppressUntil) return;
    const version = gestureVersion;
    setTimeout(() => { if (version === gestureVersion) void finishSelection({ x: event.clientX, y: event.clientY }); }, 0);
  }, true);
  document.addEventListener('keyup', event => {
    if (!event.isTrusted || isReaderEvent(event) || dragging || Date.now() < suppressUntil) return;
    if (event.key === 'Shift' || event.shiftKey || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) void finishSelection();
  }, true);
  document.addEventListener('keydown', event => {
    if (!event.isTrusted || isReaderEvent(event)) return;
    if (event.key === 'Shift' || (event.shiftKey && /^(Arrow|Home|End|Page)/u.test(event.key)) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) invalidateSelection();
  }, true);
  document.addEventListener('selectionchange', () => {
    // Programmatic selection changes can invalidate an old gesture. They never
    // create a toolbar or authorize a model request.
    if (!trackedSelection || selectionInsideReader(document)) return;
    if (!sameSelection(trackedSelection, document)) {
      // The browser-owned native menu may collapse its DOM selection while its
      // OnClickData still carries the selected text. Keep that trusted
      // menu snapshot while invalidating the old toolbar gesture.
      const nativeCapture = lastCapture;
      const keepNative = nativeCapture && nativeCapture.url === location.href && Date.now() >= nativeCapture.capturedAt && Date.now() - nativeCapture.capturedAt <= SNAPSHOT_LIFETIME;
      invalidateSelection();
      if (keepNative) lastCapture = nativeCapture;
    }
  });
  document.addEventListener('dragstart', event => { if (event.isTrusted && !isReaderEvent(event)) { dragging = true; pointerSelecting = false; invalidateSelection(); } }, true);
  document.addEventListener('dragend', event => { if (event.isTrusted) { dragging = false; pointerSelecting = false; suppressUntil = Date.now() + 350; } }, true);
  document.addEventListener('pointercancel', () => { pointerSelecting = false; });
  const scroll = (event: Event) => { if (!isReaderEvent(event)) invalidateSelection(); };
  document.addEventListener('scroll', scroll, true);
  window.visualViewport?.addEventListener('scroll', scroll);
  document.addEventListener('contextmenu', event => {
    if (!event.isTrusted) return;
    navigation();
    const capturedAt = Date.now();
    menuRect = { x: event.clientX, y: event.clientY, width: 0, height: 0 };
    // Every real context menu replaces the old capture, including an empty or
    // editable selection. A later native click cannot revive another paragraph.
    const target = event.composedPath().find(node => node instanceof Element) as Element | undefined;
    const forbidden = !!target && excludedElement(target, document);
    const result: ContextCaptureResult = forbidden ? { ok: false, message: '请输入框、编辑区域和阅窗界面之外选择文章文字。' } : captureContextSelection(document, capturedAt, { x: event.clientX, y: event.clientY });
    lastCapture = { result, url: location.href, capturedAt };
    trackedSelection = result.ok ? selectionIdentity(document) : undefined;
    removeToolbar();
  }, true);
  function command(type: ContextCommand['type']): void {
    const requestId = currentId;
    if (!requestId) return;
    if (type === 'context:stop') { stopped = true; stopHeartbeat(); panel?.cancelled(); }
    try { port?.postMessage({ type, requestId } satisfies ContextCommand); }
    catch { panel?.interrupted(); }
    if (type === 'context:close') dismissAll();
  }
  function show(message: ContextShowMessage): { ok: boolean; error?: string } {
    navigation();
    if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 200 || !['explain', 'translate'].includes(message.mode)) return { ok: false, error: '回答请求无效。' };
    if (message.snapshot && message.snapshot.url !== location.href) return { ok: false, error: '页面已变化，请重新选择文字。' };
    if (message.replacesRequestId) {
      if (currentId !== message.replacesRequestId && currentId !== message.requestId) return { ok: false, error: '上次回答已关闭。' };
    } else {
      if (message.captureId && message.captureId !== selected?.id) return { ok: false, error: '选区已变化，请重新选择文字。' };
      if (!message.captureId && !lastCapture) return { ok: false, error: '该右键选区已失效，请重新选择文字。' };
    }
    const previousLayout = message.replacesRequestId ? panel?.layout() : undefined;
    removeToolbar(); clearLocal(); currentId = message.requestId; shownCaptureId = message.captureId;
    const version = generation;
    panelPin = message.pin;
    panel = createContextPanel(message, menuRect, { command, savePin }, previousLayout ?? message.pin);
    let next: chrome.runtime.Port;
    try { next = chrome.runtime.connect({ name: CONTEXT_PORT }); }
    catch { panel.interrupted(); return { ok: false, error: '扩展连接已失效，请刷新页面。' }; }
    port = next;
    next.onMessage.addListener((state: ContextState) => {
      if (port !== next || generation !== version || currentId !== message.requestId || state.type !== 'context:state' || state.requestId !== currentId) return;
      if (location.href !== knownUrl) { navigation(); return; }
      if (stopped && state.status !== 'cancelled' && state.status !== 'error') return;
      panel?.setState(state);
      if (state.status !== 'reading' && state.status !== 'running') stopHeartbeat();
      else if (!heartbeat) heartbeat = setInterval(() => {
        if (port !== next || currentId !== message.requestId || generation !== version) { stopHeartbeat(); return; }
        try { next.postMessage({ type: 'context:status', requestId: currentId }); }
        catch { stopHeartbeat(); panel?.interrupted(); }
      }, 20_000);
    });
    next.onDisconnect.addListener(() => {
      if (port !== next || generation !== version || currentId !== message.requestId) return;
      consumeRuntimeLastError(); port = undefined; lastCapture = undefined; selected = undefined; trackedSelection = undefined; stopHeartbeat(); panel?.interrupted();
    });
    return { ok: true };
  }
  chrome.runtime.onMessage.addListener((message: ContextCaptureMessage | ContextShowMessage | { type: 'permissions:changed' | 'context:closed'; requestId?: string } | { type: 'context:toolbar-site-changed'; hostname: string }, sender, respond) => {
    if (!isBackgroundSender(sender)) return;
    if (message.type === 'context:toolbar-site-changed') {
      if (message.hostname === location.hostname) { enabled = false; dismissAll(); void refreshEligibility(); }
      return;
    }
    if (message.type === 'permissions:changed') { enabled = false; dismissAll(); void refreshEligibility(); return; }
    if (message.type === 'context:closed') { if (!message.requestId || message.requestId === currentId) dismissAll(); return; }
    if (message.type === 'context:capture') {
      navigation();
      if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 200) { respond({ ok: false, message: '选区请求无效。' }); return; }
      if (typeof message.captureId === 'string') {
        const capture = selected;
        if (!capture || capture.id !== message.captureId || capture.snapshot.url !== location.href || !sameSelection(capture.identity, document)) { respond({ ok: false, message: '选区已变化，请重新选择文字。' }); return; }
        respond(usableContextCapture({ result: { ok: true, snapshot: capture.snapshot }, url: capture.snapshot.url, capturedAt: capture.snapshot.capturedAt }, capture.snapshot.text, location.href)); return;
      }
      if (typeof message.selectedText !== 'string') { respond({ ok: false, message: '选区请求无效。' }); return; }
      respond(usableContextCapture(lastCapture, message.selectedText, location.href)); return;
    }
    if (message.type === 'context:show') { respond(show(message)); return; }
  });
  // This listener is registered before the link-preview Escape listener. One
  // press closes the nearby answer while keeping the parent preview readable.
  document.addEventListener('keydown', event => {
    if (!event.isTrusted || event.key !== 'Escape' || (!panel && !toolbar)) return;
    event.preventDefault(); event.stopImmediatePropagation(); if (currentId) command('context:close'); else dismissAll();
  }, true);
  function watch(): void { if (!navigationTimer) navigationTimer = setInterval(navigation, 400); }
  window.addEventListener('popstate', navigation); window.addEventListener('hashchange', navigation);
  window.addEventListener('pagehide', () => { ++eligibilityVersion; enabled = false; dismissAll(); clearInterval(navigationTimer); navigationTimer = undefined; });
  window.addEventListener('pageshow', event => { if (event.persisted) { knownUrl = location.href; watch(); void refreshEligibility(); } });
  watch(); void refreshEligibility();
}

function selectionIdentity(doc: Document): SelectionIdentity | undefined {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return undefined;
  const range = selection.getRangeAt(0);
  return { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset, text: normalizeContextSelection(selection.toString()) };
}
function sameSelection(identity: SelectionIdentity, doc: Document): boolean {
  const current = selectionIdentity(doc);
  return !!current && current.start === identity.start && current.end === identity.end && current.startOffset === identity.startOffset && current.endOffset === identity.endOffset && current.text === identity.text;
}
function selectionInsideReader(doc: Document): boolean {
  const selection = doc.getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  for (let element = parentElement(range.startContainer); element; element = composedParent(element)) if (element.hasAttribute('data-local-reader-root')) return true;
  return false;
}

function parentElement(node: Node | null): Element | null {
  if (!node) return null;
  if (node.nodeType === 1) return node as Element;
  return node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null);
}
function composedParent(element: Element): Element | null { return element.parentElement ?? ((element.getRootNode() as ShadowRoot).host ?? null); }
function excludedElement(element: Element, doc: Document): boolean {
  if (doc.designMode.toLowerCase() === 'on') return true;
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (current.matches(EXCLUDED)) return true;
    const style = doc.defaultView?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.contentVisibility === 'hidden' || style?.opacity === '0' || /\bblur\((?!0(?:px)?\))/.test(style?.filter ?? '')) return true;
    if ((style?.clip !== undefined && style.clip !== 'auto' && /rect\(0px,? 0px,? 0px,? 0px\)/.test(style.clip)) || /inset\((?:50|100)%/.test(style?.clipPath ?? '')) return true;
    if (style && !/^(HTML|BODY)$/.test(current.tagName) && /^(hidden|clip)$/.test(style.overflowY) && current.clientHeight > 0 && current.scrollHeight > current.clientHeight + 2) return true;
    if (current.matches('details:not([open])') && element.closest('summary')?.parentElement !== current) return true;
  }
  return false;
}

function containingParagraph(node: Node, doc: Document): Element | undefined {
  let fallback: Element | undefined;
  for (let current = parentElement(node); current && !CONTAINER.test(current.tagName); current = composedParent(current)) {
    if (current.matches(PARAGRAPH)) return current;
    if (!fallback && /^(?:block|list-item|table-cell|flex|grid)$/.test(doc.defaultView?.getComputedStyle(current).display ?? '')) fallback = current;
  }
  return fallback;
}

/** Read only visible text nodes. Never read HTML, form values, or editor data. */
interface ParagraphPosition { range: Range; start?: number; end?: number }
function paragraphText(root: Element, doc: Document, limit = MAX_CONTEXT_PARAGRAPHS, position?: ParagraphPosition): string | undefined {
  if (excludedElement(root, doc)) return undefined;
  let result = '';
  let overflow = false;
  const append = (value: string) => { result += value; if (result.length > limit) overflow = true; };
  const visit = (node: Node): void => {
    if (overflow) return;
    if (node.nodeType === 3) {
      if (position?.range.startContainer === node) position.start = result.length + position.range.startOffset;
      if (position?.range.endContainer === node) position.end = result.length + position.range.endOffset;
      append(node.textContent ?? ''); return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (excludedElement(element, doc)) return;
    if (element.tagName === 'BR') { append('\n'); return; }
    const block = element.matches(PARAGRAPH) || /^(DIV|SECTION)$/.test(element.tagName);
    if (block && result && !result.endsWith('\n')) append('\n');
    for (let index = 0; index <= element.childNodes.length; index++) {
      if (position?.range.startContainer === node && position.range.startOffset === index) position.start = result.length;
      if (position?.range.endContainer === node && position.range.endOffset === index) position.end = result.length;
      if (index < element.childNodes.length) visit(element.childNodes[index]);
      if (overflow) break;
    }
    if (block && result && !result.endsWith('\n')) append('\n');
  };
  visit(root);
  return overflow ? undefined : position ? result : result.replace(/\r/g, '').replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Reduce an oversized paragraph at whole sentence/line boundaries around the selection. */
export function completeSentenceContext(text: string, selectionStart: number, selectionEnd: number, limit = MAX_CONTEXT_PARAGRAPHS): string | undefined {
  const start = Math.max(0, Math.min(text.length, selectionStart));
  const end = Math.max(start, Math.min(text.length, selectionEnd));
  const boundary = (index: number) => /[!?。！？;；\n]/u.test(text[index]) || (text[index] === '.' && (index + 1 === text.length || /\s/u.test(text[index + 1])));
  let from = start; let to = end;
  while (from > 0 && !boundary(from - 1)) from--;
  if (!(end > start && boundary(end - 1))) {
    while (to < text.length && !boundary(to)) to++;
    if (to < text.length) to++;
  }
  const context = text.slice(from, to).trim();
  return context.length <= limit ? context : undefined;
}

function sentenceContext(root: Element, range: Range, doc: Document): string | undefined {
  const position: ParagraphPosition = { range };
  // Bound the local paragraph read even when a site puts an entire document in
  // one block. Nothing outside this containing block is scanned or submitted.
  const raw = paragraphText(root, doc, 100_000, position);
  if (!raw || (position.start === undefined && position.end === undefined)) return undefined;
  return completeSentenceContext(raw, position.start ?? position.end!, position.end ?? position.start!);
}

/** Capture the actual selection at a trusted native context menu, without moving it. */
export function captureContextSelection(doc: Document, capturedAt = Date.now(), point?: { x: number; y: number }): ContextCaptureResult {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return { ok: false, message: '请先选择文章中的文字，再打开右键菜单。' };
  const range = selection.getRangeAt(0);
  const text = selection.toString().replace(/\r\n?/g, '\n').trim();
  if (!text) return { ok: false, message: '该选区没有可读取的文章文字。' };
  if (text.length > MAX_CONTEXT_SELECTION) return { ok: false, message: `选中文字超过 ${MAX_CONTEXT_SELECTION.toLocaleString()} 字符，请选择更短的句子或段落。` };
  if (range.startContainer.ownerDocument !== doc || range.endContainer.ownerDocument !== doc || !parentElement(range.startContainer)?.isConnected || !parentElement(range.endContainer)?.isConnected) return { ok: false, message: '该选区已失效，请重新选择文字。' };
  const startElement = parentElement(range.startContainer); const endElement = parentElement(range.endContainer);
  if (!startElement || !endElement || excludedElement(startElement, doc) || excludedElement(endElement, doc)) return { ok: false, message: '请在可见文章正文中选择文字，输入框和编辑区域不参与读取。' };
  // A range can span a hidden/editor subtree even when both endpoints are safe.
  // Reject that range instead of accidentally sending those intermediate nodes.
  const walker = doc.createTreeWalker(range.commonAncestorContainer, 4);
  let first = range.startContainer;
  if (first.nodeType === 1 && first.childNodes[range.startOffset]) first = first.childNodes[range.startOffset];
  walker.currentNode = first;
  let visited = 0;
  let lastSelectedText: Node | undefined;
  for (let node: Node | null = first.nodeType === 3 ? first : walker.nextNode(); node; node = walker.nextNode()) {
    if (range.comparePoint(node, 0) === 1) break;
    if (++visited > 20_000) return { ok: false, message: '选区跨越内容过多，请选择更短的连续段落。' };
    if (!(node.textContent ?? '').trim() || !range.intersectsNode(node)) continue;
    const element = parentElement(node);
    if (element && excludedElement(element, doc)) return { ok: false, message: '该选区包含隐藏内容或编辑区域，请重新选择可见正文。' };
    lastSelectedText = node;
  }
  const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.x < (doc.defaultView?.innerWidth ?? Infinity) && rect.y < (doc.defaultView?.innerHeight ?? Infinity));
  if (!rects.length) return { ok: false, message: '选区当前不可见，请滚动到文字位置并重新选择。' };
  const chosen = point ? rects.reduce((best, rect) => distance(rect, point) < distance(best, point) ? rect : best) : rects[0];
  const candidates = new Set<Element>();
  // A native triple-click may end at the next paragraph's offset zero. Use the
  // last selected text rather than treating that unselected block as required.
  const start = containingParagraph(range.startContainer, doc); const end = containingParagraph(lastSelectedText ?? range.endContainer, doc);
  if (start) candidates.add(start); if (end) candidates.add(end);
  let context = '';
  const accepted: Array<{ element: Element; text: string }> = [];
  function include(element: Element, value = paragraphText(element, doc)): boolean {
    if (accepted.some(item => item.element === element)) return true;
    if (!value || context.length + value.length + (context ? 2 : 0) > MAX_CONTEXT_PARAGRAPHS) return false;
    accepted.push({ element, text: value }); context += `${context ? '\n\n' : ''}${value}`; return true;
  }
  let required = [...candidates].map(element => ({ element, text: paragraphText(element, doc) ?? sentenceContext(element, range, doc) }));
  if (required.reduce((length, item) => length + (item.text?.length ?? MAX_CONTEXT_PARAGRAPHS + 1) + 2, 0) > MAX_CONTEXT_PARAGRAPHS) required = required.map(item => ({ element: item.element, text: sentenceContext(item.element, range, doc) }));
  for (const item of required) if (!include(item.element, item.text)) return { ok: false, message: '所在段落及临近完整句超过 10,000 字符，无法完整提供语境。请改选更短的独立段落。' };
  // At most one adjacent complete paragraph on either side. Avoid walking an
  // article or body in search of context, and preserve complete nearby blocks.
  for (const edge of [start, end]) {
    for (const neighbor of [edge?.previousElementSibling, edge?.nextElementSibling]) {
      if (neighbor?.matches(PARAGRAPH) && !candidates.has(neighbor)) include(neighbor);
    }
  }
  if (accepted.length) {
    accepted.sort((a, b) => a.element.compareDocumentPosition(b.element) & 2 ? 1 : -1);
    context = accepted.map(item => item.text).join('\n\n');
  }
  if (!context) {
    // Plain text pages can put prose directly in body, without paragraph tags.
    // Use the local text node instead of scanning the whole document container.
    if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) context = completeSentenceContext(range.startContainer.textContent ?? '', range.startOffset, range.endOffset) ?? '';
    if (!context) return { ok: false, message: '未取得选区所在的完整段落或句子，请选择文章中的连续正文后重试。' };
  }
  return { ok: true, snapshot: { text, context, title: doc.title.trim().slice(0, MAX_CONTEXT_TITLE), url: doc.URL, rect: { x: chosen.x, y: chosen.y, width: chosen.width, height: chosen.height }, capturedAt } };
}

function distance(rect: DOMRect, point: { x: number; y: number }): number {
  return Math.hypot(Math.max(rect.left - point.x, 0, point.x - rect.right), Math.max(rect.top - point.y, 0, point.y - rect.bottom));
}
