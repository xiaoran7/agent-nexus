import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEXUS_TOOLS } from '../src/mcp/server.js';
import { createHarness, capture } from './helpers.js';

test('共享状态与 CAS', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { stateService } = h;

  const changed = capture(h.eventBus, 'state:changed');
  t.after(() => changed.stop());

  await t.test('set 后可读回', () => {
    stateService.set('locks', 'playwright-port', '8080', 'agent-1', 60);

    const row = stateService.get('locks', 'playwright-port');
    assert.equal(row.value, '8080');
    assert.equal(row.updated_by, 'agent-1');
  });

  await t.test('CAS 期望值匹配时换值成功', () => {
    const res = stateService.compareAndSwap('locks', 'playwright-port', '8080', '8081', 'agent-2');

    assert.equal(res.swapped, true);
    assert.equal(stateService.get('locks', 'playwright-port').value, '8081');
  });

  await t.test('CAS 期望值过期时不改动并回报当前值', () => {
    const res = stateService.compareAndSwap('locks', 'playwright-port', '8080', '9999', 'agent-3');

    assert.equal(res.swapped, false);
    assert.equal(res.current.value, '8081', '失败时应回报真实当前值');
    assert.equal(stateService.get('locks', 'playwright-port').value, '8081', '值不应被覆盖');
  });

  await t.test('按命名空间隔离', () => {
    stateService.set('other', 'playwright-port', '7000', 'agent-4');

    assert.equal(stateService.get('other', 'playwright-port').value, '7000');
    assert.equal(stateService.get('locks', 'playwright-port').value, '8081');
  });

  await t.test('每次写入广播 state:changed', () => {
    // 三次写入：初始 set、CAS 换值、命名空间隔离用的 set。
    assert.equal(changed.events.length, 3, '三次 set 各广播一次');
  });
});

test('消息总线', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, messageService } = h;

  coordinator.registerAgent({ id: 'codex-1', name: 'Codex 1', provider: 'codex', sessionId: 's1' });
  coordinator.registerAgent({ id: 'claude-2', name: 'Claude 2', provider: 'claude', sessionId: 's2' });

  const sent = capture(h.eventBus, 'message:sent');
  t.after(() => sent.stop());

  await t.test('定向消息只进收件人信箱', () => {
    messageService.send({
      from: 'codex-1',
      to: 'claude-2',
      content: 'InteractionResolver refactoring completed. Please rebase.',
      importance: 'urgent'
    });

    const inbox = messageService.inbox('claude-2');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].importance, 'urgent');
    assert.equal(inbox[0].from_agent, 'codex-1');
    assert.equal(inbox[0].content, 'InteractionResolver refactoring completed. Please rebase.');

    assert.equal(messageService.inbox('codex-1').length, 0, '发件人自己不应收到定向消息');
  });

  await t.test('广播消息对所有 agent 可见', () => {
    messageService.send({ from: 'codex-1', content: 'Rebasing window opens in 5 minutes.' });

    assert.equal(messageService.inbox('claude-2').length, 2, '收件人应看到定向 + 广播');
    assert.equal(messageService.inbox('codex-1').length, 1, '广播应回到发件人');
  });

  await t.test('发送广播 message:sent', () => {
    assert.equal(sent.events.length, 2);
  });
});

test('MCP 工具定义与分发', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { mcp, coordinator } = h;

  await t.test('暴露 5 个工具，声明 schema 完整', () => {
    assert.equal(NEXUS_TOOLS.length, 5);

    const declare = NEXUS_TOOLS.find((tool) => tool.name === 'nexus_declare_intent');
    assert.ok(declare, '应有 nexus_declare_intent');
    assert.deepEqual(declare.inputSchema.required, ['agent_id', 'summary', 'claims']);
    assert.deepEqual(
      declare.inputSchema.properties.claims.items.properties.type.enum,
      ['file', 'module', 'symbol'],
      'claim 类型枚举应覆盖三级资源'
    );
  });

  await t.test('nexus_declare_intent 授予租约', () => {
    const res = mcp('nexus_declare_intent', {
      agent_id: 'claude-mcp',
      summary: 'Testing via MCP tool',
      claims: [{ type: 'symbol', target: 'doAnalysis' }]
    });

    assert.equal(res.status, 'GRANTED');
    assert.ok(res.leaseId);
    assert.ok(coordinator.getAgent('claude-mcp'), '未注册 agent 应被自动补注册');
  });

  await t.test('nexus_status 返回协调总览', () => {
    const res = mcp('nexus_status', {});

    assert.ok(Array.isArray(res.agents));
    assert.ok(res.agents.length >= 1);
    assert.ok(Array.isArray(res.activeClaims));
    assert.ok(Array.isArray(res.timeline));
  });

  await t.test('nexus_state 走同一套共享状态', () => {
    mcp('nexus_state', { action: 'set', namespace: 'locks', key: 'port', value: '4100' });

    const res = mcp('nexus_state', { action: 'get', namespace: 'locks', key: 'port' });
    assert.equal(res.value, '4100');
  });

  await t.test('未知工具抛错而不是静默返回', () => {
    assert.throws(() => mcp('nexus_not_a_tool', {}), /Unknown Nexus MCP tool/);
  });
});

test('三级冲突判定与等待唤醒', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, eventBus } = h;

  coordinator.registerAgent({ id: 'a1', name: 'Agent 1', provider: 'codex', sessionId: 's1' });
  coordinator.registerAgent({ id: 'a2', name: 'Agent 2', provider: 'claude', sessionId: 's2' });

  await t.test('模块声明先到者拿到租约', () => {
    const res = coordinator.declareIntent({
      agentId: 'a1',
      intentSummary: 'Refactoring network module',
      claims: [{ type: 'module', target: 'src/network' }]
    });

    assert.equal(res.status, 'GRANTED');
  });

  await t.test('模块下的文件声明被层级规则挡住', () => {
    const res = coordinator.declareIntent({
      agentId: 'a2',
      intentSummary: 'Adding retry to http client',
      claims: [{ type: 'file', target: 'src/network/client.ts' }]
    });

    assert.equal(res.status, 'WAITING');
    assert.equal(res.blockedBy, 'a1');
    assert.match(res.reason, /Module conflict/);
  });

  await t.test('同路径不同大小写仍判为冲突', () => {
    const res = coordinator.declareIntent({
      agentId: 'a2',
      intentSummary: 'Touching the same file with different casing',
      claims: [{ type: 'file', target: 'src/network/CLIENT.ts' }]
    });

    assert.equal(res.status, 'WAITING', '路径归一化后应与已有声明冲突');
  });

  await t.test('无关文件不冲突', () => {
    const res = coordinator.declareIntent({
      agentId: 'a2',
      intentSummary: 'Editing an unrelated file',
      claims: [{ type: 'file', target: 'src/ui/Panel.tsx' }]
    });

    assert.equal(res.status, 'GRANTED');
  });

  await t.test('释放租约只唤醒队首等待者', () => {
    const woken = capture(eventBus, 'agent:woken');
    t.after(() => woken.stop());

    const before = h.db.prepare('SELECT count(*) AS n FROM wait_queue').get().n;
    assert.ok(before >= 2, `等待队列应至少有 2 项，实际 ${before}`);

    const res = coordinator.releaseLease(
      coordinator.db.prepare("SELECT id FROM leases WHERE agent_id = 'a1'").get().id,
      'a1'
    );

    assert.equal(res.success, true);
    assert.equal(woken.events.length, 1, '一次释放只唤醒一个等待者');
    assert.equal(woken.events[0].agent_id, 'a2');
  });

  await t.test('释放后原路径可再被占用', () => {
    const res = coordinator.declareIntent({
      agentId: 'a1',
      intentSummary: 'Re-entering the freed module',
      claims: [{ type: 'file', target: 'src/network/client.ts' }]
    });

    assert.equal(res.status, 'GRANTED');
  });
});
