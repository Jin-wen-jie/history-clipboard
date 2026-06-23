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
      await this.options.addImage(image);
      return;
    }

    await this.options.addText(this.options.readText());
  }
}
