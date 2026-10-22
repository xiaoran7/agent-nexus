// =============================================================================
// test/lease-policy.test.js
// 覆盖并发实测暴露出的租约生命周期缺陷：
//   1. 命名资源锁 TTL 短于真实命令时长，命令还在跑锁就被回收
//   2. 文件租约在“只读思考”阶段没有续约来源，到期即被他人抢占
//   3. 600s 硬顶让长任务必然掉锁重抢
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.js';
import { LEASE_POLICY } from '../src/daemon/coordinator.js';

const leaseRow = (db, leaseId) =>
  db.prepare('SELECT ttl_seconds, expires_at, created_at FROM leases WHERE id = ?').get(leaseId);

test('租约生命周期策略：资源锁覆盖命令时长，文件锁覆盖阅读间隔', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, db } = h;
  const projectId = 'proj-policy';

  coordinator.registerAgent({ id: 'agent-a', name: 'Agent A', provider: 'claude', sessionId: 'sa', projectId });
  coordinator.registerAgent({ id: 'agent-b', name: 'Agent B', provider: 'claude', sessionId: 'sb', projectId });

  await t.test('tests 资源锁 TTL 不短于一次完整测试运行', () => {
    const res = coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-a',
      provider: 'claude',
      sessionId: 'sa',
      resourceName: 'tests',
      projectId
    });

    assert.equal(res.allow, true);
    assert.equal(res.autoClaimed, true);

    const lease = leaseRow(db, res.leaseId);
    assert.equal(lease.ttl_seconds, LEASE_POLICY.resourceTtlSeconds);
    assert.ok(lease.ttl_seconds >= 300, `资源锁 TTL 过短: ${lease.ttl_seconds}s，长命令会在运行中被夺锁`);
  });

  await t.test('命令运行中锁不会自然到期：过期时间显著晚于一次测试的平均时长', () => {
    const lease = db
      .prepare("SELECT l.* FROM leases l JOIN claims c ON c.intent_id = l.intent_id WHERE c.claim_target = 'tests'")
      .get();
    const lifetimeSec = (lease.expires_at - lease.created_at) / 1000;
    assert.ok(lifetimeSec >= 300, `tests 锁生命周期仅 ${lifetimeSec}s`);
  });

  await t.test('另一个会话在锁有效期内被稳定拦截，不会因 TTL 提前放行', () => {
    const blocked = coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-b',
      provider: 'claude',
      sessionId: 'sb',
      resourceName: 'tests',
      projectId
    });
    assert.equal(blocked.allow, false);
    assert.equal(blocked.holder, 'Agent A');
    assert.ok(blocked.remainingSec > 240, `剩余时间 ${blocked.remainingSec}s，说明锁已接近过期`);
  });

  await t.test('PostToolUse 释放后等待者立刻可获取（TTL 只作崩溃兜底）', () => {
    coordinator.releaseResourceLock({ agentId: 'agent-a', resourceName: 'tests', projectId });

    const got = coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-b',
      provider: 'claude',
      sessionId: 'sb',
      resourceName: 'tests',
      projectId
    });
    assert.equal(got.allow, true);
    assert.equal(got.autoClaimed, true);

    coordinator.releaseResourceLock({ agentId: 'agent-b', resourceName: 'tests', projectId });
  });

  await t.test('文件租约初始 TTL 覆盖“读代码→思考→改写”的间隔', () => {
    const res = coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-a',
      provider: 'claude',
      sessionId: 'sa',
      filePath: 'src/feature.js',
      projectId
    });
    assert.equal(res.allow, true);

    const lease = leaseRow(db, res.leaseId);
    assert.equal(lease.ttl_seconds, LEASE_POLICY.fileTtlSeconds);
    assert.ok(lease.ttl_seconds >= 180, `文件锁 TTL 仅 ${lease.ttl_seconds}s，纯阅读阶段会丢锁`);
  });

  await t.test('持有者再次写同一文件会顺延租约，而不是等它到期', () => {
    const before = db
      .prepare('SELECT l.id, l.expires_at FROM leases l JOIN claims c ON c.intent_id = l.intent_id WHERE c.claim_target LIKE ?')
      .get('%src/feature.js');

    // 模拟租约已消耗大半，此时持有者继续编辑
    const squeezed = Date.now() + 5000;
    db.prepare('UPDATE leases SET expires_at = ? WHERE id = ?').run(squeezed, before.id);

    const again = coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-a',
      provider: 'claude',
      sessionId: 'sa',
      filePath: 'src/feature.js',
      projectId
    });
    assert.equal(again.allow, true);
    assert.equal(again.reason, 'self-held-lease');

    const after = db.prepare('SELECT expires_at FROM leases WHERE id = ?').get(before.id);
    assert.ok(after.expires_at > squeezed, '再次写入应顺延租约');
    assert.ok(after.expires_at >= Date.now() + 60 * 1000, '顺延幅度应覆盖下一段施工窗口');
  });

  await t.test('其他会话在此期间仍被该文件的租约拦截', () => {
    const blocked = coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-b',
      provider: 'claude',
      sessionId: 'sb',
      filePath: 'src/feature.js',
      projectId
    });
    assert.equal(blocked.allow, false);
    assert.equal(blocked.holder, 'Agent A');
  });

  await t.test('滑动续期上限放宽到覆盖长任务，且仍拒绝无限占锁', () => {
    const lease = db
      .prepare('SELECT id, created_at FROM leases l WHERE agent_id = ?')
      .get('agent-a');
    assert.ok(lease, '应存在 agent-a 的活跃租约');

    // 顶到上限
    const capped = coordinator.touchAgentLeases('agent-a', projectId, 10_000_000, LEASE_POLICY.maxTotalTtlSeconds);
    assert.equal(capped.touchedCount, 1);

    const row = db.prepare('SELECT created_at, expires_at FROM leases WHERE id = ?').get(lease.id);
    assert.equal(row.expires_at, row.created_at + LEASE_POLICY.maxTotalTtlSeconds * 1000);
    assert.ok(
      LEASE_POLICY.maxTotalTtlSeconds >= 1800,
      `上限 ${LEASE_POLICY.maxTotalTtlSeconds}s 短于一次长任务，会导致必然掉锁重抢`
    );
  });
});
