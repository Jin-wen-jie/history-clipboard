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
    const retentionChanged = await this.enforceRetention();

    const type = query.type ?? "all";
    const search = query.search?.trim().toLocaleLowerCase();
    const from = parseTime(query.from);
    const to = parseTime(query.to);
    const visibleItems: HistoryItem[] = [];
    const unreadableItems: StoredItem[] = [];

    for (const item of this.sortedItems()) {
      if (type !== "all" && item.type !== type) {
        continue;
      }

      const publicItem = await this.tryToPublicItem(item);
      if (!publicItem) {
        unreadableItems.push(item);
        continue;
      }

      const updatedAt = Date.parse(publicItem.updatedAt);
      if (from !== undefined && updatedAt < from) {
        continue;
      }

      if (to !== undefined && updatedAt > to) {
        continue;
      }

      if (search && publicItem.type === "text" && !publicItem.text.toLocaleLowerCase().includes(search)) {
        continue;
      }

      if (search && publicItem.type === "image") {
        continue;
      }

      visibleItems.push(publicItem);
    }

    const hasUnreadable = unreadableItems.length > 0;
    if (hasUnreadable) {
      await this.removeItems(unreadableItems);
    }

    if (retentionChanged || hasUnreadable) {
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
    await this.saveMetadata();
    return true;
  }

  async delete(id: string): Promise<boolean> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) {
      return false;
    }

    this.items = this.items.filter((candidate) => candidate.id !== id);
    await this.deleteContent(item);
    await this.saveMetadata();
    return true;
  }

  async clear(type: HistoryFilterType = "all"): Promise<void> {
    const removed = this.items.filter((item) => type === "all" || item.type === type);
    this.items = this.items.filter((item) => type !== "all" && item.type !== type);
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
    const items: HistoryItem[] = [];
    for (const stored of this.items) {
      const pub = await this.tryToPublicItem(stored);
      if (pub) items.push(pub);
    }
    return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items });
  }

  async importFromJson(json: string): Promise<{ imported: number; skipped: number }> {
    const data = JSON.parse(json) as { version?: number; items: HistoryItem[] };
    if (!Array.isArray(data.items)) throw new Error("Invalid backup format");

    let imported = 0;
    let skipped = 0;

    for (const item of data.items) {
      // Deduplicate by checking existing content
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
        // Image items can't be easily reconstructed from public data (no raw PNG)
        // Skip image import from JSON backup
        skipped++;
      }
    }

    return { imported, skipped };
  }

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
      await this.saveMetadata();
      return { ok: true, item: await this.toPublicItem(existing) };
    }

    const id = randomUUID();
    const item = createItem(id);
    await writeContent(item);
    this.items.push(item);
    await this.enforceRetention();
    await this.saveMetadata();
    return { ok: true, item: await this.toPublicItem(item) };
  }

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

  private sortedItems(): StoredItem[] {
    return [...this.items].sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }

      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

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
    await Promise.all(removed.map((item) => this.deleteContent(item)));
  }

  private async deleteContent(item: StoredItem): Promise<void> {
    await this.vault.delete(item.contentKey);
    if (item.type === "image") {
      await this.vault.delete(item.thumbnailKey);
    }
  }

  private async saveMetadata(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    // Backup the existing file before overwriting
    try {
      await copyFile(this.metadataPath, this.metadataPath + ".bak");
    } catch {
      // No existing file to back up — OK
    }
    await writeFile(this.metadataPath, JSON.stringify({ version: 1, items: this.items } satisfies MetadataFile), "utf8");
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
