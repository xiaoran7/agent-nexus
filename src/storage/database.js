import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

export function createDatabase(customPath = null) {
  const nexusDir = join(homedir(), '.agent-nexus');
  mkdirSync(nexusDir, { recursive: true });
  const dbPath = customPath || process.env.NEXUS_DB_PATH || join(nexusDir, 'nexus.db');

  // 自定义路径的父目录不一定存在（部署时最常见的做法是直接给一个
  // NEXUS_DB_PATH=/var/lib/agent-nexus/nexus.db）。DatabaseSync 不会建目录，
  // 缺目录时抛的是 "unable to open database file"——既不说是哪个路径，
  // 也让人误以为是权限或文件损坏问题。补齐目录后再报错才有可操作性。
  if (dbPath !== ':memory:') {
    const parent = dirname(dbPath);
    mkdirSync(parent, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    -- 1. Agent 注册表
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
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
      agent_id TEXT NOT NULL REFERENCES agents(id),
      summary TEXT NOT NULL,
      status TEXT NOT NULL, -- 'granted' | 'waiting' | 'running' | 'completed' | 'released' | 'aborted'
      blocked_by_agent_id TEXT REFERENCES agents(id),
      blocked_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 3. 资源声明表 (Resource Claims)
    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      claim_type TEXT NOT NULL, -- 'file' | 'module' | 'symbol'
      claim_target TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claims_type_target ON claims(claim_type, claim_target);

    -- 4. 租约表 (Leases)
    CREATE TABLE IF NOT EXISTS leases (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL UNIQUE REFERENCES intents(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      ttl_seconds INTEGER NOT NULL DEFAULT 300,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leases_expires ON leases(expires_at);

    -- 5. 等待队列 (Wait Queue)
    CREATE TABLE IF NOT EXISTS wait_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id TEXT NOT NULL UNIQUE REFERENCES intents(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      created_at INTEGER NOT NULL
    );

    -- 6. 事件与活动流水 (Activity Log - 面向 Dashboard Timeline)
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      target TEXT,
      description TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- 7. 共享状态表与 CAS (对齐 agent-comm 的 kv/state)
    CREATE TABLE IF NOT EXISTS state (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (namespace, key)
    );
    CREATE INDEX IF NOT EXISTS idx_state_expires ON state(expires_at);

    -- 8. 协调点对点/广播消息流 (针对 Agent 协调沟通)
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL REFERENCES agents(id),
      to_agent TEXT, -- NULL 代表广播
      intent_id TEXT REFERENCES intents(id),
      content TEXT NOT NULL,
      importance TEXT DEFAULT 'normal',
      created_at INTEGER NOT NULL
    );
  `);

  return db;
}
