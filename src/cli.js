#!/usr/bin/env node
import { startDaemon } from './daemon/index.js';
import { installAll, installClaudeHook, installCodexHook, installZCodeHook } from './installer/index.js';

const cmd = process.argv[2];

const hooks = {
  '--claude': installClaudeHook,
  '--codex': installCodexHook,
  '--zcode': installZCodeHook
};

if (cmd === 'start') {
  startDaemon().catch((err) => {
    console.error(`\n[Agent-Nexus] Startup failed:\n${err.message}\n`);
    process.exit(1);
  });
} else if (cmd === 'token') {
  issueToken();
} else if (cmd === 'hook:install') {
  const target = process.argv[3];
  (hooks[target] || installAll)();
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h' || !cmd) {
  printHelp();
} else {
  console.error(`Unknown command: ${cmd}\n`);
  printHelp();
  process.exit(1);
}

// 令牌存在运行中的 daemon 内存里，只能由 daemon 签发——所以这条命令
// 走 HTTP 找运行中的实例要一枚，不是本地生成一枚新的。
async function issueToken() {
  const agentId = process.argv[3];
  if (!agentId) {
    console.error('Usage: nexus token <agent-id>\n');
    process.exit(1);
  }
  const port = process.env.NEXUS_PORT || '4100';
  const adminToken = process.env.NEXUS_ADMIN_TOKEN;
  if (!adminToken) {
    console.error(
      'NEXUS_ADMIN_TOKEN is required: paste the observer token printed when the daemon started.\n'
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

function printHelp() {
  console.log(`
Agent-Nexus CLI:
  nexus start                    启动 daemon 与实时面板
  nexus token <agent-id>         向运行中的 daemon 签发该 agent 的令牌
  nexus hook:install [--all]     安装全部 Hook
  nexus hook:install --claude    仅安装 Claude Code Hook
  nexus hook:install --codex     仅配置 Codex / AgentHub
  nexus hook:install --zcode     仅配置 ZCode

认证：/api/* 与 WebSocket 都需要令牌。daemon 启动时打印一枚 operator 令牌；
用它执行 nexus token <agent-id> 换取绑定某个 agent 的令牌。重复签发会作废上一枚。
  `);
}
