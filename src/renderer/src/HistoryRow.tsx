import type { ReactNode } from "react";
import { IconClipboard, IconCopy, IconImage, IconPin, IconPinOff, IconTrash2 } from "./icons";
import type { HistoryItem } from "../../shared/types";
import { formatBytes } from "../../shared/format";

type HistoryRowProps = {
  item: HistoryItem;
  selected: boolean;
  focused: boolean;
  searchQuery: string;
  onCopy: (id: string) => void;
  onTogglePin: (item: HistoryItem) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string, checked: boolean) => void;
  onDoubleClick: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, item: HistoryItem) => void;
  onImageClick: (item: HistoryItem) => void;
};

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function highlightText(text: string, query: string): ReactNode {
  if (!query.trim()) {
    return <>{text}</>;
  }

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i}>{part}</mark>
          : part
      )}
    </>
  );
}

export function HistoryRow({
  item,
  selected,
  focused,
  searchQuery,
  onCopy,
  onTogglePin,
  onDelete,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onImageClick
}: HistoryRowProps) {
  const classNames = [
    "history-row",
    selected ? "selected" : "",
    focused ? "focused" : ""
  ].filter(Boolean).join(" ");

  return (
    <article
      className={classNames}
      tabIndex={-1}
      data-id={item.id}
      onDoubleClick={() => onDoubleClick(item.id)}
      onContextMenu={(e) => onContextMenu(e, item)}
    >
      <input
        className="row-checkbox"
        type="checkbox"
        checked={selected}
        onChange={(e) => onSelect(item.id, e.target.checked)}
        onClick={(e) => e.stopPropagation()}
        aria-label="选择条目"
      />
      <div className="row-kind">
        {item.type === "image" ? <IconImage size={18} /> : <IconClipboard size={18} />}
      </div>
      <div className="row-content">
        {item.type === "text" ? (
          <p className="text-preview">{highlightText(item.text, searchQuery)}</p>
        ) : (
          <div className="image-preview">
            <img
              src={item.thumbnailDataUrl}
              alt="剪贴板图片缩略图"
              onClick={(e) => {
                e.stopPropagation();
                onImageClick(item);
              }}
            />
            <span className="image-info">
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
        <button className="icon-button" type="button" title="复制" onClick={() => onCopy(item.id)}>
          <IconCopy size={16} />
        </button>
        <button className="icon-button" type="button" title={item.pinned ? "取消置顶" : "置顶"} onClick={() => onTogglePin(item)}>
          {item.pinned ? <IconPinOff size={16} /> : <IconPin size={16} />}
        </button>
        <button className="icon-button danger" type="button" title="删除" onClick={() => {
          if (window.confirm("确定要删除这条记录吗？")) {
            onDelete(item.id);
          }
        }}>
          <IconTrash2 size={16} />
        </button>
      </div>
    </article>
  );
}
