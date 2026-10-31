import {
  MAX_CONTEXT_PARAGRAPHS, MAX_CONTEXT_SELECTION, MAX_CONTEXT_TITLE, MAX_CONTEXT_URL,
  normalizeContextSelection
} from './context-shared';
import { allowedUrl } from './core';
import { secureStorage } from './store';

export interface SavedPhrase {
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
export type PhraseInput = Pick<SavedPhrase, 'text' | 'context' | 'sourceTitle' | 'sourceUrl' | 'mode' | 'coreText' | 'detailsText' | 'exampleKind'>;

export const PHRASE_STORAGE_KEY = 'savedPhrases';
export const MAX_SAVED_PHRASES = 500;
export const MAX_SAVED_PHRASE_BYTES = 6 * 1024 * 1024;
export const MAX_PHRASE_ANSWER = 40_000;

const inputKeys = ['text', 'context', 'sourceTitle', 'sourceUrl', 'mode', 'coreText', 'detailsText', 'exampleKind'];
const savedKeys = new Set([...inputKeys, 'id', 'createdAt', 'updatedAt']);
let storageQueue: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(operation);
  // A failed operation is reported to its caller without blocking later requests.
  storageQueue = result.then(() => {}, () => {});
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('收藏数据格式无效。');
  return value as Record<string, unknown>;
}
function field(value: unknown, name: string, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) throw new Error(`收藏的${name}格式无效，最多支持 ${maximum.toLocaleString('en-US')} 个字符。`);
  return value;
}
function validateInput(value: unknown): PhraseInput {
  const data = object(value);
  const text = field(data.text, '选中文字', MAX_CONTEXT_SELECTION, true);
  const context = field(data.context, '所在段落', MAX_CONTEXT_PARAGRAPHS);
  const sourceTitle = field(data.sourceTitle, '来源标题', MAX_CONTEXT_TITLE);
  const source = field(data.sourceUrl, '来源地址', MAX_CONTEXT_URL, true);
  if (/[\u0000-\u0020\u007f]/u.test(source)) throw new Error('收藏的来源地址格式无效。');
  const sourceUrl = allowedUrl(source).href;
  if (sourceUrl.length > MAX_CONTEXT_URL) throw new Error('收藏的来源地址过长。');
  if (data.mode !== 'translate' && data.mode !== 'explain') throw new Error('收藏的操作类型无效。');
  const coreText = field(data.coreText, '回答', MAX_PHRASE_ANSWER, true);
  const detailsText = field(data.detailsText, '示例', MAX_PHRASE_ANSWER);
  if (data.exampleKind !== undefined && data.exampleKind !== 'bilingual' && data.exampleKind !== 'usage') throw new Error('收藏的示例类型无效。');
  if ((data.exampleKind === 'bilingual' && data.mode !== 'translate') || (data.exampleKind === 'usage' && data.mode !== 'explain')) throw new Error('收藏的示例类型与操作不匹配。');
  return { text, context, sourceTitle, sourceUrl, mode: data.mode, coreText, detailsText, ...(data.exampleKind === undefined ? {} : { exampleKind: data.exampleKind }) };
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(value)) throw new Error('收藏标识格式无效。');
  return value;
}
function identity(value: PhraseInput): string {
  return JSON.stringify([normalizeContextSelection(value.text), value.sourceUrl, value.mode]);
}
function limits(entries: SavedPhrase[]): void {
  if (entries.length > MAX_SAVED_PHRASES) throw new Error('收藏已达 500 条上限，请先删除部分收藏后重试。');
  if (new TextEncoder().encode(JSON.stringify({ [PHRASE_STORAGE_KEY]: entries })).byteLength > MAX_SAVED_PHRASE_BYTES) throw new Error('收藏已达 6 MiB 本机存储上限，请先删除部分收藏后重试。');
}
async function snapshot(): Promise<SavedPhrase[]> {
  await secureStorage;
  const stored = (await chrome.storage.local.get<Record<string, unknown>>(PHRASE_STORAGE_KEY))[PHRASE_STORAGE_KEY];
  if (stored === undefined) return [];
  try {
    if (!Array.isArray(stored)) throw new Error('收藏列表格式无效。');
    if (stored.length > MAX_SAVED_PHRASES) throw new Error('收藏条数超出上限。');
    const ids = new Set<string>();
    const identities = new Set<string>();
    const entries = stored.map(value => {
      const data = object(value);
      if (Object.keys(data).some(key => !savedKeys.has(key))) throw new Error('收藏包含无法识别的字段。');
      const payload = validateInput(data);
      const id = identifier(data.id);
      if (!Number.isSafeInteger(data.createdAt) || (data.createdAt as number) <= 0 || !Number.isSafeInteger(data.updatedAt) || (data.updatedAt as number) < (data.createdAt as number)) throw new Error('收藏时间无效。');
      const key = identity(payload);
      if (ids.has(id) || identities.has(key)) throw new Error('收藏包含重复记录。');
      ids.add(id); identities.add(key);
      return { ...payload, id, createdAt: data.createdAt as number, updatedAt: data.updatedAt as number };
    });
    limits(entries);
    return entries;
  } catch (error) {
    throw new Error('本机收藏数据损坏或格式不兼容，未覆盖原数据。请先备份并修复收藏数据。', { cause: error });
  }
}

export async function savePhrase(input: PhraseInput): Promise<{ entry: SavedPhrase; created: boolean }> {
  // Copy and validate before joining the queue so callers cannot mutate pending input.
  const payload = validateInput(input);
  return serialize(async () => {
    const entries = await snapshot();
    const key = identity(payload);
    const previous = entries.find(entry => identity(entry) === key);
    const updatedAt = Math.max(Date.now(), ...entries.map(entry => entry.updatedAt + 1));
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw new Error('收藏更新时间无效，未修改原数据。');
    const id = previous?.id ?? crypto.randomUUID();
    if (!previous && entries.some(entry => entry.id === id)) throw new Error('收藏标识冲突，请重试。');
    const entry: SavedPhrase = {
      ...payload, id, createdAt: previous?.createdAt ?? updatedAt, updatedAt,
      ...(!payload.detailsText.trim() && previous?.detailsText ? {
        detailsText: previous.detailsText,
        ...(previous.exampleKind === undefined ? {} : { exampleKind: previous.exampleKind })
      } : {})
    };
    const next = [entry, ...entries.filter(candidate => candidate.id !== id)];
    limits(next);
    await chrome.storage.local.set({ [PHRASE_STORAGE_KEY]: next });
    return { entry: { ...entry }, created: previous === undefined };
  });
}
export async function listPhrases(): Promise<SavedPhrase[]> {
  return serialize(async () => (await snapshot()).sort((left, right) => right.updatedAt - left.updatedAt));
}
export async function deletePhrase(id: string): Promise<void> {
  const requested = identifier(id);
  return serialize(async () => {
    const entries = await snapshot();
    const next = entries.filter(entry => entry.id !== requested);
    if (next.length !== entries.length) await chrome.storage.local.set({ [PHRASE_STORAGE_KEY]: next });
  });
}
