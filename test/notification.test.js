import test from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon, stopDaemon } from '../src/daemon/index.js';
import { request } from 'node:http';

test('主动通知总线与 SSE 实时事件流', async (t) => {
  const daemon = await startDaemon({ port: 0, dbPath: ':memory:' });
  const port = daemon.port;
  const token = Array.from(daemon.tokenStore.bySecret.keys())[0];

  t.after(async () => {
    await stopDaemon(daemon);
  });

  await t.test('GET /api/events 建立 SSE 长连接并接收事件', async () => {
    let receivedData = '';

    const sseReq = request({
      host: '127.0.0.1',
      port,
      path: `/api/events?project_id=proj-sse&token=${token}`,
      method: 'GET'
    }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'text/event-stream');
      res.on('data', chunk => {
        receivedData += chunk.toString();
      });
    });

    sseReq.end();

    // 等待连接握手完成
    await new Promise(r => setTimeout(r, 80));

    // 触发一个目标项目的事件
    daemon.eventBus.emit('milestone:reached', {
      project_id: 'proj-sse',
      agent_id: 'worker-sse',
      description: 'API v2 shipped'
    });

    await new Promise(r => setTimeout(r, 80));

    sseReq.destroy();
    assert.match(receivedData, /API v2 shipped/);
  });

  await t.test('一个 SSE 客户端断开连接不会抹除其他客户端或总线的事件监听', async () => {
    let client1Data = '';
    let client2Data = '';

    const req1 = request({
      host: '127.0.0.1',
      port,
      path: `/api/events?project_id=multi-sse&token=${token}`,
      method: 'GET'
    }, (res) => {
      res.on('data', chunk => client1Data += chunk.toString());
    });
    req1.end();

    const req2 = request({
      host: '127.0.0.1',
      port,
      path: `/api/events?project_id=multi-sse&token=${token}`,
      method: 'GET'
    }, (res) => {
      res.on('data', chunk => client2Data += chunk.toString());
    });
    req2.end();

    await new Promise(r => setTimeout(r, 60));

    // 客户端 1 断开连接
    req1.destroy();
    await new Promise(r => setTimeout(r, 60));

    // 触发事件，客户端 2 必须依然能正常收到
    daemon.eventBus.emit('milestone:reached', {
      project_id: 'multi-sse',
      agent_id: 'worker-2',
      description: 'Second Client Still Alive'
    });

    await new Promise(r => setTimeout(r, 80));
    req2.destroy();

    assert.match(client2Data, /Second Client Still Alive/, '客户端 1 离线后，客户端 2 必须依然能够收到事件');
  });

  await t.test('静态资源内存缓存正常分发且带有正确的 Content-Type', async () => {
    const fetchPath = (p) => new Promise((resolve) => {
      request({
        host: '127.0.0.1',
        port,
        path: p,
        method: 'GET'
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }).end();
    });

    const htmlRes = await fetchPath('/');
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers['content-type'], /text\/html/);
    assert.match(htmlRes.body, /Agent-Nexus War Room/);

    const cssRes = await fetchPath('/style.css');
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers['content-type'], /text\/css/);
    assert.match(cssRes.body, /--schale-sky/);

    const jsRes = await fetchPath('/app.js');
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers['content-type'], /javascript/);
    assert.match(jsRes.body, /escapeHtml/);
  });

  await t.test('租约释放时主动向总线派发 resource:freed', async () => {
    let freedEvent = null;
    daemon.eventBus.once('resource:freed', (p) => {
      freedEvent = p;
    });

    daemon.coordinator.registerAgent({ id: 'worker-rf', name: 'Worker RF', provider: 'test', sessionId: 'srf', projectId: 'proj-rf' });
    const dec = daemon.coordinator.declareIntent({
      agentId: 'worker-rf',
      intentSummary: 'Holding lock',
      claims: [{ type: 'file', target: 'src/core.js' }],
      projectId: 'proj-rf'
    });

    daemon.coordinator.releaseLease(dec.leaseId, 'worker-rf');

    assert.ok(freedEvent);
    assert.equal(freedEvent.project_id, 'proj-rf');
    assert.equal(freedEvent.resources.length, 1);
    assert.equal(freedEvent.resources[0].type, 'file');
  });
});
