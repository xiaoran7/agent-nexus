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
  startDaemon();
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

function printHelp() {
  console.log(`
Agent-Nexus CLI:
  nexus start                    启动 daemon 与实时面板
  nexus hook:install [--all]     安装全部 Hook
  nexus hook:install --claude    仅安装 Claude Code Hook
  nexus hook:install --codex     仅配置 Codex / AgentHub
  nexus hook:install --zcode     仅配置 ZCode
  `);
}
