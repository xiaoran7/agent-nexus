#!/usr/bin/env node
import { appendFileSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { startEdgeBridge, pushRemoteSessionsOnce } from './daemon/bridge.js';
import { installAll, installClaudeHook, installCodexHook, installZCodeHook, installProjectMcp } from './installer/index.js';
import { resolveProject, getLocalNodeId } from './domain/project.js';
import { startMcpStdio } from './mcp/stdio.js';
import { readSessionToken, writeRemoteConfig, clearRemoteConfig, resolveNexusEndpoint } from './transport/auth.js';
import {
  installProbe,
  uninstallProbe,
  startProbe,
  stopProbe,
  probeStatus,
  writeProbePid,
  writeProbeState,
  readProbeState,
  clearProbeState,
  getProbeLogPath
} from './probe/index.js';

const cmd = process.argv[2];

const hooks = {
  '--claude': installClaudeHook,
  '--codex': installCodexHook,
  '--zcode': installZCodeHook
};

if (cmd === 'start') {
  runDaemon({ managed: false });
} else if (cmd === 'probe') {
  runDaemon({ managed: true });
} else if (cmd === 'probe:install') {
  probeInstall();
} else if (cmd === 'probe:uninstall') {
  probeUninstall();
} else if (cmd === 'probe:start') {
  probeStart();
} else if (cmd === 'probe:stop') {
  probeStop();
} else if (cmd === 'probe:status') {
  probeReport();
} else if (cmd === 'connect') {
  connectRemoteHub();
} else if (cmd === 'disconnect') {
  disconnectRemoteHub();
} else if (cmd === 'bridge') {
  runEdgeBridge();
} else if (cmd === 'token') {
  issueToken();
} else if (cmd === 'projects') {
  listProjects();
} else if (cmd === 'project') {
  showProjectInfo(process.argv[3]);
} else if (cmd === 'hook:install') {
  const target = process.argv[3];
  (hooks[target] || installAll)();
} else if (cmd === 'mcp') {
  runMcpStdio();
} else if (cmd === 'mcp:install') {
  const targetDir = process.argv[3] || process.cwd();
  installProjectMcp(targetDir);
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h' || !cmd) {
  printHelp();
} else {
  console.error(`Unknown command: ${cmd}\n`);
  printHelp();
  process.exit(1);
}

// 探针是无人值守进程：日志不能指望启动器（cmd/VBS）重定向——
// 实测 detached 启动时 `>>` 会静默丢输出。这里由进程自己接管 stdout/stderr，
// 保证崩溃与启动失败在 probe.log 里一定留痕。
function redirectProbeOutput() {
  const logPath = getProbeLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    const fd = openSync(logPath, 'a');
    const write = (chunk, encoding, callback) => {
      try {
        writeSync(fd, typeof chunk === 'string' ? chunk : Buffer.from(chunk));
      } catch {}
      if (typeof encoding === 'function') encoding();
      else if (typeof callback === 'function') callback();
      return true;
    };
    process.stdout.write = write;
    process.stderr.write = write;
    const stamp = new Date().toISOString();
    writeSync(fd, `\n[Agent-Nexus] Probe starting (pid ${process.pid}) at ${stamp}\n`);
  } catch {}
}

function runDaemon({ managed }) {
  if (managed) redirectProbeOutput();
  const opts = managed ? parseDaemonArgs() : {};

  // edge 探针：不监听端口、不建本地库，只把本机会话快照推给中心 Hub。
  if (opts.edge) {
    runEdgeProbe(opts);
    return;
  }

  import('./daemon/index.js')
    .then(({ startDaemon, stopDaemon }) =>
      startDaemon({ ...opts, probe: managed }).then((daemon) => {
        if (managed) {
          try {
            writeProbePid(process.pid);
            writeProbeState({ pid: process.pid, port: daemon.port, host: daemon.host, startedAt: Date.now() });
          } catch {}
        }
        const shutdown = async () => {
          if (managed) {
            try {
              clearProbeState();
            } catch {}
          } else {
            console.log('\n[Agent-Nexus] Gracefully shutting down daemon...');
          }
          try {
            await stopDaemon(daemon);
            if (!managed) console.log('[Agent-Nexus] Daemon stopped cleanly.');
            process.exit(0);
          } catch (err) {
            console.error('[Agent-Nexus] Error during shutdown:', err);
            process.exit(1);
          }
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        // 兜底：任何走到退出（含未捕获异常触发的 process.exit）的路径都清掉 PID 文件。
        // 否则被强杀/崩溃后残留的 PID 会一路带到下次升级，probe:stop 只认文件时就会空转。
        process.on('exit', () => {
          if (!managed) return;
          try {
            const state = readProbeState();
            // 只清自己写的那份：防止后来者（新探针）的 PID 被旧进程的退出钩子误删。
            if (!state || state.pid === process.pid) clearProbeState();
          } catch {}
        });
      })
    )
    .catch((err) => {
      const message = `\n[Agent-Nexus] Startup failed:\n${err.message}\n`;
      if (managed) {
        try {
          writeProbeState({ pid: process.pid, error: err.message, failedAt: Date.now() });
          appendFileSync(getProbeLogPath(), message);
        } catch {}
      } else {
        console.error(message);
      }
      process.exit(1);
    });
}

function parseDaemonArgs() {
  const args = process.argv.slice(3);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) opts.port = parseInt(args[++i], 10);
    else if (args[i] === '--host' && args[i + 1]) opts.host = args[++i];
    else if (args[i] === '--edge') opts.edge = true;
    else if ((args[i] === '--node' || args[i] === '--node-id') && args[i + 1]) opts.nodeId = args[++i];
  }
  return opts;
}

function runEdgeProbe(opts) {
  const bridge = startEdgeBridge({ ...(opts.nodeId ? { nodeId: opts.nodeId } : {}) });
  console.log(`[Agent-Nexus Probe] Edge mode: watching ${bridge.sessionsDir} as node [${bridge.endpoint.nodeId}] -> ${bridge.endpoint.baseUrl}`);
  if (!bridge.endpoint.token) {
    console.error('[Agent-Nexus Probe] No Hub token found. Run `nexus connect --hub <url> --token <tok> --node <name>` first.');
    process.exit(1);
  }

  try {
    writeProbePid(process.pid);
    writeProbeState({
      pid: process.pid,
      role: 'edge',
      nodeId: bridge.endpoint.nodeId,
      hubUrl: bridge.endpoint.baseUrl,
      startedAt: Date.now()
    });
  } catch {}

  const shutdown = () => {
    bridge.stop();
    try {
      clearProbeState();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function probeInstall() {
  const args = process.argv.slice(3);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) opts.port = parseInt(args[++i], 10);
    else if (args[i] === '--host' && args[i + 1]) opts.host = args[++i];
    else if (args[i] === '--edge') opts.role = 'edge';
    else if ((args[i] === '--node' || args[i] === '--node-id') && args[i + 1]) opts.nodeId = args[++i];
    else if (args[i] === '--no-start') opts.start = false;
  }

  installProbe(opts)
    .then((res) => {
      const edge = res.entry.role === 'edge';
      console.log(`[Agent-Nexus] Background probe installed (${edge ? 'edge' : 'hub'} role).`);
      console.log(`  • Node runtime: ${res.node}`);
      if (edge) console.log(`  • Edge node:    ${res.entry.nodeId}`);
      console.log(`  • Launcher:     ${res.launcherPath}`);
      console.log(`  • Auto-start:   ${res.autostartPath}`);
      console.log(`  • Log:          ${getProbeLogPath()}`);
      console.log(`  • Running now:  ${res.started ? 'yes' : 'no (starts on next login, or run `nexus probe:start`)'}`);
      if (edge) {
        console.log('\n  Edge probe pushes this machine\'s sessions to the central Hub; it opens no port.');
      } else {
        console.log('\n  The desktop app is a pure client now: open it any time, it attaches to this probe.');
      }
    })
    .catch((err) => {
      console.error(`\n[Agent-Nexus] Probe install failed:\n${err.message}\n`);
      process.exit(1);
    });
}

function probeUninstall() {
  uninstallProbe()
    .then((res) => {
      console.log('[Agent-Nexus] Background probe removed.');
      for (const file of res.removed) console.log(`  • removed ${file}`);
      console.log(`  • auto-start entry: ${res.autostartPath}`);
    })
    .catch((err) => {
      console.error(`\n[Agent-Nexus] Probe uninstall failed:\n${err.message}\n`);
      process.exit(1);
    });
}

function probeStart() {
  startProbe()
    .then((res) => {
      const where = res.baseUrl || (res.pid ? `pid ${res.pid}` : '');
      if (res.alreadyRunning) {
        console.log(`[Agent-Nexus] Probe already running${where ? ` at ${where}` : ''}${res.version ? ` (v${res.version})` : ''}.`);
      } else {
        console.log(`[Agent-Nexus] Probe started${where ? ` at ${where}` : ''}${res.version ? ` (v${res.version})` : ''}.`);
      }
    })
    .catch((err) => {
      console.error(`\n[Agent-Nexus] Probe start failed:\n${err.message}\n`);
      process.exit(1);
    });
}

function probeStop() {
  stopProbe()
    .then((res) => {
      if (res.stopped) {
        const recovered = res.recoveredByPort ? ` (PID 文件失真，已按端口 ${res.port ?? 4300} 反查定位并结束)` : '';
        console.log(`[Agent-Nexus] Probe stopped${recovered}.`);
      } else {
        console.error(
          `[Agent-Nexus] Probe is still running on port 4300. ` +
          `Something else may be holding the port; check with \`netstat -ano | findstr :4300\`.`
        );
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(`\n[Agent-Nexus] Probe stop failed:\n${err.message}\n`);
      process.exit(1);
    });
}

async function probeReport() {
  const status = await probeStatus();
  const edge = status.role === 'edge';
  console.log('\n[Agent-Nexus] Background probe status:');
  console.log(`  Role:       ${status.role}`);
  console.log(`  Installed:  ${status.installed ? 'yes' : 'no'}`);
  console.log(`  Running:    ${status.running ? 'yes' : 'no'}`);
  console.log(`  Endpoint:   ${edge ? (status.hubUrl ? `edge -> ${status.hubUrl}` : 'edge -> (no Hub bound)') : status.baseUrl}`);
  if (edge) console.log(`  Edge node:  ${status.state?.nodeId ?? status.entry?.nodeId ?? '(unknown)'}`);
  const pidLabel = status.pid ?? (status.stalePid ? `${status.stalePid} (stale)` : '(none)');
  const pidSuffix = status.pidSource === 'port' ? ` (按端口 ${status.port} 反查)` : '';
  console.log(`  PID:        ${pidLabel}${pidSuffix}`);
  console.log(`  Version:    ${status.version ?? '(unknown)'}`);
  console.log(`  Auto-start: ${status.autostartPath}`);
  console.log(`  Log:        ${status.logPath}\n`);
}

function parseMcpArgs() {
  const args = process.argv.slice(3);
  let projectRoot = null;
  let port = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      projectRoot = args[i + 1];
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { projectRoot: projectRoot || process.cwd(), port };
}

function runMcpStdio() {
  const { projectRoot, port } = parseMcpArgs();
  startMcpStdio({
    projectRoot,
    port
  });
}

async function connectRemoteHub() {
  const args = process.argv.slice(3);
  let hubUrl = null;
  let token = null;
  let nodeId = null;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--hub' || args[i] === '--url') && args[i + 1]) {
      hubUrl = args[++i];
    } else if (args[i] === '--token' && args[i + 1]) {
      token = args[++i];
    } else if ((args[i] === '--node' || args[i] === '--name') && args[i + 1]) {
      nodeId = args[++i];
    } else if (!args[i].startsWith('-') && !hubUrl) {
      hubUrl = args[i];
    }
  }

  hubUrl = hubUrl || process.env.NEXUS_HUB_URL || process.env.NEXUS_URL;
  token = token || process.env.NEXUS_TOKEN || process.env.NEXUS_ADMIN_TOKEN;
  nodeId = (nodeId || process.env.NEXUS_NODE_ID || getLocalNodeId()).trim();

  if (!hubUrl || !token) {
    console.error('Usage: nexus connect --hub http://<tailscale-ip>:4300 --token <operator-or-agent-token> [--node us-zenix]\n');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = new URL(hubUrl);
  } catch {
    console.error(`Invalid hub URL: ${hubUrl}\n`);
    process.exit(1);
  }

  const normalizedUrl = `${parsed.protocol}//${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? 443 : 4300)}`;
  const cfgPath = writeRemoteConfig({
    hubUrl: normalizedUrl,
    host: parsed.hostname,
    port: parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '4300'), 10),
    token,
    nodeId
  });

  console.log(`[Agent-Nexus] Saved remote hub binding to ${cfgPath}`);
  console.log(`  • Hub URL: ${normalizedUrl}`);
  console.log(`  • Node ID: ${nodeId}`);

  try {
    const syncRes = await pushRemoteSessionsOnce({ hubUrl: normalizedUrl, token, nodeId });
    console.log(`  • Verified & synced ${syncRes.scanned || 0} local session(s) to central Hub!`);
  } catch (err) {
    console.warn(`  • Warning: Saved config, but initial sync failed (${err.message})`);
  }
}

function disconnectRemoteHub() {
  const removed = clearRemoteConfig();
  if (removed) {
    console.log('[Agent-Nexus] Disconnected from remote Hub (~/.agent-nexus/remote.json removed). Reverted to local loopback.');
  } else {
    console.log('[Agent-Nexus] No remote Hub configuration found.');
  }
}

async function runEdgeBridge() {
  const args = process.argv.slice(3);
  const once = args.includes('--once');
  let hubUrl = null;
  let token = null;
  let nodeId = null;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--hub' || args[i] === '--url') && args[i + 1]) hubUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) token = args[++i];
    else if ((args[i] === '--node' || args[i] === '--name') && args[i + 1]) nodeId = args[++i];
  }

  const opts = {
    ...(hubUrl ? { hubUrl } : {}),
    ...(token ? { token } : {}),
    ...(nodeId ? { nodeId } : {})
  };

  if (once) {
    try {
      const res = await pushRemoteSessionsOnce(opts);
      console.log(`[Agent-Nexus Bridge] Synced ${res.scanned || 0} session(s) from [${res.host_id}] to Hub.`);
      process.exit(0);
    } catch (err) {
      console.error(`[Agent-Nexus Bridge] Sync failed: ${err.message}`);
      process.exit(1);
    }
  }

  const bridge = startEdgeBridge(opts);
  console.log(`[Agent-Nexus Bridge] Watching ${bridge.sessionsDir} as node [${bridge.endpoint.nodeId}] -> ${bridge.endpoint.baseUrl}`);
  const shutdown = () => {
    bridge.stop();
    console.log('\n[Agent-Nexus Bridge] Stopped.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function issueToken() {
  const agentId = process.argv[3];
  if (!agentId) {
    console.error('Usage: nexus token <agent-id>\n');
    process.exit(1);
  }
  const endpoint = resolveNexusEndpoint();
  const adminToken = process.env.NEXUS_ADMIN_TOKEN || endpoint.token || readSessionToken();
  if (!adminToken) {
    console.error(
      'NEXUS_ADMIN_TOKEN is required: paste the observer token printed when the daemon started, or start the daemon locally.\n'
    );
    process.exit(1);
  }

  const res = await fetch(`${endpoint.baseUrl}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ agent_id: agentId })
  });

  if (!res.ok) {
    console.error(`\n[Agent-Nexus] Could not mint a token for "${agentId}" (HTTP ${res.status}):\n`);
    console.error(`  ${(await res.text()).trim()}\n`);
    process.exit(1);
  }
  const { token } = await res.json();
  console.log(token);
}

async function listProjects() {
  const endpoint = resolveNexusEndpoint();
  const res = await fetch(`${endpoint.baseUrl}/api/projects`, {
    headers: endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}
  });

  if (!res.ok) {
    console.error(`Failed to list projects (HTTP ${res.status})`);
    process.exit(1);
  }

  const projects = await res.json();
  console.log('\n[Agent-Nexus] Known Projects:');
  for (const p of projects) {
    const hostSuffix = p.is_remote && p.host_id ? ` [${p.host_id}]` : '';
    console.log(`  • ID: ${p.id.padEnd(18)} Root: ${p.root_path || '(default)'}${hostSuffix}`);
  }
  console.log();
}

function showProjectInfo(targetDir) {
  const info = resolveProject(targetDir || process.cwd());
  console.log('\n[Agent-Nexus] Project Resolution:');
  console.log(`  Project ID:   ${info.projectId}`);
  console.log(`  Project Root: ${info.projectRoot}`);
  console.log(`  Marker:       ${info.marker || '(none, using startDir)'}\n`);
}

function printHelp() {
  console.log(`
Agent-Nexus CLI:
  nexus start                    前台启动中心 Hub daemon 与实时单面板
  nexus probe [--edge --node <id>]
                                 以后台探针模式运行（无窗口、写日志与 pid 文件）；
                                 --edge 为边缘探针：不开端口、不建库，只推会话快照给中心 Hub
  nexus probe:install [--port N] [--host H] [--edge --node <id>] [--no-start]
                                 安装开机自启的后台探针（Windows 用 VBS+cmd，Linux 用 systemd user）
  nexus probe:uninstall          移除探针、开机自启项并停止进程
  nexus probe:start | probe:stop 手动启停已安装的探针
  nexus probe:status             查看探针角色、运行状态、端点、PID 与日志位置
  nexus connect --hub <url> --token <tok> [--node <name>]
                                 将远端工作区（如 us-zenix）绑定至中心 Hub 面板（免部署第二面板）
  nexus disconnect               解除远端 Hub 绑定，恢复本机默认回环
  nexus bridge [--once]          在远端工作区运行轻量无状态会话同步桥（零端口、零面板）
  nexus token <agent-id>         向运行中的 daemon 签发该 agent 的令牌
  nexus projects                 查看当前 daemon 登记的所有项目列表
  nexus project [dir]            解析指定目录所属的项目根与 Project ID
  nexus mcp [--project <path>]   以 stdio JSON-RPC 模式运行项目级 MCP 服务
  nexus mcp:install [dir]        为指定项目注入/合并 .mcp.json 配置（对齐 AOCI 模式）
  nexus hook:install [--all]     安装全部物理拦截 Hook (Fail-Closed)
  nexus hook:install --claude    仅安装 Claude Code Hook
  nexus hook:install --codex     仅配置 Codex / AgentHub
  nexus hook:install --zcode     仅配置 ZCode

认证：/api/* 与 WebSocket 需要令牌。daemon 启动时自动将当前活动令牌写入
~/.agent-nexus/session.token，本地 CLI、Hook 与 MCP 客户端均可无感通信；
远端工作区可通过 nexus connect 持久化写入 ~/.agent-nexus/remote.json 实现全局 Hook 零感上报。
  `);
}
