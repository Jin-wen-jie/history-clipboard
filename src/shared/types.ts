export type HistoryType = "text" | "image";

export type HistoryFilterType = "all" | HistoryType;

export type ClipboardBackgroundMode = "starting" | "listening" | "fallback" | "paused" | "stopped";
export type ClipboardBackgroundState = {
  mode: ClipboardBackgroundMode;
  helperPid: number | null;
  helperGeneration: number;
  lastEventAt: number | null;
  lastSequence: number | null;
  restartCount: number;
  nextRestartAt: number | null;
  gapCount: number;
  filteredCount: number;
  queueDepth: number;
  queueBytes: number;
  lastExit: { code: number | null; signal: string | null } | null;
  lastError: string | null;
};

export type TextHistoryItem = {
  id: string;
  type: "text";
  text: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  copyCount: number;
};

export type ImageHistoryItem = {
  id: string;
  type: "image";
  thumbnailDataUrl: string;
  width: number;
  height: number;
  byteSize: number;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  copyCount: number;
};

export type HistoryItem = TextHistoryItem | ImageHistoryItem;

export type HistoryQuery = {
  search?: string;
  type?: HistoryFilterType;
  from?: string;
  to?: string;
};

export const STARTUP_DECISION_VERSION = 1;

export type StartupState = {
  desiredEnabled: boolean;
  actualEnabled: boolean | null;
  pendingDecision: boolean;
  managed: boolean;
  error: "query-failed" | "apply-failed" | "state-mismatch" | null;
};

export type AppSettings = {
  captureEnabled: boolean;
  maxItems: number;
  retentionDays: number;
  maxTextLength: number;
  maxImageBytes: number;
  hotkey: string;
  launchAtStartup: boolean;
  startupDecisionVersion: number;
  sensitiveFilterEnabled: boolean;
};

export type StorageStats = {
  totalItems: number;
  textItems: number;
  imageItems: number;
  imageBytes: number;
};

export type HistoryResult =
  | { ok: true; item: HistoryItem }
  | { ok: false; reason: "blank" | "too-large" | "sensitive" | "missing" };

export type ClipboardContent =
  | { type: "text"; text: string }
  | { type: "image"; png: Uint8Array };

export type ClipboardHistoryApi = {
  list(query?: HistoryQuery): Promise<HistoryItem[]>;
  copy(id: string): Promise<{ ok: boolean }>;
  delete(id: string): Promise<{ ok: boolean }>;
  deleteMany(ids: string[]): Promise<{ ok: boolean; count: number }>;
  clear(type?: HistoryFilterType): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<{ ok: boolean }>;
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  getStats(): Promise<StorageStats>;
  showWindow(): Promise<void>;
  exportHistory(): Promise<{ ok: boolean; reason?: string }>;
  importHistory(): Promise<{ ok: boolean; reason?: string; imported?: number; skipped?: number }>;
};

export const DEFAULT_SETTINGS: AppSettings = {
  captureEnabled: true,
  maxItems: 500,
  retentionDays: 30,
  maxTextLength: 20_000,
  maxImageBytes: 10 * 1024 * 1024,
  hotkey: "Ctrl+Alt+V",
  launchAtStartup: true,
  startupDecisionVersion: STARTUP_DECISION_VERSION,
  sensitiveFilterEnabled: false
};
