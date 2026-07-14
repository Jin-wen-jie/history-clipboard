import { describe, expect, test } from "vitest";
import { requireBoolean, sanitizeEditableSettingsPatch } from "./editableSettingsPatch";

describe("sanitizeEditableSettingsPatch", () => {
  test("keeps only editable settings with valid runtime value types", () => {
    expect(sanitizeEditableSettingsPatch({
      captureEnabled: false,
      maxItems: 800,
      retentionDays: 45,
      maxTextLength: 30_000,
      maxImageBytes: 20 * 1024 * 1024,
      hotkey: "Ctrl+Shift+V",
      sensitiveFilterEnabled: true,
      launchAtStartup: true,
      startupDecisionVersion: 99,
      unknownSetting: "blocked"
    })).toEqual({
      captureEnabled: false,
      maxItems: 800,
      retentionDays: 45,
      maxTextLength: 30_000,
      maxImageBytes: 20 * 1024 * 1024,
      hotkey: "Ctrl+Shift+V",
      sensitiveFilterEnabled: true
    });
  });

  test.each([
    undefined,
    null,
    false,
    "settings",
    [],
    { captureEnabled: "false", maxItems: Number.NaN, hotkey: 42 }
  ])("rejects an invalid settings payload %#", (payload) => {
    expect(sanitizeEditableSettingsPatch(payload)).toEqual({});
  });

  test("drops numeric values outside the supported capture limits", () => {
    expect(sanitizeEditableSettingsPatch({
      maxItems: 9,
      retentionDays: 0,
      maxTextLength: 0,
      maxImageBytes: 0
    })).toEqual({});
    expect(sanitizeEditableSettingsPatch({
      maxItems: 10.5,
      retentionDays: 365.5,
      maxTextLength: 1.5,
      maxImageBytes: 50 * 1024 * 1024 + 1
    })).toEqual({});
  });

  test("caps text limits at the supported maximum", () => {
    expect(sanitizeEditableSettingsPatch({ maxTextLength: 5_000_000 })).toEqual({
      maxTextLength: 5_000_000
    });
    expect(sanitizeEditableSettingsPatch({ maxTextLength: 5_000_001 })).toEqual({});
  });

  test("requires a real boolean for the dedicated startup IPC", () => {
    expect(() => requireBoolean("false", "startup enabled")).toThrow("startup enabled");
    expect(() => requireBoolean(undefined, "startup enabled")).toThrow("startup enabled");
  });
});
