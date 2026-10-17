import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { startMcpStdio } from '../src/mcp/stdio.js';
import { startTestDaemon } from './helpers.js';
import { ALL_NEXUS_TOOLS } from '../src/mcp/server.js';

async function waitForCount(arr, count, timeoutMs = 3000) {
  const start = Date.now();
  while (arr.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for response count ${count}, got ${arr.length}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('MCP Stdio Server: JSON-RPC 2.0 握手与工具列表', async (t) => {
  const daemon = await startTestDaemon();

  await t.test('initialize 与 tools/list 协议握手正常', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const responses = [];
    output.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        responses.push(JSON.parse(line));
      }
    });

    const mcp = startMcpStdio({
      baseUrl: daemon.base,
      token: daemon.operatorToken,
      projectId: 'test-mcp-proj',
      input,
      output
    });

    // 1. 发送 initialize
    input.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' }
    }) + '\n');

    await waitForCount(responses, 1);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.serverInfo.name, 'agent-nexus');
    assert.equal(responses[0].result.protocolVersion, '2024-11-05');

    // 2. 发送 tools/list
    input.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    }) + '\n');

    await waitForCount(responses, 2);
    assert.equal(responses.length, 2);
    assert.equal(responses[1].id, 2);
    const tools = responses[1].result.tools;
    assert.equal(tools.length, ALL_NEXUS_TOOLS.length);

    const toolNames = new Set(tools.map(t => t.name));
    assert.ok(toolNames.has('nexus_onboard'));
    assert.ok(toolNames.has('nexus_advise_plan'));
    assert.ok(toolNames.has('nexus_declare_intent'));
    assert.ok(toolNames.has('nexus_release_lease'));
    assert.ok(toolNames.has('nexus_report_milestone'));
    assert.ok(toolNames.has('nexus_search_memory'));
    assert.ok(toolNames.has('nexus_save_memory'));
    assert.ok(toolNames.has('nexus_broadcast'));
    assert.ok(toolNames.has('nexus_status'));

    mcp.close();
  });

  await t.test('tools/call 端到端调用：记忆存储与检索', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const responses = [];
    output.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        responses.push(JSON.parse(line));
      }
    });

    const mcp = startMcpStdio({
      baseUrl: daemon.base,
      token: daemon.operatorToken,
      projectId: 'proj-mcp-memory',
      input,
      output
    });

    // 1. 调用 nexus_save_memory
    input.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'nexus_save_memory',
        arguments: {
          category: 'architecture',
          key: 'oauth_flow',
          content: '项目必须严格遵照 OAuth 2.1 PKCE 规范'
        }
      }
    }) + '\n');

    await waitForCount(responses, 1);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, 10);
    assert.ok(!responses[0].result.isError);
    assert.match(responses[0].result.content[0].text, /oauth_flow/);

    // 2. 调用 nexus_search_memory
    input.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'nexus_search_memory',
        arguments: {
          query: 'PKCE'
        }
      }
    }) + '\n');

    await waitForCount(responses, 2);
    assert.equal(responses.length, 2);
    assert.equal(responses[1].id, 11);
    assert.ok(!responses[1].result.isError);
    assert.match(responses[1].result.content[0].text, /OAuth 2\.1 PKCE 规范/);

    mcp.close();
  });

  await t.test('tools/call 端到端调用：AI Tech Lead 进场申报与冲突走廊', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const responses = [];
    output.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        responses.push(JSON.parse(line));
      }
    });

    const mcp = startMcpStdio({
      baseUrl: daemon.base,
      token: daemon.operatorToken,
      projectId: 'proj-mcp-lead',
      input,
      output
    });

    // 1. 先通过 HTTP 模拟 agent-1 锁定了 core.js
    daemon.coordinator.registerAgent({
      id: 'agent-1',
      name: 'Agent Alpha',
      provider: 'claude',
      sessionId: 's1',
      projectId: 'proj-mcp-lead'
    });
    daemon.coordinator.declareIntent({
      agentId: 'agent-1',
      intentSummary: 'Refactoring core',
      claims: [{ type: 'file', target: 'src/core.js' }],
      projectId: 'proj-mcp-lead'
    });

    // 2. MCP 客户端代表 agent-2 进场申报
    input.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'nexus_onboard',
        arguments: {
          agent_id: 'agent-2',
          planned_work: [
            { type: 'file', target: 'src/core.js' },
            { type: 'file', target: 'src/utils.js' }
          ]
        }
      }
    }) + '\n');

    await waitForCount(responses, 1);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, 20);
    assert.ok(!responses[0].result.isError);

    const parsedContent = JSON.parse(responses[0].result.content[0].text);
    assert.equal(parsedContent.safeToStart.length, 1);
    assert.equal(parsedContent.safeToStart[0].target, 'src/utils.js');
    assert.equal(parsedContent.mustWait.length, 1);
    assert.equal(parsedContent.mustWait[0].target, 'src/core.js');

    mcp.close();
  });

  await daemon.close();
});
