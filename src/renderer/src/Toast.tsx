import { useState, useCallback, useEffect } from "react";
import { IconX } from "./icons";

export type ToastType = "success" | "error" | "info";

type ToastItemData = {
  id: number;
  text: string;
  type: ToastType;
};

let nextId = 1;

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItemData[]>([]);

  const addToast = useCallback((text: string, type: ToastType = "info") => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, text, type }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, removeToast };
}

export function ToastContainer({
  toasts,
  onRemove
}: {
  toasts: ToastItemData[];
  onRemove: (id: number) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <ToastItem key={t.id} item={t} onRemove={onRemove} />
      ))}
    </div>
  );
}

function ToastItem({
  item,
  onRemove
}: {
  item: ToastItemData;
  onRemove: (id: number) => void;
}) {
  const [exiting, setExiting] = useState(false);
  const [removed, setRemoved] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setExiting(true), 2700);
    const t2 = setTimeout(() => {
      setRemoved(true);
      onRemove(item.id);
    }, 2900);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [item.id, onRemove]);

  if (removed) return null;

  return (
    <div
      className={`toast ${item.type}`}
      style={{
        animation: exiting
          ? "toastOut 200ms ease forwards"
          : "toastIn 200ms ease"
      }}
    >
      <span style={{ flex: 1 }}>{item.text}</span>
      <button
        onClick={() => {
          setExiting(true);
          setTimeout(() => {
            setRemoved(true);
            onRemove(item.id);
          }, 200);
        }}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "inherit",
          padding: 0,
          display: "flex",
          opacity: 0.5,
          flexShrink: 0
        }}
        aria-label="关闭"
      >
        <IconX size={14} />
      </button>
    </div>
  );
}
