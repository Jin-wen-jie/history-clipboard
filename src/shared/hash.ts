import { createHash } from "node:crypto";

/**
 * SHA-256 hash of a namespace + null byte + data.
 * Used for content deduplication across the app.
 */
export function hashBytes(namespace: string, data: Buffer): string {
  return createHash("sha256").update(namespace).update("\0").update(data).digest("hex");
}
