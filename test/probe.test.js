import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  getAutostartPath,
  getProbeLauncherPath,
  getProbeVbsLauncherPath,
  getProbeEntryPath,
  isProbeInstalled,
  isProcessAlive,
  readProbeEntry,
  readProbePid,
  writeProbePid,
  writeProbeState,
  readProbeState,
  clearProbeState,
  installProbe,
  probeStatus
} from '../src/probe/index.js';

// 探针安装器会写开机自启项。用例全程重定向到临时目录，
// 绝不触碰开发者宿主机真实的启动文件夹。
function withTempProbeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-probe-'));
  const startup = join(dir, 'startup');
  mkdirSync(startup, { recursive: true });
  const prev = {
    NEXUS_PROBE_DIR: process.env.NEXUS_PROBE_DIR,
    NEXUS_STARTUP_DIR: process.env.NEXUS_STARTUP_DIR,
    NEXUS_REMOTE_CONFIG_PATH: process.env.NEXUS_REMOTE_CONFIG_PATH,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME
  };
  process.env.NEXUS_PROBE_DIR = dir;
  process.env.NEXUS_STARTUP_DIR = startup;
  // systemd 单元路径只认 XDG_CONFIG_HOME。不隔离它，用例里的 stopProbe
  // 会 `systemctl --user stop agent-nexus-probe.service`，把宿主机上真正
  // 在跑的探针停掉（实测：跑一次 npm test 就停掉了美西机的生产探针）。
  process.env.XDG_CONFIG_HOME = dir;
  process.env.NEXUS_REMOTE_CONFIG_PATH = join(dir, 'remote.json');
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, startup };
}

test('探针路径与自启项全部落在受控目录', async (t) => {
  const { dir, startup } = withTempProbeDir(t);

  await t.test('默认路径指向 NEXUS_PROBE_DIR 与 NEXUS_STARTUP_DIR', () => {
    assert.equal(getProbeEntryPath(), join(dir, 'probe-entry.json'));
    assert.equal(getProbeLauncherPath(), join(dir, process.platform === 'win32' ? 'probe.cmd' : 'probe.sh'));
    assert.equal(getProbeVbsLauncherPath(), join(dir, 'probe-bg.vbs'));
    assert.ok(getAutostartPath().startsWith(startup));
  });

  await t.test('未安装时 isProbeInstalled 为 false', () => {
    assert.equal(isProbeInstalled(), false);
    assert.equal(readProbeEntry(), null);
  });

  await t.test('isProcessAlive 识别本进程与明显无效的 PID', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(-1), false);
    assert.equal(isProcessAlive(NaN), false);
  });

  await t.test('pid 文件与状态文件可读写并清理', () => {
    writeProbePid(43210);
    assert.equal(readProbePid(), 43210);

    writeProbeState({ pid: 43210, port: 4399, host: '127.0.0.1', startedAt: 1 });
    const state = readProbeState();
    assert.equal(state.port, 4399);
    assert.ok(state.updatedAt > 0, '写入时应自动补 updatedAt');

    clearProbeState();
    assert.equal(readProbePid(), null);
    assert.equal(readProbeState(), null);
  });

  await t.test('损坏的状态文件不会让探针状态查询抛错', () => {
    const statePath = join(dir, 'probe.json');
    writeFileSync(statePath, '{ not json', 'utf8');
    assert.equal(readProbeState(), null);
    assert.equal(readProbePid(), null);
  });

  await t.test('edge 探针必须先绑定中心 Hub 才能安装', async () => {
    await assert.rejects(
      installProbe({ role: 'edge', start: false, nodePath: process.execPath }),
      /nexus connect/
    );
    assert.equal(isProbeInstalled(), false);
  });

  await t.test('edge 探针安装后记录角色、节点名与 --edge 启动参数', async () => {
    writeFileSync(
      join(dir, 'remote.json'),
      JSON.stringify({ hubUrl: 'http://100.79.74.121:4300', host: '100.79.74.121', port: 4300, token: 'tok', nodeId: 'us-zenix' }),
      'utf8'
    );

    const res = await installProbe({ role: 'edge', start: false, nodePath: process.execPath, cwd: dir });
    assert.equal(res.entry.role, 'edge');
    assert.equal(res.entry.nodeId, 'us-zenix');
    assert.equal(res.entry.port, null);
    assert.equal(res.entry.host, null);
    assert.equal(isProbeInstalled(), true);

    const launcher = readFileSync(getProbeLauncherPath(), 'utf8');
    assert.match(launcher, /--edge/);
    assert.match(launcher, /--node/);
    assert.match(launcher, /us-zenix/);
    assert.doesNotMatch(launcher, /--port/, 'edge 探针不应带端口参数');
  });

  await t.test('edge 探针状态按进程判活，并给出 Hub 地址', async () => {
    writeProbePid(process.pid);
    writeProbeState({ pid: process.pid, role: 'edge', nodeId: 'us-zenix', hubUrl: 'http://100.79.74.121:4300' });

    const status = await probeStatus();
    assert.equal(status.role, 'edge');
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
    assert.equal(status.port, null);
    assert.equal(status.baseUrl, null);
    assert.equal(status.hubUrl, 'http://100.79.74.121:4300');

    writeProbeState({ pid: 999999, role: 'edge', nodeId: 'us-zenix' });
    const dead = await probeStatus();
    assert.equal(dead.running, false);
    assert.equal(dead.pid, null);
    assert.equal(dead.stalePid, 999999);
  });

  // 回归：Windows 自启项必须是一条合法的 VBScript。
  // 早期版本写成 `sh.Run "node.exe" "cli.js", 0`，VBScript 没有转义引号，
  // 整行解析成「语句未结束」，探针根本不会启动，且失败是静默的。
  await t.test('Windows 自启项是合法 VBScript（引号不裸露）', async () => {
    if (process.platform !== 'win32') return;

    const res = await installProbe({ start: false, nodePath: process.execPath, cwd: dir });
    const vbs = readFileSync(res.autostartPath, 'utf8');

    assert.match(vbs, /Set sh = CreateObject\("WScript\.Shell"\)/);
    assert.match(vbs, /, 0, False/, '窗口模式必须是 0（隐藏）、不等待');
    assert.doesNotMatch(vbs, /probe\.cmd/, '不应再经由 cmd.exe，避免启动时闪控制台');

    // 探针目录下的 probe-bg.vbs 同样必须是合法的无窗 VBScript
    const bgVbsPath = getProbeVbsLauncherPath();
    assert.ok(existsSync(bgVbsPath), '应同时生成 probe-bg.vbs 用于后台静默启动');
    const bgVbs = readFileSync(bgVbsPath, 'utf8');
    assert.match(bgVbs, /Set sh = CreateObject\("WScript\.Shell"\)/);
    assert.match(bgVbs, /, 0, False/);

    // 回归：这个脚本会被反复拉起，工作目录必须与自启项同口径 ——
    // 显式给了 cwd 就用它，不能悄悄指向源码路径（v0.2.29 的无限重启事故）。
    const bgCwd = bgVbs
      .split(/\r?\n/)
      .find((l) => l.trimStart().startsWith('sh.CurrentDirectory'))
      .split('=')[1]
      .trim()
      .replace(/^"|"$/g, '');
    assert.equal(bgCwd, dir, 'probe-bg.vbs 应沿用显式指定的 cwd');

    // Run 的参数必须整体是一个用 "" 包裹、内部引号成对转义的字符串字面量。
    const runLine = vbs.split(/\r?\n/).find((l) => l.trimStart().startsWith('sh.Run'));
    assert.ok(runLine, '自启项里必须有 sh.Run 调用');
    const literal = runLine.slice(runLine.indexOf('sh.Run') + 'sh.Run'.length, runLine.lastIndexOf(', 0, False')).trim();
    assert.ok(literal.startsWith('"""') && literal.endsWith('"""'), `命令字符串应以 """ 开头结尾: ${literal}`);
    assert.equal((literal.match(/"/g) || []).length % 2, 0, '引号必须成对');
  });

  // 回归：探针是常驻后台进程，工作目录不能沿用安装时的 process.cwd()。
  // 真实事故：在 /tmp/nexus-probe-* 解包目录里安装后，systemd 单元把该目录钉死，
  // 目录被清掉后每次启动都以 status=200/CHDIR 失败，Restart=always 变成无限重启
  // （美西机重启计数到 13，探针从未真正跑起来）。
  await t.test('probe-bg.vbs 未指定 cwd 时回落到家目录', async () => {
    if (process.platform !== 'win32') return; // probe-bg.vbs 只在 Windows 生成

    await installProbe({ start: false, nodePath: process.execPath });
    const bgVbs = readFileSync(getProbeVbsLauncherPath(), 'utf8');
    const bgCwd = bgVbs
      .split(/\r?\n/)
      .find((l) => l.trimStart().startsWith('sh.CurrentDirectory'))
      .split('=')[1]
      .trim()
      .replace(/^"|"$/g, '');

    assert.equal(bgCwd, homedir(), '未指定 cwd 时应回落到家目录');
    assert.notEqual(bgCwd, process.cwd(), '绝不能沿用安装进程的当前目录');
  });

  await t.test('安装时未显式给 cwd，不把临时工作目录写进自启项', async (t) => {
    if (process.platform === 'win32') return; // systemd 单元只在 POSIX 生成

    const res = await installProbe({ start: false, nodePath: process.execPath });
    assert.equal(res.entry.cwd, null, '未指定时不得记录安装进程的 cwd');

    const unit = readFileSync(res.autostartPath, 'utf8');
    // 没有可用的 systemd user bus 时（容器化 CI 里的 `systemctl --user` 会报
    // "Failed to connect to bus: No medium found"），安装器写的是 XDG .desktop，
    // 它根本没有 WorkingDirectory 这个概念，这条断言只对 systemd 单元成立。
    if (!res.autostartPath.endsWith('.service')) {
      assert.match(unit, /^\[Desktop Entry\]$/m, '无 systemd 时应写 XDG .desktop');
      return;
    }

    const line = unit.split('\n').find((l) => l.startsWith('WorkingDirectory='));
    assert.ok(line, 'systemd 单元必须有 WorkingDirectory');
    const value = line.slice('WorkingDirectory='.length);
    assert.equal(value, homedir(), '应回落到家目录，而不是安装时的 cwd');
    assert.notEqual(value, process.cwd(), '绝不能沿用安装进程的当前目录');
  });

  // 回归：用例必须把 systemd 单元路径也重定向掉。getSystemdUnitPath() 只认
  // XDG_CONFIG_HOME，而 stopProbe 结尾会无条件 `systemctl --user stop
  // agent-nexus-probe.service`。真实事故：在装有探针的机器上跑 npm test，
  // 用例里的 stopProbe 把宿主机正在跑的探针停掉了（美西机已连续运行 20 小时，
  // 跑一次全量测试后变成 inactive）。
  await t.test('用例把 systemd 单元路径重定向到临时目录', () => {
    if (process.platform === 'win32') return; // Windows 无 systemd 单元

    const configHome = process.env.XDG_CONFIG_HOME;
    assert.ok(configHome, 'XDG_CONFIG_HOME 必须被用例重定向');
    assert.ok(
      configHome.startsWith(tmpdir()),
      `XDG_CONFIG_HOME 应指向临时目录: ${configHome}`
    );
    assert.notEqual(
      configHome,
      join(homedir(), '.config'),
      '绝不能沿用宿主机的真实配置目录'
    );
  });
});
