import { ProjectLead } from './project-lead.js';
import { NullAdapter, AnthropicAdapter, GatewayRouterAdapter, parseLlmConfig } from './llm-adapter.js';
import { GatewayRouter } from './gateway-router.js';
import { resolveProjectDisplayName } from './project.js';

export class ProjectRegistry {
  constructor(db, coordinator, eventBus, llmAdapterFactory = null, memoryService = null) {
    this.db = db;
    this.coordinator = coordinator;
    this.eventBus = eventBus;
    this.memoryService = memoryService;
    this.llmConfig = parseLlmConfig();

    // 初始化全局 GatewayRouter
    this.gatewayRouter = new GatewayRouter({
      strategy: this.llmConfig.strategy || 'smart',
      eventBus: this.eventBus
    });

    if (this.llmConfig.enabled && Array.isArray(this.llmConfig.candidates)) {
      for (const cand of this.llmConfig.candidates) {
        this.gatewayRouter.addCandidate(cand);
      }
    }

    this.llmAdapterFactory = llmAdapterFactory || (() => {
      if (this.llmConfig.enabled && this.gatewayRouter.candidates.length > 0) {
        return new GatewayRouterAdapter(this.gatewayRouter);
      }
      return new NullAdapter();
    });
    this.leads = new Map(); // projectId -> ProjectLead

    // 历史数据库平滑回填：将存量 "Project <hash>" 迁移为真实可读名称
    this.backfillProjectDisplayNames();
  }

  backfillProjectDisplayNames() {
    try {
      // 1. 清除历史测试遗留的虚拟全景 'all' 脏记录与空 id 脏记录
      this.db.prepare("DELETE FROM projects WHERE id = 'all' OR id = ''").run();

      // 2. 迁移并清理旧版残留的幽灵项目 (如直接将项目名当作 id 且 root_path 为空的脏记录)
      const phantomRows = this.db.prepare(`
        SELECT p1.id as phantom_id, p2.id as target_id
        FROM projects p1
        JOIN projects p2 ON p1.display_name = p2.display_name AND p1.id != p2.id
        WHERE (p1.root_path = '' OR p1.root_path IS NULL) AND p2.root_path != '' AND p2.root_path IS NOT NULL
      `).all();
      for (const row of phantomRows) {
        try {
          this.db.prepare('UPDATE OR IGNORE agents SET project_id = ? WHERE project_id = ?').run(row.target_id, row.phantom_id);
          this.db.prepare('UPDATE OR IGNORE intents SET project_id = ? WHERE project_id = ?').run(row.target_id, row.phantom_id);
          this.db.prepare('UPDATE OR IGNORE activity_log SET project_id = ? WHERE project_id = ?').run(row.target_id, row.phantom_id);
          this.db.prepare('DELETE FROM projects WHERE id = ?').run(row.phantom_id);
        } catch {}
      }

      // 3. 对同名空路径项目做去重清理
      this.db.prepare(`
        DELETE FROM projects
        WHERE (root_path = '' OR root_path IS NULL)
          AND id IN (SELECT display_name FROM projects WHERE root_path != '' AND root_path IS NOT NULL)
      `).run();

      const rows = this.db.prepare('SELECT id, root_path, display_name FROM projects').all();
      const updateStmt = this.db.prepare('UPDATE projects SET display_name = ? WHERE id = ?');
      for (const row of rows) {
        if (!row.display_name || /^Project\s+[0-9a-f]{16}$/i.test(row.display_name) || row.display_name === `Project ${row.id}`) {
          const resolved = resolveProjectDisplayName(row.root_path, row.root_path, row.id);
          if (resolved && resolved !== row.display_name) {
            updateStmt.run(resolved, row.id);
          }
        }
      }
    } catch {}
  }

  ensureProject(projectId, rootPath = '', displayName = null) {
    if (!projectId || projectId === 'all') return null;
    const now = Date.now();
    const finalName = displayName || resolveProjectDisplayName(rootPath, rootPath, projectId);
    this.db.prepare(`
      INSERT INTO projects (id, root_path, display_name, created_at, last_activity)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        root_path = CASE WHEN excluded.root_path != '' THEN excluded.root_path ELSE projects.root_path END,
        display_name = CASE
          WHEN excluded.display_name IS NOT NULL
            AND excluded.display_name != ''
            AND NOT excluded.display_name LIKE 'Project %'
          THEN excluded.display_name
          WHEN projects.display_name IS NULL
            OR projects.display_name = ''
            OR projects.display_name LIKE 'Project %'
          THEN excluded.display_name
          ELSE projects.display_name
        END,
        last_activity = excluded.last_activity
    `).run(projectId, rootPath, finalName, now, now);
    return this.getProject(projectId);
  }

  getProject(projectId) {
    if (!projectId || projectId === 'all') return null;
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) || null;
    if (project && (!project.display_name || /^Project\s+[0-9a-f]{16}$/i.test(project.display_name) || project.display_name === `Project ${project.id}`)) {
      project.display_name = resolveProjectDisplayName(project.root_path, project.root_path, project.id);
    }
    return project;
  }

  listProjects() {
    // 强制排除保留的虚拟全景 'all' 与空 id，确保下拉选单主权清晰且无冲突
    const projects = this.db.prepare("SELECT * FROM projects WHERE id != 'all' AND id != '' ORDER BY last_activity DESC").all();

    // 统计当前各个项目的在线助手数量
    const onlineMap = new Map();
    try {
      if (this.coordinator) {
        const snap = this.coordinator.getDashboardSnapshot('all');
        for (const a of snap.agents || []) {
          if (a.is_online) {
            onlineMap.set(a.project_id, (onlineMap.get(a.project_id) || 0) + 1);
          }
        }
      }
    } catch {}

    const result = [];
    const seenDisplayNames = new Map(); // displayName -> index in result

    for (const p of projects) {
      let displayName = p.display_name;
      if (!displayName || /^Project\s+[0-9a-f]{16}$/i.test(displayName) || displayName === `Project ${p.id}`) {
        displayName = resolveProjectDisplayName(p.root_path, p.root_path, p.id);
      }
      const onlineCount = onlineMap.get(p.id) || 0;
      const item = {
        ...p,
        display_name: displayName,
        online_agents_count: onlineCount
      };

      // 避免重复的显示名称（如旧版遗留的同名幽灵工程）
      if (seenDisplayNames.has(displayName)) {
        const existingIdx = seenDisplayNames.get(displayName);
        const existing = result[existingIdx];
        if (p.root_path && (!existing.root_path || existing.root_path === '')) {
          result[existingIdx] = item;
        } else if (onlineCount > (existing.online_agents_count || 0)) {
          result[existingIdx] = item;
        }
      } else {
        seenDisplayNames.set(displayName, result.length);
        result.push(item);
      }
    }

    // 优先按在线助手数量降序，再按最近活跃时间降序
    result.sort((a, b) => {
      const diffOnline = (b.online_agents_count || 0) - (a.online_agents_count || 0);
      if (diffOnline !== 0) return diffOnline;
      return (b.last_activity || 0) - (a.last_activity || 0);
    });

    return result;
  }

  getOrCreateLead(projectId) {
    const finalId = projectId || 'default';
    if (!this.leads.has(finalId)) {
      if (finalId !== 'all') {
        this.ensureProject(finalId);
      }
      const adapter = this.llmAdapterFactory(finalId);
      const lead = new ProjectLead(finalId, this.coordinator, this.eventBus, adapter, this.memoryService);
      this.leads.set(finalId, lead);
    }
    return this.leads.get(finalId);
  }

  removeLead(projectId) {
    return this.leads.delete(projectId);
  }
}
