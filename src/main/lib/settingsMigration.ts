import {
  DEFAULT_SETTINGS,
  STARTUP_DECISION_VERSION,
  type AppSettings
} from "../../shared/types";

const PREVIOUS_DEFAULT_MAX_TEXT_LENGTH = 20_000;
const TEXT_LIMIT_MIGRATION_VERSION = 1;

export type InstallationEvidence = {
  settingsExists: boolean;
  settingsCorrupt: boolean;
  historyExists: boolean;
  vaultKeyExists: boolean;
  contentExists: boolean;
};

export function migrateSettings(
  raw: Partial<AppSettings> | undefined,
  evidence: InstallationEvidence
): AppSettings {
  const migrated = compatibleSettings(raw);
  migrateTextLimit(migrated, raw);
  const hasExistingEvidence = evidence.settingsExists
    || evidence.historyExists
    || evidence.vaultKeyExists
    || evidence.contentExists;

  if (!hasExistingEvidence) {
    return {
      ...migrated,
      launchAtStartup: true,
      startupDecisionVersion: STARTUP_DECISION_VERSION,
      sensitiveFilterEnabled: false
    };
  }

  if (!evidence.settingsCorrupt && raw?.startupDecisionVersion === STARTUP_DECISION_VERSION) {
    return {
      ...migrated,
      startupDecisionVersion: STARTUP_DECISION_VERSION
    };
  }

  if (!evidence.settingsCorrupt && raw?.launchAtStartup === true) {
    return {
      ...migrated,
      launchAtStartup: true,
      startupDecisionVersion: STARTUP_DECISION_VERSION,
      sensitiveFilterEnabled: false
    };
  }

  return {
    ...migrated,
    launchAtStartup: false,
    startupDecisionVersion: 0,
    sensitiveFilterEnabled: false
  };
}

function compatibleSettings(raw: Partial<AppSettings> | undefined): AppSettings {
  const settings = { ...DEFAULT_SETTINGS };
  if (!raw) {
    return settings;
  }

  if (typeof raw.captureEnabled === "boolean") settings.captureEnabled = raw.captureEnabled;
  if (isFiniteNumber(raw.maxItems)) settings.maxItems = raw.maxItems;
  if (isFiniteNumber(raw.retentionDays)) settings.retentionDays = raw.retentionDays;
  if (isFiniteNumber(raw.maxTextLength)) settings.maxTextLength = raw.maxTextLength;
  if (isFiniteNumber(raw.maxImageBytes)) settings.maxImageBytes = raw.maxImageBytes;
  if (typeof raw.hotkey === "string") settings.hotkey = raw.hotkey;
  if (typeof raw.launchAtStartup === "boolean") settings.launchAtStartup = raw.launchAtStartup;
  if (typeof raw.sensitiveFilterEnabled === "boolean") {
    settings.sensitiveFilterEnabled = raw.sensitiveFilterEnabled;
  }

  return settings;
}

function migrateTextLimit(settings: AppSettings, raw: Partial<AppSettings> | undefined): void {
  if (raw?.textLimitMigrationVersion === TEXT_LIMIT_MIGRATION_VERSION) {
    return;
  }

  if (settings.maxTextLength === PREVIOUS_DEFAULT_MAX_TEXT_LENGTH) {
    settings.maxTextLength = DEFAULT_SETTINGS.maxTextLength;
  }
  settings.textLimitMigrationVersion = TEXT_LIMIT_MIGRATION_VERSION;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
