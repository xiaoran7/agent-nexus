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

  await t.test('isAlive: HTTP 探活失败但进程还在时不算离线', async () => {
    const client = new ProbeClient(testPort);
    // testPort 上没有服务，HTTP 一定失败；isProcessUp 读 ~/.agent-nexus/probe.json。
    // 这里只断言兜底路径不会把「进程活着」判成死——具体取决于本机是否装了探针。
    const result = await client.isAlive();
    if (client.isProcessUp()) {
      assert.equal(result.alive, true);
      assert.equal(result.status, 'degraded');
    } else {
      assert.equal(result.alive, false);
    }
  });
});

// 闪屏回归：面板状态机必须做到「单次抖动不翻页、失败后指数退避、已在面板上不重复加载」。
const { PanelState, isPanelKillingFailure } = require('../desktop/panel-state.cjs');

test('PanelState: 面板与离线页之间不再每 3 秒来回翻', async (t) => {
  await t.test('单次探活失败不翻离线页', () => {
    const s = new PanelState();
    assert.equal(s.onHealthResult(false, { isShowingPanel: true }), null);
    assert.equal(s.onHealthResult(false, { isShowingPanel: true }), null);
    assert.equal(s.onHealthResult(true, { isShowingPanel: true }), null);
  });

  await t.test('连续失败达阈值才翻离线页，且已在离线页时不重复翻', () => {
    const s = new PanelState();
    s.onHealthResult(false, { isShowingPanel: true });
    s.onHealthResult(false, { isShowingPanel: true });
    assert.equal(s.onHealthResult(false, { isShowingPanel: true }), 'offline');
    assert.equal(s.onHealthResult(false, { isShowingPanel: false }), null);
  });

  await t.test('探针恢复后切回面板；已在面板上则不重复 loadURL', () => {
    const s = new PanelState();
    assert.equal(s.onHealthResult(true, { isShowingPanel: false }), 'panel');
    assert.equal(s.onHealthResult(true, { isShowingPanel: true }), null);
  });

  await t.test('加载失败按 3s→6s→12s 退避，成功后归零', () => {
    const s = new PanelState();
    assert.equal(s.onPanelLoadFailed().retryInMs, 3000);
    assert.equal(s.onPanelLoadFailed().retryInMs, 6000);
    assert.equal(s.onPanelLoadFailed().retryInMs, 12000);
    s.onPanelLoadSucceeded();
    assert.equal(s.onPanelLoadFailed().retryInMs, 3000);
  });

  await t.test('退避封顶 60 秒，不会无限增长', () => {
    const s = new PanelState();
    let last = 0;
    for (let i = 0; i < 12; i++) last = s.onPanelLoadFailed().retryInMs;
    assert.equal(last, 60000);
  });

  await t.test('只有主框架的真实失败才把面板踢下线', () => {
    assert.equal(isPanelKillingFailure({ errorCode: -105, validatedURL: 'http://127.0.0.1:4300/' }), true);
    assert.equal(isPanelKillingFailure({ errorCode: -105, validatedURL: 'http://x/', isMainFrame: false }), false);
    assert.equal(isPanelKillingFailure({ errorCode: -3, validatedURL: 'http://x/' }), false);
    assert.equal(isPanelKillingFailure({ errorCode: -105, validatedURL: 'file:///offline.html' }), false);
  });
});
