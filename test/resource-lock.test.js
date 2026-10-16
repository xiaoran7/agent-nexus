import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.js';
import { NEXUS_PROJECT_TOOLS } from '../src/mcp/server.js';

test('命名资源锁与跨工作树碰撞协调 (Resource Locks & Cross-Worktree)', async (t) => {
  const harness = createHarness();
  const { coordinator, mcp, close } = harness;

  coordinator.registerAgent({ id: 'agent-alice', name: 'Alice', provider: 'claude', sessionId: 's1' });
  coordinator.registerAgent({ id: 'agent-bob', name: 'Bob', provider: 'claude', sessionId: 's2' });

  t.after(() => {
    close();
  });

  await t.test('acquireResourceLock: 先到者成功获取资源锁', () => {
    const res = coordinator.acquireResourceLock({
      agentId: 'agent-alice',
      resourceName: 'tests',
      ttlSeconds: 60,
      reason: 'Running integration tests',
      projectId: 'proj-1'
    });

    assert.equal(res.success, true);
    assert.equal(res.status, 'GRANTED');
    assert.equal(res.resource_name, 'tests');
    assert.ok(res.leaseId);
  });

  await t.test('acquireResourceLock: 后到者被排他性互斥拦截并返回当前持有者', () => {
    const res = coordinator.acquireResourceLock({
      agentId: 'agent-bob',
      resourceName: 'tests',
      ttlSeconds: 60,
      reason: 'Bob wanting to test',
      projectId: 'proj-1'
    });

    assert.equal(res.success, false);
    assert.equal(res.status, 'WAITING');
    assert.equal(res.blockedBy, 'agent-alice');
    assert.match(res.reason, /Resource conflict: 'tests' is currently held by Alice/);
  });

  await t.test('listResourceLocks: 查询当前项目下的活跃资源锁', () => {
    const locks = coordinator.listResourceLocks('proj-1');
    assert.equal(locks.length, 1);
    assert.equal(locks[0].resourceName, 'tests');
    assert.equal(locks[0].agentId, 'agent-alice');
    assert.equal(locks[0].agentName, 'Alice');

    // 另一个项目隔离
    const emptyLocks = coordinator.listResourceLocks('proj-other');
    assert.equal(emptyLocks.length, 0);
  });

  await t.test('releaseResourceLock: 释放资源锁后后到者可成功获取', () => {
    const releaseRes = coordinator.releaseResourceLock({
      agentId: 'agent-alice',
      resourceName: 'tests',
      projectId: 'proj-1'
    });
    assert.equal(releaseRes.success, true);

    const bobRes = coordinator.acquireResourceLock({
      agentId: 'agent-bob',
      resourceName: 'tests',
      ttlSeconds: 60,
      projectId: 'proj-1'
    });
    assert.equal(bobRes.success, true);
    assert.equal(bobRes.status, 'GRANTED');

    // 清理 Bob 的锁
    coordinator.releaseResourceLock({ agentId: 'agent-bob', resourceName: 'tests', projectId: 'proj-1' });
  });

  await t.test('fastCheckAndAutoClaim: 命令推导资源锁自动判冲', () => {
    // Alice 拿到 dev-server 资源锁
    const l1 = coordinator.acquireResourceLock({
      agentId: 'agent-alice',
      resourceName: 'dev-server',
      projectId: 'proj-1'
    });
    assert.equal(l1.success, true);

    // Bob 执行 bash (命令匹配 dev-server) 通过 fastCheck 探测
    const checkBlocked = coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-bob',
      resourceName: 'dev-server',
      projectId: 'proj-1'
    });
    assert.equal(checkBlocked.allow, false);
    assert.equal(checkBlocked.holder, 'Alice');

    // Alice 再次检查自己持有的资源允许放行
    const checkSelf = coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-alice',
      resourceName: 'dev-server',
      projectId: 'proj-1'
    });
    assert.equal(checkSelf.allow, true);

    coordinator.releaseResourceLock({ agentId: 'agent-alice', resourceName: 'dev-server', projectId: 'proj-1' });
  });

  await t.test('fastCheckAndAutoClaim: 跨 Worktree 相对路径冲突检测', () => {
    const projectRoot = 'd:/workspace/main-repo';
    const wtAlice = 'd:/workspace/main-repo-wt-alice';
    const wtBob = 'd:/workspace/main-repo-wt-bob';

    // Alice 注册在工作树 A
    coordinator.registerAgent({
      id: 'agent-alice',
      name: 'Alice',
      provider: 'claude',
      sessionId: 's1',
      workspaceDir: wtAlice,
      projectId: 'proj-1'
    });

    // Alice 在工作树 A 下声明修改 src/daemon/coordinator.js
    const d1 = coordinator.declareIntent({
      agentId: 'agent-alice',
      intentSummary: 'Refactor coordinator',
      claims: [{ type: 'file', target: 'src/daemon/coordinator.js' }],
      projectId: 'proj-1',
      projectRoot: projectRoot
    });
    assert.equal(d1.status, 'GRANTED');

    // Bob 在工作树 B 下试图修改其工作树下的绝对路径
    const bobFile = `${wtBob}/src/daemon/coordinator.js`;
    const checkCross = coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-bob',
      filePath: bobFile,
      projectId: 'proj-1',
      workspaceDir: wtBob,
      projectRoot: projectRoot
    });

    assert.equal(checkCross.allow, false);
    assert.equal(checkCross.holder, 'Alice');
    assert.match(checkCross.reason, /CROSS-WORKTREE CONFLICT/);

    // Alice 释放
    coordinator.releaseLease(d1.leaseId, 'agent-alice');
  });

  await t.test('MCP 工具: nexus_lock_resource 与 nexus_unlock_resource', () => {
    // 检查 project tools 包含资源锁工具
    const toolNames = NEXUS_PROJECT_TOOLS.map(t => t.name);
    assert.ok(toolNames.includes('nexus_lock_resource'));
    assert.ok(toolNames.includes('nexus_unlock_resource'));

    const lockRes = mcp('nexus_lock_resource', {
      agent_id: 'agent-alice',
      resource_name: 'build',
      project_id: 'proj-mcp'
    });

    assert.equal(lockRes.success, true);
    assert.equal(lockRes.resource_name, 'build');

    const unlockRes = mcp('nexus_unlock_resource', {
      agent_id: 'agent-alice',
      resource_name: 'build',
      project_id: 'proj-mcp'
    });

    assert.equal(unlockRes.success, true);
  });
});
