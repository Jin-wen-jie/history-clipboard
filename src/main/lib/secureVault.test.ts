import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  FileContentVault,
  MemoryKeyProvider,
  SafeStorageKeyProvider
} from "./secureVault";

describe("SafeStorageKeyProvider", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "history-vault-key-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("preserves an existing key when decryption fails", async () => {
    const keyPath = join(dir, "vault.key");
    const decryptError = new Error("cannot decrypt");
    const protector = {
      isEncryptionAvailable: vi.fn(() => true),
      decryptString: vi.fn(() => {
        throw decryptError;
      }),
      encryptString: vi.fn(() => Buffer.from("replacement-key"))
    };
    await writeFile(keyPath, "existing-encrypted-key");

    const provider = new SafeStorageKeyProvider(keyPath, protector);

    await expect(provider.getKey()).rejects.toBe(decryptError);
    expect(await readFile(keyPath, "utf8")).toBe("existing-encrypted-key");
    expect(protector.encryptString).not.toHaveBeenCalled();
  });
});

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

  test("removes encrypted files that are not referenced", async () => {
    const vault = new FileContentVault(dir, new MemoryKeyProvider());
    await vault.write("keep.text", Buffer.from([1]));
    await vault.write("drop.text", Buffer.from([2]));

    const removed = await vault.cleanupOrphans(new Set(["keep.text"]));

    expect(removed).toBe(1);
    await expect(vault.read("keep.text")).resolves.toEqual(Buffer.from([1]));
    await expect(vault.read("drop.text")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
