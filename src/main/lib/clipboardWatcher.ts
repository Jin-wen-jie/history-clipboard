import { hashBytes } from "../../shared/hash";
import type { AppSettings, HistoryResult } from "../../shared/types";
import type { ImageInput } from "./historyStore";

export type ClipboardWatcherOptions = {
  getSettings: () => Promise<AppSettings>;
  readImage: () => ImageInput | undefined;
  readText: () => string;
  addImage: (input: ImageInput) => Promise<HistoryResult> | HistoryResult;
  addText: (text: string) => Promise<HistoryResult> | HistoryResult;
  fallbackIntervalMs?: number;
  highWaterItems?: number;
  lowWaterItems?: number;
  highWaterBytes?: number;
  lowWaterBytes?: number;
  onBackpressureChange?: (paused: boolean) => void;
  onQueueStateChange?: (state: CaptureQueueState) => void;
  onFiltered?: (reason: "sensitive" | "too-large") => void;
};

export type ClipboardSnapshot = {
  image?: ImageInput;
  text: string;
};

export type CaptureQueueState = {
  depth: number;
  bytes: number;
  backpressured: boolean;
};

type CaptureQueueItem = {
  source: "native" | "poll";
  snapshot: ClipboardSnapshot;
  bytes: number;
  force: boolean;
};

type CoalescedPoll = CaptureQueueItem & {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

const DEFAULT_HIGH_WATER_ITEMS = 32;
const DEFAULT_LOW_WATER_ITEMS = 16;
const DEFAULT_HIGH_WATER_BYTES = 32 * 1024 * 1024;
const DEFAULT_LOW_WATER_BYTES = 16 * 1024 * 1024;

function nonNegativeFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function snapshotBytes(snapshot: ClipboardSnapshot): number {
  const imageBytes = snapshot.image
    ? snapshot.image.png.byteLength + snapshot.image.thumbnailPng.byteLength
    : 0;
  const bytes = Buffer.byteLength(snapshot.text, "utf8") + imageBytes;
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : Number.MAX_SAFE_INTEGER;
}

/**
 * Serializes native clipboard events and fallback observations for persistence.
 *
 * Architecture:
 *   - Native snapshots are never hash-deduplicated or silently dropped.
 *   - Poll observations share the same Promise tail and coalesce to one pending
 *     snapshot while an earlier poll is in flight.
 *   - Queue watermarks expose backpressure without concurrent store calls.
 */
export class ClipboardWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private lastImageKey?: string;
  private lastTextKey?: string;
  private rejectedImageKey?: string;
  private rejectedTextKey?: string;
  /** Serial execution tail — each capture waits for the previous one. */
  private tail: Promise<void> = Promise.resolve();
  /** Number of captures currently enqueued (used for backpressure). */
  private pendingCaptures = 0;
  private pendingBytes = 0;
  private backpressured = false;
  private readonly highWaterItems: number;
  private readonly lowWaterItems: number;
  private readonly highWaterBytes: number;
  private readonly lowWaterBytes: number;
  private pollInFlight = false;
  private coalescedPoll?: CoalescedPoll;
  private accepting = true;

  constructor(private readonly options: ClipboardWatcherOptions) {
    this.highWaterItems = nonNegativeFinite(options.highWaterItems, DEFAULT_HIGH_WATER_ITEMS);
    this.lowWaterItems = Math.min(
      nonNegativeFinite(options.lowWaterItems, DEFAULT_LOW_WATER_ITEMS),
      this.highWaterItems
    );
    this.highWaterBytes = nonNegativeFinite(options.highWaterBytes, DEFAULT_HIGH_WATER_BYTES);
    this.lowWaterBytes = Math.min(
      nonNegativeFinite(options.lowWaterBytes, DEFAULT_LOW_WATER_BYTES),
      this.highWaterBytes
    );
  }

  // ── Public API ──

  start(): void {
    this.startFallbackPolling();
  }

  startFallbackPolling(): void {
    if (!this.accepting || this.timer !== undefined) {
      return;
    }

    const ms = this.options.fallbackIntervalMs ?? 200;
    this.timer = setInterval(() => {
      this.poll();
    }, ms);
    this.poll();
  }

  stopFallbackPolling(): void {
    if (this.timer === undefined) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  stop(): void {
    this.stopFallbackPolling();
    this.accepting = false;
  }

  /**
   * Read a snapshot of the current clipboard and enqueue it for processing.
   * Externally callable (e.g., for manual triggers), but normally driven by
   * the internal poll timer.
   */
  captureOnce(): Promise<void> {
    return this.reconcileOnce();
  }

  reconcileOnce(options?: { force?: boolean }): Promise<void> {
    if (!this.accepting) {
      return Promise.resolve();
    }

    let snapshot: ClipboardSnapshot;
    try {
      snapshot = this.readSnapshot();
    } catch (error) {
      return Promise.reject(error);
    }

    return this.enqueuePoll(snapshot, options?.force === true);
  }

  captureNative(snapshot: ClipboardSnapshot): Promise<void> {
    if (!this.accepting) {
      return Promise.resolve();
    }
    return this.enqueue(this.createQueueItem("native", snapshot, false));
  }

  /**
   * Wait for all pending captures to complete.
   * Useful during graceful shutdown.
   */
  drain(): Promise<void> {
    const tail = this.tail;
    const coalesced = this.coalescedPoll?.promise.catch(() => undefined);
    return coalesced ? Promise.all([tail, coalesced]).then(() => undefined) : tail;
  }

  getQueueState(): CaptureQueueState {
    return {
      depth: this.pendingCaptures,
      bytes: this.pendingBytes,
      backpressured: this.backpressured
    };
  }

  // ── Private ──

  /**
   * Poll a full snapshot every tick. Reading image data is a bit heavier than
   * checking text only, but text-only polling misses image-only copies.
   */
  private poll(): void {
    void this.reconcileOnce().catch(() => {
      console.error("Clipboard fallback capture failed");
    });
  }

  private readSnapshot(): ClipboardSnapshot {
    return {
      image: this.options.readImage(),
      text: this.options.readText()
    };
  }

  private createQueueItem(
    source: "native" | "poll",
    snapshot: ClipboardSnapshot,
    force: boolean
  ): CaptureQueueItem {
    return { source, snapshot, bytes: snapshotBytes(snapshot), force };
  }

  private enqueue(item: CaptureQueueItem, accounted = false): Promise<void> {
    const previousTail = this.tail;
    if (!accounted) {
      this.pendingCaptures += 1;
      this.pendingBytes += item.bytes;
    }

    const capture = previousTail.then(() => this.processSnapshot(item));

    const completed = capture.finally(() => {
      this.pendingCaptures -= 1;
      this.pendingBytes = Math.max(0, this.pendingBytes - item.bytes);
      this.notifyQueueChange();
    });

    this.tail = completed.catch(() => undefined);

    if (!accounted) {
      this.notifyQueueChange();
    }

    return completed;
  }

  private enqueuePoll(snapshot: ClipboardSnapshot, force: boolean): Promise<void> {
    const item = this.createQueueItem("poll", snapshot, force);
    if (!this.pollInFlight) {
      this.pollInFlight = true;
      const capture = this.enqueue(item);
      capture.then(
        () => this.advancePoll(),
        () => this.advancePoll()
      );
      return capture;
    }

    if (this.coalescedPoll) {
      this.pendingBytes = Math.max(
        0,
        this.pendingBytes - this.coalescedPoll.bytes + item.bytes
      );
      this.coalescedPoll.snapshot = item.snapshot;
      this.coalescedPoll.bytes = item.bytes;
      this.coalescedPoll.force ||= item.force;
      this.notifyQueueChange();
      return this.coalescedPoll.promise;
    }

    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.coalescedPoll = { ...item, promise, resolve, reject };
    this.pendingCaptures += 1;
    this.pendingBytes += item.bytes;
    this.notifyQueueChange();
    return promise;
  }

  private advancePoll(): void {
    const pending = this.coalescedPoll;
    if (!pending) {
      this.pollInFlight = false;
      return;
    }

    this.coalescedPoll = undefined;
    const capture = this.enqueue(pending, true);
    capture.then(
      () => {
        pending.resolve();
        this.advancePoll();
      },
      (error) => {
        pending.reject(error);
        this.advancePoll();
      }
    );
  }

  private notifyQueueChange(): void {
    let backpressureChanged = false;
    if (
      !this.backpressured &&
      (this.pendingCaptures >= this.highWaterItems || this.pendingBytes >= this.highWaterBytes)
    ) {
      this.backpressured = true;
      backpressureChanged = true;
    } else if (
      this.backpressured &&
      this.pendingCaptures <= this.lowWaterItems &&
      this.pendingBytes <= this.lowWaterBytes
    ) {
      this.backpressured = false;
      backpressureChanged = true;
    }

    if (backpressureChanged) {
      try {
        this.options.onBackpressureChange?.(this.backpressured);
      } catch {
        console.error("Clipboard watcher backpressure callback failed");
      }
    }

    try {
      this.options.onQueueStateChange?.(this.getQueueState());
    } catch {
      console.error("Clipboard watcher queue callback failed");
    }
  }

  private async processSnapshot(item: CaptureQueueItem): Promise<void> {
    const native = item.source === "native";
    if (item.force || native) {
      this.lastImageKey = undefined;
      this.lastTextKey = undefined;
      this.rejectedImageKey = undefined;
      this.rejectedTextKey = undefined;
    }

    const settings = await this.options.getSettings();
    if (!settings.captureEnabled) {
      return;
    }

    const { snapshot } = item;

    // ── Image ──
    const image = snapshot.image;
    if (image) {
      const imageKey = hashBytes("image", image.png);
      if (
        native ||
        (this.lastImageKey !== imageKey && this.rejectedImageKey !== imageKey)
      ) {
        const result = await this.options.addImage(image);
        if (result.ok) {
          this.lastImageKey = imageKey;
          this.rejectedImageKey = undefined;
        } else {
          this.lastImageKey = undefined;
          if (result.reason === "sensitive" || result.reason === "too-large") {
            this.rejectedImageKey = imageKey;
            this.notifyFiltered(result.reason);
          } else {
            this.rejectedImageKey = undefined;
          }
        }
      }
    } else {
      this.lastImageKey = undefined;
      this.rejectedImageKey = undefined;
    }

    // ── Text ──
    const text = snapshot.text;
    if (text.length === 0) {
      this.lastTextKey = undefined;
      this.rejectedTextKey = undefined;
      return;
    }

    const textKey = hashBytes("text", Buffer.from(text, "utf8"));
    if (
      !native &&
      (this.lastTextKey === textKey || this.rejectedTextKey === textKey)
    ) {
      return;
    }

    const result = await this.options.addText(text);
    if (result.ok) {
      this.lastTextKey = textKey;
      this.rejectedTextKey = undefined;
    } else {
      this.lastTextKey = undefined;
      if (result.reason === "sensitive" || result.reason === "too-large") {
        this.rejectedTextKey = textKey;
        this.notifyFiltered(result.reason);
      } else {
        this.rejectedTextKey = undefined;
      }
    }
  }

  private notifyFiltered(reason: "sensitive" | "too-large"): void {
    try {
      this.options.onFiltered?.(reason);
    } catch {
      console.error("Clipboard watcher filtered callback failed");
    }
  }
}
