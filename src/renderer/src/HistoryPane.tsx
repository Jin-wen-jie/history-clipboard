import { useCallback, useEffect, useState } from "react";
import { IconClipboard, IconCopy, IconPin, IconPinOff, IconRefreshCw, IconSearch, IconTrash2 } from "./icons";
import type { HistoryFilterType, HistoryItem } from "../../shared/types";
import { HistoryRow } from "./HistoryRow";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ImagePreview } from "./ImagePreview";
import type { LoadState } from "./useClipboardHistory";

type HistoryPaneProps = {
  items: HistoryItem[];
  filterType: HistoryFilterType;
  search: string;
  loadState: LoadState;
  lastAction: string;
  hasSearchQuery: boolean;
  historyListRef: React.RefObject<HTMLElement | null>;
  onFilterChange: (type: HistoryFilterType) => void;
  onSearchChange: (query: string) => void;
  onRefresh: () => void;
  onCopy: (id: string) => void;
  onTogglePin: (item: HistoryItem) => void;
  onDelete: (id: string) => void;
  onDeleteMany: (ids: string[]) => void;
  onCopyItem: (id: string) => void;
  onAddToast: (text: string, type?: "success" | "error" | "info") => void;
};

function labelForType(type: HistoryFilterType): string {
  if (type === "text") return "文本";
  if (type === "image") return "图片";
  return "全部";
}

function SkeletonRow() {
  return (
    <div className="history-row skeleton-row" aria-hidden="true">
      <div className="row-kind skeleton-box" style={{ width: 36, height: 36, borderRadius: 8 }} />
      <div className="row-content">
        <div className="skeleton-box" style={{ width: "70%", height: 14, marginBottom: 8 }} />
        <div className="skeleton-box" style={{ width: "40%", height: 12 }} />
      </div>
    </div>
  );
}

export function HistoryPane({
  items,
  filterType,
  search,
  loadState,
  lastAction,
  hasSearchQuery,
  historyListRef,
  onFilterChange,
  onSearchChange,
  onRefresh,
  onCopy,
  onTogglePin,
  onDelete,
  onDeleteMany,
  onCopyItem,
  onAddToast
}: HistoryPaneProps) {
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; item: HistoryItem | null } | null>(null);

  // Image preview state
  const [previewItem, setPreviewItem] = useState<HistoryItem | null>(null);

  const isLoading = loadState === "loading";
  const isEmpty = items.length === 0 && !isLoading;
  const selectedCount = selectedIds.size;

  // Reset selection/focus when items change
  useEffect(() => {
    setSelectedIds(new Set());
    setFocusedIndex(-1);
  }, [items]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (items.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusedIndex((prev) => {
          const next = prev < items.length - 1 ? prev + 1 : 0;
          scrollToItem(next);
          return next;
        });
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusedIndex((prev) => {
          const next = prev > 0 ? prev - 1 : items.length - 1;
          scrollToItem(next);
          return next;
        });
        break;
      case "Enter":
        e.preventDefault();
        if (focusedIndex >= 0 && focusedIndex < items.length) {
          onCopyItem(items[focusedIndex].id);
          onAddToast("已复制到剪贴板", "success");
        }
        break;
      case "Delete":
        e.preventDefault();
        if (selectedCount > 0) {
          if (window.confirm(`确定要删除选中的 ${selectedCount} 条记录吗？`)) {
            onDeleteMany(Array.from(selectedIds));
            onAddToast(`已删除 ${selectedCount} 条记录`, "info");
            setSelectedIds(new Set());
          }
        } else if (focusedIndex >= 0 && focusedIndex < items.length) {
          if (window.confirm("确定要删除这条记录吗？")) {
            onDelete(items[focusedIndex].id);
            onAddToast("已删除", "info");
          }
        }
        break;
      case "a":
      case "A":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (selectedCount === items.length) {
            setSelectedIds(new Set());
          } else {
            setSelectedIds(new Set(items.map((item) => item.id)));
          }
        }
        break;
    }
  }, [items, focusedIndex, selectedCount, selectedIds, onCopyItem, onDelete, onAddToast]);

  function scrollToItem(index: number) {
    const el = listEl?.querySelector(`[data-id="${items[index]?.id}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function toggleSelect(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function handleBatchDelete() {
    if (selectedCount === 0) return;
    if (window.confirm(`确定要删除选中的 ${selectedCount} 条记录吗？此操作不可撤销。`)) {
      onDeleteMany(Array.from(selectedIds));
      onAddToast(`已删除 ${selectedCount} 条记录`, "info");
      setSelectedIds(new Set());
    }
  }

  function handleDoubleClick(id: string) {
    onCopyItem(id);
    onAddToast("已复制到剪贴板", "success");
  }

  // Context menu handlers
  function handleContextMenu(e: React.MouseEvent, item: HistoryItem) {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, item });
  }

  function closeContextMenu() {
    setCtxMenu(null);
  }

  function ctxCopy() {
    if (ctxMenu?.item) {
      onCopyItem(ctxMenu.item.id);
      onAddToast("已复制到剪贴板", "success");
    }
  }

  function ctxTogglePin() {
    if (ctxMenu?.item) {
      onTogglePin(ctxMenu.item);
    }
  }

  function ctxDelete() {
    if (ctxMenu?.item) {
      if (window.confirm("确定要删除这条记录吗？")) {
        onDelete(ctxMenu.item.id);
        onAddToast("已删除", "info");
      }
    }
  }

  // Image preview
  function handleImageClick(item: HistoryItem) {
    setPreviewItem(item);
  }

  const contextMenuItems: ContextMenuItem[] = ctxMenu?.item
    ? [
        { label: "复制", icon: <IconCopy size={15} />, onClick: ctxCopy },
        { label: ctxMenu.item.pinned ? "取消置顶" : "置顶", icon: ctxMenu.item.pinned ? <IconPinOff size={15} /> : <IconPin size={15} />, onClick: ctxTogglePin },
        { label: "---" },
        { label: "删除", icon: <IconTrash2 size={15} />, danger: true, onClick: ctxDelete }
      ]
    : [];

  function clearDateFilter() {
    setDateFrom("");
    setDateTo("");
  }

  return (
    <section className="history-pane">
      {/* Top bar */}
      <header className="topbar">
        <div>
          <p className="eyebrow">本地记录</p>
          <h1>历史剪贴板</h1>
        </div>
        <button className="icon-button" type="button" title="刷新" onClick={onRefresh}>
          <IconRefreshCw size={18} />
        </button>
      </header>

      {/* Search + Filter */}
      <div className="toolbar">
        <label className="search-box">
          <IconSearch size={16} />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索文本内容…"
            aria-label="搜索文本历史记录"
          />
        </label>
        <div className="segments" role="tablist" aria-label="筛选类型">
          {(["all", "text", "image"] as HistoryFilterType[]).map((type) => (
            <button
              key={type}
              className={filterType === type ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={filterType === type}
              onClick={() => onFilterChange(type)}
            >
              {labelForType(type)}
            </button>
          ))}
        </div>
      </div>

      {/* Date filter */}
      {(dateFrom || dateTo) && (
        <div className="date-filters">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="开始日期"
          />
          <span style={{ color: "var(--color-text-tertiary)", fontSize: 12, alignSelf: "center" }}>至</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="结束日期"
          />
          <button className="icon-button" type="button" title="清除日期筛选" onClick={clearDateFilter} style={{ width: 32, height: 32 }}>
            <IconTrash2 size={14} />
          </button>
        </div>
      )}

      {/* Status line */}
      <div className="status-line" aria-live="polite">
        {loadState === "error" ? (
          <span className="status-error">读取失败{lastAction ? `：${lastAction}` : ""}</span>
        ) : isLoading ? (
          <span className="status-loading">加载中…</span>
        ) : (
          <span>最近 {items.length} 条记录</span>
        )}
        <span>{!isLoading && lastAction ? lastAction : ""}</span>
      </div>

      {/* Search hint */}
      {hasSearchQuery && (
        <div className="search-hint">搜索仅支持文本内容，图片已被过滤</div>
      )}

      {/* Batch actions */}
      {selectedCount > 0 && (
        <div className="toolbar-actions">
          <span className="selected-count">已选 {selectedCount} 项</span>
          <button
            className="icon-button danger"
            type="button"
            title="删除选中"
            onClick={handleBatchDelete}
            style={{ width: "auto", padding: "0 12px", gap: 6 }}
          >
            <IconTrash2 size={14} />
            <span style={{ fontSize: 12 }}>删除选中</span>
          </button>
        </div>
      )}

      {/* History list */}
      <div
        className="history-list"
        ref={(el) => {
          setListEl(el);
          if (historyListRef && "current" in historyListRef) {
            (historyListRef as React.MutableRefObject<HTMLElement | null>).current = el;
          }
        }}
        role="listbox"
        aria-label="剪贴板历史"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {isLoading && items.length === 0 ? (
          <>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        ) : isEmpty ? (
          <div className="empty-state">
            <IconClipboard size={32} />
            <span>暂无记录</span>
          </div>
        ) : (
          items.map((item, index) => (
            <HistoryRow
              key={item.id}
              item={item}
              selected={selectedIds.has(item.id)}
              focused={index === focusedIndex}
              searchQuery={search}
              onCopy={onCopy}
              onTogglePin={onTogglePin}
              onDelete={onDelete}
              onSelect={toggleSelect}
              onDoubleClick={handleDoubleClick}
              onContextMenu={handleContextMenu}
              onImageClick={handleImageClick}
            />
          ))
        )}
      </div>

      {/* Context menu overlay */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
      )}

      {/* Image preview modal */}
      {previewItem && previewItem.type === "image" && (
        <ImagePreview
          src={previewItem.thumbnailDataUrl}
          width={previewItem.width}
          height={previewItem.height}
          byteSize={previewItem.byteSize}
          onClose={() => setPreviewItem(null)}
        />
      )}
    </section>
  );
}
