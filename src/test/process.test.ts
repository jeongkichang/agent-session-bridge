import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeClient } from '../client.js';
import { randomUUID } from 'node:crypto';
import { ownerToken, readEndpoint } from '../state.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
function run(args: string[], directory: string, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...extraEnv, AGENT_BRIDGE_STATE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (part) => { output += part; }); child.stderr.resume();
    child.once('error', reject); child.once('exit', (code) => resolve({ code, output }));
  });
}

test('concurrent broker starts share one instance without invalidating peers or accepted work', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-bridge-process-'));
  let sender: BridgeClient | undefined; let receiver: BridgeClient | undefined;
  try {
    const starts = await Promise.all(Array.from({ length: 5 }, () => run(['start'], directory)));
    assert.ok(starts.every((result) => result.code === 0));
    const instance = JSON.parse(starts[0]!.output).instance;
    assert.equal(new Set(starts.map((r) => JSON.parse(r.output).instance)).size, 1);
    sender = new BridgeClient('sender', 'codex', directory); receiver = new BridgeClient('receiver', 'claude', directory);
    await sender.connect(); await receiver.connect();
    const request = await sender.send({ request_id: randomUUID(), peer_id: receiver.id, text: 'preserve live dispatch' });
    await receiver.receive(0);
    const rejected = await run(['serve'], directory);
    assert.notEqual(rejected.code, 0);
    assert.equal((await sender.get(request.request_id)).state, 'delivered');
    const status = await run(['status'], directory);
    assert.equal(JSON.parse(status.output).instance, instance);
    await receiver.reply(request.request_id, 'still connected');

    const messagePath = join(directory, 'message.txt');
    writeFileSync(messagePath, 'retry after recipient closed');
    const id = randomUUID();
    const original = await run(['send', 'receiver', '--file', messagePath, '--id', id], directory);
    assert.equal(original.code, 0);
    await receiver.close();
    const replacement = new BridgeClient('receiver', 'claude', directory);
    await replacement.connect();
    try {
      const repeated = await run(['send', 'receiver', '--file', messagePath, '--id', id], directory);
      assert.equal(repeated.code, 0);
      assert.equal(JSON.parse(repeated.output).to.id, receiver.id);
      assert.equal((await replacement.receive(0)).message, null);
    } finally { await replacement.close(); }
  } finally {
    await sender?.close(); await receiver?.close();
    try {
      const { url } = readEndpoint(directory);
      await fetch(url + '/shutdown', { method: 'POST', headers: { Authorization: `Bearer ${ownerToken(directory)}` } });
    } catch { /* not started */ }
    await delay(200);
    rmSync(directory, { recursive: true });
  }
});

test('Claude launcher preserves option separators and reports signal termination as failure', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-bridge-launcher-'));
  const stub = join(directory, 'claude-stub');
  try {
    writeFileSync(stub, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    const result = await run(['claude', '--name', 'argv-probe', '--', '--resume', 'session-probe', '--', '-literal prompt'], directory, { AGENT_BRIDGE_CLAUDE_COMMAND: stub });
    assert.equal(result.code, 0);
    const args = JSON.parse(result.output) as string[];
    const separator = args.indexOf('--');
    assert.ok(args.indexOf('--mcp-config') < separator);
    assert.ok(args.indexOf('--dangerously-load-development-channels') < separator);
    assert.deepEqual(args.slice(separator), ['--', '-literal prompt']);
    assert.equal(args[args.indexOf('--resume') + 1], 'session-probe');
    assert.equal(args[args.indexOf('--dangerously-load-development-channels') + 1], 'server:session-bridge');
    // The following option ends Claude's variadic channels argument.
    assert.equal(args[args.indexOf('--dangerously-load-development-channels') + 2], '--mcp-config');
    writeFileSync(stub, `#!${process.execPath}\nprocess.kill(process.pid, 'SIGTERM');\n`);
    const interrupted = await run(['claude', '--name', 'signal-probe'], directory, { AGENT_BRIDGE_CLAUDE_COMMAND: stub });
    assert.notEqual(interrupted.code, 0);
    writeFileSync(stub, `#!${process.execPath}\nprocess.exit(7);\n`);
    assert.equal((await run(['claude', '--name', 'exit-probe'], directory, { AGENT_BRIDGE_CLAUDE_COMMAND: stub })).code, 7);
  } finally {
    try { await run(['stop'], directory); } catch { /* not started */ }
    await delay(200); rmSync(directory, { recursive: true });
  }
});
