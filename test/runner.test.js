import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, capture } from './helpers.js';

// 这组用例覆盖一条完整的协调链路：两个 agent 争夺同一文件，冲突方进入等待，
// 持有方释放租约后等待方被唤醒并成功拿到租约。
test('文件冲突：租约、Hook 拦截、释放、唤醒、二次声明', async (t) => {
  const h = createHarness();
  t.after(() => h.close());

  const { coordinator, eventBus } = h;
  const woken = capture(eventBus, 'agent:woken');
  t.after(() => woken.stop());

  await t.test('注册两个 agent', () => {
    coordinator.registerAgent({
      id: 'codex-sess_01',
      name: '重构 InteractionResolver',
      provider: 'codex',
      sessionId: 'sess_01'
    });
    coordinator.registerAgent({
      id: 'claude-sess_02',
      name: '视觉点击兜底',
      provider: 'claude',
      sessionId: 'sess_02'
    });

    assert.equal(coordinator.getAgent('codex-sess_01').provider, 'codex');
    assert.equal(coordinator.getAgent('claude-sess_02').provider, 'claude');
  });

  const claims = [{ type: 'file', target: 'app/src/InteractionResolver.kt' }];
  let leaseA;

  await t.test('先到者拿到租约', () => {
    const res = coordinator.declareIntent({
      agentId: 'codex-sess_01',
      intentSummary: '重构 InteractionResolver 的点击候选生成逻辑',
      claims: [...claims, { type: 'symbol', target: 'buildClickCandidates' }],
      ttlSeconds: 300
    });

    assert.equal(res.status, 'GRANTED');
    assert.ok(res.leaseId, '应颁发 leaseId');
    leaseA = res.leaseId;
  });

  await t.test('后到者被判 WAITING 并指明被谁挡住', () => {
    const res = coordinator.declareIntent({
      agentId: 'claude-sess_02',
      intentSummary: '给 InteractionResolver 增加视觉点击兜底',
      claims
    });

    assert.equal(res.status, 'WAITING');
    assert.equal(res.blockedBy, 'codex-sess_01');
    assert.equal(res.blockedByName, '重构 InteractionResolver');
    assert.match(res.reason, /File conflict/);
    assert.equal(res.leaseId, undefined, '被挡下时不应发租约');
  });

  await t.test('Hook 通道硬拦截对被锁文件的写入', () => {
    const check = coordinator.fastCheckAndAutoClaim({
      agentId: 'claude-sess_02',
      provider: 'claude',
      sessionId: 'sess_02',
      filePath: 'app/src/InteractionResolver.kt'
    });

    assert.equal(check.allow, false);
    assert.equal(check.holder, '重构 InteractionResolver');
    assert.match(check.reason, /BLOCKED/);
  });

  await t.test('持有者释放租约并唤醒唯一等待者', () => {
    const res = coordinator.releaseLease(leaseA, 'codex-sess_01');

    assert.equal(res.success, true);
    assert.equal(res.releasedLeaseId, leaseA);
    assert.equal(woken.events.length, 1, '应恰好唤醒一个等待者');
    assert.equal(woken.events[0].agent_id, 'claude-sess_02');
  });

  await t.test('被唤醒方重新声明后拿到租约', () => {
    const res = coordinator.declareIntent({
      agentId: 'claude-sess_02',
      intentSummary: '给 InteractionResolver 增加视觉点击兜底',
      claims
    });

    assert.equal(res.status, 'GRANTED');
    assert.ok(res.leaseId);
  });

  await t.test('面板快照反映两个 agent 与完整时间线', () => {
    const snapshot = coordinator.getDashboardSnapshot();

    assert.equal(snapshot.agents.length, 2);
    assert.ok(snapshot.timeline.length >= 4, `时间线事件偏少: ${snapshot.timeline.length}`);
    assert.ok(
      snapshot.timeline.some((e) => e.event_type === 'lease:released'),
      '时间线应包含租约释放事件'
    );
    assert.ok(
      snapshot.timeline.some((e) => e.event_type === 'hook:blocked'),
      '时间线应包含 Hook 拦截事件'
    );
  });
});
