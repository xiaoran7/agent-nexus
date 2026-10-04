import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

export function createDatabase(customPath = null) {
  const nexusDir = join(homedir(), '.agent-nexus');
  mkdirSync(nexusDir, { recursive: true });
  const dbPath = customPath || process.env.NEXUS_DB_PATH || join(nexusDir, 'nexus.db');

  if (dbPath !== ':memory:') {
    const parent = dirname(dbPath);
    mkdirSync(parent, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    -- 0. 项目登记表
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      root_path TEXT NOT NULL,
      display_name TEXT,
      created_at INTEGER NOT NULL,
      last_activity INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO projects (id, root_path, display_name, created_at, last_activity)
    VALUES ('default', '', 'Default Project', 0, 0);

    -- 1. Agent 注册表 (带项目作用域)
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      workspace_dir TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      last_heartbeat INTEGER NOT NULL,
      registered_at INTEGER NOT NULL
    );

    -- 2. 意图总账 (Intent Ledger)
    CREATE TABLE IF NOT EXISTS intents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL REFERENCES agents(id),
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      blocked_by_agent_id TEXT REFERENCES agents(id),
      blocked_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 3. 资源声明表 (Resource Claims)
    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL DEFAULT 'default',
      intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      claim_type TEXT NOT NULL,
      claim_target TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- 4. 租约表 (Leases)
    CREATE TABLE IF NOT EXISTS leases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default',
      intent_id TEXT NOT NULL UNIQUE REFERENCES intents(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      ttl_seconds INTEGER NOT NULL DEFAULT 300,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- 5. 等待队列 (Wait Queue)
    CREATE TABLE IF NOT EXISTS wait_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL DEFAULT 'default',
      intent_id TEXT NOT NULL UNIQUE REFERENCES intents(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      created_at INTEGER NOT NULL
    );

    -- 6. 事件与活动流水 (Activity Log)
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      target TEXT,
      description TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- 7. 共享状态表与 CAS (以 project_id, namespace, key 为复合主键)
    CREATE TABLE IF NOT EXISTS state (
      project_id TEXT NOT NULL DEFAULT 'default',
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, namespace, key)
    );

    -- 8. 协调点对点/广播消息流
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL DEFAULT 'default',
      from_agent TEXT NOT NULL REFERENCES agents(id),
      to_agent TEXT,
      intent_id TEXT REFERENCES intents(id),
      content TEXT NOT NULL,
      importance TEXT DEFAULT 'normal',
      created_at INTEGER NOT NULL
    );

    -- 9. 项目长期工程记忆库 (Project Long-term Memories)
    CREATE TABLE IF NOT EXISTS project_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL DEFAULT 'default',
      category TEXT NOT NULL DEFAULT 'general',
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      source_agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // 针对已存在的旧版本表结构进行平滑补列迁移
  migrateOldSchemaIfNeeded(db);

  // 补列完成后，统一创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_claims_project_type_target ON claims(project_id, claim_type, claim_target);
    CREATE INDEX IF NOT EXISTS idx_leases_project_expires ON leases(project_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_log(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_state_project_expires ON state(project_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_project_memories_proj_cat ON project_memories(project_id, category);
    CREATE INDEX IF NOT EXISTS idx_project_memories_proj_updated ON project_memories(project_id, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_memories_proj_cat_key ON project_memories(project_id, category, key);
  `);

  // 针对已存在的旧版本表结构进行平滑迁移
  migrateOldSchemaIfNeeded(db);

  return db;
}

function migrateOldSchemaIfNeeded(db) {
  const tables = ['agents', 'intents', 'claims', 'leases', 'wait_queue', 'activity_log', 'messages'];
  for (const table of tables) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default';`);
    } catch {
      // 字段已存在，忽略错误
    }
  }

  // 针对 state 表的复合主键平滑重建 (如果旧库只有两列主键)
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(state);`).all();
    const hasProjectId = tableInfo.some(col => col.name === 'project_id');
    if (!hasProjectId) {
      db.exec(`
        CREATE TABLE state_v2 (
          project_id TEXT NOT NULL DEFAULT 'default',
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          expires_at INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, namespace, key)
        );
        INSERT INTO state_v2 (project_id, namespace, key, value, updated_by, expires_at, updated_at)
        SELECT 'default', namespace, key, value, updated_by, expires_at, updated_at FROM state;
        DROP TABLE state;
        ALTER TABLE state_v2 RENAME TO state;
        CREATE INDEX IF NOT EXISTS idx_state_project_expires ON state(project_id, expires_at);
      `);
    }
  } catch {
    // 忽略迁移失败（例如新库已是 state_v2 形状）
  }
}
