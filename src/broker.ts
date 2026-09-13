import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { BridgeError, idSchema, registrationSchema, replySchema, sendSchema, terminalStates, MAX_JSON_BYTES } from './contracts.js';
import { Store } from './store.js';
import { VERSION } from './version.js';
import { ownerToken, privateDirectory, privateFile, stateDirectory } from './state.js';

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new BridgeError('json_required', 415);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BYTES) throw new BridgeError('body_too_large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('invalid_json'); }
}
const equal = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
function json(response: ServerResponse, status: number, data: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}

export async function startBroker(options: { directory: string; port?: number; ephemeral?: boolean }) {
  privateDirectory(options.directory);
  const token = ownerToken(options.directory);
  const dbPath = join(options.directory, 'bridge.sqlite');
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) privateFile(path);
  const store = new Store(dbPath);
  privateFile(dbPath);
  let closing = false;
  const waiters = new Set<AbortController>();
  const sweep = setInterval(() => store.sweep(), 1000).unref();
  const instance = randomUUID();
  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    waiters.add(abort);
    try {
      if (closing) throw new BridgeError('broker_stopping', 503);
      // Browsers must not become an ambient-authority client, even on localhost.
      if (request.headers.origin || request.headers['sec-fetch-site']) throw new BridgeError('browser_origin_forbidden', 403);
      const address = server.address();
      if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}`) throw new BridgeError('invalid_host', 403);
      const authorization = request.headers.authorization || '';
      const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!/^[a-f0-9]{64}$/.test(bearer)) throw new BridgeError('unauthorized', 401);
      const owner = equal(bearer, token);
      const actor = owner ? null : store.authenticate(bearer);
      if (!owner && !actor) throw new BridgeError('unauthorized', 401);
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = request.method;
      const peerOnly = () => { if (!actor) throw new BridgeError('peer_identity_required', 403); return actor; };
      if (method === 'GET' && path === '/health') { json(response, 200, { ok: true, instance, pid: process.pid, version: VERSION }); return; }
      if (method === 'POST' && path === '/v1/register') {
        if (!owner) throw new BridgeError('owner_required', 403);
        json(response, 200, store.register(registrationSchema.parse(await body(request)))); return;
      }
      if (method === 'POST' && path === '/v1/heartbeat') { store.heartbeat(peerOnly()); json(response, 200, { ok: true }); return; }
      if (method === 'DELETE' && path === '/v1/peer') { store.disconnect(peerOnly()); json(response, 200, { ok: true }); return; }
      if (method === 'GET' && path === '/v1/peers') { store.sweep(); json(response, 200, { peers: store.peers() }); return; }
      if (method === 'POST' && path === '/v1/requests') { json(response, 202, store.send(peerOnly(), sendSchema.parse(await body(request)))); return; }
      if (method === 'GET' && path === '/v1/requests') {
        if (!owner) throw new BridgeError('owner_required', 403);
        json(response, 200, { requests: store.recent() }); return;
      }
      if (method === 'GET' && path === '/v1/my-requests') {
        const direction = z.enum(['sent', 'received', 'both']).parse(url.searchParams.get('direction') || 'both');
        const limit = z.coerce.number().int().min(1).max(100).parse(url.searchParams.get('limit') || '20');
        json(response, 200, store.summaries(peerOnly(), direction, limit)); return;
      }
      if (method === 'POST' && path === '/v1/inbox/next') {
        const peer = peerOnly();
        const { timeout_ms } = z.object({ timeout_ms: z.number().int().min(0).max(50_000).default(0) }).strict().parse(await body(request));
        const deadline = Date.now() + timeout_ms;
        while (!abort.signal.aborted && !closing) {
          store.heartbeat(peer);
          const message = store.take(peer);
          if (message || Date.now() >= deadline) { json(response, 200, { message, timed_out: !message }); return; }
          await delay(150, undefined, { signal: abort.signal });
        }
        return;
      }
      const match = path.match(/^\/v1\/requests\/([^/]+)(?:\/(ack|reply|delivery-failed|wait))?$/);
      if (match) {
        const id = idSchema.parse(match[1]);
        const action = match[2];
        if (method === 'GET' && !action) { json(response, 200, store.request(id, actor || undefined)); return; }
        if (method === 'POST' && action === 'ack') { json(response, 200, store.acknowledge(id, peerOnly())); return; }
        if (method === 'POST' && action === 'reply') {
          const input = replySchema.omit({ request_id: true }).parse(await body(request));
          json(response, 200, store.reply(peerOnly(), { ...input, request_id: id })); return;
        }
        if (method === 'POST' && action === 'delivery-failed') { json(response, 200, store.failDelivery(id, peerOnly())); return; }
        if (method === 'GET' && action === 'wait') {
          const timeout = z.coerce.number().int().min(0).max(50_000).parse(url.searchParams.get('timeout_ms') || '0');
          const deadline = Date.now() + timeout;
          while (!abort.signal.aborted && !closing) {
            const message = store.request(id, actor || undefined);
            if (terminalStates.has(message.state) || Date.now() >= deadline) {
              json(response, 200, { request: message, timed_out: !terminalStates.has(message.state) }); return;
            }
            await delay(150, undefined, { signal: abort.signal });
          }
          return;
        }
      }
      if (method === 'POST' && path === '/shutdown') {
        if (!owner) throw new BridgeError('owner_required', 403);
        json(response, 200, { stopping: true });
        setImmediate(() => { void stop(); }); return;
      }
      throw new BridgeError('not_found', 404);
    } catch (error) {
      if (!abort.signal.aborted) {
        const status = error instanceof BridgeError ? error.status : error instanceof z.ZodError ? 400 : 500;
        const code = error instanceof BridgeError ? error.code : error instanceof z.ZodError ? 'invalid_input' : 'internal_error';
        // Never log message bodies, tokens, or SQLite errors containing parameters.
        if (status === 500) process.stderr.write('bridge: internal request error\n');
        json(response, status, { error: code });
      }
    } finally { waiters.delete(abort); }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port || 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected server address');
  const endpoint = { url: `http://127.0.0.1:${address.port}`, pid: process.pid, instance };
  if (!options.ephemeral) writeFileSync(join(options.directory, 'endpoint.json'), JSON.stringify(endpoint), { mode: 0o600 });
  async function stop() {
    if (closing) return;
    closing = true;
    clearInterval(sweep);
    for (const waiter of waiters) waiter.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    const path = join(options.directory, 'endpoint.json');
    if (!options.ephemeral && existsSync(path)) {
      try { if (JSON.parse(readFileSync(path, 'utf8')).instance === instance) unlinkSync(path); } catch { /* preserve another instance */ }
    }
  }
  return { endpoint, token, store, stop, server };
}

export async function runBroker() {
  process.umask(0o077);
  const directory = stateDirectory();
  privateDirectory(directory);
  // SQLite's process lock is released by the OS after a crash. Never unlink a
  // stale PID file: two concurrent starters could otherwise delete a new lock.
  const lockPath = join(directory, 'broker-lock.sqlite');
  privateFile(lockPath);
  const lock = new DatabaseSync(lockPath);
  let released = false;
  const release = () => { if (!released) { released = true; lock.close(); } };
  try {
    lock.exec('PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS singleton (id INTEGER PRIMARY KEY)');
    privateFile(lockPath);
    const broker = await startBroker({ directory });
    const finish = async () => {
      await broker.stop();
      release();
    };
    broker.server.on('close', release);
    process.once('SIGTERM', () => { void finish(); });
    process.once('SIGINT', () => { void finish(); });
    process.stderr.write(`bridge: listening on ${broker.endpoint.url}\n`);
  } catch { release(); throw new Error('Broker could not start; another instance may own the state directory'); }
}
