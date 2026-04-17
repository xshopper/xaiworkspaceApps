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

interface XaiSDK {
  render(html: string): void;
  http<T = any>(url: string, options?: XaiHttpOptions): Promise<XaiHttpResponse<T>>;
  storage: XaiStorage;
  chat: XaiChat;
  on(event: string, handler: (data: any) => void): void;
  log(message: string, data?: any): void;
}

declare const xai: XaiSDK;
