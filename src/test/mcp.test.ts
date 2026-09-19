import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { startBroker } from '../broker.js';

const directoryOfTest = dirname(fileURLToPath(import.meta.url));
function data(result: Awaited<ReturnType<Client['callTool']>>): any {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse((result.content as { text: string }[])[0]!.text);
}

test('real stdio MCP adapters: channel delivery, explicit reply, reverse request and Codex inbox', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-bridge-mcp-'));
  let broker = await startBroker({ directory });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), AGENT_BRIDGE_STATE_DIR: directory };
  const codex = new Client({ name: 'codex-test-host', version: '1' });
  const claude = new Client({ name: 'claude-test-host', version: '1' });
  const notifications: { content: string; meta: Record<string, string> }[] = [];
  claude.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string()) }) }), (event) => { notifications.push(event.params); });
  const codexTransport = new StdioClientTransport({ command: process.execPath, args: [join(directoryOfTest, '..', 'codex-mcp.js'), '--name', 'codex-test'], env, stderr: 'pipe' });
  const claudeTransport = new StdioClientTransport({ command: process.execPath, args: [join(directoryOfTest, '..', 'claude-channel.js'), '--name', 'claude-test'], env, stderr: 'pipe' });
  try {
    await codex.connect(codexTransport); await claude.connect(claudeTransport);
    let peerData: any;
    for (let i = 0; i < 100; i++) {
      peerData = data(await codex.callTool({ name: 'list_peers', arguments: {} }));
      if (peerData.peers.some((p: any) => p.name === 'claude-test' && p.online)) break;
      await delay(25);
    }
    const claudePeer = peerData.peers.find((p: any) => p.name === 'claude-test' && p.online);
    assert.ok(claudePeer);
    const requestId = randomUUID();
    const input = { request_id: requestId, peer_id: claudePeer.id, text: 'nonce-stdio-17' };
    const send = data(await codex.callTool({ name: 'send_message', arguments: input }));
    assert.equal(send.request_id, requestId); assert.equal(send.state, 'queued');
    for (let i = 0; i < 100 && notifications.length === 0; i++) await delay(25);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.content, input.text);
    assert.equal(notifications[0]!.meta.request_id, requestId);
    assert.equal(notifications[0]!.meta.user_approval, 'false');
    data(await claude.callTool({ name: 'acknowledge', arguments: { request_id: requestId } }));
    data(await claude.callTool({ name: 'reply', arguments: { request_id: requestId, text: 'stdio-response-17' } }));
    const result = data(await codex.callTool({ name: 'wait_reply', arguments: { request_id: requestId, timeout_ms: 1000 } }));
    assert.equal(result.request.reply, 'stdio-response-17'); assert.equal(result.request.state, 'completed');
    data(await codex.callTool({ name: 'send_message', arguments: input }));
    await delay(200); assert.equal(notifications.length, 1);

    const reverseId = randomUUID();
    data(await claude.callTool({ name: 'send_message', arguments: { request_id: reverseId, peer_id: peerData.self.id, text: 'question from Claude' } }));
    const received = data(await codex.callTool({ name: 'receive_message', arguments: { timeout_ms: 1000 } }));
    assert.equal(received.message.request_id, reverseId);
    data(await codex.callTool({ name: 'reply', arguments: { request_id: reverseId, text: 'answer from Codex' } }));
    const reverse = data(await claude.callTool({ name: 'get_reply', arguments: { request_id: reverseId } }));
    assert.equal(reverse.reply, 'answer from Codex');
    // 회신도 밀어 준다 — 다만 «신호» 만이다. 본문은 위 get_reply 가 읽는다.
    for (let i = 0; i < 100 && !notifications.some((n) => n.meta.request_id === reverseId && n.meta.event === 'reply'); i++) await delay(25);
    const replyNotice = notifications.find((n) => n.meta.request_id === reverseId && n.meta.event === 'reply');
    assert.ok(replyNotice, '보낸 쪽이 회신 도착을 알림으로 받는다');
    assert.equal(replyNotice!.meta.sender, 'codex-test');
    assert.equal(replyNotice!.meta.state, 'completed');
    assert.equal(replyNotice!.meta.user_approval, 'false');
    assert.equal(replyNotice!.content.includes('answer from Codex'), false, '알림에 회신 본문이 실리지 않는다');
    await delay(200);
    assert.equal(notifications.filter((n) => n.meta.request_id === reverseId).length, 1, '같은 회신을 두 번 알리지 않는다');
    // 알림은 요청이 아니다 — 알림을 받았다고 새 요청이 생기지 않는다(claude 가 보낸 것은 여전히 하나다).
    assert.equal(data(await claude.callTool({ name: 'list_requests', arguments: { direction: 'sent' } })).requests.length, 1);
    const repeatedWait = data(await claude.callTool({ name: 'wait_reply', arguments: { request_id: reverseId, timeout_ms: 0 } }));
    assert.equal(repeatedWait.timed_out, false);
    assert.equal(repeatedWait.request.state, 'completed');
    const inventory = data(await claude.callTool({ name: 'list_requests', arguments: { direction: 'sent' } }));
    assert.equal(inventory.requests.length, 1);
    assert.equal(inventory.requests[0].request_id, reverseId);
    assert.equal(inventory.requests[0].has_reply, true);
    assert.equal('reply' in inventory.requests[0], false);
    assert.equal('text' in inventory.requests[0], false);
    const missing = await claude.callTool({ name: 'get_reply', arguments: { request_id: randomUUID() } });
    assert.equal(missing.isError, true);
    const missingBody = JSON.parse((missing.content as { text: string }[])[0]!.text);
    assert.equal(missingBody.error, 'request_not_found');
    assert.match(missingBody.retry, /owner CLI/);
    assert.equal(peerData.self.version, '0.2.0');
    assert.equal(peerData.broker.version, '0.2.0');
    // Restart only the broker; keep the real MCP processes and their identities.
    const originalInstance = peerData.broker.instance;
    const interruptedId = randomUUID();
    data(await codex.callTool({ name: 'send_message', arguments: { request_id: interruptedId, peer_id: claudePeer.id, text: 'do not replay after broker restart' } }));
    for (let i = 0; i < 100 && !notifications.some((n) => n.meta.request_id === interruptedId); i++) await delay(25);
    assert.ok(notifications.some((n) => n.meta.request_id === interruptedId));
    await broker.stop(); broker = await startBroker({ directory });
    for (let i = 0; i < 240; i++) {
      peerData = data(await codex.callTool({ name: 'list_peers', arguments: {} }));
      if (peerData.peers.some((p: any) => p.id === peerData.self.id && p.online) && peerData.peers.some((p: any) => p.id === claudePeer.id && p.online)) break;
      await delay(50);
    }
    assert.notEqual(peerData.broker.instance, originalInstance);
    assert.equal(peerData.peers.find((p: any) => p.id === peerData.self.id)?.online, true);
    assert.equal(peerData.peers.find((p: any) => p.id === claudePeer.id)?.online, true);
    assert.equal(data(await codex.callTool({ name: 'get_reply', arguments: { request_id: interruptedId } })).state, 'delivery_unknown');
    assert.equal(data(await codex.callTool({ name: 'get_reply', arguments: { request_id: requestId } })).reply, 'stdio-response-17');
    const afterRestartId = randomUUID();
    data(await codex.callTool({ name: 'send_message', arguments: { request_id: afterRestartId, peer_id: claudePeer.id, text: 'new request after broker restart' } }));
    for (let i = 0; i < 100 && !notifications.some((n) => n.meta.request_id === afterRestartId); i++) await delay(25);
    assert.ok(notifications.some((n) => n.meta.request_id === afterRestartId));
    assert.equal(notifications.filter((n) => n.meta.request_id === interruptedId).length, 1);
    // 알림 표시는 저장 파일에 남는다 — 브로커를 다시 띄워도 끝난 요청이 다시 밀려 나오지 않는다.
    assert.equal(notifications.filter((n) => n.meta.request_id === reverseId).length, 1);
    data(await claude.callTool({ name: 'reply', arguments: { request_id: afterRestartId, text: 'recovered' } }));
    assert.equal(data(await codex.callTool({ name: 'get_reply', arguments: { request_id: afterRestartId } })).reply, 'recovered');
  } finally {
    await codex.close(); await claude.close();
    await broker.stop(); rmSync(directory, { recursive: true });
  }
});
