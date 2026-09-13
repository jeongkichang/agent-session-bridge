import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startBroker } from '../broker.js';
import { BridgeClient } from '../client.js';
import { MAX_TEXT_BYTES } from '../contracts.js';

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-bridge-http-'));
  const broker = await startBroker({ directory, ephemeral: true });
  const sender = new BridgeClient('sender', 'codex', directory, broker.endpoint.url);
  const receiver = new BridgeClient('receiver', 'claude', directory, broker.endpoint.url);
  await sender.connect(); await receiver.connect();
  return { ...broker, sender, receiver, close: async () => { await sender.close(); await receiver.close(); await broker.stop(); rmSync(directory, { recursive: true }); } };
}

test('HTTP long polling, timeout, concurrent retries, recipient reply and sender wait', async () => {
  const fixture = await setup();
  const { sender, receiver } = fixture;
  try {
    const input = { request_id: randomUUID(), peer_id: receiver.id, text: 'echo nonce-123' };
    const receives = receiver.receive(2000);
    const sends = await Promise.all(Array.from({ length: 8 }, () => sender.send(input)));
    assert.equal(new Set(sends.map((r) => r.request_id)).size, 1);
    const { message } = await receives;
    assert.equal(message?.text, input.text);
    const timeout = await sender.wait(input.request_id, 20);
    assert.equal(timeout.timed_out, true); assert.equal(timeout.request.state, 'delivered');
    const waiting = sender.wait(input.request_id, 2000);
    await receiver.acknowledge(input.request_id);
    await receiver.reply(input.request_id, 'nonce-123');
    const result = await waiting;
    assert.equal(result.timed_out, false); assert.equal(result.request.reply, 'nonce-123');
    assert.equal((await receiver.receive(0)).message, null);
  } finally { await fixture.close(); }
});

test('HTTP rejects missing/wrong auth, browser origin, hostile Host, and oversized inputs', async () => {
  const fixture = await setup();
  try {
    const url = fixture.endpoint.url;
    assert.equal((await fetch(url + '/health')).status, 401);
    assert.equal((await fetch(url + '/health', { headers: { Authorization: 'Bearer ' + '0'.repeat(64) } })).status, 401);
    assert.equal((await fetch(url + '/health', { headers: { Authorization: `Bearer ${fixture.token}`, Origin: 'http://evil.example' } })).status, 403);
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(url + '/health', { headers: { Authorization: `Bearer ${fixture.token}`, Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    assert.equal(badHost, 403);
    await assert.rejects(fixture.sender.send({ request_id: randomUUID(), peer_id: fixture.receiver.id, text: '한'.repeat(12000) }), /invalid_input/);
    await assert.rejects(fixture.sender.send({ request_id: randomUUID(), peer_id: fixture.receiver.id, text: '\u0001'.repeat(60000) }), /body_too_large/);
  } finally { await fixture.close(); }
});

test('HTTP accepts JSON-escaped text at the decoded byte limit for both send and reply', async () => {
  const fixture = await setup();
  try {
    for (const character of ['\\', '"', String.fromCharCode(1)]) {
      const text = character.repeat(MAX_TEXT_BYTES);
      const id = randomUUID();
      await fixture.sender.send({ request_id: id, peer_id: fixture.receiver.id, text });
      assert.equal((await fixture.receiver.receive(0)).message?.text, text);
      await fixture.receiver.reply(id, text);
      assert.equal((await fixture.sender.get(id)).reply, text);
    }
    await assert.rejects(fixture.sender.send({ request_id: randomUUID(), peer_id: fixture.receiver.id, text: 'x'.repeat(MAX_TEXT_BYTES + 1) }), /invalid_input/);
  } finally { await fixture.close(); }
});

test('HTTP inventory restricts results to the authenticated connection and validates bounds', async () => {
  const fixture = await setup();
  const stranger = new BridgeClient('stranger', 'codex', fixture.sender.directory, fixture.endpoint.url);
  try {
    await stranger.connect();
    const sent = await fixture.sender.send({ request_id: randomUUID(), peer_id: fixture.receiver.id, text: 'must not appear in inventory' });
    const own = await fixture.sender.summaries('sent', 20) as { requests: { request_id: string }[] };
    assert.equal(own.requests[0]?.request_id, sent.request_id);
    assert.equal(JSON.stringify(own).includes('must not appear'), false);
    assert.deepEqual(await stranger.summaries(), { requests: [], has_more: false });
    await assert.rejects(fixture.sender.summaries('both', 101), /invalid_input/);
  } finally { await stranger.close(); await fixture.close(); }
});
