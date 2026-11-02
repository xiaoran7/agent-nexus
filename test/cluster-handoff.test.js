import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, startTestDaemon } from './helpers.js';

test('ClusterNodeService: 跨机算力拓扑与探针常驻心跳', async (t) => {
  const { clusterNodeService, db } = createHarness();

  await t.test('1. 节点心跳注册与状态感知 (online)', () => {
    const node = clusterNodeService.recordHeartbeat({
      nodeId: 'edge-us-zenix',
      displayName: 'us-zenix (Linux SSH)',
      role: 'edge',
      platform: 'linux',
      ip: '192.168.1.102',
      metadata: { claudeSessions: 2, probeVersion: '0.2.31' }
    });

    assert.equal(node.id, 'edge-us-zenix');
    assert.equal(node.status, 'online');
    assert.equal(node.role, 'edge');
    assert.equal(node.platform, 'linux');

    const listed = clusterNodeService.listNodes();
    // 包含本机 hub 与刚注册的 edge-us-zenix
    assert.ok(listed.some(n => n.id === 'edge-us-zenix'));
    const zenix = listed.find(n => n.id === 'edge-us-zenix');
    assert.equal(zenix.display_name, 'us-zenix (Linux SSH)');
  });

  await t.test('2. 心跳过期自动降级为 stale 和 offline', () => {
    // 超过 45s 降级为 stale
    const staleTime = Date.now() + 50000;
    const sweptStale = clusterNodeService.sweepStaleNodes(staleTime);
    assert.ok(sweptStale >= 1);
    const nodeStale = clusterNodeService.getNode('edge-us-zenix');
    assert.equal(nodeStale.status, 'stale');

    // 超过 180s 降级为 offline
    const offlineTime = Date.now() + 200000;
    const sweptOffline = clusterNodeService.sweepStaleNodes(offlineTime);
    assert.ok(sweptOffline >= 1);
    const nodeOffline = clusterNodeService.getNode('edge-us-zenix');
    assert.equal(nodeOffline.status, 'offline');
  });

  db.close();
});

test('ProjectHandoffService: 跨机工程记忆接力工单流', async (t) => {
  const { handoffService, db } = createHarness();

  await t.test('1. 创建接力工单并查询待认领状态', () => {
    const handoff = handoffService.createHandoff({
      projectId: 'proj-oceanbase',
      sourceHostId: 'local-windows',
      sourceAgentId: 'agent-alice',
      objective: '完成 CMakeLists 重构与 Windows MSVC 编译测试',
      stateSummary: '已跑通本机构建，生成动态链接库成功',
      modifiedFiles: ['CMakeLists.txt', 'src/core.cpp'],
      nextAction: '在远端 Linux 下验证 make test 与内存泄漏'
    });

    assert.equal(handoff.status, 'pending');
    assert.equal(handoff.project_id, 'proj-oceanbase');
    assert.deepEqual(handoff.modified_files, ['CMakeLists.txt', 'src/core.cpp']);

    const pending = handoffService.getPendingHandoff({
      projectId: 'proj-oceanbase',
      targetHostId: 'edge-us-zenix'
    });
    assert.ok(pending);
    assert.equal(pending.id, handoff.id);
  });

  await t.test('2. 远端 Agent 认领接力工单并闭环', () => {
    const pending = handoffService.getPendingHandoff({ projectId: 'proj-oceanbase' });
    assert.ok(pending);

    const consumed = handoffService.consumeHandoff(pending.id, 'agent-bob-remote');
    assert.equal(consumed.status, 'in_progress');
    assert.equal(consumed.consumed_by_agent_id, 'agent-bob-remote');

    // 再次查询待认领工单应为空
    const pendingAfter = handoffService.getPendingHandoff({ projectId: 'proj-oceanbase' });
    assert.equal(pendingAfter, null);

    // 完成接力工单
    const completed = handoffService.updateStatus(pending.id, 'completed');
    assert.equal(completed.status, 'completed');
  });

  await t.test('3. 从 Git 提交流水线自动合成阶段接力', () => {
    const autoHandoff = handoffService.autoSynthesizeFromRelease({
      projectId: 'proj-oceanbase',
      sourceHostId: 'local-windows',
      sourceAgentId: 'agent-charlie',
      gitContext: {
        lastCommit: 'feat(core): support dynamic memory allocation',
        branch: 'feat/mem-pool',
        modifiedFiles: ['src/mem.c', 'include/mem.h']
      }
    });

    assert.ok(autoHandoff);
    assert.equal(autoHandoff.status, 'pending');
    assert.ok(autoHandoff.objective.includes('feat(core)'));
    assert.deepEqual(autoHandoff.modified_files, ['src/mem.c', 'include/mem.h']);
  });

  db.close();
});

test('Coordinator & PreToolUse Hook: 跨机接力上下文无感注入', async (t) => {
  const { coordinator, handoffService, db } = createHarness();

  // 1. 本地机器 Agent 提交工作接力
  handoffService.createHandoff({
    projectId: 'default',
    sourceHostId: 'local-windows',
    sourceAgentId: 'local-agent',
    objective: '核心调度器状态机升级完毕',
    stateSummary: '单元测试已通过',
    modifiedFiles: ['src/daemon/coordinator.js'],
    nextAction: '在远端 Linux 机器执行压力测试'
  });

  // 2. 远端 Linux Agent 首次运行工具触发 fastCheckAndAutoClaim
  const checkResult = coordinator.fastCheckAndAutoClaim({
    agentId: 'remote-agent-1',
    name: 'remote-linux-session',
    projectId: 'default',
    hostId: 'edge-us-zenix',
    resourceName: 'tests'
  });

  // 验证返回中包含 pendingHandoff 跨机接力上下文
  assert.ok(checkResult.pendingHandoff);
  assert.equal(checkResult.pendingHandoff.objective, '核心调度器状态机升级完毕');
  assert.equal(checkResult.pendingHandoff.source_host_id, 'local-windows');
  assert.deepEqual(checkResult.pendingHandoff.modified_files, ['src/daemon/coordinator.js']);

  // 验证自动注册了算力节点 edge-us-zenix
  const nodes = coordinator.clusterNodeService.listNodes();
  const remoteNode = nodes.find(n => n.id === 'edge-us-zenix');
  assert.ok(remoteNode);
  assert.equal(remoteNode.status, 'online');

  db.close();
});

test('REST API: 算力拓扑与跨机接力端点完整性', async () => {
  const daemon = await startTestDaemon();

  try {
    // 1. POST /api/cluster/heartbeat
    const hbRes = await daemon.request('/api/cluster/heartbeat', {
      method: 'POST',
      body: {
        node_id: 'linux-runner-01',
        display_name: 'Linux Runner #1',
        role: 'edge',
        platform: 'linux',
        ip: '10.0.0.15'
      }
    });
    assert.equal(hbRes.status, 200);
    assert.equal(hbRes.json.ok, true);

    // 2. GET /api/cluster/nodes
    const nodesRes = await daemon.request('/api/cluster/nodes');
    assert.equal(nodesRes.status, 200);
    assert.ok(Array.isArray(nodesRes.json));
    assert.ok(nodesRes.json.some(n => n.id === 'linux-runner-01'));

    // 3. POST /api/handoffs
    const createRes = await daemon.request('/api/handoffs', {
      method: 'POST',
      body: {
        project_id: 'default',
        source_host_id: 'local-windows',
        source_agent_id: 'operator',
        objective: '跨机测试流水线',
        state_summary: '本地 Windows 验证完毕',
        modified_files: ['test/runner.test.js'],
        nextAction: '在 Linux 节点执行端到端集成'
      }
    });
    assert.equal(createRes.status, 201);
    assert.ok(createRes.json.id);
    const handoffId = createRes.json.id;

    // 4. GET /api/handoffs
    const listRes = await daemon.request('/api/handoffs?project_id=default');
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.json));
    assert.ok(listRes.json.some(h => h.id === handoffId));

    // 5. POST /api/handoffs/:id/consume
    const consumeRes = await daemon.request(`/api/handoffs/${handoffId}/consume`, {
      method: 'POST',
      body: { agent_id: 'linux-worker' }
    });
    assert.equal(consumeRes.status, 200);
    assert.equal(consumeRes.json.success, true);
    assert.equal(consumeRes.json.handoff.status, 'in_progress');
  } finally {
    await daemon.close();
  }
});
