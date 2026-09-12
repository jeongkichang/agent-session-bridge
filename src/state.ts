import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export function stateDirectory(): string {
  return resolve(process.env.AGENT_BRIDGE_STATE_DIR || join(homedir(), '.local', 'state', 'agent-session-bridge'));
}

export function privateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('State directory must be a real directory owned by the current user');
  }
  chmodSync(dir, 0o700);
}

export function privateFile(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('State file must be a regular file owned by the current user');
  }
  chmodSync(path, 0o600);
}

export function ownerToken(dir: string): string {
  privateDirectory(dir);
  const path = join(dir, 'owner-token');
  try { writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  privateFile(path);
  const token = readFileSync(path, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid bridge owner token');
  return token;
}

export interface Endpoint { url: string; pid: number; instance: string }
export function readEndpoint(dir: string): Endpoint {
  const path = join(dir, 'endpoint.json');
  privateFile(path);
  const endpoint = JSON.parse(readFileSync(path, 'utf8')) as Endpoint;
  const url = new URL(endpoint.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/') {
    throw new Error('Broker endpoint must be a loopback HTTP origin');
  }
  return endpoint;
}
