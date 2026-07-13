import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hashBytes } from "../../shared/hash";
import { DEFAULT_SETTINGS, type AppSettings, type ClipboardContent, type HistoryFilterType, type HistoryItem, type HistoryQuery, type HistoryResult, type HistoryType, type StorageStats } from "../../shared/types";
import { HistoryMetadataJournal, type StoredImageItem, type StoredItem } from "./historyMetadata";
import type { ContentKeyProvider } from "./secureVault";
import { FileContentVault } from "./secureVault";
import { migrateSettings, type InstallationEvidence } from "./settingsMigration";
import { shouldRecordText } from "./textFilter";

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
  private readonly settingsPath: string;
  private readonly contentDir: string;
  private readonly vault: FileContentVault;
  private readonly metadata: HistoryMetadataJournal;
  private revision = 0;
  private metadataRecoverable = true;
  private items: StoredItem[] = [];
  private settings: AppSettings;
  private mutationTail: Promise<void> = Promise.resolve();
  private latestMutation: Promise<unknown> = Promise.resolve();
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
    this.settingsPath = join(rootDir, "settings.json");
    this.contentDir = join(rootDir, "content");
    this.vault = new FileContentVault(this.contentDir, keyProvider);
    this.metadata = new HistoryMetadataJournal(rootDir);
    this.settings = { ...DEFAULT_SETTINGS, ...initialSettings };
  }

  async init(): Promise<void> {
    return this.enqueueMutation(() => this.initInternal());
  }

  private async initInternal(): Promise<void> {
    const evidence = await this.detectInstallationEvidence();
    await mkdir(this.contentDir, { recursive: true });
    await this.loadSettings(evidence);
    const loaded = await this.metadata.load();
    this.items = loaded.items;
    this.revision = loaded.revision;
    this.metadataRecoverable = loaded.validCandidate || (!loaded.hadCandidates && !evidence.contentExists);
    this.cacheDirty = true;
    if (this.metadataRecoverable) {
      try {
        await this.vault.cleanupOrphans(this.referencedContentKeys());
      } catch {
        console.error("Encrypted content cleanup failed: orphan-cleanup");
      }
    } else {
      console.error("Encrypted content cleanup skipped: metadata-unrecoverable");
    }
  }

  async flush(): Promise<void> {
    const latestMutation = this.latestMutation;
    await latestMutation;
    await this.metadata.flush();
  }

  async list(query: HistoryQuery = {}): Promise<HistoryItem[]> {
    return this.enqueueMutation(() => this.listInternal(query));
  }

  private async listInternal(query: HistoryQuery): Promise<HistoryItem[]> {
    // Always check retention even if cached — it may remove items
    await this.enforceRetention();

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
      const unreadableIdSet = new Set(unreadableIds);
      const unreadableItems = this.items.filter((item) => unreadableIdSet.has(item.id));
      await this.commitRemoval(unreadableItems);
    }

    return visibleItems;
  }

  async addText(text: string): Promise<HistoryResult> {
    return this.enqueueMutation(() => this.addTextInternal(text));
  }

  private async addTextInternal(text: string): Promise<HistoryResult> {
    const decision = shouldRecordText(text, this.settings);
    if (!decision.ok) {
      return decision;
    }

    return this.addOrUpdateText(text);
  }

  async addImage(input: ImageInput): Promise<HistoryResult> {
    return this.enqueueMutation(() => this.addImageInternal(input));
  }

  private async addImageInternal(input: ImageInput): Promise<HistoryResult> {
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
    return this.enqueueMutation(() => this.setPinnedInternal(id, pinned));
  }

  private async setPinnedInternal(id: string, pinned: boolean): Promise<boolean> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) {
      return false;
    }

    const updatedItem = { ...item, pinned, updatedAt: this.now() };
    const nextItems = this.items.map((candidate) => candidate.id === id ? updatedItem : candidate);
    await this.saveMetadata(nextItems);
    this.items = nextItems;
    const cached = this.itemCache.get(id);
    if (cached) {
      this.itemCache.set(id, {
        ...cached,
        pinned,
        updatedAt: updatedItem.updatedAt
      });
    }
    return true;
  }

  async delete(id: string): Promise<boolean> {
    return this.enqueueMutation(() => this.deleteInternal(id));
  }

  private async deleteInternal(id: string): Promise<boolean> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) {
      return false;
    }

    await this.commitRemoval([item]);
    return true;
  }

  async deleteMany(ids: string[]): Promise<number> {
    return this.enqueueMutation(() => this.deleteManyInternal(ids));
  }

  private async deleteManyInternal(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const idSet = new Set(ids);
    const toRemove = this.items.filter((item) => idSet.has(item.id));
    if (toRemove.length === 0) return 0;

    await this.commitRemoval(toRemove);
    return toRemove.length;
  }

  async clear(type: HistoryFilterType = "all"): Promise<void> {
    return this.enqueueMutation(() => this.clearInternal(type));
  }

  private async clearInternal(type: HistoryFilterType): Promise<void> {
    const removed = this.items.filter((item) => type === "all" || item.type === type);
    await this.commitRemoval(removed);
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
    return this.enqueueMutation(() => this.updateSettingsInternal(patch));
  }

  private async updateSettingsInternal(patch: Partial<AppSettings>): Promise<AppSettings> {
    const nextSettings = { ...this.settings, ...patch };
    await this.saveSettings(nextSettings);
    this.settings = nextSettings;
    const retentionChanged = await this.enforceRetention();
    if (!retentionChanged) {
      await this.saveMetadata(this.items);
    }
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
    return this.enqueueMutation(() => this.importFromJsonInternal(json));
  }

  private async importFromJsonInternal(json: string): Promise<{ imported: number; skipped: number }> {
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
        const result = await this.addTextInternal(item.text);
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
      const updatedItem = {
        ...existing,
        updatedAt: this.now(),
        copyCount: existing.copyCount + 1
      } as StoredItem;
      const cached = this.itemCache.get(existing.id);
      let publicItem: HistoryItem;
      if (cached) {
        publicItem = {
          ...cached,
          updatedAt: updatedItem.updatedAt,
          copyCount: updatedItem.copyCount
        };
      } else {
        publicItem = await this.toPublicItem(updatedItem);
      }
      const nextItems = this.items.map((item) => item.id === existing.id ? updatedItem : item);
      await this.saveMetadata(nextItems);
      this.items = nextItems;
      this.itemCache.set(existing.id, publicItem);
      return { ok: true, item: publicItem };
    }

    const id = randomUUID();
    const item = createItem(id);
    await writeContent(item);
    const pub = await this.toPublicItem(item);
    const candidateItems = [...this.items, item];
    const removed = this.retentionItemsToRemove(candidateItems);
    const removedIds = new Set(removed.map((removedItem) => removedItem.id));
    const nextItems = candidateItems.filter((candidate) => !removedIds.has(candidate.id));
    await this.saveMetadata(nextItems);
    this.items = nextItems;
    this.itemCache.set(id, pub);
    for (const removedId of removedIds) {
      this.itemCache.delete(removedId);
      this.invalidatedIds.delete(removedId);
    }
    await this.cleanupRemovedContent(removed);
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
    const removed = this.retentionItemsToRemove(this.items);
    if (removed.length === 0) {
      return false;
    }

    await this.commitRemoval(removed);
    return true;
  }

  private retentionItemsToRemove(items: readonly StoredItem[]): StoredItem[] {
    const cutoff = this.currentRetentionCutoff(this.settings.retentionDays);
    const expired = items.filter((item) => Date.parse(item.updatedAt) < cutoff);
    const expiredIds = new Set(expired.map((item) => item.id));
    const retained = items.filter((item) => !expiredIds.has(item.id));
    const newest = [...retained].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [...expired, ...newest.slice(this.settings.maxItems)];
  }

  private async commitRemoval(removed: StoredItem[]): Promise<void> {
    if (removed.length === 0) {
      return;
    }

    const removedIds = new Set(removed.map((item) => item.id));
    const nextItems = this.items.filter((item) => !removedIds.has(item.id));
    await this.saveMetadata(nextItems);
    this.items = nextItems;
    for (const id of removedIds) {
      this.itemCache.delete(id);
      this.invalidatedIds.delete(id);
    }

    await this.cleanupRemovedContent(removed);
  }

  private async cleanupRemovedContent(removed: StoredItem[]): Promise<void> {
    const cleanupResults = await Promise.allSettled(
      removed.flatMap((item) => this.createContentDeletionTasks(item))
    );
    if (cleanupResults.some((result) => result.status === "rejected")) {
      console.error("Encrypted content cleanup failed");
    }
  }

  private createContentDeletionTasks(item: StoredItem): Promise<void>[] {
    const contentKeys = item.type === "image"
      ? [item.contentKey, item.thumbnailKey]
      : [item.contentKey];
    return contentKeys.map((contentKey) => {
      return Promise.resolve().then(() => this.vault.delete(contentKey));
    });
  }

  private referencedContentKeys(): ReadonlySet<string> {
    const contentKeys = new Set<string>();
    for (const item of this.items) {
      contentKeys.add(item.contentKey);
      if (item.type === "image") {
        contentKeys.add(item.thumbnailKey);
      }
    }
    return contentKeys;
  }

  // ── Private: Persistence ──

  private async saveMetadata(items: readonly StoredItem[]): Promise<void> {
    this.revision = await this.metadata.save(items);
  }

  private async detectInstallationEvidence(): Promise<InstallationEvidence> {
    const [settingsExists, historyExists, vaultKeyExists, contentExists] = await Promise.all([
      pathExists(this.settingsPath),
      pathExists(join(this.rootDir, "history.json")),
      pathExists(join(this.rootDir, "vault.key")),
      directoryExists(this.contentDir)
    ]);

    return {
      settingsExists,
      settingsCorrupt: false,
      historyExists,
      vaultKeyExists,
      contentExists
    };
  }

  private async loadSettings(evidence: InstallationEvidence): Promise<void> {
    let raw: Partial<AppSettings> | undefined;
    let needsRepair = !evidence.settingsExists;
    let migrationEvidence = evidence;

    if (evidence.settingsExists) {
      try {
        const parsed = JSON.parse(await readFile(this.settingsPath, "utf8")) as unknown;
        if (isRecord(parsed)) {
          raw = parsed as Partial<AppSettings>;
        } else {
          needsRepair = true;
          migrationEvidence = { ...evidence, settingsCorrupt: true };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          needsRepair = true;
          migrationEvidence = { ...evidence, settingsExists: false };
        } else if (error instanceof SyntaxError) {
          needsRepair = true;
          migrationEvidence = { ...evidence, settingsCorrupt: true };
        } else {
          throw error;
        }
      }
    }

    const migrationInput = raw ?? {
      captureEnabled: this.settings.captureEnabled,
      maxItems: this.settings.maxItems,
      retentionDays: this.settings.retentionDays,
      maxTextLength: this.settings.maxTextLength,
      maxImageBytes: this.settings.maxImageBytes,
      hotkey: this.settings.hotkey
    };
    const migrated = migrateSettings(migrationInput, migrationEvidence);
    this.settings = migrated;
    if (needsRepair || !isDeepStrictEqual(raw, migrated)) {
      await this.saveSettings(migrated);
    }
  }

  private async saveSettings(settings: AppSettings): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    try {
      await copyFile(this.settingsPath, this.settingsPath + ".bak");
    } catch {
      // No existing file to back up — OK
    }
    await writeFile(this.settingsPath, JSON.stringify(settings), "utf8");
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private currentRetentionCutoff(retentionDays: number): number {
    const current = this.options.now?.() ?? new Date();
    return current.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(mutation);
    this.latestMutation = result;
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
