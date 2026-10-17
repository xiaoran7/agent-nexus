import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, startTestDaemon } from './helpers.js';

test('进程存活监测与提前回收机制 (Process Liveness & Early Lease Reclamation)', async (t) => {
  const harness = createHarness();
  const { coordinator, db, close } = harness;

  t.after(() => {
    close();
  });

  await t.test('registerAgent 支持记录 pid 并平滑更新', () => {
    const agent = coordinator.registerAgent({
      id: 'agent-proc-1',
      name: 'Agent Process 1',
      provider: 'claude',
      sessionId: 'sess-1',
      pid: 12345
    });

    assert.equal(agent.id, 'agent-proc-1');
    assert.equal(agent.pid, 12345);

    // 再次心跳续期，pid 保持原值
    const refreshed = coordinator.registerAgent({
      id: 'agent-proc-1',
      name: 'Agent Process 1 Updated',
      provider: 'claude',
      sessionId: 'sess-1'
    });
    assert.equal(refreshed.pid, 12345);

    // 显式更新 pid
    const updated = coordinator.registerAgent({
      id: 'agent-proc-1',
      name: 'Agent Process 1 Re-pid',
      provider: 'claude',
      sessionId: 'sess-1',
      pid: 67890
    });
    assert.equal(updated.pid, 67890);
  });

  await t.test('reapDeadAgentLeases 自动监测不存在的死亡进程 (ESRCH) 并提前回收租约唤醒排队者', () => {
    // 构造一个确定不存在的死进程 PID (例如 99999999)
    const deadPid = 99999999;
    try {
      process.kill(deadPid, 0);
      assert.fail('PID 99999999 should not exist in test runtime');
    } catch (e) {
      assert.equal(e.code, 'ESRCH');
    }

    // 注册持有者 Agent，并声明一个 300s 的长租约
    coordinator.registerAgent({
      id: 'agent-dead-holder',
      name: 'Dead Holder',
      provider: 'claude',
      sessionId: 'dead-sess',
      pid: process.pid, // 先用活 PID 正常获取锁
      projectId: 'proj-reap'
    });

    const grantRes = coordinator.declareIntent({
      agentId: 'agent-dead-holder',
      intentSummary: 'Editing critical module before crash',
      claims: [{ type: 'file', target: 'src/critical.js' }],
      ttlSeconds: 300,
      projectId: 'proj-reap'
    });
    assert.equal(grantRes.status, 'GRANTED');
    assert.ok(grantRes.leaseId);

    // 注册等待者 Agent，并发访问同一文件并进入等待队列
    coordinator.registerAgent({
      id: 'agent-waiter',
      name: 'Waiter Session',
      provider: 'codex',
      sessionId: 'waiter-sess',
      pid: process.pid, // 当前测试运行的存活进程
      projectId: 'proj-reap'
    });

    const waitRes = coordinator.declareIntent({
      agentId: 'agent-waiter',
      intentSummary: 'Waiter wants critical.js',
      claims: [{ type: 'file', target: 'src/critical.js' }],
      ttlSeconds: 300,
      projectId: 'proj-reap'
    });
    assert.equal(waitRes.status, 'WAITING');
    assert.equal(waitRes.blockedBy, 'agent-dead-holder');

    // 模拟持有者进程突然退出/崩溃（更新其 pid 为已死亡的 deadPid）
    coordinator.registerAgent({
      id: 'agent-dead-holder',
      name: 'Dead Holder',
      provider: 'claude',
      sessionId: 'dead-sess',
      pid: deadPid,
      projectId: 'proj-reap'
    });

    // 核实等待队列确实有 1 个排队者
    const waitQueueBefore = coordinator.getWaitQueue('proj-reap');
    assert.equal(waitQueueBefore.length, 1);

    // 触发存活探测与提前回收
    const reapResult = coordinator.reapDeadAgentLeases();
    assert.equal(reapResult.reapedCount, 1);
    assert.equal(reapResult.deadAgents.length, 1);
    assert.equal(reapResult.deadAgents[0].agentId, 'agent-dead-holder');
    assert.equal(reapResult.deadAgents[0].pid, deadPid);

    // 核实死掉的 Agent 状态已被置为 departed
    const deadAgentRow = coordinator.getAgent('agent-dead-holder');
    assert.equal(deadAgentRow.status, 'departed');

    // 核实租约已被提前安全回收，且排队者已被成功出队唤醒
    const waitQueueAfter = coordinator.getWaitQueue('proj-reap');
    assert.equal(waitQueueAfter.length, 0);

    // 等待者此时重新声明意图，应立即畅通无阻获得独占锁
    const grantAfterReap = coordinator.declareIntent({
      agentId: 'agent-waiter',
      intentSummary: 'Waiter retry after reap',
      claims: [{ type: 'file', target: 'src/critical.js' }],
      ttlSeconds: 300,
      projectId: 'proj-reap'
    });
    assert.equal(grantAfterReap.status, 'GRANTED');
  });

  await t.test('reapDeadAgentLeases 不会误伤当前存活进程持有的租约', () => {
    coordinator.registerAgent({
      id: 'agent-alive-holder',
      name: 'Alive Holder',
      provider: 'claude',
      sessionId: 'alive-sess',
      pid: process.pid, // 当前 Node.js 进程真实存活
      projectId: 'proj-alive'
    });

    const res = coordinator.declareIntent({
      agentId: 'agent-alive-holder',
      intentSummary: 'Holding lock while alive',
      claims: [{ type: 'file', target: 'src/alive.js' }],
      ttlSeconds: 300,
      projectId: 'proj-alive'
    });
    assert.equal(res.status, 'GRANTED');

    const reapResult = coordinator.reapDeadAgentLeases();
    assert.equal(reapResult.reapedCount, 0);

    const agentRow = coordinator.getAgent('agent-alive-holder');
    assert.equal(agentRow.status, 'running');
  });
});

test('HTTP 端点 /api/hook/check 支持传递 pid 并在检测到死进程时无缝提前释放', async (t) => {
  const daemon = await startTestDaemon();
  t.after(async () => {
    await daemon.close();
  });

  const deadPid = 99999998;

  // 1. 模拟一个死进程持锁
  daemon.coordinator.registerAgent({
    id: 'agent-crashed-holder',
    name: 'Crashed Agent',
    provider: 'claude',
    sessionId: 's-crash',
    pid: deadPid,
    projectId: 'proj-http-reap'
  });

  daemon.coordinator.declareIntent({
    agentId: 'agent-crashed-holder',
    intentSummary: 'Crashed session hold',
    claims: [{ type: 'file', target: 'src/shared.js' }],
    ttlSeconds: 300,
    projectId: 'proj-http-reap'
  });

  // 2. 新 Session 发起 Hook 快速检查，携带存活的 process.pid
  const checkRes = await daemon.request('/api/hook/check', {
    method: 'POST',
    body: {
      agent_id: 'agent-new-session',
      provider: 'claude',
      session_id: 's-new',
      file_path: 'src/shared.js',
      project_id: 'proj-http-reap',
      pid: process.pid
    }
  });

  assert.equal(checkRes.status, 200);
  const data = checkRes.json;
  // 因为 reapDeadAgentLeases 在 fastCheckAndAutoClaim 中自动前置回收死锁，
  // 新 Session 不必等待 300s TTL，直接无缝放行并自动取得独占租约！
  assert.equal(data.allow, true);
  assert.equal(data.autoClaimed, true);
  assert.ok(data.leaseId);
});
