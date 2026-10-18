import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DaemonController } = require('../desktop/daemon-runner.cjs');

test('DaemonController: 守护进程探活与状态探测', async (t) => {
  let server;
  let testPort = 58941;

  await t.test('checkAlive: 端口未启动时返回 false', async () => {
    const controller = new DaemonController(testPort);
    const alive = await controller.checkAlive();
    assert.equal(alive, false);
  });

  await t.test('checkAlive: 探测目标端口正常 /health 返回 true', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve) => server.listen(testPort, '127.0.0.1', resolve));

    const controller = new DaemonController(testPort);
    const alive = await controller.checkAlive();
    assert.equal(alive, true);

    await new Promise((resolve) => server.close(resolve));
  });

  await t.test('getToken: 优先读取环境变量 NEXUS_TOKEN', () => {
    const originalEnv = process.env.NEXUS_TOKEN;
    try {
      process.env.NEXUS_TOKEN = 'test-token-12345';
      const controller = new DaemonController(testPort);
      assert.equal(controller.getToken(), 'test-token-12345');
    } finally {
      if (originalEnv) {
        process.env.NEXUS_TOKEN = originalEnv;
      } else {
        delete process.env.NEXUS_TOKEN;
      }
    }
  });

  await t.test('resolveNodeRuntime: 优先探测支持 node:sqlite 的系统 Node 解释器', () => {
    const controller = new DaemonController(testPort);
    const runtime = controller.resolveNodeRuntime();
    assert.ok(runtime.executable);
    assert.equal(typeof runtime.asNode, 'boolean');
  });
});
