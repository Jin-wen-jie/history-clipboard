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

  test("records both image and text when both are present", async () => {
    const addText = vi.fn().mockResolvedValue({ ok: true });
    const addImage = vi.fn().mockResolvedValue({ ok: true });
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

    // Both should be captured (text was previously lost when image was present)
    expect(addImage).toHaveBeenCalledWith(image);
    expect(addText).toHaveBeenCalledWith("image caption");
  });

  test("records text when no image is present", async () => {
    const addText = vi.fn().mockResolvedValue({ ok: true });
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
    const addImage = vi.fn().mockResolvedValue({ ok: true });
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

    // Image captured once, second call deduped
    expect(addImage).toHaveBeenCalledTimes(1);
  });

  test("retries rejected text on next poll (fixes lastCaptureKey poisoning)", async () => {
    const addText = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "sensitive" })
      .mockResolvedValueOnce({ ok: true });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "token: abc123",
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    // First poll: rejected as sensitive → lastTextKey NOT updated
    await watcher.captureOnce();
    expect(addText).toHaveBeenCalledTimes(1);

    // Second poll: same text still on clipboard → retried because lastTextKey wasn't set
    await watcher.captureOnce();
    expect(addText).toHaveBeenCalledTimes(2);
  });

  test("does not pollute text key with empty clipboard", async () => {
    const addText = vi.fn().mockResolvedValue({ ok: true });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "",
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    await watcher.captureOnce();

    // Empty text should not trigger addText
    expect(addText).not.toHaveBeenCalled();
  });

  test("skips concurrent poll when previous capture is still running", async () => {
    let resolveImage: () => void;
    const imagePromise = new Promise<{ ok: true }>((resolve) => {
      resolveImage = () => resolve({ ok: true });
    });
    const addImage = vi.fn().mockReturnValue(imagePromise);
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

    // Start first capture (won't complete until we resolve the promise)
    const firstCapture = watcher.captureOnce();

    // Try second capture while first is still running
    await watcher.captureOnce();

    // Second capture should have been skipped
    expect(addImage).toHaveBeenCalledTimes(1);

    // Clean up
    resolveImage!();
    await firstCapture;
  });
});
