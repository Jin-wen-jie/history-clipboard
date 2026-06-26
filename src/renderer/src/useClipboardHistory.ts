import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, HistoryFilterType, HistoryItem, StorageStats } from "../../shared/types";

export type LoadState = "idle" | "loading" | "error";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function useClipboardHistory() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [settings, setSettings] = useState<AppSettings | undefined>();
  const [stats, setStats] = useState<StorageStats | undefined>();
  const [filterType, setFilterType] = useState<HistoryFilterType>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [lastAction, setLastAction] = useState("");
  const historyListRef = useRef<HTMLElement | null>(null);
  const latestItemIdRef = useRef<string | undefined>(undefined);

  // Debounce search: avoid reloading data on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      if (!window.clipHistory) {
        throw new Error("桌面桥接未加载，请重新安装或重启应用");
      }

      const [nextSettings, nextStats, nextItems] = await Promise.all([
        window.clipHistory.getSettings(),
        window.clipHistory.getStats(),
        window.clipHistory.list({ type: filterType, search: debouncedSearch })
      ]);
      const nextLatestItemId = nextItems[0]?.id;
      const previousLatestItemId = latestItemIdRef.current;
      setSettings(nextSettings);
      setStats(nextStats);
      setItems(nextItems);
      latestItemIdRef.current = nextLatestItemId;
      if (previousLatestItemId && nextLatestItemId && previousLatestItemId !== nextLatestItemId) {
        historyListRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      }
      setLoadState("idle");
      setLastAction("");
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : String(error));
      setLoadState("error");
    }
  }, [filterType, debouncedSearch]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 1500);
    return () => window.clearInterval(interval);
  }, [load]);

  const imageBytes = useMemo(() => formatBytes(stats?.imageBytes ?? 0), [stats]);

  async function copyItem(id: string): Promise<void> {
    try {
      const result = await window.clipHistory.copy(id);
      setLastAction(result.ok ? "已复制" : "复制失败");
      // No need to reload — the copy act bumps copyCount, but that's
      // cosmetic; the next poll will pick it up.
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "复制失败");
    }
  }

  async function deleteItem(id: string): Promise<void> {
    try {
      await window.clipHistory.delete(id);
      setLastAction("已删除");
      // Optimistic local removal — avoid full reload
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "删除失败");
    }
  }

  async function deleteItems(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const result = await window.clipHistory.deleteMany(ids);
      setLastAction(`已删除 ${result.count} 条记录`);
      // Optimistic local removal
      const idSet = new Set(ids);
      setItems((prev) => prev.filter((item) => !idSet.has(item.id)));
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "批量删除失败");
    }
  }

  async function togglePinned(item: HistoryItem): Promise<void> {
    try {
      await window.clipHistory.setPinned(item.id, !item.pinned);
      // Optimistic local update
      setItems((prev) =>
        prev.map((candidate) =>
          candidate.id === item.id ? { ...candidate, pinned: !candidate.pinned } : candidate
        )
      );
      setLastAction(item.pinned ? "已取消置顶" : "已置顶");
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "操作失败");
    }
  }

  async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
    try {
      setSettings(await window.clipHistory.updateSettings(patch));
      // Settings changes can affect retention — reload to be safe
      await load();
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "设置更新失败");
    }
  }

  async function clearCurrent(): Promise<void> {
    try {
      await window.clipHistory.clear(filterType);
      setLastAction("已清空");
      // Full reload is OK here since it's a rare operation
      await load();
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "清空失败");
    }
  }

  return {
    // State
    items,
    settings,
    stats,
    filterType,
    search,
    loadState,
    lastAction,
    imageBytes,
    historyListRef,
    // Setters
    setFilterType,
    setSearch,
    // Actions
    copyItem,
    deleteItem,
    deleteItems,
    togglePinned,
    updateSettings,
    clearCurrent,
    load,
  };
}
