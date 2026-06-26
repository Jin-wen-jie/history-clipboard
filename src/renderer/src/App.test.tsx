// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, type ClipboardHistoryApi } from "../../shared/types";
import { App } from "./App";

function mockClipHistory(overrides?: Partial<ClipboardHistoryApi>): ClipboardHistoryApi {
  return {
    list: vi.fn<ClipboardHistoryApi["list"]>().mockResolvedValue([]),
    copy: vi.fn<ClipboardHistoryApi["copy"]>().mockResolvedValue({ ok: true }),
    delete: vi.fn<ClipboardHistoryApi["delete"]>().mockResolvedValue({ ok: true }),
    deleteMany: vi.fn<ClipboardHistoryApi["deleteMany"]>().mockResolvedValue({ ok: true, count: 0 }),
    clear: vi.fn<ClipboardHistoryApi["clear"]>().mockResolvedValue(),
    setPinned: vi.fn<ClipboardHistoryApi["setPinned"]>().mockResolvedValue({ ok: true }),
    getSettings: vi.fn<ClipboardHistoryApi["getSettings"]>().mockResolvedValue(DEFAULT_SETTINGS),
    updateSettings: vi.fn<ClipboardHistoryApi["updateSettings"]>().mockResolvedValue(DEFAULT_SETTINGS),
    getStats: vi.fn<ClipboardHistoryApi["getStats"]>().mockResolvedValue({ totalItems: 0, textItems: 0, imageItems: 0, imageBytes: 0 }),
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
});
