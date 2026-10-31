import type { ChatConnection } from './chat-connection-shared';
import type { SiwcStatus } from './siwc-shared';

export const CHAT_PORT = 'chat';
export const CHAT_SESSION_KEY = 'chatSession';
export const MAX_CHAT_MESSAGES = 40;
export const MAX_CHAT_INPUT = 6000;
export const MAX_CHAT_OUTPUT = 40_000;

export interface ChatCitation { start: number; end: number; url: string; title: string }
export interface ChatSearch { state: 'searching' | 'reading' | 'complete' | 'failed'; calls: number }
export interface ChatResponseDetails {
  model?: string;
  durationMs?: number;
  firstTokenMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
}
/** Metadata callbacks carry patches; consumers merge details and usage fields. */
export interface SearchUpdate { search?: ChatSearch; citations?: ChatCitation[]; details?: ChatResponseDetails }

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'done' | 'running' | 'cancelled' | 'error';
  search?: ChatSearch;
  citations?: ChatCitation[];
  details?: ChatResponseDetails;
}
export interface ChatState {
  type: 'chat:state';
  messages: ChatMessage[];
  status: 'idle' | 'running' | 'error' | 'cancelled' | 'interrupted';
  requestId?: string;
  error?: string;
  hasKey: boolean;
  settingsReady: boolean;
  connection?: ChatConnection;
  connectionLabel?: string;
  accountLabel?: string;
  siwcStatus?: SiwcStatus;
}
export type ChatCommand =
  | { type: 'chat:status' }
  | { type: 'chat:send'; text: string }
  | { type: 'chat:stop'; requestId: string }
  | { type: 'chat:clear'; requestId?: string };

