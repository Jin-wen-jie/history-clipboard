import { useEffect, useMemo, useState } from "react";
import { IconLink, IconMinus, IconPlus, IconX } from "./icons";
import { formatBytes } from "../../shared/format";
import type { HistoryItem, HistoryPreviewResult } from "../../shared/types";

const TEXT_CHUNK_SIZE = 100_000;

type ContentPreviewProps = {
  item: HistoryItem;
  onClose: () => void;
  onCopyPath: (id: string) => Promise<{ ok: boolean; reason?: "missing" | "unsupported" | "export-failed" }>;
  onAddToast: (text: string, type?: "success" | "error" | "info") => void;
};

export function ContentPreview({ item, onClose, onCopyPath, onAddToast }: ContentPreviewProps) {
  const [fontSize, setFontSize] = useState(16);
  const [visibleCharacters, setVisibleCharacters] = useState(TEXT_CHUNK_SIZE);
  const [preview, setPreview] = useState<HistoryPreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    setVisibleCharacters(TEXT_CHUNK_SIZE);
    setPreview(null);
    setImageUrl(null);
    if (item.type === "text" || (item.type === "file" && item.missing)) {
      setLoading(false);
      return;
    }

    let active = true;
    let objectUrl: string | null = null;
    setLoading(true);
    void window.clipHistory.preview(item.id).then((result) => {
      if (!active) return;
      setPreview(result);
      if (result.ok && result.type === "image") {
        objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(result.png)], { type: "image/png" }));
        setImageUrl(objectUrl);
      }
    }).catch(() => {
      if (active) setPreview({ ok: false, reason: "missing" });
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => {
      active = false;
      if (objectUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [item]);

  const previewText = useMemo(() => {
    if (item.type === "text") return item.text;
    return preview?.ok && preview.type === "file-text" ? preview.text : null;
  }, [item, preview]);
  const displayedText = previewText?.slice(0, visibleCharacters) ?? "";
  const hasMoreText = previewText !== null && displayedText.length < previewText.length;
  const hasTextViewer = previewText !== null;

  const previewFailure = item.type === "file" && item.missing
    ? "missing"
    : preview && !preview.ok
      ? preview.reason
      : null;

  function handleCopyPath() {
    void onCopyPath(item.id).then((result) => {
      if (result.ok) {
        onAddToast("已复制路径", "success");
      } else if (result.reason === "missing") {
        onAddToast("原文件已不存在", "error");
      } else {
        onAddToast("复制路径失败", "error");
      }
    });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal-content${item.type === "image" ? "" : " content-preview-modal"}`}
        role="dialog"
        aria-modal="true"
        aria-label={item.type === "text" ? "文本内容预览" : item.type === "image" ? "图片预览" : "文件信息预览"}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="关闭预览">
          <IconX size={20} />
        </button>
        {item.type === "image" ? (
          <>
            <img className="modal-image" src={imageUrl ?? item.thumbnailDataUrl} alt="剪贴板图片" />
            <div className="modal-image-info">
              <span>{item.width} × {item.height} 像素</span>
              <span>{loading ? "正在读取原图" : formatBytes(item.byteSize)}</span>
              <button className="modal-copy-path" type="button" onClick={handleCopyPath} title="复制图片文件路径">
                <IconLink size={14} />
                复制路径
              </button>
            </div>
          </>
        ) : (
          <>
            <header className="content-preview-header">
              <div>
                <strong>{item.type === "text" ? "文本内容" : item.name}</strong>
                <span>{item.type === "text" ? `${item.text.length.toLocaleString("zh-CN")} 个字符` : `${item.extension ? item.extension.toUpperCase() : "文件"} · ${formatBytes(item.byteSize)}`}</span>
              </div>
              {hasTextViewer ? (
                <div className="preview-font-controls" aria-label="字号调节">
                  <button type="button" title="缩小字号" disabled={fontSize <= 12} onClick={() => setFontSize((size) => Math.max(12, size - 2))}>
                    <IconMinus size={16} />
                  </button>
                  <span>{fontSize}</span>
                  <button type="button" title="放大字号" disabled={fontSize >= 32} onClick={() => setFontSize((size) => Math.min(32, size + 2))}>
                    <IconPlus size={16} />
                  </button>
                </div>
              ) : null}
            </header>
            {hasTextViewer ? (
              <>
                {item.type === "file" ? <div className="content-preview-source" title={item.path}>{item.path}</div> : null}
                <pre className="content-preview-text" style={{ fontSize }}>{displayedText}</pre>
                {hasMoreText ? (
                  <div className="content-preview-more">
                    <span>{displayedText.length.toLocaleString("zh-CN")} / {previewText.length.toLocaleString("zh-CN")}</span>
                    <button type="button" onClick={() => setVisibleCharacters((count) => count + TEXT_CHUNK_SIZE)}>继续加载</button>
                  </div>
                ) : null}
              </>
            ) : item.type === "file" ? (
              <div className="content-preview-file">
                <span>完整路径</span>
                <div className="content-preview-path-row">
                  <p>{item.path}</p>
                  <button className="modal-copy-path" type="button" onClick={handleCopyPath} title="复制文件路径">
                    <IconLink size={14} />
                    复制路径
                  </button>
                </div>
                <span>文件大小</span>
                <p>{formatBytes(item.byteSize)}</p>
                <span>内容预览</span>
                <p className={previewFailure === "missing" ? "preview-error" : ""}>
                  {loading
                    ? "正在读取"
                    : previewFailure === "missing"
                      ? "原文件已不存在"
                      : previewFailure === "too-large"
                        ? "文件超过 2 MB"
                        : "此文件类型不支持内容预览"}
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
