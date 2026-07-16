export type HistoryType = "text" | "image" | "file";

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

export type FileHistoryItem = {
  id: string;
  type: "file";
  path: string;
  name: string;
  extension: string;
  byteSize: number;
  missing: boolean;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  copyCount: number;
};

export type HistoryItem = TextHistoryItem | ImageHistoryItem | FileHistoryItem;

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
  textLimitMigrationVersion?: number;
  maxImageBytes: number;
  hotkey: string;
  launchAtStartup: boolean;
  startupDecisionVersion: number;
  sensitiveFilterEnabled: boolean;
};

export type EditableSettingsPatch = Partial<
  Omit<AppSettings, "launchAtStartup" | "startupDecisionVersion" | "textLimitMigrationVersion">
>;

export type StorageStats = {
  totalItems: number;
  textItems: number;
  imageItems: number;
  fileItems: number;
  imageBytes: number;
};

export type HistoryResult =
  | { ok: true; item: HistoryItem }
  | { ok: false; reason: "blank" | "too-large" | "sensitive" | "missing" };

export type ClipboardContent =
  | { type: "text"; text: string }
  | { type: "image"; png: Uint8Array }
  | { type: "file"; path: string };

export type HistoryPreviewResult =
  | { ok: true; type: "image"; png: Uint8Array }
  | { ok: true; type: "file-text"; text: string; formatted: boolean }
  | { ok: false; reason: "missing" | "unsupported" | "too-large" };

export type ClipboardHistoryApi = {
  list(query?: HistoryQuery): Promise<HistoryItem[]>;
  copy(id: string): Promise<{ ok: boolean; reason?: "missing" }>;
  copyImagePath(id: string): Promise<{ ok: boolean; path?: string; reason?: "missing" | "not-image" | "write-failed" }>;
  preview(id: string): Promise<HistoryPreviewResult>;
  delete(id: string): Promise<{ ok: boolean }>;
  deleteMany(ids: string[]): Promise<{ ok: boolean; count: number }>;
  clear(type?: HistoryFilterType): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<{ ok: boolean }>;
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: EditableSettingsPatch): Promise<AppSettings>;
  getStats(): Promise<StorageStats>;
  getStartupState(): Promise<StartupState>;
  setStartupEnabled(enabled: boolean): Promise<StartupState>;
  getBackgroundState(): Promise<ClipboardBackgroundState>;
  showWindow(): Promise<void>;
  exportHistory(): Promise<{ ok: boolean; reason?: string }>;
  importHistory(): Promise<{ ok: boolean; reason?: string; imported?: number; skipped?: number }>;
};

export const DEFAULT_MAX_TEXT_LENGTH = 1_000_000;
export const MAX_TEXT_LENGTH = 5_000_000;

export const DEFAULT_SETTINGS: AppSettings = {
  captureEnabled: true,
  maxItems: 500,
  retentionDays: 30,
  maxTextLength: DEFAULT_MAX_TEXT_LENGTH,
  textLimitMigrationVersion: 1,
  maxImageBytes: 10 * 1024 * 1024,
  hotkey: "Ctrl+Alt+V",
  launchAtStartup: true,
  startupDecisionVersion: STARTUP_DECISION_VERSION,
  sensitiveFilterEnabled: false
};
