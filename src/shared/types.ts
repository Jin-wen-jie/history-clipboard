export type HistoryType = "text" | "image";

export type HistoryFilterType = "all" | HistoryType;

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

export type AppSettings = {
  captureEnabled: boolean;
  maxItems: number;
  retentionDays: number;
  maxTextLength: number;
  maxImageBytes: number;
  hotkey: string;
  launchAtStartup: boolean;
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
  clear(type?: HistoryFilterType): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<{ ok: boolean }>;
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  getStats(): Promise<StorageStats>;
  showWindow(): Promise<void>;
};

export const DEFAULT_SETTINGS: AppSettings = {
  captureEnabled: true,
  maxItems: 500,
  retentionDays: 30,
  maxTextLength: 20_000,
  maxImageBytes: 10 * 1024 * 1024,
  hotkey: "Ctrl+Alt+V",
  launchAtStartup: false,
  sensitiveFilterEnabled: true
};
