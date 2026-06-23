// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, type ClipboardHistoryApi } from "../../shared/types";
import { App } from "./App";

describe("App", () => {
  const originalClipHistory = window.clipHistory;

  afterEach(() => {
    window.clipHistory = originalClipHistory;
  });

  test("loads recent clipboard items without a date range by default", async () => {
    const list = vi.fn<ClipboardHistoryApi["list"]>().mockResolvedValue([]);
    window.clipHistory = {
      list,
      copy: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      setPinned: vi.fn(),
      getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
      updateSettings: vi.fn(),
      getStats: vi.fn().mockResolvedValue({ totalItems: 0, textItems: 0, imageItems: 0, imageBytes: 0 }),
      showWindow: vi.fn()
    };

    render(<App />);

    await waitFor(() => {
      expect(list).toHaveBeenCalledWith({ type: "all", search: "" });
    });
  });
});
