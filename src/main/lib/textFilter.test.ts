import { describe, expect, test } from "vitest";
import { shouldRecordText } from "./textFilter";

describe("shouldRecordText", () => {
  test("rejects blank text", () => {
    expect(shouldRecordText("   ", { maxTextLength: 20_000, sensitiveFilterEnabled: true })).toEqual({
      ok: false,
      reason: "blank"
    });
  });

  test("rejects text longer than the configured limit", () => {
    expect(shouldRecordText("abcdef", { maxTextLength: 5, sensitiveFilterEnabled: true })).toEqual({
      ok: false,
      reason: "too-large"
    });
  });

  test("rejects likely one-time codes when sensitive filtering is enabled", () => {
    expect(shouldRecordText("492031", { maxTextLength: 20_000, sensitiveFilterEnabled: true })).toEqual({
      ok: false,
      reason: "sensitive"
    });
  });

  test("allows ordinary text", () => {
    expect(shouldRecordText("明天下午三点开会", { maxTextLength: 20_000, sensitiveFilterEnabled: true })).toEqual({
      ok: true
    });
  });
});
