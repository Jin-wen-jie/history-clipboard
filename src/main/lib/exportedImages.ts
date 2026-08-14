import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Removes exported-image PNGs older than `maxAgeMs`.
 *
 * `copyPathHistoryItem` exports clipboard images to a stable folder so their
 * path can be copied; without cleanup that folder grows without bound as
 * distinct images are path-copied over time. Called once at startup.
 */
export async function cleanupExportedImages(
  dir: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS
): Promise<number> {
  if (maxAgeMs < 0) {
    throw new RangeError("maxAgeMs must be non-negative");
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".png")) {
      continue;
    }
    try {
      const info = await stat(join(dir, entry.name));
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(join(dir, entry.name), { force: true });
        removed += 1;
      }
    } catch {
      // The entry may have disappeared or be unreadable; skip it.
    }
  }
  return removed;
}
