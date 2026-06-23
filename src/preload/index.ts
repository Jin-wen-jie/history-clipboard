import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings, ClipboardHistoryApi, HistoryFilterType, HistoryQuery } from "../shared/types";

const api: ClipboardHistoryApi = {
  list: (query?: HistoryQuery) => ipcRenderer.invoke("history:list", query),
  copy: (id: string) => ipcRenderer.invoke("history:copy", id),
  delete: (id: string) => ipcRenderer.invoke("history:delete", id),
  clear: (type?: HistoryFilterType) => ipcRenderer.invoke("history:clear", type),
  setPinned: (id: string, pinned: boolean) => ipcRenderer.invoke("history:setPinned", id, pinned),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke("settings:update", settings),
  getStats: () => ipcRenderer.invoke("stats:get"),
  showWindow: () => ipcRenderer.invoke("window:show")
};

contextBridge.exposeInMainWorld("clipHistory", api);
