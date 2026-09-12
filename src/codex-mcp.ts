#!/usr/bin/env node
import { runMcp } from './mcp.js';
runMcp('codex').catch(() => { process.stderr.write('session-bridge: cannot connect; run agent-session-bridge start first\n'); process.exitCode = 1; });
