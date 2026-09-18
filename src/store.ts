import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { BridgeError, type BridgeRequest, type Peer, PEER_LEASE_MS, terminalStates } from './contracts.js';
import type { z } from 'zod';
import type { registrationSchema, sendSchema, replySchema } from './contracts.js';

type Row = Record<string, string | number | null>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const iso = (value: unknown) => value == null ? null : new Date(Number(value)).toISOString();

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, private now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, secret_hash TEXT UNIQUE NOT NULL,
        seen_at INTEGER NOT NULL, lease_until INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES peers(id), to_id TEXT NOT NULL REFERENCES peers(id),
        text TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        delivered_at INTEGER, acknowledged_at INTEGER, finished_at INTEGER, reply TEXT, reason TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_inbox ON requests(to_id, state, created_at);`);
    // A process may have delivered before a crash. Do not automatically replay work.
    this.db.prepare("UPDATE requests SET state='delivery_unknown', reason='broker_restarted', finished_at=? WHERE state IN ('delivered','acknowledged')").run(this.now());
    this.db.exec('UPDATE peers SET lease_until=0');
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /**
   * 끝난 기록을 지운다. 지우지 않으면 파일이 무한히 자란다(실측: 6일에 요청 955건·5.7MB).
   * 진행 중인 요청과, 아직 기록이 걸려 있는 세션 행은 건드리지 않는다. days<=0 이면 지우지 않는다.
   */
  prune(days: number): { requests: number; peers: number } {
    if (days <= 0) return { requests: 0, peers: 0 };
    const cutoff = this.now() - days * 86_400_000;
    const requests = Number(
      this.db
        .prepare("DELETE FROM requests WHERE state IN ('completed','failed','delivery_unknown','expired') AND COALESCE(finished_at, created_at) < ?")
        .run(cutoff).changes,
    );
    const peers = Number(
      this.db
        .prepare('DELETE FROM peers WHERE lease_until <= ? AND seen_at < ? AND id NOT IN (SELECT from_id FROM requests UNION SELECT to_id FROM requests)')
        .run(this.now(), cutoff).changes,
    );
    return { requests, peers };
  }
  sweep() {
    const now = this.now();
    this.db.prepare("UPDATE requests SET state='delivery_unknown', reason='recipient_disconnected', finished_at=? WHERE state IN ('delivered','acknowledged') AND to_id IN (SELECT id FROM peers WHERE lease_until<=?)").run(now, now);
    this.db.prepare("UPDATE requests SET state='expired', reason='request_expired', finished_at=? WHERE state='queued' AND expires_at<=?").run(now, now);
    this.db.prepare("UPDATE requests SET state='delivery_unknown', reason='reply_deadline_elapsed', finished_at=? WHERE state IN ('delivered','acknowledged') AND expires_at<=?").run(now, now);
  }
  register(input: z.infer<typeof registrationSchema>): Peer {
    this.sweep();
    const now = this.now();
    const old = this.db.prepare('SELECT * FROM peers WHERE id=?').get(input.id) as Row | undefined;
    if (old && (old.secret_hash !== hash(input.secret) || old.name !== input.name || old.kind !== input.kind)) throw new BridgeError('peer_conflict', 409);
    const duplicate = this.db.prepare('SELECT id FROM peers WHERE name=? AND id<>? AND lease_until>?').get(input.name, input.id, now);
    if (duplicate) throw new BridgeError('peer_name_in_use', 409);
    this.db.prepare('INSERT INTO peers VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at, lease_until=excluded.lease_until')
      .run(input.id, input.name, input.kind, hash(input.secret), now, now + PEER_LEASE_MS);
    return this.peer(input.id);
  }
  authenticate(secret: string): string | null {
    const row = this.db.prepare('SELECT id FROM peers WHERE secret_hash=?').get(hash(secret)) as Row | undefined;
    return row ? String(row.id) : null;
  }
  heartbeat(id: string) {
    // Preserve a lost lease before extending it, even between periodic sweeps.
    this.sweep();
    const peer = this.peer(id);
    const successor = this.db.prepare('SELECT id FROM peers WHERE name=? AND id<>? AND lease_until>?').get(peer.name, id, this.now());
    if (successor) throw new BridgeError('peer_superseded', 409);
    this.db.prepare('UPDATE peers SET seen_at=?,lease_until=? WHERE id=?').run(this.now(), this.now() + PEER_LEASE_MS, id);
  }
  disconnect(id: string) {
    this.db.prepare('UPDATE peers SET lease_until=0 WHERE id=?').run(id);
    this.sweep();
  }
  peer(id: string): Peer {
    const row = this.db.prepare('SELECT * FROM peers WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new BridgeError('peer_not_found', 404);
    return { id, name: String(row.name), kind: row.kind as Peer['kind'], online: Number(row.lease_until) > this.now(), last_seen_at: iso(row.seen_at)! };
  }
  peers(): Peer[] {
    return (this.db.prepare('SELECT id FROM peers ORDER BY seen_at DESC LIMIT 200').all() as Row[]).map((p) => this.peer(String(p.id)));
  }
  request(id: string, viewer?: string): BridgeRequest {
    this.sweep();
    const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new BridgeError('request_not_found', 404);
    if (viewer && row.from_id !== viewer && row.to_id !== viewer) throw new BridgeError('request_not_found', 404);
    const from = this.peer(String(row.from_id)); const to = this.peer(String(row.to_id));
    return {
      request_id: String(row.id), from: { id: from.id, name: from.name, kind: from.kind }, to: { id: to.id, name: to.name, kind: to.kind },
      text: String(row.text), state: row.state as BridgeRequest['state'], created_at: iso(row.created_at)!, expires_at: iso(row.expires_at)!,
      delivered_at: iso(row.delivered_at), acknowledged_at: iso(row.acknowledged_at), finished_at: iso(row.finished_at),
      reply: row.reply as string | null, reason: row.reason as string | null, authority: 'external_ai_message', user_approval: false,
    };
  }
  send(from: string, input: z.infer<typeof sendSchema>): BridgeRequest {
    this.sweep();
    const fingerprint = hash(JSON.stringify([from, input.peer_id, input.text, input.ttl_seconds]));
    const old = this.db.prepare('SELECT fingerprint FROM requests WHERE id=?').get(input.request_id) as Row | undefined;
    if (old) {
      if (old.fingerprint !== fingerprint) throw new BridgeError('request_id_conflict', 409);
      return this.request(input.request_id, from);
    }
    const sender = this.peer(from);
    if (!sender.online) {
      const successor = this.db.prepare('SELECT id FROM peers WHERE name=? AND id<>? AND lease_until>?').get(sender.name, from, this.now());
      throw new BridgeError(successor ? 'peer_superseded' : 'peer_offline', 409);
    }
    if (from === input.peer_id) throw new BridgeError('self_message', 400);
    if (!this.peer(input.peer_id).online) throw new BridgeError('peer_offline', 409);
    this.db.prepare("INSERT INTO requests(id,from_id,to_id,text,fingerprint,state,created_at,expires_at) VALUES(?,?,?,?,?,'queued',?,?)")
      .run(input.request_id, from, input.peer_id, input.text, fingerprint, this.now(), this.now() + input.ttl_seconds * 1000);
    return this.request(input.request_id, from);
  }
  take(id: string): BridgeRequest | null {
    this.sweep();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT id FROM requests WHERE to_id=? AND state='queued' ORDER BY created_at,id LIMIT 1").get(id) as Row | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE requests SET state='delivered',delivered_at=? WHERE id=? AND state='queued'").run(this.now(), String(row.id));
      return this.request(String(row.id), id);
    });
  }
  acknowledge(id: string, actor: string): BridgeRequest {
    const request = this.request(id, actor);
    if (request.to.id !== actor) throw new BridgeError('not_recipient', 403);
    if (request.state === 'acknowledged') return request;
    if (request.state !== 'delivered') throw new BridgeError('invalid_state', 409);
    this.db.prepare("UPDATE requests SET state='acknowledged',acknowledged_at=? WHERE id=?").run(this.now(), id);
    return this.request(id, actor);
  }
  reply(actor: string, input: z.infer<typeof replySchema>): BridgeRequest {
    const request = this.request(input.request_id, actor);
    if (request.to.id !== actor) throw new BridgeError('not_recipient', 403);
    if (request.state === input.outcome && request.reply === input.text) return request;
    if (terminalStates.has(request.state) || request.state === 'queued') throw new BridgeError('invalid_state', 409);
    this.db.prepare('UPDATE requests SET state=?,reply=?,finished_at=?,acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=?')
      .run(input.outcome, input.text, this.now(), this.now(), input.request_id);
    return this.request(input.request_id, actor);
  }
  failDelivery(id: string, actor: string): BridgeRequest {
    const request = this.request(id, actor);
    if (request.to.id !== actor) throw new BridgeError('not_recipient', 403);
    if (request.state === 'delivered') this.db.prepare("UPDATE requests SET state='delivery_unknown',reason='channel_write_failed',finished_at=? WHERE id=?").run(this.now(), id);
    return this.request(id, actor);
  }
  recent(): BridgeRequest[] {
    return (this.db.prepare('SELECT id FROM requests ORDER BY created_at DESC LIMIT 100').all() as Row[]).map((r) => this.request(String(r.id)));
  }
  summaries(viewer: string, direction: 'sent' | 'received' | 'both', limit: number) {
    this.sweep();
    const where = direction === 'sent' ? 'from_id=?' : direction === 'received' ? 'to_id=?' : '(from_id=? OR to_id=?)';
    const bindings = direction === 'both' ? [viewer, viewer] : [viewer];
    const rows = this.db.prepare(`SELECT id FROM requests WHERE ${where} ORDER BY COALESCE(finished_at,acknowledged_at,delivered_at,created_at) DESC,id DESC LIMIT ?`).all(...bindings, limit + 1) as Row[];
    return {
      requests: rows.slice(0, limit).map((row) => {
        const { text: _text, reply, ...request } = this.request(String(row.id), viewer);
        return { ...request, has_reply: reply !== null };
      }),
      has_more: rows.length > limit,
    };
  }
}
