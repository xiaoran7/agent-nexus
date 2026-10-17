import { randomUUID } from 'node:crypto';
import { normalize, resolve, isAbsolute } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { ValidationError, requireString } from '../domain/errors.js';

export { ValidationError };

const CLAIM_TYPES = new Set(['file', 'module', 'symbol', 'resource']);

const CLAIM_TARGET_RE = /^[^\s/\\][^\s]*$/;

function isPathAbsolute(p) {
  if (!p || typeof p !== 'string') return false;
  return p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:[/\\]/.test(p);
}

function resolveSafe(baseDir, value) {
  if (!value) return '';
  if (isPathAbsolute(value)) {
    return value;
  }
  if (baseDir && /^[a-zA-Z]:[/\\]/.test(baseDir) && process.platform !== 'win32') {
    const cleanBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const cleanRel = value.replace(/\\/g, '/').replace(/^\/+/, '');
    return `${cleanBase}/${cleanRel}`;
  }
  return baseDir ? resolve(baseDir, value) : resolve(value);
}

function toComparablePath(value, baseDir, projectRoot) {
  let resolved = resolveSafe(baseDir, value);
  try {
    if (existsSync(resolved)) {
      resolved = realpathSync(resolved);
    }
  } catch {}

  // 跨 Worktree 相对化对齐：若指定了 projectRoot 且 baseDir 与 projectRoot 不一致，将工作树内的文件映射到主工程路径
  if (projectRoot && baseDir) {
    const canonicalBase = baseDir.replace(/\\/g, '/').toLowerCase();
    const canonicalProj = projectRoot.replace(/\\/g, '/').toLowerCase();
    const canonicalTarget = resolved.replace(/\\/g, '/').toLowerCase();

    if (canonicalBase !== canonicalProj && canonicalTarget.startsWith(canonicalBase + '/')) {
      const rel = canonicalTarget.slice(canonicalBase.length + 1);
      resolved = resolveSafe(projectRoot, rel);
    }
  }

  let normalized = resolved.replace(/\\/g, '/');
  return normalize(normalized).replace(/\\/g, '/').toLowerCase();
}

function requireAgentId(value) {
  return requireString(value, 'agent_id');
}

function splitTargetAnchor(target) {
  if (typeof target !== 'string') return { baseTarget: '', anchor: null };
  const hashIdx = target.indexOf('#');
  if (hashIdx === -1) return { baseTarget: target, anchor: null };
  const baseTarget = target.slice(0, hashIdx).trim();
  const anchor = target.slice(hashIdx + 1).trim().toLowerCase();
  return { baseTarget, anchor: anchor || null };
}

function assertClaimTarget(raw, claimType, baseDir, projectRoot) {
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

  if (claimType === 'resource') {
    const cleanTarget = target.trim().toLowerCase();
    if (!cleanTarget || !CLAIM_TARGET_RE.test(cleanTarget)) {
      throw new ValidationError('Resource target must not be empty or contain whitespace/path separators', 'claims[].target');
    }
    return { type: claimType, target: cleanTarget };
  }

  // 支持大文件局部锁 file#anchor（如 admin.html#header-nav）
  const { baseTarget, anchor } = splitTargetAnchor(target);
  const normalizedBase = toComparablePath(baseTarget, baseDir, projectRoot);
  if (normalizedBase === toComparablePath('.', baseDir, projectRoot) || normalizedBase === toComparablePath('/', baseDir, projectRoot)) {
    throw new ValidationError(
      `Claim target "${target}" resolves to a directory root or the working directory, not a specific resource`,
      'claims[].target'
    );
  }
  const normalized = anchor ? `${normalizedBase}#${anchor}` : normalizedBase;
  return { type: claimType, target: normalized };
}

export class CoordinatorEngine {
  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  normalizePath(filePath, baseDir, projectRoot) {
    if (!filePath) return '';
    return toComparablePath(filePath, baseDir, projectRoot);
  }

  pathsOverlap(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.startsWith(b + '/') || b.startsWith(a + '/');
  }

  // 四级冲突判定的唯一实现，加入 projectId 作用域与资源锁互斥，支持 #anchor 大文件细粒度锁
  findConflict(normalizedClaims, agentId, now, projectId = 'default') {
    const activeClaims = this.db.prepare(`
      SELECT c.claim_type, c.claim_target, c.agent_id, l.intent_id, l.expires_at,
             a.name as agent_name, a.workspace_dir as holder_workspace
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

        const remainingSec = Math.max(0, Math.ceil((active.expires_at - now) / 1000));
        const meta = {
          blockedByAgentId: active.agent_id,
          blockedByAgentName: active.agent_name,
          holderWorkspace: active.holder_workspace || '',
          claimType: active.claim_type,
          claimTarget: active.claim_target,
          expiresAt: active.expires_at,
          remainingSec
        };

        // Rule 1: 文件精确重合或大文件锚点判定 (#anchor)
        if (claim.type === 'file' && active.claim_type === 'file') {
          const { baseTarget: baseA, anchor: anchorA } = splitTargetAnchor(claim.target);
          const { baseTarget: baseB, anchor: anchorB } = splitTargetAnchor(active.claim_target);

          if (baseA === baseB) {
            // 如果双方都显式指定了不同的 anchor，属于文件不同逻辑区域，允许并发施工
            if (anchorA && anchorB && anchorA !== anchorB) {
              continue;
            }

            const isAnchorConflict = Boolean(anchorA && anchorB);
            const reason = isAnchorConflict
              ? `Anchor conflict: Section '#${anchorA}' in '${baseA}' is currently locked by ${active.agent_name}`
              : `File conflict: '${baseA}' ${!anchorB ? 'whole file is locked by' : "section '#" + anchorB + "' is locked by"} ${active.agent_name}`;

            return {
              ...meta,
              reason
            };
          }
        }

        // Rule 2: 模块 / 目录包含关系 (模块锁包含文件及其所有 anchor 锚点)
        if (claim.type === 'module' || active.claim_type === 'module') {
          const targetA = claim.type === 'file' ? splitTargetAnchor(claim.target).baseTarget : claim.target;
          const targetB = active.claim_type === 'file' ? splitTargetAnchor(active.claim_target).baseTarget : active.claim_target;

          if (this.pathsOverlap(targetA, targetB)) {
            return {
              ...meta,
              reason: `Module conflict between '${claim.target}' and '${active.claim_target}' held by ${active.agent_name}`
            };
          }
        }

        // Rule 3: 符号精确重合
        if (claim.type === 'symbol' && active.claim_type === 'symbol') {
          if (claim.target === active.claim_target) {
            return {
              ...meta,
              reason: `Symbol conflict: '${claim.target}' is being modified by ${active.agent_name}`
            };
          }
        }

        // Rule 4: 命名资源互斥 (Resource Mutual Exclusion)
        if (claim.type === 'resource' && active.claim_type === 'resource') {
          if (claim.target === active.claim_target) {
            return {
              ...meta,
              reason: `Resource conflict: '${claim.target}' is currently held by ${active.agent_name}`
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
  declareIntent({ agentId, intentSummary, claims = [], ttlSeconds = 300, projectId = 'default', projectRoot = null }) {
    requireAgentId(agentId);
    const summary = requireString(intentSummary, 'summary');
    const finalProjectId = projectId || 'default';

    if (!Array.isArray(claims)) {
      throw new ValidationError('"claims" must be an array', 'claims');
    }

    const agent = this.getAgent(agentId);
    const baseDir = agent?.workspace_dir || '';

    // 优先使用传入的 projectRoot，否则尝试从已登记的 projects 表查出项目根
    let effectiveProjectRoot = projectRoot;
    if (!effectiveProjectRoot && finalProjectId !== 'default') {
      try {
        const pRow = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(finalProjectId);
        if (pRow?.root_path) effectiveProjectRoot = pRow.root_path;
      } catch {}
    }

    const normalizedClaims = claims.map((c) => {
      if (!c || typeof c !== 'object') {
        throw new ValidationError('"claims" entries must be objects', 'claims');
      }
      return assertClaimTarget(c.target, c.type, baseDir, effectiveProjectRoot);
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
        holderWorkspace: conflict.holderWorkspace || '',
        expiresAt: conflict.expiresAt,
        remainingSec: conflict.remainingSec,
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

    const agentRow = this.db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId);
    const releasedByName = agentRow?.name || agentId;

    this.eventBus.emit('resource:freed', {
      project_id: projectId,
      resources: releasedClaims,
      released_by: agentId,
      released_by_name: releasedByName
    });

    const { nextWaiter, skipped } = this._wakeNextEligibleWaiter(projectId, now, {
      resources: releasedClaims,
      releasedBy: agentId,
      releasedByName
    });

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

  // 3.1 批量释放指定 Agent 的全部或指定范围租约 (用于 git commit / git push 后的零感自动释放)
  releaseAgentLeases({ agentId, projectId = 'default', reason = 'git_action', scope = 'all' }) {
    requireAgentId(agentId);
    const now = Date.now();
    const finalProjectId = projectId || 'default';

    const activeLeases = this.db.prepare(`
      SELECT l.id, l.intent_id, l.project_id
      FROM leases l
      WHERE l.agent_id = ? AND l.project_id = ? AND l.expires_at > ?
    `).all(agentId, finalProjectId, now);

    if (activeLeases.length === 0) {
      return {
        success: true,
        releasedCount: 0,
        releasedLeases: [],
        notifiedWaiters: []
      };
    }

    const agentRow = this.db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId);
    const releasedByName = agentRow?.name || agentId;

    const allReleasedClaims = [];
    const releasedLeaseIds = [];

    for (const lease of activeLeases) {
      const claims = this.db.prepare(`
        SELECT claim_type, claim_target FROM claims WHERE intent_id = ?
      `).all(lease.intent_id).map(c => ({ type: c.claim_type, target: c.claim_target }));

      allReleasedClaims.push(...claims);
      releasedLeaseIds.push(lease.id);

      this.db.prepare(`UPDATE intents SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, lease.intent_id);
      this.db.prepare(`DELETE FROM leases WHERE id = ?`).run(lease.id);
      this.db.prepare(`DELETE FROM claims WHERE intent_id = ?`).run(lease.intent_id);

      this.logActivity(agentId, 'lease:released', lease.id, `Auto-released lease upon ${reason} for intent ${lease.intent_id}`, finalProjectId);
    }

    this._syncAgentRunningStatus(agentId, finalProjectId, now);

    this.eventBus.emit('resource:freed', {
      project_id: finalProjectId,
      resources: allReleasedClaims,
      released_by: agentId,
      released_by_name: releasedByName,
      reason
    });

    // 循环唤醒所有当前可能已经无冲突的等待者
    const notifiedWaiters = [];
    while (true) {
      const { nextWaiter } = this._wakeNextEligibleWaiter(finalProjectId, now, {
        resources: allReleasedClaims,
        releasedBy: agentId,
        releasedByName
      });
      if (!nextWaiter) break;
      notifiedWaiters.push({
        agent_id: nextWaiter.agent_id,
        intent_id: nextWaiter.intent_id
      });
    }

    return {
      success: true,
      releasedCount: releasedLeaseIds.length,
      releasedLeases: releasedLeaseIds,
      releasedClaims: allReleasedClaims,
      notifiedWaiters
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
  _wakeNextEligibleWaiter(projectId, now, freedInfo = null) {
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
    let waiterClaims = [];
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
      waiterClaims = claims;
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

      const targetDesc = freedInfo?.resources?.map(r => r.target).join(', ') || 'locked resource';
      const freedByName = freedInfo?.releasedByName || freedInfo?.releasedBy || 'previous holder';
      const resumeHint = `Resource '${targetDesc}' held by [${freedByName}] has been released. Your claimed targets (${waiterClaims.map(c => c.target).join(', ')}) are now conflict-free. Refresh workspace and proceed.`;

      const wokenPayload = {
        project_id: projectId,
        agent_id: nextWaiter.agent_id,
        agent_name: nextWaiter.agent_name,
        intent_id: nextWaiter.intent_id,
        summary: nextWaiter.summary,
        verified: true,
        freed_resources: freedInfo?.resources || [],
        freed_by: freedInfo?.releasedBy || null,
        freed_by_name: freedByName,
        claims: waiterClaims,
        resume_hint: resumeHint,
        message: resumeHint
      };

      this.eventBus.emit('agent:woken', wokenPayload);

      // 持久化通知到 messages 表中，确保通过 nexus_dialogue_read 轮询的会话可检索到
      try {
        if (this.messageService) {
          const senderId = freedInfo?.releasedBy || 'nexus';
          if (!this.getAgent(senderId)) {
            this.registerAgent({
              id: senderId,
              name: freedByName || 'Nexus Coordinator',
              provider: 'system',
              sessionId: 'coordinator',
              projectId
            });
          }
          this.messageService.send({
            from: senderId,
            to: nextWaiter.agent_id,
            intentId: nextWaiter.intent_id,
            content: `[Resource Woken] ${resumeHint}`,
            importance: 'urgent',
            projectId,
            dialogueType: 'handoff',
            status: 'unread'
          });
        }
      } catch (err) {
        // 消息持久化作为辅助增强，不阻断主唤醒链路
      }
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

  // 5. 极速权限检查与自动补报 (针对通用 Hook 与资源锁)
  fastCheckAndAutoClaim({ agentId, provider, sessionId, filePath, resourceName, promptHint, projectId = 'default', workspaceDir = '', projectRoot = null }) {
    requireAgentId(agentId);
    const finalProjectId = projectId || 'default';
    const now = Date.now();

    // 尝试解析项目根目录
    let finalProjectRoot = projectRoot;
    if (!finalProjectRoot && finalProjectId !== 'default') {
      try {
        const pRow = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(finalProjectId);
        if (pRow?.root_path) finalProjectRoot = pRow.root_path;
      } catch {}
    }

    this.registerAgent({
      id: agentId,
      name: promptHint ? promptHint.slice(0, 30) : `${provider || 'agent'}-${(sessionId || 'default').slice(0, 6)}`,
      provider,
      sessionId,
      workspaceDir: workspaceDir || '',
      projectId: finalProjectId
    });

    this.expireLeases();

    // 5.1 命名资源锁快速检查 (例如命令推导出的 tests, dev-server, build 等)
    if (resourceName) {
      const cleanResource = resourceName.trim().toLowerCase();
      assertClaimTarget(cleanResource, 'resource', workspaceDir, finalProjectRoot);

      const existingResourceLock = this.db.prepare(`
        SELECT c.agent_id, a.name as agent_name, a.workspace_dir, i.summary, l.id as lease_id
        FROM claims c
        JOIN leases l ON c.intent_id = l.intent_id
        JOIN agents a ON c.agent_id = a.id
        JOIN intents i ON c.intent_id = i.id
        WHERE c.project_id = ? AND c.claim_type = 'resource' AND c.claim_target = ? AND l.expires_at > ?
      `).get(finalProjectId, cleanResource, now);

      if (existingResourceLock) {
        if (existingResourceLock.agent_id === agentId) {
          return { allow: true, reason: 'self-held-resource-lease' };
        } else {
          this.logActivity(agentId, 'hook:blocked', cleanResource, `Blocked access to resource '${cleanResource}' (held by ${existingResourceLock.agent_name})`, finalProjectId);
          const remainingSec = Math.max(0, Math.ceil((existingResourceLock.expires_at - now) / 1000));
          return {
            allow: false,
            holder: existingResourceLock.agent_name,
            holderWorkspace: '',
            expiresAt: existingResourceLock.expires_at,
            remainingSec,
            advice: `Resource '${cleanResource}' is busy. You can work on independent code or wait for the process to finish (ETA ~${remainingSec}s).`,
            reason: `BLOCKED: Resource '${cleanResource}' is currently locked by [${existingResourceLock.agent_name}] for "${existingResourceLock.summary}". Please wait for the current run to finish.`
          };
        }
      }

      const intentRes = this.declareIntent({
        agentId,
        intentSummary: promptHint ? `Running ${cleanResource}: ${promptHint.slice(0, 40)}` : `Auto-claimed resource lock on '${cleanResource}'`,
        claims: [{ type: 'resource', target: cleanResource }],
        ttlSeconds: 180,
        projectId: finalProjectId,
        projectRoot: finalProjectRoot
      });

      if (intentRes.status === 'WAITING') {
        this.logActivity(agentId, 'hook:blocked', cleanResource, `Blocked access to resource '${cleanResource}' (${intentRes.reason})`, finalProjectId);
        const remainingSec = intentRes.remainingSec || 0;
        return {
          allow: false,
          holder: intentRes.blockedByName,
          holderWorkspace: intentRes.holderWorkspace || '',
          expiresAt: intentRes.expiresAt || null,
          remainingSec,
          advice: `Resource '${cleanResource}' is blocked. Please wait for previous job to finish (ETA ~${remainingSec}s).`,
          reason: `BLOCKED: Resource '${cleanResource}' is blocked by [${intentRes.blockedByName}] (${intentRes.reason}). Please wait.`
        };
      }

      return {
        allow: true,
        autoClaimed: true,
        leaseId: intentRes.leaseId
      };
    }

    // 5.2 文件与模块路径冲突拦截 (支持跨工作树相对化对齐与 #anchor 细粒度锁)
    assertClaimTarget(filePath, 'file', workspaceDir, finalProjectRoot);
    const normalizedFile = this.normalizePath(filePath, workspaceDir, finalProjectRoot);
    const { baseTarget: baseFile, anchor: fileAnchor } = splitTargetAnchor(normalizedFile);

    const existingLock = this.db.prepare(`
      SELECT c.agent_id, c.claim_target, a.name as agent_name, a.workspace_dir as holder_workspace, i.summary, l.id as lease_id, l.expires_at
      FROM claims c
      JOIN leases l ON c.intent_id = l.intent_id
      JOIN agents a ON c.agent_id = a.id
      JOIN intents i ON c.intent_id = i.id
      WHERE c.project_id = ? AND c.claim_type = 'file' AND (c.claim_target = ? OR c.claim_target LIKE ? || '#%') AND l.expires_at > ?
    `).all(finalProjectId, baseFile, baseFile, now);

    // 检查是否存在冲突锁
    let conflictingLock = null;
    let selfHeld = false;
    for (const lock of existingLock) {
      if (lock.agent_id === agentId) {
        selfHeld = true;
        continue;
      }
      const { anchor: lockAnchor } = splitTargetAnchor(lock.claim_target);
      // 如果双方都有不同 anchor，允许并发
      if (fileAnchor && lockAnchor && fileAnchor !== lockAnchor) {
        continue;
      }
      conflictingLock = lock;
      break;
    }

    if (conflictingLock) {
      const isCrossWorktree = workspaceDir && conflictingLock.holder_workspace &&
        toComparablePath(workspaceDir, '') !== toComparablePath(conflictingLock.holder_workspace, '');
      const conflictPrefix = isCrossWorktree ? 'CROSS-WORKTREE CONFLICT' : 'BLOCKED';
      const worktreeNote = isCrossWorktree ? ' in another worktree (concurrent edits will cause git merge conflicts)' : '';
      const remainingSec = Math.max(0, Math.ceil((conflictingLock.expires_at - now) / 1000));

      this.logActivity(agentId, 'hook:blocked', normalizedFile, `Blocked write to ${normalizedFile} (held by ${conflictingLock.agent_name}${worktreeNote})`, finalProjectId);
      return {
        allow: false,
        holder: conflictingLock.agent_name,
        holderWorkspace: conflictingLock.holder_workspace || '',
        expiresAt: conflictingLock.expires_at,
        remainingSec,
        advice: `File '${filePath}' is locked by [${conflictingLock.agent_name}]. You can: 1) Read and analyze code, 2) Work on other independent modules/anchors, 3) Wait for holder to git commit/push (ETA ~${remainingSec}s).`,
        reason: `${conflictPrefix}: File '${filePath}' is locked by [${conflictingLock.agent_name}]${worktreeNote} for "${conflictingLock.summary}". Please wait or choose another task.`
      };
    }

    if (selfHeld) {
      return { allow: true, reason: 'self-held-lease' };
    }

    const intentRes = this.declareIntent({
      agentId,
      intentSummary: promptHint ? `Editing ${filePath}: ${promptHint.slice(0, 40)}` : `Auto-claimed edit on ${filePath}`,
      claims: [{ type: 'file', target: filePath }],
      ttlSeconds: 180,
      projectId: finalProjectId,
      projectRoot: finalProjectRoot
    });

    // 关键防御：如果意图被判定为冲突等待（例如命中模块锁或符号锁），坚决实施拦截
    if (intentRes.status === 'WAITING') {
      this.logActivity(agentId, 'hook:blocked', normalizedFile, `Blocked write to ${normalizedFile} (${intentRes.reason})`, finalProjectId);
      const remainingSec = intentRes.remainingSec || 0;
      return {
        allow: false,
        holder: intentRes.blockedByName,
        holderWorkspace: intentRes.holderWorkspace || '',
        expiresAt: intentRes.expiresAt || null,
        remainingSec,
        advice: `Target '${filePath}' is blocked (${intentRes.reason}). Switch to an independent file or wait for holder to git commit/push (ETA ~${remainingSec}s).`,
        reason: `BLOCKED: File '${filePath}' is blocked by [${intentRes.blockedByName}] (${intentRes.reason}). Please wait or choose another task.`
      };
    }

    return {
      allow: true,
      autoClaimed: true,
      leaseId: intentRes.leaseId
    };
  }

  // 6. 显式命名资源锁（Resource Locks）支持：测试、开发服务器、构建等
  acquireResourceLock({ agentId, resourceName, ttlSeconds = 300, reason = 'Resource held', projectId = 'default', projectRoot = null }) {
    requireAgentId(agentId);
    const target = requireString(resourceName, 'resourceName').trim().toLowerCase();
    const res = this.declareIntent({
      agentId,
      intentSummary: reason,
      claims: [{ type: 'resource', target }],
      ttlSeconds,
      projectId,
      projectRoot
    });

    return {
      success: res.status === 'GRANTED',
      resource_name: target,
      ...res
    };
  }

  releaseResourceLock({ agentId, resourceName, projectId = 'default' }) {
    requireAgentId(agentId);
    const target = requireString(resourceName, 'resourceName').trim().toLowerCase();
    const activeClaim = this.db.prepare(`
      SELECT c.intent_id
      FROM claims c
      JOIN leases l ON c.intent_id = l.intent_id
      WHERE c.project_id = ? AND c.agent_id = ? AND c.claim_type = 'resource' AND c.claim_target = ?
    `).get(projectId, agentId, target);

    if (activeClaim) {
      const releaseRes = this.releaseLease(activeClaim.intent_id, agentId);
      return {
        ...releaseRes,
        resource_name: target
      };
    }
    return { success: false, reason: 'No active resource lock found' };
  }

  listResourceLocks(projectId = 'default') {
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT c.claim_target as resource_name, c.agent_id, a.name as agent_name, i.summary, l.expires_at, l.created_at
      FROM claims c
      JOIN leases l ON c.intent_id = l.intent_id
      JOIN agents a ON c.agent_id = a.id
      JOIN intents i ON c.intent_id = i.id
      WHERE c.project_id = ? AND c.claim_type = 'resource' AND l.expires_at > ?
      ORDER BY l.created_at ASC
    `).all(projectId, now);

    return rows.map(r => ({
      resourceName: r.resource_name,
      resource_name: r.resource_name,
      agentId: r.agent_id,
      agent_id: r.agent_id,
      agentName: r.agent_name,
      agent_name: r.agent_name,
      summary: r.summary,
      expiresAt: r.expires_at,
      createdAt: r.created_at
    }));
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
