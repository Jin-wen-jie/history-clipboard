import { app, Notification } from "electron";
import updaterModule from "electron-updater";
import type { UpdaterState } from "../../shared/types";

const { autoUpdater } = updaterModule;

const DEV_SKIP_MESSAGE = "当前是开发/未打包运行，不检查更新";

let state: UpdaterState = {
  phase: "idle",
  version: app.getVersion(),
  targetVersion: null,
  percent: null,
  transferredBytes: null,
  totalBytes: null,
  bytesPerSecond: null,
  error: null,
  lastCheckAt: null
};

const listeners = new Set<(next: UpdaterState) => void>();

function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    listener(state);
  }
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) {
    return;
  }
  new Notification({ title, body }).show();
}

export function initAppUpdater(onChange: (next: UpdaterState) => void): void {
  listeners.add(onChange);
  onChange(state);

  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    setState({ phase: "checking", error: null, lastCheckAt: Date.now() });
  });
  autoUpdater.on("update-available", (info) => {
    setState({ phase: "available", targetVersion: info.version, error: null });
    notify(`发现新版本 v${info.version}`, "正在后台下载差量包，退出应用时自动安装。");
  });
  autoUpdater.on("update-not-available", () => {
    setState({ phase: "idle", targetVersion: null, error: null });
  });
  autoUpdater.on("download-progress", (progress) => {
    setState({
      phase: "downloading",
      percent: Math.round(progress.percent),
      transferredBytes: progress.transferred,
      totalBytes: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    setState({ phase: "downloaded", targetVersion: info.version, percent: 100 });
    notify(`v${info.version} 更新已就绪`, "退出应用后将自动安装，下次打开即为新版本。");
  });
  autoUpdater.on("error", (error) => {
    setState({ phase: "error", error: String(error?.message ?? error) });
  });
}

export async function checkForUpdatesNow(): Promise<void> {
  const result = await autoUpdater.checkForUpdatesAndNotify().catch((error) => {
    setState({ phase: "error", error: String(error?.message ?? error) });
    return null;
  });
  if (result === null && state.phase !== "error") {
    setState({ phase: "idle", error: DEV_SKIP_MESSAGE });
  }
}

export function getUpdaterState(): UpdaterState {
  return state;
}
