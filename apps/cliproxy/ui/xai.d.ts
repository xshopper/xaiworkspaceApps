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

interface XaiHttpResponse<T = unknown> {
  status: number;
  data: T;
}

interface XaiStorageEntry {
  key: string;
  value: unknown;
}

interface XaiStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<true>;
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
  get(category: string, key: string): Promise<unknown>;
  set(category: string, key: string, value: unknown, opts?: { importance?: number; metadata?: unknown }): Promise<void>;
  search(query: string): Promise<unknown[]>;
  list(category: string): Promise<unknown[]>;
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
  execute(toolSlug: string, operation: string, params?: { params?: unknown; body?: unknown; query?: unknown }): Promise<unknown>;
  list(): Promise<unknown[]>;
}

interface XaiSDK {
  render(html: string): void;
  http<T = unknown>(url: string, options?: XaiHttpOptions): Promise<XaiHttpResponse<T>>;
  storage: XaiStorage;
  chat: XaiChat;
  memory: XaiMemory;
  device: XaiDevice;
  tools: XaiTools;
  on(event: string, handler: (data: unknown) => void): void;
  request<T = unknown>(action: string, data: unknown): Promise<T>;
  requestApproval(action: string, description: string, details?: string): Promise<boolean>;
  log(message: string, data?: unknown): void;
}

declare const xai: XaiSDK;
