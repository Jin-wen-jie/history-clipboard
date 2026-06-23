import type { ClipboardHistoryApi } from "../../shared/types";

declare global {
  interface Window {
    clipHistory: ClipboardHistoryApi;
  }
}

export {};
