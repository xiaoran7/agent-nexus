// =============================================================================
// test/remote-workspace-hub.test.js
// 验证「单中心 Hub 面板 + 多节点工作区（本机 Windows + 美西 us-zenix Linux）」统一纳管闭环：
//   1. 远端节点 PID 不被本机 process.kill 探针误杀（彻底修复 3 秒掉锁与幽灵离席）
//   2. Windows Hub 处理远端 POSIX 绝对/相对路径零盘符污染，跨会话精准互斥拦截
//   3. 本机与远端同名工程并存不互相吞并，自动标注 [us-zenix]
//   4. /api/agents/sync-remote 与 Hook 顺带捎带会话注册表，远端关窗自动回收租约
//   5. remote.json 持久化配置驱动全局 Hook 零环境变量直连中心 Hub
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHarness } from './helpers.js';
import { createDatabase } from '../src/storage/database.js';
import { startDaemon, stopDaemon } from '../src/daemon/index.js';
import { pushRemoteSessionsOnce } from '../src/daemon/bridge.js';
import { ProjectRegistry } from '../src/domain/project-registry.js';
import { resolveProject, canonicalizePath } from '../src/domain/project.js';
import { writeRemoteConfig, readRemoteConfig, clearRemoteConfig, resolveNexusEndpoint } from '../src/transport/auth.js';

const HOOK_SCRIPT = join(import.meta.dirname, '../src/hook/nexus-hook.mjs');

function runHookAsync(payload, envOverrides = {}, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT, ...args], {
      env: { ...process.env, ...envOverrides },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('跨平台异构路径：Windows Hub 解析 Linux POSIX 路径不污染盘符且 Project ID 稳定一致', () => {
  const posixRoot = '/root/Claudespace/Project/Agent-Nexus';
  const canonical = canonicalizePath(posixRoot);
  assert.equal(canonical, '/root/Claudespace/Project/Agent-Nexus', '不应被拼上 Windows 盘符或强转小写破坏 Linux 路径哈希');

  const pInfo = resolveProject(posixRoot);
  assert.equal(pInfo.projectRoot, '/root/Claudespace/Project/Agent-Nexus');
  assert.equal(pInfo.displayName, 'Agent-Nexus');
  assert.match(pInfo.projectId, /^[0-9a-f]{16}$/);
});

test('节点身份隔离：远端美西 (us-zenix) 会话持锁免疫本机 PID 探针误杀，本机死进程正常回收', () => {
  const h = createHarness();
  const { coordinator } = h;
  coordinator.localNodeId = 'win-workstation';

  const remoteProj = resolveProject('/root/Claudespace/Project/foo');

  // 美西会话上报一个本机绝对不存在的 PID (999998) 并申领文件写锁
  const claimRes = coordinator.fastCheckAndAutoClaim({
    agentId: 'claude-us-sess-1',
    hostId: 'us-zenix',
    name: '美西后端重构会话',
    provider: 'claude',
    sessionId: 'us-sess-1',
    filePath: 'src/server.js',
    workspaceDir: '/root/Claudespace/Project/foo',
    projectRoot: remoteProj.projectRoot,
    projectId: remoteProj.projectId,
    pid: 999998,
    livenessVerified: true
  });
  assert.equal(claimRes.allow, true);
  assert.equal(claimRes.autoClaimed, true);

  // 本机会话上报一个本机不存在的死亡 PID (999997) 并申领另一文件写锁
  const localClaim = coordinator.fastCheckAndAutoClaim({
    agentId: 'claude-local-dead-1',
    hostId: 'win-workstation',
    name: '本机崩溃会话',
    provider: 'claude',
    sessionId: 'local-dead-1',
    filePath: 'src/local.js',
    workspaceDir: 'D:/Claudespace/Project/bar',
    projectRoot: 'd:/claudespace/project/bar',
    projectId: 'localproj0000001',
    pid: 999997
  });
  assert.equal(localClaim.allow, true);

  // 触发守护进程每 3 秒一次的死亡 PID 租约收割器
  const reapRes = coordinator.reapDeadAgentLeases();
  assert.equal(reapRes.reapedCount, 1, '仅本机死亡 PID 会话应被回收');
  assert.equal(reapRes.deadAgents[0].agentId, 'claude-local-dead-1');

  // 检查面板全景快照：美西会话依然在线且施工锁完好无损！
  const snap = coordinator.getDashboardSnapshot('all');
  const usAgent = snap.agents.find(a => a.id === 'claude-us-sess-1');
  assert.ok(usAgent, '美西会话不应被误杀隐藏');
  assert.equal(usAgent.is_online, true);
  assert.equal(usAgent.is_remote, true);
  assert.equal(usAgent.host_id, 'us-zenix');
  assert.equal(usAgent.lifecycle_state, 'working');

  const usLock = snap.activeClaims.find(c => c.agent_id === 'claude-us-sess-1');
  assert.ok(usLock, '美西会话的文件编辑锁必须持续保留');
  assert.equal(usLock.claim_target, '/root/claudespace/project/foo/src/server.js');

  // 美西第二个会话尝试修改同一文件（传 POSIX 绝对路径），应被精准拦截
  const secondClaim = coordinator.fastCheckAndAutoClaim({
    agentId: 'claude-us-sess-2',
    hostId: 'us-zenix',
    name: '美西并发会话 2',
    provider: 'claude',
    sessionId: 'us-sess-2',
    filePath: '/root/Claudespace/Project/foo/src/server.js',
    workspaceDir: '/root/Claudespace/Project/foo',
    projectRoot: remoteProj.projectRoot,
    projectId: remoteProj.projectId,
    pid: 999996,
    livenessVerified: true
  });
  assert.equal(secondClaim.allow, false, '美西第二个会话改同一文件必须被主面板判冲拦截');
  assert.match(secondClaim.holder, /美西后端重构会话/);

  h.close();
});

test('同名跨机工程区分：本机与美西同名仓库在项目列表中并存且自动携带 [us-zenix] 标签', () => {
  const h = createHarness();
  const { db, coordinator, eventBus } = h;
  coordinator.localNodeId = 'win-workstation';
  const registry = new ProjectRegistry(db, coordinator, eventBus);

  const localProj = resolveProject('D:/Claudespace/Project/Agent-Nexus');
  const remoteProj = resolveProject('/root/Claudespace/Project/Agent-Nexus');
  assert.notEqual(localProj.projectId, remoteProj.projectId);

  coordinator.registerAgent({
    id: 'claude-local-1',
    hostId: 'win-workstation',
    name: '本机开发会话',
    provider: 'claude',
    sessionId: 'local-1',
    workspaceDir: 'D:/Claudespace/Project/Agent-Nexus',
    projectRoot: localProj.projectRoot,
    projectId: localProj.projectId
  });

  coordinator.registerAgent({
    id: 'claude-remote-1',
    hostId: 'us-zenix',
    name: '美西联调会话',
    provider: 'claude',
    sessionId: 'remote-1',
    workspaceDir: '/root/Claudespace/Project/Agent-Nexus',
    projectRoot: remoteProj.projectRoot,
    projectId: remoteProj.projectId
  });

  const projects = registry.listProjects();
  const matched = projects.filter(p => p.id === localProj.projectId || p.id === remoteProj.projectId);
  assert.equal(matched.length, 2, '本机与美西同名工程严禁互相吞并');

  const remoteItem = matched.find(p => p.id === remoteProj.projectId);
  const localItem = matched.find(p => p.id === localProj.projectId);
  assert.equal(remoteItem.display_name, 'Agent-Nexus [us-zenix]');
  assert.equal(remoteItem.is_remote, true);
  assert.equal(localItem.display_name, 'Agent-Nexus');
  assert.equal(localItem.is_remote, false);

  h.close();
});

test('端到端 HTTP 汇聚：/api/agents/sync-remote、remote.json 零环境变量 Hook 上报与远端关窗锁回收', async (t) => {
  const daemon = await startDaemon({
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    adminToken: 'hub_master_token_test_999',
    isTest: true
  });
  daemon.coordinator.localNodeId = 'win-workstation';
  t.after(() => stopDaemon(daemon));

  const hubUrl = `http://127.0.0.1:${daemon.port}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer hub_master_token_test_999'
  };

  // 1. 美西 Bridge 推送 2 个在席空闲会话至单面板 Hub
  const syncRes1 = await fetch(`${hubUrl}/api/agents/sync-remote`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      host_id: 'us-zenix',
      full_snapshot: true,
      sessions: [
        {
          pid: 88101,
          sessionId: 'zenix-sess-alpha',
          name: '美西沙箱联调 A',
          cwd: '/root/Claudespace/Project/gate',
          status: 'idle',
          alive: true,
          verified: true
        },
        {
          pid: 88102,
          sessionId: 'zenix-sess-beta',
          name: '美西沙箱联调 B',
          cwd: '/root/Claudespace/Project/gate',
          status: 'busy',
          alive: true,
          verified: true
        }
      ]
    })
  });
  assert.equal(syncRes1.status, 200);
  const syncJson1 = await syncRes1.json();
  assert.equal(syncJson1.added.length, 2);

  // 2. 通过 remote.json 驱动真实 nexus-hook.mjs 子进程，模拟美西会话 A 编辑文件
  const tempCfgDir = mkdtempSync(join(tmpdir(), 'nexus-remote-cfg-'));
  const remoteCfgFile = join(tempCfgDir, 'remote.json');
  t.after(() => rmSync(tempCfgDir, { recursive: true, force: true }));

  writeRemoteConfig({
    hubUrl,
    host: '127.0.0.1',
    port: daemon.port,
    token: 'hub_master_token_test_999',
    nodeId: 'us-zenix'
  }, remoteCfgFile);

  const ep = resolveNexusEndpoint({ remoteConfigPath: remoteCfgFile });
  assert.equal(ep.nodeId, 'us-zenix');
  assert.equal(ep.port, daemon.port);

  const hookEnv = {
    NEXUS_REMOTE_CONFIG_PATH: remoteCfgFile,
    NEXUS_TOKEN: '',
    NEXUS_ADMIN_TOKEN: '',
    NEXUS_HOST: '',
    NEXUS_PORT: '',
    CLAUDE_CODE_SESSION_ID: '',
    NEXUS_SESSION_ID: '',
    NEXUS_AGENT_PROVIDER: ''
  };

  const hookRun = await runHookAsync({
    session_id: 'zenix-sess-alpha',
    cwd: '/root/Claudespace/Project/gate',
    tool_name: 'Edit',
    tool_input: { file_path: '/root/Claudespace/Project/gate/src/proxy.js' }
  }, hookEnv);
  assert.equal(hookRun.status, 0, `Hook 应放行首个写入者，stderr=${hookRun.stderr}`);

  // 验证主面板 /api/dashboard 已实时捕获美西会话 A 的文件锁与工具态势，且未分裂成双卡片
  const dashRes1 = await fetch(`${hubUrl}/api/dashboard?project_id=all`, { headers });
  const dash1 = await dashRes1.json();
  const alphaMatches = dash1.agents.filter(a => a.session_id === 'zenix-sess-alpha');
  assert.equal(alphaMatches.length, 1, '同一远端会话不得分裂为 claude-* 与 agent-* 两条记录');
  const alpha = alphaMatches[0];
  assert.equal(alpha.host_id, 'us-zenix');
  assert.equal(alpha.is_remote, true);
  assert.equal(alpha.last_tool, 'Edit');
  assert.equal(dash1.activeClaims.length, 1);

  // 3. 模拟美西会话 B 修改同一文件，Hook 应返回退出码 2 拦截
  const hookBlocked = await runHookAsync({
    session_id: 'zenix-sess-beta',
    cwd: '/root/Claudespace/Project/gate',
    tool_name: 'Write',
    tool_input: { file_path: '/root/Claudespace/Project/gate/src/proxy.js' }
  }, hookEnv);
  assert.equal(hookBlocked.status, 2, '同一美西项目并发改同一文件应被中心 Hub 拦截');
  assert.match(hookBlocked.stderr, /BLOCKED/);

  // 4. 模拟美西会话 A 关闭终端退出，下一轮 sync-remote 仅剩会话 B：会话 A 应自动离席并释放文件锁
  const syncRes2 = await fetch(`${hubUrl}/api/agents/sync-remote`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      host_id: 'us-zenix',
      full_snapshot: true,
      sessions: [
        {
          pid: 88102,
          sessionId: 'zenix-sess-beta',
          name: '美西沙箱联调 B',
          cwd: '/root/Claudespace/Project/gate',
          status: 'busy',
          alive: true,
          verified: true
        }
      ]
    })
  });
  const syncJson2 = await syncRes2.json();
  assert.ok(syncJson2.departed.includes('claude-zenix-sess-alpha'), '已退出的远端会话应被识别为 departed');

  const dashRes2 = await fetch(`${hubUrl}/api/dashboard?project_id=all`, { headers });
  const dash2 = await dashRes2.json();
  assert.equal(dash2.activeClaims.length, 0, '远端退出会话的文件锁应立即自动回收');
  assert.equal(dash2.agents.some(a => a.session_id === 'zenix-sess-alpha'), false, '离席会话不再出现在在线快照中');
});

test('Edge Bridge 与远端连接配置生命周期：扫描本地活跃会话推送至 Hub，disconnect 干净还原', async (t) => {
  const daemon = await startDaemon({
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    adminToken: 'bridge_token_abc',
    isTest: true
  });
  daemon.coordinator.localNodeId = 'win-workstation';
  t.after(() => stopDaemon(daemon));

  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-bridge-test-'));
  const sessionsDir = join(tempDir, 'sessions');
  const remoteCfgPath = join(tempDir, 'remote.json');
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const { mkdirSync } = await import('node:fs');
  mkdirSync(sessionsDir, { recursive: true });

  // 写入一个由当前真实存活进程 PID 背书的模拟会话文件，以及一个不存在的死进程会话文件
  writeFileSync(join(sessionsDir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid,
    sessionId: 'bridge-live-uuid-001',
    name: '美西 Bridge 实时发现会话',
    cwd: '/root/Claudespace/Project/Agent-Nexus',
    status: 'idle'
  }));
  writeFileSync(join(sessionsDir, '999995.json'), JSON.stringify({
    pid: 999995,
    sessionId: 'bridge-dead-uuid-002',
    name: '美西残留死进程会话',
    cwd: '/root/Claudespace/Project/Agent-Nexus',
    status: 'idle'
  }));

  writeRemoteConfig({
    hubUrl: `http://127.0.0.1:${daemon.port}`,
    host: '127.0.0.1',
    port: daemon.port,
    token: 'bridge_token_abc',
    nodeId: 'us-zenix'
  }, remoteCfgPath);

  const pushRes = await pushRemoteSessionsOnce({
    remoteConfigPath: remoteCfgPath,
    sessionsDir
  });
  assert.equal(pushRes.scanned, 1, 'Bridge 应在边缘本地过滤掉死进程，仅上报真实存活会话');
  assert.equal(pushRes.added.length, 1);

  const snap = daemon.coordinator.getDashboardSnapshot('all');
  const bridged = snap.agents.find(a => a.session_id === 'bridge-live-uuid-001');
  assert.ok(bridged);
  assert.equal(bridged.host_id, 'us-zenix');
  assert.equal(bridged.is_remote, true);

  // 验证 clearRemoteConfig 清理还原
  const cleared = clearRemoteConfig(remoteCfgPath);
  assert.equal(cleared, true);
  assert.equal(readRemoteConfig(remoteCfgPath), null);
});

test('存量旧版数据库平滑迁移：旧版无 host_id 列的 nexus.db 启动时不报 SQL logic error', (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-legacy-db-'));
  const legacyDbPath = join(tempDir, 'legacy.db');
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const oldDb = new DatabaseSync(legacyDbPath);
  oldDb.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      root_path TEXT NOT NULL,
      display_name TEXT,
      created_at INTEGER NOT NULL,
      last_activity INTEGER NOT NULL
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      workspace_dir TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      last_heartbeat INTEGER NOT NULL,
      registered_at INTEGER NOT NULL
    );
  `);
  oldDb.close();

  const upgradedDb = createDatabase(legacyDbPath);
  const defaultProj = upgradedDb.prepare('SELECT id, host_id FROM projects WHERE id = ?').get('default');
  assert.equal(defaultProj.id, 'default');
  assert.equal(defaultProj.host_id, 'local');
  upgradedDb.close();
});


