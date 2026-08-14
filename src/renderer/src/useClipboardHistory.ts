import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  ClipboardBackgroundState,
  EditableSettingsPatch,
  HistoryFilterType,
  HistoryItem,
  StartupState,
  StorageStats
} from "../../shared/types";
import { formatBytes } from "../../shared/format";

export type LoadState = "idle" | "loading" | "error";

const STARTUP_ACTION_ERROR = "启动设置失败";

/** Convert YYYY-MM-DD to an ISO start-of-day instant (or undefined if empty). */
export function dateToFrom(dateStr: string): string | undefined {
  if (!dateStr) return undefined;
  // Parse without a timezone suffix so the calendar day the user picked maps
  // to local midnight; appending "Z" would shift the range by the UTC offset
  // (e.g. an 8-hour error for UTC+8 users).
  return new Date(`${dateStr}T00:00:00`).toISOString();
}

/** Convert YYYY-MM-DD to an ISO end-of-day instant (or undefined if empty). */
export function dateToTo(dateStr: string): string | undefined {
  if (!dateStr) return undefined;
  return new Date(`${dateStr}T23:59:59.999`).toISOString();
}

export function useClipboardHistory() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [settings, setSettings] = useState<AppSettings | undefined>();
  const [stats, setStats] = useState<StorageStats | undefined>();
  const [startupState, setStartupState] = useState<StartupState | undefined>();
  const [backgroundState, setBackgroundState] = useState<ClipboardBackgroundState | undefined>();
  const [startupActionPending, setStartupActionPending] = useState(false);
  const [startupActionError, setStartupActionError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<HistoryFilterType>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [lastAction, setLastAction] = useState("");
  const historyListRef = useRef<HTMLElement | null>(null);
  const latestItemIdRef = useRef<string | undefined>(undefined);
  const loadGenerationRef = useRef(0);
  const activeLoadRef = useRef<Promise<void> | null>(null);
  const queuedLoadRef = useRef<{
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason?: unknown) => void;
  } | null>(null);
  const loadRef = useRef<(queueIfBusy?: boolean) => Promise<void>>(async () => undefined);
  const startupWriteVersionRef = useRef(0);
  const startupActionPendingRef = useRef(false);

  // Debounce search: avoid reloading data on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback((queueIfBusy = false): Promise<void> => {
    const activeLoad = activeLoadRef.current;
    if (activeLoad) {
      if (queueIfBusy) {
        loadGenerationRef.current += 1;
        // Callers awaiting the queued reload must wait for the reload itself,
        // not for the in-flight load they can no longer observe. Reuse one
        // deferred so multiple queueIfBusy calls settle together.
        if (!queuedLoadRef.current) {
          let resolve!: () => void;
          let reject!: (reason?: unknown) => void;
          const promise = new Promise<void>((nextResolve, nextReject) => {
            resolve = nextResolve;
            reject = nextReject;
          });
          queuedLoadRef.current = { promise, resolve, reject };
        }
        return queuedLoadRef.current.promise;
      }
      return activeLoad;
    }

    const loadGeneration = ++loadGenerationRef.current;
    const startupWriteVersion = startupWriteVersionRef.current;
    const loadTask = (async (): Promise<void> => {
    setLoadState("loading");
    if (!window.clipHistory) {
      setLastAction("桌面桥接未加载，请重新安装或重启应用");
      setLoadState("error");
      return;
    }

    const startupRequest = Promise.resolve()
      .then(() => window.clipHistory.getStartupState())
      .then((nextStartupState) => {
        if (
          loadGeneration === loadGenerationRef.current &&
          startupWriteVersion === startupWriteVersionRef.current &&
          !startupActionPendingRef.current
        ) {
          setStartupState(nextStartupState);
        }
      })
      .catch(() => undefined);
    const backgroundRequest = Promise.resolve()
      .then(() => window.clipHistory.getBackgroundState())
      .then((nextBackgroundState) => {
        if (loadGeneration === loadGenerationRef.current) {
          setBackgroundState(nextBackgroundState);
        }
      })
      .catch(() => undefined);

    try {
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
      if (loadGeneration !== loadGenerationRef.current) {
        return;
      }
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
    } catch (error) {
      if (loadGeneration === loadGenerationRef.current) {
        setLastAction(error instanceof Error ? error.message : String(error));
        setLoadState("error");
      }
    } finally {
      void startupRequest;
      void backgroundRequest;
    }
    })();

    activeLoadRef.current = loadTask;
    void loadTask.finally(() => {
      if (activeLoadRef.current !== loadTask) {
        return;
      }

      activeLoadRef.current = null;
      const queued = queuedLoadRef.current;
      if (queued) {
        queuedLoadRef.current = null;
        void loadRef.current().then(queued.resolve, queued.reject);
      }
    });
    return loadTask;
  }, [filterType, debouncedSearch, dateFrom, dateTo]);
  loadRef.current = load;

  useEffect(() => {
    void load(true);
    const interval = window.setInterval(() => {
      void load();
    }, 1500);
    return () => {
      window.clearInterval(interval);
      loadGenerationRef.current += 1;
    };
  }, [load]);

  const imageBytes = useMemo(() => formatBytes(stats?.imageBytes ?? 0), [stats]);

  async function copyItem(id: string): Promise<void> {
    try {
      const result = await window.clipHistory.copy(id);
      setLastAction(result.ok ? "已复制" : result.reason === "missing" ? "原文件已不存在" : "复制失败");
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "复制失败");
    }
  }

  async function copyPathItem(id: string): Promise<{ ok: boolean; reason?: "missing" | "unsupported" | "export-failed" }> {
    try {
      const result = await window.clipHistory.copyPath(id);
      setLastAction(
        result.ok
          ? "已复制路径"
          : result.reason === "missing"
            ? "原文件已不存在"
            : "复制路径失败"
      );
      return result;
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "复制路径失败");
      return { ok: false };
    }
  }

  async function deleteItem(id: string): Promise<void> {
    try {
      const result = await window.clipHistory.delete(id);
      if (!result.ok) {
        setLastAction("删除失败");
        return;
      }
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
      if (!result.ok) {
        setLastAction("删除失败");
        return;
      }
      setLastAction(`已删除 ${result.count} 条记录`);
      const idSet = new Set(ids);
      setItems((prev) => prev.filter((item) => !idSet.has(item.id)));
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "批量删除失败");
    }
  }

  async function togglePinned(item: HistoryItem): Promise<void> {
    try {
      const result = await window.clipHistory.setPinned(item.id, !item.pinned);
      if (!result.ok) {
        setLastAction("操作失败");
        return;
      }
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

  async function updateEditableSettings(patch: EditableSettingsPatch): Promise<void> {
    try {
      setSettings(await window.clipHistory.updateSettings(patch));
      await load(true);
    } catch (error) {
      setLastAction(error instanceof Error ? error.message : "设置更新失败");
    }
  }

  async function setStartupEnabled(enabled: boolean): Promise<void> {
    if (startupActionPendingRef.current) {
      return;
    }

    startupActionPendingRef.current = true;
    startupWriteVersionRef.current += 1;
    setStartupActionPending(true);
    try {
      const nextStartupState = await window.clipHistory.setStartupEnabled(enabled);
      setStartupState(nextStartupState);
      if (nextStartupState.error) {
        setStartupActionError(STARTUP_ACTION_ERROR);
        setLastAction(STARTUP_ACTION_ERROR);
      } else {
        setStartupActionError(null);
        setLastAction("");
      }
    } catch {
      setStartupActionError(STARTUP_ACTION_ERROR);
      setLastAction(STARTUP_ACTION_ERROR);
    } finally {
      startupWriteVersionRef.current += 1;
      startupActionPendingRef.current = false;
      setStartupActionPending(false);
    }
  }

  async function clearCurrent(): Promise<void> {
    try {
      await window.clipHistory.clear(filterType);
      setLastAction("已清空");
      await load(true);
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
    startupState,
    backgroundState,
    startupActionPending,
    startupActionError,
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
    copyPathItem,
    deleteItem,
    deleteItems,
    togglePinned,
    setStartupEnabled,
    updateEditableSettings,
    clearCurrent,
    load,
  };
}
