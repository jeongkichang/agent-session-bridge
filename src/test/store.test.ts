import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { BridgeError, PEER_LEASE_MS } from '../contracts.js';

function setup() {
  let time = 1_800_000_000_000;
  const store = new Store(':memory:', () => time);
  const register = (name: string, kind: 'claude' | 'codex' = 'codex') => {
    const input = { id: randomUUID(), name, kind, secret: randomBytes(32).toString('hex') };
    store.register(input); return input;
  };
  const sender = register('sender'); const receiver = register('receiver', 'claude');
  const send = (text = 'test message', id: string = randomUUID()) => store.send(sender.id, { request_id: id, peer_id: receiver.id, text, ttl_seconds: 3600 });
  return { store, sender, receiver, register, send, advance: (ms: number) => { time += ms; } };
}
function code(expected: string) { return (error: unknown) => error instanceof BridgeError && error.code === expected; }

test('durable acceptance, explicit read ACK and one matching reply', () => {
  const { store, sender, receiver, send } = setup();
  const request = send();
  assert.equal(request.state, 'queued'); assert.equal(request.user_approval, false);
  assert.equal(store.take(receiver.id)?.request_id, request.request_id);
  assert.equal(store.take(receiver.id), null);
  assert.equal(store.acknowledge(request.request_id, receiver.id).state, 'acknowledged');
  assert.equal(store.acknowledge(request.request_id, receiver.id).state, 'acknowledged');
  const reply = { request_id: request.request_id, text: 'result', outcome: 'completed' as const };
  assert.equal(store.reply(receiver.id, reply).state, 'completed');
  assert.equal(store.reply(receiver.id, reply).reply, 'result');
  assert.equal(store.request(request.request_id, sender.id).reply, 'result');
  assert.throws(() => store.reply(receiver.id, { ...reply, text: 'different' }), code('invalid_state'));
  store.close();
});

test('same request UUID retry preserves one row; changed contents conflict', () => {
  const { store, sender, receiver, send } = setup();
  const first = send();
  for (let i = 0; i < 10; i++) assert.equal(send(first.text, first.request_id).request_id, first.request_id);
  assert.equal(store.recent().length, 1);
  assert.throws(() => send('changed', first.request_id), code('request_id_conflict'));
  store.disconnect(receiver.id);
  assert.equal(store.send(sender.id, { request_id: first.request_id, peer_id: receiver.id, text: first.text, ttl_seconds: 3600 }).request_id, first.request_id);
  store.close();
});

test('offline, duplicate name, self, foreign read and false replies are rejected', () => {
  const { store, sender, receiver, register, send } = setup();
  const stranger = register('stranger'); const request = send();
  assert.throws(() => register('receiver'), code('peer_name_in_use'));
  assert.throws(() => store.request(request.request_id, stranger.id), code('request_not_found'));
  assert.throws(() => store.reply(sender.id, { request_id: request.request_id, text: 'spoof', outcome: 'completed' }), code('not_recipient'));
  assert.throws(() => store.reply(stranger.id, { request_id: request.request_id, text: 'spoof', outcome: 'completed' }), code('request_not_found'));
  assert.throws(() => store.send(sender.id, { request_id: randomUUID(), peer_id: sender.id, text: 'loop', ttl_seconds: 60 }), code('self_message'));
  store.disconnect(receiver.id);
  assert.throws(() => send(), code('peer_offline'));
  store.close();
});

test('a new session with an expired peer name never inherits old queued work', () => {
  const { store, sender, receiver, register, send, advance } = setup();
  const queued = send();
  advance(PEER_LEASE_MS + 1);
  const replacement = register('receiver', 'claude');
  assert.notEqual(replacement.id, receiver.id);
  assert.throws(() => store.heartbeat(receiver.id), code('peer_superseded'));
  assert.equal(store.peers().filter((p) => p.name === 'receiver' && p.online).length, 1);
  assert.equal(store.take(replacement.id), null);
  assert.equal(store.request(queued.request_id, sender.id).state, 'queued');
  store.close();
});

test('lease loss and deadline after dispatch become unknown, never automatic replay', () => {
  const { store, sender, receiver, send, advance } = setup();
  const request = send(); store.take(receiver.id); store.acknowledge(request.request_id, receiver.id);
  advance(PEER_LEASE_MS + 1);
  assert.equal(store.request(request.request_id, sender.id).state, 'delivery_unknown');
  store.heartbeat(receiver.id);
  assert.equal(store.take(receiver.id), null);
  store.close();
});

test('request waiting to be sent expires without pretending execution failed', () => {
  const { store, sender, send, advance } = setup();
  const request = send(); advance(3_600_001);
  assert.equal(store.request(request.request_id, sender.id).state, 'expired'); store.close();
});

test('restart preserves completed and queued records; dispatched work is uncertain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-store-'));
  const path = join(dir, 'state.sqlite');
  let store = new Store(path);
  const sender = { id: randomUUID(), name: 'sender', kind: 'codex' as const, secret: randomBytes(32).toString('hex') };
  const receiver = { id: randomUUID(), name: 'receiver', kind: 'claude' as const, secret: randomBytes(32).toString('hex') };
  store.register(sender); store.register(receiver);
  const make = () => store.send(sender.id, { request_id: randomUUID(), peer_id: receiver.id, text: 'message', ttl_seconds: 60 });
  const completed = make(); store.take(receiver.id); store.reply(receiver.id, { request_id: completed.request_id, text: 'done', outcome: 'completed' });
  const dispatched = make(); store.take(receiver.id); const queued = make();
  store.close(); store = new Store(path);
  assert.equal(store.request(completed.request_id).reply, 'done');
  assert.equal(store.request(dispatched.request_id).state, 'delivery_unknown');
  assert.equal(store.request(queued.request_id).state, 'queued');
  assert.equal(store.peer(receiver.id).online, false);
  store.register(receiver);
  assert.equal(store.take(receiver.id)?.request_id, queued.request_id);
  assert.equal(store.take(receiver.id), null);
  store.close(); rmSync(dir, { recursive: true });
});
