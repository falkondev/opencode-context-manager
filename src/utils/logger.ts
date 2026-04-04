import path from "path";
import fs from "fs";
import { CONFIG_DIR } from "./config.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ─── Paths ────────────────────────────────────────────────────────────────────

export const LOG_FILE = path.join(CONFIG_DIR, "debug.log");

// Maximum log file size before rotation (5 MB)
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// ─── Logger ──────────────────────────────────────────────────────────────────

/**
 * File-only logger. All output goes to ~/.config/opencode-cm/debug.log.
 * Never writes to stdout/stderr so the TUI is never corrupted.
 */
export class Logger {
  private static instance: Logger | null = null;

  private readonly filePath: string;
  private minLevel: LogLevel;
  private fd: number | null = null;
  private initialized = false;

  private constructor(filePath: string, minLevel: LogLevel = "debug") {
    this.filePath = filePath;
    this.minLevel = minLevel;
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(LOG_FILE);
    }
    return Logger.instance;
  }

  /** Call once at application startup to open the log file. */
  public init(minLevel: LogLevel = "debug"): void {
    this.minLevel = minLevel;
    if (this.initialized) return;
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      this.rotateIfNeeded();
      // Open in append mode, creating the file if it does not exist
      this.fd = fs.openSync(this.filePath, "a");
      this.initialized = true;
      this.writeRaw(`\n${"─".repeat(72)}\n`);
      this.info("logger", `Log started — level=${minLevel} file=${this.filePath}`);
    } catch {
      // If we cannot open the log file, degrade silently — the TUI must not crash
    }
  }

  /** Close the file descriptor on shutdown. */
  public close(): void {
    if (this.fd !== null) {
      try {
        this.info("logger", "Log closed");
        fs.closeSync(this.fd);
      } catch {
        // Ignore
      }
      this.fd = null;
    }
    this.initialized = false;
  }

  public debug(context: string, message: string, data?: unknown): void {
    this.write("debug", context, message, data);
  }

  public info(context: string, message: string, data?: unknown): void {
    this.write("info", context, message, data);
  }

  public warn(context: string, message: string, data?: unknown): void {
    this.write("warn", context, message, data);
  }

  public error(context: string, message: string, error?: unknown): void {
    let data: unknown = error;
    if (error instanceof Error) {
      data = { message: error.message, stack: error.stack };
    }
    this.write("error", context, message, data);
  }

  public setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  public getFilePath(): string {
    return this.filePath;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private write(level: LogLevel, context: string, message: string, data?: unknown): void {
    if (!this.initialized || this.fd === null) return;
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;

    const ts = new Date().toISOString();
    const lvl = level.toUpperCase().padEnd(5);
    let line = `${ts} [${lvl}] [${context}] ${message}`;
    if (data !== undefined) {
      try {
        line += " " + JSON.stringify(data, null, 0);
      } catch {
        line += " [unserializable data]";
      }
    }
    this.writeRaw(line + "\n");
  }

  private writeRaw(text: string): void {
    if (this.fd === null) return;
    try {
      const buf = Buffer.from(text, "utf-8");
      fs.writeSync(this.fd, buf);
    } catch {
      // Ignore write errors — the TUI must not crash because of logging
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const size = fs.statSync(this.filePath).size;
      if (size >= MAX_LOG_BYTES) {
        const rotated = this.filePath.replace(/\.log$/, ".1.log");
        // Keep only one backup
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(this.filePath, rotated);
      }
    } catch {
      // Rotation failure is non-critical
    }
  }
}

/** Convenience singleton accessor. */
export const logger = Logger.getInstance();
