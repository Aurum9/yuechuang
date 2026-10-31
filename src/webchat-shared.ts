export const WEBCHAT_ORIGIN = 'https://chatgpt.com';
export const WEBCHAT_PORT = 'reader-chatgpt-web';
export const WEBCHAT_PAGE_PORT = 'reader-chatgpt-page';
export type ChatConnection = 'apiKey' | 'chatgptWeb' | 'chatgptOAuth';
export type WebChatTransport = 'direct' | 'page' | 'webapp';
export interface WebChatConfig { provider: ChatConnection; model: string; transport?: WebChatTransport }
export interface WebChatModel { id: string; label: string }
export type WebChatStatusCode = 'unchecked' | 'ready' | 'signedOut' | 'missingTab' | 'permissionRequired' | 'verificationRequired' | 'error';
export type WebChatGeneration = 'unchecked' | 'working' | 'blocked';
export interface WebChatFailureInfo {
  stage: 'session' | 'client' | 'models' | 'requirements' | 'conversation';
  httpStatus?: number;
  code: WebChatErrorCode;
}
export interface WebChatStatus {
  transport?: WebChatTransport;
  state: WebChatStatusCode;
  loggedIn: boolean;
  accountLabel?: string;
  models: WebChatModel[];
  error?: string;
  generation?: WebChatGeneration;
  lastFailure?: WebChatFailureInfo;
}
export interface WebChatView { config: WebChatConfig; status: WebChatStatus }
export interface WebChatInput { role: 'system' | 'user' | 'assistant'; content: string }
export interface WebChatConversation { id: string; parentId: string }
export type WebChatPageCommand =
  | { type: 'status'; id: string }
  | { type: 'generate'; id: string; model: string; messages: WebChatInput[]; conversation?: WebChatConversation }
  | { type: 'cancel'; id: string };
export type WebChatErrorCode = 'signedOut' | 'verificationRequired' | 'accessDenied' | 'quota' | 'network' | 'format' | 'interrupted' | 'model' | 'timeout' | 'pageBusy' | 'pageChanged' | 'pageUnsupported';
export type WebChatPageEvent =
  | { type: 'status'; id: string; status: WebChatStatus }
  | { type: 'text'; id: string; text: string }
  | { type: 'heartbeat'; id: string }
  | { type: 'done'; id: string; text: string; conversation: WebChatConversation }
  | { type: 'error'; id: string; code: WebChatErrorCode; stage?: WebChatFailureInfo['stage']; httpStatus?: number };
