import { requireString, ValidationError } from './errors.js';

export const VALID_CATEGORIES = new Set(['architecture', 'rule', 'gotcha', 'milestone', 'general']);

function escapeSqlLike(str) {
  return str.replace(/([%_\\])/g, '\\$1');
}

export class ProjectMemoryService {
  constructor(db, eventBus = null) {
    this.db = db;
    this.eventBus = eventBus;
  }

  set(projectId, { category = 'general', key, content, sourceAgentId = null }) {
    const finalProjectId = requireString(projectId, 'project_id');
    const finalKey = requireString(key, 'key');
    const finalContent = requireString(content, 'content');

    let finalCat = typeof category === 'string' ? category.toLowerCase().trim() : 'general';
    if (!VALID_CATEGORIES.has(finalCat)) {
      finalCat = 'general';
    }

    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO project_memories (project_id, category, key, content, source_agent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, category, key) DO UPDATE SET
        content = excluded.content,
        source_agent_id = CASE WHEN excluded.source_agent_id IS NOT NULL THEN excluded.source_agent_id ELSE project_memories.source_agent_id END,
        updated_at = excluded.updated_at
    `);

    stmt.run(finalProjectId, finalCat, finalKey, finalContent, sourceAgentId || null, now, now);

    const record = this.get(finalProjectId, finalKey, finalCat);

    if (this.eventBus) {
      this.eventBus.emit('memory:saved', {
        project_id: finalProjectId,
        memory: record
      });
    }

    return record;
  }

  get(projectId, key, category = null) {
    const pid = projectId || 'default';
    if (category) {
      return this.db.prepare(`
        SELECT * FROM project_memories
        WHERE project_id = ? AND category = ? AND key = ?
      `).get(pid, category, key) || null;
    }
    return this.db.prepare(`
      SELECT * FROM project_memories
      WHERE project_id = ? AND key = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(pid, key) || null;
  }

  getById(projectId, id) {
    const pid = projectId || 'default';
    return this.db.prepare(`
      SELECT * FROM project_memories
      WHERE project_id = ? AND id = ?
    `).get(pid, id) || null;
  }

  list(projectId, { category = null, limit = 50, offset = 0 } = {}) {
    const pid = projectId || 'default';
    const lim = Math.max(1, Math.min(limit || 50, 200));
    const off = Math.max(0, offset || 0);

    if (pid === 'all') {
      if (category) {
        return this.db.prepare(`
          SELECT * FROM project_memories
          WHERE category = ?
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?
        `).all(category, lim, off);
      }
      return this.db.prepare(`
        SELECT * FROM project_memories
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `).all(lim, off);
    }

    if (category) {
      return this.db.prepare(`
        SELECT * FROM project_memories
        WHERE project_id = ? AND category = ?
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `).all(pid, category, lim, off);
    }

    return this.db.prepare(`
      SELECT * FROM project_memories
      WHERE project_id = ?
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(pid, lim, off);
  }

  search(projectId, query, { category = null, limit = 20 } = {}) {
    const pid = projectId || 'default';
    const q = (query || '').trim();
    if (!q) return this.list(projectId, { category, limit });

    const pattern = `%${escapeSqlLike(q)}%`;
    const lim = Math.max(1, Math.min(limit || 20, 100));

    if (pid === 'all') {
      if (category) {
        return this.db.prepare(`
          SELECT * FROM project_memories
          WHERE category = ? AND (key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(category, pattern, pattern, lim);
      }
      return this.db.prepare(`
        SELECT * FROM project_memories
        WHERE key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(pattern, pattern, lim);
    }

    if (category) {
      return this.db.prepare(`
        SELECT * FROM project_memories
        WHERE project_id = ? AND category = ? AND (key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(pid, category, pattern, pattern, lim);
    }

    return this.db.prepare(`
      SELECT * FROM project_memories
      WHERE project_id = ? AND (key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(pid, pattern, pattern, lim);
  }

  delete(projectId, identifier) {
    const pid = projectId || 'default';
    let result = null;

    if (typeof identifier === 'number' || (typeof identifier === 'string' && /^\d+$/.test(identifier))) {
      result = this.db.prepare(`
        DELETE FROM project_memories WHERE project_id = ? AND id = ?
      `).run(pid, Number(identifier));
    } else if (typeof identifier === 'object' && identifier !== null) {
      if (identifier.id) {
        result = this.db.prepare(`
          DELETE FROM project_memories WHERE project_id = ? AND id = ?
        `).run(pid, identifier.id);
      } else if (identifier.key) {
        if (identifier.category) {
          result = this.db.prepare(`
            DELETE FROM project_memories WHERE project_id = ? AND category = ? AND key = ?
          `).run(pid, identifier.category, identifier.key);
        } else {
          result = this.db.prepare(`
            DELETE FROM project_memories WHERE project_id = ? AND key = ?
          `).run(pid, identifier.key);
        }
      }
    } else if (typeof identifier === 'string') {
      result = this.db.prepare(`
        DELETE FROM project_memories WHERE project_id = ? AND key = ?
      `).run(pid, identifier);
    }

    const deleted = result ? result.changes : 0;
    if (deleted > 0 && this.eventBus) {
      this.eventBus.emit('memory:deleted', {
        project_id: pid,
        identifier
      });
    }

    return { success: deleted > 0, deleted };
  }
}
