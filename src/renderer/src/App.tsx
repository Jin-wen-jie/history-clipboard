import { Check, Clipboard, Copy, Image, Pause, Pin, PinOff, Play, RefreshCw, Search, Settings, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, HistoryFilterType, HistoryItem, StorageStats } from "../../shared/types";

type LoadState = "idle" | "loading" | "error";

export function App() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [settings, setSettings] = useState<AppSettings | undefined>();
  const [stats, setStats] = useState<StorageStats | undefined>();
  const [filterType, setFilterType] = useState<HistoryFilterType>("all");
  const [search, setSearch] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [lastAction, setLastAction] = useState("");
  const historyListRef = useRef<HTMLElement | null>(null);
  const latestItemIdRef = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      if (!window.clipHistory) {
        throw new Error("桌面桥接未加载，请重新安装或重启应用");
      }

      const [nextSettings, nextStats, nextItems] = await Promise.all([
        window.clipHistory.getSettings(),
        window.clipHistory.getStats(),
        window.clipHistory.list({ type: filterType, search })
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
  }, [filterType, search]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 1500);
    return () => window.clearInterval(interval);
  }, [load]);

  const imageBytes = useMemo(() => formatBytes(stats?.imageBytes ?? 0), [stats]);

  async function copyItem(id: string): Promise<void> {
    const result = await window.clipHistory.copy(id);
    setLastAction(result.ok ? "已复制" : "复制失败");
    await load();
  }

  async function deleteItem(id: string): Promise<void> {
    await window.clipHistory.delete(id);
    setLastAction("已删除");
    await load();
  }

  async function togglePinned(item: HistoryItem): Promise<void> {
    await window.clipHistory.setPinned(item.id, !item.pinned);
    await load();
  }

  async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
    setSettings(await window.clipHistory.updateSettings(patch));
    await load();
  }

  async function clearCurrent(): Promise<void> {
    await window.clipHistory.clear(filterType);
    setLastAction("已清空");
    await load();
  }

  return (
    <main className="app-shell">
      <section className="history-pane">
        <header className="topbar">
          <div>
            <p className="eyebrow">本地记录</p>
            <h1>历史剪贴板</h1>
          </div>
          <button className="icon-button" type="button" title="刷新" onClick={() => void load()}>
            <RefreshCw size={18} />
          </button>
        </header>

        <div className="toolbar">
          <label className="search-box">
            <Search size={18} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文本" />
          </label>
          <div className="segments" aria-label="筛选类型">
            {(["all", "text", "image"] as HistoryFilterType[]).map((type) => (
              <button
                key={type}
                className={filterType === type ? "active" : ""}
                type="button"
                onClick={() => setFilterType(type)}
              >
                {labelForType(type)}
              </button>
            ))}
          </div>
        </div>

        <div className="status-line">
          <span>{loadState === "error" ? `读取失败${lastAction ? `：${lastAction}` : ""}` : `最近 ${items.length} 条记录`}</span>
          <span>{lastAction}</span>
        </div>

        <section className="history-list" aria-label="剪贴板历史" ref={historyListRef}>
          {items.length === 0 ? (
            <div className="empty-state">
              <Clipboard size={28} />
              <span>暂无记录</span>
            </div>
          ) : (
            items.map((item) => (
              <article className="history-row" key={item.id}>
                <div className="row-kind">{item.type === "image" ? <Image size={18} /> : <Clipboard size={18} />}</div>
                <div className="row-content">
                  {item.type === "text" ? (
                    <p className="text-preview">{item.text}</p>
                  ) : (
                    <div className="image-preview">
                      <img src={item.thumbnailDataUrl} alt="剪贴板图片缩略图" />
                      <span>
                        {item.width} x {item.height} · {formatBytes(item.byteSize)}
                      </span>
                    </div>
                  )}
                  <div className="row-meta">
                    <span>{formatDate(item.updatedAt)}</span>
                    <span>复制 {item.copyCount} 次</span>
                    {item.pinned ? <span className="pin-label">置顶</span> : null}
                  </div>
                </div>
                <div className="row-actions">
                  <button className="icon-button" type="button" title="复制" onClick={() => void copyItem(item.id)}>
                    <Copy size={17} />
                  </button>
                  <button className="icon-button" type="button" title={item.pinned ? "取消置顶" : "置顶"} onClick={() => void togglePinned(item)}>
                    {item.pinned ? <PinOff size={17} /> : <Pin size={17} />}
                  </button>
                  <button className="icon-button danger" type="button" title="删除" onClick={() => void deleteItem(item.id)}>
                    <Trash2 size={17} />
                  </button>
                </div>
              </article>
            ))
          )}
        </section>
      </section>

      <aside className="settings-pane">
        <div className="pane-title">
          <Settings size={18} />
          <span>设置</span>
        </div>

        <button
          className={`wide-toggle ${settings?.captureEnabled ? "on" : ""}`}
          type="button"
          onClick={() => void updateSettings({ captureEnabled: !settings?.captureEnabled })}
        >
          {settings?.captureEnabled ? <Pause size={18} /> : <Play size={18} />}
          <span>{settings?.captureEnabled ? "暂停记录" : "恢复记录"}</span>
        </button>

        <label className="switch-row">
          <span>开机自启</span>
          <input
            type="checkbox"
            checked={settings?.launchAtStartup ?? false}
            onChange={(event) => void updateSettings({ launchAtStartup: event.target.checked })}
          />
        </label>

        <div className="stat-grid">
          <div>
            <strong>{stats?.textItems ?? 0}</strong>
            <span>文本</span>
          </div>
          <div>
            <strong>{stats?.imageItems ?? 0}</strong>
            <span>图片</span>
          </div>
          <div>
            <strong>{imageBytes}</strong>
            <span>图片占用</span>
          </div>
          <div>
            <strong>{settings?.hotkey ?? "Ctrl+Alt+V"}</strong>
            <span>热键</span>
          </div>
        </div>

        <button className="clear-button" type="button" onClick={() => void clearCurrent()}>
          <Trash2 size={17} />
          <span>清空当前筛选</span>
        </button>

        <div className="limits">
          <Check size={16} />
          <span>最近 {settings?.retentionDays ?? 30} 天 · 最多 {settings?.maxItems ?? 500} 条 · 单图 {formatBytes(settings?.maxImageBytes ?? 0)}</span>
        </div>
      </aside>
    </main>
  );
}

function labelForType(type: HistoryFilterType): string {
  if (type === "text") return "文本";
  if (type === "image") return "图片";
  return "全部";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
