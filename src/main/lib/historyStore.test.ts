import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HistoryStore } from "./historyStore";
import { MemoryKeyProvider } from "./secureVault";
import type { AppSettings } from "../../shared/types";

const settings: AppSettings = {
  captureEnabled: true,
  maxTextItems: 2,
  maxImageItems: 1,
  maxTextLength: 20_000,
  maxImageBytes: 10,
  hotkey: "Ctrl+Alt+V",
  launchAtStartup: false,
  sensitiveFilterEnabled: true
};

describe("HistoryStore", () => {
  let dir: string;
  let store: HistoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "history-clipboard-"));
    store = new HistoryStore(dir, new MemoryKeyProvider(), settings);
    await store.init();
  });

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

  test("keeps only the newest unpinned text entries", async () => {
    const pinned = await store.addText("pinned");
    if (!pinned.ok) {
      throw new Error("Expected pinned item to be stored.");
    }
    await store.setPinned(pinned.item.id, true);
    await store.addText("one");
    await store.addText("two");
    await store.addText("three");

    const texts = (await store.list()).filter((item) => item.type === "text").map((item) => item.text);

    expect(texts).toEqual(["pinned", "three", "two"]);
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
});
