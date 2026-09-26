import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { CoordinatorEngine } from '../src/daemon/coordinator.js';

function runTests() {
  console.log('--- Starting Agent-Nexus Core & Hook Conflict Scenarios Test ---');

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, session_id TEXT NOT NULL, workspace_dir TEXT, status TEXT NOT NULL DEFAULT 'idle', last_heartbeat INTEGER NOT NULL, registered_at INTEGER NOT NULL);
    CREATE TABLE intents (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), summary TEXT NOT NULL, status TEXT NOT NULL, blocked_by_agent_id TEXT REFERENCES agents(id), blocked_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE claims (id INTEGER PRIMARY KEY AUTOINCREMENT, intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id), claim_type TEXT NOT NULL, claim_target TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE leases (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE REFERENCES intents(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id), ttl_seconds INTEGER NOT NULL DEFAULT 300, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE wait_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, intent_id TEXT NOT NULL UNIQUE REFERENCES intents(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id), created_at INTEGER NOT NULL);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, event_type TEXT NOT NULL, target TEXT, description TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);

  const eventBus = new EventEmitter();
  let wokenEvents = [];
  eventBus.on('agent:woken', (e) => wokenEvents.push(e));

  const engine = new CoordinatorEngine(db, eventBus);

  // 1. 注册 Agent A (Codex) 和 Agent B (Claude)
  console.log('1. Registering Codex-1 and Claude-2...');
  engine.registerAgent({
    id: 'codex-sess_01',
    name: '重构 InteractionResolver',
    provider: 'codex',
    sessionId: 'sess_01'
  });
  engine.registerAgent({
    id: 'claude-sess_02',
    name: '视觉点击兜底',
    provider: 'claude',
    sessionId: 'sess_02'
  });

  // 2. Agent A 报备 Intent 并索取 InteractionResolver.kt
  console.log('2. Agent A declares intent on InteractionResolver.kt...');
  const resA = engine.declareIntent({
    agentId: 'codex-sess_01',
    intentSummary: '重构 InteractionResolver 的点击候选生成逻辑',
    claims: [
      { type: 'file', target: 'app/src/InteractionResolver.kt' },
      { type: 'symbol', target: 'buildClickCandidates' }
    ],
    ttlSeconds: 300
  });
  assert.strictEqual(resA.status, 'GRANTED', 'Agent A should be GRANTED');
  console.log(' -> Agent A GRANTED lease:', resA.leaseId);

  // 3. Agent B 报备冲突的 Intent
  console.log('3. Agent B declares intent on InteractionResolver.kt...');
  const resB = engine.declareIntent({
    agentId: 'claude-sess_02',
    intentSummary: '给 InteractionResolver 增加视觉点击兜底',
    claims: [
      { type: 'file', target: 'app/src/InteractionResolver.kt' }
    ]
  });
  assert.strictEqual(resB.status, 'WAITING', 'Agent B should be WAITING');
  assert.strictEqual(resB.blockedBy, 'codex-sess_01', 'Agent B should be blocked by Codex-1');
  console.log(' -> Agent B BLOCKED & WAITING. Reason:', resB.reason);

  // 4. 测试微观 Hook 通道: Agent B 试图偷偷写入 InteractionResolver.kt
  console.log('4. Testing Universal Hook interception for Agent B...');
  const hookCheck = engine.fastCheckAndAutoClaim({
    agentId: 'claude-sess_02',
    provider: 'claude',
    sessionId: 'sess_02',
    filePath: 'app/src/InteractionResolver.kt'
  });
  assert.strictEqual(hookCheck.allow, false, 'Hook must reject write to locked file');
  console.log(' -> Hook successfully intercepted & rejected write. Error message:', hookCheck.reason);

  // 5. Agent A 完成任务并释放 Lease
  console.log('5. Agent A completes work and releases lease...');
  const releaseRes = engine.releaseLease(resA.leaseId, 'codex-sess_01');
  assert.strictEqual(releaseRes.success, true, 'Lease release should succeed');
  assert.strictEqual(wokenEvents.length, 1, 'Agent B should receive wake-up event');
  console.log(' -> Lease released, Waiter woken up:', wokenEvents[0]);

  // 6. Agent B 被唤醒后重新检查判冲
  console.log('6. Agent B re-evaluates intent after wake-up...');
  const resBRetry = engine.declareIntent({
    agentId: 'claude-sess_02',
    intentSummary: '给 InteractionResolver 增加视觉点击兜底',
    claims: [
      { type: 'file', target: 'app/src/InteractionResolver.kt' }
    ]
  });
  assert.strictEqual(resBRetry.status, 'GRANTED', 'Agent B should now be GRANTED');
  console.log(' -> Agent B GRANTED lease:', resBRetry.leaseId);

  // 7. 检查 Dashboard 快照数据
  console.log('7. Verifying Dashboard Snapshot...');
  const snapshot = engine.getDashboardSnapshot();
  assert.strictEqual(snapshot.agents.length, 2);
  assert(snapshot.timeline.length >= 4);
  console.log(' -> Dashboard Snapshot valid. Total timeline events:', snapshot.timeline.length);

  console.log('\n✅ ALL AGENT-NEXUS SCENARIOS PASSED SUCCESSFULLY!');
}

runTests();
