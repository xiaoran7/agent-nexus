import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { CpaGatewayService } from '../src/domain/cpa-gateway.js';
import { startDaemon, stopDaemon } from '../src/daemon/index.js';

// 一个最小可用的假 CPA 管理接口，用来验证观测器的判定与缓存，
// 不连接任何真实服务，也不依赖外部网络。
function startFakeCpa({ secret = 'test-secret', payload = null } = {}) {
  const server = createServer((req, res) => {
    const authorized = req.headers.authorization === `Bearer ${secret}`;
    if (!authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    if (req.url.startsWith('/v0/management/auth-files')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload ?? {
        files: [
          { provider: 'antigravity', disabled: false, cooldowns: [], failed: 3, recent_requests: [{ success: 10, failed: 1 }] },
          { provider: 'antigravity', disabled: true, cooldowns: [{ scope: 'model' }], failed: 0, recent_requests: [] },
          { provider: 'codex', disabled: false, cooldowns: [], failed: 1, recent_requests: [{ success: 5, failed: 0 }] }
        ]
      }));
      return;
    }
    if (req.url.startsWith('/v0/management/config')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 'api-keys': ['a', 'b'], models: {}, 'request-log': true }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

test('CPA 网关只读观测 (CpaGatewayService)', async (t) => {
  await t.test('鉴权通过时汇总账号池、供应商与近期请求', async () => {
    const cpa = await startFakeCpa();
    try {
      const svc = new CpaGatewayService({
        endpoints: [{ baseUrl: cpa.baseUrl }],
        secret: 'test-secret'
      });
      const status = await svc.getStatus();

      assert.equal(status.reachable, true);
      assert.equal(status.unauthorized, undefined);
      assert.equal(status.managementAuthConfigured, true);
      assert.equal(status.auth.totalAccounts, 3);
      assert.equal(status.auth.enabledAccounts, 2);
      assert.equal(status.auth.disabledAccounts, 1);
      assert.equal(status.auth.coolingAccounts, 1);
      assert.equal(status.auth.failedCount, 4);
      assert.equal(status.auth.recentRequests.success, 15);
      assert.equal(status.auth.recentRequests.failed, 1);

      assert.equal(status.auth.providers[0].name, 'antigravity');
      assert.equal(status.auth.providers[0].count, 2);

      assert.equal(status.config.apiKeyCount, 2);
      assert.equal(status.config.requestLogEnabled, true);
    } finally {
      await cpa.close();
    }
  });

  await t.test('密钥错误时如实返回 unauthorized，不臆造账号数据', async () => {
    const cpa = await startFakeCpa({ secret: 'right-secret' });
    try {
      const svc = new CpaGatewayService({
        endpoints: [{ baseUrl: cpa.baseUrl }],
        secret: 'wrong-secret'
      });
      const status = await svc.getStatus();

      assert.equal(status.reachable, true);
      assert.equal(status.unauthorized, true);
      assert.equal(status.auth, null);
      assert.equal(status.config, null);
    } finally {
      await cpa.close();
    }
  });

  await t.test('端口无人监听时报告不可达，而不是抛错', async () => {
    // 绑定后立即释放，拿到一个确定没有服务的端口。
    const probe = await startFakeCpa();
    const deadPort = probe.port;
    await probe.close();

    const svc = new CpaGatewayService({
      endpoints: [{ baseUrl: `http://127.0.0.1:${deadPort}` }],
      secret: 'test-secret'
    });
    const status = await svc.getStatus();

    assert.equal(status.reachable, false);
    assert.equal(status.auth, null);
  });

  await t.test('缓存期内复用结果，force 时重新探测', async () => {
    const cpa = await startFakeCpa();
    try {
      let now = 1000;
      const svc = new CpaGatewayService({
        endpoints: [{ baseUrl: cpa.baseUrl }],
        secret: 'test-secret',
        now: () => now
      });

      const first = await svc.getStatus();
      assert.equal(first.cached, false);

      now += 3000;
      const second = await svc.getStatus();
      assert.equal(second.cached, true);

      now += 10_000;
      const third = await svc.getStatus();
      assert.equal(third.cached, false);

      const forced = await svc.getStatus({ force: true });
      assert.equal(forced.cached, false);
    } finally {
      await cpa.close();
    }
  });
});

test('GET /api/gateway 返回本机观测与各节点网关事实', async (t) => {
  const cpa = await startFakeCpa();
  const svc = new CpaGatewayService({
    endpoints: [{ baseUrl: cpa.baseUrl }],
    secret: 'test-secret'
  });

  const daemon = await startDaemon({
    port: 0,
    dbPath: ':memory:',
    isTest: true,
    writeSessionToken: false,
    cpaGatewayService: svc
  });
  const port = daemon.port;
  const token = Array.from(daemon.tokenStore.bySecret.keys())[0];

  t.after(async () => {
    await stopDaemon(daemon);
    await cpa.close();
  });

  const getJson = (path) => new Promise((resolve, reject) => {
    request({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (err) { reject(err); }
      });
    }).on('error', reject).end();
  });

  await t.test('本机观测结果直接透出', async () => {
    const { status, body } = await getJson('/api/gateway');
    assert.equal(status, 200);
    assert.equal(body.reachable, true);
    assert.equal(body.auth.totalAccounts, 3);
    assert.deepEqual(body.peers, []);
  });

  await t.test('边缘探针上报的网关事实随节点一并返回', async () => {
    daemon.clusterNodeService.recordHeartbeat('us-zenix', {
      role: 'edge',
      platform: 'linux',
      metadata: {
        gateway: {
          reachable: true,
          totalAccounts: 4,
          enabledAccounts: 4,
          coolingAccounts: 0,
          providers: [{ name: 'codex', count: 4 }],
          observedAt: Date.now()
        }
      }
    });
    daemon.clusterNodeService.recordHeartbeat('hub-node', {
      role: 'hub',
      metadata: { gateway: { reachable: false } }
    });

    const { body } = await getJson('/api/gateway');
    assert.equal(body.peers.length, 1, 'hub 节点不应出现在 peers 里');
    assert.equal(body.peers[0].node_id, 'us-zenix');
    assert.equal(body.peers[0].gateway.enabledAccounts, 4);
    assert.equal(body.peers[0].gateway.providers[0].name, 'codex');
  });
});
