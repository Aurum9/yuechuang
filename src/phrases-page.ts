import './phrases-page.css';
import './panel-embed';

interface SavedPhrase {
  id: string;
  text: string;
  context: string;
  sourceTitle: string;
  sourceUrl: string;
  mode: 'translate' | 'explain';
  coreText: string;
  detailsText: string;
  exampleKind?: 'bilingual' | 'usage';
  createdAt: number;
  updatedAt: number;
}
type FilterMode = 'all' | SavedPhrase['mode'];

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少收藏页元素：${id}`);
  return node as T;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

const search = element<HTMLInputElement>('search');
const entriesRoot = element<HTMLDivElement>('entries');
const emptyState = element<HTMLDivElement>('empty-state');
const exportScope = element<HTMLSelectElement>('export-scope');
const deleteDialog = element<HTMLDialogElement>('delete-dialog');
const feedback = element<HTMLDivElement>('feedback');
let entries: SavedPhrase[] = [];
let filtered: SavedPhrase[] = [];
let filterMode: FilterMode = 'all';
let loaded = false;
let loading = false;
let deleting = false;
let pendingDelete: SavedPhrase | undefined;

async function message(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response: unknown = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response || typeof response !== 'object' || !('ok' in response)) throw new Error('扩展后台未响应，请重新加载扩展后重试。');
  if (response.ok !== true) throw new Error('error' in response && typeof response.error === 'string' ? response.error : '操作未完成，请重试。');
  return response as Record<string, unknown>;
}

// Copy only phrase fields. Configuration and credentials can never enter an export.
function readEntry(value: unknown): SavedPhrase | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.id !== 'string' || !input.id || typeof input.text !== 'string' || !['translate', 'explain'].includes(String(input.mode))) return undefined;
  if (typeof input.createdAt !== 'number' || !Number.isFinite(new Date(input.createdAt).getTime()) || typeof input.updatedAt !== 'number' || !Number.isFinite(new Date(input.updatedAt).getTime())) return undefined;
  const text = (key: string): string => typeof input[key] === 'string' ? input[key] as string : '';
  const exampleKind = input.exampleKind === 'bilingual' || input.exampleKind === 'usage' ? input.exampleKind : undefined;
  return { id: input.id, text: input.text, context: text('context'), sourceTitle: text('sourceTitle'), sourceUrl: text('sourceUrl'), mode: input.mode as SavedPhrase['mode'], coreText: text('coreText'), detailsText: text('detailsText'), ...(exampleKind ? { exampleKind } : {}), createdAt: input.createdAt, updatedAt: input.updatedAt };
}

function sourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return url.href;
  } catch { /* Invalid source URLs stay as plain text. */ }
  return undefined;
}

function dateText(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }) : '日期未知';
}

function report(text: string, error = false): void {
  feedback.textContent = text;
  feedback.classList.toggle('feedback-error', error);
  feedback.hidden = false;
}

function detailsBlock(title: string, text: string, className: string): HTMLDetailsElement {
  const details = node('details', className);
  details.append(node('summary', '', title), node('p', 'preserve-text', text));
  return details;
}

function entryCard(entry: SavedPhrase): HTMLElement {
  const card = node('article', 'phrase-card');
  const meta = node('div', 'phrase-meta');
  const time = node('time', 'saved-date', `${entry.updatedAt > entry.createdAt ? '更新于' : '收藏于'} ${dateText(entry.updatedAt)}`);
  time.dateTime = new Date(entry.updatedAt).toISOString();
  meta.append(node('span', `mode-badge mode-${entry.mode}`, entry.mode === 'translate' ? '翻译' : '解释'), time);
  const remove = node('button', 'delete-button', '删除');
  remove.type = 'button';
  remove.setAttribute('aria-label', `删除收藏：${entry.text.slice(0, 80)}`);
  remove.addEventListener('click', () => {
    pendingDelete = entry;
    element('delete-text').textContent = entry.text;
    element('delete-error').hidden = true;
    deleteDialog.showModal();
    element<HTMLButtonElement>('cancel-delete').focus();
  });
  meta.append(remove);
  const title = node('h2', 'phrase-text', entry.text);
  const answer = node('div', 'phrase-answer');
  answer.append(node('span', 'answer-label', entry.mode === 'translate' ? '译文' : '语境解释'), node('p', 'preserve-text', entry.coreText || '未保存回答'));
  card.append(meta, title, answer);
  if (entry.detailsText) card.append(detailsBlock(entry.exampleKind === 'bilingual' ? '查看双语例句' : '查看用法示例', entry.detailsText, 'phrase-details'));
  if (entry.context) card.append(detailsBlock('查看原文语境', entry.context, 'phrase-details context-details'));
  const source = node('div', 'phrase-source');
  const sourceInfo = node('div', 'source-info');
  sourceInfo.append(node('span', 'source-label', '来源'), node('span', 'source-title', entry.sourceTitle || '未命名网页'));
  const safeUrl = sourceUrl(entry.sourceUrl);
  if (safeUrl) {
    const url = new URL(safeUrl);
    sourceInfo.append(node('span', 'source-domain', url.host));
    const open = node('a', 'source-link', '打开原文 ↗');
    open.href = safeUrl; open.target = '_blank'; open.rel = 'noopener noreferrer';
    source.append(sourceInfo, open);
  } else {
    if (entry.sourceUrl) sourceInfo.append(node('span', 'source-domain', entry.sourceUrl));
    source.append(sourceInfo, node('span', 'source-unavailable', '来源链接不可用'));
  }
  card.append(source);
  return card;
}

function exportEntries(): SavedPhrase[] { return exportScope.value === 'filtered' ? filtered : entries; }
function updateExport(): void {
  const count = exportEntries().length;
  const scope = exportScope.value === 'filtered' ? '当前筛选结果' : '全部收藏';
  element<HTMLButtonElement>('export-json').disabled = !loaded || loading || !count;
  element<HTMLButtonElement>('export-markdown').disabled = !loaded || loading || !count;
  element('export-hint').textContent = `将导出${scope} ${count} 条；不含 API Key 或模型配置。`;
  const allOption = exportScope.options.item(0);
  const filteredOption = exportScope.options.item(1);
  if (allOption) allOption.textContent = `全部收藏（${entries.length} 条）`;
  if (filteredOption) filteredOption.textContent = `当前筛选结果（${filtered.length} 条）`;
}

function render(): void {
  const keyword = search.value.trim().toLocaleLowerCase();
  filtered = entries.filter(entry => (filterMode === 'all' || entry.mode === filterMode) && (!keyword || [entry.text, entry.coreText, entry.detailsText, entry.context, entry.sourceTitle, entry.sourceUrl].some(text => text.toLocaleLowerCase().includes(keyword))));
  element('total-count').textContent = loaded ? String(entries.length) : '—';
  element('result-count').textContent = !loaded ? '正在读取本机收藏…' : keyword || filterMode !== 'all' ? `找到 ${filtered.length} 条，共 ${entries.length} 条收藏` : `共 ${entries.length} 条收藏 · 最近更新在前`;
  entriesRoot.replaceChildren(...filtered.map(entryCard));
  emptyState.hidden = !loaded || filtered.length > 0;
  element('empty-title').textContent = entries.length ? '没有找到符合条件的词句' : '还没有收藏的词句';
  element('empty-description').textContent = entries.length ? '换个关键词，或查看全部收藏。' : '在网页上选中文字，完成翻译或解释后，点击「收藏」即可留在这里。';
  element<HTMLButtonElement>('reset-search').hidden = !entries.length;
  updateExport();
}

async function refresh(): Promise<void> {
  if (loading) return;
  loading = true;
  const refreshButton = element<HTMLButtonElement>('refresh');
  refreshButton.disabled = true;
  refreshButton.textContent = '正在刷新…';
  updateExport();
  try {
    const response = await message('phrases:list');
    if (!Array.isArray(response.entries)) throw new Error('收藏读取失败，请重新加载扩展后重试。');
    const normalized = response.entries.map(readEntry);
    const next = normalized.filter((entry): entry is SavedPhrase => !!entry).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
    const changed = !loaded || JSON.stringify(next) !== JSON.stringify(entries);
    entries = next;
    loaded = true;
    feedback.hidden = true;
    if (entries.length !== normalized.length) report('部分收藏格式异常，未在列表中显示。', true);
    // A focus refresh with unchanged data should preserve expanded details and scroll position.
    if (changed) render();
  } catch (error) {
    report(error instanceof Error ? error.message : '收藏读取失败，请重试。', true);
    if (!loaded) element('result-count').textContent = '收藏读取失败，点击「刷新列表」重试。';
  } finally {
    loading = false;
    refreshButton.disabled = false;
    refreshButton.textContent = '刷新列表 ↻';
    updateExport();
  }
}

function filename(format: 'json' | 'md'): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `reading-assistant-phrases-${exportScope.value === 'filtered' ? 'filtered-' : ''}${stamp}.${format}`;
}
function markdownText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/[\[\]`*_{}<>]/g, '\\$&').replace(/^([ \t]*)([#>+\-]|\d+\.)/gm, '$1\\$2');
}
function markdownExport(selected: SavedPhrase[]): string {
  const sections = ['# 阅读助手 · 词句收藏', `导出时间：${new Date().toLocaleString('zh-CN')}  \n范围：${exportScope.value === 'filtered' ? '当前筛选结果' : '全部收藏'}，共 ${selected.length} 条`];
  for (const entry of selected) {
    const title = markdownText(entry.text.replace(/\s+/g, ' ').slice(0, 160));
    const source = sourceUrl(entry.sourceUrl);
    sections.push(`## ${title}\n\n${entry.mode === 'translate' ? '翻译' : '解释'} · 收藏于 ${dateText(entry.createdAt)}${entry.updatedAt > entry.createdAt ? ` · 更新于 ${dateText(entry.updatedAt)}` : ''}\n\n### 原文\n\n${markdownText(entry.text)}\n\n### ${entry.mode === 'translate' ? '译文' : '语境解释'}\n\n${markdownText(entry.coreText)}`);
    if (entry.detailsText) sections.push(`### ${entry.exampleKind === 'bilingual' ? '双语例句' : '用法示例'}\n\n${markdownText(entry.detailsText)}`);
    if (entry.context) sections.push(`### 原文语境\n\n${markdownText(entry.context)}`);
    sections.push(`来源：${markdownText(entry.sourceTitle || '未命名网页')}${source ? `  \n<${source}>` : entry.sourceUrl ? `  \n${markdownText(entry.sourceUrl)}` : ''}\n\n---`);
  }
  return sections.join('\n\n') + '\n';
}
function download(format: 'json' | 'md'): void {
  const selected = exportEntries();
  if (!selected.length) return;
  const content = format === 'json' ? JSON.stringify({ format: 'reading-assistant-phrases', version: 1, exportedAt: new Date().toISOString(), entries: selected.map(entry => readEntry(entry)) }, null, 2) + '\n' : markdownExport(selected);
  const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename(format);
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  report(`已导出${exportScope.value === 'filtered' ? '当前筛选结果' : '全部收藏'} ${selected.length} 条。`);
}

search.addEventListener('input', render);
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => {
  button.addEventListener('click', () => {
    filterMode = button.dataset.mode as FilterMode;
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(other => {
      other.classList.toggle('active', other === button);
      other.setAttribute('aria-pressed', String(other === button));
    });
    render();
  });
});
element('reset-search').addEventListener('click', () => {
  search.value = '';
  document.querySelector<HTMLButtonElement>('[data-mode="all"]')?.click();
  search.focus();
});
element('refresh').addEventListener('click', () => { void refresh(); });
exportScope.addEventListener('change', updateExport);
element('export-json').addEventListener('click', () => download('json'));
element('export-markdown').addEventListener('click', () => download('md'));
element('cancel-delete').addEventListener('click', () => { if (!deleting) deleteDialog.close(); });
deleteDialog.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
deleteDialog.addEventListener('close', () => { pendingDelete = undefined; });
element<HTMLFormElement>('delete-form').addEventListener('submit', event => {
  event.preventDefault();
  const entry = pendingDelete;
  if (!entry || deleting) return;
  deleting = true;
  element<HTMLButtonElement>('confirm-delete').disabled = true;
  element<HTMLButtonElement>('cancel-delete').disabled = true;
  void (async () => {
    try {
      await message('phrases:delete', { id: entry.id });
      entries = entries.filter(item => item.id !== entry.id);
      deleteDialog.close();
      render();
      report('已删除这条收藏。');
      search.focus();
    } catch (error) {
      element('delete-error').textContent = error instanceof Error ? error.message : '删除失败，请重试。';
      element('delete-error').hidden = false;
    } finally {
      deleting = false;
      element<HTMLButtonElement>('confirm-delete').disabled = false;
      element<HTMLButtonElement>('cancel-delete').disabled = false;
    }
  })();
});
// Other tabs may save new phrases while this page is open. Refresh only when returning.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !deleteDialog.open) void refresh(); });
window.addEventListener('focus', () => { if (!deleteDialog.open) void refresh(); });
void refresh();
