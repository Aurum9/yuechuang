export type ChatConnection = 'apiKey' | 'chatgptOAuth';
export interface ChatConnectionConfig { provider: ChatConnection; model: string }
export interface ChatConnectionView { config: ChatConnectionConfig; migration?: 'webModeRemoved' }
