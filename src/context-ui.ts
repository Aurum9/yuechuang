import { detailsEligibility, type ContextCommand, type ContextPanelPin, type ContextRect, type ContextShowMessage, type ContextState } from './context-shared';

export interface ContextPanelActions {
  command(type: ContextCommand['type']): void;
  savePin(pin: ContextPanelPin | null): Promise<boolean>;
}
export interface ContextPlacement { left: number; top: number; width: number; maxHeight: number }

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** Position within the selected frame, including a small iframe or mobile viewport. */
export function placeContextPanel(rect: ContextRect, viewportWidth: number, viewportHeight: number, measuredHeight = 320): ContextPlacement {
  const gutter = Math.min(12, Math.max(2, viewportWidth / 12));
  const width = Math.max(0, Math.min(430, viewportWidth - gutter * 2));
  const maxHeight = Math.max(0, Math.min(410, viewportHeight - gutter * 2));
  const height = Math.min(measuredHeight, maxHeight);
  const left = Math.max(gutter, Math.min(rect.x, viewportWidth - width - gutter));
  const below = Math.max(gutter, rect.y + Math.max(0, rect.height) + 8);
  const above = rect.y - height - 8;
  const preferred = below + height <= viewportHeight - gutter ? below : above >= gutter ? above : Math.max(gutter, Math.min(below, viewportHeight - height - gutter));
  return { left, top: preferred, width, maxHeight };
}

export function createContextPanel(message: ContextShowMessage, fallbackRect: ContextRect, actions: ContextPanelActions, initialLayout = message.pin) {
  const mode = message.mode;
  let answer = message.coreText ?? '';
  let coreText = message.coreText ?? '';
  let detailsText = message.detailsText ?? '';
  let busy = !message.error;
  let connected = true;
  let transitioning = false;
  let canExpand = false;
  let expanded = message.expanded;
  let exampleKind = message.exampleKind ?? detailsEligibility(mode, message.snapshot?.text ?? message.selectionText ?? '');
  let phase: ContextState['status'] = message.error ? 'error' : 'reading';
  let saved = false, saving = false, savedId: string | undefined;
  let pinned = !!message.pin;
  let layout = initialLayout;
  const anchor = message.snapshot?.rect ?? fallbackRect;
  const host = document.createElement('local-reader-context');
  host.setAttribute('data-local-reader-root', 'context');
  for (const [key, value] of Object.entries({ position: 'fixed', inset: '0', 'z-index': '2147483647', 'pointer-events': 'none', margin: '0', padding: '0', border: '0', display: 'block', visibility: 'visible' })) host.style.setProperty(key, value, 'important');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; color-scheme: light; color: #2d405a; font: 13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
    * { box-sizing: border-box; } [hidden] { display: none !important; }
    .panel { position: absolute; pointer-events: auto; display: flex; flex-direction: column; min-width: 0; overflow: hidden; border: 1px solid #c9d7e9; border-radius: 13px; background: #fff; box-shadow: 0 10px 34px #19344f2b,0 2px 8px #19344f12; }
    .head { flex: none; display: flex; align-items: center; gap: 7px; padding: 3px 11px; border-bottom: 1px solid #e5edf6; background: linear-gradient(115deg,#f0f5ff,#fbfdff); cursor: move; user-select: none; touch-action: none; }
    .brand { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; background: #e1ebfd; color: #3865ab; font-size: 14px; font-weight: 700; }
    .title { min-width: 0; flex: 1; display: flex; align-items: baseline; gap: 7px; font-weight: 700; font-size: 13px; line-height: 1.3; color: #304f78; }
    .title span, .subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title span { flex-shrink: 0; max-width: 100%; }
    .subtitle { color: #8090a6; font-size: 10px; font-weight: 400; }
    button { appearance: none; font: inherit; color: #4a6281; border: 1px solid #d4dfed; background: #fff; border-radius: 6px; padding: 4px 8px; line-height: 1.4; cursor: pointer; white-space: nowrap; }
    button:hover { background: #eff5ff; border-color: #a5bcdf; } button:focus-visible { outline: 2px solid #3b72d4; outline-offset: 2px; } button:disabled { opacity: .45; cursor: default; }
    .head button { display: grid; place-items: center; flex: none; width: 26px; height: 26px; padding: 0; line-height: 1; }
    .close { border: 0; background: transparent; font-size: 19px; color: #7b8ba0; }
    .pin { border-color: transparent; background: transparent; }
    .pin[aria-pressed="true"] { color: #3266b7; background: #e1ebfd; border-color: #a5bcdf; }
    .body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; min-height: 0; padding: 10px 13px 12px; user-select: text; }
    .selection { color: #71839d; font-size: 11px; line-height: 1.55; padding: 0 0 8px; border-bottom: 1px solid #eef2f7; margin-bottom: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .status { color: #7d8da4; font-size: 11px; line-height: 1.6; } .status[data-phase="error"],.status[data-phase="interrupted"] { color: #ad5935; }
    .output { font-size: 14px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; margin-top: 5px; }
    .answer-label { font-size: 11px; font-weight: 700; line-height: 1.5; color: #8190a5; margin-bottom: 4px; white-space: normal; }
    .details { margin-top: 13px; padding: 10px 11px; border-left: 3px solid #aac3eb; border-radius: 0 7px 7px 0; background: #f3f7fd; } .details .answer-label { color: #4e70a3; }
    .foot { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 5px; padding: 8px 11px; border-top: 1px solid #e8eef5; background: #fcfdff; } .foot button { font-size: 11px; }
    .expand { margin-left: auto; color: #3266b7; } .copy { color: #3266b7; }
    .resize { position: absolute; touch-action: none; user-select: none; }
    .resize[data-edge="n"], .resize[data-edge="s"] { height: 5px; left: 12px; right: 12px; cursor: ns-resize; }
    .resize[data-edge="e"], .resize[data-edge="w"] { width: 5px; top: 12px; bottom: 12px; cursor: ew-resize; }
    .resize[data-edge^="n"] { top: 0; } .resize[data-edge^="s"] { bottom: 0; }
    .resize[data-edge$="e"] { right: 0; } .resize[data-edge$="w"] { left: 0; }
    .resize.corner { width: 12px; height: 12px; cursor: nesw-resize; }
    .resize[data-edge="nw"], .resize[data-edge="se"] { cursor: nwse-resize; }
    .resize[data-edge="se"] { width: 15px; height: 15px; }
    .resize[data-edge="se"]::after { content: ''; position: absolute; right: 4px; bottom: 4px; width: 6px; height: 6px; border-right: 1px solid #7b8ba0; border-bottom: 1px solid #7b8ba0; border-radius: 0 0 3px 0; }
    @media(max-width:320px) { .head { padding-inline: 8px; } .body { padding: 8px 10px; } .foot { padding: 7px 8px; } .expand { margin-left: 0; } }
  `;
  const panel = element('section', 'panel'); panel.setAttribute('aria-label', mode === 'explain' ? '结合本文解释' : '中文翻译'); panel.dataset.requestId = message.requestId;
  const head = element('div', 'head');
  const brand = element('span', 'brand', mode === 'explain' ? '解' : '译'); brand.setAttribute('aria-hidden', 'true');
  const title = element('div', 'title');
  title.append(element('span', '', mode === 'explain' ? '结合本文解释' : '中文翻译'), element('small', 'subtitle', '阅窗 · 就近阅读'));
  const pinButton = button('', 'pin', () => {
    const { left, top } = panel.getBoundingClientRect();
    if (!pinned) layout = { ...layout, left, top };
    pinned = !pinned;
    updatePin(); position();
    void persistLayout();
  });
  pinButton.className = 'pin'; pinButton.setAttribute('aria-label', '固定回答位置');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '16'); icon.setAttribute('height', '16'); icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(icon.namespaceURI, 'path');
  path.setAttribute('d', 'M16 3l5 5-3 1-4 4v4l-2 2-3.5-3.5L4 20l-1-1 4.5-4.5L4 11l2-2h4l4-4 1-3z');
  path.setAttribute('fill', 'currentColor'); icon.append(path); pinButton.append(icon);
  const close = button('×', 'close', () => actions.command('context:close')); close.className = 'close'; close.setAttribute('aria-label', '关闭回答');
  head.append(brand, title, pinButton, close);
  const body = element('div', 'body');
  const quote = element('div', 'selection');
  const selected = message.snapshot?.text ?? message.selectionText ?? '';
  quote.textContent = selected.length > 145 ? `${selected.slice(0, 145)}…` : selected; quote.hidden = !selected;
  const status = element('div', 'status', message.error || '正在结合所在段落准备回答…'); status.dataset.phase = message.error ? 'error' : 'reading'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const output = element('div', 'output'); output.setAttribute('data-context-output', '');
  const saveNote = element('div', 'status'); saveNote.hidden = true; saveNote.setAttribute('role', 'status'); saveNote.setAttribute('data-context-save-status', '');
  const core = element('section', 'core'); const coreLabel = element('div', 'answer-label', mode === 'translate' ? '译文' : '核心解释'); const coreOutput = element('div'); coreOutput.setAttribute('data-context-core', '');
  core.append(coreLabel, coreOutput);
  const details = element('section', 'details'); const detailsLabel = element('div', 'answer-label'); const detailsOutput = element('div'); detailsOutput.setAttribute('data-context-details', '');
  details.append(detailsLabel, detailsOutput); output.append(core, details);
  body.append(quote, status, output, saveNote);
  const foot = element('div', 'foot');
  const stop = button('停止', 'stop', () => actions.command('context:stop'));
  const copy = button('复制', 'copy', async () => {
    if (!answer) return;
    const selection = (shadow as ShadowRoot & { getSelection?(): Selection | null }).getSelection?.();
    const selectedText = selection && body.contains(selection.anchorNode) && body.contains(selection.focusNode) ? selection.toString() : '';
    try { await navigator.clipboard.writeText(selectedText || answer); copy.textContent = '已复制'; }
    catch { status.textContent = '复制未获允许，可选中回答文字复制。'; }
  }); copy.className = 'copy';
  const retry = button('重试', 'retry', () => { transitioning = true; updateControls(); actions.command('context:retry'); });
  const save = button('收藏', 'save', () => { saving = true; updateControls(); actions.command('context:save'); });
  const library = button('收藏夹', 'library', () => actions.command('context:open-phrases'));
  const expand = button(exampleKind === 'bilingual' ? '双语例句' : '用法示例', 'expand', () => { transitioning = true; updateControls(); actions.command('context:expand'); }); expand.className = 'expand';
  foot.append(stop, copy, save, retry, expand, library); panel.append(head, body, foot); shadow.append(style, panel);
  document.documentElement.append(host);
  function updateControls(): void {
    stop.disabled = !connected || !busy || transitioning;
    copy.disabled = !answer;
    retry.disabled = !connected || busy || transitioning || !message.snapshot;
    save.disabled = !connected || busy || transitioning || saving || saved || phase !== 'done' || !coreText.trim();
    save.textContent = saving ? '保存中…' : saved ? '已收藏' : savedId ? '更新收藏' : '收藏';
    library.disabled = !connected || transitioning;
    expand.disabled = !connected || busy || transitioning || !canExpand || expanded;
    expand.hidden = expanded || !exampleKind || !!message.error;
    expand.textContent = exampleKind === 'bilingual' ? '双语例句' : '用法示例';
  }
  function renderAnswer(): void {
    core.hidden = !coreText;
    updateOutput(coreOutput, coreText);
    details.hidden = !detailsText;
    updateOutput(detailsOutput, detailsText);
    updateOutput(detailsLabel, exampleKind === 'bilingual' ? '双语例句' : '用法示例');
  }
  function updatePin(): void {
    pinButton.setAttribute('aria-pressed', String(pinned));
    pinButton.title = pinned ? '取消固定' : '固定在当前位置';
  }
  async function persistLayout(): Promise<void> {
    const choice = pinned ? layout ?? null : null;
    if (!await actions.savePin(choice) && choice === (pinned ? layout : null)) status.textContent = '固定位置或尺寸保存失败。';
  }
  function viewportBounds() {
    const viewport = window.visualViewport;
    const width = viewport?.width ?? innerWidth;
    const height = viewport?.height ?? innerHeight;
    const offsetLeft = viewport?.offsetLeft ?? 0;
    const offsetTop = viewport?.offsetTop ?? 0;
    const gutter = Math.min(12, Math.max(2, width / 12));
    return { width, height, offsetLeft, offsetTop, gutter, left: offsetLeft + gutter, top: offsetTop + gutter,
      right: offsetLeft + width - gutter, bottom: offsetTop + height - gutter };
  }
  function position(): void {
    const { width, height, offsetLeft, offsetTop, gutter, left, top, right, bottom } = viewportBounds();
    const initial = placeContextPanel(anchor, width, height);
    const panelWidth = Math.min(layout?.width ?? initial.width, Math.max(0, right - left));
    panel.style.width = `${panelWidth}px`;
    if (layout) {
      const availableHeight = Math.max(0, height - gutter * 2);
      const maxHeight = layout.height === undefined ? initial.maxHeight : availableHeight;
      const minHeight = Math.min(maxHeight, head.offsetHeight + foot.offsetHeight + 32);
      const requiredHeight = layout.height === undefined ? minHeight : clamp(layout.height, minHeight, maxHeight);
      const panelTop = clamp(layout.top, top, bottom - requiredHeight);
      panel.style.height = layout.height === undefined ? '' : `${requiredHeight}px`;
      panel.style.left = `${clamp(layout.left, left, right - panelWidth)}px`;
      panel.style.top = `${panelTop}px`;
      panel.style.maxHeight = `${Math.min(maxHeight, Math.max(0, bottom - panelTop))}px`;
      return;
    }
    panel.style.maxHeight = `${initial.maxHeight}px`;
    // Measure after setting width, since wrapping changes the panel's height.
    const placed = placeContextPanel(anchor, width, height, panel.getBoundingClientRect().height);
    panel.style.left = `${placed.left + offsetLeft}px`; panel.style.top = `${placed.top + offsetTop}px`;
  }
  function enableGesture(handle: HTMLElement, edge = ''): void {
    let gesture: { id: number; x: number; y: number; rect: DOMRect; moved: boolean } | undefined;
    handle.addEventListener('pointerdown', event => {
      if (!event.isTrusted || !event.isPrimary || event.button !== 0 || (event.target as Element).closest('button')) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, rect: panel.getBoundingClientRect(), moved: false };
    });
    handle.addEventListener('pointermove', event => {
      if (!event.isTrusted || !gesture || event.pointerId !== gesture.id) return;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      if (!gesture.moved && !dx && !dy) return;
      gesture.moved = true;
      const rect = gesture.rect;
      const bounds = viewportBounds();
      if (!edge) {
        layout = { ...layout, left: clamp(rect.left + dx, bounds.left, bounds.right - rect.width),
          top: clamp(rect.top + dy, bounds.top, bounds.bottom - rect.height) };
      } else {
        const minWidth = Math.min(240, rect.width);
        const minHeight = Math.min(rect.height, head.offsetHeight + foot.offsetHeight + 32);
        const left = edge.includes('w') ? clamp(rect.left + dx, bounds.left, rect.right - minWidth) : rect.left;
        const right = edge.includes('e') ? clamp(rect.right + dx, rect.left + minWidth, bounds.right) : rect.right;
        const top = edge.includes('n') ? clamp(rect.top + dy, bounds.top, rect.bottom - minHeight) : rect.top;
        const bottom = edge.includes('s') ? clamp(rect.bottom + dy, rect.top + minHeight, bounds.bottom) : rect.bottom;
        layout = { left, top, width: right - left, height: bottom - top };
      }
      position();
    });
    handle.addEventListener('lostpointercapture', event => {
      if (!event.isTrusted || !gesture || event.pointerId !== gesture.id) return;
      const moved = gesture.moved;
      gesture = undefined;
      if (moved && pinned) void persistLayout();
    });
  }
  enableGesture(head);
  for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    const handle = element('div', edge.length === 2 ? 'resize corner' : 'resize');
    handle.dataset.edge = edge; handle.setAttribute('aria-hidden', 'true');
    panel.append(handle); enableGesture(handle, edge);
  }
  const resize = new ResizeObserver(position); resize.observe(panel);
  window.addEventListener('resize', position);
  window.visualViewport?.addEventListener('resize', position);
  window.visualViewport?.addEventListener('scroll', position);
  renderAnswer(); updateControls(); updatePin(); position();
  return {
    isPinned(): boolean { return pinned; },
    layout(): ContextPanelPin | undefined { return layout; },
    contains(event: Event): boolean { return event.composedPath().includes(host); },
    remove(): void {
      resize.disconnect(); window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position); window.visualViewport?.removeEventListener('scroll', position); host.remove();
    },
    setState(state: ContextState): void {
      if (state.requestId !== message.requestId || state.mode !== mode) return;
      answer = state.text; coreText = state.coreText ?? (state.expanded ? coreText : state.text); detailsText = state.detailsText ?? ''; copy.textContent = '复制';
      busy = state.status === 'reading' || state.status === 'running'; expanded = state.expanded; canExpand = state.canExpand; exampleKind = state.exampleKind ?? exampleKind;
      phase = state.status; saved = !!state.saved; saving = !!state.saving; savedId = state.savedId;
      saveNote.textContent = state.saveError ? `收藏失败：${state.saveError}` : saved ? '已保存到本机收藏夹。' : '';
      saveNote.hidden = !saveNote.textContent;
      status.dataset.phase = state.status;
      status.textContent = state.status === 'reading' ? '正在读取选区与所在段落…' : state.status === 'running' ? expanded ? exampleKind === 'bilingual' ? '正在补充双语例句…' : '正在补充用法示例…' : '正在生成回答…' : state.status === 'done' ? expanded ? exampleKind === 'bilingual' ? '双语例句已完成' : '用法示例已完成' : '回答已完成' : state.status === 'cancelled' ? '已停止，可继续阅读或重试。' : state.error || '回答失败，请检查设置后重试。';
      renderAnswer(); updateControls(); position();
    },
    cancelled(): void { phase = 'cancelled'; busy = false; canExpand = false; status.dataset.phase = 'cancelled'; status.textContent = '已停止，可继续阅读或重试。'; updateControls(); },
    interrupted(): void { connected = false; saving = false; busy = false; status.dataset.phase = 'interrupted'; status.textContent = '回答连接已中断。请重新选择文字后查阅。'; updateControls(); },
  };
}

function updateOutput(node: HTMLElement, text: string): void {
  const existing = node.textContent ?? '';
  if (text === existing) return;
  // Streaming deltas must leave the reader's existing text selection intact.
  if (node.firstChild instanceof Text && text.startsWith(existing)) node.firstChild.appendData(text.slice(existing.length));
  else node.textContent = text;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
}
function button(label: string, action: string, handler: () => void | Promise<void>): HTMLButtonElement {
  const node = element('button', '', label); node.type = 'button'; node.dataset.contextAction = action;
  // Keeping focus in the article avoids a button click collapsing its selection
  // or scrolling a focused control into view. Keyboard activation remains native.
  node.addEventListener('mousedown', event => { if (event.isTrusted) event.preventDefault(); });
  node.addEventListener('click', event => { if (event.isTrusted) void handler(); }); return node;
}
