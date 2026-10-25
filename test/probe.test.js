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
  clearProbeState
} from '../src/probe/index.js';

// 探针安装器会写开机自启项。用例全程重定向到临时目录，
// 绝不触碰开发者宿主机真实的启动文件夹。
function withTempProbeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-probe-'));
  const startup = join(dir, 'startup');
  mkdirSync(startup, { recursive: true });
  const prev = {
    NEXUS_PROBE_DIR: process.env.NEXUS_PROBE_DIR,
    NEXUS_STARTUP_DIR: process.env.NEXUS_STARTUP_DIR
  };
  process.env.NEXUS_PROBE_DIR = dir;
  process.env.NEXUS_STARTUP_DIR = startup;
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
});
