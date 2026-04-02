/** xAI Workspace SDK type declarations for Token Market panel */

interface XaiHttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface XaiHttpResponse<T = any> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

interface XaiStorage {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<true>;
  delete(key: string): Promise<true>;
  list(prefix?: string): Promise<{ key: string; value: any }[]>;
}

interface XaiChat {
  send(text: string, buttons?: { text: string; callback_data?: string; url?: string }[][]): void;
}

interface XaiMemory {
  get(category: string, key: string): Promise<any>;
  set(category: string, key: string, value: any): Promise<void>;
  search(query: string): Promise<any[]>;
}

interface XaiSDK {
  render(html: string): void;
  http<T = any>(url: string, options?: XaiHttpOptions): Promise<XaiHttpResponse<T>>;
  storage: XaiStorage;
  chat: XaiChat;
  memory: XaiMemory;
  on(event: string, handler: (data: any) => void): void;
  log(message: string, data?: any): void;
  openUrl(url: string): Promise<void>;
}

declare const xai: XaiSDK;
