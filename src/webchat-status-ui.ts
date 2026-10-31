import type { WebChatFailureInfo, WebChatStatus, WebChatView } from './webchat-shared';

const failureLabels = {
  signedOut: '登录状态已失效，请在 ChatGPT 网页登录后重新检查。',
  verificationRequired: '网页要求额外验证，请到 ChatGPT 官方页面处理后手动重试。',
  accessDenied: '网页拒绝了本次请求；登录成功仍可能无法通过此实验连接发送消息。',
  quota: '账号当前额度或请求频率受限，请以 ChatGPT 网页提示为准。',
  network: '账号连接失败，请检查网络后手动重试。',
  format: '网页响应格式发生变化，本次请求已停止。',
  interrupted: '网页已关闭、跳转或请求被停止。',
  model: '所选模型当前不可用，请检查 ChatGPT 网页及模型列表。',
  timeout: '网页响应超时，本次请求已停止。',
  pageBusy: 'ChatGPT 账号连接正在处理另一项请求，请稍后重试。',
  pageChanged: 'ChatGPT 连接页面已更新，本次请求已停止，请到设置重新检查账号。',
  pageUnsupported: 'ChatGPT 网页客户端暂不兼容，请刷新官网页面后重新检查账号。',
} as const;
const stageLabels: Record<WebChatFailureInfo['stage'], string> = {
  client: '网页客户端', requirements: '请求准备',
  session: '登录检查', models: '模型列表', conversation: '对话请求',
};

/** Only the fixed protocol fields may become diagnostic UI text. */
export function validWebChatFailure(value: unknown): value is WebChatFailureInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as WebChatFailureInfo;
  return typeof candidate.stage === 'string' && Object.hasOwn(stageLabels, candidate.stage)
    && typeof candidate.code === 'string' && Object.hasOwn(failureLabels, candidate.code)
    && (candidate.httpStatus === undefined || Number.isInteger(candidate.httpStatus) && candidate.httpStatus >= 100 && candidate.httpStatus <= 599);
}

export function webChatFailureText(value: unknown): string {
  if (!validWebChatFailure(value)) return '';
  const status = value.httpStatus === undefined ? '' : ` · HTTP ${value.httpStatus}`;
  return `${stageLabels[value.stage]}${status}：${failureLabels[value.code]}`;
}

export function webChatStatusText(status: Pick<WebChatStatus, 'state' | 'generation' | 'transport'>): string {
  if (status.transport === 'page') return '旧版官网页面发送已停用，请更新连接设置';
  if (status.state === 'ready') {
    if (status.generation === 'working') return '已登录；最近一次对话成功';
    if (status.generation === 'blocked') return '已登录；最近一次对话失败';
    return '已登录，模型列表已读取；对话尚未验证';
  }
  const labels: Record<Exclude<WebChatStatus['state'], 'ready'>, string> = {
    unchecked: '尚未检查 ChatGPT 账号',
    signedOut: '请先在 ChatGPT 网页登录',
    missingTab: '账号连接尚未初始化，请到设置检查账号',
    permissionRequired: '请先授权 chatgpt.com 访问权限',
    verificationRequired: '请在 ChatGPT 网页完成验证',
    error: 'ChatGPT 登录或模型读取失败',
  };
  return labels[status.state];
}

export function webChatDiagnosticSnapshot(view: WebChatView, version: string) {
  const failure = view.status.lastFailure;
  const states = ['unchecked', 'ready', 'signedOut', 'missingTab', 'permissionRequired', 'verificationRequired', 'error'];
  const generation = view.status.generation === 'working' || view.status.generation === 'blocked' ? view.status.generation : 'unchecked';
  return {
    version: /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(version) ? version : 'unknown',
    provider: view.config.provider === 'apiKey' || view.config.provider === 'chatgptWeb' ? view.config.provider : 'unknown',
    ...(view.config.transport === 'page' || view.config.transport === 'direct' || view.config.transport === 'webapp' ? { transport: view.config.transport } : {}),
    status: {
      state: states.includes(view.status.state) ? view.status.state : 'unknown',
      loggedIn: view.status.loggedIn === true,
      generation,
      ...(validWebChatFailure(failure) ? { lastFailure: {
        stage: failure.stage,
        ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
        code: failure.code,
      } } : {}),
    },
  };
}

export function formatWebChatDiagnostics(view: WebChatView, version: string): string {
  const snapshot = webChatDiagnosticSnapshot(view, version);
  const description = snapshot.status.generation === 'working' ? '最近一次对话成功。' : snapshot.status.generation === 'blocked' ? '最近一次对话失败。' : snapshot.transport === 'page' ? '旧版官网页面发送已停用，请在设置中更新连接。' : '对话尚未验证；登录和模型检查不验证对话能力。';
  return `阅窗连接诊断\n${JSON.stringify(snapshot, null, 2)}\n${description}`;
}
