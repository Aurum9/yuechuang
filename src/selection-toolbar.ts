import type { ContextMode, ContextRect } from './context-shared';

export interface SelectionToolbarActions { start(mode: ContextMode): void; hidePage(): void; hideSite(): Promise<void> }

/** Keep the compact toolbar beside the selection in the selected frame. */
export function placeSelectionToolbar(rect: ContextRect, viewportWidth: number, viewportHeight: number, width = 202, height = 40) {
  const gutter = Math.min(8, Math.max(2, viewportWidth / 16));
  const actualWidth = Math.max(0, Math.min(width, viewportWidth - gutter * 2));
  const left = Math.max(gutter, Math.min(rect.x + rect.width / 2 - actualWidth / 2, viewportWidth - actualWidth - gutter));
  const above = rect.y - height - 7;
  const below = rect.y + Math.max(0, rect.height) + 7;
  const top = above >= gutter ? above : Math.max(gutter, Math.min(below, viewportHeight - height - gutter));
  return { left, top, width: actualWidth, visible: viewportWidth >= 155 && viewportHeight >= 56 };
}

export function createSelectionToolbar(captureId: string, rect: ContextRect, actions: SelectionToolbarActions) {
  const host = document.createElement('local-reader-selection-toolbar');
  host.setAttribute('data-local-reader-root', 'selection-toolbar');
  host.dataset.captureId = captureId;
  for (const [key, value] of Object.entries({ position: 'fixed', inset: '0', 'z-index': '2147483647', 'pointer-events': 'none', margin: '0', padding: '0', border: '0', display: 'block', visibility: 'visible' })) host.style.setProperty(key, value, 'important');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; color-scheme: dark; font: 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
    * { box-sizing: border-box; } [hidden] { display: none !important; }
    .toolbar { position: absolute; pointer-events: auto; width: 202px; padding: 4px; color: #f4f4f7; background: #1e1f25; border: 1px solid #393b43; border-radius: 10px; box-shadow: 0 5px 18px #11152232; user-select: none; }
    .actions { display: flex; align-items: center; gap: 2px; }
    button { appearance: none; font: inherit; display: flex; flex: 1; min-width: 0; justify-content: center; align-items: center; gap: 7px; height: 30px; padding: 5px 9px; color: inherit; background: transparent; border: 0; border-radius: 6px; cursor: pointer; white-space: nowrap; }
    button:hover { background: #363842; } button:focus-visible { outline: 2px solid #a2baff; outline-offset: -2px; }
    .glyph { color: #d1d5df; font-size: 15px; line-height: 1; flex: none; } .label { overflow: hidden; text-overflow: ellipsis; }
    .divider { flex: none; width: 1px; height: 15px; background: #41434c; margin: 0 2px; }
    .close { flex: none; width: 26px; padding: 3px; color: #b9bdc9; font-size: 20px; }
    .hide-options { margin-top: 4px; padding-top: 4px; border-top: 1px solid #41434c; }
    .hide-options button { width: 100%; height: auto; min-height: 30px; justify-content: start; white-space: normal; text-align: left; }
    .hide-error { margin: 4px 9px; color: #f4b8a8; }
  `;
  const bar = document.createElement('div'); bar.className = 'toolbar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '选中文字');
  const row = document.createElement('div'); row.className = 'actions';
  const options = document.createElement('div'); options.id = 'hide-options'; options.className = 'hide-options'; options.hidden = true;
  const error = document.createElement('p'); error.className = 'hide-error'; error.setAttribute('role', 'status'); error.hidden = true;
  const makeButton = (action: string, label: string, activate: () => void, glyph?: string) => {
    const node = document.createElement('button'); node.type = 'button'; node.dataset.selectionAction = action;
    if (glyph) { const symbol = document.createElement('span'); symbol.className = 'glyph'; symbol.setAttribute('aria-hidden', 'true'); symbol.textContent = glyph; node.append(symbol); }
    const text = document.createElement('span'); text.className = 'label'; text.textContent = label; node.append(text);
    node.addEventListener('mousedown', event => { if (event.isTrusted) event.preventDefault(); });
    node.addEventListener('click', event => { if (event.isTrusted) activate(); });
    return node;
  };
  const divider = document.createElement('span'); divider.className = 'divider'; divider.setAttribute('aria-hidden', 'true');
  const close = makeButton('close', '×', () => {
    options.hidden = !options.hidden;
    close.setAttribute('aria-expanded', String(!options.hidden));
    position();
  });
  close.className = 'close'; close.setAttribute('aria-label', '隐藏选项'); close.setAttribute('aria-expanded', 'false'); close.setAttribute('aria-controls', options.id);
  const hideSite = makeButton('hide-site', '对此网站永久隐藏', () => {
    hideSite.disabled = true;
    error.hidden = true;
    void actions.hideSite().catch(() => {
      error.textContent = '隐藏网站失败，请重试。'; error.hidden = false; position();
    }).finally(() => { hideSite.disabled = false; });
  });
  row.append(makeButton('translate', '翻译', () => actions.start('translate'), '文'), makeButton('explain', '解释', () => actions.start('explain'), '✧'), divider, close);
  options.append(makeButton('hide-page', '暂时隐藏，刷新后恢复', actions.hidePage), hideSite, error);
  bar.append(row, options);
  shadow.append(style, bar); document.documentElement.append(host);
  const position = () => {
    const viewport = window.visualViewport;
    const result = placeSelectionToolbar(rect, viewport?.width ?? innerWidth, viewport?.height ?? innerHeight, 202, bar.getBoundingClientRect().height || 40);
    bar.hidden = !result.visible;
    bar.style.width = `${result.width}px`; bar.style.left = `${result.left + (viewport?.offsetLeft ?? 0)}px`; bar.style.top = `${result.top + (viewport?.offsetTop ?? 0)}px`;
  };
  window.addEventListener('resize', position); window.visualViewport?.addEventListener('resize', position); position();
  return { remove(): void { window.removeEventListener('resize', position); window.visualViewport?.removeEventListener('resize', position); host.remove(); } };
}
