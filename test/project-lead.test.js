import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/storage/database.js';
import { CoordinatorEngine } from '../src/daemon/coordinator.js';
import { ProjectRegistry } from '../src/domain/project-registry.js';
import { ProjectLead } from '../src/domain/project-lead.js';
import { handleMcpTool, ALL_NEXUS_TOOLS } from '../src/mcp/server.js';
import { StateService } from '../src/domain/state.js';
import { MessageService } from '../src/domain/messages.js';
import { EventEmitter } from 'node:events';

class MockLlmAdapter {
  constructor(responseHandler) {
    this.responseHandler = responseHandler;
    this.calls = [];
  }

  async chat(systemPrompt, userMessage) {
    this.calls.push({ systemPrompt, userMessage });
    if (typeof this.responseHandler === 'function') {
      return this.responseHandler(systemPrompt, userMessage);
    }
    return this.responseHandler;
  }
}

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
    assert.equal(result.adviceSource, 'deterministic');
    assert.ok(result.deterministicAdvice);
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
    assert.equal(result.adviceSource, 'deterministic');

    // 确认调度指引明确建议了先干什么、避开什么
    assert.match(result.advice, /避障重排建议/);
    assert.match(result.advice, /优先完成以下 1 个空闲资源/);
    assert.match(result.advice, /src\/payment\.js/);
  });

  await t.test('AI 常驻架构师增强建议：成功生成语义指引且不破坏确定性安全', async () => {
    const mockAdapter = new MockLlmAdapter({
      content: '【Tech Lead 架构指引】优先实现 payment.js 模块，针对被锁的 user.js 先定义 UserContract 接口隔离。'
    });

    const lead = new ProjectLead('proj-ai', coordinator, bus, mockAdapter);

    coordinator.registerAgent({ id: 'worker-1', name: 'Worker 1', provider: 'claude', sessionId: 's1', projectId: 'proj-ai' });
    coordinator.declareIntent({
      agentId: 'worker-1',
      intentSummary: 'User update',
      claims: [{ type: 'file', target: 'src/user.js' }],
      projectId: 'proj-ai'
    });

    const result = await lead.onboard({
      agentId: 'worker-2',
      plannedWork: [
        { type: 'file', target: 'src/user.js' },
        { type: 'file', target: 'src/payment.js' }
      ]
    });

    // 1. 确定性冲突矩阵绝对不可变
    assert.equal(result.safeToStart.length, 1);
    assert.equal(result.safeToStart[0].target, 'src/payment.js');
    assert.equal(result.mustWait.length, 1);
    assert.equal(result.mustWait[0].target, 'src/user.js');

    // 2. 建议来源于 AI，且完整保留确定性基线建议
    assert.equal(result.adviceSource, 'llm');
    assert.equal(result.advice, '【Tech Lead 架构指引】优先实现 payment.js 模块，针对被锁的 user.js 先定义 UserContract 接口隔离。');
    assert.match(result.deterministicAdvice, /避障重排建议/);

    // 3. 验证 prompt 构造内容
    assert.equal(mockAdapter.calls.length, 1);
    assert.match(mockAdapter.calls[0].systemPrompt, /AI Tech Lead/);
    assert.match(mockAdapter.calls[0].userMessage, /src\/payment\.js/);
    assert.match(mockAdapter.calls[0].userMessage, /src\/user\.js/);
  });

  await t.test('AI 适配器异常或返回空时：透明降级为确定性建议', async () => {
    const errorAdapter = new MockLlmAdapter(async () => {
      throw new Error('Network timeout');
    });

    const lead = new ProjectLead('proj-fallback', coordinator, bus, errorAdapter);
    coordinator.registerAgent({ id: 'worker-1', name: 'Worker 1', provider: 'claude', sessionId: 's1', projectId: 'proj-fallback' });
    coordinator.declareIntent({
      agentId: 'worker-1',
      intentSummary: 'User lock',
      claims: [{ type: 'file', target: 'src/user.js' }],
      projectId: 'proj-fallback'
    });

    const result = await lead.advisePlan({
      agentId: 'worker-2',
      plannedWork: [
        { type: 'file', target: 'src/user.js' },
        { type: 'file', target: 'src/other.js' }
      ]
    });

    assert.equal(result.safeToStart.length, 1);
    assert.equal(result.mustWait.length, 1);
    assert.equal(result.adviceSource, 'deterministic');
    assert.match(result.advice, /避障重排建议/);
    assert.equal(result.advice, result.deterministicAdvice);
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
    assert.equal(mcpRes.adviceSource, 'deterministic');
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
