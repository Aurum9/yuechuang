import { SIWC_DIAGNOSTIC_EVENTS, SIWC_DIAGNOSTIC_KEYS, SIWC_DIAGNOSTIC_REASONS, SIWC_VALUE_TYPES, type SiwcDiagnostic, type SiwcView } from './siwc-shared';

const stages = ['preflight', 'credentials', 'models', 'headers', 'event', 'completion', 'stream'] as const;
const contentTypes = ['text/event-stream', 'application/json', 'text/html', 'other', 'missing'] as const;
const responseStatuses = ['missing', 'queued', 'in_progress', 'completed', 'failed', 'incomplete', 'cancelled', 'other'] as const;
const states = ['unchecked', 'signedOut', 'ready', 'planDenied', 'reauthRequired', 'permissionRequired', 'error'] as const;
const stageLabels: Record<SiwcDiagnostic['stage'], string> = { preflight: '请求准备', credentials: '登录凭证', models: '模型列表', headers: '响应头', event: '流式事件', completion: '回答完成检查', stream: '响应流' };
const reasonLabels: Record<NonNullable<SiwcDiagnostic['reason']>, string> = {
  requestInvalid: '请求结构不符合要求', nonEventStream: '未收到预期的流式响应', invalidJson: '事件内容无法解析', invalidEvent: '事件结构不符合要求',
  responseChanged: '同一响应中的标识发生变化', invalidDelta: '文本片段结构不符合要求', terminalResponseMissing: '结束事件缺少响应信息',
  terminalStatus: '结束事件的状态不符合要求', emptyText: '未收到可显示的回答文本', eventTooLarge: '单个事件超过大小上限', streamTooLarge: '响应超过大小上限',
  streamEnded: '响应在完成前结束', modelCatalog: '模型列表结构不符合要求', authFailure: '登录授权操作未完成', httpError: '官方接口返回错误',
  timeout: '请求超时', unknown: '响应结构尚待确认',
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function allowed<T extends string>(value: unknown, values: readonly T[]): value is T { return typeof value === 'string' && values.includes(value as T); }
function fieldNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return;
  const names: string[] = [];
  for (const key of value.slice(0, 64)) if (allowed(key, SIWC_DIAGNOSTIC_KEYS) && !names.includes(key)) names.push(key);
  return names;
}

/** Rebuild the diagnostic from fixed values; no server prose or field values survive. */
export function sanitizeSiwcDiagnostic(value: unknown): SiwcDiagnostic | undefined {
  if (!object(value) || !allowed(value.stage, stages)) return;
  const safe: SiwcDiagnostic = { stage: value.stage };
  if (allowed(value.reason, SIWC_DIAGNOSTIC_REASONS)) safe.reason = value.reason;
  if (typeof value.httpStatus === 'number' && Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) safe.httpStatus = value.httpStatus;
  if (allowed(value.contentType, contentTypes)) safe.contentType = value.contentType;
  if (allowed(value.eventType, SIWC_DIAGNOSTIC_EVENTS)) safe.eventType = value.eventType;
  if (allowed(value.jsonType, SIWC_VALUE_TYPES)) safe.jsonType = value.jsonType;
  if (allowed(value.deltaType, SIWC_VALUE_TYPES)) safe.deltaType = value.deltaType;
  if (allowed(value.responseType, SIWC_VALUE_TYPES)) safe.responseType = value.responseType;
  if (allowed(value.responseStatus, responseStatuses)) safe.responseStatus = value.responseStatus;
  const eventKeys = fieldNames(value.eventKeys), responseKeys = fieldNames(value.responseKeys);
  if (eventKeys) safe.eventKeys = eventKeys;
  if (responseKeys) safe.responseKeys = responseKeys;
  return safe;
}

export function siwcDiagnosticText(value: unknown): string {
  const diagnostic = sanitizeSiwcDiagnostic(value);
  if (!diagnostic) return '';
  return `${stageLabels[diagnostic.stage]}${diagnostic.httpStatus === undefined ? '' : ` · HTTP ${diagnostic.httpStatus}`}：${diagnostic.reason ? reasonLabels[diagnostic.reason] : '已记录响应结构'}`;
}

export function siwcDiagnosticSnapshot(view: SiwcView, version: string) {
  const rawStatus: unknown = view?.status;
  const status: Record<string, unknown> = object(rawStatus) ? rawStatus : {};
  const diagnostic = sanitizeSiwcDiagnostic(status.diagnostic);
  return {
    version: /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(version) ? version : 'unknown',
    provider: 'chatgptOAuth' as const,
    state: allowed(status.state, states) ? status.state : 'unknown',
    loggedIn: status.loggedIn === true,
    planAuthorized: status.planAuthorized === true,
    generation: status.generation === 'working' || status.generation === 'blocked' ? status.generation : 'unchecked',
    ...(diagnostic ? { diagnostic } : {}),
  };
}

export function formatSiwcDiagnostics(view: SiwcView, version: string): string {
  return `阅窗官方登录连接诊断\n${JSON.stringify(siwcDiagnosticSnapshot(view, version), null, 2)}`;
}
