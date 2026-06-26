import type { AppSettings } from "../../shared/types";

type TextFilterSettings = Pick<AppSettings, "maxTextLength" | "sensitiveFilterEnabled">;

export type TextRecordDecision =
  | { ok: true }
  | { ok: false; reason: "blank" | "too-large" | "sensitive" };

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;
const SECRET_LABEL_PATTERN = /\b(password|passwd|api[_-]?key|secret|token|access[_-]?token)\b\s*[:=]/i;
// Only block 8-digit numbers (most SMS OTPs); 6-digit numbers are too common (postal codes, etc.)
const OTP_PATTERN = /^\d{8}$/;
// 48+ chars, no spaces, mixed case + digits — loose enough for real tokens, tight enough to avoid
// blocking common identifiers, short base64, or serial numbers
const LONG_TOKEN_PATTERN = /^[A-Za-z0-9+/_=-]{48,}$/;

export function shouldRecordText(text: string, settings: TextFilterSettings): TextRecordDecision {
  if (text.trim().length === 0) {
    return { ok: false, reason: "blank" };
  }

  if (text.length > settings.maxTextLength) {
    return { ok: false, reason: "too-large" };
  }

  if (settings.sensitiveFilterEnabled && looksSensitive(text.trim())) {
    return { ok: false, reason: "sensitive" };
  }

  return { ok: true };
}

function looksSensitive(text: string): boolean {
  return (
    PRIVATE_KEY_PATTERN.test(text) ||
    JWT_PATTERN.test(text) ||
    SECRET_LABEL_PATTERN.test(text) ||
    OTP_PATTERN.test(text) ||
    (text.includes(" ") === false && LONG_TOKEN_PATTERN.test(text) && /[a-z]/.test(text) && /[A-Z]/.test(text) && /[0-9]/.test(text))
  );
}
