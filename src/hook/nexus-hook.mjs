#!/usr/bin/env node
// =============================================================================
// Agent-Nexus Universal Hook (通用拦截脚本)
// =============================================================================

import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const PORT = parseInt(process.env.NEXUS_PORT || '4100', 10);
const HOST = process.env.NEXUS_HOST || '127.0.0.1';

function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveAgentIdentity(payload) {
  const provider = process.env.NEXUS_AGENT_PROVIDER ||
                   (process.env.CLAUDE_CODE_SESSION_ID ? 'claude' : null) ||
                   (process.env.CODEX_SESSION_ID ? 'codex' : null) ||
                   (process.env.ZCODE_SESSION_ID ? 'zcode' : null) ||
                   'agent';

  const sessionId = process.env.NEXUS_SESSION_ID ||
                    payload.session_id ||
                    process.env.CLAUDE_CODE_SESSION_ID ||
                    process.env.CODEX_SESSION_ID ||
                    process.env.ZCODE_SESSION_ID ||
                    `${process.ppid || process.pid}`;

  const agentId = `${provider}-${sessionId}`;
  const promptHint = process.env.NEXUS_AGENT_PROMPT || payload.prompt || null;

  return { provider, sessionId, agentId, promptHint };
}

function resolveTargetFile(payload) {
  const toolInput = payload.tool_input || payload.input || {};
  if (toolInput.file_path) return toolInput.file_path;
  if (toolInput.path) return toolInput.path;
  if (toolInput.target) return toolInput.target;
  if (Array.isArray(toolInput.files) && toolInput.files.length > 0) return toolInput.files[0];

  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg.includes('/') || arg.includes(String.fromCharCode(92)) || arg.includes('.')) {
      return arg;
    }
  }

  return process.env.CLAUDE_TOOL_FILE || process.env.TOOL_INPUT_PATH || null;
}

function checkPermission(payload) {
  return new Promise((resolvePromise) => {
    const data = JSON.stringify(payload);
    const req = request({
      host: HOST,
      port: PORT,
      path: '/api/hook/check',
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 1000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try {
          resolvePromise(JSON.parse(buf));
        } catch {
          resolvePromise({ allow: true });
        }
      });
    });

    req.on('error', (e) => {
      resolvePromise({ allow: true, offline: true });
    });
    req.on('timeout', () => {
      req.destroy();
      resolvePromise({ allow: true, timeout: true });
    });

    req.write(data);
    req.end();
  });
}

async function main() {
  const payload = readStdinJson();
  const targetFile = resolveTargetFile(payload);

  if (!targetFile) {
    process.exit(0);
  }

  const identity = resolveAgentIdentity(payload);

  const res = await checkPermission({
    agent_id: identity.agentId,
    provider: identity.provider,
    session_id: identity.sessionId,
    prompt_hint: identity.promptHint,
    file_path: targetFile
  });

  if (res.allow === false) {
    console.error(`\n[Agent-Nexus] ⚠️ CONFLICT DETECTED & OPERATION BLOCKED:`);
    console.error(res.reason || `File '${basename(targetFile)}' is currently locked by another agent.`);
    console.error(`Please WAIT for the resource to be released, or switch to another independent file/task.\n`);
    process.exit(2);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
