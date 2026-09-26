#!/usr/bin/env node
import { installAll, installClaudeHook, installCodexHook, installZCodeHook } from './installer/index.js';

const cmd = process.argv[2];

if (cmd === 'hook:install') {
  const target = process.argv[3];
  if (target === '--claude') {
    installClaudeHook();
  } else if (target === '--codex') {
    installCodexHook();
  } else if (target === '--zcode') {
    installZCodeHook();
  } else {
    installAll();
  }
} else {
  console.log(`
Agent-Nexus CLI:
  nexus hook:install [--all | --claude | --codex | --zcode]
  nexus start
  `);
}
