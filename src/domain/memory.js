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
   * 使本地与远端同名工程（如 Windows 与 Linux 下的同一个仓库）天然共享长期工程记忆。
   */
  _resolveEquivalentProjectIds(pid) {
    if (!pid || pid === 'all' || pid === 'default') return [pid || 'default'];
    const ids = new Set([pid]);
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

  set(projectId, { category = 'general', key, content, sourceAgentId = null }) {
    const finalProjectId = requireString(projectId, 'project_id');
    const finalKey = requireString(key, 'key');
    const finalContent = requireString(content, 'content');

    let finalCat = typeof category === 'string' ? category.toLowerCase().trim() : 'general';
    if (!VALID_CATEGORIES.has(finalCat)) {
      finalCat = 'general';
    }

    const now = Date.now();

    const stmt = this._stmt(`
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
      return this._stmt(`
        SELECT * FROM project_memories
        WHERE project_id = ? AND category = ? AND key = ?
      `).get(pid, category, key) || null;
    }
    return this._stmt(`
      SELECT * FROM project_memories
      WHERE project_id = ? AND key = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(pid, key) || null;
  }

  getById(projectId, id) {
    const pid = projectId || 'default';
    return this._stmt(`
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
        return this._stmt(`
          SELECT * FROM project_memories
          WHERE category = ?
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?
        `).all(category, lim, off);
      }
      return this._stmt(`
        SELECT * FROM project_memories
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `).all(lim, off);
    }

    const eqIds = this._resolveEquivalentProjectIds(pid);
    const placeholders = eqIds.map(() => '?').join(', ');

    if (category) {
      return this._stmt(`
        SELECT * FROM project_memories
        WHERE project_id IN (${placeholders}) AND category = ?
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `).all(...eqIds, category, lim, off);
    }

    return this._stmt(`
      SELECT * FROM project_memories
      WHERE project_id IN (${placeholders})
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...eqIds, lim, off);
  }

  search(projectId, query, { category = null, limit = 20 } = {}) {
    const pid = projectId || 'default';
    const q = (query || '').trim();
    if (!q) return this.list(projectId, { category, limit });

    const pattern = `%${escapeSqlLike(q)}%`;
    const lim = Math.max(1, Math.min(limit || 20, 100));

    if (pid === 'all') {
      if (category) {
        return this._stmt(`
          SELECT * FROM project_memories
          WHERE category = ? AND (key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(category, pattern, pattern, lim);
      }
      return this._stmt(`
        SELECT * FROM project_memories
        WHERE key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(pattern, pattern, lim);
    }

    const eqIds = this._resolveEquivalentProjectIds(pid);
    const placeholders = eqIds.map(() => '?').join(', ');

    if (category) {
      return this._stmt(`
        SELECT * FROM project_memories
        WHERE project_id IN (${placeholders}) AND category = ? AND (key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(...eqIds, category, pattern, pattern, lim);
    }

    return this._stmt(`
      SELECT * FROM project_memories
      WHERE project_id IN (${placeholders}) AND (key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...eqIds, pattern, pattern, lim);
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
