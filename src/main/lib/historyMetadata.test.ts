import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  HistoryMetadataJournal,
  type MetadataFile,
  type StoredImageItem,
  type StoredItem,
  type StoredTextItem
} from "./historyMetadata";

const timestamp = "2026-07-12T00:00:00.000Z";

function textItem(id: string): StoredTextItem {
  return {
    id,
    type: "text",
    hash: `hash-${id}`,
    contentKey: `${id}.text`,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinned: false,
    copyCount: 1
  };
}

function imageItem(id: string): StoredImageItem {
  return {
    id,
    type: "image",
    hash: `hash-${id}`,
    contentKey: `${id}.image`,
    thumbnailKey: `${id}.thumb`,
    width: 1,
    height: 1,
    byteSize: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinned: false,
    copyCount: 1
  };
}

describe("HistoryMetadataJournal", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "history-metadata-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeCandidate(name: string, value: unknown): Promise<void> {
    await writeFile(join(dir, name), JSON.stringify(value), "utf8");
  }

  async function readCandidate(name: string): Promise<MetadataFile> {
    return JSON.parse(await readFile(join(dir, name), "utf8")) as MetadataFile;
  }

  test("selects the highest valid revision and promotes it to main", async () => {
    await writeCandidate("history.json", { version: 1, revision: 1, items: [textItem("main")] });
    await writeCandidate("history.json.tmp", { version: 1, revision: 3, items: [textItem("temp")] });
    await writeCandidate("history.json.bak", { version: 1, revision: 2, items: [textItem("backup")] });

    const journal = new HistoryMetadataJournal(dir);
    const loaded = await journal.load();

    expect(loaded).toMatchObject({
      revision: 3,
      hadCandidates: true,
      validCandidate: true,
      recovered: true
    });
    expect(loaded.items.map((entry) => entry.id)).toEqual(["temp"]);
    expect(await readCandidate("history.json")).toMatchObject({
      revision: 3,
      items: [{ id: "temp" }]
    });
    await expect(journal.save([textItem("next")])).resolves.toBe(4);
  });

  test("loads legacy metadata as revision zero", async () => {
    await writeCandidate("history.json", { version: 1, items: [textItem("legacy")] });

    const loaded = await new HistoryMetadataJournal(dir).load();

    expect(loaded).toMatchObject({
      revision: 0,
      items: [{ id: "legacy" }],
      hadCandidates: true,
      validCandidate: true,
      recovered: false
    });
  });

  test("rejects a higher revision with malformed items", async () => {
    await writeCandidate("history.json", { version: 1, revision: 1, items: [textItem("valid")] });
    await writeCandidate("history.json.tmp", { version: 1, revision: 9, items: [{ id: 42 }] });

    const loaded = await new HistoryMetadataJournal(dir).load();

    expect(loaded).toMatchObject({
      revision: 1,
      items: [{ id: "valid" }],
      hadCandidates: true,
      validCandidate: true,
      recovered: false
    });
  });

  test.each([
    {
      name: "main over temp and backup",
      candidates: [
        ["history.json", "main"],
        ["history.json.tmp", "temp"],
        ["history.json.bak", "backup"]
      ],
      expected: "main",
      recovered: false
    },
    {
      name: "temp over backup",
      candidates: [
        ["history.json.tmp", "temp"],
        ["history.json.bak", "backup"]
      ],
      expected: "temp",
      recovered: true
    }
  ])("prefers $name at the same revision", async ({ candidates, expected, recovered }) => {
    for (const [name, id] of candidates) {
      await writeCandidate(name, { version: 1, revision: 5, items: [textItem(id)] });
    }

    const loaded = await new HistoryMetadataJournal(dir).load();

    expect(loaded.revision).toBe(5);
    expect(loaded.items.map((entry) => entry.id)).toEqual([expected]);
    expect(loaded.recovered).toBe(recovered);
  });

  test("distinguishes missing metadata from invalid candidates", async () => {
    await expect(new HistoryMetadataJournal(dir).load()).resolves.toEqual({
      revision: 0,
      items: [],
      hadCandidates: false,
      validCandidate: false,
      recovered: false
    });

    await writeFile(join(dir, "history.json"), "{", "utf8");
    await writeCandidate("history.json.tmp", { version: 1, revision: -1, items: [] });
    await writeCandidate("history.json.bak", { version: 2, revision: 8, items: [] });

    await expect(new HistoryMetadataJournal(dir).load()).resolves.toEqual({
      revision: 0,
      items: [],
      hadCandidates: true,
      validCandidate: false,
      recovered: false
    });
  });

  test("validates every stored item field and discriminated union branch", async () => {
    const malformedItems: unknown[] = [
      { ...textItem("bad-id"), id: 42 },
      { ...textItem("bad-hash"), hash: null },
      { ...textItem("bad-created"), createdAt: 42 },
      { ...textItem("bad-updated"), updatedAt: false },
      { ...textItem("bad-pinned"), pinned: "false" },
      { ...textItem("bad-count"), copyCount: "1" },
      { ...textItem("bad-type"), type: "html" },
      { ...textItem("bad-content"), contentKey: 42 },
      { ...imageItem("bad-image-content"), contentKey: 42 },
      { ...imageItem("bad-thumb"), thumbnailKey: null },
      { ...imageItem("bad-width"), width: "1" },
      { ...imageItem("bad-height"), height: false },
      { ...imageItem("bad-size"), byteSize: null }
    ];

    await writeCandidate("history.json", { version: 1, revision: 1, items: [textItem("valid")] });

    for (const malformedItem of malformedItems) {
      await writeCandidate("history.json.tmp", { version: 1, revision: 9, items: [malformedItem] });
      const loaded = await new HistoryMetadataJournal(dir).load();
      expect(loaded.revision).toBe(1);
      expect(loaded.items.map((entry) => entry.id)).toEqual(["valid"]);
    }
  });

  test("snapshots at save call time and flushes the latest queued revision", async () => {
    const journal = new HistoryMetadataJournal(dir);
    await expect(journal.flush()).resolves.toBeUndefined();

    const firstItem: StoredItem = textItem("first");
    const first = journal.save([firstItem]);
    firstItem.id = "mutated-first";

    const secondItem: StoredItem = imageItem("second");
    const second = journal.save([secondItem]);
    secondItem.thumbnailKey = "mutated-thumb";

    await journal.flush();

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(await readCandidate("history.json")).toMatchObject({
      revision: 2,
      items: [{ id: "second", thumbnailKey: "second.thumb" }]
    });
    expect(await readCandidate("history.json.bak")).toMatchObject({
      revision: 1,
      items: [{ id: "first" }]
    });
  });

  test("continues queued saves after a write failure", async () => {
    const journal = new HistoryMetadataJournal(dir);
    await mkdir(join(dir, "history.json.tmp"));

    const failed = journal.save([textItem("failed")]);
    await expect(failed).rejects.toBeDefined();
    await expect(journal.flush()).rejects.toBeDefined();

    await rm(join(dir, "history.json.tmp"), { recursive: true });
    await expect(journal.save([textItem("recovered")])).resolves.toBe(2);
    await expect(journal.flush()).resolves.toBeUndefined();
    expect(await readCandidate("history.json")).toMatchObject({
      revision: 2,
      items: [{ id: "recovered" }]
    });
  });

  test("does not overwrite a valid backup when the current main is corrupt", async () => {
    await writeCandidate("history.json.bak", { version: 1, revision: 7, items: [textItem("backup")] });
    const journal = new HistoryMetadataJournal(dir);
    await journal.load();
    await writeFile(join(dir, "history.json"), "{", "utf8");

    await expect(journal.save([textItem("saved")])).resolves.toBe(8);

    expect(await readCandidate("history.json.bak")).toMatchObject({
      revision: 7,
      items: [{ id: "backup" }]
    });
    expect(await readCandidate("history.json")).toMatchObject({
      revision: 8,
      items: [{ id: "saved" }]
    });
  });
});
