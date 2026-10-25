import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProbeClient } = require('../desktop/probe-client.cjs');

// 桌面端现在是纯客户端：它只探活、读令牌、拼面板地址，绝不拉起探针。
test('ProbeClient: 只连探针，不托管探针', async (t) => {
  let server;
  const testPort = 58941;

  await t.test('checkAlive: 探针未启动时返回 alive=false', async () => {
    const client = new ProbeClient(testPort);
    const result = await client.checkAlive();
    assert.equal(result.alive, false);
  });

  await t.test('checkAlive: 探针 /health 正常时带回版本号', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '9.9.9' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve) => server.listen(testPort, '127.0.0.1', resolve));

    const client = new ProbeClient(testPort);
    const result = await client.checkAlive();
    assert.equal(result.alive, true);
    assert.equal(result.version, '9.9.9');

    await new Promise((resolve) => server.close(resolve));
  });

  await t.test('getToken: 优先读取环境变量 NEXUS_TOKEN', () => {
    const originalEnv = process.env.NEXUS_TOKEN;
    try {
      process.env.NEXUS_TOKEN = 'test-token-12345';
      const client = new ProbeClient(testPort);
      assert.equal(client.getToken(), 'test-token-12345');
    } finally {
      if (originalEnv) process.env.NEXUS_TOKEN = originalEnv;
      else delete process.env.NEXUS_TOKEN;
    }
  });

  await t.test('panelUrl: 令牌编码进查询参数，且指向探针而非桌面端自身', () => {
    const originalEnv = process.env.NEXUS_TOKEN;
    try {
      process.env.NEXUS_TOKEN = 'tok/en+with=special';
      const client = new ProbeClient(testPort);
      const url = client.panelUrl();
      assert.ok(url.startsWith(`http://127.0.0.1:${testPort}/?token=`));
      assert.ok(url.includes(encodeURIComponent('tok/en+with=special')));
    } finally {
      if (originalEnv) process.env.NEXUS_TOKEN = originalEnv;
      else delete process.env.NEXUS_TOKEN;
    }
  });

  await t.test('桌面端不再暴露拉起探针的能力', () => {
    const client = new ProbeClient(testPort);
    assert.equal(typeof client.ensureDaemonRunning, 'undefined');
    assert.equal(typeof client.shutdown, 'undefined');
    assert.equal(typeof client.resolveNodeRuntime, 'undefined');
  });
});
