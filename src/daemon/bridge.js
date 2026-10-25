// =============================================================================
// Agent-Nexus Edge Session Bridge (轻量无状态远端工作区会话同步桥)
// 运行于远端工作区（如 us-zenix），不开端口、不启面板、不建本地数据库；
// 仅监听本地 ~/.claude/sessions 变动并周期推送在席会话快照至中心 Hub 面板。
// =============================================================================

import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getClaudeSessionRegistry } from './coordinator.js';
import { resolveProject } from '../domain/project.js';
import { resolveNexusEndpoint } from '../transport/auth.js';

export function buildLocalSessionPayload(sessionsDir = null) {
  const dir = sessionsDir || process.env.NEXUS_CLAUDE_SESSIONS_DIR || join(homedir(), '.claude', 'sessions');
  const rawSessions = getClaudeSessionRegistry(dir);
  const active = [];

  for (const s of rawSessions) {
    if (!s.alive) continue;
    let projectId = null;
    let projectRoot = null;
    let displayName = null;
    if (s.cwd) {
      try {
        const pInfo = resolveProject(s.cwd);
        projectId = pInfo.projectId;
        projectRoot = pInfo.projectRoot;
        displayName = pInfo.displayName;
      } catch {}
    }

    active.push({
      pid: s.pid,
      sessionId: s.sessionId,
      name: s.name || null,
      cwd: s.cwd || null,
      projectId,
      projectRoot,
      displayName,
      status: s.status || 'idle',
      startedAt: s.startedAt || null,
      updatedAt: s.updatedAt || null,
      alive: true,
      verified: true
    });
  }

  return active;
}

export async function pushRemoteSessionsOnce(options = {}) {
  const endpoint = resolveNexusEndpoint(options);
  const sessions = buildLocalSessionPayload(options.sessionsDir || null);
  const headers = {
    'Content-Type': 'application/json',
    ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {})
  };

  const res = await fetch(`${endpoint.baseUrl}/api/agents/sync-remote`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      host_id: endpoint.nodeId,
      full_snapshot: true,
      sessions
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Hub rejected sync-remote (HTTP ${res.status}): ${errText}`);
  }
  return res.json();
}

export function startEdgeBridge(options = {}) {
  const endpoint = resolveNexusEndpoint(options);
  const sessionsDir = options.sessionsDir || process.env.NEXUS_CLAUDE_SESSIONS_DIR || join(homedir(), '.claude', 'sessions');
  const intervalMs = options.intervalMs ?? 15000;

  let stopped = false;
  let debounceTimer = null;
  let watcher = null;

  const syncSafe = async () => {
    if (stopped) return;
    try {
      await pushRemoteSessionsOnce({ ...options, sessionsDir });
    } catch (err) {
      if (!options.silent) {
        console.error(`[Agent-Nexus Bridge] Sync warning (${endpoint.baseUrl}): ${err.message}`);
      }
    }
  };

  // 启动即刻推送首帧快照
  const initialPromise = syncSafe();

  if (existsSync(sessionsDir)) {
    try {
      watcher = watch(sessionsDir, { persistent: false }, (_eventType, filename) => {
        if (filename && !filename.endsWith('.json')) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          syncSafe();
        }, 300);
      });
    } catch {}
  }

  const timer = setInterval(syncSafe, intervalMs);

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (watcher) {
      try { watcher.close(); } catch {}
      watcher = null;
    }
  };

  return {
    endpoint,
    sessionsDir,
    initialPromise,
    stop
  };
}
