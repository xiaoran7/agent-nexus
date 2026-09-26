export class StateService {
  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  expireSweep() {
    const now = Date.now();
    this.db.prepare('DELETE FROM state WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
  }

  get(namespace = 'default', key) {
    this.expireSweep();
    return this.db.prepare('SELECT * FROM state WHERE namespace = ? AND key = ?').get(namespace, key) || null;
  }

  set(namespace = 'default', key, value, updatedBy, ttlSeconds = null) {
    this.expireSweep();
    const now = Date.now();
    const expiresAt = ttlSeconds ? now + (ttlSeconds * 1000) : null;

    this.db.prepare(`
      INSERT INTO state (namespace, key, value, updated_by, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, key) DO UPDATE SET
        value = excluded.value,
        updated_by = excluded.updated_by,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(namespace, key, value, updatedBy, expiresAt, now);

    this.eventBus.emit('state:changed', { namespace, key, value, updatedBy });
    return this.get(namespace, key);
  }

  delete(namespace = 'default', key) {
    const res = this.db.prepare('DELETE FROM state WHERE namespace = ? AND key = ?').run(namespace, key);
    if (res.changes > 0) {
      this.eventBus.emit('state:deleted', { namespace, key });
      return true;
    }
    return false;
  }

  list(namespace = 'default', prefix = '') {
    this.expireSweep();
    if (prefix) {
      return this.db.prepare('SELECT * FROM state WHERE namespace = ? AND key LIKE ? ORDER BY key').all(namespace, `${prefix}%`);
    }
    return this.db.prepare('SELECT * FROM state WHERE namespace = ? ORDER BY key').all(namespace);
  }

  // CAS (Compare-And-Swap) 原子操作
  compareAndSwap(namespace = 'default', key, expected, newValue, updatedBy, ttlSeconds = null) {
    this.expireSweep();
    const current = this.get(namespace, key);
    const currentValue = current ? current.value : null;

    if (currentValue !== expected) {
      return { swapped: false, current: current };
    }

    if (newValue === '' || newValue === null) {
      this.delete(namespace, key);
    } else {
      this.set(namespace, key, newValue, updatedBy, ttlSeconds);
    }
    return { swapped: true, current: this.get(namespace, key) };
  }
}
