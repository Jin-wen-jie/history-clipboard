import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, Tray } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS, type AppSettings, type HistoryFilterType, type HistoryQuery } from "../shared/types";
import { ClipboardWatcher } from "./lib/clipboardWatcher";
import { HistoryStore, type ImageInput } from "./lib/historyStore";
import { SafeStorageKeyProvider } from "./lib/secureVault";

const currentDir = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let store: HistoryStore;
let watcher: ClipboardWatcher;
let isQuitting = false;

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

  mainWindow?.show();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 760,
    minHeight: 520,
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

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(currentDir, "../renderer/index.html"));
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
  ipcMain.handle("history:list", (_event, query?: HistoryQuery) => store.list(query));
  ipcMain.handle("history:delete", async (_event, id: string) => ({ ok: await store.delete(id) }));
  ipcMain.handle("history:clear", async (_event, type?: HistoryFilterType) => {
    await store.clear(type);
  });
  ipcMain.handle("history:setPinned", async (_event, id: string, pinned: boolean) => ({
    ok: await store.setPinned(id, pinned)
  }));
  ipcMain.handle("history:copy", async (_event, id: string) => copyHistoryItem(id));
  ipcMain.handle("settings:get", () => store.getSettings());
  ipcMain.handle("settings:update", async (_event, patch: Partial<AppSettings>) => {
    const settings = await store.updateSettings(patch);
    await applySystemSettings(settings);
    refreshTrayMenu();
    return settings;
  });
  ipcMain.handle("stats:get", () => store.getStats());
  ipcMain.handle("window:show", () => showWindow());
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
  globalShortcut.unregisterAll();
  globalShortcut.register(toElectronAccelerator(settings.hotkey), toggleWindow);
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
  mainWindow?.show();
  mainWindow?.focus();
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
