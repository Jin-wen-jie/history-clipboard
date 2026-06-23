import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAGIC = Buffer.from("HCB1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface ContentKeyProvider {
  getKey(): Promise<Buffer>;
}

export interface StringProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class MemoryKeyProvider implements ContentKeyProvider {
  private readonly key: Buffer;

  constructor(key = randomBytes(KEY_BYTES)) {
    this.key = key;
  }

  async getKey(): Promise<Buffer> {
    return this.key;
  }
}

export class SafeStorageKeyProvider implements ContentKeyProvider {
  private key?: Buffer;

  constructor(
    private readonly keyPath: string,
    private readonly protector: StringProtector
  ) {}

  async getKey(): Promise<Buffer> {
    if (this.key) {
      return this.key;
    }

    if (!this.protector.isEncryptionAvailable()) {
      throw new Error("System encryption is not available.");
    }

    try {
      const encrypted = await readFile(this.keyPath);
      this.key = Buffer.from(this.protector.decryptString(encrypted), "base64");
      return this.key;
    } catch {
      this.key = randomBytes(KEY_BYTES);
      await mkdir(dirname(this.keyPath), { recursive: true });
      await writeFile(this.keyPath, this.protector.encryptString(this.key.toString("base64")));
      return this.key;
    }
  }
}

export class FileContentVault {
  constructor(
    private readonly rootDir: string,
    private readonly keyProvider: ContentKeyProvider
  ) {}

  async write(id: string, data: Buffer): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.pathFor(id), await encrypt(data, await this.keyProvider.getKey()));
  }

  async read(id: string): Promise<Buffer> {
    return decrypt(await this.readRaw(id), await this.keyProvider.getKey());
  }

  async readRaw(id: string): Promise<Buffer> {
    return readFile(this.pathFor(id));
  }

  async delete(id: string): Promise<void> {
    await rm(this.pathFor(id), { force: true });
  }

  private pathFor(id: string): string {
    return join(this.rootDir, `${safeId(id)}.bin`);
  }
}

async function encrypt(data: Buffer, key: Buffer): Promise<Buffer> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, encrypted]);
}

async function decrypt(payload: Buffer, key: Buffer): Promise<Buffer> {
  if (payload.subarray(0, MAGIC.length).equals(MAGIC) === false) {
    throw new Error("Invalid encrypted payload.");
  }

  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const dataStart = tagStart + TAG_BYTES;
  const iv = payload.subarray(ivStart, tagStart);
  const tag = payload.subarray(tagStart, dataStart);
  const encrypted = payload.subarray(dataStart);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
