import { knownWebFailure, validWebId, WebChatFailure } from './webchat-protocol';

/** Request-local hints. They are correlation data, never credentials. */
export interface WebChatStreamV2Options {
  conversationId?: string;
  userMessageId?: string;
  previousAssistantId?: string;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const MAX_WIRE = 4 * 1024 * 1024;
const MAX_FRAME = 1 * 1024 * 1024;
const MAX_TEXT = 40_000;
const MAX_PARTS = 100;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
type Operation = 'add' | 'replace' | 'append' | 'remove' | 'patch' | 'truncate';

// Keep a small, inert projection of each message. In particular, server supplied
// DIL code, tool arguments, URLs and arbitrary metadata are never retained.
const fields: Record<string, readonly string[]> = {
  '': ['conversation_id', 'message'],
  '/message': ['id', 'author', 'channel', 'recipient', 'content', 'status', 'end_turn', 'metadata'],
  '/message/author': ['role', 'name'],
  '/message/content': ['content_type', 'parts'],
  '/message/metadata': ['model_dil_v2', 'is_error', 'is_visually_hidden_from_conversation', 'reasoning_status', 'finish_details'],
  '/message/metadata/finish_details': ['type'],
  '/message/metadata/model_dil_v2': ['fallbackMarkdown', 'fallbackMarkdownVersion']
};
const leaves = new Set([
  '/conversation_id', '/message/id', '/message/author/role', '/message/author/name',
  '/message/channel', '/message/recipient', '/message/content/content_type',
  '/message/status', '/message/end_turn', '/message/metadata/model_dil_v2/fallbackMarkdown',
  '/message/metadata/model_dil_v2/fallbackMarkdownVersion', '/message/metadata/is_error',
  '/message/metadata/is_visually_hidden_from_conversation', '/message/metadata/reasoning_status', '/message/metadata/finish_details/type'
]);

function relevant(path: string): boolean {
  return owns(fields, path) || leaves.has(path) || path === '/message/content/parts' || /^\/message\/content\/parts\/(?:0|[1-9]\d?)$/.test(path);
}
function pointer(path: unknown): string[] {
  if (typeof path !== 'string' || path.length > 512 || (path !== '' && !path.startsWith('/'))) throw new WebChatFailure('format', 'conversation');
  const segments = path === '' ? [] : path.slice(1).split('/').map(segment => {
    if (/~(?:[^01]|$)/.test(segment)) throw new WebChatFailure('format', 'conversation');
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
  });
  if (segments.length > 12 || segments.some(segment => forbidden.has(segment))) throw new WebChatFailure('format', 'conversation');
  return segments;
}
function project(path: string, value: unknown): unknown {
  if (owns(fields, path)) {
    if (!record(value)) return value === null ? null : undefined;
    const projected: Record<string, unknown> = Object.create(null);
    for (const name of fields[path]) if (owns(value, name)) {
      const selected = project(`${path}/${name}`, value[name]);
      if (selected !== undefined) projected[name] = selected;
    }
    return projected;
  }
  if (path === '/message/content/parts') {
    if (!Array.isArray(value) || value.length > MAX_PARTS) throw new WebChatFailure('format', 'conversation');
    return value.map(part => typeof part === 'string' ? bounded(part) : null);
  }
  if (leaves.has(path) || /^\/message\/content\/parts\/(?:0|[1-9]\d?)$/.test(path)) {
    if (typeof value === 'string') return bounded(value);
    if (value === null || typeof value === 'boolean' || (path.endsWith('/fallbackMarkdownVersion') && typeof value === 'number')) return value;
    return undefined;
  }
}
function bounded(text: string): string {
  if (text.length > MAX_TEXT) throw new WebChatFailure('format', 'conversation');
  return text;
}
function merge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(source)) target[key] = source[key];
  return target;
}

/**
 * Text-only decoder for legacy snapshots and the observed delta-v1 envelope.
 * It does not evaluate compiled UI code or treat stream closure as completion.
 * Delta semantics were checked against the public official client asset
 * https://chatgpt.com/cdn/assets/418851.67ef6adb3f.js (2026-10-29), class S:
 * per-channel snapshots, top-level inherited c/p/o, scoped patch batches,
 * append and truncate. The implementation below keeps a bounded projection.
 * This remains an unsupported private protocol and needs live verification.
 */
export class WebChatStreamV2 {
  text = '';
  conversationId = '';
  parentId = '';
  done = false;
  private current: Record<string, unknown> = Object.create(null);
  private readonly channels = new Map<number, Record<string, unknown>>();
  private wireBytes = 0;
  private frames = 0;
  private lastPath = '';
  private lastOperation: Operation = 'add';
  private lastChannel = 0;
  private activeAnswerChannel: number | undefined;
  private ended = false;
  private failed = false;
  private currentAssistantId = '';
  private readonly encoder = new TextEncoder();

  constructor(private readonly onText: (text: string) => void, private readonly options: WebChatStreamV2Options = {}) {
    for (const value of Object.values(options)) if (value !== undefined && !validWebId(value)) throw new WebChatFailure('format', 'conversation');
    this.conversationId = options.conversationId ?? '';
  }

  accept(data: string, event?: string): void {
    try {
      if (this.failed || this.done || ++this.frames > 20_000) throw new WebChatFailure('format', 'conversation');
      const bytes = this.encoder.encode(data).byteLength;
      this.wireBytes += bytes;
      if (bytes > MAX_FRAME || this.wireBytes > MAX_WIRE) throw new WebChatFailure('format', 'conversation');
      if (data === '[DONE]') { this.done = true; return; }
      let value: unknown;
      try { value = JSON.parse(data); } catch { throw new WebChatFailure('format', 'conversation'); }
      if (event === 'delta_encoding' || (event === undefined && value === 'v1')) {
        if (value !== 'v1') throw new WebChatFailure('format', 'conversation');
        return;
      }
      if (!record(value)) throw new WebChatFailure('format', 'conversation');
      if (value.error || value.detail || event === 'error') throw new WebChatFailure(knownWebFailure(value) ?? 'format', 'conversation');
      if (value.type === 'input_message') {
        if (this.options.userMessageId && (!record(value.input_message) || value.input_message.id !== this.options.userMessageId)) throw new WebChatFailure('format', 'conversation');
        if (value.conversation_id !== undefined) this.checkConversation(value.conversation_id);
        return;
      }
      let channel = 0;
      if (owns(value, 'p') || owns(value, 'o') || owns(value, 'v') || owns(value, 'c')) {
        channel = owns(value, 'c') ? value.c as number : this.lastChannel;
        if (!Number.isSafeInteger(channel) || channel < 0 || (!this.channels.has(channel) && this.channels.size >= 16)) throw new WebChatFailure('format', 'conversation');
        const delta = { ...value, p: owns(value, 'p') ? value.p : this.lastPath, o: owns(value, 'o') ? value.o : this.lastOperation };
        this.current = this.channels.get(channel) ?? Object.create(null);
        this.apply(delta, '', 0);
        this.channels.set(channel, this.current);
        this.lastPath = delta.p as string;
        this.lastOperation = delta.o as Operation;
        this.lastChannel = channel;
      }
      else if (owns(value, 'message')) { this.current = project('', value) as Record<string, unknown>; this.channels.set(0, this.current); }
      else return; // Infrastructure/marker events are not answer or completion.
      this.refresh(channel);
    } catch (error) {
      this.failed = true;
      if (error instanceof WebChatFailure) throw error;
      throw new WebChatFailure('format', 'conversation');
    }
  }

  private apply(delta: Record<string, unknown>, scope: string, depth: number): void {
    if (depth > 4) throw new WebChatFailure('format', 'conversation');
    const localPath = owns(delta, 'p') ? delta.p : '';
    pointer(localPath);
    const path = scope + localPath;
    const operation = delta.o;
    const segments = pointer(path);
    if (typeof operation !== 'string' || !['add', 'replace', 'append', 'remove', 'patch', 'truncate'].includes(operation)) throw new WebChatFailure('format', 'conversation');
    if (operation === 'patch') {
      if (!Array.isArray(delta.v) || delta.v.length > 256) throw new WebChatFailure('format', 'conversation');
      for (const item of delta.v) {
        if (!record(item)) throw new WebChatFailure('format', 'conversation');
        this.apply(item, path as string, depth + 1);
      }
      return;
    }
    if ((path === '/error' || path === '/detail') && delta.v) throw new WebChatFailure(knownWebFailure({ [path.slice(1)]: delta.v }) ?? 'format', 'conversation');
    if (!relevant(path as string)) {
      if ((path as string).startsWith('/message/content/parts/')) throw new WebChatFailure('format', 'conversation');
      return;
    }
    if (operation !== 'remove' && !owns(delta, 'v')) throw new WebChatFailure('format', 'conversation');
    if (!segments.length) {
      if (operation === 'remove') { this.current = Object.create(null); return; }
      if (operation === 'truncate') throw new WebChatFailure('format', 'conversation');
      if (record(delta.v) && (delta.v.error || delta.v.detail)) throw new WebChatFailure(knownWebFailure(delta.v) ?? 'format', 'conversation');
      const next = project('', delta.v);
      if (!record(next)) throw new WebChatFailure('format', 'conversation');
      this.current = operation === 'append' ? merge(this.current, next) : next;
      return;
    }
    let target: Record<string, unknown> | unknown[] = this.current;
    for (let index = 0; index < segments.length - 1; index++) {
      const key = segments[index];
      const child: unknown = (target as Record<string, unknown>)[key];
      if (!record(child) && !Array.isArray(child)) {
        if (operation === 'remove') return;
        const prefix = '/' + segments.slice(0, index + 1).join('/');
        (target as Record<string, unknown>)[key] = prefix === '/message/content/parts' ? [] : Object.create(null);
        target = (target as Record<string, unknown>)[key] as Record<string, unknown> | unknown[];
        continue;
      }
      target = child;
    }
    const key = segments.at(-1)!;
    const arrayIndex = Array.isArray(target) ? Number(key) : undefined;
    if (arrayIndex !== undefined && (!/^(?:0|[1-9]\d?)$/.test(key) || arrayIndex >= MAX_PARTS || arrayIndex > (target as unknown[]).length)) throw new WebChatFailure('format', 'conversation');
    if (operation === 'remove') {
      if (Array.isArray(target)) target.splice(arrayIndex!, 1);
      else delete target[key];
      return;
    }
    const previous = (target as Record<string, unknown>)[key];
    if (operation === 'truncate') {
      if (!Number.isSafeInteger(delta.v) || (delta.v as number) < 0 || (delta.v as number) > MAX_TEXT) throw new WebChatFailure('format', 'conversation');
      if (typeof previous === 'string') (target as Record<string, unknown>)[key] = previous.slice(0, delta.v as number);
      else if (Array.isArray(previous)) previous.length = Math.min(previous.length, delta.v as number);
      return;
    }
    const next = project(path as string, path === '/message/content/parts' && operation === 'append' && !Array.isArray(delta.v) ? [delta.v] : delta.v);
    if (next === undefined) throw new WebChatFailure('format', 'conversation');
    let replacement = next;
    if (operation === 'append') {
      if (typeof previous === 'string' && typeof next === 'string') replacement = bounded(previous + next);
      else if (Array.isArray(previous) && Array.isArray(next)) {
        if (previous.length + next.length > MAX_PARTS) throw new WebChatFailure('format', 'conversation');
        replacement = [...previous, ...next];
      } else if (record(previous) && record(next)) replacement = merge(previous, next);
      else if (previous !== undefined) throw new WebChatFailure('format', 'conversation');
    }
    if (Array.isArray(target) && operation === 'add') {
      if (target.length >= MAX_PARTS) throw new WebChatFailure('format', 'conversation');
      target.splice(arrayIndex!, 0, replacement);
    }
    else (target as Record<string, unknown>)[key] = replacement;
  }

  private refresh(channel: number): void {
    const id = this.current.conversation_id;
    // The official message envelope declares conversation_id nullable. Early
    // snapshots may precede assignment; they must not erase an already pinned ID.
    if (id !== undefined && id !== null) this.checkConversation(id);
    const message = this.current.message;
    if (!record(message) || !record(message.author)) { this.clearCurrent(channel); return; }
    if (message.author.role === 'user') {
      // The response also carries hidden user-authored settings/context with
      // their own IDs. Only the visible input echo belongs to the sent message.
      const metadata = message.metadata;
      const content = message.content;
      if ((record(metadata) && metadata.is_visually_hidden_from_conversation === true) ||
        (record(content) && content.content_type === 'user_editable_context')) {
        this.clearCurrent(channel); return;
      }
      if (this.options.userMessageId && message.id !== this.options.userMessageId) throw new WebChatFailure('format', 'conversation');
      this.clearCurrent(channel); return;
    }
    if (message.author.role !== 'assistant') { this.clearCurrent(channel); return; }
    if (!validWebId(message.id) || message.id === this.options.previousAssistantId) throw new WebChatFailure('format', 'conversation');
    const finalChannel = message.channel === undefined || message.channel === null || message.channel === 'final';
    const publicRecipient = message.recipient === undefined || message.recipient === null || message.recipient === 'all';
    if (!finalChannel || !publicRecipient || ((message.channel === undefined || message.channel === null) && message.author.name != null)) { this.clearCurrent(channel); return; }
    const content = message.content;
    const metadata = message.metadata;
    const dil = record(metadata) ? metadata.model_dil_v2 : undefined;
    let answer: string | undefined;
    if (record(metadata) && (metadata.is_error === true || metadata.is_visually_hidden_from_conversation === true || metadata.reasoning_status != null)) { this.clearCurrent(channel); return; }
    if (record(dil)) answer = dil.fallbackMarkdownVersion === 1 && typeof dil.fallbackMarkdown === 'string' ? dil.fallbackMarkdown : undefined;
    else if (record(content) && content.content_type === 'text' && Array.isArray(content.parts) && content.parts.every(part => typeof part === 'string')) answer = bounded(content.parts.join('\n'));
    if (answer === undefined) { this.clearCurrent(channel); return; }
    if (message.id !== this.currentAssistantId) {
      this.currentAssistantId = message.id;
      this.ended = false;
    }
    this.activeAnswerChannel = channel;
    this.parentId = message.id;
    const finish = record(metadata) && record(metadata.finish_details) ? metadata.finish_details.type : undefined;
    this.ended = message.status === 'finished_successfully' && message.end_turn !== false && finish !== 'interrupted' && finish !== 'content_filter';
    if (answer !== this.text) { this.text = answer; this.onText(answer); }
  }

  private clearCurrent(channel: number): void {
    if (this.activeAnswerChannel !== undefined && this.activeAnswerChannel !== channel) return;
    this.ended = false;
    this.parentId = '';
    if (this.text) { this.text = ''; this.onText(''); }
  }

  private checkConversation(id: unknown): void {
    if (!validWebId(id) || (this.conversationId && this.conversationId !== id)) throw new WebChatFailure('format', 'conversation');
    this.conversationId = id;
  }

  finish() {
    if (this.failed || !this.ended || !this.text.trim() || !this.conversationId || !this.parentId) throw new WebChatFailure('interrupted', 'conversation');
    return { text: this.text, conversation: { id: this.conversationId, parentId: this.parentId } };
  }
}
