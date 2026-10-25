// =============================================================================
// Agent-Nexus Background Probe (后台探针生命周期)
//
// 探针 = 无窗口、无 UI、开机自启的常驻协调进程，只负责 Hub 与数据面。
// 桌面端是纯客户端，只连探针、绝不拉起它，两者可分别安装与升级。
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, truncateSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { readRemoteConfig } from '../transport/auth.js';

const IS_WIN = process.platform === 'win32';
const DEFAULT_PORT = 4300;
const MAX_LOG_BYTES = 4 * 1024 * 1024;

export const PROBE_ENTRY_VERSION = 1;

export function getProbeDir() {
  return process.env.NEXUS_PROBE_DIR || join(homedir(), '.agent-nexus');
}

export function getProbePidPath() {
  return join(getProbeDir(), 'probe.pid');
}

export function getProbeStatePath() {
  return join(getProbeDir(), 'probe.json');
}

export function getProbeLogPath() {
  return join(getProbeDir(), 'probe.log');
}

export function getProbeEntryPath() {
  return join(getProbeDir(), 'probe-entry.json');
}

export function getProbeLauncherPath() {
  return join(getProbeDir(), IS_WIN ? 'probe.cmd' : 'probe.sh');
}

export function getAutostartPath() {
  if (process.env.NEXUS_STARTUP_DIR) {
    return join(process.env.NEXUS_STARTUP_DIR, IS_WIN ? 'Agent-Nexus Probe.vbs' : 'agent-nexus-probe.desktop');
  }
  if (IS_WIN) {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Agent-Nexus Probe.vbs');
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'autostart', 'agent-nexus-probe.desktop');
}

function getSystemdUnitPath() {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'systemd', 'user', 'agent-nexus-probe.service');
}

// 非交互 SSH / cron 下没有 XDG_RUNTIME_DIR，`systemctl --user` 会报
// "Failed to connect to bus: No medium found"。这里按 uid 补出运行时目录。
function userSystemctl(args, timeout = 5000) {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${process.getuid?.() ?? ''}`;
  return execFileSync('systemctl', ['--user', ...args], { stdio: 'ignore', timeout, env });
}

function systemdUnitReachable() {
  if (IS_WIN) return false;
  try {
    userSystemctl(['show-environment'], 3000);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

// 探针要跑 node:sqlite，必须找到支持它的 Node。打包后的桌面端自带的 Electron
// 运行时版本偏旧，不能拿来当探针解释器，所以这里独立探测系统 Node。
export function resolveNodeRuntime() {
  if (process.env.NEXUS_NODE_PATH && existsSync(process.env.NEXUS_NODE_PATH)) {
    return { executable: process.env.NEXUS_NODE_PATH, asNode: false };
  }

  const candidates = [
    process.execPath,
    'D:\\nodejs\\node.exe',
    'C:\\Program Files\\nodejs\\node.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'node', 'node.exe'),
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'nodejs', 'node.exe'),
    '/usr/bin/node',
    '/usr/local/bin/node',
    'node.exe',
    'node'
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if ((candidate.includes('\\') || candidate.startsWith('/')) && !existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['-e', 'require("node:sqlite")'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      // systemd 要求 ExecStart 是绝对路径，裸命令名要解析成实际路径再落盘。
      const absolute = candidate.includes('\\') || candidate.startsWith('/') ? candidate : resolveCommandPath(candidate);
      if (!absolute) continue;
      return { executable: absolute, asNode: false };
    } catch {}
  }
  return null;
}

function resolveCommandPath(command) {
  const exts = IS_WIN ? ['', '.exe', '.cmd', '.bat'] : [''];
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function readProbeEntry() {
  try {
    const raw = readFileSync(getProbeEntryPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.executable) return parsed;
  } catch {}
  return null;
}

export function readProbeState() {
  try {
    const raw = readFileSync(getProbeStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return null;
}

export function writeProbeState(state) {
  const target = getProbeStatePath();
  ensureDir(target);
  writeFileSync(target, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return target;
}

export function clearProbeState() {
  for (const file of [getProbeStatePath(), getProbePidPath()]) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {}
  }
}

export function readProbePid() {
  const state = readProbeState();
  if (state && Number.isInteger(state.pid) && state.pid > 0) return state.pid;
  try {
    const raw = readFileSync(getProbePidPath(), 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writeProbePid(pid) {
  const target = getProbePidPath();
  ensureDir(target);
  writeFileSync(target, String(pid), { encoding: 'utf8', mode: 0o600 });
  return target;
}

function rotateLog(logPath) {
  try {
    if (existsSync(logPath) && statSync(logPath).size > MAX_LOG_BYTES) {
      truncateSync(logPath, 0);
    }
  } catch {}
}

function quoteWin(arg) {
  return `"${String(arg).replace(/"/g, '""')}"`;
}

function quotePosix(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function buildProbeArgs(entry) {
  const args = [entry.cliPath, 'probe'];
  if (entry.role === 'edge') args.push('--edge');
  if (entry.port) args.push('--port', String(entry.port));
  if (entry.host) args.push('--host', String(entry.host));
  if (entry.nodeId) args.push('--node', String(entry.nodeId));
  return args;
}

function writeWindowsLauncher(entry) {
  const launcher = getProbeLauncherPath();
  ensureDir(launcher);
  rotateLog(getProbeLogPath());
  const command = [quoteWin(entry.executable), ...buildProbeArgs(entry).map(quoteWin)].join(' ');
  // 日志由探针进程自己写入 probe.log：detached 启动时 cmd 的 `>>` 重定向会静默丢输出。
  const content = [
    '@echo off',
    `cd /d ${quoteWin(entry.cwd || dirname(entry.cliPath))}`,
    command,
    ''
  ].join('\r\n');
  writeFileSync(launcher, content, 'utf8');
  return launcher;
}

function writePosixLauncher(entry) {
  const launcher = getProbeLauncherPath();
  ensureDir(launcher);
  rotateLog(getProbeLogPath());
  const command = [quotePosix(entry.executable), ...buildProbeArgs(entry).map(quotePosix)].join(' ');
  const content = [
    '#!/bin/sh',
    `cd ${quotePosix(entry.cwd || dirname(entry.cliPath))} || exit 1`,
    `exec ${command}`,
    ''
  ].join('\n');
  writeFileSync(launcher, content, { encoding: 'utf8', mode: 0o755 });
  return launcher;
}

function writeWindowsAutostart(launcherPath) {
  const autostart = getAutostartPath();
  ensureDir(autostart);
  const content = [
    "' Agent-Nexus background probe (auto-start, windowless).",
    "' Generated by `nexus probe:install`; remove with `nexus probe:uninstall`.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run ${quoteWin(launcherPath)}, 0, False`,
    ''
  ].join('\r\n');
  writeFileSync(autostart, content, 'utf8');
  return autostart;
}

function writePosixAutostart(entry) {
  const execLine = [quotePosix(entry.executable), ...buildProbeArgs(entry).map(quotePosix)].join(' ');
  if (systemdUnitReachable()) {
    const unitPath = getSystemdUnitPath();
    ensureDir(unitPath);
    const unit = [
      '[Unit]',
      'Description=Agent-Nexus background probe',
      'After=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${entry.cwd || dirname(entry.cliPath)}`,
      `ExecStart=${execLine}`,
      'Restart=always',
      'RestartSec=3',
      'Environment=NEXUS_PROBE=1',
      '',
      '[Install]',
      'WantedBy=default.target',
      ''
    ].join('\n');
    writeFileSync(unitPath, unit, 'utf8');
    try {
      userSystemctl(['daemon-reload']);
      userSystemctl(['enable', 'agent-nexus-probe.service']);
    } catch {}
    return unitPath;
  }

  const autostart = getAutostartPath();
  ensureDir(autostart);
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Agent-Nexus Probe',
    `Exec=${execLine}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n');
  writeFileSync(autostart, content, 'utf8');
  return autostart;
}

export function isProbeInstalled() {
  if (!existsSync(getProbeEntryPath())) return false;
  // Linux 上装了 systemd user 单元就不再写 XDG .desktop，两者任一存在即为已安装。
  return existsSync(getAutostartPath()) || existsSync(getSystemdUnitPath());
}

// 状态里要报「实际生效」的自启项：Linux 走 systemd 时并没有 .desktop 文件。
function effectiveAutostartPath() {
  if (!IS_WIN && existsSync(getSystemdUnitPath())) return getSystemdUnitPath();
  return getAutostartPath();
}

export async function checkProbeHealth({ host = '127.0.0.1', port = DEFAULT_PORT, timeoutMs = 1200 } = {}) {
  const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const baseUrl = `http://${probeHost}:${port}`;
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { running: false, baseUrl, status: res.status };
    const body = await res.json().catch(() => ({}));
    return { running: true, baseUrl, version: body.version || null, status: body.status || 'ok' };
  } catch (err) {
    return { running: false, baseUrl, error: err.message };
  }
}

export async function probeStatus({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const entry = readProbeEntry();
  const state = readProbeState();
  const pid = readProbePid();
  const effectivePort = entry?.port || state?.port || port;
  const effectiveHost = entry?.host || state?.host || host;
  const isEdge = entry?.role === 'edge';
  // edge 探针不开端口，健康只能看进程存活。
  const alive = pid ? isProcessAlive(pid) : false;
  const health = isEdge ? { running: alive, baseUrl: null } : await checkProbeHealth({ host: effectiveHost, port: effectivePort });

  return {
    installed: isProbeInstalled(),
    role: isEdge ? 'edge' : 'hub',
    running: health.running,
    pid: alive ? pid : null,
    stalePid: pid && !alive ? pid : null,
    port: isEdge ? null : effectivePort,
    host: isEdge ? null : effectiveHost,
    baseUrl: health.baseUrl,
    version: health.version || (alive && state?.version) || null,
    hubUrl: isEdge ? (state?.hubUrl || null) : null,
    autostartPath: effectiveAutostartPath(),
    launcherPath: existsSync(getProbeLauncherPath()) ? getProbeLauncherPath() : null,
    logPath: getProbeLogPath(),
    entry,
    state
  };
}

export async function installProbe(options = {}) {
  const cliPath = resolve(options.cliPath || join(import.meta.dirname, '../cli.js'));
  if (!existsSync(cliPath)) {
    throw new Error(`CLI entry not found at ${cliPath}; cannot install the probe.`);
  }

  const runtime = options.nodePath
    ? { executable: options.nodePath, asNode: false }
    : resolveNodeRuntime();
  if (!runtime) {
    throw new Error(
      'No Node.js runtime with `node:sqlite` support was found. ' +
      'Install Node 24+ (or set NEXUS_NODE_PATH) before installing the background probe.'
    );
  }

  const port = options.port ?? parseInt(process.env.NEXUS_PORT || String(DEFAULT_PORT), 10);
  const host = options.host ?? process.env.NEXUS_HOST ?? null;
  const role = options.role === 'edge' ? 'edge' : 'hub';
  if (role === 'edge') {
    const remote = readRemoteConfig();
    if (!remote?.hubUrl || !remote?.token) {
      throw new Error(
        'An edge probe needs a bound Hub first. Run ' +
        '`nexus connect --hub <url> --token <token> --node <name>` on this machine, then retry.'
      );
    }
  }
  const nodeId = role === 'edge'
    ? (options.nodeId || process.env.NEXUS_NODE_ID || readRemoteConfig()?.nodeId || hostname())
    : null;

  const entry = {
    version: PROBE_ENTRY_VERSION,
    role,
    executable: runtime.executable,
    cliPath,
    cwd: options.cwd || process.cwd(),
    port: role === 'edge' ? null : port,
    host: role === 'edge' ? null : host,
    nodeId,
    installedAt: Date.now()
  };

  const entryPath = getProbeEntryPath();
  ensureDir(entryPath);
  writeFileSync(entryPath, JSON.stringify(entry, null, 2), { encoding: 'utf8', mode: 0o600 });

  const launcherPath = IS_WIN ? writeWindowsLauncher(entry) : writePosixLauncher(entry);
  const autostartPath = IS_WIN ? writeWindowsAutostart(launcherPath) : writePosixAutostart(entry);

  let started = false;
  if (options.start !== false) {
    const result = await startProbe({ entry });
    started = result.started;
  }

  return { entry, launcherPath, autostartPath, started, node: runtime.executable };
}

export async function startProbe(options = {}) {
  const entry = options.entry || readProbeEntry();
  if (!entry) {
    throw new Error('The background probe is not installed yet. Run `nexus probe:install` first.');
  }

  const isEdge = entry.role === 'edge';
  const port = options.port || entry.port || DEFAULT_PORT;
  const host = options.host || entry.host || '127.0.0.1';

  // edge 探针不开端口，只能按进程判断是否已在运行。
  if (isEdge) {
    const pid = readProbePid();
    if (pid && isProcessAlive(pid)) {
      return { started: false, alreadyRunning: true, pid };
    }
  } else {
    const existing = await checkProbeHealth({ host, port });
    if (existing.running) {
      return { started: false, alreadyRunning: true, baseUrl: existing.baseUrl, version: existing.version };
    }
  }

  const launcherPath = getProbeLauncherPath();
  if (!existsSync(launcherPath)) {
    throw new Error(`Probe launcher missing at ${launcherPath}. Reinstall with \`nexus probe:install\`.`);
  }

  rotateLog(getProbeLogPath());

  // Linux 上装了 systemd user 单元就交给 systemd 拉起：直接 spawn 会绕过
  // Restart=always，并且开机后服务再拉一次就变成两个探针进程。
  if (!IS_WIN && systemdUnitReachable() && existsSync(getSystemdUnitPath())) {
    try {
      userSystemctl(['start', 'agent-nexus-probe.service'], 15000);
    } catch {}
    const deadline = Date.now() + (options.timeoutMs || 15000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const pid = readProbePid();
      if (pid && isProcessAlive(pid)) {
        if (isEdge) return { started: true, pid };
        const health = await checkProbeHealth({ host, port, timeoutMs: 800 });
        if (health.running) return { started: true, baseUrl: health.baseUrl, version: health.version, pid };
        continue;
      }
      if (!isEdge) {
        const health = await checkProbeHealth({ host, port, timeoutMs: 800 });
        if (health.running) return { started: true, baseUrl: health.baseUrl, version: health.version, pid: null };
      }
    }
    throw new Error(
      `systemd did not bring the probe up within the timeout. Check \`systemctl --user status agent-nexus-probe\` and ${getProbeLogPath()}.`
    );
  }

  const child = IS_WIN
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/c', launcherPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: entry.cwd || dirname(entry.cliPath)
      })
    : spawn('sh', [launcherPath], {
        detached: true,
        stdio: 'ignore',
        cwd: entry.cwd || dirname(entry.cliPath)
      });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs || 15000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (isEdge) {
      const pid = readProbePid();
      if (pid && isProcessAlive(pid)) return { started: true, pid };
      continue;
    }
    const health = await checkProbeHealth({ host, port, timeoutMs: 800 });
    if (health.running) {
      return { started: true, baseUrl: health.baseUrl, version: health.version, pid: child.pid };
    }
  }

  throw new Error(
    `The probe did not become healthy${isEdge ? '' : ` on port ${port}`} within the timeout. ` +
    `Check the log at ${getProbeLogPath()}.`
  );
}

export async function stopProbe(options = {}) {
  const pid = readProbePid();
  const entry = readProbeEntry();
  const isEdge = entry?.role === 'edge';
  const port = options.port || entry?.port || DEFAULT_PORT;
  const host = options.host || entry?.host || '127.0.0.1';

  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (isProcessAlive(pid) && IS_WIN) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      } catch {}
    }
  }

  if (!IS_WIN && systemdUnitReachable() && existsSync(getSystemdUnitPath())) {
    try {
      userSystemctl(['stop', 'agent-nexus-probe.service']);
    } catch {}
  }

  clearProbeState();
  if (isEdge) return { stopped: true, pid, stillRunning: false };
  const health = await checkProbeHealth({ host, port, timeoutMs: 600 });
  return { stopped: !health.running, pid, stillRunning: health.running };
}

export async function uninstallProbe(options = {}) {
  await stopProbe(options);

  const removed = [];
  for (const file of [getAutostartPath(), getProbeLauncherPath(), getProbeEntryPath(), getSystemdUnitPath()]) {
    try {
      if (existsSync(file)) {
        unlinkSync(file);
        removed.push(file);
      }
    } catch {}
  }

  if (!IS_WIN && systemdUnitReachable()) {
    try {
      userSystemctl(['disable', 'agent-nexus-probe.service']);
      userSystemctl(['daemon-reload']);
    } catch {}
  }

  clearProbeState();
  return { removed, autostartPath: getAutostartPath() };
}
