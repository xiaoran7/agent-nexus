import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/storage/database.js';
import { CoordinatorEngine } from '../src/daemon/coordinator.js';
import { ProjectRegistry } from '../src/domain/project-registry.js';
import { LEAD_STATES } from '../src/domain/project-lead.js';
import { EventEmitter } from 'node:events';

test('Project Lead 架构师非侵入静默与多 Session 唤醒机制', async (t) => {
  let db, bus, coordinator, registry, lead;
  const events = [];

  t.beforeEach(() => {
    db = createDatabase(':memory:');
    bus = new EventEmitter();
    events.length = 0;
    bus.on('lead:awakened', (e) => events.push(e));

    coordinator = new CoordinatorEngine(db, bus);
    registry = new ProjectRegistry(db, coordinator, bus);
    lead = registry.getOrCreateLead('test-proj');
  });

  t.afterEach(() => {
    try { db.close(); } catch {}
  });

  await t.test('场景 1: 单 Session (worker-1) 独立施工时，架构师静默保驾 (OBSERVING)', async () => {
    // Session 1 进场
    coordinator.registerAgent({
      id: 'worker-1',
      name: 'Worker 1 (Database Refactor)',
      provider: 'claude',
      sessionId: 's1',
      projectId: 'test-proj'
    });

    const result = await lead.onboard({
      agentId: 'worker-1',
      plannedWork: [
        { type: 'file', target: 'src/db.js' },
        { type: 'file', target: 'src/models.js' }
      ]
    });

    // 状态判定：只有单会话，无并发竞争，架构师保持静默
    assert.equal(lead.state, LEAD_STATES.OBSERVING);
    assert.equal(result.leadState, LEAD_STATES.OBSERVING);
    assert.equal(result.safeToStart.length, 2);
    assert.equal(result.mustWait.length, 0);
    assert.equal(events.length, 0, '单 Session 进场不应触发 lead:awakened 广播');
    assert.match(result.advice, /架构师静默保驾/);
    assert.match(result.advice, /无其他并发 Session/);
  });

  await t.test('场景 2: worker-1 施工中，申报意图、上锁、汇报里程碑与进度画像', async () => {
    coordinator.registerAgent({
      id: 'worker-1',
      name: 'Worker 1',
      provider: 'claude',
      sessionId: 's1',
      projectId: 'test-proj'
    });

    // 锁定 src/db.js
    const grant = coordinator.declareIntent({
      agentId: 'worker-1',
      intentSummary: '重构数据库连接池与迁移脚本',
      claims: [{ type: 'file', target: 'src/db.js' }],
      ttlSeconds: 180,
      projectId: 'test-proj'
    });
    assert.equal(grant.status, 'GRANTED');

    // 汇报达成阶段里程碑
    lead.reportMilestone({
      agentId: 'worker-1',
      description: '已完成 SQLite WAL 模式与基础表迁移'
    });

    // 验证 progress_summary 已正确写入 agents 表
    const agentRow = db.prepare('SELECT current_intent, progress_summary FROM agents WHERE id = ?').get('worker-1');
    assert.equal(agentRow.progress_summary, '已完成 SQLite WAL 模式与基础表迁移');
  });

  await t.test('场景 3: worker-1 尚未完工，新 Session (worker-2) 进场，架构师被实时唤醒 (AWAKENED) 并给出重排建议', async () => {
    // 准备在席施工的 Session 1 现场
    coordinator.registerAgent({
      id: 'worker-1',
      name: 'Worker 1 (Database)',
      provider: 'claude',
      sessionId: 's1',
      projectId: 'test-proj'
    });
    coordinator.declareIntent({
      agentId: 'worker-1',
      intentSummary: '重构数据模型与连接池',
      claims: [{ type: 'file', target: 'src/db.js' }],
      ttlSeconds: 180,
      projectId: 'test-proj'
    });
    lead.reportMilestone({
      agentId: 'worker-1',
      description: '已跑通数据模型单元测试'
    });

    // Session 2 进场：想改动 src/db.js (与 A 冲突)，同时想改动 src/api.js (独立空闲)
    coordinator.registerAgent({
      id: 'worker-2',
      name: 'Worker 2 (API Gateway)',
      provider: 'claude',
      sessionId: 's2',
      projectId: 'test-proj'
    });

    const onboardResult = await lead.onboard({
      agentId: 'worker-2',
      plannedWork: [
        { type: 'file', target: 'src/db.js' },
        { type: 'file', target: 'src/api.js' }
      ]
    });

    // 1. 验证架构师被成功唤醒
    assert.equal(lead.state, LEAD_STATES.AWAKENED);
    assert.equal(onboardResult.leadState, LEAD_STATES.AWAKENED);
    assert.equal(events.length, 1, '必须触发 lead:awakened 事件');
    assert.equal(events[0].joining_agent_id, 'worker-2');
    assert.equal(events[0].active_peer_count, 1);
    assert.equal(events[0].conflicts_count, 1);

    // 2. 验证 peer_sessions 准确聚合了 Worker 1 的施工进度 (A 已经干了多少)
    assert.ok(onboardResult.peerSessions.length >= 1);
    const peerA = onboardResult.peerSessions.find(p => p.agentId === 'worker-1');
    assert.ok(peerA);
    assert.equal(peerA.name, 'Worker 1 (Database)');
    assert.equal(peerA.progressSummary, '已跑通数据模型单元测试');
    assert.ok(peerA.heldClaims.some(c => c.target.includes('src/db.js')));

    // 3. 验证确定性冲突判定与路线重排
    assert.equal(onboardResult.safeToStart.length, 1);
    assert.equal(onboardResult.safeToStart[0].target, 'src/api.js');
    assert.equal(onboardResult.mustWait.length, 1);
    assert.equal(onboardResult.mustWait[0].target, 'src/db.js');
    assert.equal(onboardResult.mustWait[0].blockedBy, 'worker-1');

    // 4. 验证建议包含 A 干了多少与避障重排
    assert.match(onboardResult.advice, /架构师唤醒指引/);
    assert.match(onboardResult.advice, /在席 Session 施工实况/);
    assert.match(onboardResult.advice, /Worker 1/);
    assert.match(onboardResult.advice, /已跑通数据模型单元测试/);
    assert.match(onboardResult.advice, /src\/api\.js/);
  });
});
