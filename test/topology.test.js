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
});
