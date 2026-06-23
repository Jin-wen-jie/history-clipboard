import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileContentVault, MemoryKeyProvider } from "./secureVault";

describe("FileContentVault", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "history-vault-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("encrypts and decrypts bytes without storing plaintext", async () => {
    const vault = new FileContentVault(dir, new MemoryKeyProvider());
    await vault.write("item-1", Buffer.from("secret text"));

    const encrypted = await vault.readRaw("item-1");
    const decrypted = await vault.read("item-1");

    expect(encrypted.includes(Buffer.from("secret text"))).toBe(false);
    expect(decrypted.toString("utf8")).toBe("secret text");
  });
});
