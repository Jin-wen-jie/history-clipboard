import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const entry = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("main entry module imports", () => {
  test("loads the CommonJS updater through its default export", () => {
    expect(entry).toContain('import updaterModule from "electron-updater";');
    expect(entry).toContain("const { autoUpdater } = updaterModule;");
    expect(entry).not.toContain('import { autoUpdater } from "electron-updater";');
  });

  test("creates the Windows tray icon from PNG data", () => {
    expect(entry).toContain('nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, "base64"))');
    expect(entry).toContain("icon.isEmpty()");
    expect(entry).not.toContain("data:image/svg+xml");
  });
});
