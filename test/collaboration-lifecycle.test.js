// =============================================================================
// test/collaboration-lifecycle.test.js
// 验证多 Session 4 级生命周期状态机、实时协同防撞车图谱与工具遥测
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.js';
import { cleanUtf8String } from '../src/daemon/coordinator.js';

test('cleanUtf8String: 彻底清洗乱码字符与控制字节', () => {
  assert.equal(cleanUtf8String(null, 'default'), 'default');
  assert.equal(cleanUtf8String('', 'default'), 'default');
  assert.equal(cleanUtf8String('   ', 'fallback'), 'fallback');
  assert.equal(cleanUtf8String('Normal String'), 'Normal String');
  assert.equal(cleanUtf8String('Hello�Fix', 'fallback'), 'Hello Fix');
  assert.equal(cleanUtf8String('Command \x00\x08with control bytes\x1F'), 'Command with control bytes');
  assert.equal(cleanUtf8String('??????', 'fallback'), 'fallback');
  assert.equal(cleanUtf8String('   ???   ', 'fallback'), 'fallback');
});

test('Session 4-Tier 状态机与多会话实时协同图谱', async (t) => {
  const harness = createHarness();
  const { coordinator, db } = harness;
  const projectId = 'test-proj-collab';

  t.after(() => {
    harness.close();
  });

  // 1. 注册 3 个会话：
  // agent-1: 施工中 (持有文件锁)
  // agent-2: 排队中 (等待 agent-1 的文件锁)
  // agent-3: 待命中 (在线，无锁)
  coordinator.registerAgent({
    id: 'agent-1',
    name: 'Worker 1',
    provider: 'claude',
    sessionId: 'sess-1',
    projectId
  });

  coordinator.registerAgent({
    id: 'agent-2',
    name: 'Worker 2',
    provider: 'claude',
    sessionId: 'sess-2',
    projectId
  });

  coordinator.registerAgent({
    id: 'agent-3',
    name: 'Worker 3',
    provider: 'codex',
    sessionId: 'sess-3',
    projectId
  });

  // 2. agent-1 上报工具遥测并持有租约
  coordinator.recordTelemetry({
    agentId: 'agent-1',
    tool: 'Edit',
    action: 'Edit main.cjs',
    target: 'src/main.cjs',
    projectId
  });

  const intent1 = coordinator.declareIntent({
    agentId: 'agent-1',
    intentSummary: 'Refactoring main.cjs',
    claims: [{ type: 'file', target: 'src/main.cjs' }],
    projectId,
    ttlSeconds: 300
  });
  assert.equal(intent1.status, 'GRANTED');

  // 3. agent-2 尝试申报同一文件，被判 WAITING 阻塞
  const intent2 = coordinator.declareIntent({
    agentId: 'agent-2',
    intentSummary: 'Trying to update main.cjs',
    claims: [{ type: 'file', target: 'src/main.cjs' }],
    projectId,
    ttlSeconds: 300
  });
  assert.equal(intent2.status, 'WAITING');

  // 4. agent-3 仅上报只读工具遥测，保持在线待命状态
  coordinator.recordTelemetry({
    agentId: 'agent-3',
    tool: 'Read',
    action: 'Read README.md',
    target: 'README.md',
    projectId
  });

  // 5. 验证 getDashboardSnapshot 的 4-tier lifecycle_state
  const snapshot = coordinator.getDashboardSnapshot(projectId);
  assert.equal(snapshot.agents.length, 3);

  const a1 = snapshot.agents.find(a => a.id === 'agent-1');
  const a2 = snapshot.agents.find(a => a.id === 'agent-2');
  const a3 = snapshot.agents.find(a => a.id === 'agent-3');

  assert.equal(a1.lifecycle_state, 'working');
  assert.equal(a1.last_tool, 'Edit');
  assert.equal(a1.last_target, 'src/main.cjs');

  assert.equal(a2.lifecycle_state, 'waiting');
  assert.ok(a2.blocked_reason);

  assert.equal(a3.lifecycle_state, 'idle');
  assert.equal(a3.last_tool, 'Read');

  // 6. 验证 getCollaborationGraph 输出的双向拓扑图
  const graph = coordinator.getCollaborationGraph(projectId);
  assert.ok(graph.timestamp);
  assert.ok(graph.stats);
  assert.equal(graph.stats.working_sessions, 1);
  assert.equal(graph.stats.waiting_sessions, 1);
  assert.equal(graph.stats.idle_sessions, 1);
  assert.equal(graph.stats.locked_resources, 1);

  // 节点集合
  const sessionNodes = graph.nodes.filter(n => n.node_type === 'session');
  const resourceNodes = graph.nodes.filter(n => n.node_type === 'resource');
  assert.equal(sessionNodes.length, 3);
  assert.equal(resourceNodes.length, 1);
  assert.ok(resourceNodes[0].target.endsWith('src/main.cjs'));
  assert.equal(resourceNodes[0].status, 'locked');

  // 边集合
  const leaseEdge = graph.edges.find(e => e.type === 'holds_lease');
  assert.ok(leaseEdge);
  assert.equal(leaseEdge.source, 'agent-1');
  assert.ok(leaseEdge.target.endsWith('src/main.cjs'));

  const waitEdge = graph.edges.find(e => e.type === 'waiting_for');
  assert.ok(waitEdge);
  assert.equal(waitEdge.source, 'agent-2');
  assert.ok(waitEdge.target.endsWith('src/main.cjs'));
});
