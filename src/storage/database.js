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
      host_id TEXT DEFAULT 'local',
      git_remote TEXT,
      created_at INTEGER NOT NULL,
      last_activity INTEGER NOT NULL
    );

    -- 1. Agent 注册表 (带项目作用域、节点身份与进程号、工具调用态势追踪)
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default',
      host_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      workspace_dir TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      last_heartbeat INTEGER NOT NULL,
      registered_at INTEGER NOT NULL,
      current_intent TEXT,
      pid INTEGER,
      last_tool TEXT,
      last_action TEXT,
      last_target TEXT,
      liveness_verified_at INTEGER
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

    -- 7. 项目长期工程记忆库 (Project Long-term Memories)
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

    -- 8. 跨机集群节点拓扑表 (Cluster Nodes Registry)
    CREATE TABLE IF NOT EXISTS cluster_nodes (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'edge',
      platform TEXT NOT NULL DEFAULT 'unknown',
      ip TEXT,
      last_heartbeat INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'online',
      metadata TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 9. 子代理派发记录 (Subagent Spawns)
    -- 一行 = 一次真实的 SubagentStart 事件。没有这行就不显示，绝不推测。
    -- 树形归属由 parent_agent_id 表达：一级子代理的父是空（父即会话本身），
    -- 嵌套子代理的父是派发它的那个子代理。会话级的父子关系不存在，也绝不臆造。
    CREATE TABLE IF NOT EXISTS agent_spawns (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default',
      host_id TEXT NOT NULL DEFAULT 'local',
      session_id TEXT NOT NULL,
      parent_agent_id TEXT,
      parent_session_id TEXT,
      agent_type TEXT,
      description TEXT,
      model TEXT,
      run_in_background INTEGER,
      spawn_depth INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_seen_at INTEGER,
      last_tool TEXT,
      last_action TEXT,
      last_target TEXT,
      stop_reason TEXT
    );

    -- 10. 跨机与跨会话工作交接簿 (PowerContext Work Handoffs)
    CREATE TABLE IF NOT EXISTS project_handoffs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default',
      source_host_id TEXT NOT NULL,
      source_agent_id TEXT NOT NULL,
      source_session_id TEXT,
      target_host_id TEXT,
      objective TEXT NOT NULL,
      state_summary TEXT NOT NULL,
      modified_files TEXT NOT NULL DEFAULT '[]',
      next_action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      consumed_by_agent_id TEXT,
      consumed_at INTEGER,
      metadata TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  migrateOldSchemaIfNeeded(db);

  db.exec(`
    INSERT OR IGNORE INTO projects (id, root_path, display_name, host_id, created_at, last_activity)
    VALUES ('default', '', 'Default Project', 'local', 0, 0);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_claims_project_type_target ON claims(project_id, claim_type, claim_target);
    CREATE INDEX IF NOT EXISTS idx_claims_intent_id ON claims(intent_id);
    CREATE INDEX IF NOT EXISTS idx_leases_project_expires ON leases(project_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_intents_proj_status ON intents(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_intents_agent_status ON intents(agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_agents_proj_heartbeat ON agents(project_id, last_heartbeat);
    CREATE INDEX IF NOT EXISTS idx_agents_host_status ON agents(host_id, status);
    CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_log(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_project_memories_proj_cat ON project_memories(project_id, category);
    CREATE INDEX IF NOT EXISTS idx_project_memories_proj_updated ON project_memories(project_id, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_memories_proj_cat_key ON project_memories(project_id, category, key);
    CREATE INDEX IF NOT EXISTS idx_cluster_nodes_status ON cluster_nodes(status, last_heartbeat);
    CREATE INDEX IF NOT EXISTS idx_project_handoffs_proj_status ON project_handoffs(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_project_handoffs_created ON project_handoffs(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_spawns_session ON agent_spawns(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_spawns_project ON agent_spawns(project_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_spawns_status ON agent_spawns(status, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_agent_spawns_parent ON agent_spawns(parent_agent_id);
  `);

  return db;
}

function migrateOldSchemaIfNeeded(db) {
  // 清理存量数据库中已退役的历史冗余表
  try {
    db.exec(`
      DROP TABLE IF EXISTS state;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS topology_nodes;
    `);
  } catch {}

  const tables = ['agents', 'intents', 'claims', 'leases', 'wait_queue', 'activity_log'];
  for (const table of tables) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default';`);
    } catch {}
  }

  try {
    db.exec(`ALTER TABLE projects ADD COLUMN host_id TEXT DEFAULT 'local';`);
  } catch {}
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN git_remote TEXT;`);
  } catch {}

  const agentColumns = [
    { name: 'host_id', type: "TEXT NOT NULL DEFAULT 'local'" },
    { name: 'current_intent', type: 'TEXT' },
    { name: 'pid', type: 'INTEGER' },
    { name: 'last_tool', type: 'TEXT' },
    { name: 'last_action', type: 'TEXT' },
    { name: 'last_target', type: 'TEXT' },
    { name: 'liveness_verified_at', type: 'INTEGER' },
  ];
  for (const col of agentColumns) {
    try {
      db.exec(`ALTER TABLE agents ADD COLUMN ${col.name} ${col.type};`);
    } catch {}
  }

  selfHealDatabase(db);
}

function selfHealDatabase(db) {
  try {
    const now = Date.now();

    try {
      db.prepare(`DELETE FROM wait_queue WHERE (? - created_at) > 300000`).run(now);
    } catch {}

    try {
      db.prepare(`
        UPDATE intents
        SET status = 'aborted', updated_at = ?
        WHERE status IN ('waiting', 'running') AND (? - updated_at) > 600000
      `).run(now, now);
    } catch {}

    const BAD_CHAR = '�';
    try {
      const badIntents = db.prepare(`
        SELECT id, summary, blocked_reason FROM intents
        WHERE instr(summary, ?) > 0 OR instr(blocked_reason, ?) > 0
      `).all(BAD_CHAR, BAD_CHAR);

      const updateIntent = db.prepare(`UPDATE intents SET summary = ?, blocked_reason = ?, updated_at = ? WHERE id = ?`);
      for (const row of badIntents) {
        let summary = row.summary || '';
        let blocked = row.blocked_reason || null;
        if (summary.includes(BAD_CHAR)) summary = 'Background Coordination Task';
        if (blocked && blocked.includes(BAD_CHAR)) {
          blocked = blocked.replace(/[^\x20-\x7E一-龥_.\-/:#\[\]\(\)'\"]/g, 'System Agent').replace(/\s+/g, ' ');
        }
        updateIntent.run(summary, blocked, now, row.id);
      }
    } catch {}

    try {
      const badLogs = db.prepare(`SELECT id, description FROM activity_log WHERE instr(description, ?) > 0`).all(BAD_CHAR);
      const updateLog = db.prepare(`UPDATE activity_log SET description = ? WHERE id = ?`);
      for (const log of badLogs) {
        const cleanDesc = log.description.replace(/[^\x20-\x7E一-龥_.\-/:#\[\]\(\)'\"]/g, 'System Agent').replace(/\s+/g, ' ');
        updateLog.run(cleanDesc, log.id);
      }
    } catch {}

    try {
      const staleAgents = db.prepare(`
        SELECT id, pid, last_heartbeat, liveness_verified_at FROM agents
        WHERE status IN ('running', 'waiting', 'idle') AND (? - last_heartbeat) > 120000
      `).all(now);

      const updateDeparted = db.prepare(`UPDATE agents SET status = 'departed' WHERE id = ?`);
      for (const a of staleAgents) {
        let isAlive = false;
        const heartbeatAge = now - (a.last_heartbeat || 0);
        const verified = (now - (a.liveness_verified_at || 0)) <= 120000;
        if (verified) {
          isAlive = true;
        } else if (a.pid && Number.isInteger(a.pid) && a.pid > 0 && heartbeatAge <= 600000) {
          try {
            process.kill(a.pid, 0);
            isAlive = true;
          } catch (e) {
            isAlive = (e.code === 'EPERM');
          }
        }
        if (!isAlive) {
          updateDeparted.run(a.id);
        }
      }
    } catch {}
  } catch {}
}
