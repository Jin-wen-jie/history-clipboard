// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  type ClipboardBackgroundState,
  type ClipboardHistoryApi,
  type StartupState
} from "../../shared/types";
import { App } from "./App";

const DEFAULT_STARTUP_STATE: StartupState = {
  desiredEnabled: true,
  actualEnabled: true,
  pendingDecision: false,
  managed: true,
  error: null
};

const DEFAULT_BACKGROUND_STATE: ClipboardBackgroundState = {
  mode: "listening",
  helperPid: 1234,
  helperGeneration: 1,
  lastEventAt: null,
  lastSequence: null,
  restartCount: 0,
  nextRestartAt: null,
  gapCount: 0,
  filteredCount: 0,
  queueDepth: 0,
  queueBytes: 0,
  lastExit: null,
  lastError: null
};

function startupState(overrides: Partial<StartupState> = {}): StartupState {
  return { ...DEFAULT_STARTUP_STATE, ...overrides };
}

function backgroundState(
  overrides: Partial<ClipboardBackgroundState> = {}
): ClipboardBackgroundState {
  return { ...DEFAULT_BACKGROUND_STATE, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function mockClipHistory(overrides?: Partial<ClipboardHistoryApi>): ClipboardHistoryApi {
  return {
    list: vi.fn<ClipboardHistoryApi["list"]>().mockResolvedValue([]),
    copy: vi.fn<ClipboardHistoryApi["copy"]>().mockResolvedValue({ ok: true }),
    copyPath: vi.fn<ClipboardHistoryApi["copyPath"]>().mockResolvedValue({ ok: true, path: "C:\\mock\\file.png" }),
    preview: vi.fn<ClipboardHistoryApi["preview"]>().mockResolvedValue({ ok: false, reason: "unsupported" }),
    delete: vi.fn<ClipboardHistoryApi["delete"]>().mockResolvedValue({ ok: true }),
    deleteMany: vi.fn<ClipboardHistoryApi["deleteMany"]>().mockResolvedValue({ ok: true, count: 0 }),
    clear: vi.fn<ClipboardHistoryApi["clear"]>().mockResolvedValue(),
    setPinned: vi.fn<ClipboardHistoryApi["setPinned"]>().mockResolvedValue({ ok: true }),
    getSettings: vi.fn<ClipboardHistoryApi["getSettings"]>().mockResolvedValue(DEFAULT_SETTINGS),
    updateSettings: vi.fn<ClipboardHistoryApi["updateSettings"]>().mockResolvedValue(DEFAULT_SETTINGS),
    getStats: vi.fn<ClipboardHistoryApi["getStats"]>().mockResolvedValue({ totalItems: 0, textItems: 0, imageItems: 0, fileItems: 0, imageBytes: 0 }),
    getStartupState: vi.fn<ClipboardHistoryApi["getStartupState"]>().mockResolvedValue(DEFAULT_STARTUP_STATE),
    setStartupEnabled: vi.fn<ClipboardHistoryApi["setStartupEnabled"]>().mockResolvedValue(DEFAULT_STARTUP_STATE),
    getBackgroundState: vi.fn<ClipboardHistoryApi["getBackgroundState"]>().mockResolvedValue(DEFAULT_BACKGROUND_STATE),
    showWindow: vi.fn<ClipboardHistoryApi["showWindow"]>().mockResolvedValue(),
    exportHistory: vi.fn<ClipboardHistoryApi["exportHistory"]>().mockResolvedValue({ ok: true }),
    importHistory: vi.fn<ClipboardHistoryApi["importHistory"]>().mockResolvedValue({ ok: true, imported: 0, skipped: 0 }),
    ...overrides
  };
}

describe("App", () => {
  const originalClipHistory = window.clipHistory;

  afterEach(() => {
    window.clipHistory = originalClipHistory;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("loads recent clipboard items without a date range by default", async () => {
    const list = vi.fn<ClipboardHistoryApi["list"]>().mockResolvedValue([]);
    window.clipHistory = mockClipHistory({ list });

    render(<App />);

    await waitFor(() => {
      expect(list).toHaveBeenCalledWith({ type: "all", search: "" });
    });
  });

  test("scrolls back to the latest item when a new newest record appears", async () => {
    const oldItem = {
      id: "old",
      type: "text" as const,
      text: "old clipboard",
      createdAt: "2026-06-23T06:00:00.000Z",
      updatedAt: "2026-06-23T06:00:00.000Z",
      pinned: false,
      copyCount: 1
    };
    const newItem = {
      id: "new",
      type: "text" as const,
      text: "new clipboard",
      createdAt: "2026-06-23T06:01:00.000Z",
      updatedAt: "2026-06-23T06:01:00.000Z",
      pinned: false,
      copyCount: 1
    };
    const list = vi.fn<ClipboardHistoryApi["list"]>()
      .mockResolvedValueOnce([oldItem])
      .mockResolvedValue([newItem, oldItem]);
    window.clipHistory = mockClipHistory({ list });
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo;

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("old clipboard")).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("刷新"));

    await waitFor(() => {
      expect(screen.getByText("new clipboard")).toBeTruthy();
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    });
  });

  test("opens a full text preview and adjusts its font size", async () => {
    const item = {
      id: "preview-text",
      type: "text" as const,
      text: "第一行\n第二行完整内容",
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:00:00.000Z",
      pinned: false,
      copyCount: 1
    };
    window.clipHistory = mockClipHistory({
      list: vi.fn<ClipboardHistoryApi["list"]>().mockResolvedValue([item])
    });
    const { container } = render(<App />);
    await screen.findByText(/第一行/);

    fireEvent.click(screen.getByTitle("查看内容"));

    expect(screen.getByRole("dialog", { name: "文本内容预览" })).toBeTruthy();
    const preview = container.querySelector(".content-preview-text") as HTMLElement;
    expect(preview.textContent).toBe(item.text);
    expect(preview.style.fontSize).toBe("16px");
    fireEvent.click(screen.getByTitle("放大字号"));
    expect(preview.style.fontSize).toBe("18px");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "文本内容预览" })).toBeNull();
  });

  test("loads long clipboard text in bounded chunks", async () => {
    const text = "长".repeat(100_001);
    window.clipHistory = mockClipHistory({
      list: vi.fn<ClipboardHistoryApi["list"]>().mockResolvedValue([{
        id: "long-text",
        type: "text",
        text,
        createdAt: "2026-07-14T10:00:00.000Z",
        updatedAt: "2026-07-14T10:00:00.000Z",
        pinned: false,
        copyCount: 1
      }])
    });
    const { container } = render(<App />);
    await screen.findByTitle("查看内容");

    fireEvent.click(screen.getByTitle("查看内容"));

    const preview = container.querySelector(".content-preview-text") as HTMLElement;
    expect(preview.textContent).toHaveLength(100_000);
    fireEvent.click(screen.getByRole("button", { name: "继续加载" }));
    expect(preview.textContent).toHaveLength(100_001);
  });

  test("replaces the thumbnail with original image data in preview", async () => {
    const preview = vi.fn<ClipboardHistoryApi["preview"]>().mockResolvedValue({
      ok: true,
      type: "image",
      png: Uint8Array.from([137, 80, 78, 71])
    });
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:original-image") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    try {
      window.clipHistory = mockClipHistory({
        preview,
        list: vi.fn<ClipboardHistoryApi["list"]>().mockResolvedValue([{
          id: "image-preview",
          type: "image",
          thumbnailDataUrl: "data:image/png;base64,dGh1bWI=",
          width: 1920,
          height: 1080,
          byteSize: 4,
          createdAt: "2026-07-14T10:00:00.000Z",
          updatedAt: "2026-07-14T10:00:00.000Z",
          pinned: false,
          copyCount: 1
        }])
      });
      render(<App />);
      await screen.findByTitle("查看内容");

      fireEvent.click(screen.getByTitle("查看内容"));

      const image = await screen.findByAltText("剪贴板图片") as HTMLImageElement;
      await waitFor(() => expect(image.src).toContain("blob:original-image"));
      expect(preview).toHaveBeenCalledWith("image-preview");
      fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "图片预览" })).toBeNull());
    } finally {
      if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
      else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
      if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
      else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
  });

  test("shows the complete path in a file preview", async () => {
    const item = {
      id: "preview-file",
      type: "file" as const,
      path: "C:\\work\\reports\\data.json",
      name: "data.json",
      extension: "json",
      byteSize: 128,
      missing: false,
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:00:00.000Z",
      pinned: false,
      copyCount: 1
    };
    window.clipHistory = mockClipHistory({
      preview: vi.fn<ClipboardHistoryApi["preview"]>().mockResolvedValue({
        ok: true,
        type: "file-text",
        text: "{\n  \"enabled\": true\n}",
        formatted: true
      }),
      list: vi.fn<ClipboardHistoryApi["list"]>().mockResolvedValue([item])
    });
    render(<App />);
    await screen.findByText("data.json");

    fireEvent.doubleClick(screen.getByText("data.json"));

    const dialog = screen.getByRole("dialog", { name: "文件信息预览" });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText(item.path)).toBeTruthy();
    await waitFor(() => {
      expect(dialog.querySelector(".content-preview-text")?.textContent).toContain('"enabled": true');
    });
  });

  test("marks a missing file in the history list", async () => {
    window.clipHistory = mockClipHistory({
      list: vi.fn<ClipboardHistoryApi["list"]>().mockResolvedValue([{
        id: "missing-file",
        type: "file",
        path: "C:\\missing\\notes.txt",
        name: "notes.txt",
        extension: "txt",
        byteSize: 10,
        missing: true,
        createdAt: "2026-07-14T10:00:00.000Z",
        updatedAt: "2026-07-14T10:00:00.000Z",
        pinned: false,
        copyCount: 1
      }])
    });

    render(<App />);

    expect(await screen.findByText("原文件不存在")).toBeTruthy();
  });

  test("renders a slow initial load after a polling interval elapses", async () => {
    vi.useFakeTimers();
    const initialList = deferred<Awaited<ReturnType<ClipboardHistoryApi["list"]>>>();
    const slowItem = {
      id: "slow",
      type: "text" as const,
      text: "slow clipboard",
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:00:00.000Z",
      pinned: false,
      copyCount: 1
    };
    const list = vi.fn<ClipboardHistoryApi["list"]>()
      .mockReturnValueOnce(initialList.promise)
      .mockReturnValue(new Promise(() => undefined));
    window.clipHistory = mockClipHistory({ list });

    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(list).toHaveBeenCalledTimes(1);

    await act(async () => {
      initialList.resolve([slowItem]);
      await initialList.promise;
    });

    expect(screen.getByText("slow clipboard")).toBeTruthy();
  });

  test.each([
    [true, "启用后台记录"],
    [false, "暂不启用"]
  ])("records an undecided startup choice %s", async (enabled, buttonName) => {
    const setStartupEnabled = vi.fn<ClipboardHistoryApi["setStartupEnabled"]>()
      .mockResolvedValue(startupState({
        desiredEnabled: enabled,
        actualEnabled: enabled,
        pendingDecision: false
      }));
    window.clipHistory = mockClipHistory({
      getStartupState: vi.fn<ClipboardHistoryApi["getStartupState"]>()
        .mockResolvedValue(startupState({
          desiredEnabled: false,
          actualEnabled: false,
          pendingDecision: true
        })),
      setStartupEnabled
    });

    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "后台记录" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: buttonName }));

    await waitFor(() => {
      expect(setStartupEnabled).toHaveBeenCalledWith(enabled);
      expect(screen.queryByRole("dialog", { name: "后台记录" })).toBeNull();
    });
  });

  test("does not show the startup prompt after a decision", async () => {
    const getStartupState = vi.fn<ClipboardHistoryApi["getStartupState"]>()
      .mockResolvedValue(startupState({ pendingDecision: false }));
    window.clipHistory = mockClipHistory({ getStartupState });

    render(<App />);

    await waitFor(() => expect(getStartupState).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "后台记录" })).toBeNull();
  });

  test("does not write a startup decision when the prompt unmounts", async () => {
    const setStartupEnabled = vi.fn<ClipboardHistoryApi["setStartupEnabled"]>();
    window.clipHistory = mockClipHistory({
      getStartupState: vi.fn<ClipboardHistoryApi["getStartupState"]>()
        .mockResolvedValue(startupState({ pendingDecision: true })),
      setStartupEnabled
    });

    const { unmount } = render(<App />);
    await screen.findByRole("dialog", { name: "后台记录" });
    unmount();

    expect(setStartupEnabled).not.toHaveBeenCalled();
  });

  test("unblocks the history list when choosing startup behavior fails", async () => {
    const setStartupEnabled = vi.fn<ClipboardHistoryApi["setStartupEnabled"]>()
      .mockRejectedValue(new Error("启动设置失败"));
    window.clipHistory = mockClipHistory({
      getStartupState: vi.fn<ClipboardHistoryApi["getStartupState"]>()
        .mockResolvedValue(startupState({ pendingDecision: true })),
      setStartupEnabled
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "启用后台记录" }));

    await waitFor(() => expect(setStartupEnabled).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("dialog", { name: "后台记录" })).toBeNull();
    expect(screen.getByRole("listbox", { name: "剪贴板历史" })).toBeTruthy();
  });

  test("keeps the startup setting retryable without blocking the history list", async () => {
    const setStartupEnabled = vi.fn<ClipboardHistoryApi["setStartupEnabled"]>()
      .mockResolvedValueOnce(startupState({
        desiredEnabled: true,
        actualEnabled: null,
        pendingDecision: false,
        error: "apply-failed"
      }))
      .mockResolvedValueOnce(startupState({
        desiredEnabled: true,
        actualEnabled: true,
        pendingDecision: false,
        error: null
      }));
    window.clipHistory = mockClipHistory({
      getStartupState: vi.fn<ClipboardHistoryApi["getStartupState"]>()
        .mockResolvedValue(startupState({ pendingDecision: true })),
      setStartupEnabled
    });

    render(<App />);
    const enableButton = await screen.findByRole<HTMLButtonElement>("button", { name: "启用后台记录" });
    fireEvent.click(enableButton);

    await waitFor(() => expect(setStartupEnabled).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "后台记录" })).toBeNull();
    expect(screen.getByRole("listbox", { name: "剪贴板历史" })).toBeTruthy();

    const startupToggle = screen.getByRole<HTMLInputElement>("checkbox", { name: "开机自启" });
    expect(startupToggle.checked).toBe(false);
    fireEvent.click(startupToggle);
    await waitFor(() => {
      expect(setStartupEnabled).toHaveBeenCalledTimes(2);
      expect(startupToggle.checked).toBe(true);
    });
  });

  test("keeps the startup prompt open while the returned state is still pending", async () => {
    const setStartupEnabled = vi.fn<ClipboardHistoryApi["setStartupEnabled"]>()
      .mockResolvedValue(startupState({ pendingDecision: true }));
    window.clipHistory = mockClipHistory({
      getStartupState: vi.fn<ClipboardHistoryApi["getStartupState"]>()
        .mockResolvedValue(startupState({ pendingDecision: true })),
      setStartupEnabled
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "启用后台记录" }));

    await waitFor(() => expect(setStartupEnabled).toHaveBeenCalledWith(true));
    expect(screen.getByRole("dialog", { name: "后台记录" })).toBeTruthy();
  });

  test("disables both startup choices while one is pending", async () => {
    const pendingChoice = deferred<StartupState>();
    const setStartupEnabled = vi.fn<ClipboardHistoryApi["setStartupEnabled"]>()
      .mockReturnValue(pendingChoice.promise);
    window.clipHistory = mockClipHistory({
      getStartupState: vi.fn<ClipboardHistoryApi["getStartupState"]>()
        .mockResolvedValue(startupState({ pendingDecision: true })),
      setStartupEnabled
    });

    render(<App />);
    const enableButton = await screen.findByRole<HTMLButtonElement>("button", { name: "启用后台记录" });
    const declineButton = screen.getByRole<HTMLButtonElement>("button", { name: "暂不启用" });
    fireEvent.click(enableButton);

    expect(enableButton.disabled).toBe(true);
    expect(declineButton.disabled).toBe(true);
    fireEvent.click(enableButton);
    expect(setStartupEnabled).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingChoice.resolve(startupState({ pendingDecision: false }));
      await pendingChoice.promise;
    });
  });

  test("uses the dedicated startup API for the settings toggle", async () => {
    const updateSettings = vi.fn<ClipboardHistoryApi["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SETTINGS);
    const setStartupEnabled = vi.fn<ClipboardHistoryApi["setStartupEnabled"]>()
      .mockResolvedValue(startupState({
        desiredEnabled: false,
        actualEnabled: false
      }));
    window.clipHistory = mockClipHistory({ updateSettings, setStartupEnabled });

    render(<App />);
    const startupToggle = await screen.findByRole<HTMLInputElement>("checkbox", { name: "开机自启" });
    await waitFor(() => {
      expect(startupToggle.checked).toBe(true);
      expect(startupToggle.disabled).toBe(false);
    });
    fireEvent.click(startupToggle);

    await waitFor(() => expect(setStartupEnabled).toHaveBeenCalledWith(false));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  test("updates only the sensitive filter setting", async () => {
    const updateSettings = vi.fn<ClipboardHistoryApi["updateSettings"]>()
      .mockResolvedValue({ ...DEFAULT_SETTINGS, sensitiveFilterEnabled: true });
    window.clipHistory = mockClipHistory({ updateSettings });

    render(<App />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "敏感内容过滤" }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({ sensitiveFilterEnabled: true });
    });
  });

  test("saves the configured maximum text length from advanced settings", async () => {
    const updateSettings = vi.fn<ClipboardHistoryApi["updateSettings"]>()
      .mockResolvedValue({ ...DEFAULT_SETTINGS, maxTextLength: 3_000_000 });
    window.clipHistory = mockClipHistory({ updateSettings });

    render(<App />);
    fireEvent.click(await screen.findByTestId("advanced-settings-button"));
    fireEvent.change(screen.getByTestId("max-text-length-input"), {
      target: { value: "3000000" }
    });
    fireEvent.click(screen.getByTestId("save-advanced-settings-button"));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
        maxTextLength: 3_000_000
      }));
    });
  });

  test.each([
    {
      name: "startup errors override paused and fallback states",
      settings: { ...DEFAULT_SETTINGS, captureEnabled: false },
      startup: startupState({ error: "state-mismatch" }),
      background: backgroundState({ mode: "fallback" }),
      expected: "启动项异常"
    },
    {
      name: "capture disabled overrides fallback",
      settings: { ...DEFAULT_SETTINGS, captureEnabled: false },
      startup: startupState(),
      background: backgroundState({ mode: "fallback" }),
      expected: "已暂停"
    },
    {
      name: "fallback mode reports degraded polling",
      settings: DEFAULT_SETTINGS,
      startup: startupState(),
      background: backgroundState({ mode: "fallback" }),
      expected: "轮询降级"
    },
    {
      name: "listening mode reports normal capture",
      settings: DEFAULT_SETTINGS,
      startup: startupState(),
      background: backgroundState({ mode: "listening" }),
      expected: "正常监听"
    }
  ])("shows $expected when $name", async ({ settings, startup, background, expected }) => {
    window.clipHistory = mockClipHistory({
      getSettings: vi.fn<ClipboardHistoryApi["getSettings"]>().mockResolvedValue(settings),
      getStartupState: vi.fn<ClipboardHistoryApi["getStartupState"]>().mockResolvedValue(startup),
      getBackgroundState: vi.fn<ClipboardHistoryApi["getBackgroundState"]>().mockResolvedValue(background)
    });

    render(<App />);

    expect(await screen.findByText(expected)).toBeTruthy();
  });

  test("keeps the status rail empty for stopped background state", async () => {
    window.clipHistory = mockClipHistory({
      getBackgroundState: vi.fn<ClipboardHistoryApi["getBackgroundState"]>()
        .mockResolvedValue(backgroundState({ mode: "stopped" }))
    });

    render(<App />);

    const statusRail = await screen.findByTestId("capture-status");
    await waitFor(() => expect(statusRail.textContent).toBe(""));
  });

  test("keeps clipboard items available when health APIs fail", async () => {
    const item = {
      id: "kept",
      type: "text" as const,
      text: "仍可读取的历史记录",
      createdAt: "2026-07-13T10:00:00.000Z",
      updatedAt: "2026-07-13T10:00:00.000Z",
      pinned: false,
      copyCount: 1
    };
    window.clipHistory = mockClipHistory({
      list: vi.fn<ClipboardHistoryApi["list"]>().mockResolvedValue([item]),
      getStartupState: vi.fn<ClipboardHistoryApi["getStartupState"]>()
        .mockRejectedValue(new Error("startup unavailable")),
      getBackgroundState: vi.fn<ClipboardHistoryApi["getBackgroundState"]>()
        .mockRejectedValue(new Error("background unavailable"))
    });

    render(<App />);

    expect(await screen.findByText("仍可读取的历史记录")).toBeTruthy();
  });

  test("does not let a stale load overwrite a completed startup choice", async () => {
    const disabled = startupState({
      desiredEnabled: false,
      actualEnabled: false
    });
    const enabled = startupState({
      desiredEnabled: true,
      actualEnabled: true
    });
    const staleLoad = deferred<StartupState>();
    const getStartupState = vi.fn<ClipboardHistoryApi["getStartupState"]>()
      .mockResolvedValueOnce(disabled)
      .mockReturnValueOnce(staleLoad.promise)
      .mockResolvedValue(enabled);
    const setStartupEnabled = vi.fn<ClipboardHistoryApi["setStartupEnabled"]>()
      .mockResolvedValue(enabled);
    window.clipHistory = mockClipHistory({ getStartupState, setStartupEnabled });

    render(<App />);
    const startupToggle = await screen.findByRole<HTMLInputElement>("checkbox", { name: "开机自启" });
    expect(startupToggle.checked).toBe(false);

    fireEvent.click(screen.getByTitle("刷新"));
    await waitFor(() => expect(getStartupState).toHaveBeenCalledTimes(2));
    fireEvent.click(startupToggle);
    await waitFor(() => {
      expect(setStartupEnabled).toHaveBeenCalledWith(true);
      expect(startupToggle.checked).toBe(true);
    });

    await act(async () => {
      staleLoad.resolve(disabled);
      await staleLoad.promise;
    });
    expect(startupToggle.checked).toBe(true);
  });
});
