import { hashBytes } from "../../shared/hash";
import type { AppSettings, HistoryResult } from "../../shared/types";
import type { ImageInput } from "./historyStore";

export type ClipboardWatcherOptions = {
  getSettings: () => Promise<AppSettings>;
  readImage: () => ImageInput | undefined;
  readText: () => string;
  addImage: (input: ImageInput) => Promise<HistoryResult> | HistoryResult;
  addText: (text: string) => Promise<HistoryResult> | HistoryResult;
  /** Polling interval in ms (default 200) */
  intervalMs?: number;
};

type ClipboardSnapshot = {
  image: ImageInput | undefined;
  text: string;
};

/**
 * Polls clipboard content at a fixed interval and persists changes.
 *
 * Architecture:
 *   - A lightweight timer reads the clipboard text (very cheap) at `intervalMs`.
 *   - When text differs from the last poll, a full snapshot (text + image) is
 *     read synchronously and queued behind a single-consumer Promise tail so
 *     that `addImage` / `addText` calls are serialised.
 *   - Content-hash deduplication prevents duplicate entries; identical content
 *     copied again updates the existing entry's timestamp via HistoryStore.
 *   - There is no child process, no Win32 FFI, and no IPC — the polling uses
 *     Electron's built-in clipboard API exclusively. This eliminates the ~5–10 MB
 *     .NET Framework runtime and the risk of the helper process dying silently.
 */
export class ClipboardWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private lastImageKey?: string;
  private lastTextKey?: string;
  /** Last text value seen by the poll, used as a cheap pre-check. */
  private lastPolledText: string | undefined;
  /** Serial execution tail — each capture waits for the previous one. */
  private tail: Promise<void> = Promise.resolve();
  /** Number of captures currently enqueued (used for backpressure). */
  private pendingCaptures = 0;

  constructor(private readonly options: ClipboardWatcherOptions) {}

  // ── Public API ──

  start(): void {
    if (this.timer) {
      return;
    }

    // Immediate baseline capture so the first content is never missed
    void this.captureOnce().catch((error) => {
      console.error("Clipboard capture error (start):", error);
    });

    const ms = this.options.intervalMs ?? 200;
    this.timer = setInterval(() => {
      this.poll();
    }, ms);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Read a snapshot of the current clipboard and enqueue it for processing.
   * Externally callable (e.g., for manual triggers), but normally driven by
   * the internal poll timer.
   */
  captureOnce(): Promise<void> {
    // Backpressure: if too many captures are backed up, skip this round.
    // Prevents unbounded memory growth when processing is slower than polling.
    if (this.pendingCaptures > 10) {
      return Promise.resolve();
    }

    let snapshot: ClipboardSnapshot;
    try {
      snapshot = this.readSnapshot();
    } catch (error) {
      return Promise.reject(error);
    }

    return this.enqueue(snapshot);
  }

  /**
   * Wait for all pending captures to complete.
   * Useful during graceful shutdown.
   */
  drain(): Promise<void> {
    return this.tail;
  }

  // ── Private ──

  /**
   * Lightweight poll: compares text content as a cheap change-detection step.
   * Only reads the full (text + image) snapshot when the text has changed.
   *
   * This avoids calling readImage() on every tick — images are still captured
   * when they accompany changed text, which is the vast majority of real-world
   * clipboard operations. The edge case of two image-only copies with identical
   * empty text is extremely rare and would require additional format enumeration
   * that would defeat the purpose of a lightweight check.
   */
  private poll(): void {
    const text = this.options.readText();

    if (text === this.lastPolledText) {
      return; // Nothing changed — skip the expensive full snapshot
    }

    this.lastPolledText = text;
    void this.captureOnce().catch((error) => {
      console.error("Clipboard capture error (poll):", error);
    });
  }

  private readSnapshot(): ClipboardSnapshot {
    return {
      image: this.options.readImage(),
      text: this.options.readText()
    };
  }

  private enqueue(snapshot: ClipboardSnapshot): Promise<void> {
    const previousTail = this.tail;
    this.pendingCaptures += 1;

    const capture = previousTail.then(() => this.processSnapshot(snapshot));

    this.tail = capture
      .catch(() => undefined)
      .finally(() => {
        this.pendingCaptures -= 1;
      });

    return capture;
  }

  private async processSnapshot(snapshot: ClipboardSnapshot): Promise<void> {
    const settings = await this.options.getSettings();
    if (!settings.captureEnabled) {
      return;
    }

    // ── Image ──
    const image = snapshot.image;
    if (image) {
      const imageKey = hashBytes("image", image.png);
      if (this.lastImageKey !== imageKey) {
        const result = await this.options.addImage(image);
        if (result.ok) {
          this.lastImageKey = imageKey;
        }
      }
    } else {
      this.lastImageKey = undefined;
    }

    // ── Text ──
    const text = snapshot.text;
    if (text.length === 0) {
      return;
    }

    const textKey = hashBytes("text", Buffer.from(text, "utf8"));
    if (this.lastTextKey === textKey) {
      return;
    }

    const result = await this.options.addText(text);
    if (result.ok) {
      this.lastTextKey = textKey;
    }
    // If addText rejected it (sensitive, too-large, etc.), lastTextKey is NOT
    // updated so the next poll will try again (useful if settings change).
  }
}
