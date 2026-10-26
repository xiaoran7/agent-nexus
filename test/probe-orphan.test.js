// 回归：PID 文件指向已消失的进程，但端口上确实有探针在跑。
// 真实事故：旧探针是孤儿进程，probe.pid 指向另一个已死的 PID，
// probe:stop 只认文件 → 静默失手并打印「still shutting down」；probe:status 报 stale。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';

import { stopProbe, probeStatus, writeProbePid, writeProbeState, readProbePid, isProcessAlive, parseLsofPids, parseSsPids } from '../src/probe/index.js';

function withTempProbeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-probe-orphan-'));
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
  return dir;
}

// 用固定端口而不是让子进程回报：detached + shell 组合下 stdout 管道拿不稳，
// 测试本身不该因为取端口的方式而超时。
const FAKE_PORTS = [4391, 4392, 4393];
let fakePortIndex = 0;

function spawnFakeProbe(t, dir) {
  const port = FAKE_PORTS[fakePortIndex++ % FAKE_PORTS.length];
  const scriptPath = join(dir, 'fake-probe.js');
  writeFileSync(
    scriptPath,
    "const net = require('node:net');\n" +
    "const port = Number(process.argv[2]);\n" +
    "net.createServer(() => {}).listen(port, '127.0.0.1');\n",
    'utf8'
  );
  const cliPath = join(process.cwd(), 'src', 'cli.js');
  const command = `"${process.execPath}" "${scriptPath}" "${port}" "${cliPath}" "probe" "--port" "${port}"`;
  const child = spawn(command, {
    shell: true,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  const cleanup = () => {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 8000 });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  };
  t.after(cleanup);
  return waitForPort(port).then(() => ({ child, port, cleanup }));
}

async function waitForPort(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await portAccepts(port)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`fake probe did not start listening on ${port}`);
}

function portAccepts(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => { socket.removeAllListeners(); socket.destroy(); resolve(ok); };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect({ host: '127.0.0.1', port });
  });
}

test('PID 文件失真时，按端口反查仍能停掉探针', async (t) => {
  withTempProbeDir(t);
  const { child, port, cleanup } = await spawnFakeProbe(t, process.env.NEXUS_PROBE_DIR);

  // 事故现场：状态文件里的 PID 指向一个已经不存在的进程。
  const stalePid = 999999;
  writeProbePid(stalePid);
  writeProbeState({ pid: stalePid, port, host: '127.0.0.1', startedAt: Date.now() });

  const res = await stopProbe({ port, host: '127.0.0.1' });
  assert.equal(res.stopped, true, '端口上的探针应被结束');
  assert.equal(res.recoveredByPort, true, '应如实报告是按端口反查兜底的');
  assert.equal(res.stillRunning, false);
  assert.equal(readProbePid(), null, '结束时必须清掉失真的 PID 文件');

  await new Promise((r) => setTimeout(r, 400));
  // 外层 shell 可能已退出，但真正监听的孙进程必须也已经没了。
  assert.equal(await isPortFree(port), true, '端口应已释放');
  cleanup();
});

async function isPortFree(port) {
  const status = await probeStatus({ port, host: '127.0.0.1' });
  return !status.running;
}

test('PID 文件失真时，probe:status 报出端口上的真实 PID 而非 stale', async (t) => {
  withTempProbeDir(t);
  const { port } = await spawnFakeProbe(t, process.env.NEXUS_PROBE_DIR);
  writeProbePid(999999);
  writeProbeState({ pid: 999999, port, host: '127.0.0.1', startedAt: Date.now() });

  const status = await probeStatus({ port, host: '127.0.0.1' });
  // shell:true 会多包一层 cmd.exe，child.pid 是外层 shell 的 PID；
  // 反查拿到的才是真正监听端口的 node 进程 —— 断言它确实是活着的、且不是那个失真值。
  assert.ok(status.pid && status.pid > 0, '应报出端口上的真实 PID');
  assert.notEqual(status.pid, 999999, '不能把失真 PID 当成真实进程');
  assert.equal(isProcessAlive(status.pid), true, '报出的 PID 必须是活进程');
  assert.equal(status.pidSource, 'port');
  assert.equal(status.stalePid, 999999);
});

test('端口被陌生进程占用时不得误杀', async (t) => {
  withTempProbeDir(t);
  // 命令行里没有 `cli.js probe`，不是我们的探针。
  const script = `
    const net = require('node:net');
    const srv = net.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => process.stdout.write(String(srv.address().port) + '\\n'));
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no port')), 10000);
    child.stdout.once('data', (b) => { clearTimeout(timer); resolve(parseInt(String(b).trim(), 10)); });
  });

  writeProbePid(999999);
  writeProbeState({ pid: 999999, port, host: '127.0.0.1', startedAt: Date.now() });

  const res = await stopProbe({ port, host: '127.0.0.1' });
  assert.equal(res.stopped, false, '端口仍被占用时必须如实报告未停止');
  assert.equal(res.killed.length, 0, '不能动不是本项目的进程');
  assert.equal(child.exitCode, null, '陌生进程必须活着');
});

// PID 文件是「不可信输入」：探针被强杀后文件会留下旧 PID，Windows 又把这个号
// 复用给无关进程。probe:stop 过去只认文件，会对着用户的编辑器发 SIGTERM。
test('PID 文件指向无关进程时不得按文件误杀', async (t) => {
  withTempProbeDir(t);
  const script = 'setInterval(() => {}, 1000);';
  const victim = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { victim.kill('SIGKILL'); } catch {} });
  await new Promise((r) => setTimeout(r, 300));

  // 端口上没有监听者，PID 文件却指向这个无关进程。
  writeProbePid(victim.pid);
  writeProbeState({ pid: victim.pid, port: 4397, host: '127.0.0.1', startedAt: Date.now() });

  const res = await stopProbe({ port: 4397, host: '127.0.0.1' });
  assert.equal(res.killed.includes(victim.pid), false, '命令行对不上就不是探针，不能结束它');
  assert.equal(victim.exitCode, null, '无关进程必须活着');
});

// 端口反查是 probe:stop 的最后兜底，解析错了就等于没有兜底。
// 事故：两种输出共用一条靠前导空白锚定的正则，lsof 的裸 PID 行首匹配不上，
// 单个监听者时反查结果为空；而 macOS 没有 ss，走的正是 lsof 这条路径。
test('端口反查能解析 lsof 裸 PID 与 ss 的 pid= 两种输出', () => {
  assert.deepEqual(parseLsofPids('46780\n'), [46780], 'lsof 单行裸 PID 必须能取到');
  assert.deepEqual(parseLsofPids('46780\n46781\n'), [46780, 46781], 'lsof 多行不能丢第一个');
  assert.deepEqual(parseLsofPids(''), [], '端口无监听时为空');
  assert.deepEqual(
    parseSsPids('LISTEN 0 511 *:4300 *:* users:(("node",pid=46780,fd=22))'),
    [46780],
    'ss 单个 pid= 必须能取到'
  );
  assert.deepEqual(
    parseSsPids('LISTEN 0 511 *:4300 *:* users:(("node",pid=46780,fd=22))\nLISTEN 0 511 *:4300 *:* users:(("node",pid=46781,fd=23))'),
    [46780, 46781],
    'ss 多行必须全部取到'
  );
});
