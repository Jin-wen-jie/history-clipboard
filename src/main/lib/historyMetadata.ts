import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

export type StoredBase = {
  id: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  copyCount: number;
};

export type StoredTextItem = StoredBase & {
  type: "text";
  contentKey: string;
};

export type StoredImageItem = StoredBase & {
  type: "image";
  contentKey: string;
  thumbnailKey: string;
  width: number;
  height: number;
  byteSize: number;
};

export type StoredItem = StoredTextItem | StoredImageItem;

export type MetadataFile = {
  version: 1;
  revision: number;
  items: StoredItem[];
};

export type MetadataLoadResult = {
  revision: number;
  items: StoredItem[];
  hadCandidates: boolean;
  validCandidate: boolean;
  recovered: boolean;
};

const candidateFiles = [
  { name: "history.json", priority: 0 },
  { name: "history.json.tmp", priority: 1 },
  { name: "history.json.bak", priority: 2 }
] as const;

type Candidate = {
  path: string;
  priority: number;
  metadata: MetadataFile;
};

type CandidateReadResult = {
  exists: boolean;
  candidate?: Candidate;
};

export class HistoryMetadataJournal {
  private revision = 0;
  private latestWrite: Promise<void> = Promise.resolve();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string) {}

  async load(): Promise<MetadataLoadResult> {
    const reads = await Promise.all(candidateFiles.map(async ({ name, priority }) => {
      return this.readCandidate(join(this.rootDir, name), priority);
    }));
    const hadCandidates = reads.some((result) => result.exists);
    const validCandidates = reads
      .map((result) => result.candidate)
      .filter((candidate): candidate is Candidate => candidate !== undefined)
      .sort((left, right) => {
        return right.metadata.revision - left.metadata.revision || left.priority - right.priority;
      });

    const selected = validCandidates[0];
    if (!selected) {
      this.revision = 0;
      return {
        revision: 0,
        items: [],
        hadCandidates,
        validCandidate: false,
        recovered: false
      };
    }

    this.revision = selected.metadata.revision;
    const recovered = selected.priority !== 0;
    if (recovered) {
      await this.promoteSnapshot(selected.metadata);
    }

    return {
      revision: selected.metadata.revision,
      items: selected.metadata.items,
      hadCandidates,
      validCandidate: true,
      recovered
    };
  }

  save(items: readonly StoredItem[]): Promise<number> {
    const snapshot: MetadataFile = {
      version: 1,
      revision: ++this.revision,
      items: structuredClone(Array.from(items))
    };
    const write = this.writeTail.then(() => this.writeSnapshot(snapshot));
    this.latestWrite = write;
    this.writeTail = write.catch(() => undefined);
    return write.then(() => snapshot.revision);
  }

  async flush(): Promise<void> {
    await this.latestWrite;
  }

  private async writeSnapshot(snapshot: MetadataFile): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await this.writeTemporarySnapshot(snapshot);

    const mainPath = join(this.rootDir, "history.json");
    const main = await this.readCandidate(mainPath, 0);
    if (main.candidate) {
      await copyFile(mainPath, join(this.rootDir, "history.json.bak"));
    }

    await rename(join(this.rootDir, "history.json.tmp"), mainPath);
  }

  private async promoteSnapshot(snapshot: MetadataFile): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await this.writeTemporarySnapshot(snapshot);
    await rename(join(this.rootDir, "history.json.tmp"), join(this.rootDir, "history.json"));
  }

  private async writeTemporarySnapshot(snapshot: MetadataFile): Promise<void> {
    const handle = await open(join(this.rootDir, "history.json.tmp"), "w");
    try {
      await handle.writeFile(JSON.stringify(snapshot), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readCandidate(path: string, priority: number): Promise<CandidateReadResult> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      const metadata = parseMetadata(parsed);
      return {
        exists: true,
        candidate: metadata ? { path, priority, metadata } : undefined
      };
    } catch (error) {
      return {
        exists: (error as NodeJS.ErrnoException).code !== "ENOENT"
      };
    }
  }
}

function parseMetadata(value: unknown): MetadataFile | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) {
    return undefined;
  }

  let revision = 0;
  if (Object.prototype.hasOwnProperty.call(value, "revision")) {
    if (!isNonNegativeInteger(value.revision)) {
      return undefined;
    }
    revision = value.revision;
  }

  if (!value.items.every(isStoredItem)) {
    return undefined;
  }

  return {
    version: 1,
    revision,
    items: value.items
  };
}

function isStoredItem(value: unknown): value is StoredItem {
  if (!isRecord(value) || !hasStoredBase(value) || typeof value.contentKey !== "string") {
    return false;
  }

  if (value.type === "text") {
    return true;
  }

  return value.type === "image"
    && typeof value.thumbnailKey === "string"
    && isNonNegativeInteger(value.width)
    && isNonNegativeInteger(value.height)
    && isNonNegativeInteger(value.byteSize);
}

function hasStoredBase(value: Record<string, unknown>): boolean {
  return typeof value.id === "string"
    && typeof value.hash === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && typeof value.pinned === "boolean"
    && isNonNegativeInteger(value.copyCount);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
