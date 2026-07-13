export type SequenceChange =
  | { kind: "duplicate"; delta: number }
  | { kind: "next"; delta: number }
  | { kind: "gap"; delta: number }
  | { kind: "stale"; delta: number };

export function classifySequence(previous: number, next: number): SequenceChange {
  if (!isUint32(previous) || !isUint32(next)) {
    throw new Error("Invalid sequence");
  }
  const delta = (next - previous) >>> 0;
  if (delta === 0) return { kind: "duplicate", delta };
  if (delta === 1) return { kind: "next", delta };
  if (delta < 0x8000_0000) return { kind: "gap", delta };
  return { kind: "stale", delta };
}

function isUint32(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}
