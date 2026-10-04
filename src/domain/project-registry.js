import { ProjectLead } from './project-lead.js';
import { NullAdapter, AnthropicAdapter, parseLlmConfig } from './llm-adapter.js';

export class ProjectRegistry {
  constructor(db, coordinator, eventBus, llmAdapterFactory = null, memoryService = null) {
    this.db = db;
    this.coordinator = coordinator;
    this.eventBus = eventBus;
    this.memoryService = memoryService;
    this.llmConfig = parseLlmConfig();

    this.llmAdapterFactory = llmAdapterFactory || (() => {
      if (this.llmConfig.enabled) {
        return new AnthropicAdapter({
          apiKey: this.llmConfig.apiKey,
          authToken: this.llmConfig.authToken,
          baseUrl: this.llmConfig.baseUrl,
          model: this.llmConfig.model,
          timeoutMs: this.llmConfig.timeoutMs
        });
      }
      return new NullAdapter();
    });
    this.leads = new Map(); // projectId -> ProjectLead
  }

  ensureProject(projectId, rootPath = '', displayName = null) {
    const now = Date.now();
    const finalName = displayName || (projectId === 'default' ? 'Default Project' : `Project ${projectId}`);
    this.db.prepare(`
      INSERT INTO projects (id, root_path, display_name, created_at, last_activity)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        root_path = CASE WHEN excluded.root_path != '' THEN excluded.root_path ELSE projects.root_path END,
        last_activity = excluded.last_activity
    `).run(projectId, rootPath, finalName, now, now);
    return this.getProject(projectId);
  }

  getProject(projectId) {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) || null;
  }

  listProjects() {
    return this.db.prepare('SELECT * FROM projects ORDER BY last_activity DESC').all();
  }

  getOrCreateLead(projectId) {
    const finalId = projectId || 'default';
    if (!this.leads.has(finalId)) {
      this.ensureProject(finalId);
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
