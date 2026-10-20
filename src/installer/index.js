import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveProject } from '../domain/project.js';

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

// 一次 Bash 调用只检查一个文件，多写目标只会互相判冲、让彼此都没法干活。
function makeHookGroup(hookCommand) {
  return {
    // 命中可能写文件的命令。刻意不写 "*"：每条命令都会起一次 node 进程，
    // 而这个 hook 的单次预算是 1000ms。
    matcher: `Bash|Write|Edit|MultiEdit|NotebookEdit|Update|apply_patch`,
    hooks: [{ type: 'command', command: hookCommand, timeout: 5 }]
  };
}

// PostToolUse 钩子：用于命令完成后的毫秒级排他资源释放（如 tests, dev-server, build）与 git 提交租约收尾
function makePostHookGroup(hookCommand) {
  return {
    matcher: `Bash`,
    hooks: [{ type: 'command', command: hookCommand, timeout: 5 }]
  };
}

// 1. 注入 Claude Code
export function installClaudeHook(customClaudeDir = null) {
  const hookPath = assertHookScriptExists();
  const claudeConfigDir = customClaudeDir || join(homedir(), '.claude');
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
  settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];

  if (!Array.isArray(settings.hooks.PreToolUse)) {
    throw new Error(`"hooks.PreToolUse" in ${settingsPath} is not an array; left untouched.`);
  }
  if (!Array.isArray(settings.hooks.PostToolUse)) {
    throw new Error(`"hooks.PostToolUse" in ${settingsPath} is not an array; left untouched.`);
  }

  // 统一分隔符：Windows 上 JSON 里的反斜杠必须转义，否则写出的配置解析不了。
  const hookCommand = `node "${isAbsolute(hookPath) ? hookPath : resolve(hookPath)}"`;
  const postHookCommand = `node "${isAbsolute(hookPath) ? hookPath : resolve(hookPath)}" --post`;

  // Claude Code 的 PreToolUse 是「matcher 分组 + 内嵌 hooks 处理器」的嵌套结构，
  // 不是命令字符串数组。写成 ["node ..."] 宿主根本不会执行它。
  // 同时兼容历史的字符串写法：已装过的旧配置升级成正确结构。
  let preInstalled = false;
  let preUpgraded = false;
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.flatMap((group) => {
    if (typeof group === 'string') {
      if (!group.includes('nexus-hook.mjs')) return [group];
      if (preInstalled) return []; // 旧版会重复 push 同一路径，这里顺手去重
      preInstalled = true;
      preUpgraded = true;
      return [makeHookGroup(hookCommand)];
    }
    // 已用正确结构装过：整组判定，不去动别人写的 matcher 分组。
    if (preInstalled) return [group];
    const handlers = Array.isArray(group.hooks) ? group.hooks : [];
    if (!handlers.some((h) => h && typeof h.command === 'string' && h.command.includes('nexus-hook.mjs'))) {
      return [group];
    }
    preInstalled = true;
    return [group];
  });

  if (!preInstalled) {
    settings.hooks.PreToolUse.push(makeHookGroup(hookCommand));
  }

  // 配置 PostToolUse 钩子 (实现方案一：命令执行完后毫秒级释放资源锁与 git 租约)
  let postInstalled = false;
  let postUpgraded = false;
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.flatMap((group) => {
    if (typeof group === 'string') {
      if (!group.includes('nexus-hook.mjs')) return [group];
      if (postInstalled) return [];
      postInstalled = true;
      postUpgraded = true;
      return [makePostHookGroup(postHookCommand)];
    }
    if (postInstalled) return [group];
    const handlers = Array.isArray(group.hooks) ? group.hooks : [];
    if (!handlers.some((h) => h && typeof h.command === 'string' && h.command.includes('nexus-hook.mjs'))) {
      return [group];
    }
    postInstalled = true;
    return [group];
  });

  if (!postInstalled) {
    settings.hooks.PostToolUse.push(makePostHookGroup(postHookCommand));
  }

  if (!preInstalled || preUpgraded || !postInstalled || postUpgraded) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log(`[Agent-Nexus] Successfully installed PreToolUse and PostToolUse hooks to Claude Code (${settingsPath})`);
  } else {
    console.log(`[Agent-Nexus] Claude Code hooks already installed.`);
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
    nexus_daemon_url: process.env.NEXUS_URL || 'http://127.0.0.1:4300',
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
    daemon_url: process.env.NEXUS_URL || 'http://127.0.0.1:4300',
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

// 4. 注入项目级 MCP 服务器配置 (.mcp.json)
export function installProjectMcp(targetProjectDir = process.cwd()) {
  const info = resolveProject(targetProjectDir);
  const projectRoot = info.projectRoot;
  const mcpConfigPath = join(projectRoot, '.mcp.json');

  let config = { mcpServers: {} };
  if (existsSync(mcpConfigPath)) {
    try {
      config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
    } catch {
      throw new Error(`Cannot parse ${mcpConfigPath}. Please fix or backup this file; left untouched.`);
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }

  const cliPath = join(import.meta.dirname, '../cli.js');
  const normalizedCliPath = (isAbsolute(cliPath) ? cliPath : resolve(cliPath)).replace(/\\/g, '/');
  const normalizedProjectRoot = projectRoot.replace(/\\/g, '/');

  config.mcpServers.nexus = {
    command: 'node',
    args: [normalizedCliPath, 'mcp', '--project', normalizedProjectRoot]
  };

  writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(`[Agent-Nexus] Successfully configured Nexus MCP server in ${mcpConfigPath}`);
  console.log(`  Project ID:   ${info.projectId}`);
  console.log(`  Project Root: ${normalizedProjectRoot}`);
  return { mcpConfigPath, projectRoot: normalizedProjectRoot, projectId: info.projectId };
}
