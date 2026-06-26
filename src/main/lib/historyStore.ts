import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashBytes } from "../../shared/hash";
import { DEFAULT_SETTINGS, type AppSettings, type ClipboardContent, type HistoryFilterType, type HistoryItem, type HistoryQuery, type HistoryResult, type HistoryType, type StorageStats } from "../../shared/types";
import type { ContentKeyProvider } from "./secureVault";
import { FileContentVault } from "./secureVault";
import { shouldRecordText } from "./textFilter";

type StoredBase = {
  id: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  copyCount: number;
};

type StoredTextItem = StoredBase & {
  type: "text";
  contentKey: string;
};

type StoredImageItem = StoredBase & {
  type: "image";
  contentKey: string;
  thumbnailKey: string;
  width: number;
  height: number;
  byteSize: number;
};

type StoredItem = StoredTextItem | StoredImageItem;

type MetadataFile = {
  version: 1;
  items: StoredItem[];
};

type HistoryStoreOptions = {
  now?: () => Date;
};

export type ImageInput = {
  png: Buffer;
  thumbnailPng: Buffer;
  width: number;
  height: number;
};

export class HistoryStore {
  private readonly metadataPath: string;
  private readonly settingsPath: string;
  private readonly contentDir: string;
  private readonly vault: FileContentVault;
  private items: StoredItem[] = [];
  private settings: AppSettings;
  /** Cache of fully-decrypted HistoryItem keyed by id */
  private itemCache = new Map<string, HistoryItem>();
  /** True when the cache is dirty relative to this.items — full rebuild needed */
  private cacheDirty = false;
  /** Ids that have been invalidated since last cache rebuild */
  private invalidatedIds = new Set<string>();

  constructor(
    private readonly rootDir: string,
    keyProvider: ContentKeyProvider,
    initialSettings: AppSettings = DEFAULT_SETTINGS,
    private readonly options: HistoryStoreOptions = {}
  ) {
    this.metadataPath = join(rootDir, "history.json");
    this.settingsPath = join(rootDir, "settings.json");
    this.contentDir = join(rootDir, "content");
    this.vault = new FileContentVault(this.contentDir, keyProvider);
    this.settings = { ...DEFAULT_SETTINGS, ...initialSettings };
  }

  async init(): Promise<void> {
    await mkdir(this.contentDir, { recursive: true });
    await this.loadSettings();
    await this.loadMetadata();
  }

  async list(query: HistoryQuery = {}): Promise<HistoryItem[]> {
    // Always check retention even if cached — it may remove items
    const retentionChanged = await this.enforceRetention();

    const type = query.type ?? "all";
    const search = query.search?.trim().toLocaleLowerCase();
    const from = parseTime(query.from);
    const to = parseTime(query.to);

    // Rebuild cache from scratch if it's fully dirty
    if (this.cacheDirty) {
      await this.rebuildCache();
    } else if (this.invalidatedIds.size > 0) {
      // Partial update: re-decrypt only invalidated items
      await this.partialRebuildCache();
    }

    const visibleItems: HistoryItem[] = [];
    const unreadableIds: string[] = [];

    for (const item of this.sortedItems()) {
      if (type !== "all" && item.type !== type) continue;

      const publicItem = this.itemCache.get(item.id);
      if (!publicItem) {
        // Item was in StoredItem array but couldn't be decrypted — collect for cleanup
        unreadableIds.push(item.id);
        continue;
      }

      const updatedAt = Date.parse(publicItem.updatedAt);
      if (from !== undefined && updatedAt < from) continue;
      if (to !== undefined && updatedAt > to) continue;
      if (search && publicItem.type === "text" && !publicItem.text.toLocaleLowerCase().includes(search)) continue;
      if (search && publicItem.type === "image") continue;

      visibleItems.push(publicItem);
    }

    // Clean up any items that failed to decrypt
    if (unreadableIds.length > 0) {
      this.items = this.items.filter((item) => !unreadableIds.includes(item.id));
      for (const id of unreadableIds) {
        this.itemCache.delete(id);
      }
      await this.saveMetadata();
    }

    if (retentionChanged) {
      await this.saveMetadata();
    }

    return visibleItems;
  }

  async addText(text: string): Promise<HistoryResult> {
    const decision = shouldRecordText(text, this.settings);
    if (!decision.ok) {
      return decision;
    }

    return this.addOrUpdateText(text);
  }

  async addImage(input: ImageInput): Promise<HistoryResult> {
    if (input.png.length === 0) {
      return { ok: false, reason: "blank" };
    }

    if (input.png.length > this.settings.maxImageBytes) {
      return { ok: false, reason: "too-large" };
    }

    const hash = hashBytes("image", input.png);
    return this.upsertItem(hash, "image",
      (id) => ({
        id, type: "image" as const, hash,
        contentKey: `${id}.image`,
        thumbnailKey: `${id}.thumb`,
        width: input.width,
        height: input.height,
        byteSize: input.png.length,
        createdAt: this.now(),
        updatedAt: this.now(),
        pinned: false,
        copyCount: 1
      }),
      async (item) => {
        await this.vault.write(item.contentKey, input.png);
        await this.vault.write(item.thumbnailKey, input.thumbnailPng);
      }
    );
  }

  async setPinned(id: string, pinned: boolean): Promise<boolean> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) {
      return false;
    }

    item.pinned = pinned;
    item.updatedAt = this.now();
    // Update cache if the item is already cached
    const cached = this.itemCache.get(id);
    if (cached) {
      cached.pinned = pinned;
      cached.updatedAt = item.updatedAt;
    }
    await this.saveMetadata();
    return true;
  }

  async delete(id: string): Promise<boolean> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) {
      return false;
    }

    this.items = this.items.filter((candidate) => candidate.id !== id);
    this.itemCache.delete(id);
    this.invalidatedIds.delete(id);
    await this.deleteContent(item);
    await this.saveMetadata();
    return true;
  }

  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const idSet = new Set(ids);
    const toRemove = this.items.filter((item) => idSet.has(item.id));
    if (toRemove.length === 0) return 0;

    this.items = this.items.filter((item) => !idSet.has(item.id));
    // Remove from cache
    for (const id of ids) {
      this.itemCache.delete(id);
      this.invalidatedIds.delete(id);
    }

    // Delete content files in parallel
    await Promise.all(toRemove.map((item) => this.deleteContent(item)));
    await this.saveMetadata();
    return toRemove.length;
  }

  async clear(type: HistoryFilterType = "all"): Promise<void> {
    const removed = this.items.filter((item) => type === "all" || item.type === type);
    const removedIds = new Set(removed.map((item) => item.id));
    this.items = this.items.filter((item) => type !== "all" && item.type !== type);
    // Clear cache for removed items
    for (const id of removedIds) {
      this.itemCache.delete(id);
      this.invalidatedIds.delete(id);
    }
    await Promise.all(removed.map((item) => this.deleteContent(item)));
    await this.saveMetadata();
  }

  async getContent(id: string): Promise<ClipboardContent | undefined> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) {
      return undefined;
    }

    if (item.type === "text") {
      return { type: "text", text: (await this.vault.read(item.contentKey)).toString("utf8") };
    }

    return { type: "image", png: await this.vault.read(item.contentKey) };
  }

  async getSettings(): Promise<AppSettings> {
    return { ...this.settings };
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch };
    await this.saveSettings();
    await this.enforceRetention();
    await this.saveMetadata();
    return this.getSettings();
  }

  getStats(): StorageStats {
    const imageItems = this.items.filter((item): item is StoredImageItem => item.type === "image");
    return {
      totalItems: this.items.length,
      textItems: this.items.filter((item) => item.type === "text").length,
      imageItems: imageItems.length,
      imageBytes: imageItems.reduce((total, item) => total + item.byteSize, 0)
    };
  }

  // ── Export / Import ──

  async exportAsJson(): Promise<string> {
    if (this.cacheDirty) {
      await this.rebuildCache();
    } else if (this.invalidatedIds.size > 0) {
      await this.partialRebuildCache();
    }
    const items = this.sortedItems()
      .map((stored) => this.itemCache.get(stored.id))
      .filter((item): item is HistoryItem => !!item);
    return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items });
  }

  async importFromJson(json: string): Promise<{ imported: number; skipped: number }> {
    const data = JSON.parse(json) as { version?: number; items: HistoryItem[] };
    if (!Array.isArray(data.items)) throw new Error("Invalid backup format");

    let imported = 0;
    let skipped = 0;

    for (const item of data.items) {
      if (item.type === "text") {
        const hash = hashText(item.text);
        const exists = this.items.find((s) => s.type === "text" && s.hash === hash);
        if (exists) {
          skipped++;
          continue;
        }
        const result = await this.addText(item.text);
        if (result.ok) imported++;
        else skipped++;
      } else if (item.type === "image") {
        skipped++;
      }
    }

    return { imported, skipped };
  }

  // ── Private: Add / Upsert ──

  private async addOrUpdateText(text: string): Promise<HistoryResult> {
    const hash = hashText(text);
    return this.upsertItem(hash, "text",
      (id) => ({
        id, type: "text" as const, hash,
        contentKey: `${id}.text`,
        createdAt: this.now(),
        updatedAt: this.now(),
        pinned: false,
        copyCount: 1
      }),
      async (item) => {
        await this.vault.write(item.contentKey, Buffer.from(text, "utf8"));
      }
    );
  }

  private async upsertItem<T extends StoredItem>(
    hash: string,
    type: HistoryType,
    createItem: (id: string) => T,
    writeContent: (item: T) => Promise<void>
  ): Promise<HistoryResult> {
    const existing = this.items.find((item) => item.type === type && item.hash === hash);
    if (existing) {
      existing.updatedAt = this.now();
      existing.copyCount += 1;
      // Update cache in-place instead of re-decrypting from disk
      const cached = this.itemCache.get(existing.id);
      if (cached) {
        cached.updatedAt = existing.updatedAt;
        cached.copyCount = existing.copyCount;
        await this.saveMetadata();
        return { ok: true, item: cached };
      }
      // Not in cache — decrypt once for cache and return value
      const pub = await this.toPublicItem(existing);
      this.itemCache.set(existing.id, pub);
      await this.saveMetadata();
      return { ok: true, item: pub };
    }

    const id = randomUUID();
    const item = createItem(id);
    await writeContent(item);
    this.items.push(item);
    // Decrypt once; cache it and return the same object
    const pub = await this.toPublicItem(item);
    this.itemCache.set(id, pub);
    await this.enforceRetention();
    await this.saveMetadata();
    return { ok: true, item: pub };
  }

  // ── Private: Cache ──

  /** Fully rebuild the decrypt cache from all StoredItem */
  private async rebuildCache(): Promise<void> {
    const map = new Map<string, HistoryItem>();
    for (const stored of this.items) {
      try {
        const pub = await this.toPublicItem(stored);
        map.set(stored.id, pub);
      } catch {
        // Skip unreadable items
      }
    }
    this.itemCache = map;
    this.cacheDirty = false;
    this.invalidatedIds.clear();
  }

  /** Re-decrypt only items whose ids are in invalidatedIds */
  private async partialRebuildCache(): Promise<void> {
    for (const id of this.invalidatedIds) {
      const stored = this.items.find((item) => item.id === id);
      if (stored) {
        try {
          const pub = await this.toPublicItem(stored);
          this.itemCache.set(id, pub);
        } catch {
          this.itemCache.delete(id);
        }
      } else {
        // Item was removed
        this.itemCache.delete(id);
      }
    }
    this.invalidatedIds.clear();
  }

  /** Mark an id as needing cache refresh. Call after content changes. */
  private invalidateCache(id: string): void {
    this.invalidatedIds.add(id);
  }

  // ── Private: Conversions ──

  private async toPublicItem(item: StoredItem): Promise<HistoryItem> {
    if (item.type === "text") {
      return {
        id: item.id,
        type: "text",
        text: (await this.vault.read(item.contentKey)).toString("utf8"),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        pinned: item.pinned,
        copyCount: item.copyCount
      };
    }

    const thumbnail = await this.vault.read(item.thumbnailKey);
    return {
      id: item.id,
      type: "image",
      thumbnailDataUrl: `data:image/png;base64,${thumbnail.toString("base64")}`,
      width: item.width,
      height: item.height,
      byteSize: item.byteSize,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      pinned: item.pinned,
      copyCount: item.copyCount
    };
  }

  private async tryToPublicItem(item: StoredItem): Promise<HistoryItem | undefined> {
    try {
      return await this.toPublicItem(item);
    } catch {
      return undefined;
    }
  }

  // ── Private: Sorting ──

  private sortedItems(): StoredItem[] {
    return [...this.items].sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  // ── Private: Retention ──

  private async enforceRetention(): Promise<boolean> {
    const expiredRemoved = await this.removeExpiredItems();
    const trimmedRemoved = await this.trimToMaxItems();
    return expiredRemoved || trimmedRemoved;
  }

  private async removeExpiredItems(): Promise<boolean> {
    const cutoff = this.currentRetentionCutoff();
    const removed = this.items.filter((item) => Date.parse(item.updatedAt) < cutoff);
    if (removed.length === 0) {
      return false;
    }

    const removedIds = new Set(removed.map((item) => item.id));
    await this.removeItemsById(removedIds, removed);
    return true;
  }

  private async trimToMaxItems(): Promise<boolean> {
    const newest = [...this.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const removed = newest.slice(this.settings.maxItems);
    if (removed.length === 0) {
      return false;
    }

    const removedIds = new Set(removed.map((item) => item.id));
    await this.removeItemsById(removedIds, removed);
    return true;
  }

  private async removeItems(items: StoredItem[]): Promise<void> {
    await this.removeItemsById(new Set(items.map((item) => item.id)), items);
  }

  private async removeItemsById(removedIds: Set<string>, removed: StoredItem[]): Promise<void> {
    this.items = this.items.filter((item) => !removedIds.has(item.id));
    for (const id of removedIds) {
      this.itemCache.delete(id);
      this.invalidatedIds.delete(id);
    }
    await Promise.all(removed.map((item) => this.deleteContent(item)));
  }

  private async deleteContent(item: StoredItem): Promise<void> {
    await this.vault.delete(item.contentKey);
    if (item.type === "image") {
      await this.vault.delete(item.thumbnailKey);
    }
  }

  // ── Private: Persistence ──

  /** Debounced save timer handle */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Number of pending saves — used to ensure the final save always happens */
  private pendingSaves = 0;

  /**
   * Persist metadata to disk.
   * Backs up the old file first for crash recovery, then writes new data.
   * Uses a debounce to coalesce rapid writes, but always guarantees the last
   * write completes (the timer resets on each call, and the final tick fires
   * even when no more calls come).
   *
   * The .bak copy is only done when we actually flush (not on every enqueue),
   * keeping the common case fast.
   */
  private async saveMetadata(): Promise<void> {
    this.pendingSaves++;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    return new Promise<void>((resolve) => {
      this.saveTimer = setTimeout(async () => {
        this.saveTimer = null;

        // Drain all pending saves in one go
        const count = this.pendingSaves;
        this.pendingSaves = 0;

        await mkdir(this.rootDir, { recursive: true });

        // One backup per drain cycle (not per mutation)
        try {
          await copyFile(this.metadataPath, this.metadataPath + ".bak");
        } catch {
          // No existing file to back up — OK
        }

        const json = JSON.stringify({ version: 1, items: this.items } satisfies MetadataFile);
        await writeFile(this.metadataPath, json, "utf8");

        // If more saves were requested while we were writing, schedule another flush
        if (this.pendingSaves > 0) {
          this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.pendingSaves = 0;
            this.saveMetadata().catch(() => {});
          }, 200);
        }

        resolve();
      }, 200);
    });
  }

  private async loadMetadata(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.metadataPath, "utf8")) as MetadataFile;
      this.items = Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      // Main file corrupted — try backup
      try {
        const parsed = JSON.parse(await readFile(this.metadataPath + ".bak", "utf8")) as MetadataFile;
        this.items = Array.isArray(parsed.items) ? parsed.items : [];
        if (this.items.length > 0) {
          console.warn("Metadata corrupted, recovered from backup");
        }
      } catch {
        this.items = [];
      }
    }
    // Cache is stale after loading from disk; rebuild on next list()
    this.cacheDirty = true;
  }

  private async loadSettings(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, "utf8")) as Partial<AppSettings>;
      this.settings = { ...this.settings, ...parsed };
    } catch {
      await this.saveSettings();
    }
  }

  private async saveSettings(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    try {
      await copyFile(this.settingsPath, this.settingsPath + ".bak");
    } catch {
      // No existing file to back up — OK
    }
    await writeFile(this.settingsPath, JSON.stringify(this.settings), "utf8");
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private currentRetentionCutoff(): number {
    const current = this.options.now?.() ?? new Date();
    return current.getTime() - this.settings.retentionDays * 24 * 60 * 60 * 1000;
  }
}

function hashText(text: string): string {
  return hashBytes("text", Buffer.from(text, "utf8"));
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
