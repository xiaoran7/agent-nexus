import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startDaemon, stopDaemon } from '../src/daemon/index.js';

// 子代理派发树：只记录真实发生过的事件。
// 这些用例守的是"不臆造"这条底线——没有 SubagentStart 就不该出现节点，
// 没有 SubagentStop 就不该显示完成。

async function startTestDaemon(t) {
  const daemon = await startDaemon({
    port: 0,
    dbPath: ':memory:',
    isTest: true,
    writeSessionToken: false
  });
  const port = daemon.port;
  const token = Array.from(daemon.tokenStore.bySecret.keys())[0];
  t.after(() => stopDaemon(daemon));

  const call = (method, path, payload) => new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {})
      }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

  return { daemon, call };
}

test('子代理派发树 (agent spawns)', async (t) => {
  await t.test('没收到 SubagentStart 时，看板里没有任何子代理节点', async (t2) => {
    const { call } = await startTestDaemon(t2);
    const { status, body } = await call('GET', '/api/dashboard');
    assert.equal(status, 200);
    assert.deepEqual(body.agentSpawns, [], '没有任何上报就不该凭空长出节点');
  });

  await t.test('派发登记后出现在树上，收工后才标完成', async (t2) => {
    const { call } = await startTestDaemon(t2);

    await call('POST', '/api/hook/subagent-start', {
      agent_id: 'agent-aaa111',
      session_id: 'sess-1',
      agent_type: 'Explore',
      description: '查看数据库结构',
      model: 'sonnet',
      run_in_background: true,
      project_id: 'proj-a'
    });

    let dashboard = (await call('GET', '/api/dashboard?project_id=proj-a')).body;
    assert.equal(dashboard.agentSpawns.length, 1, '一个会话一棵树');
    const tree = dashboard.agentSpawns[0];
    assert.equal(tree.session_id, 'sess-1');
    assert.equal(tree.roots.length, 1);
    const node = tree.roots[0];
    assert.equal(node.agent_key, 'aaa111', 'Hook 的 agent- 前缀应被剥掉，与磁盘 id 对齐');
    assert.equal(node.agent_type, 'Explore');
    assert.equal(node.description, '查看数据库结构');
    assert.equal(node.model, 'sonnet');
    assert.equal(node.run_in_background, true);
    assert.equal(node.status, 'running');
    assert.equal(node.ended_at, null, '没收工就不该有结束时间');
    assert.equal(node.children.length, 0);

    await call('POST', '/api/hook/subagent-stop', {
      agent_id: 'agent-aaa111',
      session_id: 'sess-1',
      project_id: 'proj-a'
    });

    dashboard = (await call('GET', '/api/dashboard?project_id=proj-a')).body;
    const done = dashboard.agentSpawns[0].roots[0];
    assert.equal(done.status, 'done');
    assert.ok(done.ended_at >= done.started_at);
    assert.ok(done.duration_ms >= 0);
  });

  await t.test('嵌套子代理挂到派发它的子代理下，而不是平铺到会话', async (t2) => {
    const { call } = await startTestDaemon(t2);

    await call('POST', '/api/hook/subagent-start', {
      agent_id: 'parent01', session_id: 'sess-nest', agent_type: 'Plan', description: '顶层'
    });
    await call('POST', '/api/hook/subagent-start', {
      agent_id: 'child01', session_id: 'sess-nest', agent_type: 'Explore',
      description: '孙代理', parent_agent_id: 'parent01', spawn_depth: 2
    });

    const dashboard = (await call('GET', '/api/dashboard')).body;
    const tree = dashboard.agentSpawns.find((s) => s.session_id === 'sess-nest');
    assert.equal(tree.roots.length, 1, '一级子代理才是根');
    assert.equal(tree.roots[0].agent_key, 'parent01');
    assert.equal(tree.roots[0].children.length, 1);
    assert.equal(tree.roots[0].children[0].agent_key, 'child01');
    assert.equal(tree.roots[0].children[0].spawn_depth, 2);
  });

  await t.test('漏掉 SubagentStart 时按转录首条时间补真实开工点，不拿当前时刻冒充', async (t2) => {
    const { call } = await startTestDaemon(t2);
    const realStart = Date.now() - 90_000;

    await call('POST', '/api/hook/subagent-stop', {
      agent_id: 'orphan1', session_id: 'sess-orphan',
      agent_type: 'Explore', started_at: realStart
    });

    const dashboard = (await call('GET', '/api/dashboard')).body;
    const tree = dashboard.agentSpawns.find((s) => s.session_id === 'sess-orphan');
    assert.ok(tree, '收工事件本身也是证据，应该留痕');
    const node = tree.roots[0];
    assert.equal(node.status, 'done');
    assert.equal(node.started_at, realStart, '开始时间必须来自真实转录时间戳');
    assert.ok(node.duration_ms >= 89_000, '时长据此计算，不是 0');
  });

  await t.test('重复的 SubagentStart 幂等，不会长出第二个节点，也不重置计时', async (t2) => {
    const { call } = await startTestDaemon(t2);

    await call('POST', '/api/hook/subagent-start', {
      agent_id: 'dup1', session_id: 'sess-dup', agent_type: 'Plan', description: '第一次'
    });
    const first = (await call('GET', '/api/dashboard')).body.agentSpawns
      .find((s) => s.session_id === 'sess-dup').roots[0];

    await new Promise((r) => setTimeout(r, 15));
    await call('POST', '/api/hook/subagent-start', {
      agent_id: 'dup1', session_id: 'sess-dup', agent_type: 'Plan', description: '第二次'
    });
    const second = (await call('GET', '/api/dashboard')).body.agentSpawns
      .find((s) => s.session_id === 'sess-dup').roots[0];

    assert.equal(second.id, first.id, '同一子代理只有一行');
    assert.equal(second.started_at, first.started_at, '重复上报不得重置开工时间');
    assert.equal(second.status, 'running');
  });

  await t.test('子代理工具调用只刷新已登记的行，不会凭空造节点', async (t2) => {
    const { daemon } = await startTestDaemon(t2);

    const ghost = daemon.coordinator.touchAgentSpawn({
      agentId: 'never-registered', sessionId: 'sess-ghost'
    });
    assert.equal(ghost, null, '没有 SubagentStart 就没有这一行');
    assert.equal(daemon.coordinator.listAgentSpawns().length, 0);

    daemon.coordinator.recordAgentSpawn({ agentId: 'real1', sessionId: 'sess-real' });
    const touched = daemon.coordinator.touchAgentSpawn({
      agentId: 'real1', sessionId: 'sess-real', toolName: 'Read', toolTarget: 'src/a.js'
    });
    assert.ok(touched, '已登记的子代理应被刷新');

    const row = daemon.coordinator.listAgentSpawns().find((r) => r.id === touched);
    assert.equal(row.last_tool, 'Read');
    assert.equal(row.last_target, 'src/a.js');
  });

  await t.test('缺 agent_id 或 session_id 时返回 400，不写脏行', async (t2) => {
    const { call, daemon } = await startTestDaemon(t2);

    assert.equal((await call('POST', '/api/hook/subagent-start', { session_id: 's' })).status, 400);
    assert.equal((await call('POST', '/api/hook/subagent-start', { agent_id: 'a1' })).status, 400);
    assert.equal((await call('POST', '/api/hook/subagent-stop', {})).status, 400);
    assert.equal(daemon.coordinator.listAgentSpawns().length, 0);
  });

  await t.test('工程过滤生效：不同 project 的树互不串场', async (t2) => {
    const { call } = await startTestDaemon(t2);

    await call('POST', '/api/hook/subagent-start', {
      agent_id: 'p1a', session_id: 's-proj1', project_id: 'proj-1'
    });
    await call('POST', '/api/hook/subagent-start', {
      agent_id: 'p2a', session_id: 's-proj2', project_id: 'proj-2'
    });

    const onlyOne = (await call('GET', '/api/dashboard?project_id=proj-1')).body;
    assert.equal(onlyOne.agentSpawns.length, 1);
    assert.equal(onlyOne.agentSpawns[0].project_id, 'proj-1');

    const all = (await call('GET', '/api/dashboard?project_id=all')).body;
    assert.equal(all.agentSpawns.length, 2);
  });
});
