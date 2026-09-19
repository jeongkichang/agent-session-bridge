#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, openSync, readFileSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeClient } from './client.js';
import { runBroker } from './broker.js';
import { ownerToken, privateDirectory, privateFile, readEndpoint, stateDirectory } from './state.js';
import { BridgeError, nameSchema, idSchema, type BridgeRequest, type Peer } from './contracts.js';
import { VERSION } from './version.js';

const directory = stateDirectory();
const here = dirname(fileURLToPath(import.meta.url));
const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
async function ownerRequest(path: string, method = 'GET') {
  const endpoint = readEndpoint(directory);
  const response = await fetch(endpoint.url + path, { method, headers: { Authorization: `Bearer ${ownerToken(directory)}` }, signal: AbortSignal.timeout(3000), redirect: 'error' });
  const value = await response.json();
  if (!response.ok) throw new Error(`Broker returned HTTP ${response.status}`);
  return value;
}
async function ensureStarted() {
  try { await ownerRequest('/health'); return; } catch { /* check/start the task-owned broker */ }
  privateDirectory(directory);
  const log = join(directory, 'broker.log');
  privateFile(log);
  const fd = openSync(log, 'a', 0o600);
  const child = spawn(process.execPath, [join(here, 'cli.js'), 'serve'], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, AGENT_BRIDGE_STATE_DIR: directory }, cwd: directory });
  closeSync(fd);
  child.unref();
  for (let i = 0; i < 50; i++) {
    try { await ownerRequest('/health'); return; } catch { await delay(100); }
  }
  throw new Error('Broker did not start. Inspect the local broker.log; existing processes were not stopped.');
}
async function mcpCommand(kind: 'claude' | 'codex') {
  await ensureStarted();
  const { runMcp } = await import('./mcp.js');
  await runMcp(kind);
}
async function main() {
  const command = process.argv[2] || 'help';
  if (command === 'serve') { await runBroker(); return; }
  if (command === 'start') { await ensureStarted(); output(await ownerRequest('/health')); return; }
  if (command === 'stop') { output(await ownerRequest('/shutdown', 'POST')); return; }
  if (command === 'status') { output(await ownerRequest('/health')); return; }
  if (command === 'peers') { output(await ownerRequest('/v1/peers')); return; }
  if (command === 'history') { output(await ownerRequest('/v1/requests')); return; }
  if (command === 'get' || command === 'wait') {
    const id = idSchema.parse(process.argv[3]);
    if (command === 'get') output(await ownerRequest(`/v1/requests/${id}`));
    else {
      const endpoint = readEndpoint(directory);
      const response = await fetch(`${endpoint.url}/v1/requests/${id}/wait?timeout_ms=50000`, { headers: { Authorization: `Bearer ${ownerToken(directory)}` }, signal: AbortSignal.timeout(55_000), redirect: 'error' });
      const value = await response.json();
      if (!response.ok) throw new Error(`Broker returned HTTP ${response.status}`);
      output(value);
    }
    return;
  }
  if (command === 'send') {
    const peer = process.argv[3];
    const textFile = argument('--file');
    if (!peer || !textFile) throw new Error('Usage: send <peer-id-or-name> --file <message.txt> [--id <request-uuid>]');
    privateDirectory(directory);
    const identityPath = join(directory, 'cli-identity.json');
    try { writeFileSync(identityPath, JSON.stringify({ id: randomUUID(), secret: randomBytes(32).toString('hex') }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    privateFile(identityPath);
    const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as { id: string; secret: string };
    idSchema.parse(identity.id);
    if (!/^[a-f0-9]{64}$/.test(identity.secret)) throw new Error('Invalid CLI identity');
    const client = new BridgeClient('bridge-cli', 'client', directory, undefined, identity);
    await client.connect();
    try {
      const id = idSchema.parse(argument('--id') || randomUUID());
      let existing: BridgeRequest | undefined;
      if (argument('--id')) {
        try { existing = await client.get(id); }
        catch (error) { if (!(error instanceof BridgeError) || error.code !== 'request_not_found') throw error; }
      }
      let target: string;
      if (existing) {
        if (existing.from.id !== client.id || (existing.to.id !== peer && existing.to.name !== peer)) throw new Error('Request UUID belongs to a different sender or target');
        target = existing.to.id;
      } else {
        const peers = await client.peers();
        const candidates = peers.filter((p) => (p.id === peer || p.name === peer) && p.online);
        if (candidates.length !== 1) throw new Error('Choose one connected peer ID from peers');
        target = candidates[0]!.id;
      }
      output(await client.send({ request_id: id, peer_id: target, text: readFileSync(textFile, 'utf8') }));
    } finally { await client.close(); }
    return;
  }
  if (command === 'codex-mcp') { await mcpCommand('codex'); return; }
  if (command === 'claude-channel') { await mcpCommand('claude'); return; }
  if (command === 'claude-config') {
    const name = nameSchema.parse(argument('--name') || 'claude-bridge');
    output({ mcpServers: { 'session-bridge': { command: process.execPath, args: [join(here, 'cli.js'), 'claude-channel', '--name', name], env: { AGENT_BRIDGE_STATE_DIR: directory } } } });
    return;
  }
  if (command === 'claude') {
    const name = nameSchema.parse(argument('--name') || 'claude-bridge');
    const split = process.argv.indexOf('--');
    const forwarded = split >= 0 ? process.argv.slice(split + 1) : [];
    const config = { mcpServers: { 'session-bridge': { command: process.execPath, args: [join(here, 'cli.js'), 'claude-channel', '--name', name], env: { AGENT_BRIDGE_STATE_DIR: directory } } } };
    await ensureStarted();
    // Additional config is process-local; no existing Claude settings or aliases are edited.
    const child = spawn(process.env.AGENT_BRIDGE_CLAUDE_COMMAND || 'claude', [
      '--dangerously-load-development-channels', 'server:session-bridge', '--mcp-config', JSON.stringify(config), ...forwarded,
    ], { stdio: 'inherit', env: { ...process.env, MCP_PROTOCOL_NEGOTIATION: 'legacy' } });
    child.once('error', () => { process.stderr.write('Cannot launch Claude Code\n'); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    return;
  }
  if (command === 'doctor') {
    // 깨우기는 «연결된 Claude 채널» 이 있어야 돈다(그 연결 안에서 두 루프가 돈다). 고정 문자열 대신 실제로 센다.
    let broker: unknown = { ok: false, reason: 'broker_not_running' };
    let wakeup = 'broker_not_running';
    let listeners = 0;
    try {
      broker = await ownerRequest('/health');
      wakeup = 'peers_unreadable';
      listeners = ((await ownerRequest('/v1/peers')) as { peers: Peer[] }).peers.filter((peer) => peer.kind === 'claude' && peer.online).length;
      wakeup = listeners > 0 ? 'active' : 'no_claude_channel_connected';
    } catch { /* 위에서 잰 값을 그대로 낸다 */ }
    output({
      version: VERSION, node: process.version, state_directory: directory, broker,
      automatic_desktop_wakeup: wakeup, claude_channels_connected: listeners,
      desktop_reply_path: 'pushed reply notice (get_reply for the text) / MCP list_requests / get_reply / wait_reply / receive_message',
      endpoint_file_present: existsSync(join(directory, 'endpoint.json')),
    });
    return;
  }
  process.stdout.write(`Agent Session Bridge\n\nstart | stop | status | doctor | peers | history\nget <request-id> | wait <request-id>\nsend <peer-id-or-name> --file <message.txt> [--id <uuid>]\ncodex-mcp [--name <peer-name>]\nclaude-channel [--name <peer-name>]\nclaude-config [--name <peer-name>]\nclaude --name <peer-name> -- [Claude arguments, e.g. --resume <id>]\n\nClaude's development-channel confirmation and session permissions still apply.\nOnly explicitly connected sessions appear in peers.\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'Bridge command failed'}\n`); process.exitCode = 1; });
