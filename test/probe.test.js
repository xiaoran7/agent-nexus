import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getAutostartPath,
  getProbeLauncherPath,
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
    NEXUS_REMOTE_CONFIG_PATH: process.env.NEXUS_REMOTE_CONFIG_PATH
  };
  process.env.NEXUS_PROBE_DIR = dir;
  process.env.NEXUS_STARTUP_DIR = startup;
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

    // Run 的参数必须整体是一个用 "" 包裹、内部引号成对转义的字符串字面量。
    const runLine = vbs.split(/\r?\n/).find((l) => l.trimStart().startsWith('sh.Run'));
    assert.ok(runLine, '自启项里必须有 sh.Run 调用');
    const literal = runLine.slice(runLine.indexOf('sh.Run') + 'sh.Run'.length, runLine.lastIndexOf(', 0, False')).trim();
    assert.ok(literal.startsWith('"""') && literal.endsWith('"""'), `命令字符串应以 """ 开头结尾: ${literal}`);
    assert.equal((literal.match(/"/g) || []).length % 2, 0, '引号必须成对');
  });
});
