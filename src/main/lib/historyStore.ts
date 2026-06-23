import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type AppSettings, type ClipboardContent, type HistoryFilterType, type HistoryItem, type HistoryQuery, type HistoryResult, type StorageStats } from "../../shared/types";
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
    initialSettings: AppSettings = DEFAULT_SETTINGS
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
    const type = query.type ?? "all";
    const search = query.search?.trim().toLocaleLowerCase();
    const visibleItems: HistoryItem[] = [];

    for (const item of this.sortedItems()) {
      if (type !== "all" && item.type !== type) {
        continue;
      }

      const publicItem = await this.toPublicItem(item);
      if (search && publicItem.type === "text" && !publicItem.text.toLocaleLowerCase().includes(search)) {
        continue;
      }

      if (search && publicItem.type === "image") {
        continue;
      }

      visibleItems.push(publicItem);
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
    const existing = this.items.find((item) => item.type === "image" && item.hash === hash);
    if (existing) {
      existing.updatedAt = now();
      existing.copyCount += 1;
      await this.saveMetadata();
      return { ok: true, item: await this.toPublicItem(existing) };
    }

    const id = randomUUID();
    const item: StoredImageItem = {
      id,
      type: "image",
      hash,
      contentKey: `${id}.image`,
      thumbnailKey: `${id}.thumb`,
      width: input.width,
      height: input.height,
      byteSize: input.png.length,
      createdAt: now(),
      updatedAt: now(),
      pinned: false,
      copyCount: 1
    };

    await this.vault.write(item.contentKey, input.png);
    await this.vault.write(item.thumbnailKey, input.thumbnailPng);
    this.items.push(item);
    await this.enforceRetention();
    await this.saveMetadata();
    return { ok: true, item: await this.toPublicItem(item) };
  }

  async setPinned(id: string, pinned: boolean): Promise<boolean> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) {
      return false;
    }

    item.pinned = pinned;
    item.updatedAt = now();
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

  private async addOrUpdateText(text: string): Promise<HistoryResult> {
    const hash = hashText(text);
    const existing = this.items.find((item) => item.type === "text" && item.hash === hash);
    if (existing) {
      existing.updatedAt = now();
      existing.copyCount += 1;
      await this.saveMetadata();
      return { ok: true, item: await this.toPublicItem(existing) };
    }

    const id = randomUUID();
    const item: StoredTextItem = {
      id,
      type: "text",
      hash,
      contentKey: `${id}.text`,
      createdAt: now(),
      updatedAt: now(),
      pinned: false,
      copyCount: 1
    };

    await this.vault.write(item.contentKey, Buffer.from(text, "utf8"));
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

  private sortedItems(): StoredItem[] {
    return [...this.items].sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }

      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  private async enforceRetention(): Promise<void> {
    await this.trimUnpinned("text", this.settings.maxTextItems);
    await this.trimUnpinned("image", this.settings.maxImageItems);
  }

  private async trimUnpinned(type: StoredItem["type"], maxItems: number): Promise<void> {
    const unpinned = this.items
      .filter((item) => item.type === type && !item.pinned)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const removed = unpinned.slice(maxItems);
    if (removed.length === 0) {
      return;
    }

    const removedIds = new Set(removed.map((item) => item.id));
    this.items = this.items.filter((item) => !removedIds.has(item.id));
    await Promise.all(removed.map((item) => this.deleteContent(item)));
  }

  private async deleteContent(item: StoredItem): Promise<void> {
    await this.vault.delete(item.contentKey);
    if (item.type === "image") {
      await this.vault.delete(item.thumbnailKey);
    }
  }

  private async loadMetadata(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.metadataPath, "utf8")) as MetadataFile;
      this.items = Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      this.items = [];
    }
  }

  private async saveMetadata(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.metadataPath, JSON.stringify({ version: 1, items: this.items } satisfies MetadataFile, null, 2), "utf8");
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
    await writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf8");
  }
}

function hashText(text: string): string {
  return hashBytes("text", Buffer.from(text, "utf8"));
}

function hashBytes(namespace: string, data: Buffer): string {
  return createHash("sha256").update(namespace).update("\0").update(data).digest("hex");
}

function now(): string {
  return new Date().toISOString();
}
