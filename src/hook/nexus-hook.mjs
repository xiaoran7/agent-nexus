#!/usr/bin/env node
// =============================================================================
// Agent-Nexus Universal Hook (通用拦截脚本)
// =============================================================================

import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { resolveProject } from '../domain/project.js';
import { readSessionToken } from '../transport/auth.js';

const PORT = parseInt(process.env.NEXUS_PORT || '4100', 10);
const HOST = process.env.NEXUS_HOST || '127.0.0.1';
// daemon 要求令牌。优先读取环境变量，缺省时自动回退读取本机活动会话令牌（~/.agent-nexus/session.token）
const TOKEN = process.env.NEXUS_TOKEN || process.env.NEXUS_ADMIN_TOKEN || readSessionToken() || null;

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
//      否则 `cat src/a.js` 也会被当成写入，把只读操作误判成冲突。
//   2. 路径能解析到本仓库工作目录之下。装到全局的 hook 会收到别处的调用，
//      拿 /etc/hosts、别个项目的文件去判冲只会平白阻断。
const WRITE_COMMAND_RE =
  /(?:^|[^>])>{1,2}\s*|(?:^|\s)(?:tee|truncate)\s|(?:^|\s)(?:sed|perl)\s[^|;]*\s-i(?:\s|$)|(?:\bcp\b|\bmv\b|\binstall\b)\s/;

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

  // 2. 如果包含重定向写入 (> 或 >>)
  const redirectMatch = cleanCmd.match(/(?:^|[^>&0-9])>>?\s*([^\s;&|]+)/);
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

  const abs = isAbsolute(target) ? target : join(workspaceDir, target);
  const rel = relative(workspaceDir, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;

  return target;
}

// Git 提交与推送生命周期命令特征：用于工作完成后的零感租约自动释放
const GIT_RELEASE_COMMAND_RE = /(?:^|[;&|]\s*)git\s+(?:commit|push)(?:\s|$)/i;

function isGitCommitOrPush(payload) {
  const toolName = payload.tool_name;
  if (toolName && toolName !== 'Bash') return false;

  const rawCommand = (payload.tool_input || payload.input || {}).command;
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) return false;

  return GIT_RELEASE_COMMAND_RE.test(rawCommand);
}

function notifyGitRelease(payload) {
  return new Promise((resolvePromise) => {
    const data = JSON.stringify(payload);
    const req = request({
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
      timeout: 1500,
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
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
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

  const identity = resolveAgentIdentity(payload);
  const projectInfo = resolveProject(workspaceDir);

  // 1. 优先检查生命周期动作：若执行 git commit / git push，说明当前施工单元完结，零感释放持有的所有租约
  if (isGitCommitOrPush(payload)) {
    const releaseRes = await notifyGitRelease({
      agent_id: identity.agentId,
      project_id: projectInfo.projectId,
      workspace_dir: workspaceDir,
      reason: 'git_lifecycle'
    });
    if (releaseRes && releaseRes.releasedCount > 0) {
      console.error(`[Agent-Nexus] 🚀 Auto-released ${releaseRes.releasedCount} lease(s) upon git commit/push and notified waiters.`);
    }
    process.exit(0);
  }

  // 2. 检查 Bash 是否涉及命名排他性资源（如 tests, dev-server, build）
  const targetResource = extractBashResource(payload);
  if (targetResource) {
    const resourceRes = await checkPermission({
      agent_id: identity.agentId,
      provider: identity.provider,
      session_id: identity.sessionId,
      prompt_hint: identity.promptHint,
      resource_name: targetResource,
      project_id: projectInfo.projectId,
      project_root: projectInfo.projectRoot,
      workspace_dir: workspaceDir
    });

    if (resourceRes.allow === false) {
      console.error(`\n[Agent-Nexus] ⚠️ RESOURCE CONFLICT DETECTED & OPERATION BLOCKED:`);
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
  }

  // 3. 检查文件改写与文件锁冲突 (支持跨 Worktree 相对化对齐与 #anchor 细粒度锁)
  const targetFile = resolveTargetFile(payload) || extractBashTarget(payload, workspaceDir);

  if (!targetFile) {
    process.exit(0);
  }

  const res = await checkPermission({
    agent_id: identity.agentId,
    provider: identity.provider,
    session_id: identity.sessionId,
    prompt_hint: identity.promptHint,
    file_path: targetFile,
    project_id: projectInfo.projectId,
    project_root: projectInfo.projectRoot,
    workspace_dir: workspaceDir
  });

  if (res.allow === false) {
    console.error(`\n[Agent-Nexus] ⚠️ CONFLICT DETECTED & OPERATION BLOCKED:`);
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

  process.exit(0);
}

main().catch(() => process.exit(0));
