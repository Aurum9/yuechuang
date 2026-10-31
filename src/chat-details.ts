import type { ChatResponseDetails } from './chat-shared';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Keep only bounded display metadata. Missing counters never become zero. */
export function sanitizeChatDetails(value: unknown): ChatResponseDetails | undefined {
  if (!object(value)) return;
  const result: ChatResponseDetails = {};
  if (typeof value.model === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value.model)) result.model = value.model;
  if (count(value.durationMs)) result.durationMs = value.durationMs;
  if (count(value.firstTokenMs)) result.firstTokenMs = value.firstTokenMs;
  if (object(value.usage)) {
    const usage: NonNullable<ChatResponseDetails['usage']> = {};
    for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'totalTokens'] as const) {
      if (count(value.usage[field])) usage[field] = value.usage[field];
    }
    // The two breakdowns are subsets, when their parent count is available.
    if (usage.inputTokens !== undefined && usage.cachedInputTokens !== undefined && usage.cachedInputTokens > usage.inputTokens) delete usage.cachedInputTokens;
    if (usage.outputTokens !== undefined && usage.reasoningTokens !== undefined && usage.reasoningTokens > usage.outputTokens) delete usage.reasoningTokens;
    if (Object.keys(usage).length) result.usage = usage;
  }
  return Object.keys(result).length ? result : undefined;
}
