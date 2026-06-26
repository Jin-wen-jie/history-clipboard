import { useEffect } from "react";
import { IconX } from "./icons";

type ImagePreviewProps = {
  src: string;
  width: number;
  height: number;
  byteSize: number;
  onClose: () => void;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ImagePreview({ src, width, height, byteSize, onClose }: ImagePreviewProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="关闭预览">
          <IconX size={20} />
        </button>
        <img className="modal-image" src={src} alt="剪贴板图片" />
        <div className="modal-image-info">
          <span>{width} × {height} 像素</span>
          <span>{formatBytes(byteSize)}</span>
        </div>
      </div>
    </div>
  );
}
