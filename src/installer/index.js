import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

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

function makeHookGroup(hookCommand) {
  return {
    matcher: `Bash|Write|Edit|MultiEdit|NotebookEdit|Update|apply_patch`,
    hooks: [{ type: 'command', command: hookCommand, timeout: 5 }]
  };
}

function makePostHookGroup(hookCommand) {
  return {
    matcher: `Bash`,
    hooks: [{ type: 'command', command: hookCommand, timeout: 5 }]
  };
}

// 子代理生命周期事件按 agent_type 过滤，一律放行；脚本内部再看 NEXUS_TRACK_AGENTS。
function makeSubagentHookGroup(hookCommand) {
  return {
    matcher: `*`,
    hooks: [{ type: 'command', command: hookCommand, timeout: 5 }]
  };
}

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
      throw new Error(
        `Cannot parse ${settingsPath}. Fix or back up that file before installing; ` +
        'it was left untouched.'
      );
    }
  }

  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) {
    throw new Error(`"hooks" in ${settingsPath} has an unexpected shape; left untouched.`);
  }

  settings.hooks = settings.hooks || {};

  const hookCommand = `node "${isAbsolute(hookPath) ? hookPath : resolve(hookPath)}"`;
  const postHookCommand = `node "${isAbsolute(hookPath) ? hookPath : resolve(hookPath)}" --post`;

  // 幂等安装：同一事件上已有的 nexus-hook.mjs 组保留原样（用户可能改过超时），
  // 不重复追加；字符串形式的旧版配置升级成组对象。
  const ensure = (eventName, makeGroup) => {
    settings.hooks[eventName] = settings.hooks[eventName] || [];
    if (!Array.isArray(settings.hooks[eventName])) {
      throw new Error(`"hooks.${eventName}" in ${settingsPath} is not an array; left untouched.`);
    }
    let installed = false;
    let upgraded = false;
    settings.hooks[eventName] = settings.hooks[eventName].flatMap((group) => {
      if (typeof group === 'string') {
        if (!group.includes('nexus-hook.mjs')) return [group];
        if (installed) return [];
        installed = true;
        upgraded = true;
        return [makeGroup()];
      }
      if (installed) return [group];
      const handlers = Array.isArray(group.hooks) ? group.hooks : [];
      if (!handlers.some((h) => h && typeof h.command === 'string' && h.command.includes('nexus-hook.mjs'))) {
        return [group];
      }
      installed = true;
      return [group];
    });
    const added = !installed;
    if (added) settings.hooks[eventName].push(makeGroup());
    return { upgraded, added };
  };

  const results = [
    ensure('PreToolUse', () => makeHookGroup(hookCommand)),
    ensure('PostToolUse', () => makePostHookGroup(postHookCommand)),
    ensure('SubagentStart', () => makeSubagentHookGroup(hookCommand)),
    ensure('SubagentStop', () => makeSubagentHookGroup(hookCommand))
  ];

  if (results.some((r) => r.added || r.upgraded)) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log(`[Agent-Nexus] Installed PreToolUse / PostToolUse / SubagentStart / SubagentStop hooks (${settingsPath})`);
    console.log(`[Agent-Nexus] Subagent tracking is opt-in: set NEXUS_TRACK_AGENTS=1 to report it.`);
  } else {
    console.log(`[Agent-Nexus] Coding Assistant hooks already installed.`);
  }
}

export function installAll() {
  installClaudeHook();
}
