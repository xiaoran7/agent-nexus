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
      // 清除历史测试遗留的虚拟全景 'all' 脏记录与空 id 脏记录
      this.db.prepare("DELETE FROM projects WHERE id = 'all' OR id = ''").run();
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
    return projects.map(p => {
      if (!p.display_name || /^Project\s+[0-9a-f]{16}$/i.test(p.display_name) || p.display_name === `Project ${p.id}`) {
        return {
          ...p,
          display_name: resolveProjectDisplayName(p.root_path, p.root_path, p.id)
        };
      }
      return p;
    });
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
