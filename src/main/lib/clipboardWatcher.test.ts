import { describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { ClipboardWatcher } from "./clipboardWatcher";

describe("ClipboardWatcher", () => {
  test("does not record anything when capture is disabled", async () => {
    const addText = vi.fn();
    const addImage = vi.fn();
    const watcher = new ClipboardWatcher({
      getSettings: async () => ({ ...DEFAULT_SETTINGS, captureEnabled: false }),
      readText: () => "hello",
      readImage: () => ({
        png: Buffer.from([1]),
        thumbnailPng: Buffer.from([1]),
        width: 1,
        height: 1
      }),
      addText,
      addImage
    });

    await watcher.captureOnce();

    expect(addText).not.toHaveBeenCalled();
    expect(addImage).not.toHaveBeenCalled();
  });

  test("records an image before text when both are present", async () => {
    const addText = vi.fn();
    const addImage = vi.fn();
    const image = {
      png: Buffer.from([1, 2, 3]),
      thumbnailPng: Buffer.from([9]),
      width: 16,
      height: 9
    };
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "image caption",
      readImage: () => image,
      addText,
      addImage
    });

    await watcher.captureOnce();

    expect(addImage).toHaveBeenCalledWith(image);
    expect(addText).not.toHaveBeenCalled();
  });

  test("records text when no image is present", async () => {
    const addText = vi.fn();
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "plain text",
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    await watcher.captureOnce();

    expect(addText).toHaveBeenCalledWith("plain text");
  });

  test("does not record the same image again while the clipboard is unchanged", async () => {
    const addImage = vi.fn();
    const image = {
      png: Buffer.from([1, 2, 3]),
      thumbnailPng: Buffer.from([9]),
      width: 16,
      height: 9
    };
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "",
      readImage: () => image,
      addText: vi.fn(),
      addImage
    });

    await watcher.captureOnce();
    await watcher.captureOnce();

    expect(addImage).toHaveBeenCalledTimes(1);
  });
});
