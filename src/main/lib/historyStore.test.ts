import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HistoryStore } from "./historyStore";
import { MemoryKeyProvider } from "./secureVault";
import type { AppSettings } from "../../shared/types";

const settings: AppSettings = {
  captureEnabled: true,
  maxItems: 3,
  retentionDays: 30,
  maxTextLength: 20_000,
  maxImageBytes: 10,
  hotkey: "Ctrl+Alt+V",
  launchAtStartup: false,
  sensitiveFilterEnabled: true
};

describe("HistoryStore", () => {
  let dir: string;
  let store: HistoryStore;
  let currentTime: Date;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "history-clipboard-"));
    currentTime = new Date("2026-06-23T12:00:00.000Z");
    store = new HistoryStore(dir, new MemoryKeyProvider(), settings, { now: () => currentTime });
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
