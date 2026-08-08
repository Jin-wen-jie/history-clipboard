import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, safeStorage, Tray } from "electron";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS, type AppSettings, type CopyPathResult, type HistoryFilterType, type HistoryPreviewResult, type HistoryQuery } from "../shared/types";
import {
  ClipboardRuntime,
  shouldReconcileAfterSettingsChange
} from "./lib/clipboardRuntime";
import { requireBoolean, sanitizeEditableSettingsPatch } from "./lib/editableSettingsPatch";
import { HistoryStore, type ImageInput } from "./lib/historyStore";
import { SafeStorageKeyProvider } from "./lib/secureVault";
import { ShutdownCoordinator } from "./lib/shutdownCoordinator";
import {
  SecondInstanceWindowCoordinator,
  StartupManager,
  isLaunchAtLogin
} from "./lib/startupManager";
import updaterModule from "electron-updater";

const { autoUpdater } = updaterModule;

const MAX_FILE_PREVIEW_BYTES = 2 * 1024 * 1024;
const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".txt", ".json", ".md", ".log", ".csv", ".xml", ".yaml", ".yml",
  ".ini", ".conf", ".js", ".jsx", ".ts", ".tsx", ".css", ".html"
]);

const currentDir = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let store: HistoryStore;
let runtime: ClipboardRuntime | undefined;
let startupManager: StartupManager;
let shutdownCoordinator: ShutdownCoordinator | undefined;
const secondInstanceWindowCoordinator = new SecondInstanceWindowCoordinator();

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

let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null;

function saveWindowBounds(): void {
  if (!mainWindow) return;
  // Debounce: coalesce rapid resize/move events into a single async write
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(async () => {
    saveBoundsTimer = null;
    try {
      const bounds = mainWindow?.getBounds();
      if (!bounds) return;
      await writeFile(windowStatePath(), JSON.stringify(bounds), "utf8");
    } catch (error) {
      console.error("Failed to save window bounds:", error);
    }
  }, 300);
}

app.on("before-quit", (event) => {
  ensureShutdownCoordinator().handleBeforeQuit(event);
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    secondInstanceWindowCoordinator.handleSecondInstance(
      commandLine,
      mainWindow !== undefined && !mainWindow.isDestroyed(),
      showWindow
    );
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  if (shutdownCoordinator?.isQuitting) {
    return;
  }

  store = new HistoryStore(
    app.getPath("userData"),
    new SafeStorageKeyProvider(join(app.getPath("userData"), "vault.key"), safeStorage),
    DEFAULT_SETTINGS
  );
  await store.init();
  if (shutdownCoordinator?.isQuitting) {
    return;
  }

  startupManager = new StartupManager(app, store, process.execPath);
  await startupManager.reconcile();
  if (shutdownCoordinator?.isQuitting) {
    return;
  }

  runtime = new ClipboardRuntime({
    helperPath: app.isPackaged
      ? join(process.resourcesPath, "clipboard-listener.exe")
      : join(currentDir, "../../build/clipboard-listener.exe"),
    watcherOptions: {
      getSettings: () => store.getSettings(),
      readText: () => clipboard.readText(),
      readImage: readClipboardImage,
      addText: (text) => store.addText(text),
      addImage: (image) => store.addImage(image),
      addFile: (file) => store.addFile(file)
    },
    createImageInput
  });
  ensureShutdownCoordinator();
  powerMonitor.on("resume", () => runtime?.handleSystemResume());
  runtime.start();

  createWindow();
  createTray();
  registerIpc();
  await applyHotkeySettings(await store.getSettings());

  if (!isLaunchAtLogin(process.argv)) {
    mainWindow?.show();
  }

  // Auto-updater
  autoUpdater.logger = console;
  autoUpdater.checkForUpdatesAndNotify().catch((error) => {
    console.error("Auto-update check failed:", error);
  });

  // Check for updates hourly while the app is running, so a released
  // version reaches users shortly after publishing (not only on launch).
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      console.error("Scheduled auto-update check failed:", error);
    });
  }, 60 * 60 * 1000).unref();
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
    if (!shutdownCoordinator?.isQuitting) {
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

  secondInstanceWindowCoordinator.consumePendingShow(showWindow);
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
          const before = await store.getSettings();
          const after = await store.updateSettings({ captureEnabled: !before.captureEnabled });
          if (shouldReconcileAfterSettingsChange(before, after)) {
            await runtime?.reconcileAfterSettingsChange();
          }
          refreshTrayMenu();
        }
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
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
  ipcMain.handle("history:copyPath", async (_event, id: string) => {
    try {
      return await copyPathHistoryItem(id);
    } catch (error) {
      console.error("history:copyPath error:", error);
      return { ok: false, reason: "export-failed" };
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
  ipcMain.handle("history:preview", async (_event, id: string) => {
    try {
      return await previewHistoryItem(id);
    } catch (error) {
      console.error("history:preview error:", error);
      return { ok: false, reason: "missing" } satisfies HistoryPreviewResult;
    }
  });
  ipcMain.handle("settings:update", async (_event, value: unknown) => {
    try {
      const patch = sanitizeEditableSettingsPatch(value);
      const before = await store.getSettings();
      let settings = before;
      if (Object.keys(patch).length > 0) {
        settings = await store.updateSettings(patch);
      }
      if (shouldReconcileAfterSettingsChange(before, settings)) {
        await runtime?.reconcileAfterSettingsChange();
      }
      await applyHotkeySettings(settings);
      refreshTrayMenu();
      return settings;
    } catch (error) {
      console.error("settings:update error:", error);
      return await store.getSettings();
    }
  });
  ipcMain.handle("startup:getState", async () => startupManager.getState());
  ipcMain.handle("startup:setEnabled", async (_event, value: unknown) => (
    startupManager.setEnabled(requireBoolean(value, "startup enabled"))
  ));
  ipcMain.handle("background:getState", async () => {
    if (!runtime) {
      throw new Error("Clipboard runtime unavailable");
    }
    return runtime.getState();
  });
  ipcMain.handle("stats:get", async () => {
    try {
      return store.getStats();
    } catch (error) {
      console.error("stats:get error:", error);
      return { totalItems: 0, textItems: 0, imageItems: 0, fileItems: 0, imageBytes: 0 };
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

async function copyHistoryItem(id: string): Promise<{ ok: boolean; reason?: "missing" }> {
  const content = await store.getContent(id);
  if (!content) {
    return { ok: false };
  }

  if (content.type === "text") {
    clipboard.writeText(content.text);
  } else if (content.type === "image") {
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(content.png)));
  } else {
    try {
      if (!statSync(content.path).isFile()) {
        return { ok: false, reason: "missing" };
      }
    } catch {
      return { ok: false, reason: "missing" };
    }
    clipboard.writeBuffer("FileNameW", Buffer.from(`${content.path}\0`, "utf16le"));
  }

  return { ok: true };
}

async function copyPathHistoryItem(id: string): Promise<CopyPathResult> {
  const content = await store.getContent(id);
  if (!content) {
    return { ok: false, reason: "unsupported" };
  }

  if (content.type === "text") {
    return { ok: false, reason: "unsupported" };
  }

  if (content.type === "file") {
    try {
      if (!statSync(content.path).isFile()) {
        return { ok: false, reason: "missing" };
      }
    } catch {
      return { ok: false, reason: "missing" };
    }
    clipboard.writeText(content.path);
    return { ok: true, path: content.path };
  }

  // Images live inside the app vault (no real file path), so export the PNG
  // to a stable folder first, then copy the exported file's path.
  const exportDir = join(app.getPath("userData"), "exported-images");
  const exportPath = join(exportDir, `${id}.png`);
  await mkdir(exportDir, { recursive: true });
  await writeFile(exportPath, content.png);
  clipboard.writeText(exportPath);
  return { ok: true, path: exportPath };
}

async function applyHotkeySettings(settings: AppSettings): Promise<void> {
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
  return createImageInput(png, size.width, size.height);
}

async function previewHistoryItem(id: string): Promise<HistoryPreviewResult> {
  const content = await store.getContent(id);
  if (!content) {
    return { ok: false, reason: "missing" };
  }
  if (content.type === "image") {
    return { ok: true, type: "image", png: content.png };
  }
  if (content.type !== "file") {
    return { ok: false, reason: "unsupported" };
  }

  const extension = extname(content.path).toLocaleLowerCase();
  if (!TEXT_PREVIEW_EXTENSIONS.has(extension)) {
    return { ok: false, reason: "unsupported" };
  }
  let fileStat;
  try {
    fileStat = await stat(content.path);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!fileStat.isFile()) {
    return { ok: false, reason: "missing" };
  }
  if (fileStat.size > MAX_FILE_PREVIEW_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  const bytes = await readFile(content.path);
  if (bytes.byteLength > MAX_FILE_PREVIEW_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  const rawText = bytes.toString("utf8");
  if (extension === ".json") {
    try {
      return {
        ok: true,
        type: "file-text",
        text: JSON.stringify(JSON.parse(rawText) as unknown, null, 2),
        formatted: true
      };
    } catch {
      // Invalid JSON remains viewable as raw text.
    }
  }
  return { ok: true, type: "file-text", text: rawText, formatted: false };
}

function createImageInput(png: Buffer, width: number, height: number): ImageInput {
  const image = nativeImage.createFromBuffer(png);
  const longestSide = Math.max(width, height, 1);
  const scale = Math.min(1, 180 / longestSide);
  const thumbnail = image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  });

  return {
    png,
    thumbnailPng: thumbnail.toPNG(),
    width,
    height
  };
}

function ensureShutdownCoordinator(): ShutdownCoordinator {
  shutdownCoordinator ??= new ShutdownCoordinator({
    stopSupervisor: () => runtime?.stopSupervisor() ?? Promise.resolve(),
    stopWatcher: () => runtime?.stopWatcher(),
    drainWatcher: () => runtime?.drain() ?? Promise.resolve(),
    flushStore: async () => {
      if (store) {
        await store.flush();
      }
    },
    unregisterShortcuts: () => globalShortcut.unregisterAll(),
    quit: () => app.quit(),
    onError: () => console.error("Application shutdown step failed")
  });
  return shutdownCoordinator;
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

app.on("activate", () => {
  if (!mainWindow) {
    createWindow();
  }
  showWindow();
});

void bootstrap();
