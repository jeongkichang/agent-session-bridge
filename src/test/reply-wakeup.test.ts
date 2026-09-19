import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startBroker } from '../broker.js';
import { BridgeClient } from '../client.js';
import { Store } from '../store.js';

function store(path = ':memory:', onFinished?: (senders: readonly string[]) => void) {
  let time = 1_800_000_000_000;
  const db = new Store(path, () => time, onFinished);
  const register = (name: string, kind: 'claude' | 'codex' = 'codex') => {
    const input = { id: randomUUID(), name, kind, secret: randomBytes(32).toString('hex') };
    db.register(input);
    return input;
  };
  const sender = register('sender');
  const receiver = register('receiver', 'claude');
  return {
    db,
    sender,
    receiver,
    register,
    send: (text = 'question', id: string = randomUUID()) => db.send(sender.id, { request_id: id, peer_id: receiver.id, text, ttl_seconds: 3600 }),
    advance: (ms: number) => { time += ms; },
  };
}

test('a finished request is offered once to the sender, without its body', () => {
  const { db, sender, receiver, send } = store();
  const request = send('question');
  db.take(receiver.id);

  assert.equal(db.takeReply(sender.id), null, '아직 끝나지 않은 요청은 알릴 것이 아니다');

  db.reply(receiver.id, { request_id: request.request_id, text: 'the answer body', outcome: 'completed' });
  const notice = db.takeReply(sender.id);
  assert.equal(notice?.request_id, request.request_id);
  assert.equal(notice?.state, 'completed');
  assert.equal(notice?.has_reply, true);
  // 알림은 «꺼내 가라»는 신호다. 본문이 실리면 세션이 그만큼 먹고 「읽었다」의 주체가 흐려진다.
  assert.equal('text' in (notice as object), false);
  assert.equal('reply' in (notice as object), false);

  assert.equal(db.takeReply(sender.id), null, '같은 회신은 두 번 나가지 않는다');
  assert.equal(db.takeReply(receiver.id), null, '회신한 쪽은 알림을 받지 않는다 — 알림이 알림을 낳지 않는다');
});

test('every way a request can finish reaches the sender', () => {
  const finished: string[][] = [];
  const { db, sender, receiver, send, advance } = store(':memory:', (senders) => finished.push([...senders]));

  const expiring = send('never taken');
  advance(3600_000 + 1);
  db.sweep();
  assert.equal(db.takeReply(sender.id)?.request_id, expiring.request_id, '유효기간이 지나 끝난 것도 알린다');
  assert.ok(finished.some((group) => group.includes(sender.id)), '끝나는 자리가 보낸 쪽을 신호한다');

  // 시간을 앞당겼으니 임대도 끝났다 — 다시 등록하고 이어 간다.
  db.register(sender);
  db.register(receiver);
  const dropped = send('recipient goes away');
  db.take(receiver.id);
  db.disconnect(receiver.id);
  assert.equal(db.takeReply(sender.id)?.request_id, dropped.request_id, '상대가 사라져 끝난 것도 알린다');

  db.register(receiver);
  const failed = send('channel write fails');
  db.take(receiver.id);
  db.failDelivery(failed.request_id, receiver.id);
  assert.equal(db.takeReply(sender.id)?.request_id, failed.request_id, '전달 실패도 알린다');
  assert.equal(db.takeReply(sender.id), null);
});

test('a store file written before this column keeps working', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-bridge-old-store-'));
  const path = join(directory, 'bridge.sqlite');
  try {
    // 이 기능 «전» 의 스키마 그대로 만든다 — 새 컬럼도, 새 인덱스도 없다.
    const old = new DatabaseSync(path);
    old.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE peers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, secret_hash TEXT UNIQUE NOT NULL,
        seen_at INTEGER NOT NULL, lease_until INTEGER NOT NULL
      );
      CREATE TABLE requests (
        id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES peers(id), to_id TEXT NOT NULL REFERENCES peers(id),
        text TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        delivered_at INTEGER, acknowledged_at INTEGER, finished_at INTEGER, reply TEXT, reason TEXT
      );`);
    const senderId = randomUUID();
    const receiverId = randomUUID();
    const secrets = { [senderId]: randomBytes(32).toString('hex'), [receiverId]: randomBytes(32).toString('hex') };
    for (const [id, name] of [[senderId, 'old-sender'], [receiverId, 'old-receiver']] as const) {
      const secretHash = createHash('sha256').update(secrets[id]!).digest('hex');
      old.prepare('INSERT INTO peers VALUES(?,?,?,?,?,?)').run(id, name, 'codex', secretHash, 1, 0);
    }
    old.prepare("INSERT INTO requests(id,from_id,to_id,text,fingerprint,state,created_at,expires_at,finished_at,reply) VALUES(?,?,?,'old','fp','completed',1,2,2,'answered long ago')")
      .run(randomUUID(), senderId, receiverId);
    old.close();

    const db = new Store(path);
    const columns = (db.db.prepare('PRAGMA table_info(requests)').all() as { name: string }[]).map((column) => column.name);
    assert.ok(columns.includes('reply_notified_at'), '낡은 파일에 컬럼이 더해진다');
    // 올리는 순간 지난 회신이 한꺼번에 밀려 나가면 안 된다.
    assert.equal(db.takeReply(senderId), null, '컬럼이 생기기 «전» 에 이미 끝나 있던 기록은 알리지 않는다');

    // 그러나 «그 뒤에» 끝나는 것은 알린다 — 낡은 파일을 연 것이 기능을 끄지는 않는다.
    db.register({ id: senderId, name: 'old-sender', kind: 'codex', secret: secrets[senderId]! });
    db.register({ id: receiverId, name: 'old-receiver', kind: 'codex', secret: secrets[receiverId]! });
    const fresh = db.send(senderId, { request_id: randomUUID(), peer_id: receiverId, text: 'after the upgrade', ttl_seconds: 3600 });
    db.take(receiverId);
    db.reply(receiverId, { request_id: fresh.request_id, text: 'fresh answer', outcome: 'completed' });
    assert.equal(db.takeReply(senderId)?.request_id, fresh.request_id);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function httpFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-bridge-reply-'));
  const broker = await startBroker({ directory, ephemeral: true });
  const sender = new BridgeClient('reply-sender', 'claude', directory, broker.endpoint.url);
  const receiver = new BridgeClient('reply-receiver', 'codex', directory, broker.endpoint.url);
  await sender.connect();
  await receiver.connect();
  return {
    ...broker,
    sender,
    receiver,
    close: async () => {
      await sender.close();
      await receiver.close();
      await broker.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('a waiting sender is woken by the reply, not by the recheck interval', async () => {
  const fixture = await httpFixture();
  const { sender, receiver } = fixture;
  try {
    const input = { request_id: randomUUID(), peer_id: receiver.id, text: 'wake me when finished' };
    await sender.send(input);
    await receiver.receive(2000);

    // 재확인 주기는 2초다. 끝나는 자리가 신호를 안 보내면 아래 시간이 2초 가까이로 늘어난다.
    const waiting = sender.receiveReply(5000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const repliedAt = Date.now();
    await receiver.reply(input.request_id, 'the answer body');
    const { notice } = await waiting;
    const noticeMs = Date.now() - repliedAt;

    assert.equal(notice?.request_id, input.request_id);
    assert.equal(notice?.state, 'completed');
    assert.equal('reply' in (notice as object), false, '알림에는 회신 본문이 실리지 않는다');
    assert.ok(noticeMs < 500, `회신이 대기를 즉시 깨워야 한다, ${noticeMs}ms 걸렸다`);

    // 내용은 요청 조회가 읽는다 — 알림은 신호일 뿐이다.
    assert.equal((await sender.get(input.request_id)).reply, 'the answer body');
  } finally {
    await fixture.close();
  }
});

test('two pollers and a restart never deliver the same notice twice', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-bridge-reply-once-'));
  let broker = await startBroker({ directory, ephemeral: true });
  const identity = { id: randomUUID(), secret: randomBytes(32).toString('hex') };
  let sender = new BridgeClient('once-sender', 'claude', directory, broker.endpoint.url, identity);
  const receiver = new BridgeClient('once-receiver', 'codex', directory, broker.endpoint.url);
  try {
    await sender.connect();
    await receiver.connect();
    const input = { request_id: randomUUID(), peer_id: receiver.id, text: 'answer me once' };
    await sender.send(input);
    await receiver.receive(2000);

    // 같은 피어로 두 커넥션이 동시에 기다린다 — 꺼내면서 표시하므로 하나만 받아야 한다.
    const both = Promise.all([sender.receiveReply(4000), sender.receiveReply(4000)]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await receiver.reply(input.request_id, 'once');
    const results = await both;
    const delivered = results.filter((result) => result.notice !== null);
    assert.equal(delivered.length, 1, '동시 폴링에서도 한 번만 나간다');
    assert.equal(delivered[0]!.notice?.request_id, input.request_id);

    await sender.close();
    await broker.stop();
    // 표시는 저장 파일에 남는다 — 브로커를 다시 띄워도 같은 회신이 다시 나가지 않는다.
    broker = await startBroker({ directory, ephemeral: true });
    sender = new BridgeClient('once-sender', 'claude', directory, broker.endpoint.url, identity);
    await sender.connect();
    const again = await sender.receiveReply(300);
    assert.equal(again.notice, null, '재시작 뒤에도 다시 나가지 않는다');
    assert.equal(again.timed_out, true);
  } finally {
    await sender.close().catch(() => undefined);
    await receiver.close().catch(() => undefined);
    await broker.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
