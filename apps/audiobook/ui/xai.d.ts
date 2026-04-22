/** xAI Workspace SDK type declarations for Audiobook panel. */

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

interface XaiChat {
  send(text: string, buttons?: { text: string; callback_data?: string; url?: string }[][]): void;
}

interface XaiAudioLoadOpts {
  url: string;
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  durationSec?: number;
  bookId?: string;
  chapterIdx?: number;
  startPositionSec?: number;
}

interface XaiAudioState {
  status: 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';
  positionSec: number;
  durationSec: number;
  bookId: string | null;
  chapterIdx: number | null;
  rate: number;
}

interface XaiAudio {
  load(opts: XaiAudioLoadOpts): Promise<{ durationSec: number }>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seekTo(positionSec: number): Promise<void>;
  seekRelative(deltaSec: number): Promise<void>;
  setRate(rate: number): Promise<void>;
  release(): Promise<void>;
  state(): Promise<XaiAudioState>;
}

interface XaiSDK {
  render(html: string): void;
  http<T = any>(url: string, options?: XaiHttpOptions): Promise<XaiHttpResponse<T>>;
  chat: XaiChat;
  audio: XaiAudio;
  on(event: string, handler: (data: any) => void): void;
  log(message: string, data?: any): void;
  openUrl(url: string): Promise<void>;
  permissions: string[];
}

declare const xai: XaiSDK;
