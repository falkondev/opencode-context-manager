import { statSync } from "fs";

type ChangeCallback = () => void;

/**
 * Polls the opencode.db file modification time at a given interval.
 * Calls the registered callbacks when changes are detected.
 */
export class DbWatcher {
  private readonly dbPath: string;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastMtime = 0;
  private callbacks: ChangeCallback[] = [];
  private intervalMs: number;

  constructor(dbPath: string, intervalSeconds = 2) {
    this.dbPath = dbPath;
    this.intervalMs = intervalSeconds * 1000;
  }

  public onChanged(cb: ChangeCallback): void {
    this.callbacks.push(cb);
  }

  public start(): void {
    this.lastMtime = this.getCurrentMtime();
    this.interval = setInterval(() => {
      this.check();
    }, this.intervalMs);
  }

  public stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  public setIntervalSeconds(seconds: number): void {
    this.intervalMs = seconds * 1000;
    if (this.interval) {
      this.stop();
      this.start();
    }
  }

  private check(): void {
    const mtime = this.getCurrentMtime();
    if (mtime !== this.lastMtime) {
      this.lastMtime = mtime;
      for (const cb of this.callbacks) {
        try {
          cb();
        } catch {
          // Ignore errors in callbacks
        }
      }
    }
  }

  private getCurrentMtime(): number {
    try {
      return statSync(this.dbPath).mtimeMs;
    } catch {
      return 0;
    }
  }
}
