import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDatabase } from '../src/storage/database.js';
import { TopologyService } from '../src/domain/topology.js';
import { CoordinatorEngine } from '../src/daemon/coordinator.js';

test('TopologyService: 演进拓扑节点记录与因果图生成', async (t) => {
  let db, bus, topoSvc, coordinator;

  t.beforeEach(() => {
    db = createDatabase(':memory:');
    bus = new EventEmitter();
    topoSvc = new TopologyService(db, bus);
    coordinator = new CoordinatorEngine(db, bus);
    coordinator.topologyService = topoSvc;
  });

  t.afterEach(() => {
    try { db.close(); } catch {}
  });

  await t.test('显式记录节点与自动时间序因果边推断', () => {
    // 节点 1
    const node1 = topoSvc.recordNode({
      projectId: 'proj-1',
      agentId: 'claude-1',
      title: '重构认证中间件',
      description: '使用 TokenStore 统一会话权限验证',
      claims: [{ type: 'file', target: 'src/transport/auth.js' }]
    });

    assert.ok(node1.id.startsWith('topo_'));
    assert.equal(node1.title, '重构认证中间件');
    assert.deepEqual(node1.parent_node_ids, []);

    // 节点 2：不给 parentNodeIds，自动挂接 node1
    const node2 = topoSvc.recordNode({
      projectId: 'proj-1',
      agentId: 'codex-2',
      title: '接入前端 Token 自动注入',
      description: '解决页面刷新后鉴权失效问题',
      claims: [{ type: 'file', target: 'src/ui/app.js' }]
    });

    assert.ok(node2.parent_node_ids.includes(node1.id));

    // 获取拓扑图
    const graph = topoSvc.getTopologyGraph('proj-1');
    assert.equal(graph.totalNodes, 2);
    assert.equal(graph.totalEdges, 1);
    assert.equal(graph.edges[0].from, node1.id);
    assert.equal(graph.edges[0].to, node2.id);
  });

  await t.test('coordinator releaseLease 自动沉淀 completed 拓扑节点与关键文件快照', () => {
    coordinator.registerAgent({
      id: 'agent-alpha',
      name: 'Alpha Worker',
      provider: 'claude',
      sessionId: 'sess-1',
      projectId: 'proj-coord'
    });

    const intent = coordinator.declareIntent({
      agentId: 'agent-alpha',
      intentSummary: '修复 SQLite 索引碎片化问题',
      claims: [
        { type: 'file', target: 'src/storage/database.js' },
        { type: 'file', target: 'src/storage/schema.sql' }
      ],
      projectId: 'proj-coord'
    });

    assert.equal(intent.status, 'GRANTED');

    // 释放租约
    const res = coordinator.releaseLease(intent.leaseId, 'agent-alpha');
    assert.ok(res.success);

    // 验证拓扑节点是否自动记录
    const graph = topoSvc.getTopologyGraph('proj-coord');
    assert.equal(graph.totalNodes, 1);
    const node = graph.nodes[0];
    assert.equal(node.agentId, 'agent-alpha');
    assert.equal(node.title, '完成: 修复 SQLite 索引碎片化问题');
    assert.equal(node.claims.length, 2);
    assert.ok(node.claims[0].target.includes('src/storage/database.js'));
  });

  await t.test('项目隔离性保证：不同项目拓扑互不串扰', () => {
    topoSvc.recordNode({
      projectId: 'proj-A',
      agentId: 'agent-A',
      title: 'A 项目功能'
    });

    topoSvc.recordNode({
      projectId: 'proj-B',
      agentId: 'agent-B',
      title: 'B 项目功能'
    });

    const graphA = topoSvc.getTopologyGraph('proj-A');
    const graphB = topoSvc.getTopologyGraph('proj-B');

    assert.equal(graphA.totalNodes, 1);
    assert.equal(graphA.nodes[0].title, 'A 项目功能');

    assert.equal(graphB.totalNodes, 1);
    assert.equal(graphB.nodes[0].title, 'B 项目功能');
  });

  await t.test('多分支因果 DAG 推断与模块分类 (detectModule & multi-branch predecessors)', () => {
    // 节点 1: transport 模块
    const n1 = topoSvc.recordNode({
      projectId: 'proj-dag',
      agentId: 'agent-1',
      title: '实现 WebSocket 全双工长连接',
      claims: [{ type: 'file', target: 'src/transport/ws.js' }]
    });
    assert.equal(n1.module, 'transport');

    // 节点 2: transport 模块（同文件同模块延续）
    const n2 = topoSvc.recordNode({
      projectId: 'proj-dag',
      agentId: 'agent-2',
      title: '接入 WS 鉴权与心跳保活',
      claims: [{ type: 'file', target: 'src/transport/ws.js' }]
    });
    assert.equal(n2.module, 'transport');
    assert.equal(n2.causality_type, 'causal_file');
    assert.ok(n2.parent_node_ids.includes(n1.id));

    // 节点 3: ui 模块分支
    const n3 = topoSvc.recordNode({
      projectId: 'proj-dag',
      agentId: 'agent-3',
      title: '构建综合全览驾驶舱 UI 视口',
      claims: [{ type: 'file', target: 'src/ui/app.js' }]
    });
    assert.equal(n3.module, 'ui');

    // 节点 4: 里程碑节点（汇聚前序分支）
    const n4 = topoSvc.recordNode({
      projectId: 'proj-dag',
      agentId: 'agent-lead',
      nodeType: 'milestone',
      title: '完成 v0.2.8 全双工长连接与综合全览发布',
      claims: []
    });
    assert.equal(n4.causality_type, 'milestone_convergence');

    const graph = topoSvc.getTopologyGraph('proj-dag');
    assert.ok(graph.modules.includes('transport'));
    assert.ok(graph.modules.includes('ui'));
    assert.equal(graph.totalNodes, 4);
    assert.ok(graph.totalEdges >= 3);

    const gn1 = graph.nodes.find(n => n.id === n1.id);
    const gn2 = graph.nodes.find(n => n.id === n2.id);
    const gn4 = graph.nodes.find(n => n.id === n4.id);
    assert.equal(gn1.depth, 0);
    assert.equal(gn2.depth, 1);
    assert.ok(gn4.depth >= 1);
  });

  await t.test('getUnifiedCockpit: 综合全览多维聚合数据结构完整性', () => {
    coordinator.registerAgent({
      id: 'worker-live',
      name: 'Working Agent',
      provider: 'claude',
      sessionId: 'sess-cockpit',
      projectId: 'proj-cockpit'
    });

    // 模拟施工遥测
    coordinator.recordTelemetry({
      agentId: 'worker-live',
      toolName: 'Grep',
      toolAction: '搜索拓扑节点',
      toolTarget: 'src/domain/topology.js',
      projectId: 'proj-cockpit'
    });

    // 模拟意图声明
    const intent = coordinator.declareIntent({
      agentId: 'worker-live',
      intentSummary: '修改拓扑生成规则',
      claims: [{ type: 'file', target: 'src/domain/topology.js' }],
      projectId: 'proj-cockpit'
    });

    const cockpit = coordinator.getUnifiedCockpit('proj-cockpit');

    assert.ok(cockpit);
    assert.equal(cockpit.projectId, 'proj-cockpit');
    assert.ok(cockpit.metrics);
    assert.equal(cockpit.metrics.workingAgents, 1);
    assert.equal(cockpit.metrics.activeLocks, 1);
    assert.ok(Array.isArray(cockpit.activeWorkers));
    assert.equal(cockpit.activeWorkers.length, 1);
    assert.equal(cockpit.activeWorkers[0].id, 'worker-live');
    assert.equal(cockpit.activeWorkers[0].lifecycle_state, 'working');
    assert.equal(cockpit.activeWorkers[0].current_tool, 'Grep');
    assert.ok(cockpit.topologySnapshot);
    assert.ok(cockpit.lockContention);
    assert.equal(cockpit.lockContention.activeClaims.length, 1);
  });

  // 回归：一次 cockpit 快照只允许刷新一轮会话/租约。
  // 过去 dashboard 与 collab 各自跑一遍，cockpit 又把两者串起来，加上前端
  // 每 4 秒一次的 sync:request，主线程被同步任务吃满，/health 抖到数秒。
  await t.test('getUnifiedCockpit 只刷新一次，嵌套快照复用同一轮结果', () => {
    let syncCalls = 0;
    const originalSync = coordinator.syncClaudeSessions.bind(coordinator);
    coordinator.syncClaudeSessions = (...args) => {
      syncCalls++;
      return originalSync(...args);
    };
    try {
      coordinator.getUnifiedCockpit('proj-cockpit');
      assert.equal(syncCalls, 1, `cockpit 应只触发一次 sync，实际 ${syncCalls} 次`);

      // 顶层快照仍然各自刷新一次，语义不变。
      syncCalls = 0;
      coordinator.getDashboardSnapshot('proj-cockpit');
      assert.equal(syncCalls, 1);

      syncCalls = 0;
      coordinator.getCollaborationGraph('proj-cockpit');
      assert.equal(syncCalls, 1);
    } finally {
      coordinator.syncClaudeSessions = originalSync;
    }
  });

  await t.test('四级状态机语义校准: 写入/修改工具触发 working，waiting 专指排队阻塞', () => {
    coordinator.registerAgent({
      id: 'worker-read',
      name: 'Read Agent',
      provider: 'claude',
      sessionId: 'sess-read',
      projectId: 'proj-state'
    });

    // 1. Edit 工具上报 -> working
    coordinator.recordTelemetry({
      agentId: 'worker-read',
      toolName: 'Edit',
      toolAction: '编辑源码',
      toolTarget: 'src/daemon/index.js',
      projectId: 'proj-state'
    });
    let agent = coordinator.getAgent('worker-read');
    assert.equal(agent.lifecycle_state, 'working');

    // 2. Write 工具上报 -> working
    coordinator.recordTelemetry({
      agentId: 'worker-read',
      toolName: 'Write',
      toolAction: '覆写文件',
      projectId: 'proj-state'
    });
    agent = coordinator.getAgent('worker-read');
    assert.equal(agent.lifecycle_state, 'working');

    // 3. 阻塞排队 -> waiting
    coordinator.declareIntent({
      agentId: 'worker-read',
      intentSummary: '独占文件',
      claims: [{ type: 'file', target: 'locked.js' }],
      projectId: 'proj-state'
    });

    coordinator.registerAgent({
      id: 'worker-blocked',
      name: 'Blocked Agent',
      provider: 'codex',
      sessionId: 'sess-blocked',
      projectId: 'proj-state'
    });

    const blockedIntent = coordinator.declareIntent({
      agentId: 'worker-blocked',
      intentSummary: '尝试获取同一文件',
      claims: [{ type: 'file', target: 'locked.js' }],
      projectId: 'proj-state'
    });

    assert.equal(blockedIntent.status, 'WAITING');
    const blockedAgent = coordinator.getAgent('worker-blocked');
    assert.equal(blockedAgent.lifecycle_state, 'waiting');
  });
});
