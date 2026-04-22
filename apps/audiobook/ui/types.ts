export interface Chapter {
  idx: number;
  title: string;
  startChar: number;
  endChar: number;
  durationSec?: number;
  audioPath?: string;
}

export interface BookShare {
  id: string;
  url: string;
  sharedAt: string;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  sourceType: 'gutenberg' | 'url';
  sourceUrl: string | null;
  chapters: Chapter[];
  chars: number;
  importedAt: string;
  share?: BookShare | null;
}

export interface SearchResult {
  id: string;
  title: string;
  author: string;
  sourceType: 'gutenberg';
  downloads: {
    epub: string | null;
    txt: string | null;
    pdf: string | null;
    html: string | null;
  };
}

export type PlayerStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerState {
  bookId: string | null;
  chapterIdx: number;
  status: PlayerStatus;
  positionSec: number;
  durationSec: number;
}

export interface Voice {
  id: string;
  label: string;
  consent: boolean;
  createdAt: string;
  durationSec: number;
  sampleRate: number;
  engineReady: boolean;
  engine: string | null;
}

export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'stopped' | 'uploading' | 'error';

export interface RecorderState {
  status: RecorderStatus;
  elapsedSec: number;
  preview: string | null;        // object URL for playback
  blob: Blob | null;
  consent: boolean;
  label: string;
  message: string | null;
}

export interface PanelState {
  tab: 'library' | 'discover' | 'book' | 'voice';
  loading: boolean;
  error: string | null;
  shareMessage: string | null;

  library: Book[];
  search: {
    query: string;
    results: SearchResult[];
  };

  activeBook: Book | null;
  audioStatus: {
    chapters: { idx: number; generated: boolean; durationSec: number | null }[];
    jobs: { id: string; chapterIdx: number; status: string; percent: number; error: string | null }[];
  } | null;

  player: PlayerState;

  voice: string;
  speed: number;

  voices: Voice[];
  recorder: RecorderState;
}
