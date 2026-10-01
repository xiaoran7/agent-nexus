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
