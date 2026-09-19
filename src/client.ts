import { randomBytes, randomUUID } from 'node:crypto';
import { BridgeError, type BridgeRequest, type Peer, type ReplyNotice } from './contracts.js';
import { ownerToken, readEndpoint, stateDirectory } from './state.js';

export class BridgeClient {
  readonly id: string;
  private readonly secret: string;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private readonly owner: string;
  constructor(readonly name: string, readonly kind: Peer['kind'], readonly directory = stateDirectory(), private readonly explicitUrl?: string, identity?: { id: string; secret: string }) {
    this.id = identity?.id || randomUUID();
    this.secret = identity?.secret || randomBytes(32).toString('hex');
    this.owner = ownerToken(directory);
  }
  get url() { return this.explicitUrl || readEndpoint(this.directory).url; }
  async request<T>(path: string, options: { method?: string; body?: unknown; owner?: boolean; timeout?: number; signal?: AbortSignal } = {}): Promise<T> {
    const response = await fetch(this.url + path, {
      method: options.method || 'GET',
      headers: { Authorization: `Bearer ${options.owner ? this.owner : this.secret}`, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout || 55_000)]) : AbortSignal.timeout(options.timeout || 55_000),
      redirect: 'error',
    });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new BridgeError(result.error || 'broker_request_failed', response.status);
    return result;
  }
  async connect(): Promise<Peer> {
    const peer = await this.request<Peer>('/v1/register', { method: 'POST', owner: true, body: { id: this.id, name: this.name, kind: this.kind, secret: this.secret }, timeout: 5000 });
    this.timer = setInterval(() => {
      if (!this.closed) void this.request('/v1/heartbeat', { method: 'POST', timeout: 5000 }).catch(() => { /* next request reports connectivity */ });
    }, 10_000).unref();
    return peer;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    try { await this.request('/v1/peer', { method: 'DELETE', timeout: 1500 }); } catch { /* expiry marks offline */ }
  }
  async peers(): Promise<Peer[]> { return (await this.request<{ peers: Peer[] }>('/v1/peers')).peers; }
  summaries(direction: 'sent' | 'received' | 'both' = 'both', limit = 20) {
    return this.request('/v1/my-requests?direction=' + direction + '&limit=' + limit);
  }
  send(input: { request_id: string; peer_id: string; text: string; ttl_seconds?: number }) {
    return this.request<BridgeRequest>('/v1/requests', { method: 'POST', body: input });
  }
  get(id: string) { return this.request<BridgeRequest>(`/v1/requests/${encodeURIComponent(id)}`); }
  wait(id: string, timeout = 50_000, signal?: AbortSignal) { return this.request<{ request: BridgeRequest; timed_out: boolean }>(`/v1/requests/${encodeURIComponent(id)}/wait?timeout_ms=${timeout}`, { signal, timeout: timeout + 5000 }); }
  receive(timeout = 50_000, signal?: AbortSignal) { return this.request<{ message: BridgeRequest | null; timed_out: boolean }>('/v1/inbox/next', { method: 'POST', body: { timeout_ms: timeout }, signal, timeout: timeout + 5000 }); }
  /** 내가 보낸 요청이 끝났다는 알림 하나를 기다린다. 본문은 안 온다 — 내용은 `get` 으로 읽는다. */
  receiveReply(timeout = 50_000, signal?: AbortSignal) { return this.request<{ notice: ReplyNotice | null; timed_out: boolean }>('/v1/outbox/next', { method: 'POST', body: { timeout_ms: timeout }, signal, timeout: timeout + 5000 }); }
  acknowledge(id: string) { return this.request<BridgeRequest>(`/v1/requests/${encodeURIComponent(id)}/ack`, { method: 'POST' }); }
  reply(id: string, text: string, outcome: 'completed' | 'failed' = 'completed') { return this.request<BridgeRequest>(`/v1/requests/${encodeURIComponent(id)}/reply`, { method: 'POST', body: { text, outcome } }); }
  deliveryFailed(id: string) { return this.request<BridgeRequest>(`/v1/requests/${encodeURIComponent(id)}/delivery-failed`, { method: 'POST' }); }
}
