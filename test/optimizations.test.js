import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, capture } from './helpers.js';

test('生命周期零感自动释放 (Git Commit / Push Auto-Release)', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, eventBus } = h;

  coordinator.registerAgent({ id: 'worker-1', name: 'Worker 1', provider: 'claude', sessionId: 's1' });
  coordinator.registerAgent({ id: 'worker-2', name: 'Worker 2', provider: 'codex', sessionId: 's2' });

  // worker-1 声明两个租约
  const dec1 = coordinator.declareIntent({
    agentId: 'worker-1',
    intentSummary: 'Edit admin.html',
    claims: [{ type: 'file', target: 'admin.html' }],
    ttlSeconds: 300
  });
  const dec2 = coordinator.declareIntent({
    agentId: 'worker-1',
    intentSummary: 'Hold tests resource',
    claims: [{ type: 'resource', target: 'tests' }],
    ttlSeconds: 300
  });

  assert.equal(dec1.status, 'GRANTED');
  assert.equal(dec2.status, 'GRANTED');
  assert.equal(coordinator.getAgent('worker-1').status, 'running');

  // worker-2 尝试申报同一文件，进入 WAITING
  const dec3 = coordinator.declareIntent({
    agentId: 'worker-2',
    intentSummary: 'Update admin.html header',
    claims: [{ type: 'file', target: 'admin.html' }],
    ttlSeconds: 300
  });
  assert.equal(dec3.status, 'WAITING');

  const freedCaptures = capture(eventBus, 'resource:freed');
  const wokenCaptures = capture(eventBus, 'agent:woken');
  t.after(() => {
    freedCaptures.stop();
    wokenCaptures.stop();
  });

  // worker-1 执行 git commit，触发 releaseAgentLeases
  const releaseRes = coordinator.releaseAgentLeases({
    agentId: 'worker-1',
    reason: 'git_lifecycle'
  });

  assert.equal(releaseRes.success, true);
  assert.equal(releaseRes.releasedCount, 2, '应当一次性释放全部两个租约');
  assert.equal(coordinator.getAgent('worker-1').status, 'idle', '所有租约释放后状态应转为 idle');

  // 验证 worker-2 被唤醒
  assert.equal(releaseRes.notifiedWaiters.length, 1);
  assert.equal(releaseRes.notifiedWaiters[0].agent_id, 'worker-2');
  assert.equal(wokenCaptures.events.length, 1);
  assert.equal(wokenCaptures.events[0].agent_id, 'worker-2');
  assert.match(wokenCaptures.events[0].resume_hint, /admin\.html/);

  // 幂等性：无活跃租约时再次调用不报错
  const rerun = coordinator.releaseAgentLeases({ agentId: 'worker-1' });
  assert.equal(rerun.success, true);
  assert.equal(rerun.releasedCount, 0);
});

test('大文件锚点锁 (#anchor Granular File Locks)', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator } = h;

  coordinator.registerAgent({ id: 'agent-nav', name: 'Nav Worker', provider: 'claude', sessionId: 's1' });
  coordinator.registerAgent({ id: 'agent-data', name: 'Data Worker', provider: 'claude', sessionId: 's2' });
  coordinator.registerAgent({ id: 'agent-monolith', name: 'Whole File Worker', provider: 'codex', sessionId: 's3' });

  // 场景 1: 同一文件的不同锚点（不同区域）允许安全并发
  const decNav = coordinator.declareIntent({
    agentId: 'agent-nav',
    intentSummary: 'Update navigation banner',
    claims: [{ type: 'file', target: 'admin.html#nav-banner' }]
  });
  const decData = coordinator.declareIntent({
    agentId: 'agent-data',
    intentSummary: 'Update live traffic stream',
    claims: [{ type: 'file', target: 'admin.html#traffic-stream' }]
  });

  assert.equal(decNav.status, 'GRANTED', '首个锚点锁应成功授予');
  assert.equal(decData.status, 'GRANTED', '同一文件不同锚点应当允许安全并发施工');

  // 场景 2: 相同锚点互斥
  const decConflictAnchor = coordinator.declareIntent({
    agentId: 'agent-monolith',
    intentSummary: 'Touch same nav banner',
    claims: [{ type: 'file', target: 'admin.html#nav-banner' }]
  });
  assert.equal(decConflictAnchor.status, 'WAITING', '相同锚点应当互斥排队');
  assert.match(decConflictAnchor.reason, /Anchor conflict/);

  // 场景 3: 全文件锁（无 anchor）与任意锚点互斥
  coordinator.registerAgent({ id: 'agent-whole', name: 'Whole Worker', provider: 'codex', sessionId: 's4' });
  const decWhole = coordinator.declareIntent({
    agentId: 'agent-whole',
    intentSummary: 'Refactor whole admin.html',
    claims: [{ type: 'file', target: 'admin.html' }]
  });
  assert.equal(decWhole.status, 'WAITING', '整文件锁必须等待局部锚点锁全部释放');
  assert.match(decWhole.reason, /File conflict/);
});

test('冲突拦截高级诊断 (ETA, Holder Info & Action Advice)', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator } = h;

  coordinator.registerAgent({
    id: 'holder-1',
    name: 'Top Banner Engineer',
    provider: 'claude',
    sessionId: 's1',
    workspaceDir: 'D:/workspace/main',
    projectId: 'proj-1'
  });
  coordinator.registerAgent({
    id: 'waiter-1',
    name: 'Sidebar Engineer',
    provider: 'claude',
    sessionId: 's2',
    workspaceDir: 'D:/workspace/wt-sidebar',
    projectId: 'proj-1'
  });

  coordinator.declareIntent({
    agentId: 'holder-1',
    intentSummary: 'Style refactoring on admin.html',
    claims: [{ type: 'file', target: 'admin.html' }],
    ttlSeconds: 120,
    projectId: 'proj-1',
    projectRoot: 'D:/workspace/main'
  });

  // Fast check 拦截应携带详细诊断字段与跨工作树检测
  const check = coordinator.fastCheckAndAutoClaim({
    agentId: 'waiter-1',
    filePath: 'admin.html',
    workspaceDir: 'D:/workspace/wt-sidebar',
    projectId: 'proj-1',
    projectRoot: 'D:/workspace/main'
  });

  assert.equal(check.allow, false);
  assert.equal(check.holder, 'Top Banner Engineer');
  assert.equal(check.holderWorkspace, 'D:/workspace/main');
  assert.ok(check.remainingSec > 0 && check.remainingSec <= 120, '应包含剩余预估租期');
  assert.ok(check.expiresAt > Date.now(), '应包含到期时间戳');
  assert.match(check.reason, /CROSS-WORKTREE CONFLICT/);
  assert.match(check.advice, /ETA ~/);
  assert.match(check.advice, /git commit\/push/);
});

test('持久化唤醒通知 (Durable Waiter Messages & Dialogue Integration)', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, messageService } = h;

  coordinator.registerAgent({ id: 'agent-a', name: 'Agent A', provider: 'claude', sessionId: 'sa' });
  coordinator.registerAgent({ id: 'agent-b', name: 'Agent B', provider: 'codex', sessionId: 'sb' });

  const decA = coordinator.declareIntent({
    agentId: 'agent-a',
    intentSummary: 'Hold lock on config.json',
    claims: [{ type: 'file', target: 'config.json' }]
  });

  const decB = coordinator.declareIntent({
    agentId: 'agent-b',
    intentSummary: 'Need config.json',
    claims: [{ type: 'file', target: 'config.json' }]
  });
  assert.equal(decB.status, 'WAITING');

  // A 释放租约
  coordinator.releaseLease(decA.leaseId, 'agent-a');

  // 验证 B 的信箱中持久化写入了一条 handoff 唤醒通知
  const inbox = messageService.inbox('agent-b');
  assert.equal(inbox.length, 1, '被唤醒的 Agent 信箱中应有一条持久化通知');
  assert.equal(inbox[0].dialogue_type, 'handoff');
  assert.equal(inbox[0].importance, 'urgent');
  assert.match(inbox[0].content, /config\.json/);
  assert.match(inbox[0].content, /Agent A/);
});

test('REST API: /api/hook/git-release 与 /api/leases/release-agent 端点集成', async (t) => {
  const { startTestDaemon } = await import('./helpers.js');
  const d = await startTestDaemon();
  t.after(() => d.close());

  // 注册两个 agent 并让 agent-1 持有租约
  await d.request('/api/agents', {
    method: 'POST',
    body: { id: 'agent-1', name: 'Agent One', provider: 'claude', session_id: 's1' }
  });
  await d.request('/api/agents', {
    method: 'POST',
    body: { id: 'agent-2', name: 'Agent Two', provider: 'codex', session_id: 's2' }
  });

  const decRes = await d.request('/api/intents/declare', {
    method: 'POST',
    body: {
      agent_id: 'agent-1',
      summary: 'Edit some file',
      claims: [{ type: 'file', target: 'index.js' }]
    }
  });
  assert.equal(decRes.status, 200);
  assert.equal(decRes.json.status, 'GRANTED');

  // 等待方 agent-2
  const waitRes = await d.request('/api/intents/declare', {
    method: 'POST',
    body: {
      agent_id: 'agent-2',
      summary: 'Also need index.js',
      claims: [{ type: 'file', target: 'index.js' }]
    }
  });
  assert.equal(waitRes.status, 200);
  assert.equal(waitRes.json.status, 'WAITING');

  // 调用 /api/hook/git-release
  const relRes = await d.request('/api/hook/git-release', {
    method: 'POST',
    body: {
      agent_id: 'agent-1',
      reason: 'git_lifecycle'
    }
  });
  assert.equal(relRes.status, 200);
  assert.equal(relRes.json.success, true);
  assert.equal(relRes.json.releasedCount, 1);
  assert.equal(relRes.json.notifiedWaiters.length, 1);
  assert.equal(relRes.json.notifiedWaiters[0].agent_id, 'agent-2');
});
