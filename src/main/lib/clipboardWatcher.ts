import { hashBytes } from "../../shared/hash";
import type { AppSettings, HistoryResult } from "../../shared/types";
import type { ImageInput } from "./historyStore";

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
  private lastImageKey?: string;
  private lastTextKey?: string;
  private isCapturing = false;
  // Track if the last text read was empty to avoid re-checking empty clipboard
  private lastTextWasEmpty = false;

  constructor(private readonly options: ClipboardWatcherOptions) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.captureOnce().catch((error) => {
        console.error("Clipboard capture error:", error);
      });
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
    // Prevent concurrent polls from running at the same time
    if (this.isCapturing) {
      return;
    }

    this.isCapturing = true;
    try {
      const settings = await this.options.getSettings();
      if (!settings.captureEnabled) {
        return;
      }

      // --- Step 1: Capture image if changed ---
      const image = this.options.readImage();
      if (image) {
        const imageKey = hashBytes("image", image.png);
        if (this.lastImageKey !== imageKey) {
          const result = await this.options.addImage(image);
          if (result.ok) {
            this.lastImageKey = imageKey;
          }
        }
      } else {
        // No image on clipboard — reset image key so a new image can be captured
        this.lastImageKey = undefined;
      }

      // --- Step 2: Capture text if changed (independent of image) ---
      const text = this.options.readText();
      if (text.length === 0) {
        // File copy or empty clipboard — don't update lastTextKey to avoid poisoning
        this.lastTextWasEmpty = true;
        return;
      }

      const textKey = hashBytes("text", Buffer.from(text, "utf8"));
      if (this.lastTextKey === textKey) {
        return;
      }

      const result = await this.options.addText(text);
      if (result.ok) {
        this.lastTextKey = textKey;
        this.lastTextWasEmpty = false;
      }
      // If addText rejected it (sensitive, too-large, etc.), lastTextKey is NOT updated
      // so the next poll will try again (useful if settings change)
    } finally {
      this.isCapturing = false;
    }
  }
}
