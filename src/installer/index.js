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
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
  settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];

  if (!Array.isArray(settings.hooks.PreToolUse)) {
    throw new Error(`"hooks.PreToolUse" in ${settingsPath} is not an array; left untouched.`);
  }
  if (!Array.isArray(settings.hooks.PostToolUse)) {
    throw new Error(`"hooks.PostToolUse" in ${settingsPath} is not an array; left untouched.`);
  }

  const hookCommand = `node "${isAbsolute(hookPath) ? hookPath : resolve(hookPath)}"`;
  const postHookCommand = `node "${isAbsolute(hookPath) ? hookPath : resolve(hookPath)}" --post`;

  let preInstalled = false;
  let preUpgraded = false;
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.flatMap((group) => {
    if (typeof group === 'string') {
      if (!group.includes('nexus-hook.mjs')) return [group];
      if (preInstalled) return [];
      preInstalled = true;
      preUpgraded = true;
      return [makeHookGroup(hookCommand)];
    }
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

export function installAll() {
  installClaudeHook();
}
