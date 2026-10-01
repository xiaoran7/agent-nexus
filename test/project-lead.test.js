import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/storage/database.js';
import { CoordinatorEngine } from '../src/daemon/coordinator.js';
import { ProjectRegistry } from '../src/domain/project-registry.js';
import { handleMcpTool, ALL_NEXUS_TOOLS } from '../src/mcp/server.js';
import { StateService } from '../src/domain/state.js';
import { MessageService } from '../src/domain/messages.js';
import { EventEmitter } from 'node:events';

test('Project Lead 架构师调度与避障建议', async (t) => {
  let db, bus, coordinator, stateService, messageService, registry;

  t.beforeEach(() => {
    db = createDatabase(':memory:');
    bus = new EventEmitter();
    coordinator = new CoordinatorEngine(db, bus);
    stateService = new StateService(db, bus);
    messageService = new MessageService(db, bus);
    registry = new ProjectRegistry(db, coordinator, bus);
  });

  t.afterEach(() => {
    try { db.close(); } catch {}
  });

  await t.test('空闲项目进场：所有计划均判定为安全并发通道', async () => {
    const lead = registry.getOrCreateLead('proj-alpha');
    const result = await lead.onboard({
      agentId: 'worker-1',
      plannedWork: [
        { type: 'file', target: 'src/user.js' },
        { type: 'file', target: 'src/order.js' }
      ]
    });

    assert.equal(result.safeToStart.length, 2);
    assert.equal(result.mustWait.length, 0);
    assert.match(result.advice, /全部空闲/);
  });

  await t.test('存在并发冲突时：智能给出避障与优先施工指引', async () => {
    const lead = registry.getOrCreateLead('proj-alpha');

    // 假设 Session 1 已经先一步拿到了 user.js 的写租约
    coordinator.registerAgent({ id: 'worker-1', name: 'Worker 1', provider: 'claude', sessionId: 's1', projectId: 'proj-alpha' });
    coordinator.declareIntent({
      agentId: 'worker-1',
      intentSummary: 'Refactoring User Entity',
      claims: [{ type: 'file', target: 'src/user.js' }],
      ttlSeconds: 120,
      projectId: 'proj-alpha'
    });

    // 新进场的 Session 2 申报它想做的事：既要动 user.js，又要写 payment.js
    const result = await lead.onboard({
      agentId: 'worker-2',
      plannedWork: [
        { type: 'file', target: 'src/user.js' },
        { type: 'file', target: 'src/payment.js' }
      ]
    });

    assert.equal(result.safeToStart.length, 1);
    assert.equal(result.safeToStart[0].target, 'src/payment.js');

    assert.equal(result.mustWait.length, 1);
    assert.equal(result.mustWait[0].target, 'src/user.js');
    assert.equal(result.mustWait[0].blockedBy, 'worker-1');

    // 确认调度指引明确建议了先干什么、避开什么
    assert.match(result.advice, /避障重排建议/);
    assert.match(result.advice, /优先完成以下 1 个空闲资源/);
    assert.match(result.advice, /src\/payment\.js/);
  });

  await t.test('MCP 工具 nexus_onboard 端到端测试', async () => {
    const onboardTool = ALL_NEXUS_TOOLS.find(t => t.name === 'nexus_onboard');
    assert.ok(onboardTool);

    const mcpRes = await handleMcpTool('nexus_onboard', {
      agent_id: 'mcp-worker',
      project_id: 'proj-mcp',
      planned_work: [{ target: 'src/main.js' }]
    }, { coordinator, stateService, messageService, projectRegistry: registry });

    assert.equal(mcpRes.safeToStart.length, 1);
    assert.equal(mcpRes.mustWait.length, 0);
  });

  await t.test('MCP 工具 nexus_report_milestone 广播并联动释放资源', async () => {
    coordinator.registerAgent({ id: 'worker-m', name: 'Worker M', provider: 'claude', sessionId: 'sm', projectId: 'proj-mcp' });
    const dec = coordinator.declareIntent({
      agentId: 'worker-m',
      intentSummary: 'Editing task',
      claims: [{ type: 'file', target: 'src/done.js' }],
      projectId: 'proj-mcp'
    });

    const mcpRes = await handleMcpTool('nexus_report_milestone', {
      agent_id: 'worker-m',
      project_id: 'proj-mcp',
      description: 'Done with first milestone',
      lease_id_to_release: dec.leaseId
    }, { coordinator, stateService, messageService, projectRegistry: registry });

    assert.equal(mcpRes.success, true);
    assert.equal(mcpRes.released.success, true);
  });
});
