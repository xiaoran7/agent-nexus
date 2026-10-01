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
  }

  expireSweep() {
    const now = Date.now();
    this.db.prepare('DELETE FROM state WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
  }

  get(namespace = 'default', key, projectId = 'default') {
    requireString(namespace, 'namespace');
    requireString(key, 'key');
    this.expireSweep();
    return this.db.prepare(`
      SELECT * FROM state WHERE project_id = ? AND namespace = ? AND key = ?
    `).get(projectId, namespace, key) || null;
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
    if (prefix) {
      return this.db.prepare(`
        SELECT * FROM state WHERE project_id = ? AND namespace = ? AND key LIKE ? ORDER BY key
      `).all(projectId, namespace, `${prefix}%`);
    }
    return this.db.prepare(`
      SELECT * FROM state WHERE project_id = ? AND namespace = ? ORDER BY key
    `).all(projectId, namespace);
  }

  // CAS (Compare-And-Swap) 原子操作
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

    this.expireSweep();
    const current = this.get(namespace, key, projectId);
    const currentValue = current ? current.value : null;

    if (currentValue !== expected) {
      return { swapped: false, current: current };
    }

    try {
      if (newValue === '' || newValue === null) {
        this.delete(namespace, key, projectId);
      } else {
        this.set(namespace, key, newValue, updatedBy, requireTtl(ttlSeconds), projectId);
      }
    } catch (err) {
      if (err instanceof ValidationError && err.field === 'value') {
        throw new ValidationError('"new_value" must be a string or null', 'new_value');
      }
      throw err;
    }
    return { swapped: true, current: this.get(namespace, key, projectId) };
  }
}
