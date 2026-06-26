import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, Tray } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS, type AppSettings, type HistoryFilterType, type HistoryQuery } from "../shared/types";
import { ClipboardWatcher } from "./lib/clipboardWatcher";
import { HistoryStore, type ImageInput } from "./lib/historyStore";
import { SafeStorageKeyProvider } from "./lib/secureVault";
import { autoUpdater } from "electron-updater";

const currentDir = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let store: HistoryStore;
let watcher: ClipboardWatcher;
let isQuitting = false;

function windowStatePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

function loadWindowBounds(): { x?: number; y?: number; width?: number; height?: number } {
  try {
    const path = windowStatePath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function saveWindowBounds(): void {
  if (!mainWindow) return;
  try {
    const bounds = mainWindow.getBounds();
    writeFileSync(windowStatePath(), JSON.stringify(bounds));
  } catch (error) {
    console.error("Failed to save window bounds:", error);
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  store = new HistoryStore(
    app.getPath("userData"),
    new SafeStorageKeyProvider(join(app.getPath("userData"), "vault.key"), safeStorage),
    DEFAULT_SETTINGS
  );
  await store.init();

  createWindow();
  createTray();
  registerIpc();
  await applySystemSettings(await store.getSettings());

  watcher = new ClipboardWatcher({
    getSettings: () => store.getSettings(),
    readText: () => clipboard.readText(),
    readImage: readClipboardImage,
    addText: (text) => store.addText(text),
    addImage: (image) => store.addImage(image)
  });
  watcher.start();

  // Don't show window if app auto-started (launchAtStartup) — stay in tray
  const settings = await store.getSettings();
  if (!settings.launchAtStartup) {
    mainWindow?.show();
  }

  // Auto-updater
  autoUpdater.logger = console;
  autoUpdater.checkForUpdatesAndNotify().catch((error) => {
    console.error("Auto-update check failed:", error);
  });
}

function createWindow(): void {
  const savedBounds = loadWindowBounds();
  mainWindow = new BrowserWindow({
    width: savedBounds.width ?? 980,
    height: savedBounds.height ?? 700,
    minWidth: 760,
    minHeight: 520,
    x: savedBounds.x,
    y: savedBounds.y,
    title: "历史剪贴板",
    show: false,
    backgroundColor: "#f3f5f2",
    webPreferences: {
      preload: join(currentDir, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("resize", saveWindowBounds);
  mainWindow.on("move", saveWindowBounds);

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL).catch((error) => {
      console.error("Failed to load renderer URL:", error);
    });
  } else {
    mainWindow.loadFile(join(currentDir, "../renderer/index.html")).catch((error) => {
      console.error("Failed to load renderer file:", error);
    });
  }
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("历史剪贴板");
  tray.on("click", toggleWindow);
  refreshTrayMenu();
}

function refreshTrayMenu(): void {
  if (!tray) {
    return;
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开历史剪贴板", click: showWindow },
      { type: "separator" },
      {
        label: "暂停/恢复记录",
        click: async () => {
          const settings = await store.getSettings();
          await store.updateSettings({ captureEnabled: !settings.captureEnabled });
          refreshTrayMenu();
        }
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function registerIpc(): void {
  ipcMain.handle("history:list", async (_event, query?: HistoryQuery) => {
    try {
      return await store.list(query);
    } catch (error) {
      console.error("history:list error:", error);
      return [];
    }
  });
  ipcMain.handle("history:delete", async (_event, id: string) => {
    try {
      return { ok: await store.delete(id) };
    } catch (error) {
      console.error("history:delete error:", error);
      return { ok: false };
    }
  });
  ipcMain.handle("history:deleteMany", async (_event, ids: string[]) => {
    try {
      const count = await store.deleteMany(ids);
      return { ok: true, count };
    } catch (error) {
      console.error("history:deleteMany error:", error);
      return { ok: false, count: 0 };
    }
  });
  ipcMain.handle("history:clear", async (_event, type?: HistoryFilterType) => {
    try {
      await store.clear(type);
    } catch (error) {
      console.error("history:clear error:", error);
    }
  });
  ipcMain.handle("history:setPinned", async (_event, id: string, pinned: boolean) => {
    try {
      return { ok: await store.setPinned(id, pinned) };
    } catch (error) {
      console.error("history:setPinned error:", error);
      return { ok: false };
    }
  });
  ipcMain.handle("history:copy", async (_event, id: string) => {
    try {
      return await copyHistoryItem(id);
    } catch (error) {
      console.error("history:copy error:", error);
      return { ok: false };
    }
  });
  ipcMain.handle("settings:get", async () => {
    try {
      return await store.getSettings();
    } catch (error) {
      console.error("settings:get error:", error);
      return DEFAULT_SETTINGS;
    }
  });
  ipcMain.handle("settings:update", async (_event, patch: Partial<AppSettings>) => {
    try {
      const settings = await store.updateSettings(patch);
      await applySystemSettings(settings);
      refreshTrayMenu();
      return settings;
    } catch (error) {
      console.error("settings:update error:", error);
      return await store.getSettings();
    }
  });
  ipcMain.handle("stats:get", async () => {
    try {
      return store.getStats();
    } catch (error) {
      console.error("stats:get error:", error);
      return { totalItems: 0, textItems: 0, imageItems: 0, imageBytes: 0 };
    }
  });
  ipcMain.handle("window:show", async () => {
    try {
      showWindow();
    } catch (error) {
      console.error("window:show error:", error);
    }
  });

  ipcMain.handle("history:export", async () => {
    try {
      const json = await store.exportAsJson();
      const { filePath } = await dialog.showSaveDialog(mainWindow!, {
        title: "导出剪贴板历史",
        defaultPath: `剪贴板备份-${new Date().toISOString().slice(0, 10)}.hcbk`,
        filters: [{ name: "剪贴板备份", extensions: ["hcbk"] }]
      });
      if (!filePath) return { ok: false, reason: "cancelled" };
      await writeFile(filePath, json, "utf8");
      return { ok: true };
    } catch (error) {
      console.error("history:export error:", error);
      return { ok: false, reason: "export-failed" };
    }
  });

  ipcMain.handle("history:import", async () => {
    try {
      const { filePaths } = await dialog.showOpenDialog(mainWindow!, {
        title: "导入剪贴板历史",
        filters: [{ name: "剪贴板备份", extensions: ["hcbk"] }],
        properties: ["openFile"]
      });
      if (!filePaths || filePaths.length === 0) return { ok: false, reason: "cancelled" };
      const json = await readFile(filePaths[0], "utf8");
      const result = await store.importFromJson(json);
      return { ok: true, imported: result.imported, skipped: result.skipped };
    } catch (error) {
      console.error("history:import error:", error);
      return { ok: false, reason: "import-failed" };
    }
  });
}

async function copyHistoryItem(id: string): Promise<{ ok: boolean }> {
  const content = await store.getContent(id);
  if (!content) {
    return { ok: false };
  }

  if (content.type === "text") {
    clipboard.writeText(content.text);
  } else {
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(content.png)));
  }

  return { ok: true };
}

async function applySystemSettings(settings: AppSettings): Promise<void> {
  app.setLoginItemSettings({ openAtLogin: settings.launchAtStartup });
  globalShortcut.unregister(toElectronAccelerator(settings.hotkey));
  const registered = globalShortcut.register(toElectronAccelerator(settings.hotkey), toggleWindow);
  if (!registered) {
    console.warn(`Failed to register global shortcut: ${settings.hotkey}`);
  }
}

function readClipboardImage(): ImageInput | undefined {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return undefined;
  }

  const png = image.toPNG();
  if (png.length === 0) {
    return undefined;
  }

  const size = image.getSize();
  const longestSide = Math.max(size.width, size.height, 1);
  const scale = Math.min(1, 180 / longestSide);
  const thumbnail = image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale))
  });

  return {
    png,
    thumbnailPng: thumbnail.toPNG(),
    width: size.width,
    height: size.height
  };
}

function toggleWindow(): void {
  if (mainWindow?.isVisible()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

function showWindow(): void {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(true);
  setTimeout(() => {
    mainWindow?.setAlwaysOnTop(false);
  }, 800);
}

function toElectronAccelerator(hotkey: string): string {
  return hotkey.replace("Ctrl", "Control");
}

function createTrayIcon(): Electron.NativeImage {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
    '<rect width="32" height="32" rx="7" fill="#20322f"/>',
    '<path d="M11 7h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" fill="#e9f2ed"/>',
    '<path d="M13 5h6a2 2 0 0 1 2 2v3h-10V7a2 2 0 0 1 2-2Z" fill="#4f8b7d"/>',
    '<path d="M13 15h6M13 19h5" stroke="#20322f" stroke-width="2" stroke-linecap="round"/>',
    "</svg>"
  ].join("");

  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

app.on("before-quit", () => {
  isQuitting = true;
  watcher?.stop();
  globalShortcut.unregisterAll();
});

app.on("activate", () => {
  if (!mainWindow) {
    createWindow();
  }
  showWindow();
});

void bootstrap();
