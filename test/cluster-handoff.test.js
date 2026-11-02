import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHarness, startTestDaemon } from './helpers.js';
import { normalizeGitRemoteUrl } from '../src/domain/project.js';

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

    // 5. POST /api/handoffs/:id/consume (认领 -> in_progress)
    const consumeRes = await daemon.request(`/api/handoffs/${handoffId}/consume`, {
      method: 'POST',
      body: { agent_id: 'linux-worker' }
    });
    assert.equal(consumeRes.status, 200);
    assert.equal(consumeRes.json.success, true);
    assert.equal(consumeRes.json.handoff.status, 'in_progress');

    // 6. POST /api/handoffs/:id/consume 再次调用自动演进为 completed 闭环
    const completeRes = await daemon.request(`/api/handoffs/${handoffId}/consume`, {
      method: 'POST',
      body: { agent_id: 'linux-worker' }
    });
    assert.equal(completeRes.status, 200);
    assert.equal(completeRes.json.handoff.status, 'completed');
  } finally {
    await daemon.close();
  }
});

test('跨 OS 同源仓库等价解析：Windows 与 Linux 异构路径共享接力工单与工程长期记忆', () => {
  const { coordinator, handoffService, memoryService, db } = createHarness();
  coordinator.localNodeId = 'win-workstation';

  // 注册本机 Windows 会话与远端 Linux 会话（同一仓库名 Agent-Nexus，不同跨系统路径与 projectId）
  coordinator.registerAgent({
    id: 'claude-win-dev',
    hostId: 'win-workstation',
    name: 'Windows 主开发会话',
    provider: 'claude',
    sessionId: 'win-dev',
    workspaceDir: 'D:/Claudespace/Project/Agent-Nexus',
    projectRoot: 'd:/claudespace/project/agent-nexus',
    projectId: 'proj_win_hash_01'
  });

  coordinator.registerAgent({
    id: 'claude-linux-runner',
    hostId: 'us-zenix',
    name: 'Linux 美西验证会话',
    provider: 'claude',
    sessionId: 'linux-runner',
    workspaceDir: '/root/Claudespace/Project/Agent-Nexus',
    projectRoot: '/root/Claudespace/Project/Agent-Nexus',
    projectId: 'proj_linux_hash_02'
  });

  // 1. 在 Windows projectId 下沉淀长期记忆与自动合成工单
  memoryService.set('proj_win_hash_01', {
    category: 'architecture',
    key: 'hub_edge_topology',
    content: '单中心 Hub + 边缘轻量无状态探针',
    sourceAgentId: 'claude-win-dev'
  });

  const h1 = handoffService.createHandoff('proj_win_hash_01', {
    sourceHostId: 'win-workstation',
    sourceAgentId: 'claude-win-dev',
    objective: '第一阶段草稿提交',
    stateSummary: '初步修改',
    nextAction: '待继续',
    metadata: { auto_synthesized: true }
  });
  assert.equal(h1.status, 'pending');

  // 新一轮自动合成工单应自动将上一条未认领的自动合成工单演进为 completed
  const h2 = handoffService.createHandoff('proj_win_hash_01', {
    sourceHostId: 'win-workstation',
    sourceAgentId: 'claude-win-dev',
    objective: '第二阶段完整提交',
    stateSummary: '已完成 SQL 预编译缓存与单次 RTT Hook 优化',
    modifiedFiles: ['src/daemon/coordinator.js', 'src/hook/nexus-hook.mjs'],
    nextAction: '在 Linux 远端执行全量基准验证',
    metadata: { auto_synthesized: true }
  });
  assert.equal(handoffService.getById(h1.id).status, 'completed');
  assert.equal(h2.status, 'pending');

  // 2. 远端 Linux 会话使用自己的 proj_linux_hash_02 查询待接力工单与长期记忆，应自动跨机命中！
  const pendingForLinux = handoffService.getPendingHandoff('proj_linux_hash_02', {
    excludeAgentId: 'claude-linux-runner'
  });
  assert.ok(pendingForLinux, '远端 Linux 工程 ID 应自动感知同仓库 Windows 工程下的待接力工单');
  assert.equal(pendingForLinux.id, h2.id);

  const linuxMemories = memoryService.list('proj_linux_hash_02');
  assert.equal(linuxMemories.length, 1, '远端 Linux 工程 ID 应自动共享同仓库 Windows 工程下的长期记忆');
  assert.equal(linuxMemories[0].key, 'hub_edge_topology');

  db.close();
});

test('跨机缺陷修复 1: Git Remote 指纹强等价聚合与同名异源仓库防串味隔离', () => {
  const { coordinator, handoffService, memoryService, db } = createHarness();
  coordinator.localNodeId = 'win-hub';

  // 验证各种协议格式归一化到同一指纹
  assert.equal(normalizeGitRemoteUrl('https://github.com/Acme/Core-Engine.git'), 'github.com/acme/core-engine');
  assert.equal(normalizeGitRemoteUrl('git@github.com:Acme/Core-Engine.git'), 'github.com/acme/core-engine');
  assert.equal(normalizeGitRemoteUrl('ssh://git@github.com/Acme/Core-Engine/'), 'github.com/acme/core-engine');

  // 场景 A: 目录名完全不同，但 Git Remote 相同 -> 必须识别为同一仓库
  coordinator.registerAgent({
    id: 'agent-win-copy',
    hostId: 'win-hub',
    sessionId: 's-win',
    workspaceDir: 'D:/work/my-local-fork-dir',
    projectRoot: 'd:/work/my-local-fork-dir',
    gitRemote: 'https://github.com/acme/core-engine.git',
    projectId: 'proj_dir_alpha'
  });
  coordinator.registerAgent({
    id: 'agent-linux-ci',
    hostId: 'us-zenix',
    sessionId: 's-linux',
    workspaceDir: '/opt/ci/build-slot-07',
    projectRoot: '/opt/ci/build-slot-07',
    gitRemote: 'git@github.com:acme/core-engine.git',
    projectId: 'proj_dir_beta'
  });

  memoryService.set('proj_dir_alpha', {
    category: 'rule',
    key: 'ci_env_rule',
    content: '构建前需加载 clang-18 工具链'
  });
  assert.equal(memoryService.list('proj_dir_beta').length, 1, '不同目录名但相同 Git Remote 应共享工程记忆');

  // 场景 B: 目录名完全相同 (payment-service)，但属于不同 Git Remote -> 严禁串味！
  coordinator.registerAgent({
    id: 'agent-org-a',
    hostId: 'win-hub',
    sessionId: 's-org-a',
    workspaceDir: 'D:/projects/payment-service',
    projectRoot: 'd:/projects/payment-service',
    gitRemote: 'https://github.com/org-a/payment-service.git',
    projectId: 'proj_org_a'
  });
  coordinator.registerAgent({
    id: 'agent-org-b',
    hostId: 'us-zenix',
    sessionId: 's-org-b',
    workspaceDir: '/root/projects/payment-service',
    projectRoot: '/root/projects/payment-service',
    gitRemote: 'https://github.com/org-b/payment-service.git',
    projectId: 'proj_org_b'
  });

  handoffService.createHandoff('proj_org_a', {
    sourceHostId: 'win-hub',
    sourceAgentId: 'agent-org-a',
    objective: 'Org-A 内部账务改造',
    stateSummary: '仅限 Org-A',
    nextAction: '验证 Org-A'
  });
  const leaked = handoffService.getPendingHandoff('proj_org_b', { excludeAgentId: 'agent-org-b' });
  assert.equal(leaked, null, '同名目录但不同 Git Remote 绝不能互相泄露接力工单');

  db.close();
});

test('跨机缺陷修复 2: 异构 OS 路径同文件写锁互斥、跨机排队唤醒与本地资源锁隔离', () => {
  const { coordinator, db } = createHarness();
  coordinator.localNodeId = 'win-workstation';

  // 1. Windows 会话通过 fastCheckAndAutoClaim 锁定 src/daemon/coordinator.js
  const winClaim = coordinator.fastCheckAndAutoClaim({
    agentId: 'claude-win',
    hostId: 'win-workstation',
    provider: 'claude',
    sessionId: 'win-01',
    filePath: 'D:/MockWorkspace/Agent-Nexus/src/daemon/coordinator.js',
    workspaceDir: 'D:/MockWorkspace/Agent-Nexus',
    projectRoot: 'd:/mockworkspace/agent-nexus',
    gitRemote: 'https://github.com/tanner/agent-nexus.git',
    projectId: 'proj_win_lock'
  });
  assert.equal(winClaim.allow, true);

  // 2. Linux 会话编辑同一仓库下的同一个相对路径文件 -> 必须被跨机拦截！
  const linuxBlocked = coordinator.fastCheckAndAutoClaim({
    agentId: 'claude-linux',
    hostId: 'us-zenix',
    provider: 'claude',
    sessionId: 'linux-01',
    filePath: '/root/Claudespace/Project/Agent-Nexus/src/daemon/coordinator.js',
    workspaceDir: '/root/Claudespace/Project/Agent-Nexus',
    projectRoot: '/root/Claudespace/Project/Agent-Nexus',
    gitRemote: 'git@github.com:tanner/agent-nexus.git',
    projectId: 'proj_linux_lock'
  });
  assert.equal(linuxBlocked.allow, false, '跨机编辑同一仓库同一文件应被拦截');
  assert.equal(linuxBlocked.holderHostId, 'win-workstation');
  assert.match(linuxBlocked.reason, /remote node \[win-workstation\]/);

  // 3. Linux 会话运行本机 tests 资源锁 -> 不同物理机器互不抢占 CPU/端口，应当放行！
  const winTests = coordinator.fastCheckAndAutoClaim({
    agentId: 'claude-win',
    hostId: 'win-workstation',
    provider: 'claude',
    sessionId: 'win-01',
    resourceName: 'tests',
    projectId: 'proj_win_lock'
  });
  assert.equal(winTests.allow, true);

  const linuxTests = coordinator.fastCheckAndAutoClaim({
    agentId: 'claude-linux',
    hostId: 'us-zenix',
    provider: 'claude',
    sessionId: 'linux-01',
    resourceName: 'tests',
    projectId: 'proj_linux_lock'
  });
  assert.equal(linuxTests.allow, true, '不同机器的 tests 运行时锁不应互相阻塞');

  // 4. Linux 会话通过 declareIntent 排队等待该文件，当 Windows 释放锁时应跨机自动唤醒 Linux！
  const linuxWaitIntent = coordinator.declareIntent({
    agentId: 'claude-linux',
    intentSummary: 'Linux 端补充守护进程探针逻辑',
    claims: [{ type: 'file', target: '/root/Claudespace/Project/Agent-Nexus/src/daemon/coordinator.js' }],
    projectId: 'proj_linux_lock',
    projectRoot: '/root/Claudespace/Project/Agent-Nexus'
  });
  assert.equal(linuxWaitIntent.status, 'WAITING');

  let wokenEvent = null;
  coordinator.eventBus.once('agent:woken', (ev) => { wokenEvent = ev; });

  coordinator.releaseAgentLeases({
    agentId: 'claude-win',
    hostId: 'win-workstation',
    projectId: 'proj_win_lock',
    reason: 'git_lifecycle'
  });

  assert.ok(wokenEvent, 'Windows 释放文件锁后应立即跨机唤醒 Linux 等待会话');
  assert.equal(wokenEvent.agent_id, 'claude-linux');

  db.close();
});

test('跨机缺陷修复 3 & 4: 租约过期后的无锁提交合成、服务端按 Agent 投递去重与跨机状态演进', () => {
  const { coordinator, handoffService, db } = createHarness();
  coordinator.localNodeId = 'win-workstation';

  // 1. 模拟 Windows 会话获取文件锁后，因思考耗时超过 TTL 导致租约已过期清理 (activeLeases === 0)
  coordinator.fastCheckAndAutoClaim({
    agentId: 'claude-win-slow',
    hostId: 'win-workstation',
    provider: 'claude',
    sessionId: 'win-slow',
    filePath: 'D:/Repo/Nexus/src/core.js',
    workspaceDir: 'D:/Repo/Nexus',
    projectRoot: 'd:/repo/nexus',
    gitRemote: 'https://github.com/acme/nexus.git',
    projectId: 'proj_win_slow'
  });
  db.prepare(`UPDATE leases SET expires_at = ?`).run(Date.now() - 10000);
  coordinator.expireLeases();

  // 确认此刻名下已无任何活跃租约
  const activeCount = db.prepare(`SELECT count(*) as c FROM leases WHERE agent_id = 'claude-win-slow'`).get().c;
  assert.equal(activeCount, 0);

  // 2. 执行 git commit 释放（附带或回退历史记录）仍能成功合成跨机接力工单！
  const relRes = coordinator.releaseAgentLeases({
    agentId: 'claude-win-slow',
    hostId: 'win-workstation',
    projectId: 'proj_win_slow',
    reason: 'git_lifecycle',
    gitContext: {
      lastCommit: 'fix(core): handle slow lease expiration gracefully',
      modifiedFiles: ['src/core.js', 'src/utils.js']
    }
  });
  assert.equal(relRes.releasedCount, 0);
  assert.ok(relRes.handoffId, '即使提交时活跃租约为 0，也必须合成跨机接力工单');

  const handoff = handoffService.getById(relRes.handoffId);
  assert.equal(handoff.objective, 'fix(core): handle slow lease expiration gracefully');
  assert.deepEqual(handoff.modified_files, ['src/core.js', 'src/utils.js']);

  // 3. 远端 Linux 会话 1 拉取遥测：首次返回 pendingHandoff，第二次服务端自动去重返回无 pendingHandoff
  coordinator.registerAgent({
    id: 'claude-linux-1',
    hostId: 'us-zenix',
    sessionId: 'linux-1',
    workspaceDir: '/root/nexus',
    projectRoot: '/root/nexus',
    gitRemote: 'git@github.com:acme/nexus.git',
    projectId: 'proj_linux_peer'
  });

  const tel1 = coordinator.recordTelemetry({
    agentId: 'claude-linux-1',
    hostId: 'us-zenix',
    sessionId: 'linux-1',
    toolName: 'Read',
    projectId: 'proj_linux_peer'
  });
  assert.ok(tel1.pendingHandoff, 'Linux 会话 1 首次工具调用应收到跨机接力工单');
  assert.equal(tel1.pendingHandoff.id, handoff.id);

  const tel2 = coordinator.recordTelemetry({
    agentId: 'claude-linux-1',
    hostId: 'us-zenix',
    sessionId: 'linux-1',
    toolName: 'Grep',
    projectId: 'proj_linux_peer'
  });
  assert.equal(tel2.pendingHandoff, undefined, 'Hub 端已记录投递，不应对同一 Agent 重复返回同一工单');

  // 4. 远端同项目的另一个并行会话 (claude-linux-2) 仍能正常收到该工单
  const telOtherAgent = coordinator.recordTelemetry({
    agentId: 'claude-linux-2',
    hostId: 'us-zenix',
    sessionId: 'linux-2',
    toolName: 'Read',
    projectId: 'proj_linux_peer'
  });
  assert.ok(telOtherAgent.pendingHandoff, '另一个尚未接收过的远端 Agent 仍应收到接力工单');

  // 5. 当 Linux 会话提交新一轮代码合成新工单时，Windows 侧旧自动合成工单应跨 projectId 自动演进为 completed
  const linuxRel = coordinator.releaseAgentLeases({
    agentId: 'claude-linux-1',
    hostId: 'us-zenix',
    projectId: 'proj_linux_peer',
    reason: 'git_lifecycle',
    gitContext: {
      lastCommit: 'test(core): pass linux integration suite',
      modifiedFiles: ['test/core.test.js']
    }
  });
  assert.ok(linuxRel.handoffId);
  assert.equal(handoffService.getById(handoff.id).status, 'completed', '下游新提交应自动将上游旧自动合成工单跨机闭环为 completed');

  db.close();
});

test('跨机缺陷修复 5: Hook 真实 Git 提交提取与 PreToolUse stdout additionalContext 大模型上下文注入', async () => {
  const daemon = await startTestDaemon();
  const tempRepo = mkdtempSync(join(tmpdir(), 'nexus-git-handoff-'));
  const tempHome = mkdtempSync(join(tmpdir(), 'nexus-hook-home-'));
  const hookPath = join(import.meta.dirname, '../src/hook/nexus-hook.mjs');

  const runHook = (payload, extraArgs = [], envOverrides = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath, ...extraArgs], {
      cwd: tempRepo,
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        NEXUS_HUB_URL: `http://127.0.0.1:${daemon.port}`,
        NEXUS_HOST: '127.0.0.1',
        NEXUS_PORT: String(daemon.port),
        NEXUS_TOKEN: daemon.operatorToken,
        ...envOverrides
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', reject);
    child.stdin.end(JSON.stringify(payload));
  });

  try {
    // 1. 初始化真实临时 Git 仓库并配置 remote origin，提交一个新文件（全程无预先活跃文件锁）
    execFileSync('git', ['init'], { cwd: tempRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: tempRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: tempRepo, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/ZeroCopy-Engine.git'], { cwd: tempRepo, stdio: 'ignore' });

    mkdirSync(join(tempRepo, 'src'), { recursive: true });
    writeFileSync(join(tempRepo, 'src', 'pipeline.js'), 'export const v = 1;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'feat(pipeline): implement zero-copy ring buffer'], { cwd: tempRepo, stdio: 'ignore' });

    // 2. 模拟本地 Windows Claude Code 在 git commit 完成后触发 PostToolUse 钩子
    const postRes = await runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "feat(pipeline): implement zero-copy ring buffer"' },
      session_id: 'win-commit-sess',
      cwd: tempRepo
    }, ['--post'], { NEXUS_NODE_ID: 'win-dev-box' });
    assert.equal(postRes.code, 0);

    // 3. 模拟远端 Linux Claude Code 会话首次触发 PreToolUse 钩子
    const preRes = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      session_id: 'linux-relay-sess',
      cwd: tempRepo
    }, [], { NEXUS_NODE_ID: 'us-zenix' });

    assert.equal(preRes.code, 0);
    assert.ok(preRes.stdout.trim().length > 0, 'PreToolUse exit(0) 时必须在 stdout 输出结构化 JSON 供 Claude Code 注入上下文');

    const parsedStdout = JSON.parse(preRes.stdout.trim());
    assert.equal(parsedStdout.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.equal(parsedStdout.hookSpecificOutput?.permissionDecision, undefined, '不应输出 permissionDecision: allow 以免绕过用户权限门禁');
    assert.match(parsedStdout.hookSpecificOutput?.additionalContext, /win-dev-box/);
    assert.match(parsedStdout.hookSpecificOutput?.additionalContext, /feat\(pipeline\): implement zero-copy ring buffer/);
    assert.match(parsedStdout.hookSpecificOutput?.additionalContext, /src\/pipeline\.js/);
  } finally {
    await daemon.close();
    rmSync(tempRepo, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

