import type { IDbSession } from "../models/session.ts";
import type {
  ISessionMetrics,
  ISessionSummary,
} from "../models/metrics.ts";
import { SqliteReader } from "../analyzers/sqlite-reader.ts";
import { SessionAnalyzer } from "../analyzers/session-analyzer.ts";
import { DbWatcher } from "../utils/db-watcher.ts";
import { loadConfig } from "../utils/config.ts";

type RefreshCallback = (sessions: ISessionSummary[], current: ISessionMetrics | null) => void;

/**
 * Orchestrates SQLite reading, session analysis, and live DB polling.
 */
export class SessionManager {
  private reader: SqliteReader;
  private analyzer: SessionAnalyzer;
  private watcher: DbWatcher;
  private callbacks: RefreshCallback[] = [];
  private sessions: IDbSession[] = [];
  private currentSessionId: string | null = null;
  private summaries: ISessionSummary[] = [];
  private currentMetrics: ISessionMetrics | null = null;

  constructor(dbPath: string) {
    this.reader = new SqliteReader(dbPath);
    this.analyzer = new SessionAnalyzer();
    const config = loadConfig();
    this.watcher = new DbWatcher(dbPath, config.refreshInterval);
    this.watcher.onChanged(() => this.refresh());
  }

  public start(): void {
    this.refresh();
    this.watcher.start();
  }

  public stop(): void {
    this.watcher.stop();
    this.reader.close();
  }

  public onRefresh(cb: RefreshCallback): void {
    this.callbacks.push(cb);
  }

  public setRefreshInterval(seconds: number): void {
    this.watcher.setIntervalSeconds(seconds);
  }

  public selectSession(id: string): ISessionMetrics | null {
    this.currentSessionId = id;
    return this.loadSessionMetrics(id);
  }

  public getCurrentMetrics(): ISessionMetrics | null {
    return this.currentMetrics;
  }

  public getSummaries(): ISessionSummary[] {
    return this.summaries;
  }

  public refresh(): void {
    try {
      // Reload sessions list
      this.sessions = this.reader.listSessions(50);

      // Build summaries quickly (without loading all parts)
      this.summaries = this.sessions.map((s) => {
        const messages = this.reader.getMessagesForSession(s.id);
        const parts = this.reader.getPartsForSession(s.id);
        const metrics = this.analyzer.analyze(s, messages, parts);
        return this.analyzer.toSummary(metrics);
      });

      // Reload current session if selected
      if (this.currentSessionId) {
        this.currentMetrics = this.loadSessionMetrics(this.currentSessionId);
      } else if (this.sessions.length > 0 && this.sessions[0] !== undefined) {
        // Auto-select most recent session
        this.currentSessionId = this.sessions[0].id;
        this.currentMetrics = this.loadSessionMetrics(this.sessions[0].id);
      }

      this.notify();
    } catch {
      // Non-fatal — will retry on next poll
    }
  }

  private loadSessionMetrics(sessionId: string): ISessionMetrics | null {
    try {
      const session = this.reader.getSession(sessionId);
      if (!session) return null;

      const messages = this.reader.getMessagesForSession(sessionId);
      const parts = this.reader.getPartsForSession(sessionId);
      const metrics = this.analyzer.analyze(session, messages, parts);
      this.currentMetrics = metrics;
      return metrics;
    } catch {
      return null;
    }
  }

  private notify(): void {
    for (const cb of this.callbacks) {
      try {
        cb(this.summaries, this.currentMetrics);
      } catch {
        // Ignore errors in callbacks
      }
    }
  }
}
