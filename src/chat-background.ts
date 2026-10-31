import { allowedUrl, validateSettings } from './core';
import { requestCompletion } from './model';
import { readConfig, secureStorage } from './store';
import { planChat } from './chat-model';
import { CHAT_PORT, CHAT_SESSION_KEY, MAX_CHAT_INPUT, MAX_CHAT_MESSAGES, MAX_CHAT_OUTPUT, type ChatCommand, type ChatMessage, type ChatState, type SearchUpdate } from './chat-shared';
import { sanitizeChatCitations, sanitizeChatSearch } from './chat-search';
import { sanitizeChatDetails } from './chat-details';
import { getChatConnectionView } from './chat-connection';
import type { ChatConnection } from './chat-connection-shared';
import { ensureSiwcReady, getSiwcView, requestSiwc } from './siwc-background';
import type { SiwcView } from './siwc-shared';

interface Job { id: string; owner: chrome.runtime.Port; controller: AbortController; assistant?: ChatMessage; key: string; connection?: ChatConnection }
let state: ChatState = empty();
let job: Job | undefined;
let initialized = false;
let ready: Promise<void> | undefined;
let writes: Promise<unknown> = Promise.resolve();
let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;
let checkpointBlocked = false;
let configurationReady = async (): Promise<unknown> => undefined;
let beforeRequest = () => {};
const ports = new Set<chrome.runtime.Port>();
function empty(): ChatState { return { type: 'chat:state', messages: [], status: 'idle', hasKey: false, settingsReady: false, connection: 'apiKey', connectionLabel: 'API Key' }; }
const trusted = (sender?: chrome.runtime.MessageSender) => sender?.id === chrome.runtime.id && sender.url?.split('#')[0] === chrome.runtime.getURL('sidepanel.html') && (sender.frameId === undefined || sender.frameId === 0);
const hidden = (value: string, key: string) => key ? value.replaceAll(key, '[Key 已隐藏]') : value;
function errorText(error: unknown, key = '') { return hidden(error instanceof Error ? error.message.replaceAll('摘要', '回答') : '对话操作失败，请手动重试。', key); }
function emit() { for (const port of ports) { try { port.postMessage(state); } catch { /* Closing panels cannot receive updates. */ } } }
function current(active: Job) { if (job !== active || active.controller.signal.aborted || !ports.has(active.owner)) throw new DOMException('Aborted', 'AbortError'); }
function safeMessage(item: ChatMessage): ChatMessage {
  const message: ChatMessage = { id: item.id, role: item.role, content: item.content, status: item.status };
  if (item.role === 'assistant') {
    const search = sanitizeChatSearch(item.search), citations = sanitizeChatCitations(item.citations, item.content.length);
    const details = sanitizeChatDetails(item.details);
    if (search) message.search = search;
    if (citations.length) message.citations = citations;
    if (details) message.details = details;
  }
  return message;
}
function interruptSearch(message?: ChatMessage): void {
  if (message?.search && ['searching', 'reading'].includes(message.search.state)) message.search = { ...message.search, state: 'failed' };
}

/** Checkpoints contain only a whitelist of conversation fields; configuration never enters them. */
function persist(remove = false): Promise<unknown> {
  const value = { messages: state.messages.map(safeMessage), status: state.status, ...(state.requestId ? { requestId: state.requestId } : {}), ...(state.error ? { error: state.error } : {}) };
  const next = writes.then(() => remove ? chrome.storage.session.remove(CHAT_SESSION_KEY) : chrome.storage.session.set({ [CHAT_SESSION_KEY]: value }));
  writes = next.catch(() => {}); return next;
}
function clearTimer() { clearTimeout(checkpointTimer); checkpointTimer = undefined; }
function scheduleCheckpoint(active: Job) {
  if (checkpointTimer) return;
  checkpointTimer = setTimeout(() => {
    checkpointTimer = undefined;
    if (job !== active) return;
    void persist().catch(() => { if (job === active) cancelChat('无法保存会话进度，已停止生成。请检查扩展存储后重试。'); });
  }, 400);
}
function restore(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object') throw new Error('会话记录格式无效，请清空会话后继续。');
  const saved = value as Partial<ChatState>;
  if (!Array.isArray(saved.messages) || saved.messages.length > MAX_CHAT_MESSAGES || !['idle', 'running', 'error', 'cancelled', 'interrupted'].includes(saved.status || '') || saved.requestId !== undefined && (typeof saved.requestId !== 'string' || saved.requestId.length > 100) || saved.error !== undefined && (typeof saved.error !== 'string' || saved.error.length > 2000)) throw new Error('会话记录格式无效，请清空会话后继续。');
  const messages: ChatMessage[] = saved.messages.map((item, index) => {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 100 || item.role !== (index % 2 === 0 ? 'user' : 'assistant') || !['done', 'running', 'cancelled', 'error'].includes(item.status) || typeof item.content !== 'string' || item.content.length > (item.role === 'user' ? MAX_CHAT_INPUT : MAX_CHAT_OUTPUT) || item.role === 'user' && item.status !== 'done') throw new Error('会话记录格式无效，请清空会话后继续。');
    return safeMessage(item);
  });
  if (messages.length % 2 !== 0 || messages.some((item, index) => item.status === 'running' && (saved.status !== 'running' || index !== messages.length - 1))) throw new Error('会话记录格式无效，请清空会话后继续。');
  state = { ...empty(), messages, status: saved.status!, ...(saved.requestId ? { requestId: saved.requestId } : {}), ...(saved.error ? { error: saved.error } : {}) };
  if (state.status === 'running') {
    state.status = 'interrupted'; state.error = '扩展后台已中断，未自动重发请求。可继续使用已完成的对话，或清空会话。';
    for (const item of state.messages) if (item.status === 'running') { item.status = 'cancelled'; interruptSearch(item); }
  }
}
async function load(): Promise<void> {
  try { await secureStorage; restore((await chrome.storage.session.get(CHAT_SESSION_KEY))[CHAT_SESSION_KEY]); }
  catch (error) { checkpointBlocked = true; state = { ...empty(), status: 'error', error: errorText(error) }; }
}
const ensureReady = () => ready ??= load();
function applyApiKey(key: string): void {
  delete state.siwcStatus;
  state.connection = 'apiKey'; state.connectionLabel = 'API Key';
  state.hasKey = !!key;
  delete state.accountLabel;
}
function applySiwc(view: SiwcView): void {
  state.connection = 'chatgptOAuth'; state.connectionLabel = 'ChatGPT 订阅';
  state.hasKey = view.status.loggedIn && view.status.planAuthorized;
  state.settingsReady = view.status.state === 'ready' && !!view.config.model && view.status.models.some(item => item.id === view.config.model);
  state.siwcStatus = structuredClone(view.status);
  if (view.status.accountLabel) state.accountLabel = view.status.accountLabel; else delete state.accountLabel;
}
async function refresh(): Promise<void> {
  try {
    await configurationReady();
    const { settings, key } = await readConfig();
    const view = await getChatConnectionView();
    if (view.config.provider === 'chatgptOAuth') { applySiwc(await ensureSiwcReady()); return; }
    applyApiKey(key);
    for (const item of state.messages) item.content = hidden(item.content, key);
    if (state.error) state.error = hidden(state.error, key);
    try { validateSettings(settings); state.settingsReady = !!settings.baseUrl && !!settings.model && await chrome.permissions.contains({ origins: [allowedUrl(settings.baseUrl).origin + '/*'] }); }
    catch { state.settingsReady = false; }
  } catch { state.hasKey = false; state.settingsReady = false; }
}

export function cancelChat(reason = '已停止生成，已收到的片段保留。'): void {
  const active = job;
  if (!active) return;
  ++revision; job = undefined; clearTimer(); active.controller.abort();
  if (active.assistant) { active.assistant.status = 'cancelled'; interruptSearch(active.assistant); }
  state.status = 'cancelled'; state.error = hidden(reason, active.key); emit();
  const savedRevision = revision;
  void persist().catch(() => { if (revision === savedRevision) { state.error = '已停止生成，但无法保存会话进度。请检查扩展存储。'; emit(); } });
}

async function send(port: chrome.runtime.Port, input: unknown): Promise<void> {
  if (job || !ports.has(port)) return;
  if (checkpointBlocked) { state.status = 'error'; state.error = '无法读取之前的会话，请先清空会话后继续。本次没有调用模型。'; emit(); return; }
  const active: Job = { id: crypto.randomUUID(), owner: port, controller: new AbortController(), key: '' };
  job = active; ++revision;
  state.status = 'running'; state.requestId = active.id; delete state.error; emit();
  try {
    await configurationReady(); current(active);
    const { settings, key } = await readConfig(); current(active); active.key = key;
    const view = await getChatConnectionView(); current(active); active.connection = view.config.provider;
    if (view.config.provider === 'chatgptOAuth') {
      applySiwc(await ensureSiwcReady()); current(active);
      if (!state.settingsReady) throw new Error(state.siwcStatus?.error || (state.siwcStatus?.state === 'ready' ? '请在设置中选择当前账号可用的模型并保存。' : '请到设置安装本地助手，登录 ChatGPT 并授权套餐用量。'));
    } else {
      applyApiKey(key);
      if (!settings.baseUrl || !settings.model || !key) throw new Error('请先在设置中填写接口地址、模型和 API Key。');
      validateSettings(settings);
      state.settingsReady = await chrome.permissions.contains({ origins: [allowedUrl(settings.baseUrl).origin + '/*'] }); current(active);
      if (!state.settingsReady) throw new Error('模型接口尚未授权，请在设置中授权接口域名。');
    }
    if (typeof input === 'string' && key && input.includes(key)) throw new Error('请勿在对话中发送当前配置的 API Key。本次没有调用模型。');
    const plan = planChat(settings, state.messages, input, view.config.provider);
    const user: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: plan.text, status: 'done' };
    active.assistant = { id: crypto.randomUUID(), role: 'assistant', content: '', status: 'running' };
    state.messages.push(user, active.assistant); emit();
    await persist(); current(active);
    beforeRequest(); current(active);
    let textWasRedacted = false;
    const onText = (text: string) => {
      current(active);
      if (text.length > MAX_CHAT_OUTPUT) throw new Error('回答超过 40,000 字符上限，已停止生成。请缩小问题后重试。');
      active.assistant!.content = hidden(text, key);
      if (active.assistant!.content !== text) { textWasRedacted = true; delete active.assistant!.citations; }
      emit(); scheduleCheckpoint(active);
    };
    const onUpdate = (update: SearchUpdate) => {
      current(active);
      const assistant = active.assistant!;
      if (update.search !== undefined) { const search = sanitizeChatSearch(update.search); if (search) assistant.search = search; }
      if (update.citations !== undefined) {
        assistant.citations = textWasRedacted ? [] : sanitizeChatCitations(update.citations, assistant.content.length).filter(citation => !key || !citation.url.includes(key) && !citation.title.includes(key));
      }
      if (update.details !== undefined) {
        const details = sanitizeChatDetails(update.details);
        if (details) {
          if (key && details.model?.includes(key)) delete details.model;
          assistant.details = sanitizeChatDetails({ ...assistant.details, ...details,
            ...(details.usage ? { usage: { ...assistant.details?.usage, ...details.usage } } : {}) });
        }
      }
      emit(); scheduleCheckpoint(active);
    };
    const answer = view.config.provider === 'chatgptOAuth'
      ? await requestSiwc(plan.messages, active.controller.signal, onText, onUpdate)
      : await requestCompletion(settings, key, plan.messages, active.controller.signal, onText, undefined, plan.outputTokens);
    current(active); clearTimer();
    if (answer.length > MAX_CHAT_OUTPUT) throw new Error('回答超过 40,000 字符上限，已停止生成。请缩小问题后重试。');
    active.assistant.content = hidden(answer, key); active.assistant.status = 'done'; state.status = 'idle';
    if (active.connection === 'chatgptOAuth') { applySiwc(await getSiwcView()); current(active); }
    await persist(); current(active);
    job = undefined; emit();
  } catch (error) {
    if (job !== active || active.controller.signal.aborted) return;
    const failedRevision = revision;
    clearTimer(); active.controller.abort(); job = undefined;
    if (active.assistant) { active.assistant.status = 'error'; interruptSearch(active.assistant); }
    if (active.connection === 'chatgptOAuth') {
      applySiwc(await getSiwcView());
      if (revision !== failedRevision) return;
    }
    state.status = 'error'; state.error = errorText(error, active.key); emit();
    const savedRevision = revision;
    try { await persist(); }
    catch { if (revision === savedRevision) { state.error = '无法保存会话进度，本次请求已停止。请检查扩展存储后手动重试。'; emit(); } }
  }
}

async function clear(requestId: string | undefined): Promise<void> {
  if (state.requestId && requestId !== state.requestId) return;
  cancelChat('会话已清空。'); ++revision; clearTimer();
  state = { ...state, messages: [], status: 'idle' }; delete state.requestId; delete state.error; emit();
  const savedRevision = revision;
  try { await persist(true); checkpointBlocked = false; }
  catch { if (revision === savedRevision) { state.status = 'error'; state.error = '无法清空本机会话记录，请检查扩展存储后重试。'; emit(); } }
}

export function initializeChat(options: { configurationReady?: () => Promise<unknown>; beforeRequest?: () => void } = {}): Promise<void> {
  if (options.configurationReady) configurationReady = options.configurationReady;
  if (options.beforeRequest) beforeRequest = options.beforeRequest;
  if (!initialized) {
    initialized = true;
    chrome.runtime.onConnect.addListener(port => {
      if (port.name !== CHAT_PORT) return;
      if (!trusted(port.sender)) { port.disconnect(); return; }
      ports.add(port);
      port.onDisconnect.addListener(() => { ports.delete(port); if (job?.owner === port) cancelChat('侧边栏已关闭，生成已停止。'); });
      port.onMessage.addListener((command: ChatCommand) => {
        if (!command || typeof command !== 'object' || !ports.has(port)) return;
        void (async () => {
          await ensureReady(); if (!ports.has(port)) return;
          if (command.type === 'chat:status') { await refresh(); if (ports.has(port)) emit(); }
          else if (command.type === 'chat:send') await send(port, command.text);
          else if (command.type === 'chat:stop' && typeof command.requestId === 'string' && command.requestId === job?.id) cancelChat();
          else if (command.type === 'chat:clear' && (command.requestId === undefined || typeof command.requestId === 'string')) await clear(command.requestId);
        })().catch(() => { /* State changes report their own errors; a closed Port has no recipient. */ });
      });
      void ensureReady().then(refresh).then(() => { if (ports.has(port)) emit(); });
    });
  }
  return ensureReady();
}
