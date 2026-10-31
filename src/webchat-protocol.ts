import type { WebChatErrorCode, WebChatFailureInfo, WebChatInput, WebChatModel, WebChatPageCommand } from './webchat-shared';

export class WebChatFailure extends Error {
  constructor(public readonly code: WebChatErrorCode, public readonly stage?: WebChatFailureInfo['stage'], public readonly httpStatus?: number) { super(code); }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const validWebId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
export function pageCommand(value: unknown): WebChatPageCommand | undefined {
  if (!record(value) || !validWebId(value.id)) return;
  if (value.type === 'status' || value.type === 'cancel') return { type: value.type, id: value.id };
  if (value.type !== 'generate' || !validWebId(value.model) || !Array.isArray(value.messages) || !value.messages.length || value.messages.length > 41) return;
  let size = 0;
  const messages: WebChatInput[] = [];
  for (const item of value.messages) {
    if (!record(item) || !['system', 'user', 'assistant'].includes(String(item.role)) || typeof item.content !== 'string' || !item.content.trim()) return;
    size += item.content.length;
    if (size > 200_000) return;
    messages.push({ role: item.role as WebChatInput['role'], content: item.content });
  }
  if (messages.at(-1)?.role !== 'user') return;
  let conversation;
  if (value.conversation !== undefined) {
    if (!record(value.conversation) || !validWebId(value.conversation.id) || !validWebId(value.conversation.parentId)) return;
    conversation = { id: value.conversation.id, parentId: value.conversation.parentId };
  }
  return { type: 'generate', id: value.id, model: value.model, messages, ...(conversation ? { conversation } : {}) };
}
export function parseWebModels(value: unknown): WebChatModel[] {
  if (!record(value) || !Array.isArray(value.models)) throw new WebChatFailure('format');
  const result: WebChatModel[] = [];
  for (const item of value.models.slice(0, 100)) {
    if (!record(item)) continue;
    const id = item.slug ?? item.id;
    const label = item.title ?? item.display_name ?? item.name ?? id;
    if (!validWebId(id) || typeof label !== 'string' || !label.trim()) continue;
    if (!result.some(model => model.id === id)) result.push({ id, label: label.trim().slice(0, 160) });
  }
  if (!result.length) throw new WebChatFailure('model');
  return result;
}
export function webHttpFailure(status: number): WebChatErrorCode {
  if (status === 401) return 'signedOut';
  if (status === 403) return 'accessDenied';
  if (status === 429) return 'quota';
  if (status === 400 || status === 404 || status === 422) return 'format';
  return 'network';
}
/** Classify only exact known codes; never expose or infer a cause from arbitrary server prose. */
export function knownWebFailure(value: unknown): WebChatErrorCode | undefined {
  if (!record(value)) return;
  const failure = record(value.error) ? value.error : record(value.detail) ? value.detail : value;
  const code = failure.code ?? failure.type;
  if (typeof code !== 'string') return;
  if (['captcha_required', 'challenge_required', 'verification_required'].includes(code)) return 'verificationRequired';
  if (['sentinel_required', 'chat_requirements_required', 'proof_of_work_required'].includes(code)) return 'accessDenied';
  if (['rate_limit_exceeded', 'quota_exceeded', 'insufficient_quota'].includes(code)) return 'quota';
  if (['session_expired', 'token_expired', 'invalid_token', 'unauthenticated'].includes(code)) return 'signedOut';
  if (['model_not_found', 'model_not_available', 'invalid_model'].includes(code)) return 'model';
}
export function webConversationBody(command: Extract<WebChatPageCommand, { type: 'generate' }>, uuid: () => string) {
  // A lost/reset association starts a new remote thread with the completed local context.
  // Continuations send only the new turn, leaving ChatGPT's existing history authoritative.
  const selected = command.conversation ? command.messages.slice(-1) : command.messages;
  const instruction = selected.filter(message => message.role === 'system').map(message => message.content).join('\n');
  const messages = selected.filter(message => message.role !== 'system').map((message, index) => ({
    id: uuid(), author: { role: message.role },
    content: { content_type: 'text', parts: [index === 0 && instruction ? `${instruction}\n\n${message.content}` : message.content] }
  }));
  return {
    action: 'next', messages, model: command.model,
    parent_message_id: command.conversation?.parentId ?? uuid(),
    ...(command.conversation ? { conversation_id: command.conversation.id } : {}),
    history_and_training_disabled: false
  };
}

/** Only ordinary assistant text snapshots are supported. Unknown private protocols fail closed. */
export class WebChatStream {
  text = '';
  conversationId = '';
  parentId = '';
  done = false;
  private ended = false;
  constructor(private readonly onText: (text: string) => void) {}
  accept(data: string) {
    if (data === '[DONE]') { this.done = true; return; }
    if (this.done || data.length > 200_000) throw new WebChatFailure('format');
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw new WebChatFailure('format'); }
    if (!record(value)) throw new WebChatFailure('format');
    if (value.error || value.detail) {
      throw new WebChatFailure(knownWebFailure(value) ?? 'format', 'conversation');
    }
    const message = value.message;
    if (!record(message) || !record(message.author) || message.author.role !== 'assistant') return;
    if (!record(message.content) || message.content.content_type !== 'text' || !Array.isArray(message.content.parts) || !message.content.parts.every(part => typeof part === 'string')) throw new WebChatFailure('format');
    const text = message.content.parts.join('\n');
    if (text.length > 40_000) throw new WebChatFailure('format');
    if (validWebId(value.conversation_id)) this.conversationId = value.conversation_id;
    if (validWebId(message.id)) {
      if (this.parentId !== message.id) this.ended = false;
      this.parentId = message.id;
    }
    this.ended = message.end_turn === true || (message.end_turn !== false && message.status === 'finished_successfully');
    if (text !== this.text) { this.text = text; this.onText(text); }
  }
  finish() {
    if (!this.ended || !this.text.trim() || !this.conversationId || !this.parentId) throw new WebChatFailure('interrupted');
    return { text: this.text, conversation: { id: this.conversationId, parentId: this.parentId } };
  }
}
