import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOOK_SCRIPT_PATH = join(process.cwd(), 'src/hook/nexus-hook.mjs');

// 1. 注入 Claude Code
export function installClaudeHook() {
  const claudeConfigDir = join(homedir(), '.claude');
  mkdirSync(claudeConfigDir, { recursive: true });
  const settingsPath = join(claudeConfigDir, 'settings.json');

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      settings = {};
    }
  }

  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];

  const hookCommand = `node "${HOOK_SCRIPT_PATH}"`;
  const exists = settings.hooks.PreToolUse.some(h => typeof h === 'string' && h.includes('nexus-hook.mjs'));

  if (!exists) {
    settings.hooks.PreToolUse.push(hookCommand);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log(`[Agent-Nexus] Successfully installed PreToolUse hook to Claude Code (${settingsPath})`);
  } else {
    console.log(`[Agent-Nexus] Claude Code hook already installed.`);
  }
}

// 2. 注入 Codex / AgentHub Runtime
export function installCodexHook() {
  const agenthubConfigDir = join(homedir(), '.agenthub');
  mkdirSync(agenthubConfigDir, { recursive: true });
  const configPath = join(agenthubConfigDir, 'coordinator.json');

  const config = {
    enabled: true,
    nexus_daemon_url: 'http://127.0.0.1:4100',
    enforce_pre_edit: true,
    hook_script: HOOK_SCRIPT_PATH
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(`[Agent-Nexus] Successfully configured Nexus gateway for Codex / AgentHub runtime (${configPath})`);
}

// 3. 注入 ZCode
export function installZCodeHook() {
  const zcodeDir = join(homedir(), '.zcode');
  mkdirSync(zcodeDir, { recursive: true });
  const configPath = join(zcodeDir, 'nexus-guard.json');

  const config = {
    enabled: true,
    daemon_url: 'http://127.0.0.1:4100',
    pre_edit_hook: HOOK_SCRIPT_PATH
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(`[Agent-Nexus] Successfully configured Nexus guard for ZCode (${configPath})`);
}

export function installAll() {
  console.log('=== Installing Agent-Nexus Universal Hooks ===');
  installClaudeHook();
  installCodexHook();
  installZCodeHook();
  console.log('=== Universal Hook Installation Complete ===');
}
