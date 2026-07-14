import type { EditableSettingsPatch } from "../../shared/types";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= minimum
    && value <= maximum;
}

export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}

export function sanitizeEditableSettingsPatch(value: unknown): EditableSettingsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const input = value as Record<string, unknown>;
  const patch: EditableSettingsPatch = {};

  if (typeof input.captureEnabled === "boolean") {
    patch.captureEnabled = input.captureEnabled;
  }
  if (isIntegerInRange(input.maxItems, 10, 10_000)) {
    patch.maxItems = input.maxItems;
  }
  if (isIntegerInRange(input.retentionDays, 1, 365)) {
    patch.retentionDays = input.retentionDays;
  }
  if (isIntegerInRange(input.maxTextLength, 1, Number.MAX_SAFE_INTEGER)) {
    patch.maxTextLength = input.maxTextLength;
  }
  if (isIntegerInRange(input.maxImageBytes, 1024 * 1024, MAX_IMAGE_BYTES)) {
    patch.maxImageBytes = input.maxImageBytes;
  }
  if (typeof input.hotkey === "string") {
    patch.hotkey = input.hotkey;
  }
  if (typeof input.sensitiveFilterEnabled === "boolean") {
    patch.sensitiveFilterEnabled = input.sensitiveFilterEnabled;
  }

  return patch;
}
