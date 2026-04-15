/**
 * xAI Workspace Platform SDK — Type declarations
 *
 * The platform injects `window.xai` into every sandbox iframe at runtime.
 * This file provides TypeScript definitions for the injected API.
 *
 * Reusable by any mini app with a UI panel.
 */

interface XaiHttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
}

interface XaiHttpResponse<T = any> {
  status: number;
  data: T;
}

interface XaiStorageEntry {
  key: string;
  value: any;
}

interface XaiStorage {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<true>;
  delete(key: string): Promise<true>;
  list(prefix?: string): Promise<XaiStorageEntry[]>;
}

interface XaiChatButton {
  text: string;
  data: string;
}

interface XaiChat {
  send(text: string, buttons?: XaiChatButton[][]): void;
}

interface XaiMemory {
  get(category: string, key: string): Promise<any>;
  set(category: string, key: string, value: any, opts?: { importance?: number; metadata?: any }): Promise<void>;
  search(query: string): Promise<any[]>;
  list(category: string): Promise<any[]>;
  remove(category: string, key: string): Promise<void>;
}

interface XaiDeviceFiles {
  write(path: string, data: string): Promise<void>;
  read(path: string): Promise<string>;
  delete(path: string): Promise<void>;
  list(path: string): Promise<string[]>;
}

interface XaiDevice {
  takePhoto(): Promise<string>;
  pickPhoto(): Promise<string>;
  getLocation(): Promise<{ lat: number; lng: number }>;
  copyToClipboard(text: string): Promise<void>;
  readClipboard(): Promise<string>;
  share(options: { title?: string; text?: string; url?: string }): Promise<void>;
  getInfo(): Promise<{ model: string; os: string; battery: number }>;
  getNetwork(): Promise<{ connected: boolean; type: string }>;
  files: XaiDeviceFiles;
}

interface XaiTools {
  execute(toolSlug: string, operation: string, params?: { params?: any; body?: any; query?: any }): Promise<any>;
  list(): Promise<any[]>;
}

interface XaiCliproxyOAuth {
  startOAuth(provider: string): Promise<{ authorize_url: string; state: string; started_at: string }>;
  pollOAuth(state: string, started_at: string, provider: string): Promise<{ status: string; message?: string }>;
}

interface XaiSDK {
  render(html: string): void;
  http<T = any>(url: string, options?: XaiHttpOptions): Promise<XaiHttpResponse<T>>;
  openUrl(url: string): Promise<void>;
  cliproxy: XaiCliproxyOAuth;
  storage: XaiStorage;
  chat: XaiChat;
  memory: XaiMemory;
  device: XaiDevice;
  tools: XaiTools;
  on(event: string, handler: (data: any) => void): void;
  request(action: string, data: any): Promise<any>;
  requestApproval(action: string, description: string, details?: string): Promise<'approved' | 'denied' | 'timeout'>;
  log(message: string, data?: any): void;
}

declare const xai: XaiSDK;
