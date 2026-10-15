import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  NullAdapter,
  AnthropicAdapter,
  formatMessagesUrl,
  parseLlmConfig
} from '../src/domain/llm-adapter.js';

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

test('parseLlmConfig: 环境变量解析逻辑', () => {
  // 无 Key 时默认禁用
  const empty = parseLlmConfig({});
  assert.equal(empty.enabled, false);

  // 存在 Key 时默认激活
  const withKey = parseLlmConfig({ ANTHROPIC_API_KEY: 'test-key' });
  assert.equal(withKey.enabled, true);
  assert.equal(withKey.apiKey, 'test-key');
  assert.equal(withKey.model, 'claude-3-5-sonnet-latest');
  assert.equal(withKey.timeoutMs, 8000);

  // 显式禁用
  const disabled = parseLlmConfig({
    ANTHROPIC_API_KEY: 'test-key',
    NEXUS_LLM_ENABLED: 'false'
  });
  assert.equal(disabled.enabled, false);

  // 自定义配置
  const custom = parseLlmConfig({
    NEXUS_ANTHROPIC_API_KEY: 'nexus-key',
    ANTHROPIC_AUTH_TOKEN: 'bearer-tok',
    NEXUS_LLM_MODEL: 'claude-sonnet-4-6',
    NEXUS_LLM_TIMEOUT_MS: '5000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:4050'
  });
  assert.equal(custom.enabled, true);
  assert.equal(custom.apiKey, 'nexus-key');
  assert.equal(custom.authToken, 'bearer-tok');
  assert.equal(custom.model, 'claude-sonnet-4-6');
  assert.equal(custom.timeoutMs, 5000);
  assert.equal(custom.baseUrl, 'http://127.0.0.1:4050');
});

test('NullAdapter: 始终返回 null', async () => {
  const adapter = new NullAdapter();
  const res = await adapter.chat('system', 'user');
  assert.equal(res, null);
});

test('AnthropicAdapter: 无 Key 时直接返回 null', async () => {
  const adapter = new AnthropicAdapter();
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

test('AnthropicAdapter: 超时自动降级返回 null', async () => {
  const server = createServer((req, res) => {
    // 延迟 500ms 响应，但 adapter 只给 50ms 超时
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'Too late' }] }));
    }, 500);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 50
    });

    const t0 = Date.now();
    const res = await adapter.chat('Sys', 'User');
    const elapsed = Date.now() - t0;

    assert.equal(res, null);
    assert.ok(elapsed < 400, `Should abort quickly, elapsed: ${elapsed}ms`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('AnthropicAdapter: 远端 500 或格式畸形时安全降级', async () => {
  const server = createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      baseUrl: `http://127.0.0.1:${port}`
    });

    const res = await adapter.chat('Sys', 'User');
    assert.equal(res, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
