import { describe, expect, test } from "vitest";
import {
  ClipboardAgentFrameParser,
  type AgentFrameHeader,
  type NativeClipboardSnapshot
} from "./clipboardAgentProtocol";

const MAX_FRAME_LENGTH = 64 * 1024 * 1024;

function encodeFrame(header: AgentFrameHeader, payload = Buffer.alloc(0)): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const frameLength = 4 + headerBytes.length + payload.length;
  const result = Buffer.allocUnsafe(4 + frameLength);
  result.writeUInt32LE(frameLength, 0);
  result.writeUInt32LE(headerBytes.length, 4);
  headerBytes.copy(result, 8);
  payload.copy(result, 8 + headerBytes.length);
  return result;
}

function encodeRawFrame(headerBytes: Buffer, payload = Buffer.alloc(0)): Buffer {
  const frameLength = 4 + headerBytes.length + payload.length;
  const result = Buffer.allocUnsafe(4 + frameLength);
  result.writeUInt32LE(frameLength, 0);
  result.writeUInt32LE(headerBytes.length, 4);
  headerBytes.copy(result, 8);
  payload.copy(result, 8 + headerBytes.length);
  return result;
}

function asHeader(value: unknown): AgentFrameHeader {
  return value as AgentFrameHeader;
}

function expectInvalidHeader(value: unknown): void {
  const parser = new ClipboardAgentFrameParser();
  expect(() => parser.push(encodeFrame(asHeader(value)))).toThrow("Invalid frame header");
}

function snapshotHeader(overrides: Record<string, unknown> = {}): AgentFrameHeader {
  return asHeader({
    version: 1,
    type: "snapshot",
    sequence: 12,
    capturedAt: 1_783_828_800_000,
    ...overrides
  });
}

describe("ClipboardAgentFrameParser", () => {
  test("parses multiple control frames from one chunk", () => {
    const headers: AgentFrameHeader[] = [
      { version: 1, type: "ready", pid: 42, sequence: 8, at: 1_000 },
      { version: 1, type: "heartbeat", sequence: 9, at: 1_001 },
      {
        version: 1,
        type: "gap",
        reason: "overflow",
        fromSequence: 9,
        toSequence: 12,
        dropped: 2,
        at: 1_002
      },
      { version: 1, type: "error", code: "clipboard-busy", sequence: 12, at: 1_003 }
    ];
    const parser = new ClipboardAgentFrameParser();

    expect(parser.push(Buffer.concat(headers.map((header) => encodeFrame(header))))).toEqual(headers);
  });

  test("accepts every fixed gap reason and error code", () => {
    const headers: AgentFrameHeader[] = [
      ...(["sequence-advanced", "overflow", "clipboard-busy"] as const).map((reason) => ({
        version: 1 as const,
        type: "gap" as const,
        reason,
        toSequence: 1,
        dropped: 0,
        at: 0
      })),
      ...(["too-large", "clipboard-busy", "listener-failed", "internal"] as const).map((code) => ({
        version: 1 as const,
        type: "error" as const,
        code,
        at: 0
      }))
    ];
    const parser = new ClipboardAgentFrameParser();

    expect(parser.push(Buffer.concat(headers.map((header) => encodeFrame(header))))).toEqual(headers);
  });

  test("parses text and png from a fragmented snapshot frame", () => {
    const text = Buffer.from("hello", "utf8");
    const png = Buffer.from([137, 80, 78, 71]);
    const payload = Buffer.concat([text, png]);
    const encoded = encodeFrame({
      version: 1,
      type: "snapshot",
      sequence: 12,
      capturedAt: 1_783_828_800_000,
      text: { offset: 0, length: text.length },
      png: { offset: text.length, length: png.length, width: 1, height: 1 }
    }, payload);
    const parser = new ClipboardAgentFrameParser();

    expect(parser.push(encoded.subarray(0, 7))).toEqual([]);
    expect(parser.push(encoded.subarray(7))).toEqual([{
      version: 1,
      type: "snapshot",
      sequence: 12,
      capturedAt: 1_783_828_800_000,
      text: "hello",
      png,
      width: 1,
      height: 1
    }]);
  });

  test("parses a frame pushed one byte at a time", () => {
    const header: AgentFrameHeader = {
      version: 1,
      type: "heartbeat",
      sequence: 0xffff_ffff,
      at: 1_783_828_800_000
    };
    const encoded = encodeFrame(header);
    const parser = new ClipboardAgentFrameParser();
    const frames = [];
    for (const byte of encoded) {
      frames.push(...parser.push(Buffer.from([byte])));
    }

    expect(frames).toEqual([header]);
  });

  test("retains incomplete length, header-length, and frame data", () => {
    const header: AgentFrameHeader = { version: 1, type: "heartbeat", sequence: 7, at: 8 };
    const encoded = encodeFrame(header);

    for (const split of [3, 6, encoded.length - 1]) {
      const parser = new ClipboardAgentFrameParser();
      expect(parser.push(encoded.subarray(0, split))).toEqual([]);
      expect(parser.push(encoded.subarray(split))).toEqual([header]);
    }
  });

  test("parses text-only, image-only, and empty snapshots", () => {
    const text = Buffer.from("plain text", "utf8");
    const png = Buffer.from([1, 2, 3]);
    const frames = [
      encodeFrame(snapshotHeader({ text: { offset: 0, length: text.length } }), text),
      encodeFrame(snapshotHeader({ sequence: 13, png: { offset: 0, length: png.length, width: 4, height: 3 } }), png),
      encodeFrame(snapshotHeader({ sequence: 14 }))
    ];
    const parser = new ClipboardAgentFrameParser();

    expect(parser.push(Buffer.concat(frames))).toEqual([
      {
        version: 1,
        type: "snapshot",
        sequence: 12,
        capturedAt: 1_783_828_800_000,
        text: "plain text"
      },
      {
        version: 1,
        type: "snapshot",
        sequence: 13,
        capturedAt: 1_783_828_800_000,
        text: "",
        png,
        width: 4,
        height: 3
      },
      {
        version: 1,
        type: "snapshot",
        sequence: 14,
        capturedAt: 1_783_828_800_000,
        text: ""
      }
    ] satisfies NativeClipboardSnapshot[]);
  });

  test("copies parsed png bytes away from source and parser buffers", () => {
    const png = Buffer.from([137, 80, 78, 71]);
    const encoded = encodeFrame(snapshotHeader({
      png: { offset: 0, length: png.length, width: 1, height: 1 }
    }), png);
    const parser = new ClipboardAgentFrameParser();
    const [snapshot] = parser.push(encoded) as NativeClipboardSnapshot[];

    encoded.fill(0);
    parser.push(encodeFrame({ version: 1, type: "heartbeat", sequence: 13, at: 1 }).subarray(0, 5));
    parser.reset();

    expect(snapshot.png).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  test("reset discards an incomplete frame", () => {
    const first = encodeFrame({ version: 1, type: "heartbeat", sequence: 1, at: 1 });
    const secondHeader: AgentFrameHeader = { version: 1, type: "heartbeat", sequence: 2, at: 2 };
    const second = encodeFrame(secondHeader);
    const parser = new ClipboardAgentFrameParser();

    expect(parser.push(first.subarray(0, 5))).toEqual([]);
    parser.reset();

    expect(parser.push(second)).toEqual([secondHeader]);
  });

  test("rejects a frame length below the header-length field", () => {
    const encoded = Buffer.alloc(4);
    encoded.writeUInt32LE(3, 0);

    expect(() => new ClipboardAgentFrameParser().push(encoded)).toThrow("Invalid frame length");
  });

  test("rejects a frame length above 64 MiB from the prefix alone", () => {
    const encoded = Buffer.alloc(4);
    encoded.writeUInt32LE(MAX_FRAME_LENGTH + 1, 0);

    expect(() => new ClipboardAgentFrameParser().push(encoded)).toThrow("Frame too large");
  });

  test("accepts a structurally valid frame whose frameLength is exactly 64 MiB", () => {
    let payloadLength = MAX_FRAME_LENGTH - 4;
    let header = snapshotHeader({ png: { offset: 0, length: payloadLength, width: 1, height: 1 } });
    let headerBytes = Buffer.from(JSON.stringify(header), "utf8");

    while (payloadLength !== MAX_FRAME_LENGTH - 4 - headerBytes.length) {
      payloadLength = MAX_FRAME_LENGTH - 4 - headerBytes.length;
      header = snapshotHeader({ png: { offset: 0, length: payloadLength, width: 1, height: 1 } });
      headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    }

    const encoded = Buffer.alloc(4 + MAX_FRAME_LENGTH);
    encoded.writeUInt32LE(MAX_FRAME_LENGTH, 0);
    encoded.writeUInt32LE(headerBytes.length, 4);
    headerBytes.copy(encoded, 8);

    const [snapshot] = new ClipboardAgentFrameParser().push(encoded) as NativeClipboardSnapshot[];
    expect(snapshot.png?.length).toBe(payloadLength);
  });

  test("rejects a header length outside its frame", () => {
    const encoded = Buffer.alloc(8);
    encoded.writeUInt32LE(4, 0);
    encoded.writeUInt32LE(1, 4);

    expect(() => new ClipboardAgentFrameParser().push(encoded)).toThrow("Invalid header length");
  });

  test("rejects invalid JSON and non-object JSON", () => {
    expect(() => new ClipboardAgentFrameParser().push(encodeRawFrame(Buffer.from("{", "utf8"))))
      .toThrow("Invalid header JSON");

    for (const value of [null, [], "heartbeat", 1]) {
      expectInvalidHeader(value);
    }
  });

  test("strictly rejects non-UTF-8 header and text bytes", () => {
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    expect(() => new ClipboardAgentFrameParser().push(encodeRawFrame(invalidUtf8)))
      .toThrow("Invalid UTF-8");

    const invalidText = encodeFrame(snapshotHeader({ text: { offset: 0, length: invalidUtf8.length } }), invalidUtf8);
    expect(() => new ClipboardAgentFrameParser().push(invalidText)).toThrow("Invalid UTF-8");
  });

  test("rejects unknown versions and frame types", () => {
    expectInvalidHeader({ version: 2, type: "heartbeat", sequence: 1, at: 1 });
    expectInvalidHeader({ version: 1, type: "unknown", sequence: 1, at: 1 });
  });

  test.each([
    ["missing version", { type: "heartbeat", sequence: 1, at: 1 }],
    ["non-numeric version", { version: "1", type: "heartbeat", sequence: 1, at: 1 }],
    ["missing type", { version: 1, sequence: 1, at: 1 }],
    ["non-string type", { version: 1, type: 1, sequence: 1, at: 1 }],
    ["missing ready pid", { version: 1, type: "ready", sequence: 1, at: 1 }],
    ["zero ready pid", { version: 1, type: "ready", pid: 0, sequence: 1, at: 1 }],
    ["fractional ready pid", { version: 1, type: "ready", pid: 1.5, sequence: 1, at: 1 }],
    ["string ready pid", { version: 1, type: "ready", pid: "1", sequence: 1, at: 1 }],
    ["missing ready sequence", { version: 1, type: "ready", pid: 1, at: 1 }],
    ["negative ready sequence", { version: 1, type: "ready", pid: 1, sequence: -1, at: 1 }],
    ["overflow ready sequence", { version: 1, type: "ready", pid: 1, sequence: 0x1_0000_0000, at: 1 }],
    ["fractional heartbeat sequence", { version: 1, type: "heartbeat", sequence: 1.5, at: 1 }],
    ["string heartbeat sequence", { version: 1, type: "heartbeat", sequence: "1", at: 1 }],
    ["missing heartbeat at", { version: 1, type: "heartbeat", sequence: 1 }],
    ["negative ready at", { version: 1, type: "ready", pid: 1, sequence: 1, at: -1 }],
    ["fractional heartbeat at", { version: 1, type: "heartbeat", sequence: 1, at: 1.5 }],
    ["unsafe heartbeat at", { version: 1, type: "heartbeat", sequence: 1, at: Number.MAX_SAFE_INTEGER + 1 }],
    ["string heartbeat at", { version: 1, type: "heartbeat", sequence: 1, at: "1" }],
    ["missing snapshot sequence", { version: 1, type: "snapshot", capturedAt: 1 }],
    ["missing capturedAt", { version: 1, type: "snapshot", sequence: 1 }],
    ["negative capturedAt", { version: 1, type: "snapshot", sequence: 1, capturedAt: -1 }],
    ["fractional capturedAt", { version: 1, type: "snapshot", sequence: 1, capturedAt: 1.5 }],
    ["unsafe capturedAt", { version: 1, type: "snapshot", sequence: 1, capturedAt: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing gap reason", { version: 1, type: "gap", toSequence: 1, dropped: 0, at: 1 }],
    ["unknown gap reason", { version: 1, type: "gap", reason: "unknown", toSequence: 1, dropped: 0, at: 1 }],
    ["missing gap toSequence", { version: 1, type: "gap", reason: "overflow", dropped: 0, at: 1 }],
    ["invalid gap toSequence", { version: 1, type: "gap", reason: "overflow", toSequence: -1, dropped: 0, at: 1 }],
    ["invalid optional fromSequence", { version: 1, type: "gap", reason: "overflow", fromSequence: 1.5, toSequence: 1, dropped: 0, at: 1 }],
    ["missing dropped", { version: 1, type: "gap", reason: "overflow", toSequence: 1, at: 1 }],
    ["negative dropped", { version: 1, type: "gap", reason: "overflow", toSequence: 1, dropped: -1, at: 1 }],
    ["fractional dropped", { version: 1, type: "gap", reason: "overflow", toSequence: 1, dropped: 0.5, at: 1 }],
    ["missing gap at", { version: 1, type: "gap", reason: "overflow", toSequence: 1, dropped: 0 }],
    ["missing error code", { version: 1, type: "error", at: 1 }],
    ["unknown error code", { version: 1, type: "error", code: "unknown", at: 1 }],
    ["invalid optional error sequence", { version: 1, type: "error", code: "internal", sequence: null, at: 1 }],
    ["missing error at", { version: 1, type: "error", code: "internal" }],
    ["unknown header field", { version: 1, type: "heartbeat", sequence: 1, at: 1, detail: "secret" }]
  ])("rejects invalid required or enum field: %s", (_name, header) => {
    expectInvalidHeader(header);
  });

  test.each([
    ["non-object text", { text: "text" }],
    ["missing text offset", { text: { length: 0 } }],
    ["missing text length", { text: { offset: 0 } }],
    ["negative text offset", { text: { offset: -1, length: 0 } }],
    ["fractional text offset", { text: { offset: 0.5, length: 0 } }],
    ["negative text length", { text: { offset: 0, length: -1 } }],
    ["fractional text length", { text: { offset: 0, length: 0.5 } }],
    ["extra text field", { text: { offset: 0, length: 0, encoding: "utf8" } }],
    ["non-object png", { png: [] }],
    ["missing png offset", { png: { length: 0, width: 1, height: 1 } }],
    ["missing png length", { png: { offset: 0, width: 1, height: 1 } }],
    ["negative png offset", { png: { offset: -1, length: 0, width: 1, height: 1 } }],
    ["fractional png offset", { png: { offset: 0.5, length: 0, width: 1, height: 1 } }],
    ["negative png length", { png: { offset: 0, length: -1, width: 1, height: 1 } }],
    ["fractional png length", { png: { offset: 0, length: 0.5, width: 1, height: 1 } }],
    ["zero png width", { png: { offset: 0, length: 0, width: 0, height: 1 } }],
    ["fractional png width", { png: { offset: 0, length: 0, width: 1.5, height: 1 } }],
    ["zero png height", { png: { offset: 0, length: 0, width: 1, height: 0 } }],
    ["fractional png height", { png: { offset: 0, length: 0, width: 1, height: 1.5 } }],
    ["extra png field", { png: { offset: 0, length: 0, width: 1, height: 1, format: "png" } }]
  ])("rejects invalid snapshot segment field: %s", (_name, overrides) => {
    expectInvalidHeader({
      version: 1,
      type: "snapshot",
      sequence: 1,
      capturedAt: 1,
      ...overrides
    });
  });

  test.each([
    ["segment offset out of bounds", { text: { offset: 2, length: 0 } }, Buffer.from([1])],
    ["segment length out of bounds", { text: { offset: 0, length: 2 } }, Buffer.from([1])],
    ["segments overlap", {
      text: { offset: 0, length: 2 },
      png: { offset: 1, length: 2, width: 1, height: 1 }
    }, Buffer.from([1, 2, 3])],
    ["leading gap", { text: { offset: 1, length: 1 } }, Buffer.from([1, 2])],
    ["middle gap", {
      text: { offset: 0, length: 1 },
      png: { offset: 2, length: 1, width: 1, height: 1 }
    }, Buffer.from([1, 2, 3])],
    ["undeclared tail", { text: { offset: 0, length: 1 } }, Buffer.from([1, 2])],
    ["entirely undeclared payload", {}, Buffer.from([1])]
  ])("rejects invalid snapshot payload layout: %s", (_name, overrides, payload) => {
    const parser = new ClipboardAgentFrameParser();
    expect(() => parser.push(encodeFrame(snapshotHeader(overrides), payload))).toThrow("Invalid frame payload");
  });

  test("rejects payload on every control frame type", () => {
    const headers: AgentFrameHeader[] = [
      { version: 1, type: "ready", pid: 1, sequence: 1, at: 1 },
      { version: 1, type: "heartbeat", sequence: 1, at: 1 },
      { version: 1, type: "gap", reason: "overflow", toSequence: 1, dropped: 1, at: 1 },
      { version: 1, type: "error", code: "internal", at: 1 }
    ];

    for (const header of headers) {
      expect(() => new ClipboardAgentFrameParser().push(encodeFrame(header, Buffer.from([1]))))
        .toThrow("Invalid frame payload");
    }
  });

  test("clears parser state after a malformed complete frame", () => {
    const parser = new ClipboardAgentFrameParser();
    const goodHeader: AgentFrameHeader = { version: 1, type: "heartbeat", sequence: 99, at: 10 };

    expect(() => parser.push(encodeRawFrame(Buffer.from("{", "utf8")))).toThrow("Invalid header JSON");
    expect(parser.push(encodeFrame(goodHeader))).toEqual([goodHeader]);
  });
});
