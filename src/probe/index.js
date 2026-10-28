// =============================================================================
// Agent-Nexus Background Probe (后台探针生命周期)
//
// 探针 = 无窗口、无 UI、开机自启的常驻协调进程，只负责 Hub 与数据面。
// 桌面端是纯客户端，只连探针、绝不拉起它，两者可分别安装与升级。
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, truncateSync, readdirSync, readlinkSync } from 'node:fs';
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

export function getProbeVbsLauncherPath() {
  return join(getProbeDir(), 'probe-bg.vbs');
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

  // 同步生成纯后台静默启动的 VBScript：
  // 在 Windows 11 下，若默认终端被设为 Windows Terminal，任何经由 cmd.exe / node.exe 直接拉起
  // 的控制台进程都会被 Windows Terminal 拦截并在前台弹出可见标签页/黑框。
  // 使用 wscript.exe（GUI 子系统）配合窗口模式 0（SW_HIDE）启动，可彻底避免控制台黑框弹出。
  const vbsLauncher = getProbeVbsLauncherPath();
  const argv = entry?.executable
    ? [entry.executable, ...buildProbeArgs(entry)]
    : null;
  const runLine = argv
    ? `sh.Run ${quoteWin(argv.map((a) => `"${String(a).replace(/"/g, '""')}"`).join(' '))}, 0, False`
    : `sh.Run ${quoteWin(launcher)}, 0, False`;
  const vbsContent = [
    "' Agent-Nexus background probe launcher (windowless).",
    'Set sh = CreateObject("WScript.Shell")',
    // 与自启项同口径：这个脚本会被反复拉起，工作目录不能指向安装时可能属于
    // 临时解包目录的源码路径（v0.2.29 事故），缺省回落到家目录。
    `sh.CurrentDirectory = ${quoteWin(entry?.cwd || homedir())}`,
    runLine,
    ''
  ].join('\r\n');
  writeFileSync(vbsLauncher, vbsContent, 'utf8');

  return launcher;
}

function writePosixLauncher(entry) {
  const launcher = getProbeLauncherPath();
  ensureDir(launcher);
  rotateLog(getProbeLogPath());
  const command = [quotePosix(entry.executable), ...buildProbeArgs(entry).map(quotePosix)].join(' ');
  const content = [
    '#!/bin/sh',
    `cd ${quotePosix(entry.cwd || homedir())} || cd / || exit 1`,
    `exec ${command}`,
    ''
  ].join('\n');
  writeFileSync(launcher, content, { encoding: 'utf8', mode: 0o755 });
  return launcher;
}

function writeWindowsAutostart(launcherPath) {
  const autostart = getAutostartPath();
  ensureDir(autostart);
  const entry = readProbeEntry();
  // 直接调 node 而不是经过 probe.cmd：cmd.exe 即使被 wscript 以隐藏方式拉起，
  // 某些 Windows 版本仍会闪一下控制台。node 本身是控制台程序，
  // 由 wscript 的窗口模式 0 启动时不会创建可见窗口。
  //
  // VBScript 没有转义引号，`sh.Run "a" "b", 0` 会被解析成语句未结束；
  // 必须把整条命令行拼成一个字符串字面量再交给 Run。
  const argv = entry?.executable
    ? [entry.executable, ...buildProbeArgs(entry)]
    : null;
  const runLine = argv
    ? `sh.Run ${quoteWin(argv.map((a) => `"${String(a).replace(/"/g, '""')}"`).join(' '))}, 0, False`
    : `sh.Run ${quoteWin(launcherPath)}, 0, False`;
  const content = [
    "' Agent-Nexus background probe (auto-start, windowless).",
    "' Generated by `nexus probe:install`; remove with `nexus probe:uninstall`.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${quoteWin(entry?.cwd || homedir())}`,
    runLine,
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
      // 工作目录取不到就用家目录兜底：WorkingDirectory 指向一个不存在的目录时
      // systemd 会以 status=200/CHDIR 直接失败，Restart=always 于是变成无限重启。
      `WorkingDirectory=${entry.cwd || homedir()}`,
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

// 探活超时不能卡太紧：daemon 主线程被 SQLite 扫描或会话发现占住时，
// /health 实测会抖到 600ms 以上，1200ms 阈值会把健康的探针误判成离线
// （桌面端随之在面板与离线页之间来回切）。
export async function checkProbeHealth({ host = '127.0.0.1', port = DEFAULT_PORT, timeoutMs = 3000 } = {}) {
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

// 端口是否仍在监听：HTTP 探活失败时的兜底判据。
async function isPortListening(port) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
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
  // hub 探针：HTTP 探活偶发超时（daemon 忙）不代表进程没了。进程活着且
  // 端口仍在监听就按在线报，避免状态面板显示"未运行"而实际服务正常。
  const portListening = isEdge ? false : await isPortListening(effectivePort);
  // 端口在监听、但 PID 文件里的进程已经不在：说明这份文件是上次强杀留下的残影。
  // 这时按端口反查真实监听进程，让 probe:status 报出真正在跑的那个 PID，
  // 而不是把一个死 PID 标成 "stale" 让人以为探针没起来。
  let effectivePid = pid;
  let pidSource = pid ? 'state' : null;
  if (!isEdge && !alive && portListening) {
    const live = findListeningPids(effectivePort).filter((p) => isNexusProbeCommand(p) === true);
    if (live.length > 0) {
      effectivePid = live[0];
      pidSource = 'port';
    }
  }
  const effectiveAlive = effectivePid ? (pidSource === 'port' ? true : alive) : false;
  const running = health.running || (effectiveAlive && portListening);

  return {
    installed: isProbeInstalled(),
    role: isEdge ? 'edge' : 'hub',
    running,
    pid: effectiveAlive ? effectivePid : null,
    pidSource,
    stalePid: pid && !alive ? pid : null,
    port: isEdge ? null : effectivePort,
    host: isEdge ? null : effectiveHost,
    baseUrl: health.baseUrl,
    version: health.version || (effectiveAlive && state?.version) || null,
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
    // 探针是常驻后台进程，工作目录不能沿用安装时的 process.cwd()：
    // 在临时目录里安装（CI、解包目录、/tmp 沙箱）会让自启项把那个目录钉死，
    // 目录被清掉后 systemd 每次启动都以 status=200/CHDIR 失败并无限重启
    // （美西机实测重启计数到 13）。只有调用方显式给了 cwd 才记录。
    cwd: options.cwd || null,
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

  // Windows 下必须通过 wscript 以 SW_HIDE (0) 静默拉起：
  // 若直接 spawn cmd.exe / node.exe，Windows Terminal 会拦截控制台创建并在前台弹窗/新建标签页。
  const vbsPath = getProbeVbsLauncherPath();
  const autostartVbs = getAutostartPath();
  const targetVbs = IS_WIN
    ? (existsSync(vbsPath) ? vbsPath : (existsSync(autostartVbs) ? autostartVbs : null))
    : null;

  const child = IS_WIN && targetVbs
    ? spawn('wscript.exe', [targetVbs], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: entry.cwd || dirname(entry.cliPath)
      })
    : IS_WIN
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

// 按端口反查监听进程。PID 文件只在探针「顺利启动」时写入，进程被强杀或从
// 旧版本升级时文件会指向早已消失的 PID —— 此时 probe:stop 只认文件就会静默失手。
// 这里只做反查，是否可杀由调用方用命令行核对，避免误杀占用同端口的其他服务。
export function parseLsofPids(out) {
  return [...out.matchAll(/^\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
}

export function parseSsPids(out) {
  return [...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
}

// 纯 /proc 兜底：act_runner 的 CI 容器（catthehacker/ubuntu）里既没有 lsof
// 也没有 ss，少了这条端口反查永远返回空，stopProbe 只能看着孤儿探针继续跑。
// /proc/net/tcp 的 st=0A 即 LISTEN，末列 inode 再去 /proc/<pid>/fd 里对符号链接。
export function parseProcNetTcp(out, port) {
  const needle = Number(port).toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  for (const line of out.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const parts = f[1].split(':');
    if (parts.length !== 2) continue;
    if (parts[1].toUpperCase() !== needle) continue;
    if (f[3].toUpperCase() !== '0A') continue;
    inodes.add(f[9]);
  }
  return [...inodes];
}

function findPidsViaProc(port) {
  const inodes = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const inode of parseProcNetTcp(content, port)) inodes.add(inode);
  }
  if (inodes.size === 0) return [];

  const pids = new Set();
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let fds;
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target;
      try {
        target = readlinkSync(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && inodes.has(m[1])) {
        pids.add(Number(entry));
        break;
      }
    }
  }
  return [...pids];
}

function findListeningPids(port) {
  const pids = new Set();
  try {
    if (IS_WIN) {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
        encoding: 'utf8', windowsHide: true, timeout: 5000
      });
      for (const line of out.split(/\r?\n/)) {
        // 形如 `  TCP    0.0.0.0:4300    0.0.0.0:0    LISTENING    15928`
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && Number(m[1]) === Number(port)) pids.add(Number(m[2]));
      }
    } else {
      // `lsof -t` 只吐裸 PID（每行一个），`ss` 吐 `users:(("node",pid=123,fd=22))`，
      // 两种格式不能共用一条正则：`(?:pid=|\s)(\d+)` 靠前导空白锚定，而 lsof 的
      // 首行 PID 前面什么都没有，正则匹配从第二个字符起才成立 —— 单个 PID 时直接
      // 一个都取不到，多个时永远丢掉第一个。macOS 没有 ss，走的就是这条路径。
      const commands = [
        ['lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], parseLsofPids],
        ['ss', ['-lptn', `sport = :${port}`], parseSsPids]
      ];
      for (const [cmd, args, extract] of commands) {
        try {
          const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
          for (const n of extract(out)) {
            if (n > 0) pids.add(n);
          }
          if (pids.size > 0) break;
        } catch {}
      }
      // lsof / ss 都不存在时（精简版 CI 容器），退回到只依赖 /proc 的路径。
      if (pids.size === 0) {
        for (const n of findPidsViaProc(port)) {
          if (n > 0) pids.add(n);
        }
      }
    }
  } catch {}
  return [...pids];
}

// 命令行的自证：只结束我们自己拉起的探针，绝不对端口上的陌生进程动手。
// 注意实际命令行里每个参数都是带引号的（`"...\\cli.js" "probe" "--port" "4300"`），
// 匹配时不能假设 `probe` 前面是空格而未加引号，否则真机上一个都认不出来。
// `probe` 必须是完整子命令：后面只能是引号/空白/结尾，`probe:install` 之类不算。
const PROBE_CMDLINE_RE = /cli\.js(?=["'\s])[\s\S]*?(?<![\w.:-])probe(?=["'\s]|$)/i;

// 返回 true=确认是我们的探针，false=确认不是，null=读不到命令行（平台不支持/无权限）。
// 三态是必要的：macOS 没有 /proc，把「读不到」当成「不是」会让 edge 探针永远停不掉。
function isNexusProbeCommand(pid) {
  const cmdline = readProcessCmdline(pid);
  if (cmdline === null) return null;
  return PROBE_CMDLINE_RE.test(cmdline);
}

function readProcessCmdline(pid) {
  try {
    if (IS_WIN) {
      const out = execFileSync('powershell', [
        '-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      return out.trim() ? out : null;
    }
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {}
    // macOS 与无 procfs 的环境退回 ps；两个参数之间补空格，保持与真机命令行同构。
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 5000 });
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}

function killTree(pid) {
  try {
    if (IS_WIN) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 8000 });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

export async function stopProbe(options = {}) {
  const entry = readProbeEntry();
  const isEdge = entry?.role === 'edge';
  const port = options.port || entry?.port || DEFAULT_PORT;
  const host = options.host || entry?.host || '127.0.0.1';
  const recordedPid = readProbePid();

  const targets = new Set();
  // PID 文件是「不可信输入」：被强杀/升级后它会指向早已消失的 PID，
  // 而 Windows 会把这个号复用给无关进程。这里同样要命令行自证，否则
  // probe:stop 会对着用户编辑器发 SIGTERM。
  // 读不到命令行（null）时仍认这份记录：edge 探针没有端口兜底，若因平台限制
  // 一律拒绝，探针就再也停不掉了；而「明确不是探针」（false）必须拒绝。
  if (recordedPid && isProcessAlive(recordedPid) && isNexusProbeCommand(recordedPid) !== false) {
    targets.add(recordedPid);
  }
  // PID 文件失真时按端口兜底：这是旧版本强杀升级后 probe:stop 静默失手的根因。
  if (!isEdge) {
    for (const pid of findListeningPids(port)) {
      if (isNexusProbeCommand(pid) === true) targets.add(pid);
    }
  }

  let stoppedAny = false;
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (isProcessAlive(pid)) killTree(pid);
    if (!isProcessAlive(pid)) stoppedAny = true;
  }

  if (!IS_WIN && systemdUnitReachable() && existsSync(getSystemdUnitPath())) {
    try {
      userSystemctl(['stop', 'agent-nexus-probe.service']);
    } catch {}
  }

  clearProbeState();
  if (isEdge) return { stopped: ![...targets].some(isProcessAlive), pid: recordedPid, stillRunning: [...targets].some(isProcessAlive) };

  // 以「端口真的没人应答」为准，而不是「我们的 kill 调用返回了」。
  const health = await checkProbeHealth({ host, port, timeoutMs: 600 });
  const portListening = await isPortListening(port);
  const stillRunning = health.running || portListening;
  return {
    stopped: !stillRunning,
    pid: recordedPid,
    port: isEdge ? null : port,
    stalePid: recordedPid && !targets.has(recordedPid) ? recordedPid : null,
    killed: [...targets],
    recoveredByPort: stoppedAny && recordedPid && !targets.has(recordedPid),
    stillRunning
  };
}

export async function uninstallProbe(options = {}) {
  await stopProbe(options);

  const removed = [];
  for (const file of [getAutostartPath(), getProbeLauncherPath(), getProbeVbsLauncherPath(), getProbeEntryPath(), getSystemdUnitPath()]) {
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
