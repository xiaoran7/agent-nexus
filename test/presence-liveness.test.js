// =============================================================================
// test/presence-liveness.test.js
// 覆盖并发实测暴露出的在席判定缺陷：
//   1. 10 分钟心跳门禁把“活着但安静”的长回合会话误判为离席
//   2. 会话注册表的命名管道才是权威存活信号（免疫 Windows PID 复用）
//   3. 心跳上报刷屏时间线，淹没真正的冲突与释放事件
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness } from './helpers.js';
import { computeAgentLifecycleState } from '../src/daemon/coordinator.js';

const makeRegistryDir = (entries) => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-registry-'));
  for (const [file, data] of Object.entries(entries)) {
    writeFileSync(join(dir, file), JSON.stringify(data), 'utf8');
  }
  return dir;
};

test('computeAgentLifecycleState: 管道验证过的会话不受 10 分钟心跳门禁影响', async (t) => {
  const now = Date.now();

  await t.test('长回合（11 分钟无工具调用）但管道已验证 → 保持在席', () => {
    const state = computeAgentLifecycleState({
      pid: process.pid,
      last_heartbeat: now - 11 * 60 * 1000,
      liveness_verified_at: now - 1000,
      status: 'idle'
    }, now);

    assert.equal(state.isOnline, true, '宿主进程仍在，不应因心跳陈旧判为离席');
    assert.notEqual(state.lifecycleState, 'departed');
  });

  await t.test('等待用户输入 30 分钟但管道已验证 → 保持在席', () => {
    const state = computeAgentLifecycleState({
      pid: process.pid,
      last_heartbeat: now - 30 * 60 * 1000,
      liveness_verified_at: now - 5000,
      status: 'idle'
    }, now);

    assert.equal(state.isOnline, true);
  });

  await t.test('验证时间过期后，陈旧心跳仍按原规则归位 departed', () => {
    const state = computeAgentLifecycleState({
      pid: process.pid,
      last_heartbeat: now - 30 * 60 * 1000,
      liveness_verified_at: now - 10 * 60 * 1000,
      status: 'idle'
    }, now);

    assert.equal(state.isOnline, false, '验证早已过期，不能无限期视为在线');
  });

  await t.test('无管道验证时保留原有 10 分钟 PID 复用保护', () => {
    const state = computeAgentLifecycleState({
      pid: process.pid,
      last_heartbeat: now - 11 * 60 * 1000,
      liveness_verified_at: null,
      status: 'idle'
    }, now);

    assert.equal(state.isOnline, false, '无法证明宿主存活时，PID 复用风险仍按原策略处理');
  });
});

test('会话注册表：命名管道是权威存活信号', async (t) => {
  const harness = createHarness();
  t.after(() => harness.close());
  const { coordinator, db } = harness;

  // 指向一个确实存在的管道（当前测试进程所在的 Node 不创建管道，这里用真实存在的路径模拟）
  const livePipeDir = mkdtempSync(join(tmpdir(), 'nexus-pipe-'));
  const livePipe = join(livePipeDir, 'live.sock');
  writeFileSync(livePipe, '', 'utf8');
  t.after(() => rmSync(livePipeDir, { recursive: true, force: true }));

  const registryDir = makeRegistryDir({
    '111.json': {
      pid: process.pid, // 存活 PID，但管道不存在 → 说明这个 PID 是被复用的
      sessionId: 'sess-reused-pid',
      cwd: process.cwd(),
      status: 'busy',
      name: '幽灵会话',
      updatedAt: Date.now(),
      messagingSocketPath: join(livePipeDir, 'gone.sock')
    },
    '222.json': {
      pid: process.pid,
      sessionId: 'sess-live-pipe',
      cwd: process.cwd(),
      status: 'busy',
      name: '真实长回合',
      updatedAt: Date.now(),
      messagingSocketPath: livePipe
    }
  });
  t.after(() => rmSync(registryDir, { recursive: true, force: true }));

  await t.test('管道缺失的注册表条目不会被当作在线会话同步进来', () => {
    coordinator.syncClaudeSessions(Date.now(), registryDir);

    const ghost = db.prepare("SELECT * FROM agents WHERE session_id = 'sess-reused-pid'").get();
    assert.equal(ghost, undefined, 'PID 存活但管道消失，说明会话已退出、PID 被复用');
  });

  await t.test('管道存在的条目被同步，并写入存活验证时间', () => {
    const live = db.prepare("SELECT * FROM agents WHERE session_id = 'sess-live-pipe'").get();
    assert.ok(live, '管道存在应同步为在线会话');
    assert.ok(live.liveness_verified_at > 0, '应记录管道验证时间');
  });

  await t.test('已验证会话即使心跳陈旧也保持在线', () => {
    const stale = Date.now() - 20 * 60 * 1000;
    db.prepare("UPDATE agents SET last_heartbeat = ?, status = 'idle' WHERE session_id = 'sess-live-pipe'").run(stale);

    const snapshot = coordinator.getDashboardSnapshot();
    const agent = snapshot.agents.find((a) => a.session_id === 'sess-live-pipe');
    assert.ok(agent, '在线会话应出现在快照中');
    assert.equal(agent.is_online, true);
  });

  await t.test('会话退出后（管道消失）会被判为离席', () => {
    rmSync(livePipe, { force: true });
    const stale = Date.now() - 20 * 60 * 1000;
    db.prepare("UPDATE agents SET last_heartbeat = ?, liveness_verified_at = NULL WHERE session_id = 'sess-live-pipe'").run(stale);

    coordinator.syncClaudeSessions(Date.now(), registryDir);
    const snapshot = coordinator.getDashboardSnapshot();
    const agent = snapshot.agents.find((a) => a.session_id === 'sess-live-pipe');
    assert.equal(agent, undefined, '离席会话默认不出现在快照中');
  });
});

test('心跳不再刷屏时间线', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, db } = h;
  const projectId = 'proj-noise';

  const countLogs = () =>
    db.prepare("SELECT count(*) AS n FROM activity_log WHERE event_type = 'agent:registered' AND project_id = ?").get(projectId).n;

  await t.test('首次注册记录一条事件', () => {
    coordinator.registerAgent({ id: 'agent-q', name: 'Quiet Agent', provider: 'claude', sessionId: 'sq', projectId });
    assert.equal(countLogs(), 1);
  });

  await t.test('重复心跳不产生新事件', () => {
    for (let i = 0; i < 20; i++) {
      coordinator.registerAgent({ id: 'agent-q', name: 'Quiet Agent', provider: 'claude', sessionId: 'sq', projectId });
    }
    assert.equal(countLogs(), 1, '心跳不该逐次写入活动流水');
  });

  await t.test('工具遥测（每次写工具都会触发）也不写活动流水', () => {
    for (let i = 0; i < 20; i++) {
      coordinator.recordTelemetry({ agentId: 'agent-q', tool: 'Edit', action: 'Edit a.js', target: 'src/a.js', projectId });
    }
    assert.equal(countLogs(), 1);
  });

  await t.test('改名仍记录一条，便于追溯', () => {
    coordinator.registerAgent({ id: 'agent-q', name: 'Renamed Agent', provider: 'claude', sessionId: 'sq', projectId });
    assert.equal(countLogs(), 2);
  });

  await t.test('真正的协同事件仍在时间线里', () => {
    coordinator.registerAgent({ id: 'agent-r', name: 'Other Agent', provider: 'claude', sessionId: 'sr', projectId });
    coordinator.declareIntent({
      agentId: 'agent-q',
      intentSummary: 'Editing a.js',
      claims: [{ type: 'file', target: 'src/a.js' }],
      projectId
    });
    coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-r',
      provider: 'claude',
      sessionId: 'sr',
      filePath: 'src/a.js',
      projectId
    });

    const snapshot = coordinator.getDashboardSnapshot(projectId);
    assert.ok(snapshot.timeline.some((e) => e.event_type === 'intent:granted'), '授权事件应保留');
    assert.ok(snapshot.timeline.some((e) => e.event_type === 'hook:blocked'), '拦截事件应保留');
  });
});
