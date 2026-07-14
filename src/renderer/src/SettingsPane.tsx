import { IconCheck, IconPause, IconPlay, IconSave, IconSettings, IconTrash2 } from "./icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  ClipboardBackgroundState,
  EditableSettingsPatch,
  StartupState,
  StorageStats
} from "../../shared/types";
import { formatBytes } from "../../shared/format";

type SettingsPaneProps = {
  settings: AppSettings | undefined;
  stats: StorageStats | undefined;
  startupState: StartupState | undefined;
  backgroundState: ClipboardBackgroundState | undefined;
  startupActionPending: boolean;
  imageBytes: string;
  onToggleCapture: () => void;
  onToggleLaunchAtStartup: (enabled: boolean) => void;
  onClear: () => void;
  onSaveSettings: (patch: EditableSettingsPatch) => void;
  addToast: (text: string, type?: "success" | "error" | "info") => void;
};

export function SettingsPane({
  settings,
  stats,
  startupState,
  backgroundState,
  startupActionPending,
  imageBytes,
  onToggleCapture,
  onToggleLaunchAtStartup,
  onClear,
  onSaveSettings,
  addToast
}: SettingsPaneProps) {
  const [editing, setEditing] = useState(false);
  const [editRetentionDays, setEditRetentionDays] = useState(30);
  const [editMaxItems, setEditMaxItems] = useState(500);
  const [editMaxImageBytes, setEditMaxImageBytes] = useState(10);
  const [editHotkey, setEditHotkey] = useState("Ctrl+Alt+V");
  const captureStatus = getCaptureStatus(settings, startupState, backgroundState);
  const startupEnabled = startupState?.error
    ? startupState.actualEnabled ?? false
    : startupState?.desiredEnabled ?? false;

  function startEditing(): void {
    setEditRetentionDays(settings?.retentionDays ?? 30);
    setEditMaxItems(settings?.maxItems ?? 500);
    setEditMaxImageBytes((settings?.maxImageBytes ?? 10 * 1024 * 1024) / (1024 * 1024));
    setEditHotkey(settings?.hotkey ?? "Ctrl+Alt+V");
    setEditing(true);
  }

  function saveSettings(): void {
    onSaveSettings({
      retentionDays: editRetentionDays,
      maxItems: editMaxItems,
      maxImageBytes: editMaxImageBytes * 1024 * 1024,
      hotkey: editHotkey
    });
    setEditing(false);
  }

  return (
    <aside className="settings-pane">
      <div className="pane-title">
        <IconSettings size={18} />
        <span>设置</span>
      </div>

      <button
        className={`wide-toggle ${settings?.captureEnabled ? "on" : ""}`}
        type="button"
        onClick={onToggleCapture}
      >
        {settings?.captureEnabled ? <IconPause size={18} /> : <IconPlay size={18} />}
        <span>{settings?.captureEnabled ? "暂停记录" : "恢复记录"}</span>
      </button>

      <div
        className={`capture-status${captureStatus ? ` ${captureStatus.tone}` : ""}`}
        data-testid="capture-status"
        role="status"
        aria-label="后台记录状态"
        aria-live="polite"
      >
        {captureStatus && (
          <>
            <span className="capture-status-dot" aria-hidden="true" />
            <span>{captureStatus.label}</span>
          </>
        )}
      </div>

      <label className="switch-row">
        <span>开机自启</span>
        <input
          type="checkbox"
          checked={startupEnabled}
          disabled={!startupState || startupActionPending}
          onChange={(event) => onToggleLaunchAtStartup(event.target.checked)}
        />
      </label>

      <label className="switch-row">
        <span>敏感内容过滤</span>
        <input
          type="checkbox"
          checked={settings?.sensitiveFilterEnabled ?? false}
          disabled={!settings}
          onChange={(event) => onSaveSettings({ sensitiveFilterEnabled: event.target.checked })}
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

      <button className="clear-button" type="button" onClick={() => {
        if (window.confirm("确定要清空当前筛选的所有记录吗？此操作不可撤销。")) {
          onClear();
        }
      }}>
        <IconTrash2 size={17} />
        <span>清空当前筛选</span>
      </button>

      <div style={{ display: "flex", gap: 8 }}>
        <button className="wide-toggle" type="button" onClick={() => window.clipHistory?.exportHistory().then((r) => {
          if (r.ok) addToast("导出成功", "success");
          else if (r.reason !== "cancelled") addToast("导出失败", "error");
        })} style={{ flex: 1, fontSize: 12 }}>
          <IconSave size={15} />
          <span>导出备份</span>
        </button>
        <button className="wide-toggle" type="button" onClick={() => window.clipHistory?.importHistory().then((r) => {
          if (r.ok) addToast(`导入完成：${r.imported} 条导入，${r.skipped} 条跳过`, "success");
          else if (r.reason !== "cancelled") addToast("导入失败", "error");
        })} style={{ flex: 1, fontSize: 12 }}>
          <IconSave size={15} />
          <span>导入备份</span>
        </button>
      </div>

      <div className="limits">
        <IconCheck size={16} />
        <span>最近 {settings?.retentionDays ?? 30} 天 · 最多 {settings?.maxItems ?? 500} 条 · 单图 {formatBytes(settings?.maxImageBytes ?? 0)}</span>
      </div>

      <hr className="settings-divider" />

      {editing ? (
        <div className="settings-editor">
          <label className="edit-field">
            <span>保留天数</span>
            <input
              type="number"
              min={1}
              max={365}
              value={editRetentionDays}
              onChange={(e) => setEditRetentionDays(Number(e.target.value))}
            />
          </label>
          <label className="edit-field">
            <span>最大条数</span>
            <input
              type="number"
              min={10}
              max={10000}
              value={editMaxItems}
              onChange={(e) => setEditMaxItems(Number(e.target.value))}
            />
          </label>
          <label className="edit-field">
            <span>单图上限</span>
            <select value={editMaxImageBytes} onChange={(e) => setEditMaxImageBytes(Number(e.target.value))}>
              <option value={1}>1 MB</option>
              <option value={2}>2 MB</option>
              <option value={5}>5 MB</option>
              <option value={10}>10 MB</option>
              <option value={20}>20 MB</option>
              <option value={50}>50 MB</option>
            </select>
          </label>
          <label className="edit-field">
            <span>全局热键</span>
            <HotkeyRecorder value={editHotkey} onChange={setEditHotkey} />
          </label>
          <div className="edit-actions">
            <button className="edit-cancel" type="button" onClick={() => setEditing(false)}>
              取消
            </button>
            <button className="edit-save" type="button" onClick={saveSettings}>
              <IconSave size={16} />
              <span>保存设置</span>
            </button>
          </div>
        </div>
      ) : (
        <button className="edit-button" type="button" onClick={startEditing}>
          修改高级设置
        </button>
      )}
    </aside>
  );
}

type CaptureStatus = {
  label: "启动项异常" | "已暂停" | "轮询降级" | "正常监听";
  tone: "error" | "warning" | "success";
};

function getCaptureStatus(
  settings: AppSettings | undefined,
  startupState: StartupState | undefined,
  backgroundState: ClipboardBackgroundState | undefined
): CaptureStatus | undefined {
  if (startupState?.error) {
    return { label: "启动项异常", tone: "error" };
  }
  if (settings?.captureEnabled === false) {
    return { label: "已暂停", tone: "warning" };
  }
  if (backgroundState?.mode === "fallback" || backgroundState?.mode === "starting") {
    return { label: "轮询降级", tone: "warning" };
  }
  if (backgroundState?.mode === "listening") {
    return { label: "正常监听", tone: "success" };
  }
  return undefined;
}

// ── Hotkey Recorder ──

function HotkeyRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [display, setDisplay] = useState(value);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!recording) {
      setDisplay(value);
    }
  }, [value, recording]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      setRecording(false);
      setDisplay(value);
      return;
    }

    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");

    // Ignore modifier-only presses
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
      setDisplay(parts.join("+") + "+…");
      return;
    }

    // Map key names
    const keyMap: Record<string, string> = {
      " ": "Space",
      "ArrowUp": "Up",
      "ArrowDown": "Down",
      "ArrowLeft": "Left",
      "ArrowRight": "Right",
    };
    const keyName = keyMap[e.key] || e.key;

    if (!parts.includes(keyName)) {
      parts.push(keyName);
    }

    const result = parts.join("+");
    setDisplay(result);
    onChange(result);
    setRecording(false);
  }, [value, onChange]);

  useEffect(() => {
    if (recording) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [recording, handleKeyDown]);

  return (
    <div
      ref={ref}
      className={`hotkey-recorder${recording ? " recording" : ""}`}
      onClick={() => {
        setRecording(true);
        setDisplay("");
      }}
      tabIndex={0}
      role="button"
      aria-label="点击录制快捷键"
    >
      {recording ? (
        <span className="hint">按下快捷键… (Esc 取消)</span>
      ) : display ? (
        <span>{display}</span>
      ) : (
        <span className="hint">点击设置</span>
      )}
    </div>
  );
}

