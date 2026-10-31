import './options.css';
import './panel-embed';
import { DEFAULT_SETTINGS, type Settings, type SettingsView } from './shared';
import type { ChatConnectionConfig, ChatConnectionView } from './chat-connection-shared';
import { SIWC_API_ORIGIN, siwcStatusText, type SiwcView } from './siwc-shared';
import { formatSiwcDiagnostics, siwcDiagnosticText } from './siwc-diagnostics';

type Response = { ok: true; [key: string]: unknown } | { ok: false; error: string };

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少设置页元素：${id}`);
  return node as T;
}

const form = element<HTMLFormElement>('settings-form');
const baseInput = element<HTMLInputElement>('base-url');
const modelInput = element<HTMLInputElement>('model');
const keyInput = element<HTMLInputElement>('api-key');
const rememberInput = element<HTMLInputElement>('remember-key');
const autoInput = element<HTMLInputElement>('auto-summary');
const budgetInput = element<HTMLInputElement>('input-budget');
const autoLongInput = element<HTMLInputElement>('auto-long-summary');
const feedback = element<HTMLDivElement>('feedback');
const saveState = element<HTMLSpanElement>('save-state');
const testButton = element<HTMLButtonElement>('test-connection');
const keyClearButton = element<HTMLButtonElement>('clear-key');
const permissionInput = element<HTMLInputElement>('permission-origin');
document.querySelector<HTMLAnchorElement>('.brand')?.addEventListener('click', event => {
  event.preventDefault();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
let savedSettings: Settings = { ...DEFAULT_SETTINGS };
let loaded = false;
let busy = false;
let hasKey = false;
const connectionForm = element<HTMLFormElement>('connection-form');
const apiConnection = element<HTMLInputElement>('connection-api');
const oauthConnection = element<HTMLInputElement>('connection-oauth');
const oauthModel = element<HTMLSelectElement>('siwc-model');
element<HTMLInputElement>('siwc-extension-id').value = chrome.runtime.id;
let connectionView: ChatConnectionView | undefined;
let siwcView: SiwcView | undefined;
let connectionBusy = false;
let connectionLoaded = false;
let siwcAuthorizing = false;
let siwcCancelling = false;
let siwcReadVersion = 0;
let connectionReadVersion = 0;
let connectionEditVersion = 0;
let migrationNotified = false;

function notifyConnectionChanged(): void {
  if (location.search !== '?panel=1' || window.parent === window) return;
  try {
    if (window.parent.location.href.split(/[?#]/)[0] !== chrome.runtime.getURL('sidepanel.html')) return;
    window.parent.postMessage({ type: 'reader:connection-changed' }, location.origin);
  } catch { /* Only the packaged parent panel receives state-change signals. */ }
}

async function message(type: string, payload: Record<string, unknown> = {}): Promise<Response & Record<string, unknown>> {
  const response = await chrome.runtime.sendMessage({ type, ...payload }) as Response | undefined;
  if (!response || typeof response.ok !== 'boolean') throw new Error('扩展后台未响应，请重新加载扩展后重试。');
  if (!response.ok) throw new Error(response.error || '操作未完成，请重试。');
  return response as Response & Record<string, unknown>;
}

function report(text: string, kind: 'success' | 'error' | 'info' = 'success'): void {
  feedback.className = `feedback feedback-${kind}`;
  feedback.textContent = text;
  feedback.hidden = false;
}

function readSettings(): Settings {
  return { baseUrl: baseInput.value.trim(), model: modelInput.value.trim(), autoSummary: autoInput.checked, rememberKey: rememberInput.checked, inputBudgetTokens: Number(budgetInput.value), autoLongSummary: autoLongInput.checked };
}

function endpointFor(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('请输入完整的接口地址，如 https://api.example.com/v1。'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('接口地址请勿包含账号、密码、查询参数或 # 片段。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('请输入 HTTPS 接口，或 localhost / 127.0.0.1 的 HTTP 接口。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}

function updateEndpoint(): void {
  const target = element<HTMLParagraphElement>('endpoint-preview');
  if (!baseInput.value.trim()) {
    target.textContent = '填写后显示实际请求地址';
    target.classList.remove('invalid');
    return;
  }
  try {
    target.textContent = `请求地址：${endpointFor(baseInput.value.trim())}`;
    target.classList.remove('invalid');
  } catch (error) {
    target.textContent = error instanceof Error ? error.message : '请检查接口地址。';
    target.classList.add('invalid');
  }
}

function updateDirty(): void {
  if (!loaded) return;
  const dirty = JSON.stringify(readSettings()) !== JSON.stringify(savedSettings) || keyInput.value.length > 0;
  saveState.textContent = dirty ? '有未保存的更改' : '已保存到本机';
  saveState.classList.toggle('is-dirty', dirty);
}

function renderPermissions(origins: string[]): void {
  const list = element<HTMLUListElement>('permission-list');
  list.replaceChildren();
  const sorted = [...origins].sort();
  element('permission-count').textContent = `${sorted.length} 条`;
  const broadHttps = origins.includes('https://*/*');
  element('permission-status').textContent = broadHttps ? 'HTTPS 网页访问已启用' : origins.length ? '已按域授权，请确认来源页、目标页及接口均已覆盖' : '尚未授权；授权后可识别链接拖动并读取正文';
  element('permission-dot').classList.toggle('is-enabled', origins.length > 0);
  element<HTMLButtonElement>('grant-https').textContent = broadHttps ? 'HTTPS 访问已授权' : '启用 HTTPS 网页访问';
  if (!sorted.length) {
    const empty = document.createElement('li');
    empty.className = 'permission-empty';
    empty.textContent = '暂无网站授权';
    list.append(empty);
  }
  for (const origin of sorted) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = origin;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-permission';
    remove.textContent = '撤销';
    remove.setAttribute('aria-label', `撤销 ${origin} 的访问权限`);
    remove.addEventListener('click', () => {
      void perform(async () => {
        const removed = await chrome.permissions.remove({ origins: [origin] });
        await refresh(false);
        report(removed ? `已撤销 ${origin} 的访问权限，相关摘要任务将停止。` : '该权限未被移除，请检查浏览器扩展权限设置。', removed ? 'success' : 'error');
      });
    });
    item.append(label, remove);
    list.append(item);
  }
}

async function refresh(replaceForm: boolean): Promise<SettingsView> {
  const result = await message('settings:get');
  const view = result as unknown as SettingsView;
  if (!view.settings || !Array.isArray(view.permissions)) throw new Error('设置读取失败，请重新加载扩展。');
  hasKey = view.hasKey;
  if (replaceForm) {
    savedSettings = { ...view.settings };
    baseInput.value = view.settings.baseUrl;
    modelInput.value = view.settings.model;
    autoInput.checked = view.settings.autoSummary;
    budgetInput.value = String(view.settings.inputBudgetTokens ?? DEFAULT_SETTINGS.inputBudgetTokens);
    autoLongInput.checked = view.settings.autoLongSummary ?? false;
    rememberInput.checked = view.settings.rememberKey;
    loaded = true;
  }
  element('key-status').textContent = hasKey ? (view.settings.rememberKey ? '已有本机 Key' : '已有会话 Key') : '尚未保存 Key';
  keyClearButton.disabled = busy || !hasKey;
  element('cache-count').textContent = String(view.cacheCount ?? 0);
  const warning = element<HTMLDivElement>('storage-warning');
  warning.textContent = view.warning || '';
  warning.hidden = !view.warning;
  renderPermissions(view.permissions);
  updateEndpoint();
  updateDirty();
  return view;
}

async function perform(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll<HTMLButtonElement>('button')];
  controls.forEach(control => { control.disabled = true; });
  try {
    await action();
  } catch (error) {
    report(error instanceof Error ? error.message : '操作未完成，请重试。', 'error');
  } finally {
    busy = false;
    document.querySelectorAll<HTMLButtonElement>('button').forEach(control => { control.disabled = false; });
    keyClearButton.disabled = !hasKey;
    testButton.textContent = '保存并测试连接';
    updateConnectionControls();
  }
}

function selectedProvider(): ChatConnectionConfig['provider'] { return oauthConnection.checked ? 'chatgptOAuth' : 'apiKey'; }
function selectedConnection(): ChatConnectionConfig {
  const provider = selectedProvider();
  return { provider, model: provider === 'chatgptOAuth' ? oauthModel.value || '' : '' };
}

function connectionDirty(): boolean {
  if (!connectionView) return false;
  const current = selectedConnection();
  return current.provider !== connectionView.config.provider
    || current.provider === 'chatgptOAuth' && current.model !== connectionView.config.model;
}

function connectionReport(text: string, error = false): void {
  const target = element('connection-feedback');
  target.textContent = text;
  target.classList.toggle('is-error', error);
  target.hidden = !text;
}

function updateConnectionControls(): void {
  const isOAuth = selectedProvider() === 'chatgptOAuth';
  const disabled = busy || connectionBusy || !connectionLoaded;
  element('siwc-details').hidden = !isOAuth;
  apiConnection.disabled = disabled;
  oauthConnection.disabled = disabled;
  oauthModel.disabled = disabled || !siwcView?.status.planAuthorized || !siwcView.status.models.length;
  element<HTMLButtonElement>('save-connection').disabled = disabled;
  for (const id of ['siwc-login', 'siwc-refresh', 'siwc-new-account']) element<HTMLButtonElement>(id).disabled = disabled;
  element<HTMLButtonElement>('siwc-logout').disabled = disabled || !siwcView?.status.loggedIn;
  element<HTMLButtonElement>('siwc-copy-diagnostics').disabled = busy || !siwcView;
  const authorizing = siwcAuthorizing || !!siwcView?.status.loginPending;
  element('siwc-cancel').hidden = !authorizing;
  element<HTMLButtonElement>('siwc-cancel').disabled = busy || siwcCancelling || !authorizing;
  element<HTMLButtonElement>('siwc-login').textContent = authorizing ? '等待 OpenAI 登录授权…' : '使用 ChatGPT 登录 ↗';
  const dirty = connectionDirty();
  element('connection-save-state').textContent = connectionBusy ? '正在处理…' : !connectionLoaded ? '连接配置尚未读取' : dirty ? '有未保存的更改' : '已保存到本机';
  element('connection-save-state').classList.toggle('is-dirty', dirty);
}

function renderConnection(view: ChatConnectionView, replaceChoice: boolean): void {
  ++connectionReadVersion;
  connectionView = view;
  connectionLoaded = true;
  if (replaceChoice) {
    apiConnection.checked = view.config.provider === 'apiKey';
    oauthConnection.checked = view.config.provider === 'chatgptOAuth';
    if (siwcView) renderOAuthModels(siwcView, true);
  }
  if (view.migration === 'webModeRemoved' && !migrationNotified) {
    migrationNotified = true;
    connectionReport('ChatGPT 网页模式已移除，请选择官方订阅或模型 API。');
  }
  updateConnectionControls();
}

function renderOAuthModels(view: SiwcView, replaceChoice: boolean): void {
  const previousModel = oauthModel.value;
  const savedConfig = connectionView?.config ?? view.config;
  const savedModel = savedConfig.provider === 'chatgptOAuth' ? savedConfig.model : '';
  const wanted = replaceChoice ? savedModel : previousModel || savedModel;
  oauthModel.replaceChildren();
  for (const model of view.status.models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    oauthModel.append(option);
  }
  if (view.status.models.some(model => model.id === wanted)) oauthModel.value = wanted;
  if (!view.status.models.length || wanted && !view.status.models.some(model => model.id === wanted)) {
    const option = document.createElement('option');
    option.value = wanted;
    option.textContent = option.value ? `已保存：${option.value}（请刷新确认）` : '授权套餐用量后选择可用模型';
    oauthModel.append(option);
    oauthModel.value = wanted;
  }
}

function renderSiwc(view: SiwcView, replaceChoice: boolean): void {
  ++siwcReadVersion;
  siwcView = view;
  renderOAuthModels(view, replaceChoice);
  element('siwc-status').textContent = view.status.loginPending ? '等待 OpenAI 官方页面完成授权' : siwcStatusText(view.status);
  element('siwc-identity').textContent = view.status.loggedIn ? '已登录' : '尚未登录';
  element('siwc-entitlement').textContent = view.status.planAuthorized ? '已授权' : view.status.loggedIn ? '尚未授权，请重新登录并允许套餐用量' : '尚未授权';
  element('siwc-state-dot').classList.toggle('is-ready', view.status.state === 'ready' && view.status.generation === 'working');
  element('siwc-account').textContent = view.status.accountLabel || '';
  element('siwc-account').hidden = !view.status.accountLabel;
  element('siwc-failure').textContent = view.status.error || '';
  element('siwc-failure').hidden = !view.status.error;
  const diagnosticText = siwcDiagnosticText(view.status.diagnostic);
  element('siwc-diagnostic').textContent = diagnosticText;
  element('siwc-diagnostic').hidden = !diagnosticText;
  element('siwc-diagnostic').classList.toggle('is-error', view.status.generation === 'blocked');
  element('siwc-helper-help').hidden = !!view.status.helperVersion && view.status.state !== 'helperMissing';
  element('siwc-logout-notice').hidden = view.status.remoteRevoked !== false || view.status.loggedIn;
  updateConnectionControls();
}

async function siwcMessage(type: string, payload: Record<string, unknown> = {}): Promise<SiwcView> {
  const result = await message(type, payload);
  const view = result.view as SiwcView | undefined;
  if (!view?.config || !view.status || !Array.isArray(view.status.models)) throw new Error('官方登录状态读取失败，请重新加载扩展后重试。');
  return view;
}

async function connectionMessage(type: string, payload: Record<string, unknown> = {}): Promise<ChatConnectionView> {
  const result = await message(type, payload);
  const view = result.view as ChatConnectionView | undefined;
  if (!view?.config || !['apiKey', 'chatgptOAuth'].includes(view.config.provider) || typeof view.config.model !== 'string') throw new Error('对话连接配置读取失败，请重新加载扩展后重试。');
  return view;
}

async function performConnection(action: () => Promise<void>): Promise<void> {
  if (busy || connectionBusy) return;
  connectionBusy = true;
  connectionReport('');
  updateConnectionControls();
  try { await action(); }
  catch (error) { connectionReport(error instanceof Error ? error.message : '对话连接操作未完成，请重试。', true); }
  finally { connectionBusy = false; updateConnectionControls(); }
}

connectionForm.addEventListener('change', () => {
  ++connectionEditVersion;
  connectionReport('');
  updateConnectionControls();
});
connectionForm.addEventListener('submit', event => {
  event.preventDefault();
  void performConnection(async () => {
    const config = selectedConnection();
    if (config.provider === 'chatgptOAuth') {
      if (!siwcView?.status.planAuthorized || !siwcView.status.models.some(model => model.id === config.model)) throw new Error('请先完成官方登录并授权套餐用量，刷新并选择可用模型后保存。');
      const view = await siwcMessage('siwc:save', { config });
      renderConnection({ config: view.config }, true);
      renderSiwc(view, true);
      notifyConnectionChanged();
      connectionReport('已保存 ChatGPT 订阅连接。请到「对话」发送问题验证；正常聊天无需保留官网标签页。当前正在生成的回答会停止。');
      return;
    }
    const view = await connectionMessage('connection:save', { config });
    renderConnection(view, true);
    notifyConnectionChanged();
    connectionReport('已切换为模型 API。侧栏对话使用下方保存的接口与 Key。');
  });
});

function requestSiwc(type: 'siwc:login' | 'siwc:refresh', newAccount = false): void {
  if (busy || connectionBusy || !connectionLoaded) return;
  // Keep the optional API permission request inside the trusted button gesture.
  const grant = chrome.permissions.request({ origins: [`${SIWC_API_ORIGIN}/*`] });
  void performConnection(async () => {
    if (!await grant) throw new Error('尚未获得 OpenAI 官方 API 访问权限。请再次点击并授权。');
    siwcAuthorizing = type === 'siwc:login';
    updateConnectionControls();
    connectionReport(type === 'siwc:login' ? '请在打开的 OpenAI 页面完成登录，并授权套餐用量。完成后会返回这里，尚未发送聊天问题。' : '正在检查本地助手、授权状态和可用模型…');
    try {
      const view = await siwcMessage(type, newAccount ? { newAccount: true } : {});
      renderSiwc(view, false);
      notifyConnectionChanged();
      if (view.status.state === 'ready' && view.status.planAuthorized) connectionReport('已获得套餐用量授权和可用模型。选择模型并保存，再到「对话」验证。尚未发送聊天问题。');
      else connectionReport(siwcStatusText(view.status), true);
    } finally { siwcAuthorizing = false; }
  });
}
element('siwc-login').addEventListener('click', () => requestSiwc('siwc:login'));
element('siwc-new-account').addEventListener('click', () => requestSiwc('siwc:login', true));
element('siwc-refresh').addEventListener('click', () => requestSiwc('siwc:refresh'));
element('siwc-copy-diagnostics').addEventListener('click', () => {
  if (busy || !siwcView) return;
  const text = formatSiwcDiagnostics(siwcView, chrome.runtime.getManifest().version);
  void navigator.clipboard.writeText(text).then(() => {
    connectionReport('已复制连接诊断，仅含版本、授权状态和响应结构，不含账号、凭证或对话内容。');
  }).catch(() => connectionReport('复制连接诊断失败，请允许剪贴板访问后重试。', true));
});
element('siwc-copy-id').addEventListener('click', () => {
  void navigator.clipboard.writeText(chrome.runtime.id).then(() => {
    connectionReport('已复制当前阅窗扩展 ID，可粘贴到本地助手安装命令中。');
  }).catch(() => {
    element<HTMLInputElement>('siwc-extension-id').select();
    connectionReport('复制未完成，已选中扩展 ID，可手动复制。', true);
  });
});
element('siwc-cancel').addEventListener('click', () => {
  if (busy || siwcCancelling || !siwcAuthorizing && !siwcView?.status.loginPending) return;
  siwcCancelling = true;
  updateConnectionControls();
  void siwcMessage('siwc:cancel').then(view => {
    renderSiwc(view, false);
    notifyConnectionChanged();
    connectionReport('已取消本次登录。可以关闭尚未完成授权的登录页面。');
  }).catch(error => connectionReport(error instanceof Error ? error.message : '取消登录失败，请重试。', true)).finally(() => {
    siwcCancelling = false;
    updateConnectionControls();
  });
});
element('siwc-logout').addEventListener('click', () => {
  void performConnection(async () => {
    let view: SiwcView;
    try { view = await siwcMessage('siwc:logout'); }
    catch (error) {
      notifyConnectionChanged();
      connectionReport(`${error instanceof Error ? error.message : '本地助手退出操作未完成。'}尚未确认本机凭证已清除，请检查助手后重试。`, true);
      return;
    }
    renderSiwc(view, false);
    notifyConnectionChanged();
    if (view.status.state !== 'signedOut') {
      connectionReport(`${view.status.error || siwcStatusText(view.status)}。尚未确认本机凭证已清除，请检查助手后重试。`, true);
      return;
    }
    connectionReport(view.status.remoteRevoked
      ? '已退出本机账号，清除本地凭证并撤销本次授权。当前正在生成的回答会停止。'
      : '已退出本机账号并清除本地凭证。远端授权撤销尚未确认，可在 OpenAI 账号的应用授权设置中检查。当前正在生成的回答会停止。');
  });
});

async function save(): Promise<void> {
  if (!form.reportValidity()) throw new Error('请补全接口地址和模型标识。');
  const settings = readSettings();
  endpointFor(settings.baseUrl);
  if (!settings.model) throw new Error('请填写模型标识。');
  const key = keyInput.value.trim();
  await message('settings:save', { settings, ...(key ? { key } : {}) });
  if (keyInput.value.trim() === key) keyInput.value = '';
  const view = await refresh(false);
  savedSettings = { ...view.settings };
  loaded = true;
  // Preserve any newer edits made while the background was saving.
  if (JSON.stringify(readSettings()) === JSON.stringify(settings)) {
    baseInput.value = view.settings.baseUrl;
    modelInput.value = view.settings.model;
  }
  updateEndpoint();
  updateDirty();
  notifyConnectionChanged();
}

form.addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    await save();
    report('配置已保存。可在已授权网页拖动链接，开始预览。');
  });
});

form.addEventListener('input', () => { element('test-result').hidden = true; updateEndpoint(); updateDirty(); });
form.addEventListener('change', updateDirty);

testButton.addEventListener('click', () => {
  void perform(async () => {
    await save();
    testButton.textContent = '正在测试连接…';
    element('test-result').hidden = true;
    report('正在向已配置的接口发送一次测试请求…', 'info');
    const result = await message('settings:test');
    element('test-text').textContent = String(result.text || '接口已返回成功响应。');
    element('test-result').hidden = false;
    report('连接测试成功。真实文章的摘要效果仍需在预览小窗中验证。');
  });
});

function requestOrigins(origins: string[]): void {
  if (busy) return;
  // Call request synchronously from the click handler to retain Chrome's user gesture.
  const request = chrome.permissions.request({ origins });
  void perform(async () => {
    const granted = await request;
    await refresh(false);
    report(granted ? '访问权限已授予。若网页尚未出现预览投放区，请刷新该网页。' : '授权未完成。你可以稍后再试，或仅授权指定的域。', granted ? 'success' : 'info');
  });
}

element('grant-https').addEventListener('click', () => requestOrigins(['https://*/*']));
element('grant-local').addEventListener('click', () => requestOrigins(['http://localhost/*', 'http://127.0.0.1/*']));
element('grant-origin').addEventListener('click', () => {
  try {
    let url: URL;
    try { url = new URL(permissionInput.value.trim()); }
    catch { throw new Error('请输入完整的网站地址，如 https://example.com。'); }
    if (url.username || url.password) throw new Error('网站地址请勿包含账号或密码。');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('只能授权 HTTPS 网站，或 localhost / 127.0.0.1 的 HTTP 地址。');
    }
    requestOrigins([`${url.protocol}//${url.hostname}/*`]);
  } catch (error) {
    report(error instanceof Error ? error.message : '请输入完整的网站地址，如 https://example.com。', 'error');
    permissionInput.focus();
  }
});

element('clear-cache').addEventListener('click', () => {
  void perform(async () => {
    await message('settings:clear-cache');
    await refresh(false);
    report('会话摘要缓存已清空。再次总结将发送新的模型请求。');
  });
});

keyClearButton.addEventListener('click', () => {
  void perform(async () => {
    await message('settings:clear-key');
    keyInput.value = '';
    await refresh(false);
    report('已清除本机与会话内保存的 Key。原网页预览仍可使用。');
  });
});

element('export-settings').addEventListener('click', () => {
  void perform(async () => {
    const result = await message('settings:export');
    const settings = result.settings as Settings;
    const exported: Settings = { baseUrl: settings.baseUrl, model: settings.model, autoSummary: settings.autoSummary, rememberKey: settings.rememberKey, inputBudgetTokens: settings.inputBudgetTokens, autoLongSummary: settings.autoLongSummary };
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'reading-assistant-settings.json';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    report('已导出保存的配置，不含 API Key。尚未保存的输入不会写入导出文件。');
  });
});

function refreshConnectionStatus(): void {
  refreshConnectionConfig();
  refreshSiwcStatus();
}
function refreshConnectionConfig(reportFailure = false): void {
  const version = ++connectionReadVersion;
  const editVersion = connectionEditVersion;
  const preserveChoice = connectionDirty();
  void connectionMessage('connection:get').then(view => {
    if (version !== connectionReadVersion) return;
    renderConnection(view, !preserveChoice && editVersion === connectionEditVersion && !connectionDirty());
  }).catch(error => {
    if (!reportFailure || version !== connectionReadVersion) return;
    connectionReport(error instanceof Error ? error.message : '对话连接配置读取失败，请重新加载扩展。', true);
    updateConnectionControls();
  });
}
function refreshSiwcStatus(reportFailure = false): void {
  const version = ++siwcReadVersion;
  void siwcMessage('siwc:get').then(view => {
    if (version === siwcReadVersion) renderSiwc(view, false);
  }).catch(error => {
    if (!reportFailure || version !== siwcReadVersion) return;
    element('siwc-failure').textContent = error instanceof Error ? error.message : '官方登录状态读取失败。';
    element('siwc-failure').hidden = false;
  });
}
window.addEventListener('message', event => {
  if (location.search !== '?panel=1' || window.parent === window || event.origin !== location.origin || event.source !== window.parent) return;
  if (!event.data || typeof event.data !== 'object') return;
  if (event.data.type === 'reader:settings-visible') refreshConnectionStatus();
  if (event.data.type === 'reader:connection-state') refreshSiwcStatus();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshConnectionStatus(); });
chrome.permissions.onAdded.addListener(() => { void refresh(false).catch(() => undefined); refreshConnectionStatus(); });
chrome.permissions.onRemoved.addListener(() => { void refresh(false).catch(() => undefined); refreshConnectionStatus(); });

void perform(async () => { await refresh(true); });
refreshConnectionConfig(true);
refreshSiwcStatus(true);
