import { contextBridge, ipcRenderer } from "electron";
import type { ClipboardHistoryApi, EditableSettingsPatch, HistoryFilterType, HistoryQuery, UpdaterState } from "../shared/types";

const api: ClipboardHistoryApi = {
  list: (query?: HistoryQuery) => ipcRenderer.invoke("history:list", query),
  copy: (id: string) => ipcRenderer.invoke("history:copy", id),
  copyPath: (id: string) => ipcRenderer.invoke("history:copyPath", id),
  preview: (id: string) => ipcRenderer.invoke("history:preview", id),
  delete: (id: string) => ipcRenderer.invoke("history:delete", id),
  deleteMany: (ids: string[]) => ipcRenderer.invoke("history:deleteMany", ids),
  clear: (type?: HistoryFilterType) => ipcRenderer.invoke("history:clear", type),
  setPinned: (id: string, pinned: boolean) => ipcRenderer.invoke("history:setPinned", id, pinned),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (settings: EditableSettingsPatch) => ipcRenderer.invoke("settings:update", settings),
  getStats: () => ipcRenderer.invoke("stats:get"),
  getStartupState: () => ipcRenderer.invoke("startup:getState"),
  setStartupEnabled: (enabled: boolean) => ipcRenderer.invoke("startup:setEnabled", enabled),
  getBackgroundState: () => ipcRenderer.invoke("background:getState"),
  showWindow: () => ipcRenderer.invoke("window:show"),
  checkForUpdates: () => ipcRenderer.invoke("updater:check"),
  getUpdaterState: () => ipcRenderer.invoke("updater:getState"),
  onUpdaterState: (callback: (state: UpdaterState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdaterState) => callback(state);
    ipcRenderer.on("updater:state", listener);
    return () => {
      ipcRenderer.removeListener("updater:state", listener);
    };
  },
  exportHistory: () => ipcRenderer.invoke("history:export"),
  importHistory: () => ipcRenderer.invoke("history:import")
};

contextBridge.exposeInMainWorld("clipHistory", api);
