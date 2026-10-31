import './research-page.css';
import './panel-embed';
import { researchActive, researchInput, researchMarkdown, RESEARCH_PORT, type ResearchClaim, type ResearchSource, type ResearchTask, type SavedResearch } from './research-shared';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`缺少研究页元素：${id}`);
  return value as T;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

const question = element<HTMLTextAreaElement>('question');
const urls = element<HTMLTextAreaElement>('urls');
const feedback = element('feedback');
const deleteDialog = element<HTMLDialogElement>('delete-dialog');
let current: ResearchTask | null = null;
let reports: SavedResearch[] = [];
let selectedSavedId: string | undefined;
let pendingDelete: SavedResearch | undefined;
let hasKey = false;
let settingsReady = false;
let loaded = false;
let busy = false;
let saving = false;
let deleting = false;
let polling = false;
let refreshing = false;
let authorized = false;
let inputRevision = 0;
let renderKey = '';
let connected = false;
let port: chrome.runtime.Port | undefined;

const statusText: Record<ResearchTask['status'], string> = { reading: '正在阅读', analyzing: '正在分析', synthesizing: '正在汇总', done: '研究完成', cancelled: '已停止', error: '研究失败', interrupted: '任务中断' };
const sourceStatus: Record<ResearchSource['status'], string> = { queued: '等待读取', reading: '正在读取', analyzing: '正在分析', done: '已分析', error: '未完成' };

async function message(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response: unknown = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response || typeof response !== 'object' || !('ok' in response)) throw new Error('扩展后台未响应，请重新加载扩展后重试。');
  if (response.ok !== true) throw new Error('error' in response && typeof response.error === 'string' ? response.error : '操作未完成，请重试。');
  return response as Record<string, unknown>;
}
function report(text: string, error = false): void {
  feedback.textContent = text;
  feedback.classList.toggle('feedback-error', error);
  feedback.hidden = false;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请重试。'; }
function input(): { question: string; urls: string[] } {
  return researchInput(question.value, urls.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean));
}
function origins(values: string[]): string[] {
  return [...new Set(values.map(value => { const url = new URL(value); return `${url.protocol}//${url.hostname}/*`; }))];
}
function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) return url.href;
  } catch { /* Unusable source URLs remain plain text. */ }
  return undefined;
}
function dateText(timestamp: number): string {
  const value = new Date(timestamp);
  return Number.isFinite(value.getTime()) ? value.toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '日期未知';
}

function updateControls(): void {
  const active = researchActive(current);
  let valid = false;
  let inputError = '';
  try { input(); valid = true; } catch (error) { inputError = errorText(error); }
  question.disabled = busy || active;
  urls.disabled = busy || active;
  element<HTMLButtonElement>('authorize').disabled = busy || active || !valid || !connected;
  element<HTMLButtonElement>('start-research').disabled = busy || active || !valid || !loaded || !hasKey || !settingsReady || !authorized || !connected;
  element<HTMLButtonElement>('stop-research').disabled = busy || !active || !connected;
  element<HTMLButtonElement>('stop-research').hidden = !active;
  const start = element<HTMLButtonElement>('start-research');
  start.textContent = busy ? '处理中…' : active ? '研究进行中…' : '开始研究 →';
  const ready = element('ready-state');
  let text = !loaded ? '正在检查配置…' : !connected ? '连接已断开，请重新加载扩展并刷新此页。' : active ? '任务进行中，可随时停止；请保持此页打开。' : !settingsReady || !hasKey ? '请先在设置页配置模型、Key，并授权模型接口。' : !valid ? inputError : !authorized ? '开始前，请点击「授权所填网站」。' : '配置和网站权限已就绪，点击开始后才会调用模型。';
  ready.textContent = text;
  ready.classList.toggle('needs-attention', loaded && (!connected || !settingsReady || !hasKey || (valid && !authorized)));
  element('question-count').textContent = `${question.value.length.toLocaleString('en-US')} / 1,500`;
  const count = urls.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean).length;
  element('url-count').textContent = count ? `${count} / 5 个链接` : '每行一个';
  element('active-monitor').hidden = !current || (!active && !selectedSavedId);
  if (current) {
    element('active-state').textContent = statusText[current.status];
    element('active-stage').textContent = `${current.stage} · 模型调用 ${current.calls}/${current.maxCalls}`;
  }
  element<HTMLButtonElement>('view-current').hidden = !selectedSavedId;
  updateReportActions();
}

async function checkInputPermissions(): Promise<void> {
  const revision = ++inputRevision;
  authorized = false;
  updateControls();
  try {
    const values = input();
    const permitted = await chrome.permissions.contains({ origins: origins(values.urls) });
    if (revision !== inputRevision) return;
    authorized = permitted;
  } catch { /* Invalid fields are described beside the action buttons. */ }
  if (revision === inputRevision) updateControls();
}

function selectedTask(): ResearchTask | null {
  return selectedSavedId ? reports.find(item => item.id === selectedSavedId)?.task ?? null : current;
}
function updateReportActions(): void {
  const task = selectedTask();
  const saved = !!selectedSavedId || !!task?.savedId || reports.some(item => item.task.id === task?.id);
  const save = element<HTMLButtonElement>('save-report');
  save.hidden = !!selectedSavedId;
  save.disabled = busy || saving || !connected || task?.status !== 'done' || !task.report || saved;
  save.textContent = saving ? '正在保存…' : saved ? '已保存到本机' : '保存报告到本机';
  element<HTMLButtonElement>('export-report').disabled = !task?.report;
}

function citationButton(sourceId: string, finding: number, task: ResearchTask): HTMLButtonElement | undefined {
  const source = task.sources.find(item => item.id === sourceId);
  if (!source || !source.findings[finding]) return undefined;
  const button = node('button', 'citation', `${sourceId}·${finding + 1}`);
  button.type = 'button';
  button.dataset.sourceId = sourceId;
  button.dataset.findingIndex = String(finding);
  button.setAttribute('aria-label', `核对来源 ${sourceId} 的第 ${finding + 1} 条原文证据`);
  button.addEventListener('click', () => {
    const card = [...document.querySelectorAll<HTMLElement>('#sources [data-source-id]')].find(item => item.dataset.sourceId === sourceId);
    const target = card?.querySelector<HTMLElement>(`[data-finding-index="${finding}"]`);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
  });
  return button;
}
function claimSection(title: string, claims: ResearchClaim[], task: ResearchTask): HTMLElement {
  const section = node('section', 'report-part');
  section.append(node('h4', '', title));
  const list = node('ul', 'report-claims');
  for (const claim of claims) {
    const item = node('li', '', claim.text);
    const citations = node('span', 'citations');
    for (const citation of claim.citations) {
      const button = citationButton(citation.sourceId, citation.finding, task);
      if (button) citations.append(button);
    }
    if (citations.childElementCount) item.append(citations);
    list.append(item);
  }
  section.append(list);
  return section;
}
function comparisonTable(task: ResearchTask): HTMLElement | undefined {
  const sources = task.sources.filter(source => source.status === 'done' && source.findings.length);
  if (!sources.length) return undefined;
  const section = node('section', 'report-part source-comparison');
  section.id = 'source-comparison';
  section.append(node('h4', '', '来源比较表'), node('p', 'comparison-description', '按来源并列整理，点击引用可核对原文。'));
  const table = node('table', 'comparison-table');
  const caption = node('caption', 'visually-hidden', '各来源与研究问题有关的要点和原文引用');
  const head = node('thead', '');
  const headings = node('tr', '');
  for (const title of ['来源', '与研究问题相关的要点']) {
    const cell = node('th', '', title);
    cell.scope = 'col';
    headings.append(cell);
  }
  head.append(headings);
  const body = node('tbody', '');
  for (const source of sources) {
    const row = node('tr', '');
    row.dataset.comparisonSourceId = source.id;
    const name = node('th', 'comparison-source');
    name.scope = 'row';
    name.append(node('span', 'comparison-source-id', source.id), node('span', 'comparison-source-title', source.title || '未命名网页'));
    const points = node('td', 'comparison-points');
    const list = node('ul', '');
    source.findings.forEach((finding, index) => {
      const item = node('li', '', finding.point);
      const citation = citationButton(source.id, index, task);
      if (citation) item.append(citation);
      list.append(item);
    });
    points.append(list);
    row.append(name, points);
    body.append(row);
  }
  table.append(caption, head, body);
  section.append(table);
  return section;
}
function sourceCard(source: ResearchSource): HTMLElement {
  const card = node('article', 'source-card');
  card.dataset.sourceId = source.id;
  const head = node('div', 'source-head');
  const info = node('div', 'source-info');
  info.append(node('h4', 'source-title', source.title || '等待网页标题'));
  const rawUrl = source.url || source.requestedUrl;
  const safe = safeUrl(rawUrl);
  if (safe) {
    const link = node('a', 'source-url', safe);
    link.href = safe; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `打开来源 ${source.id}：${source.title || safe}`);
    info.append(link);
  } else info.append(node('span', 'source-url', rawUrl));
  const state = node('span', 'source-state', sourceStatus[source.status] || source.status);
  state.dataset.status = source.status;
  head.append(node('span', 'source-number', source.id), info, state);
  card.append(head);
  if (source.notice || source.characters !== undefined) {
    const parts = [source.characters !== undefined ? `已读取 ${source.characters.toLocaleString('zh-CN')} 字符` : '', source.notice || ''].filter(Boolean);
    card.append(node('p', 'source-notice', parts.join(' · ')));
  }
  if (source.error) card.append(node('p', 'source-error', source.error));
  if (source.findings.length) {
    const findings = node('div', 'findings');
    source.findings.forEach((finding, index) => {
      const block = node('div', 'finding');
      block.dataset.findingIndex = String(index);
      block.tabIndex = -1;
      block.append(node('p', 'finding-point', `${source.id}·${index + 1}  ${finding.point}`), node('span', 'finding-label', '原文引句'), node('blockquote', '', finding.quote));
      findings.append(block);
    });
    card.append(findings);
  } else card.append(node('p', 'finding-empty', source.status === 'done' ? '这篇资料没有提取到与问题直接相关的原文证据。' : source.status === 'error' ? '此来源未参与最终比较。' : '读取并分析后，将在这里显示相关要点和原文引句。'));
  return card;
}

function renderTask(force = false): void {
  const task = selectedTask();
  const key = JSON.stringify([selectedSavedId, task]);
  if (!force && key === renderKey) { updateControls(); return; }
  renderKey = key;
  element('task-empty').hidden = !!task;
  element('task-content').hidden = !task;
  if (!task) { updateControls(); return; }
  element('view-label').textContent = selectedSavedId ? '已存报告 · 本机资料' : '当前任务';
  element('task-question').textContent = task.question;
  element('task-status').textContent = statusText[task.status] || task.status;
  element('task-status').dataset.status = task.status;
  element('task-stage').textContent = task.stage;
  element('call-count').textContent = `模型调用 ${task.calls}/${task.maxCalls}`;
  element('task-error').hidden = !task.error;
  element('task-error').textContent = task.error || '';
  const root = element('report');
  root.replaceChildren();
  if (task.report) {
    for (const [name, title] of [['overview', '资料概览'], ['comparisons', '比较结果'], ['conclusion', '结论']] as const) {
      if (task.report[name].length) root.append(claimSection(title, task.report[name], task));
      if (name === 'overview') {
        const table = comparisonTable(task);
        if (table) root.append(table);
      }
    }
    if (!root.childElementCount) root.append(node('p', 'report-placeholder', '模型未返回可展示的报告内容，可先检查来源证据。'));
  } else root.append(node('p', 'report-placeholder', researchActive(task) ? '正在逐篇阅读和分析。全部可用资料处理后，将在这里生成带引用的比较报告。' : '本次任务未生成完整报告。下方保留已取得的来源和原文证据。'));
  element('report-caption').textContent = task.report ? '引用可点击核对' : researchActive(task) ? '等待资料分析完成' : '任务已结束';
  element('sources').replaceChildren(...task.sources.map(sourceCard));
  updateControls();
}

function exportTask(task: ResearchTask): void {
  if (!task.report) return;
  const content = researchMarkdown(task);
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `reading-assistant-research-${new Date(task.createdAt).toISOString().slice(0, 10)}-${task.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}.md`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  report('已导出这份研究报告，包含问题、比较结果、来源和原文证据。');
}
function renderHistory(): void {
  element('saved-count').textContent = loaded ? `共 ${reports.length} / 20 份 · 最近保存在前` : '正在读取…';
  element('saved-empty').hidden = !loaded || !!reports.length;
  const cards = reports.map(entry => {
    const card = node('article', `saved-card${entry.id === selectedSavedId ? ' selected' : ''}`);
    card.dataset.savedId = entry.id;
    const open = node('button', 'saved-open', entry.task.question);
    open.type = 'button'; open.dataset.action = 'view';
    open.addEventListener('click', () => { selectedSavedId = entry.id; renderTask(true); renderHistory(); });
    card.append(open, node('p', 'saved-meta', `${dateText(entry.savedAt)} · ${entry.task.sources.length} 篇来源`));
    const actions = node('div', 'saved-actions');
    const download = node('button', '', '导出 Markdown');
    download.type = 'button'; download.dataset.action = 'export';
    download.addEventListener('click', () => exportTask(entry.task));
    const remove = node('button', '', '删除');
    remove.type = 'button'; remove.dataset.action = 'delete';
    remove.addEventListener('click', () => {
      pendingDelete = entry;
      element('delete-text').textContent = entry.task.question;
      element('delete-error').hidden = true;
      deleteDialog.showModal();
      element('cancel-delete').focus();
    });
    actions.append(download, remove); card.append(actions);
    return card;
  });
  element('saved-reports').replaceChildren(...cards);
}

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  element<HTMLButtonElement>('refresh-reports').disabled = true;
  try {
    const response = await message('research:view');
    if (!Array.isArray(response.reports)) throw new Error('报告列表读取失败，请重新加载扩展后重试。');
    current = (response.task ?? null) as ResearchTask | null;
    reports = (response.reports as SavedResearch[]).slice().sort((a, b) => b.savedAt - a.savedAt);
    hasKey = response.hasKey === true;
    settingsReady = response.settingsReady === true;
    loaded = true;
    if (selectedSavedId && !reports.some(entry => entry.id === selectedSavedId)) selectedSavedId = undefined;
    renderHistory(); renderTask();
    await checkInputPermissions();
  } catch (error) {
    report(errorText(error), true);
    if (!loaded) element('saved-count').textContent = '读取失败，可点击刷新重试。';
  } finally {
    refreshing = false;
    element<HTMLButtonElement>('refresh-reports').disabled = false;
    updateControls();
  }
}

async function poll(): Promise<void> {
  if (polling || !researchActive(current) || !connected) return;
  polling = true;
  try {
    const response = await message('research:status');
    current = (response.task ?? null) as ResearchTask | null;
    renderTask();
  } catch (error) { report(errorText(error), true); }
  finally { polling = false; }
}

question.addEventListener('input', () => { void checkInputPermissions(); });
urls.addEventListener('input', () => { void checkInputPermissions(); });
element('authorize').addEventListener('click', () => {
  if (busy || researchActive(current)) return;
  try {
    const values = input();
    // Keep the request inside the trusted click, before any await.
    const request = chrome.permissions.request({ origins: origins(values.urls) });
    busy = true; updateControls();
    void (async () => {
      try {
        const granted = await request;
        await checkInputPermissions();
        report(granted ? '所填网站已授权。开始研究后，将只读取本次提交的文档链接。' : '授权未完成。你可以再次点击授权，或调整文档链接。', !granted);
      } catch (error) { report(errorText(error), true); }
      finally { busy = false; updateControls(); }
    })();
  } catch (error) { report(errorText(error), true); }
});
element<HTMLFormElement>('research-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || researchActive(current)) return;
  let values: { question: string; urls: string[] };
  try { values = input(); } catch (error) { report(errorText(error), true); return; }
  busy = true; updateControls();
  void (async () => {
    try {
      const response = await message('research:start', values);
      current = response.task as ResearchTask;
      selectedSavedId = undefined;
      feedback.hidden = true;
      renderHistory(); renderTask(true);
    } catch (error) { report(errorText(error), true); }
    finally { busy = false; updateControls(); }
  })();
});
element('stop-research').addEventListener('click', () => {
  if (busy || !current || !researchActive(current)) return;
  const id = current.id;
  busy = true; updateControls();
  void (async () => {
    try {
      const response = await message('research:stop', { id });
      current = (response.task ?? null) as ResearchTask | null;
      renderTask();
      report('任务已停止。已取得的来源证据仍可查看。');
    } catch (error) { report(errorText(error), true); }
    finally { busy = false; updateControls(); }
  })();
});
element('view-current').addEventListener('click', () => { selectedSavedId = undefined; renderHistory(); renderTask(true); });
element('save-report').addEventListener('click', () => {
  const task = current;
  if (selectedSavedId || saving || busy || task?.status !== 'done' || !task.report) return;
  saving = true; updateReportActions();
  void (async () => {
    try {
      const response = await message('research:save', { id: task.id });
      const entry = response.report as SavedResearch;
      reports = [entry, ...reports.filter(item => item.id !== entry.id)].sort((a, b) => b.savedAt - a.savedAt);
      if (current?.id === task.id) current = { ...current, savedId: entry.id };
      renderHistory();
      report('已保存到本机，重启浏览器后可在「已存报告」中查看。');
    } catch (error) { report(errorText(error), true); }
    finally { saving = false; renderTask(); }
  })();
});
element('export-report').addEventListener('click', () => { const task = selectedTask(); if (task) exportTask(task); });
element('refresh-reports').addEventListener('click', () => { void refresh(); });
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
      await message('research:delete', { id: entry.id });
      reports = reports.filter(item => item.id !== entry.id);
      if (selectedSavedId === entry.id) selectedSavedId = undefined;
      if (current?.savedId === entry.id) current = { ...current, savedId: undefined };
      deleteDialog.close(); renderHistory(); renderTask(true);
      report('已删除这份本机报告。');
    } catch (error) {
      element('delete-error').textContent = errorText(error);
      element('delete-error').hidden = false;
    } finally {
      deleting = false;
      element<HTMLButtonElement>('confirm-delete').disabled = false;
      element<HTMLButtonElement>('cancel-delete').disabled = false;
    }
  })();
});

try {
  port = chrome.runtime.connect({ name: RESEARCH_PORT });
  connected = true;
  port.onDisconnect.addListener(() => {
    // Read lastError here to avoid an unhandled Chrome runtime diagnostic.
    void chrome.runtime.lastError;
    connected = false; updateControls();
    report('与扩展后台的连接已断开。请重新加载扩展并刷新此页，再确认任务状态。', true);
  });
} catch (error) { report(errorText(error), true); }
const pollTimer = window.setInterval(() => { void poll(); }, 1500);
const heartbeatTimer = window.setInterval(() => {
  if (!connected || !port) return;
  try { port.postMessage({ type: 'research:heartbeat' }); } catch { connected = false; updateControls(); }
}, 20_000);
window.addEventListener('pagehide', () => { window.clearInterval(pollTimer); window.clearInterval(heartbeatTimer); port?.disconnect(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !deleteDialog.open && !busy) void refresh(); });
void refresh();
