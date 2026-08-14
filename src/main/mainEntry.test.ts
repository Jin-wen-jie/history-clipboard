import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const entry = readFileSync(new URL("./lib/appUpdater.ts", import.meta.url), "utf8");

describe("app updater module imports", () => {
  test("loads the CommonJS updater through its default export", () => {
    expect(entry).toContain('import updaterModule from "electron-updater";');
    expect(entry).toContain("const { autoUpdater } = updaterModule;");
    expect(entry).not.toContain('import { autoUpdater } from "electron-updater";');
  });
});
