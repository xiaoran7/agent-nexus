import { ValidationError, requireString } from './errors.js';

function requireValue(value) {
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError('"value" is required and must be a non-empty string', 'value');
  }
  return value;
}

function requireTtl(ttlSeconds) {
  if (ttlSeconds === null || ttlSeconds === undefined) return null;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new ValidationError('"ttl_seconds" must be a positive number', 'ttl_seconds');
  }
  return ttlSeconds;
}

export class StateService {
  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
    this._lastSweepAt = 0;
  }

  expireSweep(force = false) {
    const now = Date.now();
    // 节流机制：非强制调用时，至少间隔 3000ms 执行一次全表清理，大幅减轻高频事务开销
    if (!force && now - this._lastSweepAt < 3000) {
      return;
    }
    this._lastSweepAt = now;
    this.db.prepare('DELETE FROM state WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
  }

  get(namespace = 'default', key, projectId = 'default') {
    requireString(namespace, 'namespace');
    requireString(key, 'key');
    this.expireSweep();
    const row = this.db.prepare(`
      SELECT * FROM state WHERE project_id = ? AND namespace = ? AND key = ?
    `).get(projectId, namespace, key);
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      return null;
    }
    return row;
  }

  set(namespace = 'default', key, value, updatedBy, ttlSeconds = null, projectId = 'default') {
    requireString(namespace, 'namespace');
    requireString(key, 'key');
    requireValue(value);
    requireString(updatedBy, 'updated_by');
    const ttl = requireTtl(ttlSeconds);

    this.expireSweep();
    const now = Date.now();
    const expiresAt = ttl ? now + (ttl * 1000) : null;

    this.db.prepare(`
      INSERT INTO state (project_id, namespace, key, value, updated_by, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, namespace, key) DO UPDATE SET
        value = excluded.value,
        updated_by = excluded.updated_by,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(projectId, namespace, key, value, updatedBy, expiresAt, now);

    this.eventBus.emit('state:changed', { project_id: projectId, namespace, key, value, updatedBy });
    return this.get(namespace, key, projectId);
  }

  delete(namespace = 'default', key, projectId = 'default') {
    requireString(namespace, 'namespace');
    requireString(key, 'key');
    const res = this.db.prepare(`
      DELETE FROM state WHERE project_id = ? AND namespace = ? AND key = ?
    `).run(projectId, namespace, key);
    if (res.changes > 0) {
      this.eventBus.emit('state:deleted', { project_id: projectId, namespace, key });
      return true;
    }
    return false;
  }

  list(namespace = 'default', prefix = '', projectId = 'default') {
    this.expireSweep();
    const now = Date.now();
    if (prefix) {
      return this.db.prepare(`
        SELECT * FROM state
        WHERE project_id = ? AND namespace = ? AND (expires_at IS NULL OR expires_at > ?) AND key LIKE ?
        ORDER BY key
      `).all(projectId, namespace, now, `${prefix}%`);
    }
    return this.db.prepare(`
      SELECT * FROM state
      WHERE project_id = ? AND namespace = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY key
    `).all(projectId, namespace, now);
  }

  // CAS (Compare-And-Swap) 原子操作：在 BEGIN IMMEDIATE 事务中原子执行，消除 TOCTOU 竞争
  compareAndSwap(namespace = 'default', key, expected, newValue, updatedBy, ttlSeconds = null, projectId = 'default') {
    requireString(namespace, 'namespace');
    requireString(key, 'key');
    if (expected !== null && typeof expected !== 'string') {
      throw new ValidationError('"expected" must be a string or null', 'expected');
    }
    if (newValue !== null && typeof newValue !== 'string') {
      throw new ValidationError('"new_value" must be a string or null', 'new_value');
    }
    if (newValue !== null && newValue !== '') {
      requireString(updatedBy, 'updated_by');
    }

    const ttl = requireTtl(ttlSeconds);
    this.expireSweep();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      const row = this.db.prepare(`
        SELECT * FROM state WHERE project_id = ? AND namespace = ? AND key = ?
      `).get(projectId, namespace, key);

      const isExpired = row && row.expires_at !== null && row.expires_at <= now;
      const effectiveRow = isExpired ? null : row;
      const currentValue = effectiveRow ? effectiveRow.value : null;

      if (currentValue !== expected) {
        this.db.exec('COMMIT');
        return { swapped: false, current: effectiveRow };
      }

      if (newValue === '' || newValue === null) {
        this.db.prepare(`
          DELETE FROM state WHERE project_id = ? AND namespace = ? AND key = ?
        `).run(projectId, namespace, key);
        this.db.exec('COMMIT');
        this.eventBus?.emit('state:deleted', { project_id: projectId, namespace, key });
        return { swapped: true, current: null };
      } else {
        const expiresAt = ttl ? now + (ttl * 1000) : null;
        this.db.prepare(`
          INSERT INTO state (project_id, namespace, key, value, updated_by, expires_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, namespace, key) DO UPDATE SET
            value = excluded.value,
            updated_by = excluded.updated_by,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
        `).run(projectId, namespace, key, newValue, updatedBy, expiresAt, now);

        const updatedRow = this.db.prepare(`
          SELECT * FROM state WHERE project_id = ? AND namespace = ? AND key = ?
        `).get(projectId, namespace, key);

        this.db.exec('COMMIT');
        this.eventBus?.emit('state:changed', { project_id: projectId, namespace, key, value: newValue, updatedBy });
        return { swapped: true, current: updatedRow };
      }
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }
}
