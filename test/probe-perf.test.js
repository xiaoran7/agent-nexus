// =============================================================================
// test/probe-perf.test.js
// 探针快照链路回归：过期租约去重、在席过滤下推、驾驶舱等待队列与锁分类。
// 这些行为在 300 会话规模下决定了主线程每 3 秒被占用多久，改动容易悄悄退化。
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, capture, startTestDaemon } from './helpers.js';

function insertDepartedAgent(db, { id, projectId, livenessVerifiedAt = null }) {
  const stale = Date.now() - 30 * 60 * 1000;
  db.prepare(`
    INSERT INTO agents (id, project_id, host_id, name, provider, session_id, workspace_dir, status, last_heartbeat, registered_at, pid, liveness_verified_at)
    VALUES (?, ?, 'local', ?, 'claude', ?, '', 'departed', ?, ?, NULL, ?)
  `).run(id, projectId, `历史会话 ${id}`, `sess-${id}`, stale, stale, livenessVerifiedAt);
}

// claim 目标会被规范化为可比较的绝对路径，断言只看文件名部分。
function basename(target) {
  return String(target || '').replace(/\\/g, '/').split('/').pop();
}

test('expireLeases: 同一 agent 的多份过期租约只同步一次状态', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, db } = h;
  const projectId = 'proj-expire';

  coordinator.registerAgent({ id: 'agent-a', name: 'Worker A', provider: 'claude', sessionId: 'sa', projectId });
  coordinator.registerAgent({ id: 'agent-b', name: 'Worker B', provider: 'claude', sessionId: 'sb', projectId });

  coordinator.declareIntent({ agentId: 'agent-a', intentSummary: '改 a.js', claims: [{ type: 'file', target: 'src/a.js' }], projectId });
  coordinator.declareIntent({ agentId: 'agent-a', intentSummary: '改 b.js', claims: [{ type: 'file', target: 'src/b.js' }], projectId });
  coordinator.declareIntent({ agentId: 'agent-b', intentSummary: '改 c.js', claims: [{ type: 'file', target: 'src/c.js' }], projectId });

  assert.equal(db.prepare('SELECT count(*) AS n FROM leases WHERE agent_id = ?').get('agent-a').n, 2);

  const { events, stop } = capture(h.eventBus, 'agent:status');
  const past = Date.now() - 1000;
  db.prepare('UPDATE leases SET expires_at = ? WHERE project_id = ?').run(past, projectId);
  coordinator.expireLeases();
  stop();

  // 过去 affectedAgents 是 Set<对象>，永远去不了重：两份租约 → 两次查库、两次广播。
  const forA = events.filter((e) => e.agent_id === 'agent-a');
  const forB = events.filter((e) => e.agent_id === 'agent-b');
  assert.equal(forA.length, 1, `agent-a 的状态只应同步一次，实际 ${forA.length} 次`);
  assert.equal(forB.length, 1, `agent-b 的状态只应同步一次，实际 ${forB.length} 次`);
  assert.equal(db.prepare('SELECT count(*) AS n FROM leases').get().n, 0, '过期租约应全部回收');
});

test('dashboard 在席过滤下推到 SQL，完整历史仍需显式请求', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, db } = h;
  const projectId = 'proj-filter';

  coordinator.registerAgent({ id: 'agent-live', name: 'Live Worker', provider: 'claude', sessionId: 'sl', projectId });
  insertDepartedAgent(db, { id: 'agent-gone', projectId });
  // 会话复活的唯一入口是 syncClaudeSessions：它把 status 改回在线档位。
  // 因此这里用 liveness_verified_at 单独撑着的 departed 行不参与快照，也不该被复活。
  insertDepartedAgent(db, { id: 'agent-verified', projectId, livenessVerifiedAt: Date.now() - 5000 });

  const snapshot = coordinator.getDashboardSnapshot(projectId);
  const ids = snapshot.agents.map((a) => a.id);

  assert.deepEqual(ids, ['agent-live'], '默认快照只序列化在席会话');

  const full = coordinator.getDashboardSnapshot(projectId, { includeDeparted: true });
  assert.ok(full.agents.some((a) => a.id === 'agent-gone'), 'includeDeparted 时仍要能拿到完整历史');
  assert.equal(full.agents.length, 3);
});

test('驾驶舱的等待队列与排他锁分类来自真实数据', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, db } = h;
  const projectId = 'proj-cockpit-queue';

  coordinator.registerAgent({ id: 'agent-hold', name: 'Holder', provider: 'claude', sessionId: 'sh', projectId });
  coordinator.registerAgent({ id: 'agent-wait', name: 'Waiter', provider: 'claude', sessionId: 'sw', projectId });
  coordinator.registerAgent({ id: 'agent-lock', name: 'Lock Holder', provider: 'claude', sessionId: 'sl', projectId });

  coordinator.declareIntent({ agentId: 'agent-hold', intentSummary: '改 shared.js', claims: [{ type: 'file', target: 'src/shared.js' }], projectId });
  const blocked = coordinator.declareIntent({ agentId: 'agent-wait', intentSummary: '也要改 shared.js', claims: [{ type: 'file', target: 'src/shared.js' }], projectId });
  assert.equal(blocked.status, 'WAITING');
  coordinator.declareIntent({ agentId: 'agent-lock', intentSummary: '跑测试', claims: [{ type: 'resource', target: 'tests' }], projectId });

  insertDepartedAgent(db, { id: 'agent-history', projectId });

  const cockpit = coordinator.getUnifiedCockpit(projectId);

  // 过去 dashboard 从不返回 waitQueue，界面上「N 处冲突等待」永远是 0。
  assert.ok(Array.isArray(cockpit.dashboard.waitQueue));
  assert.equal(cockpit.dashboard.waitQueue.length, 1);
  assert.equal(cockpit.dashboard.waitQueue[0].agent_id, 'agent-wait');
  assert.ok(cockpit.dashboard.waitQueue[0].agent_name);
  assert.equal(cockpit.lockContention.waitQueue.length, 1);

  // 文件 claim 与命名资源锁分列展示，计数不重不漏。
  assert.equal(cockpit.lockContention.activeClaims.length, 1);
  assert.equal(basename(cockpit.lockContention.activeClaims[0].claim_target), 'shared.js');
  assert.equal(cockpit.lockContention.resourceLocks.length, 1);
  assert.equal(cockpit.lockContention.resourceLocks[0].claim_target, 'tests');
  assert.equal(cockpit.metrics.activeLocks, 2);

  // 拓扑只返回一份，避免同一次响应里把上百个节点的 JSON 发两遍。
  assert.ok(cockpit.topologySnapshot);
  assert.equal(cockpit.topology, undefined, 'cockpit 不应再重复返回 topology');
});

test('collab 复用 dashboard 行时 total_sessions 反映整库、离席数不为假零', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, db } = h;
  const projectId = 'proj-reuse';

  coordinator.registerAgent({ id: 'agent-one', name: 'One', provider: 'claude', sessionId: 's1', projectId });
  coordinator.registerAgent({ id: 'agent-two', name: 'Two', provider: 'claude', sessionId: 's2', projectId });
  insertDepartedAgent(db, { id: 'agent-old', projectId });

  const cockpit = coordinator.getUnifiedCockpit(projectId);
  const total = db.prepare('SELECT count(*) AS n FROM agents WHERE project_id = ?').get(projectId).n;

  assert.equal(cockpit.collab.stats.total_sessions, total);
  assert.equal(cockpit.collab.stats.departed_sessions, 1, '离席数应由总数与在席档位反推');
  const onlineCount = cockpit.collab.stats.working_sessions
    + cockpit.collab.stats.waiting_sessions
    + cockpit.collab.stats.idle_sessions;
  assert.equal(onlineCount + cockpit.collab.stats.departed_sessions, total);

  // 复用行不得改变图谱节点集合：仍是同一批在席会话。
  const sessionNodes = cockpit.collab.nodes.filter((n) => n.node_type === 'session');
  assert.equal(sessionNodes.length, 2);
  assert.deepEqual(
    sessionNodes.map((n) => n.id).sort(),
    cockpit.dashboard.agents.map((a) => a.id).sort()
  );
});

test('轻量计数接口与完整快照口径一致', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, db } = h;
  const projectId = 'proj-counts';

  coordinator.registerAgent({ id: 'agent-work', name: 'Worker', provider: 'claude', sessionId: 'w1', projectId });
  coordinator.registerAgent({ id: 'agent-idle', name: 'Idler', provider: 'claude', sessionId: 'i1', projectId });
  coordinator.registerAgent({ id: 'agent-wait', name: 'Waiter', provider: 'claude', sessionId: 'q1', projectId });
  coordinator.declareIntent({ agentId: 'agent-work', intentSummary: '改 main.js', claims: [{ type: 'file', target: 'src/main.js' }], projectId });
  coordinator.declareIntent({ agentId: 'agent-wait', intentSummary: '抢 main.js', claims: [{ type: 'file', target: 'src/main.js' }], projectId });
  insertDepartedAgent(db, { id: 'agent-history', projectId });

  const counts = coordinator.getLiveAgentCounts();
  const snapshot = coordinator.getDashboardSnapshot(projectId);
  const online = snapshot.agents.filter((a) => a.is_online);

  assert.equal(counts.total, online.length, '计数与快照的在席口径必须一致');
  assert.equal(counts.working, online.filter((a) => a.lifecycle_state === 'working').length);
  assert.equal(counts.waiting, online.filter((a) => a.lifecycle_state === 'waiting').length);
  assert.equal(counts.idle, online.filter((a) => a.lifecycle_state === 'idle').length);
  assert.equal(counts.activeLeases, 1);
  assert.equal(counts.waitingIntents, 1);
});

// /api/status 是桌面端每 3 秒轮询一次的端点，也是唯一保留的公开读接口；
// 它只吐计数。真正的看板与驾驶舱里有全部会话名、工作目录与文件锁，必须走令牌。
test('管道瞬时漏检不得判离席，真正消失的本地会话仍被收割', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, db } = h;
  const projectId = 'proj-grace';
  const dir = mkdtempSync(join(tmpdir(), 'nexus-grace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  coordinator.registerAgent({ id: 'claude-abc', name: '抖动的会话', provider: 'claude', sessionId: 'abc', projectId });
  // 模拟「PID 已不可用、只剩命名管道」的会话：管道一抖就整条判死。
  db.prepare('UPDATE agents SET pid = 999999, liveness_verified_at = ? WHERE id = ?').run(Date.now(), 'claude-abc');
  coordinator.declareIntent({ agentId: 'claude-abc', intentSummary: '改核心文件', claims: [{ type: 'file', target: 'src/core.js' }], projectId });
  const leaseCount = () => db.prepare('SELECT count(*) AS n FROM leases WHERE agent_id = ?').get('claude-abc').n;

  assert.equal(leaseCount(), 1);
  // 单帧从注册表消失：Windows 管道 existsSync 实测每秒约 3.5% 漏检，一帧抖动就回收租约会打断编辑。
  const once = coordinator.syncClaudeSessions(Date.now(), dir);
  assert.deepEqual(once.departed, []);
  assert.equal(leaseCount(), 1, '漏检一帧不能释放租约');
  // 连续 10 帧（本地 3 秒刷新 ≈ 30 秒）都在宽限期内。
  for (let i = 0; i < 10; i++) coordinator.syncClaudeSessions(Date.now(), dir);
  assert.notEqual(db.prepare('SELECT status FROM agents WHERE id = ?').get('claude-abc').status, 'departed');

  // 超过宽限期且 PID 探针同样失败 = 真死，照常收割。
  db.prepare('UPDATE agents SET liveness_verified_at = ? WHERE id = ?').run(Date.now() - 60000, 'claude-abc');
  const reaped = coordinator.syncClaudeSessions(Date.now(), dir);
  assert.deepEqual(reaped.departed, ['claude-abc']);
  assert.equal(leaseCount(), 0, '确认死亡后必须释放租约');
  assert.equal(db.prepare('SELECT liveness_verified_at FROM agents WHERE id = ?').get('claude-abc').liveness_verified_at, null);
});

// 全量快照收割只对「注册表追踪过的会话」生效。经全局 Hook 注册的终端会话从不写
// ~/.claude/sessions，它的缺席不是死亡证据——过去这里会在首个 3 秒 tick 里
// 把刚拿到的租约全部释放掉。
test('Hook 注册的终端会话不在注册表里，也不得被全量快照收割', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, db } = h;
  const projectId = 'proj-hookonly';
  const dir = mkdtempSync(join(tmpdir(), 'nexus-hookonly-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 没有 pid、没有 liveness_verified_at：正是 Hook 上报的终端会话形状。
  coordinator.registerAgent({ id: 'claude-hookonly', name: '终端会话', provider: 'claude', sessionId: 'hookonly', projectId });
  coordinator.declareIntent({ agentId: 'claude-hookonly', intentSummary: '改 core.js', claims: [{ type: 'file', target: 'src/core.js' }], projectId });

  const res = coordinator.syncClaudeSessions(Date.now(), dir);
  assert.deepEqual(res.departed, [], '注册表从未追踪过它，缺席不能算死亡');
  assert.equal(db.prepare('SELECT status FROM agents WHERE id = ?').get('claude-hookonly').status, 'running');
  assert.equal(db.prepare('SELECT count(*) AS n FROM leases WHERE agent_id = ?').get('claude-hookonly').n, 1);

  // 但它仍然要能被心跳超时收割——豁免的只是「注册表缺席」这条证据。
  db.prepare('UPDATE agents SET last_heartbeat = ? WHERE id = ?').run(Date.now() - 180000, 'claude-hookonly');
  coordinator.reapStaleIntentsAndAgents();
  assert.equal(db.prepare('SELECT status FROM agents WHERE id = ?').get('claude-hookonly').status, 'departed');
});

// 漏检一帧时，会话仍在该帧的快照里（alive=false）。宽限期必须从「最后一次验活」起算，
// 否则一个空闲 60 秒的会话会在单帧抖动里被立即收割——正是 45 秒宽限要防的场景。
test('宽限期从最后一次验活起算，不因单帧漏检立即收割', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, db } = h;
  const projectId = 'proj-flake';

  coordinator.registerAgent({ id: 'claude-idle', name: '空闲会话', provider: 'claude', sessionId: 'idle1', projectId });
  // 已空闲 60 秒（长回合/等待用户输入），验活戳同样是 60 秒前。
  db.prepare('UPDATE agents SET pid = NULL, liveness_verified_at = ? WHERE id = ?').run(Date.now() - 60000, 'claude-idle');
  coordinator.declareIntent({ agentId: 'claude-idle', intentSummary: '改 a.js', claims: [{ type: 'file', target: 'src/a.js' }], projectId });

  const res = coordinator._ingestSessionEntries(
    [{ pid: 1234, sessionId: 'idle1', name: '空闲会话', alive: false, verified: false, updatedAt: Date.now() }],
    coordinator.localNodeId,
    Date.now(),
    { fullSnapshot: true }
  );
  assert.deepEqual(res.departed, [], '漏检一帧不等于死亡');
  assert.equal(db.prepare('SELECT count(*) AS n FROM leases WHERE agent_id = ?').get('claude-idle').n, 1);
});

// 远端桥把漏检的会话以 alive=false 保留在快照里，所以「缺席」意味着注册表条目真的没了；
// 但边缘桥每 15 秒才推一帧，单帧缺席仍要给宽限，否则一次网络抖动就会清掉远端文件锁。
test('远端会话从快照中消失后仍保留一个宽限期', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, db } = h;
  const projectId = 'proj-remote';

  coordinator.syncRemoteClaudeSessions({
    hostId: 'us-zenix',
    sessions: [{ sessionId: 'r1', pid: 4242, name: '远端会话', cwd: '/srv/app', projectId, alive: true, verified: true }]
  });
  coordinator.declareIntent({ agentId: 'claude-r1', intentSummary: '改远端文件', claims: [{ type: 'file', target: 'src/r.js' }], projectId });
  const leaseCount = () => db.prepare('SELECT count(*) AS n FROM leases WHERE agent_id = ?').get('claude-r1').n;

  const first = coordinator.syncRemoteClaudeSessions({ hostId: 'us-zenix', sessions: [] });
  assert.deepEqual(first.departed, [], '单帧缺席不能立即收割远端会话');
  assert.equal(leaseCount(), 1);

  // 宽限期过后仍缺席 = 真死，照常收割并释放锁。
  db.prepare('UPDATE agents SET liveness_verified_at = ? WHERE id = ?').run(Date.now() - 60000, 'claude-r1');
  const later = coordinator.syncRemoteClaudeSessions({ hostId: 'us-zenix', sessions: [] });
  assert.deepEqual(later.departed, ['claude-r1']);
  assert.equal(leaseCount(), 0);
});

test('PID 回收只标记离席，不改写最后在线时间', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, db } = h;
  const projectId = 'proj-reap';

  coordinator.registerAgent({ id: 'agent-dead', name: 'Dead', provider: 'claude', sessionId: 'd1', projectId });
  // 直接造一条活跃租约：declareIntent 内部会跑刷新，搅乱下面要断言的心跳时刻。
  const now = Date.now();
  db.prepare(`
    INSERT INTO intents (id, project_id, agent_id, summary, status, created_at, updated_at)
    VALUES ('intent-dead', ?, 'agent-dead', '改 dead.js', 'granted', ?, ?)
  `).run(projectId, now, now);
  db.prepare(`
    INSERT INTO leases (id, project_id, agent_id, intent_id, expires_at, created_at)
    VALUES ('lease-dead', ?, 'agent-dead', 'intent-dead', ?, ?)
  `).run(projectId, now + 60000, now);
  const heartbeat = Date.now() - 120000;
  db.prepare('UPDATE agents SET pid = 999999, last_heartbeat = ? WHERE id = ?').run(heartbeat, 'agent-dead');
  const before = db.prepare('SELECT status, pid, last_heartbeat FROM agents WHERE id = ?').get('agent-dead');
  assert.equal(before.last_heartbeat, heartbeat);

  assert.equal(coordinator.reapDeadAgentLeases().reapedCount, 1);
  const row = db.prepare('SELECT status, last_heartbeat FROM agents WHERE id = ?').get('agent-dead');
  assert.equal(row.status, 'departed');
  // 过去走 updateAgentStatus 会把 last_heartbeat 刷成 now，面板永远看不出何时掉的线。
  assert.equal(row.last_heartbeat, heartbeat, '离席行的最后在线时间不应被改写');
});

test('/api/status 公开且只返回计数，dashboard 与 cockpit 需要令牌', async (t) => {
  const d = await startTestDaemon();
  t.after(() => d.close());

  await t.test('匿名 /api/status 可用且不含会话明细', async () => {
    const res = await d.request('/api/status', { token: null });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
    for (const key of ['active_agents_count', 'working', 'waiting', 'idle', 'active_leases', 'waiting_intents']) {
      assert.equal(typeof res.json[key], 'number', `${key} 必须是数字`);
    }
    assert.equal('agents' in res.json, false, '状态接口不应携带会话明细');
    assert.equal('timeline' in res.json, false);
  });

  await t.test('匿名读 /api/dashboard 与 /api/cockpit 返回 401', async () => {
    for (const path of ['/api/dashboard', '/api/cockpit']) {
      const res = await d.request(path, { token: null });
      assert.equal(res.status, 401, `${path} 不应匿名可读`);
    }
  });

  await t.test('带令牌时两个快照接口都可读', async () => {
    for (const path of ['/api/dashboard', '/api/cockpit']) {
      const res = await d.request(path);
      assert.equal(res.status, 200, `${path} 带令牌应可读`);
    }
  });
});
