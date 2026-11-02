import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';
import { startTestDaemon } from './helpers.js';

test('Multi-Machine Real-World Simulation: Hub + Remote Edge Probe + Hook Injection + WebSocket', async () => {
  // 清理缓存避免历史测试干扰
  const cacheFile = join(homedir(), '.agent-nexus', '.notified-handoffs.json');
  try { if (existsSync(cacheFile)) unlinkSync(cacheFile); } catch {}

  // 1. 启动真实的 Hub Daemon (HTTP + WebSocket + 内存数据库)
  const daemon = await startTestDaemon({ nodeId: 'local-windows' });
  const hubUrl = daemon.base;
  const token = daemon.operatorToken;

  try {
    // 2. 模拟远端 Linux 工作机 "us-zenix" 的边缘探针 (Edge Probe) 发送周期心跳
    const edgeHeartbeatRes = await daemon.request('/api/cluster/heartbeat', {
      method: 'POST',
      body: {
        node_id: 'us-zenix',
        display_name: 'us-zenix (Remote Linux)',
        role: 'edge',
        platform: 'linux',
        ip: '10.0.0.88',
        metadata: { probe_version: '0.2.31', claude_sessions_count: 1 }
      }
    });
    assert.equal(edgeHeartbeatRes.status, 200);
    assert.equal(edgeHeartbeatRes.json.ok, true);
    assert.equal(edgeHeartbeatRes.json.node.id, 'us-zenix');
    assert.equal(edgeHeartbeatRes.json.node.status, 'online');

    // 3. 验证 Hub 端仪表盘 / 拓扑接口正确识别了该远端边缘节点
    const nodesRes = await daemon.request('/api/cluster/nodes');
    assert.equal(nodesRes.status, 200);
    const nodes = nodesRes.json;
    assert.ok(nodes.some(n => n.id === 'us-zenix' && n.status === 'online'));
    assert.ok(nodes.some(n => n.id === 'local-windows' && n.role === 'hub'));

    // 4. 模拟本地工作会话 (agent-win-1) 完成阶段开发任务并触发提交收尾
    // 4.1 声明意图并获取文件锁
    const claimRes = await daemon.request('/api/intents/declare', {
      method: 'POST',
      body: {
        agent_id: 'agent-win-1',
        project_id: 'default',
        intent_summary: '完成核心状态机与接力机制代码开发',
        claims: [{ type: 'file', target: 'src/daemon/coordinator.js' }]
      }
    });
    assert.equal(claimRes.status, 200);
    assert.equal(claimRes.json.status, 'GRANTED');

    // 4.2 本地会话执行 git commit，触发生命周期释放与阶段工单自动合成
    const releaseRes = await daemon.request('/api/hook/git-release', {
      method: 'POST',
      body: {
        agent_id: 'agent-win-1',
        host_id: 'local-windows',
        project_id: 'default',
        reason: 'git_lifecycle'
      }
    });
    assert.equal(releaseRes.status, 200);
    assert.ok(releaseRes.json.releasedCount >= 1);

    // 4.3 校验 Hub 端已自动合成接力工单
    const handoffsRes = await daemon.request('/api/handoffs?project_id=default');
    assert.equal(handoffsRes.status, 200);
    assert.ok(handoffsRes.json.length >= 1);
    const latestHandoff = handoffsRes.json[0];
    assert.equal(latestHandoff.status, 'pending');
    assert.equal(latestHandoff.source_host_id, 'local-windows');
    assert.ok(latestHandoff.modified_files.some(f => f.includes('coordinator.js')), `modified_files should contain coordinator.js, got: ${JSON.stringify(latestHandoff.modified_files)}`);

    // 5. 模拟远端机器 "us-zenix" 上新开的 Claude Code 会话 (agent-zenix-worker)
    // 远端 Agent 首次执行只读命令 (例如 Read 或 Bash 探活)
    // 执行真实 Hook 子进程，传入环境变量 NEXUS_HUB_URL 与 NEXUS_TOKEN
    const hookPath = join(import.meta.dirname, '../src/hook/nexus-hook.mjs');

    const runHook = (payload, envOverrides = {}) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hookPath], {
        env: {
          ...process.env,
          NEXUS_HUB_URL: hubUrl,
          NEXUS_TOKEN: token,
          NEXUS_NODE_ID: 'us-zenix',
          NEXUS_HOST: '127.0.0.1',
          NEXUS_PORT: String(daemon.port),
          ...envOverrides
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', c => stdout += c);
      child.stderr.on('data', c => stderr += c);
      child.on('close', code => resolve({ status: code, stdout, stderr }));
      child.on('error', reject);
      child.stdin.end(JSON.stringify(payload));
    });

    const hookRes = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/daemon/coordinator.js' },
      session_id: 'zenix-session-001',
      cwd: process.cwd()
    });

    // 验证 Hook 退出码为 0 (正常放行)，且在 stderr 输出了跨机接力上下文提示！
    assert.equal(hookRes.status, 0);
    assert.ok(hookRes.stderr.includes('跨机接力上下文'), `stderr should contain handoff info, got: ${hookRes.stderr}`);
    assert.ok(hookRes.stderr.includes('local-windows'));
    assert.ok(hookRes.stderr.includes('coordinator.js'));

    // 6. 验证同一次 session 下后续工具调用不会重复刷屏骚扰
    const secondHookRes = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 'zenix-session-001',
      cwd: process.cwd()
    });

    assert.equal(secondHookRes.status, 0);
    // 第二次调用同 session 不重复打印
    assert.ok(!secondHookRes.stderr.includes('跨机接力上下文'));

    // 7. 远端会话认领并闭环该工单
    const consumeRes = await daemon.request(`/api/handoffs/${latestHandoff.id}/consume`, {
      method: 'POST',
      body: { agent_id: 'agent-zenix-worker' }
    });
    assert.equal(consumeRes.status, 200);
    assert.equal(consumeRes.json.success, true);
    assert.equal(consumeRes.json.handoff.status, 'in_progress');

    // 8. 验证 Dashboard 快照完整包含算力节点与接力数据
    const dashRes = await daemon.request('/api/dashboard?project_id=default');
    assert.equal(dashRes.status, 200);
    assert.ok(dashRes.json.clusterNodes);
    assert.ok(dashRes.json.clusterNodes.some(n => n.id === 'us-zenix'));
    assert.ok(dashRes.json.activeHandoffs);
  } finally {
    await daemon.close();
  }
});
