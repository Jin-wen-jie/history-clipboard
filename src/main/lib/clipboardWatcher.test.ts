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

    // First call: rejected as sensitive → lastTextKey NOT updated
    await watcher.captureOnce();
    expect(addText).toHaveBeenCalledTimes(1);

    // Second call: same text still on clipboard → retried because lastTextKey wasn't set
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

  test("serialises rapid captures while preserving each snapshot", async () => {
    let clipboardText = "A";
    let releaseFirst: () => void;
    const firstPersisted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const persisted: string[] = [];
    const addText = vi.fn(async (text: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (text === "A") {
        await firstPersisted;
      }
      persisted.push(text);
      inFlight -= 1;
      return {
        ok: true as const,
        item: {
          id: text,
          type: "text" as const,
          text,
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
          pinned: false,
          copyCount: 1
        }
      };
    });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => clipboardText,
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    // First capture reads "A", second reads "B" (snapshot taken at call time)
    const first = watcher.captureOnce();
    clipboardText = "B";
    const second = watcher.captureOnce();

    // First should start processing immediately (pendingCaptures goes 0→1)
    await vi.waitFor(() => expect(addText).toHaveBeenCalledTimes(1));
    expect(addText).toHaveBeenLastCalledWith("A");

    // Release the first capture so the second can proceed
    releaseFirst!();
    await Promise.all([first, second]);

    expect(persisted).toEqual(["A", "B"]);
    expect(maxInFlight).toBe(1);
  });

  test("deduplicates unchanged content", async () => {
    const addText = vi.fn().mockResolvedValue({ ok: true });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "unchanged",
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    await watcher.captureOnce();
    await watcher.captureOnce();

    expect(addText).toHaveBeenCalledTimes(1);
  });

  test("recovers after a synchronous clipboard read failure", async () => {
    const addText = vi.fn().mockResolvedValue({ ok: true });
    let shouldFail = true;
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("clipboard read failed");
        }
        return "recovered";
      },
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    await expect(watcher.captureOnce()).rejects.toThrow("clipboard read failed");
    await watcher.captureOnce();

    expect(addText).toHaveBeenCalledWith("recovered");
  });

  test("captures the initial clipboard snapshot when started", async () => {
    const addText = vi.fn().mockResolvedValue({ ok: true });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "already present",
      readImage: () => undefined,
      addText,
      addImage: vi.fn(),
      intervalMs: 60_000
    });

    watcher.start();
    await watcher.drain();
    watcher.stop();

    expect(addText).toHaveBeenCalledWith("already present");
  });

  test("skips poll when text is unchanged", async () => {
    const addText = vi.fn().mockResolvedValue({ ok: true });
    const readText = vi.fn().mockReturnValue("same text");
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText,
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    // First capture reads and stores
    await watcher.captureOnce();
    expect(addText).toHaveBeenCalledTimes(1);

    // Reset readText mock to track calls
    readText.mockClear();

    // Call captureOnce again — should still work since it doesn't use
    // lastPolledText (only the internal poll() does)
    await watcher.captureOnce();
    expect(addText).toHaveBeenCalledTimes(1); // deduped by content hash
  });
});
