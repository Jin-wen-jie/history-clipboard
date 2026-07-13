import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "../../shared/types";
import { migrateSettings, type InstallationEvidence } from "./settingsMigration";

const noEvidence = (): InstallationEvidence => ({
  settingsExists: false,
  settingsCorrupt: false,
  historyExists: false,
  vaultKeyExists: false,
  contentExists: false
});

const oldEvidence = (): InstallationEvidence => ({
  settingsExists: true,
  settingsCorrupt: false,
  historyExists: true,
  vaultKeyExists: true,
  contentExists: true
});

type MigrationCase = readonly [
  name: string,
  raw: Partial<AppSettings> | undefined,
  evidence: InstallationEvidence,
  launchAtStartup: boolean,
  startupDecisionVersion: number
];

const migrationCases: MigrationCase[] = [
  ["new install", undefined, noEvidence(), true, 1],
  ["legacy enabled", { launchAtStartup: true }, oldEvidence(), true, 1],
  ["legacy disabled", { launchAtStartup: false }, oldEvidence(), false, 0],
  ["legacy missing flag", { captureEnabled: true }, oldEvidence(), false, 0],
  ["corrupt settings with history", undefined, { ...oldEvidence(), settingsCorrupt: true }, false, 0],
  ["decided disabled", { launchAtStartup: false, startupDecisionVersion: 1 }, oldEvidence(), false, 1]
];

describe("migrateSettings", () => {
  test.each(migrationCases)(
    "migrates %s",
    (_name, raw, evidence, launchAtStartup, startupDecisionVersion) => {
      expect(migrateSettings(raw, evidence)).toMatchObject({
        launchAtStartup,
        startupDecisionVersion
      });
    }
  );

  test.each([
    ["enabled", true],
    ["disabled", false],
    ["missing", undefined]
  ] as const)("disables sensitive filtering for legacy settings with the flag %s", (_name, value) => {
    expect(migrateSettings({ sensitiveFilterEnabled: value }, oldEvidence()).sensitiveFilterEnabled).toBe(false);
  });

  test.each([true, false])("preserves sensitive filtering set to %s for version 1", (sensitiveFilterEnabled) => {
    expect(migrateSettings({
      launchAtStartup: false,
      startupDecisionVersion: 1,
      sensitiveFilterEnabled
    }, oldEvidence()).sensitiveFilterEnabled).toBe(sensitiveFilterEnabled);
  });

  test("preserves compatible settings without letting undefined replace defaults", () => {
    const migrated = migrateSettings({
      captureEnabled: false,
      maxItems: 123,
      retentionDays: 14,
      maxTextLength: undefined,
      maxImageBytes: 2_048,
      hotkey: "Ctrl+Shift+V",
      launchAtStartup: true,
      sensitiveFilterEnabled: true
    }, oldEvidence());

    expect(migrated).toMatchObject({
      captureEnabled: false,
      maxItems: 123,
      retentionDays: 14,
      maxTextLength: DEFAULT_SETTINGS.maxTextLength,
      maxImageBytes: 2_048,
      hotkey: "Ctrl+Shift+V",
      launchAtStartup: true,
      startupDecisionVersion: 1,
      sensitiveFilterEnabled: false
    });
  });
});
