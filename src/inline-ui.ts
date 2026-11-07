import { READER_ROOT_ATTRIBUTE } from './extract';
import type { Article, SummaryPlan } from './shared';

export type Phase = 'ready' | 'reading' | 'running' | 'confirming' | 'done' | 'cancelled' | 'error' | 'interrupted';
interface Actions { summarize(): void; reread(): void; confirm(): void; stop(): void; close(): void; openTab(): void; settings(): void }

export function createInlinePanel(actions: Actions) {
  let summary = '';
  let frame: HTMLIFrameElement | undefined;
  let frameTimeout: ReturnType<typeof setTimeout> | undefined;
  let pageStatus: 'loading' | 'ready' | 'error' = 'loading';
  let collapsed = false;
  let summaryCollapsed = false;
  const host = document.createElement('local-reader-preview');
  host.setAttribute(READER_ROOT_ATTRIBUTE, 'preview');
  for (const [key, value] of Object.entries({ position: 'fixed', inset: '0', 'z-index': '2147483647', 'pointer-events': 'none', margin: '0', padding: '0', border: '0', display: 'block' })) host.style.setProperty(key, value, 'important');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; color-scheme: light; color: #233248; font: 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
    * { box-sizing: border-box; } [hidden] { display: none !important; }
    .scrim { position: fixed; inset: 0; pointer-events: none; background: #19314a0b; backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px); opacity: 0; transition: opacity 180ms ease; }
    .scrim.active { opacity: 1; }
    .panel { position: absolute; top: 22px; right: 24px; width: min(600px,calc(100vw - 48px)); height: min(860px,calc(100dvh - 44px)); display: flex; flex-direction: column; pointer-events: auto; border: 1px solid #c8d5e6; border-radius: 17px; overflow: hidden; background: #fff; box-shadow: 0 20px 70px #11274138,0 3px 12px #11274114; }
    .panel.collapsed { width: min(360px,calc(100vw - 48px)); height: auto; }
    .head { display: flex; align-items: center; gap: 7px; flex: none; padding: 11px 13px; background: linear-gradient(110deg,#f1f6ff,#f9fbff); border-bottom: 1px solid #e2eaf3; }
    .brand { width: 27px; height: 27px; display: grid; place-items: center; color: #3465bb; background: #e4edfd; border-radius: 8px; font-size: 18px; }
    .name { flex: 1; min-width: 0; font-weight: 700; font-size: 14px; color: #243e63; } .mode { display: block; font-size: 10px; font-weight: 400; color: #73839b; }
    button { appearance: none; font: inherit; line-height: 1.45; color: #475a74; border: 1px solid #d3deec; background: #fff; border-radius: 7px; padding: 5px 9px; cursor: pointer; white-space: nowrap; }
    button:hover { background: #eff5ff; border-color: #9fb9e2; } button:focus-visible { outline: 2px solid #3d6fd4; outline-offset: 2px; } button:disabled { opacity: .45; cursor: default; }
    .icon { padding: 2px 8px; font-size: 18px; line-height: 1.5; } .primary { color: #fff; background: #3267c4; border-color: #3267c4; } .primary:hover { background: #2458b3; }
    .content { display: flex; flex: 1; min-height: 0; flex-direction: column; }
    .location { padding: 8px 13px 7px; flex: none; border-bottom: 1px solid #e8eef5; background: #fff; }
    .target-title { color: #314967; font-size: 12px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .url { color: #7b899d; font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; user-select: text; margin-top: 1px; }
    .page-status { font-size: 11px; color: #7c8ba1; line-height: 1.5; padding-top: 3px; overflow-wrap: anywhere; } .page-status[data-state="error"] { color: #ae5d2b; }
    .frame-wrap { flex: 1; min-height: 110px; background: #f7f9fc; position: relative; overflow: hidden; }
    iframe { width: 100%; height: 100%; display: block; border: 0; background: #fff; }
    .placeholder { position: absolute; inset: 0; display: grid; place-content: center; gap: 9px; text-align: center; padding: 24px; color: #8998ac; font-size: 13px; }
    .placeholder .symbol { font-size: 30px; color: #b4c6e1; }
    .summary { flex: none; height: clamp(230px,34vh,340px); min-height: 0; display: flex; flex-direction: column; border-top: 1px solid #d7e3f3; background: #fcfdff; }
    .summary.collapsed { height: auto; }
    .summary-head { display: flex; align-items: center; gap: 6px; padding: 9px 12px; flex: none; border-bottom: 1px solid #edf1f7; }
    .summary-label { color: #304e76; font-weight: 700; font-size: 13px; flex: 1; min-width: 0; }
    .summary-head button { font-size: 11px; padding: 4px 8px; }
    .summary-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 10px 14px 12px; }
    .status { font-size: 12px; line-height: 1.6; color: #6b7d95; } .status[data-phase="error"],.status[data-phase="interrupted"] { color: #ac512f; }
    .coverage { color: #71829b; font-size: 11px; margin-top: 3px; }
    .notice { font-size: 12px; color: #9b6823; background: #fff7e7; border: 1px solid #f4e3c4; padding: 7px 9px; border-radius: 7px; margin-top: 7px; line-height: 1.5; }
    .plan { background: #f0f5ff; border: 1px solid #dce6fa; color: #42628f; font-size: 12px; line-height: 1.6; border-radius: 8px; padding: 9px 10px; margin-top: 8px; }
    .confirm { display: flex; align-items: center; gap: 8px; margin-top: 7px; } .confirm small { color: #788aa4; font-size: 11px; }
    .output { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.8; color: #2d405a; margin: 10px 0 0; user-select: text; }
    .foot { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 7px 12px; border-top: 1px solid #e8eef5; background: #fff; }
    .foot button { font-size: 11px; padding: 4px 8px; } .privacy { font-size: 10px; color: #91a0b4; margin-left: auto; }
    @media(max-width:650px) { .panel { right: 12px; top: 12px; width: calc(100vw - 24px); height: calc(100dvh - 24px); } .panel.collapsed { width: calc(100vw - 24px); } .head { padding: 9px 10px; } .summary-head { flex-wrap: wrap; padding: 8px 10px; gap: 5px; } .summary-label { flex-basis: 100%; } .summary { height: min(40vh,300px); } .privacy { flex-basis: 100%; margin-left: 0; } }
    @media(prefers-reduced-motion:reduce) { .scrim { transition: none; } }
  `;
  const scrim = el('div', 'scrim'); scrim.setAttribute('aria-hidden', 'true');
  const pane = el('section', 'panel'); pane.setAttribute('aria-label', '链接预览与摘要');
  const hover = (value: boolean) => scrim.classList.toggle('active', value);
  pane.addEventListener('pointerenter', () => hover(true)); pane.addEventListener('pointerleave', () => hover(false));
  const head = el('div', 'head');
  const brand = el('span', 'brand', '↗'); brand.setAttribute('aria-hidden', 'true');
  const name = el('div', 'name', '链接预览');
  const mode = el('small', 'mode', '真实网页 · 手动总结'); name.append(mode);
  const content = el('div', 'content');
  const collapse = button('收起', 'collapse', () => { collapsed = !collapsed; pane.classList.toggle('collapsed', collapsed); content.hidden = collapsed; foot.hidden = collapsed; collapse.textContent = collapsed ? '展开' : '收起'; collapse.setAttribute('aria-expanded', String(!collapsed)); }); collapse.setAttribute('aria-expanded', 'true');
  const close = button('×', 'close', actions.close); close.className = 'icon'; close.setAttribute('aria-label', '关闭预览');
  head.append(brand, name, collapse, close);
  const locationBar = el('div', 'location');
  const title = el('div', 'target-title', '正在打开链接'); const url = el('div', 'url');
  const page = el('div', 'page-status', '正在加载真实网页…'); page.dataset.state = 'loading';
  locationBar.append(title, url, page);
  const frameWrap = el('div', 'frame-wrap');
  const placeholder = el('div', 'placeholder'); placeholder.append(el('div', 'symbol', '↗'), el('div', '', '正在打开目标网页…')); frameWrap.append(placeholder);
  const summaryPane = el('section', 'summary'); summaryPane.setAttribute('aria-label', '中文摘要');
  const summaryHead = el('div', 'summary-head'); const summaryBody = el('div', 'summary-body');
  const generate = button('总结', 'summarize', actions.summarize); generate.className = 'primary';
  const stop = button('停止', 'stop', actions.stop); stop.disabled = true;
  const reread = button('重新读取', 'reread', actions.reread);
  const foldSummary = button('收起摘要', 'collapse-summary', () => { summaryCollapsed = !summaryCollapsed; summaryPane.classList.toggle('collapsed', summaryCollapsed); summaryBody.hidden = summaryCollapsed; foldSummary.textContent = summaryCollapsed ? '展开摘要' : '收起摘要'; foldSummary.setAttribute('aria-expanded', String(!summaryCollapsed)); });
  foldSummary.setAttribute('aria-expanded', 'true');
  summaryHead.append(el('div', 'summary-label', '中文摘要'), generate, stop, reread, foldSummary);
  const status = el('div', 'status', '点击“总结”后发送当前已加载正文。'); status.dataset.phase = 'ready'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const coverage = el('div', 'coverage'); coverage.hidden = true;
  const notice = el('div', 'notice'); notice.hidden = true;
  const planBox = el('div', 'plan'); planBox.hidden = true;
  const planText = el('div', 'plan-text'); const confirmRow = el('div', 'confirm');
  const confirm = button('全文分段总结', 'confirm-sections', actions.confirm); confirm.className = 'primary';
  confirmRow.append(confirm, el('small', '', '将按预计次数调用当前模型')); planBox.append(planText, confirmRow);
  const output = el('div', 'output'); output.setAttribute('data-reader-output', '');
  summaryBody.append(status, coverage, notice, planBox, output); summaryPane.append(summaryHead, summaryBody);
  content.append(locationBar, frameWrap, summaryPane);
  const foot = el('div', 'foot');
  const copy = button('复制摘要', 'copy', async () => {
    if (!summary) return;
    try { await navigator.clipboard.writeText(summary); copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制摘要'; }, 1_500); }
    catch { status.textContent = '复制未获允许，可直接选择摘要文字复制。'; }
  }); copy.disabled = true;
  foot.append(copy, button('在标签页打开', 'open-tab', actions.openTab), button('设置', 'settings', actions.settings), el('span', 'privacy', '摘要使用当前模型连接 · 当前已加载内容'));
  pane.append(head, content, foot); shadow.append(style, scrim, pane); document.documentElement.append(host);

  function clearFrame(): void { if (frameTimeout) clearTimeout(frameTimeout); frameTimeout = undefined; frame?.remove(); frame = undefined; placeholder.hidden = false; }
  function setTarget(nextTitle: string | undefined, nextUrl: string): void {
    url.textContent = nextUrl; url.title = nextUrl;
    if (nextTitle) { title.textContent = nextTitle; title.title = nextTitle; }
  }
  function setPage(next: typeof pageStatus, error?: string): void {
    pageStatus = next; page.dataset.state = next;
    page.textContent = next === 'loading' ? '正在加载真实网页…' : next === 'ready' ? '原网页已就绪，可浏览并按需总结' : error || '页面未能确认加载。网站可能限制嵌入或缺少权限，可在标签页打开。';
    if (next !== 'loading' && frameTimeout) { clearTimeout(frameTimeout); frameTimeout = undefined; }
  }
  return {
    remove: () => { clearFrame(); host.remove(); },
    prepare: (targetUrl: string) => {
      clearFrame(); collapsed = false; pane.classList.remove('collapsed'); content.hidden = false; foot.hidden = false; collapse.textContent = '收起'; collapse.setAttribute('aria-expanded', 'true');
      title.textContent = '目标原网页'; setTarget(undefined, targetUrl); setPage('loading'); hover(false);
    },
    load: (id: string, targetUrl: string) => {
      clearFrame();
      frame = document.createElement('iframe');
      frame.name = `local-reader-${id}`; frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
      frame.setAttribute('title', '链接目标原网页'); frame.referrerPolicy = 'no-referrer';
      frame.addEventListener('pointerenter', () => hover(true)); frame.src = targetUrl;
      placeholder.hidden = true; frameWrap.append(frame);
      frameTimeout = setTimeout(() => { if (pageStatus === 'loading') setPage('error', '页面尚未确认可读取，可能加载较慢、限制嵌入或缺少权限。可继续等待或在标签页打开。'); }, 12_000);
    },
    setTarget, setPage,
    setAutomatic: (automatic: boolean) => { mode.textContent = `真实网页 · ${automatic ? '自动总结已开启' : '手动总结'}`; },
    setText: (text: string) => { summary = text; output.textContent = text; copy.disabled = !text; },
    clearArticle: () => { coverage.hidden = true; coverage.textContent = ''; notice.hidden = true; notice.textContent = ''; },
    setArticle: (article: Omit<Article, 'text'>) => {
      setTarget(article.title, article.url);
      coverage.hidden = false; coverage.textContent = `已读取 ${article.originalLength.toLocaleString()} 字符 · 当前已加载正文`;
      const text = article.notice || (article.truncated ? '本文存在截取范围，本次摘要仅覆盖实际读取到的内容。' : article.coverage === 'partial' ? '本次仅处理当前已加载部分，未读取分页或尚未加载内容。' : '');
      notice.textContent = text; notice.hidden = !text;
    },
    setPlan: (plan: SummaryPlan | undefined, needsConfirmation: boolean) => {
      planBox.hidden = !plan; confirmRow.hidden = !needsConfirmation;
      planText.textContent = !plan ? '' : plan.requests === 0 ? '会话缓存命中 · 本次不产生模型调用' : plan.strategy === 'sections' ? `长文分为 ${plan.segments} 节，预计 ${plan.requests} 次模型调用（含整合）；输入约 ${plan.estimatedTokens.toLocaleString()} tokens。` : `预计 1 次模型调用 · 正文 ${plan.characters.toLocaleString()} 字符`;
    },
    setState: (next: Phase, text: string) => {
      status.dataset.phase = next; status.textContent = text;
      const busy = next === 'reading' || next === 'running';
      generate.disabled = busy; generate.textContent = next === 'reading' ? '读取中' : next === 'running' ? '生成中' : ['error', 'cancelled', 'interrupted'].includes(next) ? '重试总结' : '总结';
      stop.disabled = !busy && next !== 'confirming'; reread.disabled = next === 'reading'; confirm.disabled = busy;
    }
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
}
function button(label: string, action: string, handler: () => void | Promise<void>): HTMLButtonElement {
  const node = el('button', '', label); node.type = 'button'; node.dataset.readerAction = action;
  node.addEventListener('click', event => { if (event.isTrusted) void handler(); }); return node;
}
