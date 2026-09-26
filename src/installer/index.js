import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

// Hook 脚本按脚本自身位置定位，不能用 process.cwd()：
// `nexus hook:install` 从任意目录执行都是合法用法，写进用户配置的是一条
// 长期生效的命令，必须指向真实存在的文件，而不是碰巧等于安装位置的路径。
const HOOK_SCRIPT_PATH = join(import.meta.dirname, '../hook/nexus-hook.mjs');

function assertHookScriptExists() {
  if (!existsSync(HOOK_SCRIPT_PATH)) {
    throw new Error(
      `Hook script not found at ${HOOK_SCRIPT_PATH}. ` +
      'Install the agent-nexus package and run the installer from an npm bin shim, ' +
      'or invoke src/installer directly instead of a partially copied tree.'
    );
  }
  return HOOK_SCRIPT_PATH;
}

// 1. 注入 Claude Code
export function installClaudeHook() {
  const hookPath = assertHookScriptExists();
  const claudeConfigDir = join(homedir(), '.claude');
  mkdirSync(claudeConfigDir, { recursive: true });
  const settingsPath = join(claudeConfigDir, 'settings.json');

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      // 原文件不是合法 JSON：不能拿空配置覆盖，用户的其他设置会一起丢。
      throw new Error(
        `Cannot parse ${settingsPath}. Fix or back up that file before installing; ` +
        'it was left untouched.'
      );
    }
  }

  // Claude Code 的 hooks 是按事件名索引的对象（PreToolUse / PostToolUse ...），
  // 每个键的值才是数组。形状不对时宁可报错，也不去改写用户的配置。
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) {
    throw new Error(`"hooks" in ${settingsPath} has an unexpected shape; left untouched.`);
  }

  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];

  if (!Array.isArray(settings.hooks.PreToolUse)) {
    throw new Error(`"hooks.PreToolUse" in ${settingsPath} is not an array; left untouched.`);
  }

  // 统一分隔符：Windows 上 JSON 里的反斜杠必须转义，否则写出的配置解析不了。
  const hookCommand = `node "${isAbsolute(hookPath) ? hookPath : resolve(hookPath)}"`;
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
  const hookPath = assertHookScriptExists();
  const agenthubConfigDir = join(homedir(), '.agenthub');
  mkdirSync(agenthubConfigDir, { recursive: true });
  const configPath = join(agenthubConfigDir, 'coordinator.json');

  // 已存在的配置改写前先合并，而不是整份覆盖：
  // 这份文件里可能有其他 runtime 也在用的字段。
  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8')) || {};
    } catch {
      throw new Error(`Cannot parse ${configPath}; left untouched.`);
    }
  }

  Object.assign(config, {
    enabled: true,
    nexus_daemon_url: process.env.NEXUS_URL || 'http://127.0.0.1:4100',
    enforce_pre_edit: true,
    hook_script: hookPath
  });

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(`[Agent-Nexus] Successfully configured Nexus gateway for Codex / AgentHub runtime (${configPath})`);
}

// 3. 注入 ZCode
export function installZCodeHook() {
  const hookPath = assertHookScriptExists();
  const zcodeDir = join(homedir(), '.zcode');
  mkdirSync(zcodeDir, { recursive: true });
  const configPath = join(zcodeDir, 'nexus-guard.json');

  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8')) || {};
    } catch {
      throw new Error(`Cannot parse ${configPath}; left untouched.`);
    }
  }

  Object.assign(config, {
    enabled: true,
    daemon_url: process.env.NEXUS_URL || 'http://127.0.0.1:4100',
    pre_edit_hook: hookPath
  });

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
