import { resolveProjectDisplayName, getLocalNodeId, normalizeNodeId, isSameNode } from './project.js';
import { computeAgentLifecycleState } from '../daemon/coordinator.js';

export class ProjectRegistry {
  constructor(db, coordinator = null) {
    this.db = db;
    this.coordinator = coordinator;
    this.backfillProjectDisplayNames();
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

  backfillProjectDisplayNames() {
    try {
      this.db.prepare("DELETE FROM projects WHERE id = 'all' OR id = ''").run();

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
    this._stmt(`
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
    const project = this._stmt('SELECT * FROM projects WHERE id = ?').get(projectId) || null;
    if (project && (!project.display_name || /^Project\s+[0-9a-f]{16}$/i.test(project.display_name) || project.display_name === `Project ${project.id}`)) {
      project.display_name = resolveProjectDisplayName(project.root_path, project.root_path, project.id);
    }
    return project;
  }

  listProjects() {
    const projects = this._stmt("SELECT * FROM projects WHERE id != 'all' AND id != '' ORDER BY last_activity DESC").all();

    const onlineMap = new Map();
    const projectHostMap = new Map();
    const localNodeId = this.coordinator?.localNodeId || getLocalNodeId();
    const now = Date.now();
    try {
      const liveRows = this._stmt(`
        SELECT a.project_id, a.host_id, a.status, a.pid, a.last_heartbeat, a.liveness_verified_at, a.last_tool,
               (SELECT count(*) FROM leases l WHERE l.agent_id = a.id AND l.expires_at > ?) as active_leases_count
        FROM agents a
        WHERE a.status != 'departed'
      `).all(now);
      for (const a of liveRows) {
        const { isOnline } = computeAgentLifecycleState(a, now, localNodeId);
        if (isOnline) {
          onlineMap.set(a.project_id, (onlineMap.get(a.project_id) || 0) + 1);
        }
        if (a.host_id && !projectHostMap.has(a.project_id)) {
          projectHostMap.set(a.project_id, a.host_id);
        }
      }
    } catch {}

    const result = [];
    const seenDisplayNames = new Map();

    for (const p of projects) {
      let baseDisplayName = p.display_name;
      if (!baseDisplayName || /^Project\s+[0-9a-f]{16}$/i.test(baseDisplayName) || baseDisplayName === `Project ${p.id}`) {
        baseDisplayName = resolveProjectDisplayName(p.root_path, p.root_path, p.id);
      }
      const hostId = normalizeNodeId(projectHostMap.get(p.id) || p.host_id || localNodeId);
      const isRemote = !isSameNode(hostId, localNodeId);
      const displayName = (isRemote && !baseDisplayName.includes(`[${hostId}]`))
        ? `${baseDisplayName} [${hostId}]`
        : baseDisplayName;
      const onlineCount = onlineMap.get(p.id) || 0;
      const item = {
        ...p,
        host_id: hostId,
        is_remote: isRemote,
        display_name: displayName,
        online_agents_count: onlineCount
      };

      if (seenDisplayNames.has(displayName)) {
        const existingIdx = seenDisplayNames.get(displayName);
        const existing = result[existingIdx];
        const pHasRoot = Boolean(p.root_path && p.root_path !== '');
        const existingHasRoot = Boolean(existing.root_path && existing.root_path !== '');

        if (pHasRoot && existingHasRoot && p.root_path !== existing.root_path) {
          const disambiguated = {
            ...item,
            display_name: `${displayName} (${p.id.slice(0, 6)})`
          };
          seenDisplayNames.set(disambiguated.display_name, result.length);
          result.push(disambiguated);
        } else if (pHasRoot && !existingHasRoot) {
          result[existingIdx] = item;
        } else if (!pHasRoot && !existingHasRoot && onlineCount > (existing.online_agents_count || 0)) {
          result[existingIdx] = item;
        }
      } else {
        seenDisplayNames.set(displayName, result.length);
        result.push(item);
      }
    }

    result.sort((a, b) => {
      const diffOnline = (b.online_agents_count || 0) - (a.online_agents_count || 0);
      if (diffOnline !== 0) return diffOnline;
      return (b.last_activity || 0) - (a.last_activity || 0);
    });

    return result;
  }
}
