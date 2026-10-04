import { randomUUID } from 'node:crypto';
import { normalize, resolve, isAbsolute } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { ValidationError, requireString } from '../domain/errors.js';

export { ValidationError };

const CLAIM_TYPES = new Set(['file', 'module', 'symbol']);

const CLAIM_TARGET_RE = /^[^\s/\\][^\s]*$/;

function toComparablePath(value, baseDir) {
  let resolved = baseDir && !isAbsolute(value) ? resolve(baseDir, value) : resolve(value);
  try {
    if (existsSync(resolved)) {
      resolved = realpathSync(resolved);
    }
  } catch {}
  return normalize(resolved).replace(/\\/g, '/').toLowerCase();
}

function requireAgentId(value) {
  return requireString(value, 'agent_id');
}

function assertClaimTarget(raw, claimType, baseDir) {
  const target = requireString(raw, 'claims[].target');

  if (!CLAIM_TYPES.has(claimType)) {
    throw new ValidationError(
      `Unsupported claim type "${claimType}"; expected one of ${[...CLAIM_TYPES].join(', ')}`,
      'claims[].type'
    );
  }

  if (claimType === 'symbol') {
    if (!CLAIM_TARGET_RE.test(target)) {
      throw new ValidationError('Symbol target must not start with a path separator or whitespace', 'claims[].target');
    }
    return { type: claimType, target: target.toLowerCase() };
  }

  const normalized = toComparablePath(target, baseDir);
  if (normalized === toComparablePath('.', baseDir) || normalized === toComparablePath('/', baseDir)) {
    throw new ValidationError(
      `Claim target "${target}" resolves to a directory root or the working directory, not a specific resource`,
      'claims[].target'
    );
  }
  return { type: claimType, target: normalized };
}

export class CoordinatorEngine {
  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  normalizePath(filePath, baseDir) {
    if (!filePath) return '';
    let resolved = baseDir && !isAbsolute(filePath) ? resolve(baseDir, filePath) : resolve(filePath);
    try {
      if (existsSync(resolved)) {
        resolved = realpathSync(resolved);
      }
    } catch {}
    return normalize(resolved).replace(/\\/g, '/').toLowerCase();
  }

  pathsOverlap(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.startsWith(b + '/') || b.startsWith(a + '/');
  }

  // 三级冲突判定的唯一实现，加入 projectId 作用域
  findConflict(normalizedClaims, agentId, now, projectId = 'default') {
    const activeClaims = this.db.prepare(`
      SELECT c.claim_type, c.claim_target, c.agent_id, l.intent_id, a.name as agent_name
      FROM claims c
      JOIN leases l ON c.intent_id = l.intent_id
      JOIN agents a ON c.agent_id = a.id
      WHERE l.project_id = ? AND l.expires_at > ? AND c.project_id = ?
    `).all(projectId, now, projectId);

    for (const claim of normalizedClaims) {
      for (const active of activeClaims) {
        if (active.agent_id === agentId) {
          continue;
        }

        // Rule 1: 文件精确重合
        if (claim.type === 'file' && active.claim_type === 'file') {
          if (claim.target === active.claim_target) {
            return {
              blockedByAgentId: active.agent_id,
              blockedByAgentName: active.agent_name,
              reason: `File conflict: '${claim.target}' is currently locked by ${active.agent_name}`
            };
          }
        }

        // Rule 2: 模块 / 目录包含关系
        if (claim.type === 'module' || active.claim_type === 'module') {
          if (this.pathsOverlap(claim.target, active.claim_target)) {
            return {
              blockedByAgentId: active.agent_id,
              blockedByAgentName: active.agent_name,
              reason: `Module conflict between '${claim.target}' and '${active.claim_target}' held by ${active.agent_name}`
            };
          }
        }

        // Rule 3: 符号精确重合
        if (claim.type === 'symbol' && active.claim_type === 'symbol') {
          if (claim.target === active.claim_target) {
            return {
              blockedByAgentId: active.agent_id,
              blockedByAgentName: active.agent_name,
              reason: `Symbol conflict: '${claim.target}' is being modified by ${active.agent_name}`
            };
          }
        }
      }
    }
    return null;
  }

  // 1. Agent 注册或心跳续期
  registerAgent({ id, name, provider, sessionId, workspaceDir, projectId = 'default' }) {
    requireAgentId(id);

    const now = Date.now();
    const finalSessionId = sessionId == null ? 'default' : String(sessionId);
    const finalProvider = provider == null ? 'unknown' : String(provider);
    const finalName = name || `${finalProvider}-${finalSessionId.slice(0, 6)}`;
    const finalProjectId = projectId || 'default';

    const stmt = this.db.prepare(`
      INSERT INTO agents (id, project_id, name, provider, session_id, workspace_dir, status, last_heartbeat, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        workspace_dir = excluded.workspace_dir,
        last_heartbeat = excluded.last_heartbeat
    `);
    stmt.run(id, finalProjectId, finalName, finalProvider, finalSessionId, workspaceDir || '', now, now);

    if (workspaceDir && finalProjectId) {
      try {
        const canonicalRoot = toComparablePath(workspaceDir);
        this.db.prepare(`
          INSERT INTO projects (id, root_path, display_name, created_at, last_activity)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            root_path = CASE WHEN projects.root_path IS NULL OR projects.root_path = '' THEN excluded.root_path ELSE projects.root_path END,
            last_activity = excluded.last_activity
        `).run(finalProjectId, canonicalRoot, `Project ${finalProjectId}`, now, now);
      } catch {}
    }

    this.logActivity(id, 'agent:registered', null, `Agent ${finalName} (${finalProvider}) registered/heartbeat`, finalProjectId);
    return this.getAgent(id);
  }

  getAgent(id, projectId = null) {
    if (projectId) {
      return this.db.prepare('SELECT * FROM agents WHERE id = ? AND project_id = ?').get(id, projectId);
    }
    return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  }

  listAgents(projectId = null) {
    if (projectId) {
      return this.db.prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY last_heartbeat DESC').all(projectId);
    }
    return this.db.prepare('SELECT * FROM agents ORDER BY last_heartbeat DESC').all();
  }

  updateAgentStatus(id, status) {
    this.db.prepare('UPDATE agents SET status = ?, last_heartbeat = ? WHERE id = ?').run(status, Date.now(), id);
    this.eventBus.emit('agent:status', { agent_id: id, status });
  }

  // 2. 意图声明与确定性冲突检查 (Core Algorithm)
  declareIntent({ agentId, intentSummary, claims = [], ttlSeconds = 300, projectId = 'default' }) {
    requireAgentId(agentId);
    const summary = requireString(intentSummary, 'summary');
    const finalProjectId = projectId || 'default';

    if (!Array.isArray(claims)) {
      throw new ValidationError('"claims" must be an array', 'claims');
    }

    const agent = this.getAgent(agentId);
    const baseDir = agent?.workspace_dir || '';

    const normalizedClaims = claims.map((c) => {
      if (!c || typeof c !== 'object') {
        throw new ValidationError('"claims" entries must be objects', 'claims');
      }
      return assertClaimTarget(c.target, c.type, baseDir);
    });

    this.expireLeases();
    const now = Date.now();
    const intentId = `intent_${randomUUID().slice(0, 8)}`;

    if (!agent) {
      const parts = agentId.split('-');
      const provider = parts[0] || 'agent';
      const sessionId = parts.slice(1).join('-') || `${now}`;
      this.registerAgent({
        id: agentId,
        name: summary.slice(0, 30),
        provider,
        sessionId,
        workspaceDir: '',
        projectId: finalProjectId
      });
    }

    let conflict = this.findConflict(normalizedClaims, agentId, now, finalProjectId);

    if (!conflict) {
      this.db.prepare(`
        INSERT INTO intents (id, project_id, agent_id, summary, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'granted', ?, ?)
      `).run(intentId, finalProjectId, agentId, summary, now, now);

      const claimInsert = this.db.prepare(`
        INSERT INTO claims (project_id, intent_id, agent_id, claim_type, claim_target, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const c of normalizedClaims) {
        claimInsert.run(finalProjectId, intentId, agentId, c.type, c.target, now);
      }

      const leaseId = `lease_${randomUUID().slice(0, 8)}`;
      const expiresAt = now + (ttlSeconds * 1000);
      this.db.prepare(`
        INSERT INTO leases (id, project_id, intent_id, agent_id, ttl_seconds, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(leaseId, finalProjectId, intentId, agentId, ttlSeconds, expiresAt, now);

      this.updateAgentStatus(agentId, 'running');
      this.logActivity(agentId, 'intent:granted', claims.map(c => c.target).join(', '), `Granted lease for intent: "${summary}"`, finalProjectId);

      return {
        status: 'GRANTED',
        intentId,
        leaseId,
        expiresAt,
        claims: normalizedClaims
      };
    } else {
      this.db.prepare(`
        INSERT INTO intents (id, project_id, agent_id, summary, status, blocked_by_agent_id, blocked_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?)
      `).run(intentId, finalProjectId, agentId, summary, conflict.blockedByAgentId, conflict.reason, now, now);

      const claimInsert = this.db.prepare(`
        INSERT INTO claims (project_id, intent_id, agent_id, claim_type, claim_target, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const c of normalizedClaims) {
        claimInsert.run(finalProjectId, intentId, agentId, c.type, c.target, now);
      }

      this.db.prepare(`
        INSERT INTO wait_queue (project_id, intent_id, agent_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(finalProjectId, intentId, agentId, now);

      this.updateAgentStatus(agentId, 'waiting');
      this.logActivity(agentId, 'intent:blocked', claims.map(c => c.target).join(', '), `Blocked by ${conflict.blockedByAgentName}: ${conflict.reason}`, finalProjectId);

      return {
        status: 'WAITING',
        intentId,
        blockedBy: conflict.blockedByAgentId,
        blockedByName: conflict.blockedByAgentName,
        reason: conflict.reason,
        claims: normalizedClaims
      };
    }
  }

  // 3. 租约释放与等待者主动唤醒
  releaseLease(leaseIdOrIntentId, agentId) {
    if (leaseIdOrIntentId == null || leaseIdOrIntentId === '') {
      return { success: false, message: 'Lease not found or not owned by agent' };
    }

    const now = Date.now();
    const lease = this.db.prepare(`
      SELECT * FROM leases WHERE (id = ? OR intent_id = ?) AND agent_id = ?
    `).get(leaseIdOrIntentId, leaseIdOrIntentId, agentId);

    if (!lease) {
      return { success: false, message: 'Lease not found or not owned by agent' };
    }

    const projectId = lease.project_id || 'default';

    // 查出被释放的 claims 便于发布 resource:freed 事件
    const releasedClaims = this.db.prepare(`
      SELECT claim_type, claim_target FROM claims WHERE intent_id = ?
    `).all(lease.intent_id).map(c => ({ type: c.claim_type, target: c.claim_target }));

    this.db.prepare(`UPDATE intents SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, lease.intent_id);
    this.db.prepare(`DELETE FROM leases WHERE id = ?`).run(lease.id);
    this.db.prepare(`DELETE FROM claims WHERE intent_id = ?`).run(lease.intent_id);

    this._syncAgentRunningStatus(agentId, projectId, now);
    this.logActivity(agentId, 'lease:released', lease.id, `Agent released lease for intent ${lease.intent_id}`, projectId);

    this.eventBus.emit('resource:freed', {
      project_id: projectId,
      resources: releasedClaims,
      released_by: agentId
    });

    const { nextWaiter, skipped } = this._wakeNextEligibleWaiter(projectId, now);

    return {
      success: true,
      releasedLeaseId: lease.id,
      notifiedWaiter: nextWaiter ? {
        agent_id: nextWaiter.agent_id,
        intent_id: nextWaiter.intent_id
      } : null,
      stillBlocked: skipped
    };
  }

  // 内部辅助方法：依据剩余活跃租约准确同步 Agent 运行状态
  _syncAgentRunningStatus(agentId, projectId, now) {
    const active = this.db.prepare(`
      SELECT count(*) as count FROM leases WHERE agent_id = ? AND project_id = ? AND expires_at > ?
    `).get(agentId, projectId, now);
    if ((active?.count || 0) === 0) {
      this.updateAgentStatus(agentId, 'idle');
    } else {
      this.updateAgentStatus(agentId, 'running');
    }
  }

  // 内部辅助方法：复核并唤醒等待队列中首个满足条件的 Agent
  _wakeNextEligibleWaiter(projectId, now) {
    const breadthOf = (intentId) => this.db.prepare(`
      SELECT COALESCE(SUM(
        CASE WHEN claim_type = 'file' THEN 1
             ELSE LENGTH(claim_target) - LENGTH(REPLACE(claim_target, '/', '')) + 1
        END
      ), 0) AS segments, COUNT(*) AS n
      FROM claims WHERE intent_id = ?
    `).get(intentId);

    const candidates = this.db.prepare(`
      SELECT w.intent_id, w.agent_id, i.summary, a.name as agent_name
      FROM wait_queue w
      JOIN intents i ON w.intent_id = i.id
      JOIN agents a ON w.agent_id = a.id
      WHERE w.project_id = ?
      ORDER BY w.id ASC
    `).all(projectId).map((c) => ({ ...c, breadth: breadthOf(c.intent_id) }))
      .sort((a, b) => (b.breadth.segments - a.breadth.segments) || (b.breadth.n - a.breadth.n));

    let nextWaiter = null;
    let skipped = 0;
    for (const cand of candidates) {
      const claims = this.db.prepare(`
        SELECT claim_type, claim_target FROM claims WHERE intent_id = ?
      `).all(cand.intent_id).map((c) => ({ type: c.claim_type, target: c.claim_target }));

      if (claims.length === 0 || this.findConflict(claims, cand.agent_id, now, projectId)) {
        skipped++;
        continue;
      }
      nextWaiter = cand;
      break;
    }

    if (nextWaiter) {
      this.db.prepare(`DELETE FROM wait_queue WHERE intent_id = ?`).run(nextWaiter.intent_id);

      this.db.prepare(`
        UPDATE intents
        SET status = 'released', blocked_by_agent_id = NULL, blocked_reason = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, nextWaiter.intent_id);

      this.logActivity(nextWaiter.agent_id, 'agent:woken', nextWaiter.intent_id, `Notified waiter ${nextWaiter.agent_name} to recheck`, projectId);
      this.eventBus.emit('agent:woken', {
        project_id: projectId,
        agent_id: nextWaiter.agent_id,
        intent_id: nextWaiter.intent_id,
        verified: true,
        message: 'Resource released and your claims are now conflict-free. Refresh workspace and proceed.'
      });
    }

    return { nextWaiter, skipped };
  }

  // 4. 过期租约定时清理（联动释放事件与排队唤醒）
  expireLeases() {
    const now = Date.now();
    const expired = this.db.prepare('SELECT * FROM leases WHERE expires_at <= ?').all(now);
    if (expired.length === 0) return;

    const affectedProjects = new Set();
    const affectedAgents = new Set();

    for (const l of expired) {
      const pid = l.project_id || 'default';
      affectedProjects.add(pid);
      affectedAgents.add({ agentId: l.agent_id, projectId: pid });

      // 提取释放的 claims
      const releasedClaims = this.db.prepare(`
        SELECT claim_type, claim_target FROM claims WHERE intent_id = ?
      `).all(l.intent_id).map(c => ({ type: c.claim_type, target: c.claim_target }));

      this.db.prepare(`UPDATE intents SET status = 'aborted', updated_at = ? WHERE id = ?`).run(now, l.intent_id);
      this.db.prepare(`DELETE FROM leases WHERE id = ?`).run(l.id);
      this.db.prepare(`DELETE FROM claims WHERE intent_id = ?`).run(l.intent_id);
      this.logActivity(l.agent_id, 'lease:expired', l.id, `Lease ${l.id} expired due to TTL timeout`, pid);

      if (releasedClaims.length > 0) {
        this.eventBus.emit('resource:freed', {
          project_id: pid,
          resources: releasedClaims,
          released_by: l.agent_id
        });
      }
    }

    // 同步涉及到的 Agent 状态
    for (const { agentId, projectId } of affectedAgents) {
      this._syncAgentRunningStatus(agentId, projectId, now);
    }

    // 释放资源后，复核并唤醒等待者
    for (const pid of affectedProjects) {
      this._wakeNextEligibleWaiter(pid, now);
    }
  }

  // 5. 极速权限检查与自动补报 (针对通用 Hook)
  fastCheckAndAutoClaim({ agentId, provider, sessionId, filePath, promptHint, projectId = 'default', workspaceDir = '' }) {
    requireAgentId(agentId);
    assertClaimTarget(filePath, 'file', workspaceDir);

    const finalProjectId = projectId || 'default';
    const normalizedFile = this.normalizePath(filePath, workspaceDir);
    const now = Date.now();

    this.registerAgent({
      id: agentId,
      name: promptHint ? promptHint.slice(0, 30) : `${provider || 'agent'}-${(sessionId || 'default').slice(0, 6)}`,
      provider,
      sessionId,
      workspaceDir: workspaceDir || '',
      projectId: finalProjectId
    });

    this.expireLeases();

    const existingLock = this.db.prepare(`
      SELECT c.agent_id, a.name as agent_name, i.summary, l.id as lease_id
      FROM claims c
      JOIN leases l ON c.intent_id = l.intent_id
      JOIN agents a ON c.agent_id = a.id
      JOIN intents i ON c.intent_id = i.id
      WHERE c.project_id = ? AND c.claim_type = 'file' AND c.claim_target = ? AND l.expires_at > ?
    `).get(finalProjectId, normalizedFile, now);

    if (existingLock) {
      if (existingLock.agent_id === agentId) {
        return { allow: true, reason: 'self-held-lease' };
      } else {
        this.logActivity(agentId, 'hook:blocked', normalizedFile, `Blocked write to ${normalizedFile} (held by ${existingLock.agent_name})`, finalProjectId);
        return {
          allow: false,
          holder: existingLock.agent_name,
          reason: `BLOCKED: File '${filePath}' is locked by [${existingLock.agent_name}] for "${existingLock.summary}". Please wait or choose another task.`
        };
      }
    }

    const intentRes = this.declareIntent({
      agentId,
      intentSummary: promptHint ? `Editing ${filePath}: ${promptHint.slice(0, 40)}` : `Auto-claimed edit on ${filePath}`,
      claims: [{ type: 'file', target: filePath }],
      ttlSeconds: 180,
      projectId: finalProjectId
    });

    // 关键防御：如果意图被判定为冲突等待（例如命中模块锁或符号锁），坚决实施拦截
    if (intentRes.status === 'WAITING') {
      this.logActivity(agentId, 'hook:blocked', normalizedFile, `Blocked write to ${normalizedFile} (${intentRes.reason})`, finalProjectId);
      return {
        allow: false,
        holder: intentRes.blockedByName,
        reason: `BLOCKED: File '${filePath}' is blocked by [${intentRes.blockedByName}] (${intentRes.reason}). Please wait or choose another task.`
      };
    }

    return {
      allow: true,
      autoClaimed: true,
      leaseId: intentRes.leaseId
    };
  }

  logActivity(agentId, eventType, target, description, projectId = 'default') {
    const now = Date.now();
    const finalProjectId = projectId || 'default';
    this.db.prepare(`
      INSERT INTO activity_log (project_id, agent_id, event_type, target, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(finalProjectId, agentId, eventType, target, description, now);

    this.eventBus.emit('timeline:event', {
      project_id: finalProjectId,
      agent_id: agentId,
      event_type: eventType,
      target,
      description,
      created_at: now
    });
  }

  getWaitQueue(projectId = 'default') {
    return this.db.prepare(`
      SELECT w.intent_id, w.agent_id, i.summary, a.name as agent_name
      FROM wait_queue w
      JOIN intents i ON w.intent_id = i.id
      JOIN agents a ON w.agent_id = a.id
      WHERE w.project_id = ?
      ORDER BY w.id ASC
    `).all(projectId);
  }

  getDashboardSnapshot(projectId = null) {
    const now = Date.now();
    let agents;
    let activeClaims;
    let timeline;

    if (projectId) {
      agents = this.db.prepare(`
        SELECT a.*,
          (SELECT count(*) FROM leases l WHERE l.agent_id = a.id AND l.expires_at > ?) as active_leases_count,
          (SELECT i.summary FROM intents i WHERE i.agent_id = a.id AND i.status IN ('granted', 'running', 'waiting') ORDER BY i.created_at DESC LIMIT 1) as current_intent,
          (SELECT i.status FROM intents i WHERE i.agent_id = a.id AND i.status IN ('granted', 'running', 'waiting') ORDER BY i.created_at DESC LIMIT 1) as current_intent_status,
          (SELECT i.blocked_reason FROM intents i WHERE i.agent_id = a.id AND i.status = 'waiting' ORDER BY i.created_at DESC LIMIT 1) as blocked_reason
        FROM agents a
        WHERE a.project_id = ?
      `).all(now, projectId);

      activeClaims = this.db.prepare(`
        SELECT c.*, a.name as agent_name, l.expires_at
        FROM claims c
        JOIN leases l ON c.intent_id = l.intent_id
        JOIN agents a ON c.agent_id = a.id
        WHERE l.expires_at > ? AND c.project_id = ?
      `).all(now, projectId);

      timeline = this.db.prepare(`
        SELECT al.*, a.name as agent_name, a.provider
        FROM activity_log al
        LEFT JOIN agents a ON al.agent_id = a.id
        WHERE al.project_id = ?
        ORDER BY al.id DESC LIMIT 50
      `).all(projectId);
    } else {
      agents = this.db.prepare(`
        SELECT a.*,
          (SELECT count(*) FROM leases l WHERE l.agent_id = a.id AND l.expires_at > ?) as active_leases_count,
          (SELECT i.summary FROM intents i WHERE i.agent_id = a.id AND i.status IN ('granted', 'running', 'waiting') ORDER BY i.created_at DESC LIMIT 1) as current_intent,
          (SELECT i.status FROM intents i WHERE i.agent_id = a.id AND i.status IN ('granted', 'running', 'waiting') ORDER BY i.created_at DESC LIMIT 1) as current_intent_status,
          (SELECT i.blocked_reason FROM intents i WHERE i.agent_id = a.id AND i.status = 'waiting' ORDER BY i.created_at DESC LIMIT 1) as blocked_reason
        FROM agents a
      `).all(now);

      activeClaims = this.db.prepare(`
        SELECT c.*, a.name as agent_name, l.expires_at
        FROM claims c
        JOIN leases l ON c.intent_id = l.intent_id
        JOIN agents a ON c.agent_id = a.id
        WHERE l.expires_at > ?
      `).all(now);

      timeline = this.db.prepare(`
        SELECT al.*, a.name as agent_name, a.provider
        FROM activity_log al
        LEFT JOIN agents a ON al.agent_id = a.id
        ORDER BY al.id DESC LIMIT 50
      `).all();
    }

    return {
      agents,
      activeClaims,
      timeline
    };
  }
}

export { CoordinatorEngine as Coordinator };
