import { StrictMode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import type { ClipboardHistoryApi } from "../../shared/types";
import { App } from "./App";
import "./styles.css";

if (!window.clipHistory && "__TAURI_INTERNALS__" in window) {
  const command = <T,>(name: string, args?: Record<string, unknown>) => invoke<T>(name, args);
  const api: ClipboardHistoryApi = {
    list: (query) => command("history_list", { query }),
    copy: (id) => command("history_copy", { id }),
    copyImagePath: (id) => command("history_copy_image_path", { id }),
    preview: (id) => command("history_preview", { id }),
    delete: (id) => command("history_delete", { id }),
    deleteMany: (ids) => command("history_delete_many", { ids }),
    clear: (type) => command("history_clear", { historyType: type }),
    setPinned: (id, pinned) => command("history_set_pinned", { id, pinned }),
    getSettings: () => command("settings_get"),
    updateSettings: (settings) => command("settings_update", { settings }),
    getStats: () => command("stats_get"),
    getStartupState: () => command("startup_get_state"),
    setStartupEnabled: (enabled) => command("startup_set_enabled", { enabled }),
    getBackgroundState: () => command("background_get_state"),
    showWindow: () => command("window_show"),
    exportHistory: () => command("history_export"),
    importHistory: () => command("history_import")
  };
  window.clipHistory = api;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
