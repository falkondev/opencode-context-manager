import { Database } from "bun:sqlite";
import type {
  IDbSession,
  IDbMessageRaw,
  IDbPartRaw,
  IMessage,
  IPart,
  IMessageData,
  IPartData,
} from "../models/session.ts";
import { logger } from "../utils/logger.ts";

/**
 * Direct SQLite reader for the OpenCode database.
 * All queries are synchronous (bun:sqlite is synchronous by default).
 */
export class SqliteReader {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true, create: false });
    logger.info("sqlite-reader", `Database opened (read-only): ${dbPath}`);
  }

  public close(): void {
    this.db.close();
    logger.info("sqlite-reader", "Database closed");
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  public listSessions(limit = 50): IDbSession[] {
    const query = this.db.query<IDbSession, [number]>(
      `SELECT id, project_id, parent_id, slug, directory, title, version,
              share_url, summary_additions, summary_deletions, summary_files,
              summary_diffs, time_created, time_updated, time_archived, workspace_id
       FROM session
       ORDER BY time_updated DESC
       LIMIT ?`,
    );
    return query.all(limit) as unknown as IDbSession[];
  }

  public getSession(id: string): IDbSession | null {
    const query = this.db.query<IDbSession, [string]>(
      `SELECT id, project_id, parent_id, slug, directory, title, version,
              share_url, summary_additions, summary_deletions, summary_files,
              summary_diffs, time_created, time_updated, time_archived, workspace_id
       FROM session WHERE id = ?`,
    );
    return query.get(id) ?? null;
  }

  // ─── Messages ──────────────────────────────────────────────────────────────

  public getMessagesForSession(sessionId: string): IMessage[] {
    const query = this.db.query<IDbMessageRaw, [string]>(
      `SELECT id, session_id, time_created, time_updated, data
       FROM message
       WHERE session_id = ?
       ORDER BY time_created ASC`,
    );
    const rows = query.all(sessionId);
    return rows.map((r) => this.parseMessage(r));
  }

  public getLatestMessageForSession(sessionId: string): IMessage | null {
    const query = this.db.query<IDbMessageRaw, [string]>(
      `SELECT id, session_id, time_created, time_updated, data
       FROM message
       WHERE session_id = ?
       ORDER BY time_created DESC
       LIMIT 1`,
    );
    const row = query.get(sessionId);
    return row ? this.parseMessage(row) : null;
  }

  // ─── Parts ─────────────────────────────────────────────────────────────────

  public getPartsForSession(sessionId: string): IPart[] {
    const query = this.db.query<IDbPartRaw, [string]>(
      `SELECT id, message_id, session_id, time_created, time_updated, data
       FROM part
       WHERE session_id = ?
       ORDER BY time_created ASC`,
    );
    const rows = query.all(sessionId);
    return rows.map((r) => this.parsePart(r));
  }

  public getPartsForMessage(messageId: string): IPart[] {
    const query = this.db.query<IDbPartRaw, [string]>(
      `SELECT id, message_id, session_id, time_created, time_updated, data
       FROM part
       WHERE message_id = ?
       ORDER BY time_created ASC`,
    );
    const rows = query.all(messageId);
    return rows.map((r) => this.parsePart(r));
  }

  // ─── Aggregates ────────────────────────────────────────────────────────────

  public getSessionCount(): number {
    const result = this.db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM session")
      .get();
    return result?.count ?? 0;
  }

  public getMessageDataLength(messageId: string): number {
    const result = this.db
      .query<{ len: number }, [string]>(
        "SELECT length(data) as len FROM message WHERE id = ?",
      )
      .get(messageId);
    return result?.len ?? 0;
  }

  // ─── Private Parsers ───────────────────────────────────────────────────────

  private parseMessage(raw: IDbMessageRaw): IMessage {
    let data: IMessageData;
    try {
      data = JSON.parse(raw.data) as IMessageData;
    } catch (err) {
      logger.warn("sqlite-reader", `Failed to parse message JSON id=${raw.id}`, {
        error: err instanceof Error ? err.message : String(err),
        raw_length: raw.data?.length ?? 0,
      });
      data = { role: "user", agent: "unknown" };
    }
    return {
      id: raw.id,
      session_id: raw.session_id,
      time_created: raw.time_created,
      time_updated: raw.time_updated,
      data,
    };
  }

  private parsePart(raw: IDbPartRaw): IPart {
    let data: IPartData;
    try {
      data = JSON.parse(raw.data) as IPartData;
    } catch (err) {
      logger.warn("sqlite-reader", `Failed to parse part JSON id=${raw.id}`, {
        error: err instanceof Error ? err.message : String(err),
        raw_length: raw.data?.length ?? 0,
      });
      data = { type: "text", text: "" };
    }
    return {
      id: raw.id,
      message_id: raw.message_id,
      session_id: raw.session_id,
      time_created: raw.time_created,
      time_updated: raw.time_updated,
      data,
    };
  }
}
