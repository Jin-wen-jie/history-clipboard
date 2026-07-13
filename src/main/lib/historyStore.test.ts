import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HistoryStore } from "./historyStore";
import { MemoryKeyProvider } from "./secureVault";
import type { InstallationEvidence } from "./settingsMigration";
import { DEFAULT_SETTINGS, type AppSettings } from "../../shared/types";

const settings: AppSettings = {
  captureEnabled: true,
  maxItems: 3,
  retentionDays: 30,
  maxTextLength: 20_000,
  maxImageBytes: 10,
  hotkey: "Ctrl+Alt+V",
  launchAtStartup: false,
  startupDecisionVersion: 1,
  sensitiveFilterEnabled: true
};

describe("HistoryStore settings migration", () => {
  let dir: string;
  let keyProvider: MemoryKeyProvider;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "history-clipboard-settings-"));
    keyProvider = new MemoryKeyProvider(Buffer.alloc(32, 8));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function initialize(): Promise<HistoryStore> {
    const target = new HistoryStore(dir, keyProvider);
    await target.init();
    return target;
  }

  async function readPersistedSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
  }

  test("treats a root without pre-existing content as a new installation", async () => {
    const target = await initialize();

    expect(await target.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await readPersistedSettings()).toMatchObject({
      launchAtStartup: true,
      startupDecisionVersion: 1,
      sensitiveFilterEnabled: false
    });
  });

  test.each([
    ["disabled", { launchAtStartup: false, sensitiveFilterEnabled: true }],
    ["missing", { captureEnabled: false, sensitiveFilterEnabled: true }]
  ])("keeps legacy %s startup settings pending a decision", async (_name, legacySettings) => {
    await writeFile(join(dir, "settings.json"), JSON.stringify(legacySettings), "utf8");

    const target = await initialize();

    expect(await target.getSettings()).toMatchObject({
      launchAtStartup: false,
      startupDecisionVersion: 0,
      sensitiveFilterEnabled: false
    });
  });

  test("migrates a legacy enabled startup setting to version 1", async () => {
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      launchAtStartup: true,
      sensitiveFilterEnabled: true
    }), "utf8");

    const target = await initialize();

    expect(await target.getSettings()).toMatchObject({
      launchAtStartup: true,
      startupDecisionVersion: 1,
      sensitiveFilterEnabled: false
    });
  });

  test("preserves observed legacy evidence when settings disappear before reading", async () => {
    const settingsPath = join(dir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ captureEnabled: true }), "utf8");
    const target = new HistoryStore(dir, keyProvider);
    const internals = target as unknown as {
      detectInstallationEvidence(): Promise<InstallationEvidence>;
    };
    const detectEvidence = internals.detectInstallationEvidence.bind(internals);
    const detectionSpy = vi.spyOn(internals, "detectInstallationEvidence").mockImplementation(async () => {
      const evidence = await detectEvidence();
      expect(evidence).toEqual({
        settingsExists: true,
        settingsCorrupt: false,
        historyExists: false,
        vaultKeyExists: false,
        contentExists: false
      });
      await rm(settingsPath);
      return evidence;
    });

    try {
      await target.init();
    } finally {
      detectionSpy.mockRestore();
    }

    expect(await target.getSettings()).toMatchObject({
      launchAtStartup: false,
      startupDecisionVersion: 0,
      sensitiveFilterEnabled: false
    });
    await expect(readPersistedSettings()).resolves.toMatchObject({
      launchAtStartup: false,
      startupDecisionVersion: 0
    });
  });

  test.each([
    ["history", async (rootDir: string) => {
      await writeFile(join(rootDir, "history.json"), JSON.stringify({
        version: 1,
        revision: 0,
        items: []
      }), "utf8");
    }],
    ["vault key", async (rootDir: string) => {
      await writeFile(join(rootDir, "vault.key"), "existing-key", "utf8");
    }],
    ["content directory", async (rootDir: string) => {
      await mkdir(join(rootDir, "content"));
    }]
  ] satisfies Array<readonly [string, (rootDir: string) => Promise<void>]>) (
    "repairs corrupt settings conservatively with only %s evidence",
    async (_name, createEvidence) => {
      await writeFile(join(dir, "settings.json"), "{", "utf8");
      await createEvidence(dir);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      try {
        const target = await initialize();
        expect(await target.getSettings()).toMatchObject({
          launchAtStartup: false,
          startupDecisionVersion: 0,
          sensitiveFilterEnabled: false
        });
      } finally {
        errorSpy.mockRestore();
      }
    }
  );

  test("does not rewrite a valid version 1 settings file", async () => {
    const existingSettings: AppSettings = {
      captureEnabled: false,
      maxItems: 250,
      retentionDays: 14,
      maxTextLength: 12_000,
      maxImageBytes: 2 * 1024 * 1024,
      hotkey: "Ctrl+Shift+V",
      launchAtStartup: false,
      startupDecisionVersion: 1,
      sensitiveFilterEnabled: true
    };
    const settingsPath = join(dir, "settings.json");
    await writeFile(settingsPath, JSON.stringify(existingSettings), "utf8");
    const stableTime = new Date("2001-02-03T04:05:06.000Z");
    await utimes(settingsPath, stableTime, stableTime);
    const before = await stat(settingsPath);

    const target = await initialize();
    const after = await stat(settingsPath);

    expect(await target.getSettings()).toEqual(existingSettings);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("repairs corrupt settings without losing loadable history", async () => {
    const original = await initialize();
    await original.addText("alpha");
    await original.flush();
    await writeFile(join(dir, "settings.json"), "{", "utf8");

    const reloaded = await initialize();

    expect(await reloaded.getSettings()).toMatchObject({
      launchAtStartup: false,
      startupDecisionVersion: 0,
      sensitiveFilterEnabled: false
    });
    await expect(reloaded.list()).resolves.toMatchObject([
      { type: "text", text: "alpha" }
    ]);
    await expect(readPersistedSettings()).resolves.toMatchObject({
      startupDecisionVersion: 0
    });
  });
});

describe("HistoryStore", () => {
  let dir: string;
  let store: HistoryStore;
  let keyProvider: MemoryKeyProvider;
  let currentTime: Date;

  type MetadataSnapshot = {
    revision: number;
    items: Array<{ id: string }>;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "history-clipboard-"));
    currentTime = new Date("2026-06-23T12:00:00.000Z");
    keyProvider = new MemoryKeyProvider(Buffer.alloc(32, 7));
    store = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
    await store.init();
  });

  async function expectMetadataCommittedBeforeCleanup<T>(
    target: HistoryStore,
    operation: () => Promise<T>,
    assertMetadata: (metadata: MetadataSnapshot) => void
  ): Promise<T> {
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const vault = (target as unknown as {
      vault: { delete(id: string): Promise<void> };
    }).vault;
    const originalDelete = vault.delete.bind(vault);
    const deleteSpy = vi.spyOn(vault, "delete").mockImplementation(async (id) => {
      await deleteGate;
      await originalDelete(id);
    });

    const pendingOperation = operation();
    let orderingError: unknown;
    try {
      await vi.waitFor(async () => {
        const metadata = JSON.parse(
          await readFile(join(dir, "history.json"), "utf8")
        ) as MetadataSnapshot;
        assertMetadata(metadata);
      });
    } catch (error) {
      orderingError = error;
    } finally {
      releaseDelete();
    }

    try {
      const result = await pendingOperation;
      if (orderingError) throw orderingError;
      expect(deleteSpy).toHaveBeenCalled();
      return result;
    } finally {
      deleteSpy.mockRestore();
    }
  }

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("deduplicates text entries by content hash", async () => {
    await store.addText("alpha");
    await store.addText("alpha");

    const items = await store.list();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "text", text: "alpha", copyCount: 2 });
  });

  test("persists metadata before addText resolves", async () => {
    vi.useFakeTimers();
    try {
      await store.addText("alpha");

      const reloaded = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
      await reloaded.init();

      const items = await reloaded.list();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ type: "text", text: "alpha" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("commits removed metadata before deleting encrypted content", async () => {
    const added = await store.addText("alpha");
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("expected text item");

    const deleted = await expectMetadataCommittedBeforeCleanup(
      store,
      () => store.delete(added.item.id),
      (metadata) => {
        expect(metadata.items).toEqual([]);
      }
    );

    expect(deleted).toBe(true);
  });

  test("keeps history available when deletion metadata commit fails", async () => {
    const added = await store.addText("alpha");
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("expected text item");

    const temporaryPath = join(dir, "history.json.tmp");
    await mkdir(temporaryPath);
    await expect(store.delete(added.item.id)).rejects.toBeDefined();
    await rm(temporaryPath, { recursive: true });

    await expect(store.list()).resolves.toMatchObject([
      { id: added.item.id, type: "text", text: "alpha" }
    ]);
    await expect(store.getContent(added.item.id)).resolves.toEqual({
      type: "text",
      text: "alpha"
    });

    await expect(store.delete(added.item.id)).resolves.toBe(true);
    await store.flush();
    const reloaded = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
    await reloaded.init();
    await expect(reloaded.list()).resolves.toEqual([]);
  });

  test("queues a pin mutation behind an in-flight deletion commit", async () => {
    const added = await store.addText("alpha");
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("expected text item");

    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const metadata = (store as unknown as {
      metadata: { save(items: readonly unknown[]): Promise<number> };
    }).metadata;
    const originalSave = metadata.save.bind(metadata);
    const saveSpy = vi.spyOn(metadata, "save").mockImplementation(async (items) => {
      markSaveStarted();
      await saveGate;
      return originalSave(items);
    });

    const deletion = store.delete(added.item.id);
    await saveStarted;
    let pinSettled = false;
    const pinning = store.setPinned(added.item.id, true).then(
      (result) => {
        pinSettled = true;
        return result;
      },
      (error) => {
        pinSettled = true;
        throw error;
      }
    );

    try {
      await Promise.resolve();
      expect(pinSettled).toBe(false);
    } finally {
      releaseSave();
      await Promise.allSettled([deletion, pinning]);
      saveSpy.mockRestore();
    }

    await expect(deletion).resolves.toBe(true);
    await expect(pinning).resolves.toBe(false);
    await store.flush();
    const metadataSnapshot = JSON.parse(
      await readFile(join(dir, "history.json"), "utf8")
    ) as MetadataSnapshot;
    expect(metadataSnapshot.items).toEqual([]);
  });

  test("deleteMany commits metadata before deleting encrypted content", async () => {
    const alpha = await store.addText("alpha");
    const beta = await store.addText("beta");
    expect(alpha.ok && beta.ok).toBe(true);
    if (!alpha.ok || !beta.ok) throw new Error("expected text items");

    const removed = await expectMetadataCommittedBeforeCleanup(
      store,
      () => store.deleteMany([alpha.item.id]),
      (metadata) => {
        expect(metadata.revision).toBe(3);
        expect(metadata.items.map((item) => item.id)).toEqual([beta.item.id]);
      }
    );

    expect(removed).toBe(1);
  });

  test("clear commits metadata before deleting encrypted content", async () => {
    await store.addText("alpha");

    await expectMetadataCommittedBeforeCleanup(
      store,
      () => store.clear(),
      (metadata) => {
        expect(metadata.revision).toBe(2);
        expect(metadata.items).toEqual([]);
      }
    );
  });

  test("expired-item retention commits metadata before deleting encrypted content", async () => {
    currentTime = new Date("2026-05-01T08:00:00.000Z");
    await store.addText("old");
    currentTime = new Date("2026-06-23T12:00:00.000Z");

    await expectMetadataCommittedBeforeCleanup(
      store,
      () => store.list(),
      (metadata) => {
        expect(metadata.revision).toBe(2);
        expect(metadata.items).toEqual([]);
      }
    );
  });

  test("max-item retention commits metadata once before deleting encrypted content", async () => {
    const first = await store.addText("one");
    currentTime = new Date("2026-06-23T12:01:00.000Z");
    await store.addText("two");
    currentTime = new Date("2026-06-23T12:02:00.000Z");
    await store.addText("three");
    currentTime = new Date("2026-06-23T12:03:00.000Z");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected text item");

    await expectMetadataCommittedBeforeCleanup(
      store,
      () => store.addText("four"),
      (metadata) => {
        expect(metadata.revision).toBe(4);
        expect(metadata.items).toHaveLength(3);
        expect(metadata.items.map((item) => item.id)).not.toContain(first.item.id);
      }
    );
  });

  test("unreadable cleanup commits metadata before deleting encrypted content", async () => {
    await writeFile(join(dir, "history.json"), JSON.stringify({
      version: 1,
      revision: 1,
      items: [
        {
          id: "missing-content",
          type: "text",
          hash: "hash",
          contentKey: "missing.text",
          createdAt: "2026-06-23T12:00:00.000Z",
          updatedAt: "2026-06-23T12:00:00.000Z",
          pinned: false,
          copyCount: 1
        }
      ]
    }), "utf8");
    const reloaded = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
    await reloaded.init();

    await expectMetadataCommittedBeforeCleanup(
      reloaded,
      () => reloaded.list(),
      (metadata) => {
        expect(metadata.revision).toBe(2);
        expect(metadata.items).toEqual([]);
      }
    );
  });

  test("logs only a fixed message when encrypted content cleanup fails", async () => {
    const added = await store.addImage({
      png: Buffer.from([1, 2, 3]),
      thumbnailPng: Buffer.from([4]),
      width: 1,
      height: 1
    });
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("expected image item");

    const vault = (store as unknown as {
      vault: { delete(id: string): Promise<void> };
    }).vault;
    const deleteSpy = vi.spyOn(vault, "delete").mockRejectedValue(
      new Error(`sensitive cleanup failure: ${dir}`)
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(store.delete(added.item.id)).resolves.toBe(true);
      const metadata = JSON.parse(
        await readFile(join(dir, "history.json"), "utf8")
      ) as MetadataSnapshot;
      expect(metadata.items).toEqual([]);
      expect(deleteSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("Encrypted content cleanup failed");
    } finally {
      errorSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  test("waits for every image blob cleanup after one cleanup fails", async () => {
    const added = await store.addImage({
      png: Buffer.from([1, 2, 3]),
      thumbnailPng: Buffer.from([4]),
      width: 1,
      height: 1
    });
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("expected image item");

    let releaseThumbnail!: () => void;
    const thumbnailGate = new Promise<void>((resolve) => {
      releaseThumbnail = resolve;
    });
    const vault = (store as unknown as {
      vault: { delete(id: string): Promise<void> };
    }).vault;
    const deleteSpy = vi.spyOn(vault, "delete").mockImplementation((id) => {
      if (id.endsWith(".image")) {
        throw new Error("content cleanup failed");
      }
      return thumbnailGate;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let settled = false;
    let deletionError: unknown;
    const deletion = store.delete(added.item.id).then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        deletionError = error;
        return false;
      }
    );

    try {
      await vi.waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(2));
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      releaseThumbnail();
      try {
        await deletion;
      } finally {
        errorSpy.mockRestore();
        deleteSpy.mockRestore();
      }
    }

    expect(deletionError).toBeUndefined();
    await expect(deletion).resolves.toBe(true);
  });

  test("flush waits for the latest revision", async () => {
    const added = await store.addText("alpha");
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("expected text item");

    const firstMutation = store.setPinned(added.item.id, true);
    const secondMutation = store.setPinned(added.item.id, false);
    await store.flush();
    await Promise.all([firstMutation, secondMutation]);

    const reloaded = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
    await reloaded.init();
    expect(await reloaded.list()).toMatchObject([{ id: added.item.id, pinned: false }]);
  });

  test("cleans orphan blobs only when metadata is recoverable", async () => {
    await store.addText("alpha");
    const image = await store.addImage({
      png: Buffer.from([9]),
      thumbnailPng: Buffer.from([8]),
      width: 1,
      height: 1
    });
    expect(image.ok).toBe(true);
    if (!image.ok) throw new Error("expected image item");
    const orphanPath = join(dir, "content", "orphan.text.bin");
    await writeFile(orphanPath, Buffer.from([1, 2, 3]));

    const reloaded = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
    await reloaded.init();

    await expect(readFile(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(reloaded.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "alpha" }),
      expect.objectContaining({ id: image.item.id, type: "image" })
    ]));
    await expect(reloaded.getContent(image.item.id)).resolves.toEqual({
      type: "image",
      png: Buffer.from([9])
    });
  });

  test("continues initialization when recoverable orphan cleanup fails", async () => {
    await store.addText("alpha");
    const reloaded = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
    const vault = (reloaded as unknown as {
      vault: { cleanupOrphans(ids: ReadonlySet<string>): Promise<number> };
    }).vault;
    const cleanupSpy = vi.spyOn(vault, "cleanupOrphans").mockRejectedValue(
      new Error(`orphan cleanup failed at ${dir}`)
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(reloaded.init()).resolves.toBeUndefined();
      await expect(reloaded.list()).resolves.toMatchObject([
        { type: "text", text: "alpha" }
      ]);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("Encrypted content cleanup failed: orphan-cleanup");
    } finally {
      errorSpy.mockRestore();
      cleanupSpy.mockRestore();
    }

    const retried = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
    const retryVault = (retried as unknown as {
      vault: { cleanupOrphans(ids: ReadonlySet<string>): Promise<number> };
    }).vault;
    const retrySpy = vi.spyOn(retryVault, "cleanupOrphans");
    try {
      await retried.init();
      expect(retrySpy).toHaveBeenCalledTimes(1);
    } finally {
      retrySpy.mockRestore();
    }
  });

  test("preserves orphan blobs when every metadata candidate is corrupt", async () => {
    const orphanPath = join(dir, "content", "orphan.text.bin");
    await writeFile(orphanPath, Buffer.from([1, 2, 3]));
    await writeFile(join(dir, "history.json"), "{", "utf8");
    await writeFile(join(dir, "history.json.tmp"), "[]", "utf8");
    await writeFile(join(dir, "history.json.bak"), JSON.stringify({ version: 2, items: [] }), "utf8");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const reloaded = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
    const vault = (reloaded as unknown as {
      vault: { cleanupOrphans(ids: ReadonlySet<string>): Promise<number> };
    }).vault;
    const cleanupSpy = vi.spyOn(vault, "cleanupOrphans");
    try {
      await reloaded.init();

      await expect(readFile(orphanPath)).resolves.toEqual(Buffer.from([1, 2, 3]));
      expect(cleanupSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith("Encrypted content cleanup skipped: metadata-unrecoverable");
    } finally {
      cleanupSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("preserves orphan blobs when metadata is missing but content already exists", async () => {
    const orphanPath = join(dir, "content", "orphan.text.bin");
    await writeFile(orphanPath, Buffer.from([1, 2, 3]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const reloaded = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
      await reloaded.init();

      await expect(readFile(orphanPath)).resolves.toEqual(Buffer.from([1, 2, 3]));
      expect(errorSpy).toHaveBeenCalledWith("Encrypted content cleanup skipped: metadata-unrecoverable");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("recovers the metadata write chain after a write failure", async () => {
    const added = await store.addText("alpha");
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("expected text item");

    const temporaryPath = join(dir, "history.json.tmp");
    await mkdir(temporaryPath);
    await expect(store.setPinned(added.item.id, true)).rejects.toBeDefined();
    await rm(temporaryPath, { recursive: true });

    await expect(store.setPinned(added.item.id, false)).resolves.toBe(true);
    await store.flush();

    const reloaded = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
    await reloaded.init();
    expect(await reloaded.list()).toMatchObject([{ id: added.item.id, pinned: false }]);
  });

  test("continues revisions from the latest recovered metadata candidate", async () => {
    const added = await store.addText("alpha");
    expect(added.ok).toBe(true);

    const main = JSON.parse(await readFile(join(dir, "history.json"), "utf8"));
    expect(main.revision).toBe(1);
    const recoveredId = main.items[0].id;
    await writeFile(join(dir, "history.json.tmp"), JSON.stringify({
      ...main,
      revision: 3,
      items: [{ ...main.items[0], pinned: true }]
    }), "utf8");

    const reloaded = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
    await reloaded.init();

    expect((await reloaded.list())[0]).toMatchObject({ id: recoveredId, pinned: true });
    expect(JSON.parse(await readFile(join(dir, "history.json"), "utf8")).revision).toBe(3);
    await reloaded.setPinned(recoveredId, false);
    await reloaded.flush();
    expect(JSON.parse(await readFile(join(dir, "history.json"), "utf8")).revision).toBe(4);
  });

  test("keeps only the newest entries across text and images", async () => {
    await store.addText("one");
    currentTime = new Date("2026-06-23T12:01:00.000Z");
    await store.addImage({ png: Buffer.from([1]), thumbnailPng: Buffer.from([1]), width: 1, height: 1 });
    currentTime = new Date("2026-06-23T12:02:00.000Z");
    await store.addText("two");
    currentTime = new Date("2026-06-23T12:03:00.000Z");
    await store.addText("three");

    const items = await store.list();

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.type === "text" ? item.text : "image")).toEqual(["three", "two", "image"]);
  });

  test("rejects images larger than the configured limit", async () => {
    const result = await store.addImage({
      png: Buffer.from("this image is too large"),
      thumbnailPng: Buffer.from("thumb"),
      width: 2,
      height: 2
    });

    expect(result).toEqual({ ok: false, reason: "too-large" });
    expect(await store.list()).toEqual([]);
  });

  test("stores image metadata and deduplicates image bytes", async () => {
    const png = Buffer.from([1, 2, 3, 4]);
    await store.addImage({ png, thumbnailPng: Buffer.from([9]), width: 8, height: 6 });
    await store.addImage({ png, thumbnailPng: Buffer.from([9]), width: 8, height: 6 });

    const items = await store.list();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "image", width: 8, height: 6, byteSize: 4, copyCount: 2 });
  });

  test("removes entries older than the retention window", async () => {
    currentTime = new Date("2026-05-01T08:00:00.000Z");
    await store.addText("old");
    currentTime = new Date("2026-06-23T12:00:00.000Z");
    await store.addText("fresh");

    const texts = (await store.list()).filter((item) => item.type === "text").map((item) => item.text);

    expect(texts).toEqual(["fresh"]);
  });

  test("filters records by updated time range", async () => {
    currentTime = new Date("2026-06-23T08:00:00.000Z");
    await store.addText("morning");
    currentTime = new Date("2026-06-23T12:00:00.000Z");
    await store.addText("noon");
    currentTime = new Date("2026-06-23T18:00:00.000Z");
    await store.addText("evening");

    const texts = (await store.list({
      from: "2026-06-23T11:00:00.000Z",
      to: "2026-06-23T13:00:00.000Z"
    })).filter((item) => item.type === "text").map((item) => item.text);

    expect(texts).toEqual(["noon"]);
  });

  test("skips unreadable entries instead of failing the whole list", async () => {
    await writeFile(join(dir, "history.json"), JSON.stringify({
      version: 1,
      items: [
        {
          id: "missing-content",
          type: "text",
          hash: "hash",
          contentKey: "missing.text",
          createdAt: "2026-06-23T12:00:00.000Z",
          updatedAt: "2026-06-23T12:00:00.000Z",
          pinned: false,
          copyCount: 1
        }
      ]
    }), "utf8");
    const reloaded = new HistoryStore(dir, new MemoryKeyProvider(), settings, { now: () => currentTime });
    await reloaded.init();

    await expect(reloaded.list()).resolves.toEqual([]);
  });
});
