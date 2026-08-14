import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupExportedImages } from "./exportedImages";

describe("cleanupExportedImages", () => {
  let dir: string;

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("removes stale PNGs and keeps recent ones", async () => {
    dir = await mkdtemp(join(tmpdir(), "exported-images-"));
    const oldPath = join(dir, "old.png");
    const recentPath = join(dir, "recent.png");
    await writeFile(oldPath, "x");
    await writeFile(recentPath, "x");
    const longAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(oldPath, longAgo, longAgo);

    const removed = await cleanupExportedImages(dir, 7 * 24 * 60 * 60 * 1000);

    expect(removed).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(["recent.png"]);
  });

  test("ignores non-PNG files", async () => {
    dir = await mkdtemp(join(tmpdir(), "exported-images-"));
    const staleTxt = join(dir, "old.txt");
    const stalePng = join(dir, "old.png");
    await writeFile(staleTxt, "x");
    await writeFile(stalePng, "x");
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(staleTxt, longAgo, longAgo);
    await utimes(stalePng, longAgo, longAgo);

    const removed = await cleanupExportedImages(dir, 7 * 24 * 60 * 60 * 1000);

    expect(removed).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(["old.txt"]);
  });

  test("returns zero when the directory does not exist", async () => {
    dir = await mkdtemp(join(tmpdir(), "exported-images-"));
    await rm(dir, { recursive: true, force: true });

    await expect(cleanupExportedImages(dir)).resolves.toBe(0);
  });
});
