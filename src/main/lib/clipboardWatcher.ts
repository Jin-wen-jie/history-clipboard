import type { AppSettings, HistoryResult } from "../../shared/types";
import type { ImageInput } from "./historyStore";
import { createHash } from "node:crypto";

export type ClipboardWatcherOptions = {
  getSettings: () => Promise<AppSettings>;
  readImage: () => ImageInput | undefined;
  readText: () => string;
  addImage: (input: ImageInput) => Promise<HistoryResult> | HistoryResult;
  addText: (text: string) => Promise<HistoryResult> | HistoryResult;
  intervalMs?: number;
};

export class ClipboardWatcher {
  private timer?: NodeJS.Timeout;
  private lastCaptureKey?: string;

  constructor(private readonly options: ClipboardWatcherOptions) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.captureOnce();
    }, this.options.intervalMs ?? 700);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  async captureOnce(): Promise<void> {
    const settings = await this.options.getSettings();
    if (!settings.captureEnabled) {
      return;
    }

    const image = this.options.readImage();
    if (image) {
      const captureKey = hashCapture("image", image.png);
      if (this.lastCaptureKey === captureKey) {
        return;
      }

      await this.options.addImage(image);
      this.lastCaptureKey = captureKey;
      return;
    }

    const text = this.options.readText();
    const captureKey = hashCapture("text", Buffer.from(text, "utf8"));
    if (this.lastCaptureKey === captureKey) {
      return;
    }

    await this.options.addText(text);
    this.lastCaptureKey = captureKey;
  }
}

function hashCapture(type: "text" | "image", data: Buffer): string {
  return createHash("sha256").update(type).update("\0").update(data).digest("hex");
}
