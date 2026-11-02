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
    const metaJson = JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {});

    this.db.prepare(`
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

    let sql = `
      SELECT * FROM project_handoffs
      WHERE (project_id = ? OR project_id = 'default' OR ? = 'default') AND status = 'pending'
    `;
    const params = [pid, pid];

    if (excludeAgentId) {
      sql += ` AND source_agent_id != ?`;
      params.push(excludeAgentId);
    }
    if (forHostId) {
      sql += ` AND (target_host_id IS NULL OR target_host_id = ? OR target_host_id = 'all')`;
      params.push(forHostId);
    }

    sql += ` ORDER BY created_at DESC LIMIT 1`;
    const row = this.db.prepare(sql).get(...params);
    return row ? this._formatRow(row) : null;
  }

  /**
   * 标记交接工单已被接力会话认领/消费
   */
  consumeHandoff(id, consumingAgentId, hostId = null) {
    const now = Date.now();
    this.db.prepare(`
      UPDATE project_handoffs
      SET status = 'in_progress', consumed_by_agent_id = ?, consumed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(consumingAgentId || 'unknown', now, now, id);

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
    this.db.prepare(`
      UPDATE project_handoffs
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(status, now, id);
    return this.getById(id);
  }

  /**
   * 列出指定工程的交接历史
   */
  list(projectId, { status = null, limit = 20, offset = 0 } = {}) {
    const pid = projectId || 'default';
    const lim = Math.max(1, Math.min(limit || 20, 100));
    const off = Math.max(0, offset || 0);

    let sql = `SELECT * FROM project_handoffs WHERE 1=1`;
    const params = [];

    if (pid !== 'all') {
      sql += ` AND project_id = ?`;
      params.push(pid);
    }

    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(lim, off);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => this._formatRow(r));
  }

  getById(id) {
    const row = this.db.prepare(`SELECT * FROM project_handoffs WHERE id = ?`).get(id);
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
