import { ValidationError, requireString } from './errors.js';

// value 在 schema 里是 TEXT NOT NULL，但 NULL 会让 SQLite 直接拒绝绑定、抛
// TypeError 而不是校验错误——那会变成 500，调用方看不出该补哪个字段。
// 这里只接受字符串：状态是给 agent 传结构化载荷用的，复杂值由调用方自己
// JSON.stringify，和 messages.content 的处理一致。
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

  get(namespace = 'default', key) {
    requireString(namespace, 'namespace');
    requireString(key, 'key');
    this.expireSweep();
    return this.db.prepare('SELECT * FROM state WHERE namespace = ? AND key = ?').get(namespace, key) || null;
  }

  set(namespace = 'default', key, value, updatedBy, ttlSeconds = null) {
    requireString(namespace, 'namespace');
    requireString(key, 'key');
    requireValue(value);
    requireString(updatedBy, 'updated_by');
    const ttl = requireTtl(ttlSeconds);

    this.expireSweep();
    const now = Date.now();
    const expiresAt = ttl ? now + (ttl * 1000) : null;

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
    requireString(namespace, 'namespace');
    requireString(key, 'key');
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
    // expected 是"当前期望值"，键不存在时它就是 null，null 必须是合法输入。
    // newValue 也可能是 null——set() 里它表示"删掉这个键"，和 expected 的
    // 语义不同，所以两者必须分开校验。
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
    const current = this.get(namespace, key);
    const currentValue = current ? current.value : null;

    if (currentValue !== expected) {
      return { swapped: false, current: current };
    }

    // 下面的 set() 会把同一个值再校验一遍，并抛出标着 "value" 的错误。
    // 调用方填的字段叫 new_value，回一个对不上的字段名等于没告诉它改哪儿。
    try {
      if (newValue === '' || newValue === null) {
        this.delete(namespace, key);
      } else {
        this.set(namespace, key, newValue, updatedBy, requireTtl(ttlSeconds));
      }
    } catch (err) {
      if (err instanceof ValidationError && err.field === 'value') {
        throw new ValidationError('"new_value" must be a string or null', 'new_value');
      }
      throw err;
    }
    return { swapped: true, current: this.get(namespace, key) };
  }
}
