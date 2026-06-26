import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

export type ContextMenuItem = {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onClick?: () => void;
};

type ContextMenuProps = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Delay to avoid the same click that opened the menu
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
    });
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  const adjustedX = Math.min(x, window.innerWidth - 180);
  const adjustedY = Math.min(y, window.innerHeight - items.length * 40 - 16);

  return (
    <>
      <div className="context-menu-backdrop" onClick={onClose} />
      <div
        ref={menuRef}
        className="context-menu"
        style={{ left: adjustedX, top: adjustedY }}
      >
        {items.map((item, i) =>
          item.label === "---" ? (
            <hr key={i} className="context-menu-separator" />
          ) : (
          <button
            key={i}
            className={`context-menu-item${item.danger ? " danger" : ""}`}
            onClick={() => {
              item.onClick?.();
              onClose();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
          )
        )}
      </div>
    </>
  );
}


