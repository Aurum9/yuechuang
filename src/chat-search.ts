import { MAX_CHAT_OUTPUT, type ChatCitation, type ChatSearch } from './chat-shared';

export const MAX_CHAT_CITATIONS = 100;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Source links are data, never executable markup or automatic fetch targets. */
export function sanitizeChatCitations(value: unknown, textLength: number): ChatCitation[] {
  if (!Array.isArray(value) || !Number.isSafeInteger(textLength) || textLength < 0 || textLength > MAX_CHAT_OUTPUT) return [];
  const result: ChatCitation[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 1000)) {
    if (!object(item) || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)) continue;
    const start = item.start as number, end = item.end as number;
    if (start < 0 || end <= start || end > textLength || typeof item.url !== 'string' || item.url.length > 2048 || /[\u0000-\u0020\u007f]/.test(item.url)) continue;
    let url: URL;
    try { url = new URL(item.url); } catch { continue; }
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) continue;
    const title = typeof item.title === 'string' ? item.title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 300) : '';
    const key = `${start}:${end}:${url.href}`;
    if (seen.has(key)) continue;
    seen.add(key); result.push({ start, end, url: url.href, title: title || url.hostname });
    if (result.length >= MAX_CHAT_CITATIONS) break;
  }
  return result.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function sanitizeChatSearch(value: unknown): ChatSearch | undefined {
  if (!object(value) || typeof value.state !== 'string' || !['searching', 'reading', 'complete', 'failed'].includes(value.state) || !Number.isSafeInteger(value.calls) || (value.calls as number) < 1 || (value.calls as number) > 1000) return;
  return { state: value.state as ChatSearch['state'], calls: value.calls as number };
}
