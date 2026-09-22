import type { AgentEvent, RoomEvent, RoomSnapshot } from "@mp/protocol";
import { COLLECTIONS, type ApplyResult, type Collection } from "@mp/room";

export interface RoomMeta {
  roomId: string;
  secretHash: string;
  repo?: string;
  createdAt: number;
}

/** How many seq'd events to keep for replay-on-reconnect. Older clients get a snapshot. */
export const MAX_EVENTS = 5000;

/** SQLite persistence for one room. All writes for one op happen in a single transaction. */
export class RoomStore {
  private readonly sql: SqlStorage;
  private readonly storage: DurableObjectStorage;
  private readonly nextStreamN = new Map<string, number>();

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.sql = storage.sql;
  }

  migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS entities (collection TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (collection, id))",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, json TEXT NOT NULL)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS streams (agent_id TEXT NOT NULL, n INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (agent_id, n))",
    );
  }

  getMeta(): RoomMeta | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'room'").toArray()[0];
    return row ? (JSON.parse(row.value) as RoomMeta) : null;
  }

  init(meta: RoomMeta): void {
    this.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO meta (key, value) VALUES ('room', ?)", JSON.stringify(meta));
      this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('seq', '0')");
    });
  }

  load(roomId: string): RoomSnapshot {
    const seqRow = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'seq'").toArray()[0];
    const snap: RoomSnapshot = {
      roomId,
      seq: seqRow ? Number(seqRow.value) : 0,
      members: [],
      agents: [],
      plans: [],
      claims: [],
      locks: [],
      diffs: [],
      threads: [],
      messages: [],
      reviews: [],
      freezes: [],
      streams: {},
    };
    for (const row of this.sql.exec<{ collection: string; json: string }>("SELECT collection, json FROM entities")) {
      if ((COLLECTIONS as readonly string[]).includes(row.collection)) {
        (snap[row.collection as Collection] as unknown[]).push(JSON.parse(row.json));
      }
    }
    for (const row of this.sql.exec<{ agent_id: string; n: number; json: string }>(
      "SELECT agent_id, n, json FROM streams ORDER BY agent_id, n",
    )) {
      (snap.streams[row.agent_id] ??= []).push(JSON.parse(row.json) as AgentEvent);
      this.nextStreamN.set(row.agent_id, row.n + 1);
    }
    return snap;
  }

  save(result: Pick<ApplyResult, "events" | "changes">, seq: number): void {
    if (!result.events.length && !result.changes.length) return;
    this.storage.transactionSync(() => {
      for (const c of result.changes) {
        switch (c.kind) {
          case "put":
            this.sql.exec(
              "INSERT OR REPLACE INTO entities (collection, id, json) VALUES (?, ?, ?)",
              c.collection,
              c.id,
              JSON.stringify(c.value),
            );
            break;
          case "del":
            this.sql.exec("DELETE FROM entities WHERE collection = ? AND id = ?", c.collection, c.id);
            break;
          case "stream.append": {
            let n = this.nextStreamN.get(c.agentId) ?? 0;
            for (const e of c.events) {
              this.sql.exec("INSERT INTO streams (agent_id, n, json) VALUES (?, ?, ?)", c.agentId, n++, JSON.stringify(e));
            }
            this.nextStreamN.set(c.agentId, n);
            this.sql.exec("DELETE FROM streams WHERE agent_id = ? AND n < ?", c.agentId, n - c.keep);
            break;
          }
          case "stream.clear":
            this.sql.exec("DELETE FROM streams WHERE agent_id = ?", c.agentId);
            this.nextStreamN.delete(c.agentId);
            break;
        }
      }
      for (const e of result.events) {
        this.sql.exec("INSERT INTO events (seq, json) VALUES (?, ?)", e.seq, JSON.stringify(e));
      }
      if (result.events.length) {
        this.sql.exec("DELETE FROM events WHERE seq <= ?", seq - MAX_EVENTS);
        this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('seq', ?)", String(seq));
      }
    });
  }

  /** Events after `afterSeq`, or null if some of them have already been trimmed. */
  eventsAfter(afterSeq: number, currentSeq: number): RoomEvent[] | null {
    if (afterSeq > currentSeq) return null;
    if (afterSeq === currentSeq) return [];
    const oldest = this.sql.exec<{ seq: number }>("SELECT MIN(seq) AS seq FROM events").toArray()[0]?.seq;
    if (oldest === undefined || oldest === null || oldest > afterSeq + 1) return null;
    return this.sql
      .exec<{ json: string }>("SELECT json FROM events WHERE seq > ? ORDER BY seq", afterSeq)
      .toArray()
      .map((r) => JSON.parse(r.json) as RoomEvent);
  }
}
