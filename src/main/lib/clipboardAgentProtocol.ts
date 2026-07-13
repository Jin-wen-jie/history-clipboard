/**
 * Maximum frameLength: excludes the outer 4-byte length prefix and includes
 * the 4-byte headerLength field, UTF-8 JSON header, and payload. Writers and
 * queues must apply this limit to that entire encoded span after the prefix.
 */
export const MAX_AGENT_FRAME_LENGTH = 64 * 1024 * 1024;

const MAX_INT32 = 0x7fff_ffff;

// All `at` and `capturedAt` fields are Unix epoch milliseconds.

export type AgentFrameHeader =
  | { version: 1; type: "ready"; pid: number; sequence: number; at: number }
  | { version: 1; type: "heartbeat"; sequence: number; at: number }
  | {
      version: 1;
      type: "snapshot";
      sequence: number;
      capturedAt: number;
      text?: { offset: number; length: number };
      png?: { offset: number; length: number; width: number; height: number };
    }
  | {
      version: 1;
      type: "gap";
      reason: "sequence-advanced" | "overflow" | "clipboard-busy";
      fromSequence?: number;
      toSequence: number;
      dropped: number;
      at: number;
    }
  | {
      version: 1;
      type: "error";
      code: "too-large" | "clipboard-busy" | "listener-failed" | "internal";
      sequence?: number;
      at: number;
    };

export type NativeClipboardSnapshot = {
  version: 1;
  type: "snapshot";
  sequence: number;
  capturedAt: number;
  text: string;
  png?: Buffer;
  width?: number;
  height?: number;
};

export type AgentControlFrame = Extract<
  AgentFrameHeader,
  { type: "ready" | "heartbeat" | "gap" | "error" }
>;

export type AgentFrame = AgentControlFrame | NativeClipboardSnapshot;

type JsonObject = Record<string, unknown>;
type SnapshotHeader = Extract<AgentFrameHeader, { type: "snapshot" }>;
type TextSegment = NonNullable<SnapshotHeader["text"]>;
type PngSegment = NonNullable<SnapshotHeader["png"]>;

const GAP_REASONS = new Set(["sequence-advanced", "overflow", "clipboard-busy"]);
const ERROR_CODES = new Set(["too-large", "clipboard-busy", "listener-failed", "internal"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

function isPositiveInt32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_INT32;
}

function isNonNegativeInt32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_INT32;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Error("Invalid UTF-8");
  }
}

function parseJsonHeader(bytes: Buffer): unknown {
  const json = decodeUtf8(bytes);
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new Error("Invalid header JSON");
  }
}

function invalidHeader(): never {
  throw new Error("Invalid frame header");
}

function validateTextSegment(value: unknown): TextSegment {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["offset", "length"]) ||
    !isNonNegativeSafeInteger(value.offset) ||
    !isNonNegativeSafeInteger(value.length)
  ) {
    return invalidHeader();
  }
  return { offset: value.offset, length: value.length };
}

function validatePngSegment(value: unknown): PngSegment {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["offset", "length", "width", "height"]) ||
    !isNonNegativeSafeInteger(value.offset) ||
    !isNonNegativeSafeInteger(value.length) ||
    !isPositiveInt32(value.width) ||
    !isPositiveInt32(value.height)
  ) {
    return invalidHeader();
  }
  return {
    offset: value.offset,
    length: value.length,
    width: value.width,
    height: value.height
  };
}

function validateHeader(value: unknown): AgentFrameHeader {
  if (!isObject(value) || value.version !== 1 || typeof value.type !== "string") {
    return invalidHeader();
  }

  switch (value.type) {
    case "ready":
      if (
        !hasOnlyKeys(value, ["version", "type", "pid", "sequence", "at"]) ||
        !isPositiveInt32(value.pid) ||
        !isUint32(value.sequence) ||
        !isTimestamp(value.at)
      ) {
        return invalidHeader();
      }
      return { version: 1, type: "ready", pid: value.pid, sequence: value.sequence, at: value.at };

    case "heartbeat":
      if (
        !hasOnlyKeys(value, ["version", "type", "sequence", "at"]) ||
        !isUint32(value.sequence) ||
        !isTimestamp(value.at)
      ) {
        return invalidHeader();
      }
      return { version: 1, type: "heartbeat", sequence: value.sequence, at: value.at };

    case "snapshot": {
      if (
        !hasOnlyKeys(value, ["version", "type", "sequence", "capturedAt", "text", "png"]) ||
        !isUint32(value.sequence) ||
        !isTimestamp(value.capturedAt)
      ) {
        return invalidHeader();
      }
      const header: SnapshotHeader = {
        version: 1,
        type: "snapshot",
        sequence: value.sequence,
        capturedAt: value.capturedAt
      };
      if (Object.hasOwn(value, "text")) {
        header.text = validateTextSegment(value.text);
      }
      if (Object.hasOwn(value, "png")) {
        header.png = validatePngSegment(value.png);
      }
      return header;
    }

    case "gap":
      if (
        !hasOnlyKeys(value, ["version", "type", "reason", "fromSequence", "toSequence", "dropped", "at"]) ||
        typeof value.reason !== "string" ||
        !GAP_REASONS.has(value.reason) ||
        (Object.hasOwn(value, "fromSequence") && !isUint32(value.fromSequence)) ||
        !isUint32(value.toSequence) ||
        !isNonNegativeInt32(value.dropped) ||
        !isTimestamp(value.at)
      ) {
        return invalidHeader();
      }
      return Object.hasOwn(value, "fromSequence")
        ? {
            version: 1,
            type: "gap",
            reason: value.reason as Extract<AgentFrameHeader, { type: "gap" }>["reason"],
            fromSequence: value.fromSequence as number,
            toSequence: value.toSequence,
            dropped: value.dropped,
            at: value.at
          }
        : {
            version: 1,
            type: "gap",
            reason: value.reason as Extract<AgentFrameHeader, { type: "gap" }>["reason"],
            toSequence: value.toSequence,
            dropped: value.dropped,
            at: value.at
          };

    case "error":
      if (
        !hasOnlyKeys(value, ["version", "type", "code", "sequence", "at"]) ||
        typeof value.code !== "string" ||
        !ERROR_CODES.has(value.code) ||
        (Object.hasOwn(value, "sequence") && !isUint32(value.sequence)) ||
        !isTimestamp(value.at)
      ) {
        return invalidHeader();
      }
      return Object.hasOwn(value, "sequence")
        ? {
            version: 1,
            type: "error",
            code: value.code as Extract<AgentFrameHeader, { type: "error" }>["code"],
            sequence: value.sequence as number,
            at: value.at
          }
        : {
            version: 1,
            type: "error",
            code: value.code as Extract<AgentFrameHeader, { type: "error" }>["code"],
            at: value.at
          };

    default:
      return invalidHeader();
  }
}

function parseFrame(header: AgentFrameHeader, payload: Buffer): AgentFrame {
  if (header.type !== "snapshot") {
    if (payload.length !== 0) {
      throw new Error("Invalid frame payload");
    }
    return header;
  }

  const segments: Array<{ offset: number; length: number }> = [];
  if (header.text) segments.push(header.text);
  if (header.png) segments.push(header.png);
  for (const segment of segments) {
    if (segment.offset > payload.length || segment.length > payload.length - segment.offset) {
      throw new Error("Invalid frame payload");
    }
  }
  segments.sort((left, right) => left.offset - right.offset);

  let payloadOffset = 0;
  for (const segment of segments) {
    if (segment.offset !== payloadOffset) {
      throw new Error("Invalid frame payload");
    }
    payloadOffset = segment.offset + segment.length;
  }
  if (payloadOffset !== payload.length) {
    throw new Error("Invalid frame payload");
  }

  const snapshot: NativeClipboardSnapshot = {
    version: 1,
    type: "snapshot",
    sequence: header.sequence,
    capturedAt: header.capturedAt,
    text: header.text
      ? decodeUtf8(payload.subarray(header.text.offset, header.text.offset + header.text.length))
      : ""
  };
  if (header.png) {
    snapshot.png = Buffer.from(payload.subarray(header.png.offset, header.png.offset + header.png.length));
    snapshot.width = header.png.width;
    snapshot.height = header.png.height;
  }
  return snapshot;
}

export class ClipboardAgentFrameParser {
  private chunks: Buffer[] = [];
  private headIndex = 0;
  private headOffset = 0;
  private bufferedBytes = 0;

  /** Retains chunk references; callers must not mutate a chunk after push. */
  push(chunk: Buffer): AgentFrame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.bufferedBytes += chunk.length;
    }

    const frames: AgentFrame[] = [];
    try {
      while (this.bufferedBytes >= 4) {
        const frameLength = this.peekUInt32LE(0);
        if (frameLength < 4) {
          throw new Error("Invalid frame length");
        }
        if (frameLength > MAX_AGENT_FRAME_LENGTH) {
          throw new Error("Frame too large");
        }

        const totalLength = 4 + frameLength;
        if (this.bufferedBytes < 8) {
          break;
        }

        const headerLength = this.peekUInt32LE(4);
        if (headerLength > frameLength - 4) {
          throw new Error("Invalid header length");
        }
        if (this.bufferedBytes < totalLength) {
          break;
        }

        const encodedFrame = this.takeBytes(totalLength);
        const headerEnd = 8 + headerLength;
        const header = validateHeader(parseJsonHeader(encodedFrame.subarray(8, headerEnd)));
        const payload = encodedFrame.subarray(headerEnd, totalLength);
        frames.push(parseFrame(header, payload));
      }
      return frames;
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  finish(): void {
    if (this.bufferedBytes === 0) return;
    this.reset();
    throw new Error("Incomplete frame");
  }

  reset(): void {
    this.chunks = [];
    this.headIndex = 0;
    this.headOffset = 0;
    this.bufferedBytes = 0;
  }

  private peekUInt32LE(relativeOffset: number): number {
    let chunkIndex = this.headIndex;
    let chunkOffset = this.headOffset;
    let value = 0;

    for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
      while (chunkOffset === this.chunks[chunkIndex].length) {
        chunkIndex += 1;
        chunkOffset = 0;
      }
      if (relativeOffset > 0) {
        relativeOffset -= 1;
        chunkOffset += 1;
        byteIndex -= 1;
        continue;
      }
      value += this.chunks[chunkIndex][chunkOffset] * (2 ** (byteIndex * 8));
      chunkOffset += 1;
    }
    return value >>> 0;
  }

  private takeBytes(length: number): Buffer {
    const head = this.chunks[this.headIndex];
    const headAvailable = head.length - this.headOffset;
    if (headAvailable >= length) {
      const result = head.subarray(this.headOffset, this.headOffset + length);
      this.headOffset += length;
      this.bufferedBytes -= length;
      if (this.headOffset === head.length) {
        this.headIndex += 1;
        this.headOffset = 0;
      }
      this.compactChunks();
      return result;
    }

    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const current = this.chunks[this.headIndex];
      const copyLength = Math.min(current.length - this.headOffset, length - written);
      current.copy(result, written, this.headOffset, this.headOffset + copyLength);
      written += copyLength;
      this.headOffset += copyLength;
      this.bufferedBytes -= copyLength;
      if (this.headOffset === current.length) {
        this.headIndex += 1;
        this.headOffset = 0;
      }
    }
    this.compactChunks();
    return result;
  }

  private compactChunks(): void {
    if (this.headIndex === this.chunks.length) {
      this.chunks = [];
      this.headIndex = 0;
      return;
    }
    if (this.headIndex > 0 && this.headIndex * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.headIndex);
      this.headIndex = 0;
    }
  }
}
