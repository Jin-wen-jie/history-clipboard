import { describe, expect, test } from "vitest";
import { toIsoTime } from "./timeFilters";

describe("toIsoTime", () => {
  test("returns undefined for an empty value", () => {
    expect(toIsoTime("")).toBeUndefined();
  });

  test("returns undefined for an invalid or partially typed value", () => {
    expect(toIsoTime("2026-06-")).toBeUndefined();
    expect(toIsoTime("not-a-date")).toBeUndefined();
  });

  test("converts a valid datetime-local value to ISO", () => {
    expect(toIsoTime("2026-06-23T12:30")).toBe(new Date("2026-06-23T12:30").toISOString());
  });
});
