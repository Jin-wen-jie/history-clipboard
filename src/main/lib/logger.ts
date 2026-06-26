import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

export class Logger {
  private logDir: string;
  private currentDate: string;

  constructor(baseDir: string) {
    this.logDir = join(baseDir, "logs");
    this.currentDate = "";
  }

  private async write(level: LogLevel, ...args: unknown[]): Promise<void> {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19);

    // Rotate log file daily
    if (dateStr !== this.currentDate) {
      this.currentDate = dateStr;
    }

    const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    const line = `[${timeStr}] [${level.toUpperCase()}] ${message}\n`;

    // Also output to console during development
    if (level === "error") {
      console.error(...args);
    } else if (level === "warn") {
      console.warn(...args);
    }

    try {
      await mkdir(this.logDir, { recursive: true });
      await appendFile(join(this.logDir, `${dateStr}.log`), line, "utf8");
    } catch {
      // Silently fail for logging
    }
  }

  debug(...args: unknown[]): void {
    void this.write("debug", ...args);
  }

  info(...args: unknown[]): void {
    void this.write("info", ...args);
  }

  warn(...args: unknown[]): void {
    void this.write("warn", ...args);
  }

  error(...args: unknown[]): void {
    void this.write("error", ...args);
  }
}

let _logger: Logger | undefined;

export function getLogger(baseDir?: string): Logger {
  if (!_logger && baseDir) {
    _logger = new Logger(baseDir);
  }
  return _logger ?? new Logger(".");
}
