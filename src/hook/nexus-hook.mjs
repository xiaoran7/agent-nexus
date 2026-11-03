#!/usr/bin/env node
// =============================================================================
// Agent-Nexus Universal Hook (通用拦截脚本)
// =============================================================================

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative } from 'node:path';
import { homedir } from 'node:os';
import { resolveProject } from '../domain/project.js';
import { resolveNexusEndpoint } from '../transport/auth.js';

const ENDPOINT = resolveNexusEndpoint();
const PORT = ENDPOINT.port;
const HOST = ENDPOINT.host;
const PROTOCOL = ENDPOINT.protocol;
const TOKEN = ENDPOINT.token;
const NODE_ID = ENDPOINT.nodeId;
const IS_REMOTE_HUB = ENDPOINT.isRemoteHub;
const doRequest = PROTOCOL === 'https:' ? httpsRequest : httpRequest;

function isLocalPidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 在当前机器本地扫描 ~/.claude/sessions 并验证本地进程/管道存活与真实 Git 项目根
 * 用于远端节点（如 us-zenix）顺带向中心 Hub 同步同机所有在席会话，无需 Hub 跨机读盘或跨机探 PID
 */
function collectLocalClaudePeerSessions() {
  const result = [];
  try {
    const dir = process.env.NEXUS_CLAUDE_SESSIONS_DIR || join(homedir(), '.claude', 'sessions');
    if (!existsSync(dir)) return result;
    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (!data || !data.sessionId || !data.pid) continue;
        const pidAlive = isLocalPidAlive(data.pid);
        let pipeAlive = false;
        if (data.messagingSocketPath) {
          try { pipeAlive = existsSync(data.messagingSocketPath); } catch {}
        }
        const hasPipe = Boolean(data.messagingSocketPath);
        const alive = hasPipe ? pipeAlive : pidAlive;
        if (!alive) continue;

        let projectId = null;
        let projectRoot = null;
        let displayName = null;
        let gitRemote = null;
        if (data.cwd) {
          try {
            const pInfo = resolveProject(data.cwd);
            projectId = pInfo.projectId;
            projectRoot = pInfo.projectRoot;
            displayName = pInfo.displayName;
            gitRemote = pInfo.gitRemote || null;
          } catch {}
        }

        result.push({
          pid: data.pid,
          sessionId: data.sessionId,
          name: data.name || null,
          cwd: data.cwd || null,
          projectId,
          projectRoot,
          displayName,
          gitRemote,
          status: data.status || 'idle',
          startedAt: data.startedAt || null,
          updatedAt: data.updatedAt || null,
          alive: true,
          verified: true
        });
      } catch {}
    }
  } catch {}
  return result;
}

function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function findClaudeSessionInfo(sessionId) {
  try {
    const dir = join(homedir(), '.claude', 'sessions');
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const fullPath = join(dir, f);
        const data = JSON.parse(readFileSync(fullPath, 'utf8'));
        if (data && data.sessionId) {
          if (sessionId && (data.sessionId === sessionId || data.sessionId.startsWith(sessionId) || sessionId.startsWith(data.sessionId))) {
            return data;
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

function resolveAgentIdentity(payload) {
  const provider = process.env.NEXUS_AGENT_PROVIDER ||
                   (process.env.CLAUDE_CODE_SESSION_ID ? 'claude' : null) ||
                   (process.env.CODEX_SESSION_ID ? 'codex' : null) ||
                   (process.env.ZCODE_SESSION_ID ? 'zcode' : null) ||
                   'agent';

  const rawSessionId = process.env.NEXUS_SESSION_ID ||
                       payload.session_id ||
                       process.env.CLAUDE_CODE_SESSION_ID ||
                       process.env.CODEX_SESSION_ID ||
                       process.env.ZCODE_SESSION_ID ||
                       null;
  // 若无持久化 UUID 而退回本机进程号，在跨机模式下拼入 NODE_ID 防止两台机器碰巧相同 PID 撞车
  const sessionId = rawSessionId || (IS_REMOTE_HUB ? `${NODE_ID}-${process.ppid || process.pid}` : `${process.ppid || process.pid}`);

  const agentId = `${provider}-${sessionId}`;
  const promptHint = process.env.NEXUS_AGENT_PROMPT || payload.prompt || null;

  // 核心安全防线：短生命周期的 Hook 进程自身 PID (process.pid) 或瞬态 shell (process.ppid)
  // 绝不能作为常驻 Agent 会话存活探针 PID 上报！否则 Hook 进程一旦退出，
  // 服务端 reapDeadAgentLeases 会在毫秒级内误判 Agent 死亡并提前回收租约（导致 Edit 锁瞬间消失）。
  // 只有在明确提供持久化宿主 PID (如 payload.pid、payload.agent_pid、AGENT_PID 环境变量) 时才上报有效数字。
  const rawPid = payload.pid || payload.agent_pid || process.env.NEXUS_AGENT_PID || process.env.CLAUDE_PID || null;
  const parsedPid = rawPid ? parseInt(rawPid, 10) : null;
  let pid = Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;
  let name = payload.name || null;
  let finalPrompt = promptHint;
  let livenessVerified = false;

  if (provider === 'claude') {
    const claudeInfo = findClaudeSessionInfo(sessionId);
    if (claudeInfo) {
      if (!pid && claudeInfo.pid) {
        pid = claudeInfo.pid;
      }
      if (claudeInfo.name && !name) {
        name = claudeInfo.name;
      }
      if (!finalPrompt && claudeInfo.name) {
        finalPrompt = claudeInfo.name;
      }
      if (claudeInfo.messagingSocketPath) {
        try { livenessVerified = existsSync(claudeInfo.messagingSocketPath); } catch {}
      } else if (claudeInfo.pid) {
        livenessVerified = isLocalPidAlive(claudeInfo.pid);
      }
    }
  }

  return { provider, sessionId, agentId, promptHint: finalPrompt, pid, name, livenessVerified };
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

// 资源锁命令特征：测试套件、开发服务器与大型构建等排他性资源
const RESOURCE_COMMAND_PATTERNS = [
  {
    resource: 'tests',
    re: /(?:^|[;&|]\s*)(?:npm\s+(?:test|t\b|run\s+test)|pnpm\s+(?:test|t\b|run\s+test)|yarn\s+test|bun\s+test|npx\s+(?:vitest|jest)|pytest|cargo\s+test|go\s+test|mvn\s+test|gradlew?\s+test)(?:\s|$)/i
  },
  {
    resource: 'dev-server',
    re: /(?:^|[;&|]\s*)(?:npm\s+run\s+dev|pnpm\s+run\s+dev|yarn\s+dev|bun\s+run\s+dev|vite(?:\s|$)|next\s+dev|nuxt\s+dev|flask\s+run|uvicorn|nodemon|webpack\s+serve)(?:\s|$)/i
  },
  {
    resource: 'build',
    re: /(?:^|[;&|]\s*)(?:npm\s+run\s+build|pnpm\s+run\s+build|yarn\s+build|bun\s+run\s+build|cargo\s+build|gradlew?\s+build|mvn\s+package)(?:\s|$)/i
  }
];

function extractBashResource(payload) {
  const toolName = payload.tool_name;
  if (toolName && toolName !== 'Bash') return null;

  const rawCommand = (payload.tool_input || payload.input || {}).command;
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) return null;

  for (const { resource, re } of RESOURCE_COMMAND_PATTERNS) {
    if (re.test(rawCommand)) {
      return resource;
    }
  }
  return null;
}

// Bash 没有 file_path，目标是命令行本身。只在命令确实会写入、且参数里带有
// 本地文件路径时才挑一个目标出来。
//
// 两个条件都必须满足，缺一不可：
//   1. 命令是写入动作（>、tee、sed -i、cp/mv 目的端、截断重定向……）。
//      注意：必须排除箭头函数 (=>)、指针箭头 (->) 与比较符。
//      否则 `cat src/a.js` 也会被当成写入，把只读操作误判成冲突。
//   2. 路径能解析到本仓库工作目录之下。装到全局的 hook 会收到别处的调用，
//      拿 /etc/hosts、别个项目的文件去判冲只会平白阻断。
const WRITE_COMMAND_RE =
  /(?:^|[^>=\-\s])\s*>{1,2}\s+[^\s;&|]+|(?:^|\s)(?:tee|truncate)\s|(?:^|\s)(?:sed|perl)\s[^|;]*\s-i(?:\s|$)|(?:\bcp\b|\bmv\b|\binstall\b)\s/;

// cp/mv/install 改写的是目的端，不是源。取最后一个路径参数才是真正被写入的文件。
const COPY_COMMAND_RE = /(?:\bcp\b|\bmv\b|\binstall\b)\s/;

function extractBashTarget(payload, workspaceDir) {
  const rawCommand = (payload.tool_input || payload.input || {}).command;
  if (typeof rawCommand !== 'string' || !rawCommand) return null;

  // 1. 先剥离丢弃输出的 /dev/null 重定向与描述符重定向 (如 2>/dev/null, 2>&1)
  const cleanCmd = rawCommand
    .replace(/(?:[0-9]|&)?>>?\s*\/dev\/null/g, ' ')
    .replace(/[0-9]?&>[0-9]/g, ' ')
    .trim();

  if (!cleanCmd || !WRITE_COMMAND_RE.test(cleanCmd)) return null;

  // 2. 如果包含重定向写入 (> 或 >>)，排除 => 和 ->
  const redirectMatch = cleanCmd.match(/(?:^|[^>=\-0-9])>>?\s*([^\s;&|]+)/);
  if (redirectMatch) {
    const target = redirectMatch[1].replace(/^["']|["']$/g, '');
    if (target && !/[`$()]/.test(target)) {
      const abs = isAbsolute(target) ? target : join(workspaceDir, target);
      const rel = relative(workspaceDir, abs);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
        return target;
      }
    }
    return null;
  }

  // 3. 针对 cp/mv/install/tee/truncate/sed -i 等命令
  const paths = [];
  for (const token of cleanCmd.match(/"[^"]*"|'[^']*'|[^\s;&|]+/g) || []) {
    const candidate = token.replace(/^["']|["']$/g, '');
    if (/[`$()]/.test(candidate)) continue;
    if (!candidate.includes('/') && !candidate.includes(String.fromCharCode(92))) continue;
    paths.push(candidate);
  }

  if (paths.length === 0) return null;

  // cp/mv/install 改写的是目的端（最后一个路径），其余写入命令取第一个。
  const target = COPY_COMMAND_RE.test(cleanCmd) ? paths[paths.length - 1] : paths[0];

  if (workspaceDir && workspaceDir.startsWith('/')) {
    const abs = posix.isAbsolute(target) ? posix.normalize(target) : posix.join(workspaceDir, target);
    const rel = posix.relative(posix.normalize(workspaceDir), abs);
    if (!rel || rel.startsWith('..') || posix.isAbsolute(rel)) return null;
    return target;
  }

  const abs = isAbsolute(target) ? target : join(workspaceDir, target);
  const rel = relative(workspaceDir, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;

  return target;
}

// Git 提交与推送生命周期命令特征：用于工作完成后的零感租约自动释放
const GIT_RELEASE_COMMAND_RE = /(?:^|[;&|]\s*)git\s+(?:commit|push)(?:\s|$)/i;
const GIT_PUSH_COMMAND_RE = /(?:^|[;&|]\s*)git\s+push(?:\s|$)/i;

function isGitCommitOrPush(payload) {
  const toolName = payload.tool_name;
  if (toolName && toolName !== 'Bash') return false;

  const rawCommand = (payload.tool_input || payload.input || {}).command;
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) return false;

  return GIT_RELEASE_COMMAND_RE.test(rawCommand);
}

function extractCommitMessageFromCommand(rawCommand) {
  if (!rawCommand || typeof rawCommand !== 'string') return null;
  // 1. 匹配 Claude Code 常用的 heredoc 提交格式: git commit -m "$(cat <<'EOF'\n标题\n...)"
  const heredocMatch = rawCommand.match(/<<['"]?EOF['"]?\s*\r?\n([^\r\n]+)/i);
  if (heredocMatch && heredocMatch[1].trim()) {
    return heredocMatch[1].trim();
  }
  // 2. 匹配常规 -m "..." / -m '...' / --message="..."
  const msgMatch = rawCommand.match(/(?:-m|--message)(?:=|\s+)(?:"([^"$`\r\n]+)"|'([^'\r\n]+)'|([^\s;&|"']+))/);
  const candidate = (msgMatch && (msgMatch[1] || msgMatch[2] || msgMatch[3])) ? (msgMatch[1] || msgMatch[2] || msgMatch[3]).trim() : null;
  return candidate || null;
}

function runGitQuick(args, cwd) {
  try {
    if (!cwd || !existsSync(cwd)) return '';
    return execFileSync('git', args, {
      cwd,
      timeout: 600,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

/**
 * 提取真实的 Git 提交说明与涉及改动文件列表，供跨机接力工单精准合成
 */
function extractGitReleaseContext(payload, workspaceDir, isPost = false) {
  const rawCommand = (payload.tool_input || payload.input || {}).command || '';
  const isPush = GIT_PUSH_COMMAND_RE.test(rawCommand);
  const cmdMsg = extractCommitMessageFromCommand(rawCommand);

  let headSubject = null;
  let headFiles = [];
  let stagedFiles = [];

  if (isPost || isPush) {
    const logOut = runGitQuick(['log', '-1', '--pretty=%ct%n%s'], workspaceDir);
    if (logOut) {
      const lines = logOut.split(/\r?\n/);
      const commitTs = parseInt(lines[0], 10);
      const subject = (lines[1] || '').trim();
      const nowSec = Math.floor(Date.now() / 1000);
      // git push 直接信任 HEAD；git commit 的 PostToolUse 仅在 HEAD 是近期新生成提交时采信，防止空提交失败误读历史旧提交
      if (subject && (isPush || (Number.isFinite(commitTs) && Math.abs(nowSec - commitTs) <= 120))) {
        headSubject = subject;
        const diffOut = runGitQuick(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD'], workspaceDir);
        if (diffOut) {
          headFiles = diffOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        }
      }
    }
  }

  if (!isPost && !isPush) {
    const stagedOut = runGitQuick(['diff', '--cached', '--name-only'], workspaceDir) ||
                      (/\s-[a-zA-Z]*a/.test(rawCommand) ? runGitQuick(['diff', '--name-only', 'HEAD'], workspaceDir) : '');
    if (stagedOut) {
      stagedFiles = stagedOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
  }

  const lastCommit = (isPost ? headSubject : cmdMsg) || cmdMsg || headSubject || null;
  const modifiedFiles = (isPost && headFiles.length > 0)
    ? headFiles
    : (stagedFiles.length > 0 ? stagedFiles : headFiles);

  if (!lastCommit && modifiedFiles.length === 0) return null;
  return {
    ...(lastCommit ? { lastCommit } : {}),
    ...(modifiedFiles.length > 0 ? { modifiedFiles } : {})
  };
}

function notifyGitRelease(payload) {
  return new Promise((resolvePromise) => {
    const data = JSON.stringify(payload);
    const req = doRequest({
      host: HOST,
      port: PORT,
      path: '/api/hook/git-release',
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
      },
      timeout: IS_REMOTE_HUB ? 2500 : 1500,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try {
          resolvePromise(JSON.parse(buf));
        } catch {
          resolvePromise({ success: true });
        }
      });
    });

    req.on('error', () => resolvePromise({ success: false, offline: true }));
    req.on('timeout', () => {
      req.destroy();
      resolvePromise({ success: false, timeout: true });
    });

    req.write(data);
    req.end();
  });
}

function notifyResourceRelease(payload) {
  return new Promise((resolvePromise) => {
    const data = JSON.stringify(payload);
    const req = doRequest({
      host: HOST,
      port: PORT,
      path: '/api/hook/resource-release',
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
      },
      timeout: IS_REMOTE_HUB ? 2500 : 1500,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try {
          resolvePromise(JSON.parse(buf));
        } catch {
          resolvePromise({ success: true });
        }
      });
    });

    req.on('error', () => resolvePromise({ success: false, offline: true }));
    req.on('timeout', () => {
      req.destroy();
      resolvePromise({ success: false, timeout: true });
    });

    req.write(data);
    req.end();
  });
}

let stdoutHandoffEmitted = false;

// =============================================================================
// 子代理生命周期 (SubagentStart / SubagentStop)
// =============================================================================
// 启用开关：默认关闭，NEXUS_TRACK_AGENTS=1 才上报。关闭时不发任何请求，
// 也不改变原有 Hook 行为，回退只要删掉这个环境变量。
const TRACK_AGENTS = process.env.NEXUS_TRACK_AGENTS === '1';

/**
 * 从子代理转录文件读取元数据。
 *
 * SubagentStart 的载荷只有 agent_id 和 agent_type，没有描述和模型。
 * 但 CLI 会在派发时就写好 <agentId>.meta.json，里面有 description / model /
 * parentAgentId / spawnDepth —— 这些正是树上要显示的真实信息。
 * 读不到就留空，界面上显示"未记录"，绝不拿 agent_type 冒充任务描述。
 */
function readSubagentMeta(transcriptPath, agentId) {
  if (!transcriptPath || !agentId) return null;
  try {
    const dir = join(dirname(transcriptPath), 'subagents');
    const key = String(agentId).replace(/^agent-/, '');
    const candidates = [`agent-${key}.meta.json`, `${key}.meta.json`];
    for (const name of candidates) {
      const full = join(dir, name);
      if (!existsSync(full)) continue;
      const parsed = JSON.parse(readFileSync(full, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      return {
        description: typeof parsed.description === 'string' ? parsed.description : null,
        model: typeof parsed.model === 'string' ? parsed.model : null,
        parentAgentId: typeof parsed.parentAgentId === 'string' ? parsed.parentAgentId : null,
        spawnDepth: Number.isInteger(parsed.spawnDepth) ? parsed.spawnDepth : null,
        agentType: typeof parsed.agentType === 'string' ? parsed.agentType : null,
        requestShape: typeof parsed.requestShape === 'string' ? parsed.requestShape : null
      };
    }
  } catch {}
  return null;
}

/** 子代理转录文件的首条记录时间 = 真实开工时刻，用于补全漏掉 SubagentStart 的情况。 */
function readSubagentStartTime(transcriptPath, agentId) {
  if (!transcriptPath || !agentId) return null;
  try {
    const key = String(agentId).replace(/^agent-/, '');
    const full = join(dirname(transcriptPath), 'subagents', `agent-${key}.jsonl`);
    if (!existsSync(full)) return null;
    // 只读文件开头几 KB：首条记录就是最老的一条，没必要读整份转录。
    const fd = openSync(full, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, n).toString('utf8');
      const line = head.split('\n').find((l) => l.trim());
      if (!line) return null;
      const first = JSON.parse(line.replace(/\}[\s\S]*$/, '}'));
      const ts = Date.parse(first?.timestamp);
      return Number.isFinite(ts) ? ts : null;
    } finally {
      closeSync(fd);
    }
  } catch {}
  return null;
}

/**
 * SubagentStart / SubagentStop 上报。
 *
 * 这是子代理唯一的可信来源：只有在 CLI 真的开始/结束一个子代理时才会触发，
 * 不是我们去猜哪个 Agent 工具调用产生了子代理。失败静默，绝不阻塞工具调用。
 */
function notifySubagentEvent(endpoint, payload, extra) {
  return new Promise((resolvePromise) => {
    try {
      const data = JSON.stringify({ ...payload, ...extra });
      const req = doRequest({
        host: HOST,
        port: PORT,
        path: endpoint,
        method: 'POST',
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
        },
        timeout: IS_REMOTE_HUB ? 2500 : 1200
      }, (res) => {
        let buf = '';
        res.on('data', (c) => buf += c);
        res.on('end', () => {
          try { resolvePromise(JSON.parse(buf)); } catch { resolvePromise({ success: true }); }
        });
      });
      req.on('error', () => resolvePromise({ success: false, offline: true }));
      req.on('timeout', () => {
        req.destroy();
        resolvePromise({ success: false, timeout: true });
      });
      req.write(data);
      req.end();
    } catch {
      resolvePromise(false);
    }
  });
}

function printPendingHandoff(h, sessionId = 'global', hookEventName = 'PreToolUse') {
  if (!h || !h.id) return;
  const cachePath = join(homedir(), '.agent-nexus', '.notified-handoffs.json');
  try {
    let notified = {};
    if (existsSync(cachePath)) {
      notified = JSON.parse(readFileSync(cachePath, 'utf8'));
    }
    const cacheKey = `${sessionId}:${h.id}`;
    if (notified[cacheKey]) return;

    notified[cacheKey] = Date.now();
    const keys = Object.keys(notified);
    if (keys.length > 50) {
      for (const k of keys.slice(0, keys.length - 50)) delete notified[k];
    }
    const dir = dirname(cachePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(notified), 'utf8');
  } catch {}

  const fromHost = h.source_host_id ? `[${h.source_host_id}] ` : '';
  console.error(`\n[Agent-Nexus] 跨机接力上下文：检测到上游节点 ${fromHost}提交的阶段任务 "${h.objective}"`);
  if (h.modified_files && h.modified_files.length > 0) {
    console.error(`  - 已改动文件: ${h.modified_files.slice(0, 5).join(', ')}${h.modified_files.length > 5 ? ` 等共 ${h.modified_files.length} 个文件` : ''}`);
  }
  if (h.next_action) {
    console.error(`  - 建议接力动作: ${h.next_action}\n`);
  }

  // Claude Code 在 exit(0) 时会隐藏 stderr，必须通过 stdout 输出结构化 hookSpecificOutput.additionalContext
  // 才能将跨机接力上下文真正注入大模型的上下文窗口；不传 permissionDecision 以保留用户原有的权限审批门禁。
  if (!stdoutHandoffEmitted) {
    stdoutHandoffEmitted = true;
    const contextLines = [
      `[Agent-Nexus 跨机接力上下文] 上游节点 ${fromHost}已提交最新阶段工作 (Handoff ID: ${h.id}):`,
      `- 阶段目标: ${h.objective}`
    ];
    if (h.state_summary && h.state_summary !== h.objective) {
      contextLines.push(`- 完成状态: ${h.state_summary}`);
    }
    if (Array.isArray(h.modified_files) && h.modified_files.length > 0) {
      contextLines.push(`- 已改动文件: ${h.modified_files.slice(0, 10).join(', ')}${h.modified_files.length > 10 ? ` 等共 ${h.modified_files.length} 个文件` : ''}`);
    }
    if (h.next_action) {
      contextLines.push(`- 建议接力动作: ${h.next_action}`);
    }
    contextLines.push(`提示: 若该仓库存在远端新提交，建议先检查 git status / git pull 同步上游改动后再开始编辑。`);

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hookEventName || 'PreToolUse',
        additionalContext: contextLines.join('\n')
      }
    }) + '\n');
  }
}

function reportTelemetry(payload) {
  return new Promise((resolvePromise) => {
    try {
      const data = JSON.stringify(payload);
      const req = doRequest({
        host: HOST,
        port: PORT,
        path: '/api/hook/telemetry',
        method: 'POST',
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
        },
        timeout: IS_REMOTE_HUB ? 2500 : 1500,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => buf += c);
        res.on('end', () => {
          try {
            resolvePromise(JSON.parse(buf));
          } catch {
            resolvePromise({ success: true });
          }
        });
      });
      req.on('error', () => {
        resolvePromise(false);
      });
      req.on('timeout', () => {
        req.destroy();
        resolvePromise(false);
      });
      req.write(data);
      req.end();
    } catch {
      resolvePromise(false);
    }
  });
}

function checkPermission(payload) {
  return new Promise((resolvePromise) => {
    const data = JSON.stringify(payload);
    const req = doRequest({
      host: HOST,
      port: PORT,
      path: '/api/hook/check',
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
      },
      timeout: IS_REMOTE_HUB ? 2500 : 1000,
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

  const identity = resolveAgentIdentity(payload);
  const projectInfo = resolveProject(workspaceDir);

  // 0.0 子代理生命周期事件：先于一切判冲逻辑处理，直接上报后退出。
  //     这两个事件不携带 tool_name，也不该触发任何租约动作。
  const hookEvent = payload.hook_event_name || payload.event || null;
  if (TRACK_AGENTS && (hookEvent === 'SubagentStart' || hookEvent === 'SubagentStop')) {
    const subId = payload.agent_id || null;
    const meta = readSubagentMeta(payload.transcript_path, subId);
    const common = {
      agent_id: subId,
      session_id: payload.session_id || identity.sessionId,
      host_id: NODE_ID,
      project_id: projectInfo.projectId,
      agent_type: payload.agent_type || meta?.agentType || null,
      description: meta?.description || null,
      model: meta?.model || null,
      parent_agent_id: meta?.parentAgentId || null,
      spawn_depth: meta?.spawnDepth || null,
      run_in_background: meta?.requestShape === 'background',
      at: Date.now()
    };
    if (hookEvent === 'SubagentStart') {
      await notifySubagentEvent('/api/hook/subagent-start', common);
    } else {
      await notifySubagentEvent('/api/hook/subagent-stop', {
        ...common,
        started_at: readSubagentStartTime(payload.transcript_path, subId),
        stop_reason: payload.stop_hook_active ? 'hook_active' : null
      });
    }
    process.exit(0);
  }

  // 0. PostToolUse 闭环处理：命令执行完毕后的毫秒级排他资源释放与提交收尾
  const isPost = process.argv.includes('--post') ||
                 payload.hook_event_name === 'PostToolUse' ||
                 payload.event === 'PostToolUse' ||
                 Boolean(payload.tool_result !== undefined || payload.tool_response !== undefined);

  if (isPost) {
    const targetResource = extractBashResource(payload);
    if (targetResource) {
      const releaseRes = await notifyResourceRelease({
        agent_id: identity.agentId,
        host_id: NODE_ID,
        session_id: identity.sessionId,
        resource_name: targetResource,
        project_id: projectInfo.projectId,
        workspace_dir: workspaceDir,
        reason: 'command_completion'
      });
      if (releaseRes && releaseRes.success) {
        console.error(`[Agent-Nexus] [Auto-Released] Auto-released resource lock '${targetResource}' upon command completion.`);
      }
    }

    if (isGitCommitOrPush(payload)) {
      const gitContext = extractGitReleaseContext(payload, workspaceDir, true);
      const releaseRes = await notifyGitRelease({
        agent_id: identity.agentId,
        host_id: NODE_ID,
        session_id: identity.sessionId,
        project_id: projectInfo.projectId,
        project_root: projectInfo.projectRoot,
        git_remote: projectInfo.gitRemote || null,
        git_context: gitContext,
        workspace_dir: workspaceDir,
        reason: 'git_lifecycle'
      });
      if (releaseRes && releaseRes.releasedCount > 0) {
        console.error(`[Agent-Nexus] [Auto-Released] Auto-released ${releaseRes.releasedCount} lease(s) upon git commit/push and notified waiters.`);
      }
    }

    process.exit(0);
  }

  // 1. 解析工具动作与目标特征
  const toolName = payload.tool_name || null;
  const toolInput = payload.tool_input || payload.input || {};
  const toolTarget = toolInput.file_path || toolInput.path || toolInput.target || toolInput.pattern || null;
  const toolAction = toolName === 'Bash'
    ? (toolInput.command ? toolInput.command.slice(0, 80) : 'Run Command')
    : (toolTarget ? `${toolName} ${basename(toolTarget)}` : toolName);

  // 远端模式下，顺手采集同机 ~/.claude/sessions 活跃会话快照一并捎带给中心 Hub
  // 仅当扫描结果非空时捎带，防止非 Claude Code 宿主（无 ~/.claude/sessions 目录）误传空快照
  const rawPeers = IS_REMOTE_HUB ? collectLocalClaudePeerSessions() : null;
  const peerSessions = rawPeers && rawPeers.length > 0 ? rawPeers : undefined;

  // 2. 优先检查生命周期动作：
  //    对于 Claude Code（携带 hook_event_name === 'PreToolUse' 且已配置 PostToolUse），留到命令真正成功后的 PostToolUse 再释放锁并提取 HEAD 提交，避免空提交失败提前放锁；
  //    对于仅有前置钩子的宿主（如 Codex / ZCode），在此处直接提取暂存区上下文并释放租约。
  if (isGitCommitOrPush(payload) && payload.hook_event_name !== 'PreToolUse') {
    const gitContext = extractGitReleaseContext(payload, workspaceDir, false);
    const releaseRes = await notifyGitRelease({
      agent_id: identity.agentId,
      host_id: NODE_ID,
      session_id: identity.sessionId,
      project_id: projectInfo.projectId,
      project_root: projectInfo.projectRoot,
      git_remote: projectInfo.gitRemote || null,
      git_context: gitContext,
      workspace_dir: workspaceDir,
      reason: 'git_lifecycle'
    });
    if (releaseRes && releaseRes.releasedCount > 0) {
      console.error(`[Agent-Nexus] [Auto-Released] Auto-released ${releaseRes.releasedCount} lease(s) upon git commit/push and notified waiters.`);
    }
    process.exit(0);
  }

  const targetResource = extractBashResource(payload);
  const targetFile = resolveTargetFile(payload) || extractBashTarget(payload, workspaceDir);

  // 3. 仅对纯只读/非锁类工具单独发送 /api/hook/telemetry；
  //    涉及资源锁或文件锁的操作直接将 telemetry 元数据合并进 /api/hook/check 单次 RTT 完成，消除跨机双倍网络往返
  if (toolName && !targetResource && !targetFile) {
    try {
      const telRes = await reportTelemetry({
        agent_id: identity.agentId,
        host_id: NODE_ID,
        provider: identity.provider,
        session_id: identity.sessionId,
        name: identity.name,
        tool: toolName,
        action: toolAction,
        target: toolTarget,
        workspace_dir: workspaceDir,
        project_root: projectInfo.projectRoot,
        git_remote: projectInfo.gitRemote || null,
        project_id: projectInfo.projectId,
        pid: identity.pid,
        liveness_verified: identity.livenessVerified,
        ...(payload.agent_id ? { subagent_id: payload.agent_id } : {}),
        ...(peerSessions ? { peer_sessions: peerSessions } : {})
      });
      if (telRes && telRes.pendingHandoff) {
        printPendingHandoff(telRes.pendingHandoff, identity.sessionId, payload.hook_event_name || 'PreToolUse');
      }
    } catch {}
  }

  // 4. 检查 Bash 是否涉及命名排他性资源（如 tests, dev-server, build）
  if (targetResource) {
    const resourceRes = await checkPermission({
      agent_id: identity.agentId,
      host_id: NODE_ID,
      provider: identity.provider,
      session_id: identity.sessionId,
      name: identity.name,
      prompt_hint: identity.promptHint,
      resource_name: targetResource,
      tool: toolName,
      action: toolAction,
      target: toolTarget || targetResource,
      project_id: projectInfo.projectId,
      project_root: projectInfo.projectRoot,
      git_remote: projectInfo.gitRemote || null,
      workspace_dir: workspaceDir,
      pid: identity.pid,
      liveness_verified: identity.livenessVerified,
      ...(peerSessions ? { peer_sessions: peerSessions } : {})
    });

    if (resourceRes.allow === false) {
      console.error(`\n[Agent-Nexus] [BLOCKED] RESOURCE CONFLICT DETECTED & OPERATION BLOCKED:`);
      console.error(resourceRes.reason || `Resource '${targetResource}' is currently locked by another agent.`);
      if (resourceRes.holder) {
        console.error(`  - Lock Holder:   [${resourceRes.holder}]`);
      }
      if (resourceRes.remainingSec !== undefined) {
        console.error(`  - Estimated ETA: ~${resourceRes.remainingSec}s`);
      }
      if (resourceRes.advice) {
        console.error(`  - Action Advice: ${resourceRes.advice}`);
      } else {
        console.error(`Please WAIT for the concurrent process to finish before running this command.\n`);
      }
      process.exit(2);
    }

    if (resourceRes.pendingHandoff) {
      printPendingHandoff(resourceRes.pendingHandoff, identity.sessionId, payload.hook_event_name || 'PreToolUse');
    }
  }

  // 5. 检查文件改写与文件锁冲突 (支持跨 Worktree 相对化对齐与 #anchor 细粒度锁)
  if (!targetFile) {
    process.exit(0);
  }

  const res = await checkPermission({
    agent_id: identity.agentId,
    host_id: NODE_ID,
    provider: identity.provider,
    session_id: identity.sessionId,
    name: identity.name,
    prompt_hint: identity.promptHint,
    file_path: targetFile,
    tool: toolName,
    action: toolAction,
    target: toolTarget || targetFile,
    project_id: projectInfo.projectId,
    project_root: projectInfo.projectRoot,
    git_remote: projectInfo.gitRemote || null,
    workspace_dir: workspaceDir,
    pid: identity.pid,
    liveness_verified: identity.livenessVerified,
    ...(peerSessions && !targetResource ? { peer_sessions: peerSessions } : {})
  });

  if (res.allow === false) {
    console.error(`\n[Agent-Nexus] [BLOCKED] CONFLICT DETECTED & OPERATION BLOCKED:`);
    console.error(res.reason || `File '${basename(targetFile)}' is currently locked by another agent.`);
    if (res.holder) {
      console.error(`  - Lock Holder:   [${res.holder}]`);
    }
    if (res.holderWorkspace) {
      console.error(`  - Workspace:     ${res.holderWorkspace}`);
    }
    if (res.remainingSec !== undefined) {
      console.error(`  - Estimated ETA: ~${res.remainingSec}s (auto-releases on git commit/push)`);
    }
    if (res.advice) {
      console.error(`  - Action Advice: ${res.advice}`);
    } else {
      console.error(`Please WAIT for the resource to be released, or switch to another independent file/task.\n`);
    }
    process.exit(2);
  }

  if (res.pendingHandoff) {
    printPendingHandoff(res.pendingHandoff, identity.sessionId, payload.hook_event_name || 'PreToolUse');
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
