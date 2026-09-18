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

test('retention removes finished records without touching live work', () => {
  const { store, sender, receiver, send, advance } = setup();

  const finished = send('old one');
  store.take(receiver.id);
  store.reply(receiver.id, { request_id: finished.request_id, text: 'done', outcome: 'completed' });

  advance(40 * 86_400_000);
  const stale = store.register({ id: randomUUID(), name: 'stale', kind: 'codex', secret: randomBytes(32).toString('hex') });
  store.disconnect(stale.id);
  advance(40 * 86_400_000);
  // 살아 있는 요청은 시간을 앞당긴 «뒤에» 만든다. 먼저 만들면 유효기간이 지나 만료된다(그 자체는 정상 동작).
  // 시간이 지나면 세션 임대도 끝나므로 다시 등록한다.
  store.register(sender);
  store.register(receiver);
  const open = send('still open');

  assert.deepEqual(store.prune(0), { requests: 0, peers: 0 }, '0 이면 아무것도 지우지 않는다');

  const removed = store.prune(30);
  assert.equal(removed.requests, 1, '끝난 기록만 지운다');
  assert.ok(removed.peers >= 1, '기록이 걸리지 않은 오래된 세션 행도 지운다');

  assert.throws(() => store.request(finished.request_id, sender.id));
  assert.equal(store.request(open.request_id, sender.id).state, 'queued', '진행 중인 요청은 남는다');
  assert.ok(store.peers().some((peer) => peer.id === sender.id), '기록이 걸린 세션 행은 남는다');
  assert.ok(!store.peers().some((peer) => peer.id === stale.id));
  store.close();
});

test('retention keeps an old departed peer that a surviving record still points at', () => {
  const { store, receiver, register, advance } = setup();
  // 보낸 세션이 떠난 뒤 상대가 나중에 답하는 경우. 기록은 최근이고 세션 행만 오래됐다.
  const departed = register('departed');
  const request = store.send(departed.id, { request_id: randomUUID(), peer_id: receiver.id, text: '먼저 보내고 떠남', ttl_seconds: 86_400 });
  // 요청 유효기간(하루) 안에서 움직인다. 넘기면 답하기 전에 만료된다.
  advance(12 * 3600_000);
  store.register(receiver);
  store.take(receiver.id);
  store.reply(receiver.id, { request_id: request.request_id, text: '늦게 답함', outcome: 'completed' });

  // 6시간보다 오래된 것을 지운다 — 세션 행(12시간 전)은 오래됐고 기록(방금)은 최근이다.
  const removed = store.prune(0.25);
  assert.equal(removed.requests, 0, '최근에 끝난 기록은 남긴다');
  assert.ok(store.peers().some((peer) => peer.id === departed.id), '기록이 가리키는 세션 행은 오래돼도 지우지 않는다');
  assert.equal(store.request(request.request_id, departed.id).reply, '늦게 답함');
  store.close();
});

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

test('superseded senders cannot dispatch new work but can inspect and retry their original request', () => {
  const { store, sender, receiver, register, send, advance } = setup();
  try {
    const original = send();
    advance(PEER_LEASE_MS + 1);
    const replacement = register('sender');
    store.heartbeat(receiver.id);
    assert.throws(() => send('new work'), code('peer_superseded'));
    assert.equal(send(original.text, original.request_id).request_id, original.request_id);
    assert.equal(store.request(original.request_id, sender.id).text, original.text);
    assert.equal(store.send(replacement.id, { request_id: randomUUID(), peer_id: receiver.id, text: 'new sender', ttl_seconds: 60 }).state, 'queued');
    store.disconnect(replacement.id);
    assert.throws(() => store.send(replacement.id, { request_id: randomUUID(), peer_id: receiver.id, text: 'offline', ttl_seconds: 60 }), code('peer_offline'));
  } finally { store.close(); }
});

test('lease renewal cannot erase a disconnect between periodic sweeps', () => {
  for (const renew of ['heartbeat', 'register'] as const) {
    for (const acknowledged of [false, true]) {
      const { store, sender, receiver, send, advance } = setup();
      try {
        const request = send(); store.take(receiver.id);
        if (acknowledged) store.acknowledge(request.request_id, receiver.id);
        advance(PEER_LEASE_MS + 1);
        if (renew === 'heartbeat') store.heartbeat(receiver.id);
        else store.register(receiver);
        const result = store.request(request.request_id, sender.id);
        assert.equal(result.state, 'delivery_unknown');
        assert.equal(result.reason, 'recipient_disconnected');
        assert.equal(store.peer(receiver.id).online, true);
        assert.equal(store.take(receiver.id), null);
      } finally { store.close(); }
    }
  }
});

test('request inventory is private, bounded, and includes replies without returning message bodies', () => {
  const { store, sender, receiver, register, send, advance } = setup();
  try {
    const stranger = register('stranger');
    const first = send('private body'); store.take(receiver.id);
    store.reply(receiver.id, { request_id: first.request_id, text: 'private answer', outcome: 'completed' });
    advance(1); const second = send('second');
    const result = store.summaries(sender.id, 'sent', 1);
    assert.equal(result.has_more, true);
    assert.equal(result.requests[0]?.request_id, second.request_id);
    const completed = store.summaries(receiver.id, 'received', 20).requests.find((r) => r.request_id === first.request_id)!;
    assert.equal(completed.state, 'completed'); assert.equal(completed.has_reply, true);
    assert.equal('text' in completed, false); assert.equal('reply' in completed, false);
    assert.equal(store.summaries(stranger.id, 'both', 100).requests.length, 0);
    assert.equal(store.summaries(sender.id, 'received', 100).requests.length, 0);
  } finally { store.close(); }
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
