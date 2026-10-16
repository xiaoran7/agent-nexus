import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAILURE_TYPES,
  classifyFailure,
  resetsIn,
  Candidate,
  selectSmart,
  selectOrdered,
  selectRotate,
  selectLeastUsed,
  GatewayRouter
} from '../src/domain/gateway-router.js';
import { startTestDaemon } from './helpers.js';

test('classifyFailure: 精准归因各类 HTTP 状态与错误实体', () => {
  // 1. 认证失败
  assert.equal(classifyFailure(401, {}, '{"error":"unauthorized"}'), FAILURE_TYPES.AUTH);
  assert.equal(classifyFailure(403, {}, '{"error":{"type":"authentication_error"}}'), FAILURE_TYPES.AUTH);

  // 2. 欠费 / 余额不足 (402 或 body 匹配欠费关键字)
  assert.equal(classifyFailure(402, {}, 'Payment required'), FAILURE_TYPES.CREDIT);
  assert.equal(classifyFailure(400, {}, 'insufficient balance in account'), FAILURE_TYPES.CREDIT);
  assert.equal(classifyFailure(429, {}, 'credits are exhausted, please recharge'), FAILURE_TYPES.CREDIT);
  assert.equal(classifyFailure(400, {}, '当前账户余额不足，请充值'), FAILURE_TYPES.CREDIT);

  // 3. 配额耗尽 (Quota)
  assert.equal(classifyFailure(429, {}, 'monthly quota exceeded'), FAILURE_TYPES.QUOTA);
  assert.equal(classifyFailure(429, {}, 'You have hit your daily usage limit'), FAILURE_TYPES.QUOTA);
  assert.equal(classifyFailure(429, {}, '当前套餐用量限额已用完'), FAILURE_TYPES.QUOTA);

  // 4. 短时频控 (Rate Limit)
  assert.equal(classifyFailure(429, {}, 'Too many requests, rate limit exceeded (RPM limit)'), FAILURE_TYPES.RATE);
  assert.equal(classifyFailure(429, {}, '请求太频繁，请稍后再试'), FAILURE_TYPES.RATE);

  // 5. 上游服务故障或超载 (500, 502, 503, 504, 529)
  assert.equal(classifyFailure(500, {}, 'Internal Server Error'), FAILURE_TYPES.SERVER);
  assert.equal(classifyFailure(502, {}, 'Bad Gateway'), FAILURE_TYPES.SERVER);
  assert.equal(classifyFailure(529, {}, 'Anthropic is overloaded'), FAILURE_TYPES.SERVER);

  // 6. 网络超时与中断
  assert.equal(classifyFailure(0, {}, '', new Error('The operation was aborted')), FAILURE_TYPES.TIMEOUT);
  const connErr = new Error('connect ETIMEDOUT');
  connErr.code = 'ETIMEDOUT';
  assert.equal(classifyFailure(0, {}, '', connErr), FAILURE_TYPES.TIMEOUT);
});

test('resetsIn: 解析 Retry-After、限流标头与时间戳', () => {
  // Retry-After 秒数
  assert.equal(resetsIn({ 'retry-after': '5' }), 5000);

  // Anthropic / OpenAI 重置标头（秒数）
  assert.equal(resetsIn({ 'anthropic-ratelimit-unified-reset': '12' }), 12000);

  // 5xx 服务端错误指数退避
  assert.equal(resetsIn({}, '', FAILURE_TYPES.SERVER, 0), 15000);
  assert.equal(resetsIn({}, '', FAILURE_TYPES.SERVER, 1), 30000);
  assert.equal(resetsIn({}, '', FAILURE_TYPES.SERVER, 2), 45000);
});

test('Candidate: 运行态生命周期、休眠与恢复', () => {
  const c = new Candidate({
    id: 'test-node',
    provider: 'anthropic',
    adapter: { chatWithDetails: async () => ({ ok: true }) }
  });

  assert.equal(c.isResting(), false);
  assert.equal(c.remainingRestMs(), 0);

  // 模拟记录一次限频失败
  c.recordFailure(FAILURE_TYPES.RATE, 2000, { status: 429 });
  assert.equal(c.isResting(), true);
  assert.ok(c.remainingRestMs() > 0);
  assert.equal(c.consecutiveFailures, 1);
  assert.equal(c.failureCount, 1);

  // 导出 JSON 不暴露内部敏感对象
  const json = c.toSafeJson();
  assert.equal(json.id, 'test-node');
  assert.equal(json.resting, true);

  // 手动 reset 立即解除休眠
  c.reset();
  assert.equal(c.isResting(), false);
  assert.equal(c.consecutiveFailures, 0);

  // 记录一次成功
  c.recordSuccess(120);
  assert.equal(c.successCount, 1);
  assert.equal(c.lastLatencyMs, 120);
});

test('Routing Strategies: 多策略算法正确性', () => {
  const c1 = new Candidate({ id: 'c1', priority: 0, weight: 1, adapter: {} });
  const c2 = new Candidate({ id: 'c2', priority: 1, weight: 2, adapter: {} });
  const c3 = new Candidate({ id: 'c3', priority: 2, weight: 1, adapter: {} });

  // Ordered
  const ordered = selectOrdered([c3, c1, c2]);
  assert.deepEqual(ordered.map(c => c.id), ['c1', 'c2', 'c3']);

  // Rotate
  const state = { turn: 0 };
  const r1 = selectRotate([c1, c2, c3], state);
  assert.deepEqual(r1.map(c => c.id), ['c1', 'c2', 'c3']);
  const r2 = selectRotate([c1, c2, c3], state);
  assert.deepEqual(r2.map(c => c.id), ['c2', 'c3', 'c1']);

  // Smart (带 affinityKey 亲和性)
  const s1 = selectSmart([c1, c2, c3], { affinityKey: 'project-alpha' });
  const s2 = selectSmart([c1, c2, c3], { affinityKey: 'project-alpha' });
  assert.equal(s1[0].id, s2[0].id, '同一项目亲和性必须稳定路由至相同主选节点');

  // LeastUsed
  c1.totalRequests = 10; // load = 10 / 1 = 10
  c2.totalRequests = 10; // load = 10 / 2 = 5
  c3.totalRequests = 2;  // load = 2 / 1 = 2
  const least = selectLeastUsed([c1, c2, c3]);
  assert.equal(least[0].id, 'c3');
  assert.equal(least[1].id, 'c2');
  assert.equal(least[2].id, 'c1');
});

test('GatewayRouter: 无感故障转移与熔断休眠', async () => {
  const router = new GatewayRouter({ strategy: 'ordered' });

  // 候选者 1 模拟 529 服务端过载
  let c1Calls = 0;
  router.addCandidate({
    id: 'primary-overloaded',
    priority: 0,
    adapter: {
      async chatWithDetails() {
        c1Calls++;
        return { ok: false, status: 529, body: 'Anthropic is temporarily overloaded' };
      }
    }
  });

  // 候选者 2 模拟正常可用
  let c2Calls = 0;
  router.addCandidate({
    id: 'backup-healthy',
    priority: 1,
    adapter: {
      async chatWithDetails() {
        c2Calls++;
        return { ok: true, status: 200, content: '来自备用节点的成功回复' };
      }
    }
  });

  // 第一次请求：应该先试 c1 失败，然后无缝 fallback 到 c2
  const res1 = await router.routeAndExecute('sys', 'user');
  assert.ok(res1);
  assert.equal(res1.content, '来自备用节点的成功回复');
  assert.equal(res1.candidateId, 'backup-healthy');
  assert.equal(c1Calls, 1);
  assert.equal(c2Calls, 1);

  // 验证 c1 已经进入休眠熔断状态
  const cands = router.getCandidates();
  const c1Meta = cands.find(c => c.id === 'primary-overloaded');
  assert.equal(c1Meta.resting, true);

  // 第二次请求：c1 处于休眠，网关应 0 延时跳过 c1，直接调用 c2
  const res2 = await router.routeAndExecute('sys', 'user');
  assert.ok(res2);
  assert.equal(res2.candidateId, 'backup-healthy');
  assert.equal(c1Calls, 1, 'c1 休眠中，不应受到任何二次请求冲击');
  assert.equal(c2Calls, 2);

  // 手动 reset c1 恢复健康
  router.resetCandidate('primary-overloaded');
  const c1Restored = router.getCandidates().find(c => c.id === 'primary-overloaded');
  assert.equal(c1Restored.resting, false);
});

test('REST Endpoints: /api/gateway/route, /chat 与 /reset 接口端到端验证', async (t) => {
  const d = await startTestDaemon();
  t.after(() => d.close());

  // 动态添加一个 mock candidate 到 d.projectRegistry.gatewayRouter
  d.projectRegistry.gatewayRouter.addCandidate({
    id: 'rest-mock-cand',
    name: 'Rest Mock Candidate',
    provider: 'mock',
    adapter: {
      async chatWithDetails(sys, user) {
        return { ok: true, status: 200, content: `Echo: ${user}` };
      }
    }
  });

  // 1. GET /api/gateway/status
  const statusRes = await d.request('/api/gateway/status');
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.json.candidateCount, 1);
  assert.equal(statusRes.json.candidates[0].id, 'rest-mock-cand');

  // 2. POST /api/gateway/chat
  const chatRes = await d.request('/api/gateway/chat', {
    method: 'POST',
    body: {
      system_prompt: 'sys',
      user_message: 'hello gateway'
    }
  });
  assert.equal(chatRes.status, 200);
  assert.equal(chatRes.json.content, 'Echo: hello gateway');
  assert.equal(chatRes.json.candidateId, 'rest-mock-cand');

  // 3. POST /api/gateway/reset
  const resetRes = await d.request('/api/gateway/reset', {
    method: 'POST',
    body: { id: 'rest-mock-cand' }
  });
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.json.success, true);
  assert.equal(resetRes.json.resetId, 'rest-mock-cand');
});
