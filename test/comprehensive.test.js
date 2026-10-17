import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEXUS_TOOLS } from '../src/mcp/server.js';
import { createHarness, capture } from './helpers.js';

test('共享状态与 CAS', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { stateService } = h;

  const changed = capture(h.eventBus, 'state:changed');
  t.after(() => changed.stop());

  await t.test('set 后可读回', () => {
    stateService.set('locks', 'playwright-port', '8080', 'agent-1', 60);

    const row = stateService.get('locks', 'playwright-port');
    assert.equal(row.value, '8080');
    assert.equal(row.updated_by, 'agent-1');
  });

  await t.test('CAS 期望值匹配时换值成功', () => {
    const res = stateService.compareAndSwap('locks', 'playwright-port', '8080', '8081', 'agent-2');

    assert.equal(res.swapped, true);
    assert.equal(stateService.get('locks', 'playwright-port').value, '8081');
  });

  await t.test('CAS 期望值过期时不改动并回报当前值', () => {
    const res = stateService.compareAndSwap('locks', 'playwright-port', '8080', '9999', 'agent-3');

    assert.equal(res.swapped, false);
    assert.equal(res.current.value, '8081', '失败时应回报真实当前值');
    assert.equal(stateService.get('locks', 'playwright-port').value, '8081', '值不应被覆盖');
  });

  await t.test('按命名空间隔离', () => {
    stateService.set('other', 'playwright-port', '7000', 'agent-4');

    assert.equal(stateService.get('other', 'playwright-port').value, '7000');
    assert.equal(stateService.get('locks', 'playwright-port').value, '8081');
  });

  await t.test('每次写入广播 state:changed', () => {
    // 三次写入：初始 set、CAS 换值、命名空间隔离用的 set。
    assert.equal(changed.events.length, 3, '三次 set 各广播一次');
  });
});

test('消息总线', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, messageService } = h;

  coordinator.registerAgent({ id: 'codex-1', name: 'Codex 1', provider: 'codex', sessionId: 's1' });
  coordinator.registerAgent({ id: 'claude-2', name: 'Claude 2', provider: 'claude', sessionId: 's2' });

  const sent = capture(h.eventBus, 'message:sent');
  t.after(() => sent.stop());

  await t.test('定向消息只进收件人信箱', () => {
    messageService.send({
      from: 'codex-1',
      to: 'claude-2',
      content: 'InteractionResolver refactoring completed. Please rebase.',
      importance: 'urgent'
    });

    const inbox = messageService.inbox('claude-2');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].importance, 'urgent');
    assert.equal(inbox[0].from_agent, 'codex-1');
    assert.equal(inbox[0].content, 'InteractionResolver refactoring completed. Please rebase.');

    assert.equal(messageService.inbox('codex-1').length, 0, '发件人自己不应收到定向消息');
  });

  await t.test('广播消息对所有 agent 可见', () => {
    messageService.send({ from: 'codex-1', content: 'Rebasing window opens in 5 minutes.' });

    assert.equal(messageService.inbox('claude-2').length, 2, '收件人应看到定向 + 广播');
    assert.equal(messageService.inbox('codex-1').length, 1, '广播应回到发件人');
  });

  await t.test('发送广播 message:sent', () => {
    assert.equal(sent.events.length, 2);
  });
});

test('agent 列表查询', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator } = h;

  await t.test('按最近心跳排序返回全部 agent', () => {
    coordinator.registerAgent({ id: 'stale-1', name: '先注册', provider: 'codex', sessionId: 's1' });
    coordinator.registerAgent({ id: 'fresh-1', name: '后注册', provider: 'claude', sessionId: 's2' });

    // 两次注册可能落在同一毫秒，此时 last_heartbeat 相等、排序无定义。
    // 这里显式拉开心跳，固定住 listAgents 承诺的排序契约。
    h.db.prepare("UPDATE agents SET last_heartbeat = 1000 WHERE id = 'stale-1'").run();
    h.db.prepare("UPDATE agents SET last_heartbeat = 2000 WHERE id = 'fresh-1'").run();

    const agents = coordinator.listAgents();
    assert.equal(agents.length, 2);
    assert.equal(agents[0].id, 'fresh-1', '心跳较新的应排在前面');
    assert.equal(agents[1].id, 'stale-1', '心跳较旧的应排在后面');
  });

  await t.test('重复注册刷新心跳而不是产生新行', () => {
    coordinator.registerAgent({ id: 'stale-1', name: '先注册', provider: 'codex', sessionId: 's1' });

    const agents = coordinator.listAgents();
    assert.equal(agents.length, 2, '重复注册不应新增 agent');
    assert.equal(agents[0].id, 'stale-1', '刷新心跳后应排到最前');
  });

  await t.test('空库返回空数组', () => {
    const empty = createHarness();
    t.after(() => empty.close());

    assert.deepEqual(empty.coordinator.listAgents(), []);
  });
});

test('MCP 工具定义与分发', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { mcp, coordinator } = h;

  await t.test('暴露 5 个工具，声明 schema 完整', () => {
    assert.equal(NEXUS_TOOLS.length, 5);

    const declare = NEXUS_TOOLS.find((tool) => tool.name === 'nexus_declare_intent');
    assert.ok(declare, '应有 nexus_declare_intent');
    assert.deepEqual(declare.inputSchema.required, ['agent_id', 'summary', 'claims']);
    assert.deepEqual(
      declare.inputSchema.properties.claims.items.properties.type.enum,
      ['file', 'module', 'symbol'],
      'claim 类型枚举应覆盖三级资源'
    );
  });

  await t.test('nexus_declare_intent 授予租约', () => {
    const res = mcp('nexus_declare_intent', {
      agent_id: 'claude-mcp',
      summary: 'Testing via MCP tool',
      claims: [{ type: 'symbol', target: 'doAnalysis' }]
    });

    assert.equal(res.status, 'GRANTED');
    assert.ok(res.leaseId);
    assert.ok(coordinator.getAgent('claude-mcp'), '未注册 agent 应被自动补注册');
  });

  await t.test('nexus_status 返回协调总览', () => {
    const res = mcp('nexus_status', {});

    assert.ok(Array.isArray(res.agents));
    assert.ok(res.agents.length >= 1);
    assert.ok(Array.isArray(res.activeClaims));
    assert.ok(Array.isArray(res.timeline));
  });

  await t.test('nexus_state 走同一套共享状态', () => {
    mcp('nexus_state', { action: 'set', namespace: 'locks', key: 'port', value: '4300' });

    const res = mcp('nexus_state', { action: 'get', namespace: 'locks', key: 'port' });
    assert.equal(res.value, '4300');
  });

  await t.test('未知工具抛错而不是静默返回', () => {
    assert.throws(() => mcp('nexus_not_a_tool', {}), /Unknown Nexus MCP tool/);
  });
});

test('三级冲突判定与等待唤醒', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, eventBus } = h;

  coordinator.registerAgent({ id: 'a1', name: 'Agent 1', provider: 'codex', sessionId: 's1' });
  coordinator.registerAgent({ id: 'a2', name: 'Agent 2', provider: 'claude', sessionId: 's2' });

  await t.test('模块声明先到者拿到租约', () => {
    const res = coordinator.declareIntent({
      agentId: 'a1',
      intentSummary: 'Refactoring network module',
      claims: [{ type: 'module', target: 'src/network' }]
    });

    assert.equal(res.status, 'GRANTED');
  });

  await t.test('模块下的文件声明被层级规则挡住', () => {
    const res = coordinator.declareIntent({
      agentId: 'a2',
      intentSummary: 'Adding retry to http client',
      claims: [{ type: 'file', target: 'src/network/client.ts' }]
    });

    assert.equal(res.status, 'WAITING');
    assert.equal(res.blockedBy, 'a1');
    assert.match(res.reason, /Module conflict/);
  });

  await t.test('同路径不同大小写仍判为冲突', () => {
    const res = coordinator.declareIntent({
      agentId: 'a2',
      intentSummary: 'Touching the same file with different casing',
      claims: [{ type: 'file', target: 'src/network/CLIENT.ts' }]
    });

    assert.equal(res.status, 'WAITING', '路径归一化后应与已有声明冲突');
  });

  await t.test('无关文件不冲突', () => {
    const res = coordinator.declareIntent({
      agentId: 'a2',
      intentSummary: 'Editing an unrelated file',
      claims: [{ type: 'file', target: 'src/ui/Panel.tsx' }]
    });

    assert.equal(res.status, 'GRANTED');
  });

  await t.test('释放租约只唤醒队首等待者', () => {
    const woken = capture(eventBus, 'agent:woken');
    t.after(() => woken.stop());

    const before = h.db.prepare('SELECT count(*) AS n FROM wait_queue').get().n;
    assert.ok(before >= 2, `等待队列应至少有 2 项，实际 ${before}`);

    const res = coordinator.releaseLease(
      coordinator.db.prepare("SELECT id FROM leases WHERE agent_id = 'a1'").get().id,
      'a1'
    );

    assert.equal(res.success, true);
    assert.equal(woken.events.length, 1, '一次释放只唤醒一个等待者');
    assert.equal(woken.events[0].agent_id, 'a2');
  });

  await t.test('释放后原路径可再被占用', () => {
    const res = coordinator.declareIntent({
      agentId: 'a1',
      intentSummary: 'Re-entering the freed module',
      claims: [{ type: 'file', target: 'src/network/client.ts' }]
    });

    assert.equal(res.status, 'GRANTED');
  });
});

// 模块判冲按路径分段比较：同前缀但不同分支的兄弟目录不该互相阻塞。
// 这组用例逐条固定边界语义，任何一方改动都能立刻定位到具体关系。
test('模块判冲的路径边界', async (t) => {
  // held 持有 src/network，probe 的每个用例都用独立 agent，声明后即释放，互不干扰。
  const check = (claim) => {
    const h = createHarness();
    t.after(() => h.close());
    h.coordinator.registerAgent({ id: 'holder', name: 'holder', provider: 'codex', sessionId: 'sh' });
    h.coordinator.registerAgent({ id: 'probe', name: 'probe', provider: 'claude', sessionId: 'sp' });

    h.coordinator.declareIntent({
      agentId: 'holder',
      intentSummary: 'hold src/network',
      claims: [{ type: 'module', target: 'src/network' }]
    });

    return h.coordinator
      .declareIntent({ agentId: 'probe', intentSummary: 'probe', claims: [claim] })
      .status;
  };

  const shouldBlock = [
    ['模块内的文件', { type: 'file', target: 'src/network/client.ts' }],
    ['模块内的嵌套目录文件', { type: 'file', target: 'src/network/deep/nested.ts' }],
    ['模块本身', { type: 'module', target: 'src/network' }],
    ['嵌套子模块', { type: 'module', target: 'src/network/deep' }],
  ];

  const shouldPass = [
    ['同前缀兄弟目录', { type: 'file', target: 'src/network-legacy/index.ts' }],
    ['同前缀兄弟模块', { type: 'module', target: 'src/network-legacy' }],
    ['中间层同前缀', { type: 'file', target: 'src/network-utils/x.ts' }],
    ['无斜杠同前缀文件', { type: 'file', target: 'src/networkx' }],
    ['完全不同树', { type: 'file', target: 'src/ui/Panel.tsx' }],
  ];

  for (const [label, claim] of shouldBlock) {
    await t.test(`${label} 应被阻塞`, () => {
      assert.equal(check(claim), 'WAITING', `${JSON.stringify(claim)} 应命中 src/network 的租约`);
    });
  }

  for (const [label, claim] of shouldPass) {
    await t.test(`${label} 应放行`, () => {
      assert.equal(check(claim), 'GRANTED', `${JSON.stringify(claim)} 不该被 src/network 的租约挡住`);
    });
  }

  await t.test('pathsOverlap 直接单测', () => {
    const h = createHarness();
    t.after(() => h.close());
    const { pathsOverlap } = h.coordinator;

    assert.equal(pathsOverlap('a/b', 'a/b'), true, '相同路径应重叠');
    assert.equal(pathsOverlap('a/b', 'a/b/c'), true, '子路径应重叠');
    assert.equal(pathsOverlap('a/b/c', 'a/b'), true, '反向包含应重叠');
    assert.equal(pathsOverlap('a/b', 'a/bc'), false, '同前缀兄弟应不重叠');
    assert.equal(pathsOverlap('a/b', 'a/bc/d'), false, '中间层同前缀应不重叠');
    assert.equal(pathsOverlap('', 'a/b'), false, '空路径不匹配任何东西');
  });
});

// 唤醒队列过去是纯 FIFO（ORDER BY w.id）：不管队首此刻是否真能拿到资源，
// 一律唤醒它。等待期间资源可能已被别人抢走或继续被锁着，于是白唤醒一轮，
// 而后面那个其实已经能拿到的等待者被饿着。
test('唤醒队列按可用性复核并按 claim 宽窄重排', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator } = h;

  await t.test('跳过仍冲突的等待者，唤醒已经能拿到的那个', () => {
    // A 锁住 src/network，B 也要它 → 排队（队首）
    const a = coordinator.declareIntent({
      agentId: 'A', intentSummary: 'A', claims: [{ type: 'module', target: 'src/network' }]
    });
    const b = coordinator.declareIntent({
      agentId: 'B', intentSummary: 'B', claims: [{ type: 'module', target: 'src/network' }]
    });
    assert.equal(a.status, 'GRANTED');
    assert.equal(b.status, 'WAITING');

    // C 占住 pkg/other，D 也要它 → 后排队
    const c = coordinator.declareIntent({
      agentId: 'C', intentSummary: 'C', claims: [{ type: 'module', target: 'pkg/other' }]
    });
    const d = coordinator.declareIntent({
      agentId: 'D', intentSummary: 'D', claims: [{ type: 'module', target: 'pkg/other' }]
    });
    assert.equal(c.status, 'GRANTED');
    assert.equal(d.status, 'WAITING');

    // 释放 C：此时 B 仍被 A 挡着，D 已经能拿到 src 之外的那块
    const res = coordinator.releaseLease(c.leaseId, 'C');

    assert.equal(res.notifiedWaiter.agent_id, 'D',
      'B 仍被 A 挡着，应跳过它唤醒已可用的 D');
    assert.equal(res.stillBlocked, 1, 'B 应被记为仍在冲突');
    assert.equal(res.notifiedWaiter.intent_id, d.intentId);

    // B 确实还留在队列里，且仍标着被 A 阻塞
    const stillQueued = h.db.prepare('SELECT agent_id FROM wait_queue').all().map((r) => r.agent_id);
    assert.deepEqual(stillQueued, ['B']);
  });

  await t.test('宽声明排在窄声明之后', () => {
    const h2 = createHarness();
    t.after(() => h2.close());
    const co = h2.coordinator;

    // holder 占住 src，让下面两个（都在 src 之下）都进队列。
    // 不能用 '.'：claim 目标解析到工作目录会被 assertClaimTarget 拒掉。
    const holder = co.declareIntent({
      agentId: 'H', intentSummary: 'H', claims: [{ type: 'module', target: 'src' }]
    });
    assert.equal(holder.status, 'GRANTED');

    // 两条路径让"字符长度"与"路径段数"给出相反的顺序：
    //   src/a/b   → 42 字符， 7 段（深 = 范围窄）
    //   src/zzz…  → 69 字符， 6 段（浅 = 几乎和 src 一样宽）
    // 浅的那条字符更长、段数却更少，所以按长度升序会选错，按段数降序才对。
    // deep 先入队，shallow 后入队，只有排序真的生效才会选对。
    const deep = co.declareIntent({
      agentId: 'D', intentSummary: 'D', claims: [{ type: 'module', target: 'src/a/b' }]
    });
    const shallow = co.declareIntent({
      agentId: 'S', intentSummary: 'S',
      claims: [{ type: 'module', target: 'src/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }]
    });
    assert.equal(deep.status, 'WAITING');
    assert.equal(shallow.status, 'WAITING');

    // 断言可观察行为而不是重述排序 SQL：释放后谁被唤醒，就是排在前面的那个。
    // 宽度按路径段数降序算：段数多 = 钻得深 = 要的范围小，窄的先过。
    // claim 存的是归一化后的绝对路径，长度被工作目录前缀和目录名长度主导，
    // 与"要的范围有多大"无关——src/zzz… 只是个名字很长的浅目录。
    const res = co.releaseLease(holder.leaseId, 'H');
    assert.equal(res.notifiedWaiter.agent_id, 'D',
      'src/a/b 只占两个叶子目录，应先于那条名字更长却同样宽的浅目录被唤醒');

    // 宽的仍在队列里，等待下一轮（被唤醒者只是出队，并没有真的拿到租约）
    const stillQueued = h2.db.prepare('SELECT agent_id FROM wait_queue').all().map((r) => r.agent_id);
    assert.deepEqual(stillQueued, ['S']);
  });

  await t.test('唤醒事件带上已复核标记', () => {
    const h3 = createHarness();
    t.after(() => h3.close());
    const co = h3.coordinator;

    const a = co.declareIntent({
      agentId: 'A', intentSummary: 'A', claims: [{ type: 'module', target: 'src/x' }]
    });
    const b = co.declareIntent({
      agentId: 'B', intentSummary: 'B', claims: [{ type: 'module', target: 'src/x' }]
    });
    assert.equal(b.status, 'WAITING');

    const events = capture(h3.eventBus, 'agent:woken');
    co.releaseLease(a.leaseId, 'A');

    assert.equal(events.events.length, 1);
    assert.equal(events.events[0].verified, true, '选中时已复核过，应告知 agent');
    events.stop();
  });
});

test('核心状态机闭环与门禁防御增强', async (t) => {
  const h = createHarness();
  t.after(() => h.close());
  const { coordinator, mcp, eventBus } = h;

  await t.test('fastCheckAndAutoClaim 遇到模块锁时严格拦截而非放行', () => {
    coordinator.registerAgent({ id: 'mod-holder', name: 'Module Holder', provider: 'test', sessionId: 's1' });
    const dec = coordinator.declareIntent({
      agentId: 'mod-holder',
      intentSummary: 'Hold src/daemon module',
      claims: [{ type: 'module', target: 'src/daemon' }]
    });
    assert.equal(dec.status, 'GRANTED');

    // 另一个 Agent 尝试通过 Hook 门禁写入该模块下的文件
    const check = coordinator.fastCheckAndAutoClaim({
      agentId: 'file-writer',
      provider: 'test',
      sessionId: 's2',
      filePath: 'src/daemon/coordinator.js'
    });

    assert.equal(check.allow, false, '被模块锁包含的文件必须被拦截');
    assert.match(check.reason, /BLOCKED/, '拦截原因中应包含明确的 BLOCKED 提示');
    assert.equal(check.holder, 'Module Holder', '应准确回显持有者名称');
  });

  await t.test('expireLeases 超时后自动派发 resource:freed 并唤醒排队等待者', () => {
    coordinator.registerAgent({ id: 'agent-exp', name: 'Expiring Agent', provider: 'test', sessionId: 's1' });
    coordinator.registerAgent({ id: 'agent-wait', name: 'Waiting Agent', provider: 'test', sessionId: 's2' });

    const dec1 = coordinator.declareIntent({
      agentId: 'agent-exp',
      intentSummary: 'Hold file',
      claims: [{ type: 'file', target: 'src/timeout.js' }],
      ttlSeconds: 1 // 1 秒过期
    });
    assert.equal(dec1.status, 'GRANTED');

    const dec2 = coordinator.declareIntent({
      agentId: 'agent-wait',
      intentSummary: 'Wait for file',
      claims: [{ type: 'file', target: 'src/timeout.js' }]
    });
    assert.equal(dec2.status, 'WAITING');

    let freedFired = false;
    let wokenFired = false;
    eventBus.once('resource:freed', () => { freedFired = true; });
    eventBus.once('agent:woken', () => { wokenFired = true; });

    // 推进数据库时间使租约过期
    h.db.prepare("UPDATE leases SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, dec1.leaseId);

    coordinator.expireLeases();

    assert.equal(freedFired, true, '租约自然过期必须派发 resource:freed 事件');
    assert.equal(wokenFired, true, '租约自然过期必须唤醒队列里的合法等待者');

    // 等待者的 intent 状态应变为 released
    const updatedIntent = h.db.prepare("SELECT status FROM intents WHERE id = ?").get(dec2.intentId);
    assert.equal(updatedIntent.status, 'released');
  });

  await t.test('多租约 Agent 在部分租约释放后保持 running 状态，全部释放后才转 idle', () => {
    coordinator.registerAgent({ id: 'multi-agent', name: 'Multi Agent', provider: 'test', sessionId: 's1' });

    const decA = coordinator.declareIntent({
      agentId: 'multi-agent',
      intentSummary: 'Hold A',
      claims: [{ type: 'file', target: 'src/part_a.js' }]
    });
    const decB = coordinator.declareIntent({
      agentId: 'multi-agent',
      intentSummary: 'Hold B',
      claims: [{ type: 'file', target: 'src/part_b.js' }]
    });

    assert.equal(coordinator.getAgent('multi-agent').status, 'running');

    // 释放租约 A，租约 B 依然有效
    coordinator.releaseLease(decA.leaseId, 'multi-agent');
    assert.equal(coordinator.getAgent('multi-agent').status, 'running', '仍有其他租约时状态应维持 running');

    // 释放租约 B
    coordinator.releaseLease(decB.leaseId, 'multi-agent');
    assert.equal(coordinator.getAgent('multi-agent').status, 'idle', '所有租约释放后状态应转为 idle');
  });

  await t.test('MCP nexus_state 传入未知 action 时抛出 ValidationError', () => {
    assert.throws(() => {
      mcp('nexus_state', { action: 'invalid_action' });
    }, /Unsupported action/);
  });
});
