import { randomUUID } from 'node:crypto';
import { normalize, resolve } from 'node:path';
import { ValidationError, requireString } from '../domain/errors.js';

// 协调器此前是 ValidationError 的定义处。现在它住在 domain/errors.js（状态和
// 消息两个入口也要用），这里继续导出是为了不打断既有 import 路径。
export { ValidationError };

const CLAIM_TYPES = new Set(['file', 'module', 'symbol']);

// symbol 目标按字面比较，不做路径解析；只要求它不是以分隔符/空白开头。
const CLAIM_TARGET_RE = /^[^\s/\\][^\s]*$/;

function toComparablePath(value) {
  return normalize(resolve(value)).replace(/\\/g, '/').toLowerCase();
}

function requireAgentId(value) {
  return requireString(value, 'agent_id');
}

function assertClaimTarget(raw, claimType) {
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

  // 校验必须发生在归一化之后：相对路径是合法输入，会按 daemon 的工作目录解析。
  // 真正的判据是「解析后能否变成一个可用于比较的路径」——resolve() 会把
  // undefined / null / '' / '.' 一律变成工作目录或盘符根，这些都不能拿去做
  // file claim，否则一条空声明就能把所有同样发空目标的 agent 一起锁死。
  const normalized = toComparablePath(target);
  if (normalized === toComparablePath('.') || normalized === toComparablePath('/')) {
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

  // 规范化文件路径 (跨系统统一小写与正斜杠，用于确定性比较)
  // 缺少有效路径时返回 ''，不可用于声明。上一级必须先经 assertClaimTarget
  // 拦截，否则空串会变成一条真实的 file claim，把所有同样发空路径的 agent 一起锁死。
  normalizePath(filePath) {
    if (!filePath) return '';
    return normalize(resolve(filePath)).replace(/\\/g, '/').toLowerCase();
  }

  // 判断两个已归一化的路径是否落在同一目录树下 (任一方是另一方的祖先，或完全相同)。
  // 按 '/' 分段比较而非裸 startsWith，否则 src/network 会误判为包含 src/network-legacy。
  pathsOverlap(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.startsWith(b + '/') || b.startsWith(a + '/');
  }

  // 三级冲突判定的唯一实现。declareIntent 与唤醒时的复核都走这里，
  // 免得两条路径的判冲规则哪天长歪。
  // claims 必须是已归一化的形状（{type, target}）。
  findConflict(normalizedClaims, agentId, now) {
    // 只看当前 ACTIVE leases 对应的 claims
    const activeClaims = this.db.prepare(`
      SELECT c.claim_type, c.claim_target, c.agent_id, l.intent_id, a.name as agent_name
      FROM claims c
      JOIN leases l ON c.intent_id = l.intent_id
      JOIN agents a ON c.agent_id = a.id
      WHERE l.expires_at > ?
    `).all(now);

    for (const claim of normalizedClaims) {
      for (const active of activeClaims) {
        if (active.agent_id === agentId) {
          // 同一 Agent 允许重入/扩展
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

        // Rule 2: 模块 / 目录包含关系 (按路径分段比较，避免 src/network 误伤 src/network-legacy)
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
  registerAgent({ id, name, provider, sessionId, workspaceDir }) {
    requireAgentId(id);

    const now = Date.now();
    const finalSessionId = sessionId == null ? 'default' : String(sessionId);
    const finalProvider = provider == null ? 'unknown' : String(provider);
    const finalName = name || `${finalProvider}-${finalSessionId.slice(0, 6)}`;

    const stmt = this.db.prepare(`
      INSERT INTO agents (id, name, provider, session_id, workspace_dir, status, last_heartbeat, registered_at)
      VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        workspace_dir = excluded.workspace_dir,
        last_heartbeat = excluded.last_heartbeat
    `);
    stmt.run(id, finalName, finalProvider, finalSessionId, workspaceDir || '', now, now);

    this.logActivity(id, 'agent:registered', null, `Agent ${finalName} (${finalProvider}) registered/heartbeat`);
    return this.getAgent(id);
  }

  getAgent(id) {
    return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  }

  listAgents() {
    return this.db.prepare('SELECT * FROM agents ORDER BY last_heartbeat DESC').all();
  }

  updateAgentStatus(id, status) {
    this.db.prepare('UPDATE agents SET status = ?, last_heartbeat = ? WHERE id = ?').run(status, Date.now(), id);
    this.eventBus.emit('agent:status', { agent_id: id, status });
  }

  // 2. 意图声明与确定性冲突检查 (Core Algorithm)
  declareIntent({ agentId, intentSummary, claims = [], ttlSeconds = 300 }) {
    requireAgentId(agentId);
    const summary = requireString(intentSummary, 'summary');

    if (!Array.isArray(claims)) {
      throw new ValidationError('"claims" must be an array', 'claims');
    }

    // 先整体校验再落任何记录：一条非法声明不应留下半截 intent 或 claim 残影。
    const normalizedClaims = claims.map((c) => {
      if (!c || typeof c !== 'object') {
        throw new ValidationError('"claims" entries must be objects', 'claims');
      }
      return assertClaimTarget(c.target, c.type);
    });

    this.expireLeases(); // 每次检查前先剔除过期租约
    const now = Date.now();
    const intentId = `intent_${randomUUID().slice(0, 8)}`;

    // 确保 agent 已在表中存在，避免 FOREIGN KEY constraint 失败
    const agent = this.getAgent(agentId);
    if (!agent) {
      const parts = agentId.split('-');
      const provider = parts[0] || 'agent';
      const sessionId = parts.slice(1).join('-') || `${now}`;
      this.registerAgent({
        id: agentId,
        name: summary.slice(0, 30),
        provider,
        sessionId,
        workspaceDir: ''
      });
    }

    let conflict = this.findConflict(normalizedClaims, agentId, now);

    if (!conflict) {
      // GRANTED: 记录意图，保存 claims，颁发 Lease
      this.db.prepare(`
        INSERT INTO intents (id, agent_id, summary, status, created_at, updated_at)
        VALUES (?, ?, ?, 'granted', ?, ?)
      `).run(intentId, agentId, summary, now, now);

      const claimInsert = this.db.prepare(`
        INSERT INTO claims (intent_id, agent_id, claim_type, claim_target, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const c of normalizedClaims) {
        claimInsert.run(intentId, agentId, c.type, c.target, now);
      }

      const leaseId = `lease_${randomUUID().slice(0, 8)}`;
      const expiresAt = now + (ttlSeconds * 1000);
      this.db.prepare(`
        INSERT INTO leases (id, intent_id, agent_id, ttl_seconds, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(leaseId, intentId, agentId, ttlSeconds, expiresAt, now);

      this.updateAgentStatus(agentId, 'running');
      this.logActivity(agentId, 'intent:granted', claims.map(c => c.target).join(', '), `Granted lease for intent: "${summary}"`);

      return {
        status: 'GRANTED',
        intentId,
        leaseId,
        expiresAt,
        claims: normalizedClaims
      };
    } else {
      // WAITING: 记录意图为 waiting，加入等待队列
      this.db.prepare(`
        INSERT INTO intents (id, agent_id, summary, status, blocked_by_agent_id, blocked_reason, created_at, updated_at)
        VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?)
      `).run(intentId, agentId, summary, conflict.blockedByAgentId, conflict.reason, now, now);

      // 保存期望声明的 claims
      const claimInsert = this.db.prepare(`
        INSERT INTO claims (intent_id, agent_id, claim_type, claim_target, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const c of normalizedClaims) {
        claimInsert.run(intentId, agentId, c.type, c.target, now);
      }

      this.db.prepare(`
        INSERT INTO wait_queue (intent_id, agent_id, created_at)
        VALUES (?, ?, ?)
      `).run(intentId, agentId, now);

      this.updateAgentStatus(agentId, 'waiting');
      this.logActivity(agentId, 'intent:blocked', claims.map(c => c.target).join(', '), `Blocked by ${conflict.blockedByAgentName}: ${conflict.reason}`);

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

  // 3. 租约释放与等待者主动唤醒 (Wake-up Bus)
  releaseLease(leaseIdOrIntentId, agentId) {
    // 租约不存在属于常态竞态（已过期或已释放），返回 404 而不是 400。
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

    // 标记意图完成并删除租约和 claims
    this.db.prepare(`UPDATE intents SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, lease.intent_id);
    this.db.prepare(`DELETE FROM leases WHERE id = ?`).run(lease.id);
    this.db.prepare(`DELETE FROM claims WHERE intent_id = ?`).run(lease.intent_id);

    this.updateAgentStatus(agentId, 'idle');
    this.logActivity(agentId, 'lease:released', lease.id, `Agent released lease for intent ${lease.intent_id}`);

    // 选下一个唤醒谁：不是纯 FIFO。
    //
    // 纯 FIFO（ORDER BY w.id）有两个问题。等待期间资源可能被别人抢走或继续
    // 被锁着，此时唤醒队首就是白唤醒一轮：它重新声明后仍然 WAITING。
    // 排在后面、但此刻其实已经能拿到的等待者反而被饿着。
    //
    // 等待者的 claim 在入队时是留在 claims 表里的（只有租约过期或释放才删），
    // 所以这里能直接复核它现在是否真的无冲突，不必等它自己再声明一次。
    // 队列按 claim 宽窄重排：要得最窄的先过。
    //
    // 宽声明（整个 src/）既容易和所有人冲突，等待时间又长。窄声明先拿，
    // 剩下的大块更容易被切成互不相干的部分，减少反复惊群——即一批等待者
    // 同时被唤醒、又同时抢同一块、然后又一起回去等下一轮。
    //
    // 宽度必须按语义算，不能用 LENGTH(claim_target)。claim 存的是归一化后的
    // 绝对路径，长度被工作目录前缀和盘符主导：pkg/other 反而比 src/network
    // 短，于是排序完全错位。
    //
    // 段数代表的是"往下钻了几层"，层数越多、要的范围越小，所以降序排。
    // 这一点很容易写反：升序会把 src/ab（几乎和 src 一样宽）排在
    // src/a/b/c/d（只占一个叶子目录）前面，正好是最不该先放的那个。
    // file claim 恒为 1 段，永远排在 module 之后。
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
      ORDER BY w.id ASC
    `).all().map((c) => ({ ...c, breadth: breadthOf(c.intent_id) }))
      // 降序：段数多 = 钻得深 = 范围窄，窄的先过。多的排在后面。
      .sort((a, b) => (b.breadth.segments - a.breadth.segments) || (b.breadth.n - a.breadth.n));

    let nextWaiter = null;
    let skipped = 0;
    for (const cand of candidates) {
      const claims = this.db.prepare(`
        SELECT claim_type, claim_target FROM claims WHERE intent_id = ?
      `).all(cand.intent_id).map((c) => ({ type: c.claim_type, target: c.claim_target }));

      if (claims.length === 0 || this.findConflict(claims, cand.agent_id, now)) {
        // 仍在冲突中：留在队列里等下一次释放，别白唤醒。
        skipped++;
        continue;
      }
      nextWaiter = cand;
      break;
    }

    if (nextWaiter) {
      // 从等待队列中移除
      this.db.prepare(`DELETE FROM wait_queue WHERE intent_id = ?`).run(nextWaiter.intent_id);

      // 该意图已出队，不再处于等待：置为 released 并清掉判冲留痕。
      // 否则这条陈旧的 waiting 记录会在面板快照里盖过 agent 重新声明后的 granted 意图，
      // 让正在运行的 agent 显示为"等待中"并挂着早已失效的 blocked_reason。
      this.db.prepare(`
        UPDATE intents
        SET status = 'released', blocked_by_agent_id = NULL, blocked_reason = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, nextWaiter.intent_id);

      this.logActivity(nextWaiter.agent_id, 'agent:woken', nextWaiter.intent_id, `Notified waiter ${nextWaiter.agent_name} to recheck`);
      this.eventBus.emit('agent:woken', {
        agent_id: nextWaiter.agent_id,
        intent_id: nextWaiter.intent_id,
        // 选中它时已经复核过冲突：此刻它声明的资源确实没有别人持锁。
        // 告诉 agent 这一点，它就知道不必再问一遍就能开始干活。
        verified: true,
        message: 'Resource released and your claims are now conflict-free. Refresh workspace and proceed.'
      });
    }

    return {
      success: true,
      releasedLeaseId: lease.id,
      notifiedWaiter: nextWaiter ? {
        agent_id: nextWaiter.agent_id,
        intent_id: nextWaiter.intent_id
      } : null,
      // 仍在冲突中、被跳过的等待者数。它们留在队列里等下一次释放。
      stillBlocked: skipped
    };
  }

  // 4. 过期租约定时清理
  expireLeases() {
    const now = Date.now();
    const expired = this.db.prepare('SELECT * FROM leases WHERE expires_at <= ?').all(now);
    for (const l of expired) {
      this.db.prepare(`UPDATE intents SET status = 'aborted', updated_at = ? WHERE id = ?`).run(now, l.intent_id);
      this.db.prepare(`DELETE FROM leases WHERE id = ?`).run(l.id);
      this.db.prepare(`DELETE FROM claims WHERE intent_id = ?`).run(l.intent_id);
      this.logActivity(l.agent_id, 'lease:expired', l.id, `Lease ${l.id} expired due to TTL timeout`);
    }
  }

  // 5. 极速权限检查与自动补报 (针对通用 Hook)
  fastCheckAndAutoClaim({ agentId, provider, sessionId, filePath, promptHint }) {
    // 这是 hook 最容易被绕过的一层：宿主没解析出目标文件时会发来空载荷。
    // 过去空路径会被归一化成 '' 并落成一条 file claim，锁死所有同样发空路径的 agent。
    requireAgentId(agentId);
    assertClaimTarget(filePath, 'file');

    const normalizedFile = this.normalizePath(filePath);
    const now = Date.now();

    // 确保证件已注册
    this.registerAgent({
      id: agentId,
      name: promptHint ? promptHint.slice(0, 30) : `${provider || 'agent'}-${(sessionId || 'default').slice(0, 6)}`,
      provider,
      sessionId,
      workspaceDir: ''
    });

    this.expireLeases();

    // 检查该文件是否被其他人占用
    const existingLock = this.db.prepare(`
      SELECT c.agent_id, a.name as agent_name, i.summary, l.id as lease_id
      FROM claims c
      JOIN leases l ON c.intent_id = l.intent_id
      JOIN agents a ON c.agent_id = a.id
      JOIN intents i ON c.intent_id = i.id
      WHERE c.claim_type = 'file' AND c.claim_target = ? AND l.expires_at > ?
    `).get(normalizedFile, now);

    if (existingLock) {
      if (existingLock.agent_id === agentId) {
        // 自己已经持锁：直接放行
        return { allow: true, reason: 'self-held-lease' };
      } else {
        // 他人持锁：硬拦截
        this.logActivity(agentId, 'hook:blocked', normalizedFile, `Blocked write to ${normalizedFile} (held by ${existingLock.agent_name})`);
        return {
          allow: false,
          holder: existingLock.agent_name,
          reason: `BLOCKED: File '${filePath}' is locked by [${existingLock.agent_name}] for "${existingLock.summary}". Please wait or choose another task.`
        };
      }
    }

    // 无人占用：自动补办 Lease 并放行 (Auto-Claim)
    const intentRes = this.declareIntent({
      agentId,
      intentSummary: promptHint ? `Editing ${filePath}: ${promptHint.slice(0, 40)}` : `Auto-claimed edit on ${filePath}`,
      claims: [{ type: 'file', target: filePath }],
      ttlSeconds: 180
    });

    return {
      allow: true,
      autoClaimed: true,
      leaseId: intentRes.leaseId
    };
  }

  logActivity(agentId, eventType, target, description) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO activity_log (agent_id, event_type, target, description, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(agentId, eventType, target, description, now);

    this.eventBus.emit('timeline:event', {
      agent_id: agentId,
      event_type: eventType,
      target,
      description,
      created_at: now
    });
  }

  // 6. 获取全局状态矩阵与时间线 (面向 Dashboard)
  getDashboardSnapshot() {
    const agents = this.db.prepare(`
      SELECT a.*, 
        (SELECT count(*) FROM leases l WHERE l.agent_id = a.id AND l.expires_at > ?) as active_leases_count,
        (SELECT i.summary FROM intents i WHERE i.agent_id = a.id AND i.status IN ('granted', 'running', 'waiting') ORDER BY i.created_at DESC LIMIT 1) as current_intent,
        (SELECT i.status FROM intents i WHERE i.agent_id = a.id AND i.status IN ('granted', 'running', 'waiting') ORDER BY i.created_at DESC LIMIT 1) as current_intent_status,
        (SELECT i.blocked_reason FROM intents i WHERE i.agent_id = a.id AND i.status = 'waiting' ORDER BY i.created_at DESC LIMIT 1) as blocked_reason
      FROM agents a
    `).all(Date.now());

    const activeClaims = this.db.prepare(`
      SELECT c.*, a.name as agent_name, l.expires_at
      FROM claims c
      JOIN leases l ON c.intent_id = l.intent_id
      JOIN agents a ON c.agent_id = a.id
      WHERE l.expires_at > ?
    `).all(Date.now());

    const timeline = this.db.prepare(`
      SELECT al.*, a.name as agent_name, a.provider
      FROM activity_log al
      LEFT JOIN agents a ON al.agent_id = a.id
      ORDER BY al.id DESC LIMIT 50
    `).all();

    return {
      agents,
      activeClaims,
      timeline
    };
  }
}
