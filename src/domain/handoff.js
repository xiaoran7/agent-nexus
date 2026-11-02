import { randomUUID } from 'node:crypto';
import { requireString } from './errors.js';

/**
 * 跨机与跨会话工作交接服务 (PowerContext Work Handoff Service)
 * 解决 Claude Desktop 多机/多 Tab 场景下的认知孤岛：
 * 将上游会话（如 Local Windows）已验证的改动、状态与下一步动作，
 * 无缝串联给下游接力会话（如 Remote Linux us-zenix）
 */
export class ProjectHandoffService {
  constructor(db, eventBus = null) {
    this.db = db;
    this.eventBus = eventBus;
  }

  _stmt(sql) {
    if (this._stmtDb !== this.db) {
      this._stmtDb = this.db;
      this._stmtCache = new Map();
    }
    let stmt = this._stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this._stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * 解析跨机同源工程 ID 集合：
   * 解决本地 Windows (D:\...\Agent-Nexus) 与远端 Linux (/root/.../Agent-Nexus)
   * 因跨 OS 绝对路径哈希不同导致生成的 projectId 不一致、无法跨机共享同一仓库交接工单的问题。
   */
  _resolveEquivalentProjectIds(pid) {
    if (!pid || pid === 'all' || pid === 'default') return [pid || 'default'];
    const ids = new Set([pid, 'default']);
    try {
      const row = this._stmt(`SELECT display_name, root_path FROM projects WHERE id = ?`).get(pid);
      const rawName = row?.display_name || (row?.root_path ? row.root_path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() : null);
      if (rawName) {
        const baseName = rawName.replace(/\s*\[[^\]]+\]\s*$/, '').trim().toLowerCase();
        if (baseName && baseName !== 'default project' && !baseName.startsWith('project (')) {
          const peers = this._stmt(`
            SELECT id, display_name, root_path FROM projects
            WHERE id != 'all' AND id != ''
          `).all();
          for (const p of peers) {
            const pRaw = p.display_name || (p.root_path ? p.root_path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() : '');
            const pBase = pRaw.replace(/\s*\[[^\]]+\]\s*$/, '').trim().toLowerCase();
            if (pBase === baseName) {
              ids.add(p.id);
            }
          }
        }
      }
    } catch {}
    return [...ids];
  }

  /**
   * 创建一份持久交接工单
   */
  createHandoff(projectIdOrOpts, opts = {}) {
    let finalProjectId;
    let options;
    if (typeof projectIdOrOpts === 'object' && projectIdOrOpts !== null) {
      finalProjectId = requireString(projectIdOrOpts.projectId || projectIdOrOpts.project_id || 'default', 'project_id');
      options = projectIdOrOpts;
    } else {
      finalProjectId = requireString(projectIdOrOpts || 'default', 'project_id');
      options = opts || {};
    }

    const {
      sourceHostId = 'local',
      sourceAgentId,
      source_agent_id,
      sourceSessionId = null,
      source_session_id = null,
      targetHostId = null,
      target_host_id = null,
      objective,
      stateSummary,
      state_summary,
      modifiedFiles = [],
      modified_files = [],
      nextAction,
      next_action,
      metadata = {}
    } = options;

    const finalObjective = requireString(objective, 'objective');
    const finalState = requireString(stateSummary || state_summary || finalObjective, 'stateSummary');
    const finalNextAction = requireString(nextAction || next_action || '请接力推进', 'nextAction');
    const finalAgentId = requireString(sourceAgentId || source_agent_id || 'operator', 'sourceAgentId');

    const id = `handoff-${randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const files = modifiedFiles.length > 0 ? modifiedFiles : modified_files;
    const filesJson = JSON.stringify(Array.isArray(files) ? files : []);
    const metaObj = metadata && typeof metadata === 'object' ? metadata : {};
    const metaJson = JSON.stringify(metaObj);

    // 若为自动合成的新一轮阶段提交，自动将同项目此前未认领的旧自动合成工单演进为 completed，避免过期接力堆积
    if (metaObj.auto_synthesized) {
      try {
        this._stmt(`
          UPDATE project_handoffs
          SET status = 'completed', updated_at = ?
          WHERE project_id = ? AND status = 'pending' AND instr(metadata, '"auto_synthesized":true') > 0
        `).run(now, finalProjectId);
      } catch {}
    }

    this._stmt(`
      INSERT INTO project_handoffs (
        id, project_id, source_host_id, source_agent_id, source_session_id,
        target_host_id, objective, state_summary, modified_files, next_action,
        status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      id, finalProjectId, sourceHostId || 'local', finalAgentId, sourceSessionId || source_session_id || null,
      targetHostId || target_host_id || null, finalObjective, finalState, filesJson, finalNextAction,
      metaJson, now, now
    );

    const record = this.getById(id);

    if (this.eventBus) {
      this.eventBus.emit('handoff:created', {
        project_id: finalProjectId,
        handoff: record
      });
    }

    return record;
  }

  /**
   * 获取某工程待接力的最新有效交接工单
   * @param {string|object} projectIdOrOpts
   * @param {object} [opts]
   */
  getPendingHandoff(projectIdOrOpts, opts = {}) {
    let pid = 'default';
    let options = {};
    if (typeof projectIdOrOpts === 'object' && projectIdOrOpts !== null) {
      pid = projectIdOrOpts.projectId || projectIdOrOpts.project_id || 'default';
      options = projectIdOrOpts;
    } else {
      pid = projectIdOrOpts || 'default';
      options = opts || {};
    }

    const excludeAgentId = options.excludeAgentId || options.exclude_agent_id || null;
    const forHostId = options.forHostId || options.for_host_id || options.targetHostId || options.target_host_id || null;

    const eqIds = this._resolveEquivalentProjectIds(pid);
    const placeholders = eqIds.map(() => '?').join(', ');

    let sql = `
      SELECT * FROM project_handoffs
      WHERE (project_id IN (${placeholders}) OR ? = 'default') AND status = 'pending'
    `;
    const params = [...eqIds, pid];

    if (excludeAgentId) {
      sql += ` AND source_agent_id != ?`;
      params.push(excludeAgentId);
    }
    if (forHostId) {
      sql += ` AND (target_host_id IS NULL OR target_host_id = ? OR target_host_id = 'all')`;
      params.push(forHostId);
    }

    sql += ` ORDER BY created_at DESC LIMIT 1`;
    const row = this._stmt(sql).get(...params);
    return row ? this._formatRow(row) : null;
  }

  /**
   * 标记交接工单已被接力会话认领/消费，或已完成闭环
   */
  consumeHandoff(id, consumingAgentId, hostId = null, targetStatus = null) {
    const now = Date.now();
    const existing = this.getById(id);
    const nextStatus = targetStatus || (existing?.status === 'in_progress' ? 'completed' : 'in_progress');

    this._stmt(`
      UPDATE project_handoffs
      SET status = ?, consumed_by_agent_id = COALESCE(?, consumed_by_agent_id), consumed_at = COALESCE(consumed_at, ?), updated_at = ?
      WHERE id = ?
    `).run(nextStatus, consumingAgentId || 'unknown', now, now, id);

    const record = this.getById(id);
    if (this.eventBus && record) {
      this.eventBus.emit('handoff:consumed', {
        project_id: record.project_id,
        handoff: record,
        by_agent_id: consumingAgentId,
        host_id: hostId
      });
    }
    return record;
  }

  /**
   * 更新交接工单状态
   */
  updateStatus(id, status) {
    const now = Date.now();
    this._stmt(`
      UPDATE project_handoffs
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(status, now, id);
    return this.getById(id);
  }

  /**
   * 列出指定工程的交接历史（支持跨机同名工程聚合）
   */
  list(projectId, { status = null, limit = 20, offset = 0 } = {}) {
    const pid = projectId || 'default';
    const lim = Math.max(1, Math.min(limit || 20, 100));
    const off = Math.max(0, offset || 0);

    let sql = `SELECT * FROM project_handoffs WHERE 1=1`;
    const params = [];

    if (pid !== 'all') {
      const eqIds = this._resolveEquivalentProjectIds(pid);
      const placeholders = eqIds.map(() => '?').join(', ');
      sql += ` AND project_id IN (${placeholders})`;
      params.push(...eqIds);
    }

    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(lim, off);

    const rows = this._stmt(sql).all(...params);
    return rows.map(r => this._formatRow(r));
  }

  getById(id) {
    const row = this._stmt(`SELECT * FROM project_handoffs WHERE id = ?`).get(id);
    return row ? this._formatRow(row) : null;
  }

  /**
   * 当会话执行 Git Commit / Release 时，自动合成一份阶段性交接工单
   */
  autoSynthesizeFromRelease(projectIdOrOpts, agentOrOpts = null, releasedClaims = []) {
    let pid = 'default';
    let agent = null;
    let claims = [];

    if (typeof projectIdOrOpts === 'object' && projectIdOrOpts !== null && !agentOrOpts) {
      pid = projectIdOrOpts.projectId || projectIdOrOpts.project_id || 'default';
      const sourceHost = projectIdOrOpts.sourceHostId || projectIdOrOpts.source_host_id || 'local';
      const sourceAgent = projectIdOrOpts.sourceAgentId || projectIdOrOpts.source_agent_id || 'agent';
      const git = projectIdOrOpts.gitContext || {};
      agent = {
        id: sourceAgent,
        host_id: sourceHost,
        session_id: projectIdOrOpts.sourceSessionId || null,
        current_intent: git.lastCommit || projectIdOrOpts.objective || null
      };
      claims = git.modifiedFiles || projectIdOrOpts.modifiedFiles || [];
    } else {
      pid = projectIdOrOpts || 'default';
      agent = agentOrOpts;
      claims = releasedClaims || [];
    }

    if (!agent) return null;
    const fileTargets = (claims || [])
      .map(c => (typeof c === 'string' ? c : c.claim_target || c.target || ''))
      .filter(Boolean);

    // 只有在明确有文件改动或有效意图时才自动沉淀
    const summary = agent.current_intent || agent.progress_summary || (fileTargets.length > 0 ? `完成文件改动 (${fileTargets.length} 个文件)` : null);
    if (!summary && fileTargets.length === 0) return null;

    const objective = summary || '阶段代码实现完工';
    const stateSummary = fileTargets.length > 0
      ? `已提交修改文件: ${fileTargets.slice(0, 5).join(', ')}${fileTargets.length > 5 ? ` 等共 ${fileTargets.length} 个文件` : ''}，写锁已安全释放。`
      : '阶段开发任务已提交收尾，环境已重置为空闲。';
    const nextAction = '可在对端环境中执行测试、构建、环境验收或开始后续子模块开发。';

    return this.createHandoff(pid, {
      sourceHostId: agent.host_id || 'local',
      sourceAgentId: agent.id,
      sourceSessionId: agent.session_id || null,
      objective,
      stateSummary,
      modifiedFiles: fileTargets,
      nextAction,
      metadata: {
        auto_synthesized: true,
        source_provider: agent.provider || 'claude'
      }
    });
  }

  _formatRow(row) {
    let files = [];
    let meta = {};
    try { files = JSON.parse(row.modified_files || '[]'); } catch {}
    try { meta = JSON.parse(row.metadata || '{}'); } catch {}

    return {
      id: row.id,
      project_id: row.project_id,
      source_host_id: row.source_host_id,
      source_agent_id: row.source_agent_id,
      source_session_id: row.source_session_id,
      target_host_id: row.target_host_id,
      objective: row.objective,
      state_summary: row.state_summary,
      modified_files: files,
      next_action: row.next_action,
      status: row.status,
      consumed_by_agent_id: row.consumed_by_agent_id,
      consumed_at: row.consumed_at,
      metadata: meta,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
}
