import { describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { ClipboardWatcher } from "./clipboardWatcher";

function addedText(text: string) {
  return {
    ok: true as const,
    item: {
      id: text,
      type: "text" as const,
      text,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
      pinned: false,
      copyCount: 1
    }
  };
}

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

  test("native snapshots are persisted without hash deduplication", async () => {
    const addText = vi.fn().mockResolvedValue({ ok: true });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "",
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    await watcher.captureNative({ text: "copied twice" });
    await watcher.captureNative({ text: "copied twice" });

    expect(addText).toHaveBeenCalledTimes(2);
  });

  test("native queue serializes and applies item backpressure without dropping snapshots", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persisted: string[] = [];
    const transitions: boolean[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const addText = vi.fn(async (text: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (text === "A") {
        await firstBlocked;
      }
      persisted.push(text);
      inFlight -= 1;
      return addedText(text);
    });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "",
      readImage: () => undefined,
      addText,
      addImage: vi.fn(),
      highWaterItems: 2,
      lowWaterItems: 1,
      highWaterBytes: Number.MAX_SAFE_INTEGER,
      lowWaterBytes: Number.MAX_SAFE_INTEGER,
      onBackpressureChange: (paused) => transitions.push(paused)
    });

    const first = watcher.captureNative({ text: "A" });
    await vi.waitFor(() => expect(addText).toHaveBeenCalledTimes(1));
    const second = watcher.captureNative({ text: "B" });
    const third = watcher.captureNative({ text: "C" });

    releaseFirst();
    await Promise.all([first, second, third]);

    expect(persisted).toEqual(["A", "B", "C"]);
    expect(maxInFlight).toBe(1);
    expect(transitions).toEqual([true, false]);
    expect(watcher.getQueueState()).toEqual({ depth: 0, bytes: 0, backpressured: false });
  });

  test("poll coalesces blocked requests and persists the latest clipboard snapshot", async () => {
    let clipboardText = "A";
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persisted: string[] = [];
    const addText = vi.fn(async (text: string) => {
      if (text === "A") {
        await firstBlocked;
      }
      persisted.push(text);
      return addedText(text);
    });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => clipboardText,
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    const first = watcher.reconcileOnce();
    await vi.waitFor(() => expect(addText).toHaveBeenCalledTimes(1));
    clipboardText = "B";
    const second = watcher.reconcileOnce();
    clipboardText = "C";
    const third = watcher.reconcileOnce();
    let drained = false;
    const drain = watcher.drain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    releaseFirst();
    await Promise.all([first, second, third, drain]);

    expect(persisted).toEqual(["A", "C"]);
    await watcher.reconcileOnce();
    expect(persisted).toEqual(["A", "C"]);
  });

  test("mixed queue keeps a pending poll before a later native snapshot", async () => {
    let clipboardText = "A";
    let releaseFirst!: () => void;
    let releasePending!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const pendingBlocked = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    const started: string[] = [];
    const persisted: string[] = [];
    const addText = vi.fn(async (text: string) => {
      started.push(text);
      if (text === "A") {
        await firstBlocked;
      } else if (text === "B") {
        await pendingBlocked;
      }
      persisted.push(text);
      return addedText(text);
    });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => clipboardText,
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    let firstDone = false;
    const first = watcher.reconcileOnce().then(() => {
      firstDone = true;
    });
    await vi.waitFor(() => expect(started).toEqual(["A"]));
    clipboardText = "B";
    let pendingDone = false;
    const pending = watcher.reconcileOnce().then(() => {
      pendingDone = true;
    });
    let nativeDone = false;
    const native = watcher.captureNative({ text: "N" }).then(() => {
      nativeDone = true;
    });

    await Promise.resolve();
    expect([firstDone, pendingDone, nativeDone]).toEqual([false, false, false]);
    releaseFirst();
    await vi.waitFor(() => expect(started).toContain("B"));
    const beforePendingRelease = {
      started: [...started],
      firstDone,
      pendingDone,
      nativeDone
    };

    releasePending();
    await Promise.all([first, pending, native]);

    expect(beforePendingRelease).toEqual({
      started: ["A", "B"],
      firstDone: true,
      pendingDone: false,
      nativeDone: false
    });
    expect(persisted).toEqual(["A", "B", "N"]);
    expect(watcher.getQueueState()).toEqual({ depth: 0, bytes: 0, backpressured: false });
  });

  test("mixed queue moves a replaced pending poll behind intervening native work", async () => {
    let clipboardText = "A";
    let releaseFirst!: () => void;
    let releaseLatest!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const latestBlocked = new Promise<void>((resolve) => {
      releaseLatest = resolve;
    });
    const started: string[] = [];
    const persisted: string[] = [];
    const addText = vi.fn(async (text: string) => {
      started.push(text);
      if (text === "A") {
        await firstBlocked;
      } else if (text === "C") {
        await latestBlocked;
      }
      persisted.push(text);
      return addedText(text);
    });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => clipboardText,
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    const first = watcher.reconcileOnce();
    await vi.waitFor(() => expect(started).toEqual(["A"]));
    clipboardText = "B";
    const pending = watcher.reconcileOnce();
    const native = watcher.captureNative({ text: "N" });
    clipboardText = "C";
    const replaced = watcher.reconcileOnce();
    expect(replaced).toBe(pending);
    expect(watcher.getQueueState()).toEqual({ depth: 3, bytes: 3, backpressured: false });

    let pendingDone = false;
    void pending.then(() => {
      pendingDone = true;
    });
    let replacedDone = false;
    void replaced.then(() => {
      replacedDone = true;
    });
    releaseFirst();
    await vi.waitFor(() => expect(started).toContain("C"));
    const beforeLatestRelease = {
      started: [...started],
      pendingDone,
      replacedDone
    };

    releaseLatest();
    await Promise.all([first, pending, native, replaced]);

    expect(beforeLatestRelease).toEqual({
      started: ["A", "N", "C"],
      pendingDone: false,
      replacedDone: false
    });
    expect(persisted).toEqual(["A", "N", "C"]);
    expect(watcher.getQueueState()).toEqual({ depth: 0, bytes: 0, backpressured: false });
  });

  test("mixed queue continues pending poll and native work after active poll failure", async () => {
    let clipboardText = "A";
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const persisted: string[] = [];
    const transitions: boolean[] = [];
    const addText = vi.fn(async (text: string) => {
      started.push(text);
      if (text === "A") {
        await firstBlocked;
        throw new Error("active poll failed");
      }
      persisted.push(text);
      return addedText(text);
    });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => clipboardText,
      readImage: () => undefined,
      addText,
      addImage: vi.fn(),
      highWaterItems: 2,
      lowWaterItems: 0,
      onBackpressureChange: (paused) => transitions.push(paused)
    });

    const first = watcher.reconcileOnce();
    const firstFailure = expect(first).rejects.toThrow("active poll failed");
    await vi.waitFor(() => expect(started).toEqual(["A"]));
    clipboardText = "B";
    const pending = watcher.reconcileOnce();
    const native = watcher.captureNative({ text: "N" });
    const drain = watcher.drain();

    releaseFirst();
    await Promise.all([firstFailure, pending, native, drain]);

    expect(started).toEqual(["A", "B", "N"]);
    expect(persisted).toEqual(["B", "N"]);
    expect(transitions).toEqual([true, false]);
    expect(watcher.getQueueState()).toEqual({ depth: 0, bytes: 0, backpressured: false });
  });

  test("stop drains the final native item in a mixed queue", async () => {
    let clipboardText = "A";
    let releaseFirst!: () => void;
    let releaseNative!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const nativeBlocked = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    const started: string[] = [];
    const addText = vi.fn(async (text: string) => {
      started.push(text);
      if (text === "A") {
        await firstBlocked;
      } else if (text === "N") {
        await nativeBlocked;
      }
      return addedText(text);
    });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => clipboardText,
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    const first = watcher.reconcileOnce();
    await vi.waitFor(() => expect(started).toEqual(["A"]));
    clipboardText = "B";
    let pendingDone = false;
    const pending = watcher.reconcileOnce().then(() => {
      pendingDone = true;
    });
    let nativeDone = false;
    const native = watcher.captureNative({ text: "N" }).then(() => {
      nativeDone = true;
    });
    watcher.stop();
    let drained = false;
    const drain = watcher.drain().then(() => {
      drained = true;
    });

    releaseFirst();
    await vi.waitFor(() => expect(started).toContain("N"));
    await Promise.resolve();
    const beforeNativeRelease = {
      started: [...started],
      pendingDone,
      nativeDone,
      drained
    };

    releaseNative();
    await Promise.all([first, pending, native, drain]);

    expect(beforeNativeRelease).toEqual({
      started: ["A", "B", "N"],
      pendingDone: true,
      nativeDone: false,
      drained: false
    });
    expect(watcher.getQueueState()).toEqual({ depth: 0, bytes: 0, backpressured: false });
  });

  test("stop still drains a coalesced poll after the active poll fails", async () => {
    let clipboardText = "A";
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persisted: string[] = [];
    const addText = vi.fn(async (text: string) => {
      if (text === "A") {
        await firstBlocked;
        throw new Error("poll store failed");
      }
      persisted.push(text);
      return addedText(text);
    });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => clipboardText,
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    const first = watcher.reconcileOnce();
    const firstFailure = expect(first).rejects.toThrow("poll store failed");
    await vi.waitFor(() => expect(addText).toHaveBeenCalledTimes(1));
    clipboardText = "B";
    const second = watcher.reconcileOnce();
    watcher.stop();
    let drained = false;
    const drain = watcher.drain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    releaseFirst();
    await Promise.all([firstFailure, second, drain]);

    expect(persisted).toEqual(["B"]);
    expect(watcher.getQueueState()).toEqual({ depth: 0, bytes: 0, backpressured: false });
  });

  test("fallback stop leaves native capture active while stop rejects new observations", async () => {
    const readText = vi.fn().mockReturnValue("baseline");
    const addText = vi.fn().mockResolvedValue({ ok: true });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText,
      readImage: () => undefined,
      addText,
      addImage: vi.fn(),
      fallbackIntervalMs: 60_000
    });

    watcher.startFallbackPolling();
    watcher.startFallbackPolling();
    await watcher.drain();

    expect(readText).toHaveBeenCalledTimes(1);
    expect(addText).toHaveBeenCalledWith("baseline");

    watcher.stopFallbackPolling();
    await watcher.captureNative({ text: "native after fallback stop" });
    expect(addText).toHaveBeenCalledWith("native after fallback stop");

    watcher.stop();
    await watcher.captureNative({ text: "ignored native" });
    await watcher.reconcileOnce();

    expect(readText).toHaveBeenCalledTimes(1);
    expect(addText).toHaveBeenCalledTimes(2);
  });

  test("filtered poll fingerprints are suppressed until force clears all keys", async () => {
    const image = {
      png: Buffer.from([1, 2]),
      thumbnailPng: Buffer.from([3]),
      width: 2,
      height: 1
    };
    const addImage = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "too-large" })
      .mockResolvedValueOnce({ ok: true });
    const addText = vi.fn().mockResolvedValue({ ok: true });
    const filtered: Array<"sensitive" | "too-large"> = [];
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "accepted text",
      readImage: () => image,
      addText,
      addImage,
      onFiltered: (reason) => filtered.push(reason)
    });

    await watcher.reconcileOnce();
    await watcher.reconcileOnce();

    expect(addImage).toHaveBeenCalledTimes(1);
    expect(addText).toHaveBeenCalledTimes(1);
    expect(filtered).toEqual(["too-large"]);

    await watcher.reconcileOnce({ force: true });

    expect(addImage).toHaveBeenCalledTimes(2);
    expect(addText).toHaveBeenCalledTimes(2);
    expect(filtered).toEqual(["too-large"]);
  });

  test("blank and missing poll results are retried without filtered notifications", async () => {
    const image = {
      png: Buffer.from([7]),
      thumbnailPng: Buffer.from([8]),
      width: 1,
      height: 1
    };
    const addImage = vi.fn().mockResolvedValue({ ok: false, reason: "missing" });
    const addText = vi.fn().mockResolvedValue({ ok: false, reason: "blank" });
    const onFiltered = vi.fn();
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "whitespace-like",
      readImage: () => image,
      addText,
      addImage,
      onFiltered
    });

    await watcher.reconcileOnce();
    await watcher.reconcileOnce();

    expect(addImage).toHaveBeenCalledTimes(2);
    expect(addText).toHaveBeenCalledTimes(2);
    expect(onFiltered).not.toHaveBeenCalled();
  });

  test("native results update poll keys and clear stale filtered fingerprints", async () => {
    const addText = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "sensitive" })
      .mockResolvedValueOnce({ ok: false, reason: "missing" })
      .mockResolvedValue({ ok: true });
    const filtered: Array<"sensitive" | "too-large"> = [];
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "same native text",
      readImage: () => undefined,
      addText,
      addImage: vi.fn(),
      onFiltered: (reason) => filtered.push(reason)
    });

    await watcher.captureNative({ text: "same native text" });
    await watcher.captureNative({ text: "same native text" });
    await watcher.reconcileOnce();
    await watcher.reconcileOnce();

    expect(addText).toHaveBeenCalledTimes(3);
    expect(filtered).toEqual(["sensitive"]);

    await watcher.captureNative({ text: "same native text" });
    expect(addText).toHaveBeenCalledTimes(4);
  });

  test("native failure clears an old poll fingerprint so fallback can retry the same content", async () => {
    const addText = vi.fn()
      .mockResolvedValueOnce(addedText("same text"))
      .mockRejectedValueOnce(new Error("native store failed"))
      .mockResolvedValueOnce(addedText("same text"));
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "same text",
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    await watcher.reconcileOnce();
    await expect(watcher.captureNative({ text: "same text" })).rejects.toThrow(
      "native store failed"
    );
    await watcher.reconcileOnce();

    expect(addText).toHaveBeenCalledTimes(3);
  });

  test("native image success is retained when text fails and fallback retries only text", async () => {
    const image = {
      png: Buffer.from([4, 5]),
      thumbnailPng: Buffer.from([6]),
      width: 2,
      height: 1
    };
    const addImage = vi.fn().mockResolvedValue({ ok: true });
    const addText = vi.fn()
      .mockRejectedValueOnce(new Error("text store failed"))
      .mockResolvedValueOnce(addedText("caption"));
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "caption",
      readImage: () => image,
      addText,
      addImage
    });

    await expect(
      watcher.captureNative({ text: "caption", image })
    ).rejects.toThrow("text store failed");
    await watcher.reconcileOnce();

    expect(addImage).toHaveBeenCalledTimes(1);
    expect(addText).toHaveBeenCalledTimes(2);
  });

  test("stop lets queued native items finish and drain waits for the last item", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persisted: string[] = [];
    const addText = vi.fn(async (text: string) => {
      if (text === "A") {
        await firstBlocked;
      }
      persisted.push(text);
      return addedText(text);
    });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "ignored poll",
      readImage: () => undefined,
      addText,
      addImage: vi.fn()
    });

    const first = watcher.captureNative({ text: "A" });
    await vi.waitFor(() => expect(addText).toHaveBeenCalledTimes(1));
    const second = watcher.captureNative({ text: "B" });
    watcher.stop();
    await watcher.captureNative({ text: "ignored native" });
    await watcher.reconcileOnce();

    let drained = false;
    const drain = watcher.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseFirst();
    await Promise.all([first, second, drain]);

    expect(persisted).toEqual(["A", "B"]);
    expect(watcher.getQueueState()).toEqual({ depth: 0, bytes: 0, backpressured: false });
  });

  test("queue recovers from a task failure and restores backpressure counts", async () => {
    const persisted: string[] = [];
    const transitions: boolean[] = [];
    const addText = vi.fn(async (text: string) => {
      if (text === "fails") {
        throw new Error("store failed");
      }
      persisted.push(text);
      return addedText(text);
    });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "",
      readImage: () => undefined,
      addText,
      addImage: vi.fn(),
      highWaterItems: 1,
      lowWaterItems: 0,
      onBackpressureChange: (paused) => transitions.push(paused)
    });

    const failed = watcher.captureNative({ text: "fails" });
    const failure = expect(failed).rejects.toThrow("store failed");
    const next = watcher.captureNative({ text: "continues" });

    await Promise.all([failure, next, watcher.drain()]);

    expect(persisted).toEqual(["continues"]);
    expect(transitions).toEqual([true, false]);
    expect(watcher.getQueueState()).toEqual({ depth: 0, bytes: 0, backpressured: false });
  });

  test("queue remains serial when a state callback enqueues another native snapshot", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persisted: string[] = [];
    const addText = vi.fn(async (text: string) => {
      if (text === "A") {
        await firstBlocked;
      }
      persisted.push(text);
      return addedText(text);
    });
    let watcher!: ClipboardWatcher;
    let reentrantCapture: Promise<void> | undefined;
    let reentered = false;
    watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "",
      readImage: () => undefined,
      addText,
      addImage: vi.fn(),
      onQueueStateChange: (state) => {
        if (!reentered && state.depth === 1) {
          reentered = true;
          reentrantCapture = watcher.captureNative({ text: "B" });
        }
      }
    });

    const first = watcher.captureNative({ text: "A" });
    await vi.waitFor(() => expect(addText).toHaveBeenCalledWith("A"));
    const callsBeforeRelease = addText.mock.calls.map(([text]) => text);

    releaseFirst();
    await Promise.all([first, reentrantCapture!]);

    expect(callsBeforeRelease).toEqual(["A"]);
    expect(persisted).toEqual(["A", "B"]);
  });

  test("backpressure resumes only after item and byte counts reach both low watermarks", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const transitions: boolean[] = [];
    const states: Array<{ depth: number; bytes: number; backpressured: boolean }> = [];
    const addText = vi.fn(async (text: string) => {
      await (text === "a" ? firstBlocked : secondBlocked);
      return addedText(text);
    });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "",
      readImage: () => undefined,
      addText,
      addImage: vi.fn(),
      highWaterItems: 2,
      lowWaterItems: 1,
      highWaterBytes: 100,
      lowWaterBytes: 1,
      onBackpressureChange: (paused) => transitions.push(paused),
      onQueueStateChange: (state) => {
        states.push({ ...state });
        state.depth = 999;
        state.bytes = 999;
        state.backpressured = false;
      }
    });

    const first = watcher.captureNative({ text: "a" });
    await vi.waitFor(() => expect(addText).toHaveBeenCalledTimes(1));
    const second = watcher.captureNative({ text: "éé" });

    const exposed = watcher.getQueueState();
    expect(exposed).toEqual({ depth: 2, bytes: 5, backpressured: true });
    exposed.depth = 0;
    exposed.bytes = 0;
    exposed.backpressured = false;
    expect(watcher.getQueueState()).toEqual({ depth: 2, bytes: 5, backpressured: true });

    releaseFirst();
    await vi.waitFor(() => expect(addText).toHaveBeenCalledTimes(2));
    expect(watcher.getQueueState()).toEqual({ depth: 1, bytes: 4, backpressured: true });
    expect(transitions).toEqual([true]);

    releaseSecond();
    await Promise.all([first, second]);

    expect(transitions).toEqual([true, false]);
    expect(states[states.length - 1]).toEqual({ depth: 0, bytes: 0, backpressured: false });
    expect(watcher.getQueueState()).toEqual({ depth: 0, bytes: 0, backpressured: false });
  });

  test("byte backpressure counts UTF-8 text plus PNG and thumbnail buffers", async () => {
    let releaseImage!: () => void;
    const imageBlocked = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    const transitions: boolean[] = [];
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "",
      readImage: () => undefined,
      addText: vi.fn(async (text: string) => addedText(text)),
      addImage: vi.fn(async () => {
        await imageBlocked;
        return { ok: false as const, reason: "missing" as const };
      }),
      highWaterItems: 10,
      lowWaterItems: 10,
      highWaterBytes: 5,
      lowWaterBytes: 0,
      onBackpressureChange: (paused) => transitions.push(paused)
    });

    const capture = watcher.captureNative({
      text: "é",
      image: {
        png: Buffer.from([1, 2]),
        thumbnailPng: Buffer.from([3]),
        width: 2,
        height: 1
      }
    });

    expect(watcher.getQueueState()).toEqual({ depth: 1, bytes: 5, backpressured: true });
    releaseImage();
    await capture;

    expect(transitions).toEqual([true, false]);
    expect(watcher.getQueueState()).toEqual({ depth: 0, bytes: 0, backpressured: false });
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

  test("poll captures image-only clipboard changes when text is unchanged", async () => {
    const firstImage = {
      png: Buffer.from([1]),
      thumbnailPng: Buffer.from([1]),
      width: 1,
      height: 1
    };
    const secondImage = {
      png: Buffer.from([2]),
      thumbnailPng: Buffer.from([2]),
      width: 1,
      height: 1
    };
    let image = firstImage;
    const addImage = vi.fn().mockResolvedValue({ ok: true });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "",
      readImage: () => image,
      addText: vi.fn(),
      addImage
    });

    (watcher as unknown as { poll: () => void }).poll();
    await watcher.drain();
    expect(addImage).toHaveBeenCalledWith(firstImage);

    addImage.mockClear();
    image = secondImage;

    (watcher as unknown as { poll: () => void }).poll();
    await watcher.drain();

    expect(addImage).toHaveBeenCalledWith(secondImage);
  });

  test("retries a rejected image-only capture only when forced", async () => {
    const image = {
      png: Buffer.from([1]),
      thumbnailPng: Buffer.from([1]),
      width: 1,
      height: 1
    };
    const addImage = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "too-large" })
      .mockResolvedValueOnce({ ok: true });
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText: () => "",
      readImage: () => image,
      addText: vi.fn(),
      addImage
    });

    (watcher as unknown as { poll: () => void }).poll();
    await watcher.drain();

    (watcher as unknown as { poll: () => void }).poll();
    await watcher.drain();

    expect(addImage).toHaveBeenCalledTimes(1);

    await watcher.reconcileOnce({ force: true });

    expect(addImage).toHaveBeenCalledTimes(2);
  });

  test("retries rejected text only when forced", async () => {
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
    expect(addText).toHaveBeenCalledTimes(1);

    await watcher.reconcileOnce({ force: true });
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
    const first = watcher.captureNative({ text: clipboardText });
    clipboardText = "B";
    const second = watcher.captureNative({ text: clipboardText });

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
      fallbackIntervalMs: 60_000
    });

    watcher.start();
    await watcher.drain();
    watcher.stop();

    expect(addText).toHaveBeenCalledWith("already present");
  });

  test("poll reads a full snapshot but deduplicates unchanged content", async () => {
    const addText = vi.fn().mockResolvedValue({ ok: true });
    const readText = vi.fn().mockReturnValue("same text");
    const readImage = vi.fn().mockReturnValue(undefined);
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readText,
      readImage,
      addText,
      addImage: vi.fn()
    });

    (watcher as unknown as { poll: () => void }).poll();
    await watcher.drain();

    readText.mockClear();
    readImage.mockClear();

    (watcher as unknown as { poll: () => void }).poll();
    await watcher.drain();

    expect(readText).toHaveBeenCalledTimes(1);
    expect(readImage).toHaveBeenCalledTimes(1);
    expect(addText).toHaveBeenCalledTimes(1);
  });
});
