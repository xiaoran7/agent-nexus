#!/usr/bin/env node
// =============================================================================
// Agent-Nexus Universal Hook (通用拦截脚本)
// =============================================================================

import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

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

// 只有真正改文件的工具才值得去问协调库。Read/Grep/Glob/LS 之类拿到 file_path
// 也不该被判冲——误拦的代价（agent 认为文件被占用而绕路）远大于漏拦。
const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Update', 'apply_patch'
]);

function resolveTargetFile(payload) {
  const toolName = payload.tool_name;
  if (toolName && !WRITE_TOOLS.has(toolName)) return null;

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

// Bash 没有 file_path，目标是命令行本身。只在命令确实会写入、且参数里带有
// 本地文件路径时才挑一个目标出来。
//
// 两个条件都必须满足，缺一不可：
//   1. 命令是写入动作（>、tee、sed -i、cp/mv 目的端、截断重定向……）。
//      否则 `cat src/a.js` 也会被当成写入，把只读操作误判成冲突。
//   2. 路径能解析到本仓库工作目录之下。装到全局的 hook 会收到别处的调用，
//      拿 /etc/hosts、别个项目的文件去判冲只会平白阻断。
const WRITE_COMMAND_RE =
  /(?:^|[^>])>{1,2}\s*|(?:^|\s)(?:tee|truncate)\s|(?:^|\s)(?:sed|perl)\s[^|;]*\s-i(?:\s|$)|(?:\bcp\b|\bmv\b|\binstall\b)\s/;

// cp/mv/install 改写的是目的端，不是源。取最后一个路径参数才是真正被写入的文件。
const COPY_COMMAND_RE = /(?:\bcp\b|\bmv\b|\binstall\b)\s/;

function extractBashTarget(payload, workspaceDir) {
  const command = (payload.tool_input || payload.input || {}).command;
  if (typeof command !== 'string' || !command) return null;
  if (!WRITE_COMMAND_RE.test(command)) return null;

  // 先按出现顺序取出全部路径 token，再决定取哪个。
  // 不能先按"在工作目录内"过滤：cp 的源和目的分处两侧时，过滤会把源留下，
  // 于是 `cp a.js /tmp/b.js` 反倒判成"要写 a.js"，把一次无关的拷贝拦下来。
  const paths = [];
  for (const token of command.match(/"[^"]*"|'[^']*'|[^\s;&|]+/g) || []) {
    const candidate = token.replace(/^["']|["']$/g, '');
    // 反引号与 $() 里的内容无法静态还原，跳过而不是猜。
    if (/[`$()]/.test(candidate)) continue;
    // 纯命令行开关（-rf、--config）不含路径分隔符，排除。
    if (!candidate.includes('/') && !candidate.includes(String.fromCharCode(92))) continue;
    paths.push(candidate);
  }

  if (paths.length === 0) return null;

  // cp/mv/install 改写的是目的端（最后一个路径），其余写入命令取第一个。
  const target = COPY_COMMAND_RE.test(command) ? paths[paths.length - 1] : paths[0];

  // 工作目录之外的文件不参与判冲：hook 装到全局后，会收到别处项目的调用，
  // 拿那些路径去判冲只会平白阻断。
  const abs = isAbsolute(target) ? target : join(workspaceDir, target);
  const rel = relative(workspaceDir, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;

  return target;
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
          resolvePromise({ allow: true, reason: 'unparseable-response' });
        }
      });
    });

    // daemon 明确拒收这个请求（如目标文件缺失）时不能放行。
    // 直接 exit 0 会把「协调库不知道这个文件」变成一次静默放行，
    // 而调用方以为检查通过了。fail-closed 并把原因交给 stderr。
    req.on('response', (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        resolvePromise({
          allow: false,
          rejected: true,
          reason: `Agent-Nexus rejected this request (HTTP ${res.statusCode}). The coordinator could not evaluate it.`
        });
      }
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
  // 工作目录优先取载荷里的 cwd（宿主告诉我们的调用位置），退回环境变量。
  // daemon 用自己的 cwd 解析相对路径，两者不一致会让判冲落到不同文件上。
  const workspaceDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const targetFile = resolveTargetFile(payload) || extractBashTarget(payload, workspaceDir);

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
