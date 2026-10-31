import type { ChatConnectionConfig } from './chat-connection-shared';
import type { WebChatModel } from './webchat-shared';

export const SIWC_HOST = 'com.yuechuang.helper';
export const SIWC_API_ORIGIN = 'https://api.openai.com';
export const SIWC_DIAGNOSTIC_REASONS = ['requestInvalid', 'nonEventStream', 'invalidJson', 'invalidEvent', 'responseChanged', 'invalidDelta', 'terminalResponseMissing', 'terminalStatus', 'emptyText', 'eventTooLarge', 'streamTooLarge', 'streamEnded', 'modelCatalog', 'nativeFailure', 'httpError', 'timeout', 'unknown'] as const;
export const SIWC_DIAGNOSTIC_EVENTS = ['response.created', 'response.in_progress', 'response.output_item.added', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done', 'response.output_text.delta', 'response.output_text.done', 'response.refusal.delta', 'response.refusal.done', 'response.reasoning_summary_text.delta', 'response.completed', 'response.failed', 'response.incomplete', 'error', 'doneMarker', 'other'] as const;
export const SIWC_DIAGNOSTIC_KEYS = ['type', 'response', 'delta', 'item_id', 'output_index', 'content_index', 'sequence_number', 'error', 'code', 'message', 'status', 'output', 'id', 'object', 'created_at', 'model', 'usage', 'content', 'role', 'text', 'data', 'event', 'done'] as const;
export const SIWC_VALUE_TYPES = ['undefined', 'object', 'array', 'string', 'number', 'boolean', 'null', 'invalid'] as const;
export interface SiwcDiagnostic {
  stage: 'preflight' | 'helper' | 'models' | 'headers' | 'event' | 'completion' | 'stream';
  reason?: typeof SIWC_DIAGNOSTIC_REASONS[number];
  httpStatus?: number;
  contentType?: 'text/event-stream' | 'application/json' | 'text/html' | 'other' | 'missing';
  eventType?: typeof SIWC_DIAGNOSTIC_EVENTS[number];
  eventKeys?: string[];
  jsonType?: typeof SIWC_VALUE_TYPES[number];
  deltaType?: typeof SIWC_VALUE_TYPES[number];
  responseType?: typeof SIWC_VALUE_TYPES[number];
  responseKeys?: string[];
  responseStatus?: 'missing' | 'queued' | 'in_progress' | 'completed' | 'failed' | 'incomplete' | 'cancelled' | 'other';
}
export type SiwcState = 'unchecked' | 'helperMissing' | 'signedOut' | 'ready' | 'planDenied' | 'reauthRequired' | 'permissionRequired' | 'error';
export interface SiwcStatus {
  state: SiwcState;
  loggedIn: boolean;
  planAuthorized: boolean;
  models: WebChatModel[];
  helperVersion?: string;
  accountLabel?: string;
  accountId?: string;
  loginPending?: boolean;
  generation: 'unchecked' | 'working' | 'blocked';
  error?: string;
  remoteRevoked?: boolean;
  diagnostic?: SiwcDiagnostic;
}
export interface SiwcView { config: ChatConnectionConfig; status: SiwcStatus }
export function siwcStatusText(status: SiwcStatus): string {
  if (status.state === 'ready') return status.generation === 'working' ? '套餐用量已授权；最近一次对话成功' : status.generation === 'blocked' ? '套餐用量已授权；最近一次对话失败' : '套餐用量已授权；对话尚未验证';
  const labels: Record<Exclude<SiwcState, 'ready'>, string> = {
    unchecked: '尚未检查本地助手', helperMissing: '本地助手未安装或未正确注册', signedOut: '尚未登录 ChatGPT',
    planDenied: '身份已验证，尚未授权套餐用量', reauthRequired: '授权已失效，请重新登录',
    permissionRequired: '请授权访问 OpenAI 官方 API', error: '连接检查失败，请查看提示',
  };
  return labels[status.state];
}
