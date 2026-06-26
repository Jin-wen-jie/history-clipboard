import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, HistoryFilterType, HistoryItem, StorageStats } from "../../shared/types";
import { formatBytes } from "../../shared/format";

export type LoadState = "idle" | "loading" | "error";

/** Convert YYYY-MM-DD to an ISO start-of-day string (or undefined if empty) */
function dateToFrom(dateStr: string): string | undefined {
  if (!dateStr) return undefined;
  return `${dateStr}T00:00:00.000Z`;
}

/** Convert YYYY-MM-DD to an ISO end-of-day string (or undefined if empty) */
function dateToTo(dateStr: string): string | undefined {
  if (!dateStr) return undefined;
  return `${dateStr}T23:59:59.999Z`;
}

export function useClipboardHistory() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [settings, setSettings] = useState<AppSettings | undefined>();
  const [stats, setStats] = useState<StorageStats | undefined>();
  const [filterType, setFilterType] = useState<HistoryFilterType>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
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
        window.clipHistory.list({
          type: filterType,
          search: debouncedSearch,
          from: dateToFrom(dateFrom),
          to: dateToTo(dateTo)
        })
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
  }, [filterType, debouncedSearch, dateFrom, dateTo]);

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
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "复制失败");
    }
  }

  async function deleteItem(id: string): Promise<void> {
    try {
      await window.clipHistory.delete(id);
      setLastAction("已删除");
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
      const idSet = new Set(ids);
      setItems((prev) => prev.filter((item) => !idSet.has(item.id)));
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "批量删除失败");
    }
  }

  async function togglePinned(item: HistoryItem): Promise<void> {
    try {
      await window.clipHistory.setPinned(item.id, !item.pinned);
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
      await load();
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "设置更新失败");
    }
  }

  async function clearCurrent(): Promise<void> {
    try {
      await window.clipHistory.clear(filterType);
      setLastAction("已清空");
      await load();
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "清空失败");
    }
  }

  function clearDateFilter(): void {
    setDateFrom("");
    setDateTo("");
  }

  return {
    // State
    items,
    settings,
    stats,
    filterType,
    search,
    dateFrom,
    dateTo,
    loadState,
    lastAction,
    imageBytes,
    historyListRef,
    // Setters
    setFilterType,
    setSearch,
    setDateFrom,
    setDateTo,
    clearDateFilter,
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
