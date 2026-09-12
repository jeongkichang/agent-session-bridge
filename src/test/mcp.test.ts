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
  const broker = await startBroker({ directory });
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
  } finally {
    await codex.close(); await claude.close();
    await broker.stop(); rmSync(directory, { recursive: true });
  }
});
