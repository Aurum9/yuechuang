export const CHAT_CONNECTION_CONFIG_KEY = 'webChatConfig';
export type ChatConnection = 'apiKey' | 'chatgptOAuth';
export interface ChatConnectionConfig { provider: ChatConnection; model: string }
export interface ChatConnectionView { config: ChatConnectionConfig; migration?: 'webModeRemoved' }
