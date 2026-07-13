import { describe, expect, test } from "vitest";
import { classifySequence, type SequenceChange } from "./clipboardSequence";

describe("classifySequence", () => {
  test.each<[number, number, SequenceChange]>([
    [10, 10, { kind: "duplicate", delta: 0 }],
    [10, 11, { kind: "next", delta: 1 }],
    [10, 13, { kind: "gap", delta: 3 }],
    [0xffff_ffff, 0, { kind: "next", delta: 1 }],
    [100, 99, { kind: "stale", delta: 0xffff_ffff }],
    [0, 0x8000_0000, { kind: "stale", delta: 0x8000_0000 }]
  ])("classifies uint32 change from %d to %d", (previous, next, expected) => {
    expect(classifySequence(previous, next)).toEqual(expected);
  });

  test.each([
    Number.NaN,
    -1,
    1.5,
    0x1_0000_0000,
    2 ** 53
  ])("rejects invalid uint32 sequence %s", (invalid) => {
    expect(() => classifySequence(invalid, 0)).toThrow("Invalid sequence");
    expect(() => classifySequence(0, invalid)).toThrow("Invalid sequence");
  });
});
