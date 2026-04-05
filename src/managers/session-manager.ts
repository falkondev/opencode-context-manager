import { Database } from "bun:sqlite";

import type { IDbSession } from "../models/session.ts";
import type {
  ISessionMetrics,
  ISessionSummary,
} from "../models/metrics.ts";
import { SqliteReader } from "../analyzers/sqlite-reader.ts";
import { SessionAnalyzer } from "../analyzers/session-analyzer.ts";
import { DbWatcher } from "../utils/db-watcher.ts";
import { loadConfig } from "../utils/config.ts";
import { logger } from "../utils/logger.ts";

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
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
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

  /**
   * Renames a session by updating its title in the SQLite database.
   * Opens a separate writable connection (the reader is read-only).
   * Returns true on success, false on failure.
   */
  public renameSession(sessionId: string, newTitle: string): boolean {
    let db: Database | null = null;
    try {
      db = new Database(this.dbPath, { readonly: false, create: false });
      const stmt = db.prepare("UPDATE session SET title = ? WHERE id = ?");
      stmt.run(newTitle, sessionId);
      logger.info("session-manager", `Session renamed: ${sessionId} → "${newTitle}"`);

      // Update cached summaries in-place so the UI reflects the change immediately
      for (const s of this.summaries) {
        if (s.id === sessionId) {
          s.title = newTitle;
        }
      }
      if (this.currentMetrics && this.currentMetrics.session.id === sessionId) {
        this.currentMetrics.session.title = newTitle;
      }
      // Also update the raw sessions list
      for (const s of this.sessions) {
        if (s.id === sessionId) {
          s.title = newTitle;
        }
      }

      this.notify();
      return true;
    } catch (err) {
      logger.error("session-manager", `renameSession(${sessionId}) failed`, err);
      return false;
    } finally {
      db?.close();
    }
  }

  public getSummaries(): ISessionSummary[] {
    return this.summaries;
  }

  public refresh(): void {
    try {
      // Reload sessions list
      this.sessions = this.reader.listSessions(50);
      logger.debug("session-manager", `Loaded ${this.sessions.length} sessions`);

      // Build summaries quickly (without loading all parts)
      this.summaries = this.sessions.map((s) => {
        const messages = this.reader.getMessagesForSession(s.id);
        const parts = this.reader.getPartsForSession(s.id);
        const metrics = this.analyzer.analyze(s, messages, parts);
        logger.debug("session-manager", `Analyzed session ${s.id}`, {
          title: s.title,
          messages: messages.length,
          parts: parts.length,
          tokens: metrics.tokens.total,
          context_pct: metrics.context_percentage,
          model: metrics.model_id,
          is_live: metrics.is_live,
        });
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

      logger.info("session-manager", "Refresh complete", {
        sessions: this.summaries.length,
        current: this.currentSessionId ?? "none",
      });
      this.notify();
    } catch (err) {
      logger.error("session-manager", "refresh() failed — will retry on next poll", err);
    }
  }

  private loadSessionMetrics(sessionId: string): ISessionMetrics | null {
    try {
      const session = this.reader.getSession(sessionId);
      if (!session) {
        logger.warn("session-manager", `Session not found: ${sessionId}`);
        return null;
      }

      const messages = this.reader.getMessagesForSession(sessionId);
      const parts = this.reader.getPartsForSession(sessionId);

      // Load child (subagent) sessions so the analyzer can compute subagent metrics
      const childDbSessions = this.reader.getChildSessions(sessionId);
      const childSessions = childDbSessions.map((cs) => ({
        session: cs,
        messages: this.reader.getMessagesForSession(cs.id),
        parts: this.reader.getPartsForSession(cs.id),
      }));

      const metrics = this.analyzer.analyze(session, messages, parts, childSessions);
      this.currentMetrics = metrics;

      logger.debug("session-manager", `Loaded metrics for session ${sessionId}`, {
        model: metrics.model_id,
        tokens: metrics.tokens,
        cost: metrics.cost,
        context_pct: metrics.context_percentage,
        tool_calls: metrics.tool_calls_count,
        steps: metrics.step_count,
        finish_reason: metrics.finish_reason,
        is_live: metrics.is_live,
        subagents: metrics.subagents.length,
      });

      return metrics;
    } catch (err) {
      logger.error("session-manager", `loadSessionMetrics(${sessionId}) failed`, err);
      return null;
    }
  }

  private notify(): void {
    for (const cb of this.callbacks) {
      try {
        cb(this.summaries, this.currentMetrics);
      } catch (err) {
        logger.error("session-manager", "Callback error in notify()", err);
      }
    }
  }
}
