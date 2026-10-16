import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  NullAdapter,
  AnthropicAdapter,
  OpenAiAdapter,
  GatewayRouterAdapter,
  formatMessagesUrl,
  formatOpenAiUrl,
  parseLlmConfig
} from '../src/domain/llm-adapter.js';
import { GatewayRouter } from '../src/domain/gateway-router.js';

test('formatMessagesUrl: 智能补齐与格式化各类反代及官方地址', () => {
  assert.equal(formatMessagesUrl('https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1/messages');
  assert.equal(formatMessagesUrl('https://api.anthropic.com/v1/'), 'https://api.anthropic.com/v1/messages');
  assert.equal(formatMessagesUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  assert.equal(formatMessagesUrl('http://127.0.0.1:4050'), 'http://127.0.0.1:4050/v1/messages');
  assert.equal(formatMessagesUrl('http://127.0.0.1:4050/v1'), 'http://127.0.0.1:4050/v1/messages');
  assert.equal(formatMessagesUrl('http://127.0.0.1:4050/messages'), 'http://127.0.0.1:4050/messages');
  assert.equal(formatMessagesUrl('http://127.0.0.1:4050/v1/messages'), 'http://127.0.0.1:4050/v1/messages');
  assert.equal(formatMessagesUrl('ai-gateway.example.com'), 'https://ai-gateway.example.com/v1/messages');
});

test('formatOpenAiUrl: 智能补齐与格式化各类 OpenAI 反代及官方地址', () => {
  assert.equal(formatOpenAiUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(formatOpenAiUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(formatOpenAiUrl('https://api.openai.com'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(formatOpenAiUrl('http://127.0.0.1:8000'), 'http://127.0.0.1:8000/v1/chat/completions');
  assert.equal(formatOpenAiUrl('http://127.0.0.1:8000/v1'), 'http://127.0.0.1:8000/v1/chat/completions');
  assert.equal(formatOpenAiUrl('http://127.0.0.1:8000/chat/completions'), 'http://127.0.0.1:8000/chat/completions');
});

test('parseLlmConfig: 环境变量解析逻辑与多候选组网', () => {
  // 无 Key 时默认禁用
  const empty = parseLlmConfig({});
  assert.equal(empty.enabled, false);
  assert.equal(empty.candidates.length, 0);

  // 存在 Anthropic Key 时默认单候选
  const withKey = parseLlmConfig({ ANTHROPIC_API_KEY: 'test-key' });
  assert.equal(withKey.enabled, true);
  assert.equal(withKey.apiKey, 'test-key');
  assert.equal(withKey.model, 'claude-3-5-sonnet-latest');
  assert.equal(withKey.timeoutMs, 8000);
  assert.equal(withKey.candidates.length, 1);
  assert.equal(withKey.candidates[0].provider, 'anthropic');

  // 同时存在 Anthropic 和 OpenAI Key 时自动组建双候选主备链
  const dual = parseLlmConfig({
    ANTHROPIC_API_KEY: 'ant-key',
    OPENAI_API_KEY: 'oai-key'
  });
  assert.equal(dual.enabled, true);
  assert.equal(dual.candidates.length, 2);
  assert.equal(dual.candidates[0].provider, 'anthropic');
  assert.equal(dual.candidates[0].priority, 0);
  assert.equal(dual.candidates[1].provider, 'openai');
  assert.equal(dual.candidates[1].priority, 1);

  // 显式 JSON 候选者配置
  const explicit = parseLlmConfig({
    NEXUS_GATEWAY_CANDIDATES: JSON.stringify([
      { id: 'deepseek', provider: 'openai', model: 'deepseek-chat', apiKey: 'ds-key', baseUrl: 'https://api.deepseek.com' },
      { id: 'claude', provider: 'anthropic', model: 'claude-3-5-haiku-20241022', apiKey: 'cl-key' }
    ])
  });
  assert.equal(explicit.enabled, true);
  assert.equal(explicit.candidates.length, 2);
  assert.equal(explicit.candidates[0].id, 'deepseek');
  assert.equal(explicit.candidates[0].provider, 'openai');
  assert.equal(explicit.candidates[1].id, 'claude');
  assert.equal(explicit.candidates[1].provider, 'anthropic');
});

test('NullAdapter: 始终返回 null', async () => {
  const adapter = new NullAdapter();
  const res = await adapter.chat('system', 'user');
  assert.equal(res, null);
});

test('AnthropicAdapter: 成功请求并解析文本内容', async () => {
  let receivedHeaders = null;
  let receivedBody = null;

  const server = createServer(async (req, res) => {
    receivedHeaders = req.headers;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      receivedBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        content: [
          { type: 'text', text: '建议先写 mock 接口，再进行集成测试。' }
        ]
      }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      authToken: 'auth-test',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'claude-3-5-sonnet-latest'
    });

    const res = await adapter.chat('System Instruction', 'User Request');
    assert.deepEqual(res, { content: '建议先写 mock 接口，再进行集成测试。' });
    assert.equal(receivedHeaders['x-api-key'], 'sk-ant-test');
    assert.equal(receivedHeaders['authorization'], 'Bearer auth-test');
    assert.equal(receivedBody.system, 'System Instruction');
    assert.equal(receivedBody.messages[0].content, 'User Request');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('OpenAiAdapter: 成功请求并解析 Chat Completions 协议', async () => {
  let receivedHeaders = null;
  let receivedBody = null;

  const server = createServer(async (req, res) => {
    receivedHeaders = req.headers;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      receivedBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          { message: { role: 'assistant', content: 'OpenAI 建议优先重构数据库连接池。' } }
        ]
      }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const adapter = new OpenAiAdapter({
      apiKey: 'sk-openai-test',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'gpt-4o-mini'
    });

    const res = await adapter.chat('System Instruction', 'User Request');
    assert.deepEqual(res, { content: 'OpenAI 建议优先重构数据库连接池。' });
    assert.equal(receivedHeaders['authorization'], 'Bearer sk-openai-test');
    assert.equal(receivedBody.model, 'gpt-4o-mini');
    assert.equal(receivedBody.messages[0].role, 'system');
    assert.equal(receivedBody.messages[1].role, 'user');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('GatewayRouterAdapter: 包装网关并正常返回结果与溯源信息', async () => {
  const router = new GatewayRouter();
  router.addCandidate({
    id: 'mock-cand',
    provider: 'mock',
    adapter: {
      async chatWithDetails() {
        return { ok: true, status: 200, content: '网关调度输出' };
      }
    }
  });

  const adapter = new GatewayRouterAdapter(router);
  const res = await adapter.chat('sys', 'user');
  assert.equal(res.content, '网关调度输出');
  assert.equal(res._gateway.candidateId, 'mock-cand');
});
