#!/usr/bin/env node
import { startDaemon, stopDaemon } from './daemon/index.js';
import { installAll, installClaudeHook, installCodexHook, installZCodeHook, installProjectMcp } from './installer/index.js';
import { resolveProject } from './domain/project.js';
import { startMcpStdio } from './mcp/stdio.js';
import { readSessionToken } from './transport/auth.js';

const cmd = process.argv[2];

const hooks = {
  '--claude': installClaudeHook,
  '--codex': installCodexHook,
  '--zcode': installZCodeHook
};

if (cmd === 'start') {
  startDaemon()
    .then((daemon) => {
      const shutdown = async () => {
        console.log('\n[Agent-Nexus] Gracefully shutting down daemon...');
        try {
          await stopDaemon(daemon);
          console.log('[Agent-Nexus] Daemon stopped cleanly.');
          process.exit(0);
        } catch (err) {
          console.error('[Agent-Nexus] Error during shutdown:', err);
          process.exit(1);
        }
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error(`\n[Agent-Nexus] Startup failed:\n${err.message}\n`);
      process.exit(1);
    });
} else if (cmd === 'token') {
  issueToken();
} else if (cmd === 'projects') {
  listProjects();
} else if (cmd === 'project') {
  showProjectInfo(process.argv[3]);
} else if (cmd === 'hook:install') {
  const target = process.argv[3];
  (hooks[target] || installAll)();
} else if (cmd === 'mcp') {
  runMcpStdio();
} else if (cmd === 'mcp:install') {
  const targetDir = process.argv[3] || process.cwd();
  installProjectMcp(targetDir);
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h' || !cmd) {
  printHelp();
} else {
  console.error(`Unknown command: ${cmd}\n`);
  printHelp();
  process.exit(1);
}

function parseMcpArgs() {
  const args = process.argv.slice(3);
  let projectRoot = null;
  let port = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      projectRoot = args[i + 1];
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { projectRoot: projectRoot || process.cwd(), port };
}

function runMcpStdio() {
  const { projectRoot, port } = parseMcpArgs();
  startMcpStdio({
    projectRoot,
    port
  });
}

async function issueToken() {
  const agentId = process.argv[3];
  if (!agentId) {
    console.error('Usage: nexus token <agent-id>\n');
    process.exit(1);
  }
  const port = process.env.NEXUS_PORT || '4300';
  const adminToken = process.env.NEXUS_ADMIN_TOKEN || process.env.NEXUS_TOKEN || readSessionToken();
  if (!adminToken) {
    console.error(
      'NEXUS_ADMIN_TOKEN is required: paste the observer token printed when the daemon started, or start the daemon locally.\n'
    );
    process.exit(1);
  }

  const res = await fetch(`http://127.0.0.1:${port}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ agent_id: agentId })
  });

  if (!res.ok) {
    console.error(`\n[Agent-Nexus] Could not mint a token for "${agentId}" (HTTP ${res.status}):\n`);
    console.error(`  ${(await res.text()).trim()}\n`);
    process.exit(1);
  }
  const { token } = await res.json();
  console.log(token);
}

async function listProjects() {
  const port = process.env.NEXUS_PORT || '4300';
  const token = process.env.NEXUS_ADMIN_TOKEN || process.env.NEXUS_TOKEN || readSessionToken();
  const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  if (!res.ok) {
    console.error(`Failed to list projects (HTTP ${res.status})`);
    process.exit(1);
  }

  const projects = await res.json();
  console.log('\n[Agent-Nexus] Known Projects:');
  for (const p of projects) {
    console.log(`  • ID: ${p.id.padEnd(18)} Root: ${p.root_path || '(default)'}`);
  }
  console.log();
}

function showProjectInfo(targetDir) {
  const info = resolveProject(targetDir || process.cwd());
  console.log('\n[Agent-Nexus] Project Resolution:');
  console.log(`  Project ID:   ${info.projectId}`);
  console.log(`  Project Root: ${info.projectRoot}`);
  console.log(`  Marker:       ${info.marker || '(none, using startDir)'}\n`);
}

function printHelp() {
  console.log(`
Agent-Nexus CLI:
  nexus start                    启动 daemon 与实时面板
  nexus token <agent-id>         向运行中的 daemon 签发该 agent 的令牌
  nexus projects                 查看当前 daemon 登记的所有项目列表
  nexus project [dir]            解析指定目录所属的项目根与 Project ID
  nexus mcp [--project <path>]   以 stdio JSON-RPC 模式运行项目级 MCP 服务
  nexus mcp:install [dir]        为指定项目注入/合并 .mcp.json 配置（对齐 AOCI 模式）
  nexus hook:install [--all]     安装全部物理拦截 Hook (Fail-Closed)
  nexus hook:install --claude    仅安装 Claude Code Hook
  nexus hook:install --codex     仅配置 Codex / AgentHub
  nexus hook:install --zcode     仅配置 ZCode

认证：/api/* 与 WebSocket 需要令牌。daemon 启动时自动将当前活动令牌写入
~/.agent-nexus/session.token，本地 CLI、Hook 与 MCP 客户端均可无感通信。
  `);
}
