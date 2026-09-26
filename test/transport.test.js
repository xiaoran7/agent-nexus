import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { startTestDaemon } from './helpers.js';
import {
  installClaudeHook,
  installCodexHook,
  installZCodeHook
} from '../src/installer/index.js';

// 这一层只做一件事：起真实 HTTP/WS 栈跑端到端。之前 47 个用例全部直接调用
// domain 层，transport 与依赖装配零覆盖——node_modules 里 ws 只是 Vite 顺带装进来的
// 传递依赖，干净环境直接 ERR_MODULE_NOT_FOUND，测试却全绿。
test('daemon 在真实 HTTP 栈上完成一条协调链路', async (t) => {
  const d = await startTestDaemon();
  t.after(() => d.close());

  await t.test('health 可达', async () => {
    const res = await d.request('/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'healthy');
  });

  await t.test('先到者经 HTTP 拿到租约', async () => {
    const res = await d.request('/api/intents/declare', {
      method: 'POST',
      body: {
        agent_id: 'codex-http-1',
        summary: 'refactor client',
        claims: [{ type: 'file', target: 'src/client.js' }],
        ttl_seconds: 300
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'GRANTED');
    assert.ok(res.json.leaseId, '应颁发 leaseId');
  });

  await t.test('后到者经 HTTP 被判 WAITING', async () => {
    const res = await d.request('/api/intents/declare', {
      method: 'POST',
      body: {
        agent_id: 'claude-http-2',
        summary: 'also touching client',
        claims: [{ type: 'file', target: 'src/client.js' }]
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'WAITING');
    assert.equal(res.json.blockedBy, 'codex-http-1');
  });

  await t.test('hook 通道经 HTTP 硬拦截', async () => {
    const res = await d.request('/api/hook/check', {
      method: 'POST',
      body: {
        agent_id: 'claude-http-2',
        provider: 'claude',
        session_id: 'http2',
        file_path: 'src/client.js'
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.allow, false, '他人持锁时应硬拦截');
  });

  await t.test('释放租约后原路径可再被占用', async () => {
    const leaseId = d.db
      .prepare("SELECT id FROM leases WHERE agent_id = 'codex-http-1'")
      .get().id;

    const released = await d.request(`/api/leases/${leaseId}/release`, {
      method: 'POST',
      body: { agent_id: 'codex-http-1' }
    });
    assert.equal(released.status, 200);
    assert.equal(released.json.success, true);

    const again = await d.request('/api/intents/declare', {
      method: 'POST',
      body: {
        agent_id: 'claude-http-2',
        summary: 'retry after release',
        claims: [{ type: 'file', target: 'src/client.js' }]
      }
    });
    assert.equal(again.json.status, 'GRANTED', '释放后应能重新拿到租约');
  });

  await t.test('dashboard 快照经 HTTP 可读', async () => {
    const res = await d.request('/api/dashboard');

    assert.equal(res.status, 200);
    assert.ok(res.json.agents.length >= 2);
    assert.ok(res.json.timeline.length >= 4, '时间线应记录整条链路');
  });
});

// 输入校验：非法请求必须是 400 且不得写入任何协调状态。
// 空 file_path 曾被归一化成 '' 并落成一条真实 claim，第一个这样做的 agent
// 会把所有同样发空目标的 agent 永久锁死。
test('HTTP 层拒绝非法输入且不产生脏状态', async (t) => {
  const d = await startTestDaemon();
  t.after(() => d.close());

  const claimCount = () =>
    d.db.prepare('SELECT count(*) AS n FROM claims').get().n;

  await t.test('hook 通道缺 file_path 返回 400', async () => {
    const res = await d.request('/api/hook/check', {
      method: 'POST',
      body: { agent_id: 'x', provider: 'unknown', session_id: 'default' }
    });

    assert.equal(res.status, 400, '缺失目标文件应报 400 而不是放行');
    assert.equal(res.json.allow, undefined, '非法请求不应返回 allow 判定');
  });

  await t.test('非法请求没有落成空路径 claim', async () => {
    assert.equal(claimCount(), 0, 'claims 表不应出现任何记录');
  });

  await t.test('一个 agent 的非法请求不会拦下其他 agent', async () => {
    const first = await d.request('/api/hook/check', {
      method: 'POST',
      body: { agent_id: 'no-path-1', provider: 'claude', session_id: 's1' }
    });
    assert.equal(first.status, 400);

    // 换一个带真实目标的 agent，必须正常放行。
    const second = await d.request('/api/hook/check', {
      method: 'POST',
      body: { agent_id: 'no-path-2', provider: 'claude', session_id: 's2', file_path: 'src/ok.js' }
    });
    assert.equal(second.status, 200);
    assert.equal(second.json.allow, true, '空载荷投毒不应波及其他 agent');
  });

  await t.test('空串与工作目录同样被拒', async () => {
    for (const bad of ['', '   ', '.', './']) {
      const res = await d.request('/api/hook/check', {
        method: 'POST',
        body: { agent_id: 'edge-1', provider: 'claude', session_id: 'e', file_path: bad }
      });
      assert.equal(res.status, 400, `目标 "${bad}" 应被拒绝`);
    }
  });

  await t.test('declare 缺 agent_id 返回 400 而非 SQLite 绑定错误', async () => {
    const res = await d.request('/api/intents/declare', {
      method: 'POST',
      body: { summary: 'no agent', claims: [{ type: 'file', target: 'src/a.js' }] }
    });

    assert.equal(res.status, 400);
    assert.match(res.json.error, /agent_id/);
    assert.doesNotMatch(res.json.error, /SQLite|parameter/i, '不应把底层驱动错误透给调用方');
  });

  await t.test('未知 claim 类型返回 400', async () => {
    const res = await d.request('/api/intents/declare', {
      method: 'POST',
      body: {
        agent_id: 'claude-bad',
        summary: 'bad claim type',
        claims: [{ type: 'directory', target: 'src/x' }]
      }
    });

    assert.equal(res.status, 400);
    assert.match(res.json.error, /claim type/i);
  });

  await t.test('畸形 JSON 返回 400 且不泄露解析器细节', async () => {
    const res = await fetch(`${d.base}/api/intents/declare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json'
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /not valid JSON/i);
  });

  await t.test('非法声明不留下半截 intent 记录', async () => {
    const res = await d.request('/api/intents/declare', {
      method: 'POST',
      body: {
        agent_id: 'claude-partial',
        summary: 'first claim valid, second invalid',
        claims: [
          { type: 'file', target: 'src/valid.js' },
          { type: 'file', target: '' }
        ]
      }
    });

    assert.equal(res.status, 400);
    const orphan = d.db
      .prepare("SELECT count(*) AS n FROM intents WHERE agent_id = 'claude-partial'")
      .get().n;
    assert.equal(orphan, 0, '整体校验失败时不应写入任何 intent');
  });

  await t.test('daemon 仍健康', async () => {
    const res = await d.request('/health');
    assert.equal(res.status, 200);
  });
});

// 跨源策略：daemon 只监听本机，但浏览器不理会目标地址是不是本机。
test('跨源请求默认不放行', async (t) => {
  const d = await startTestDaemon();
  t.after(() => d.close());

  await t.test('未列入白名单的 Origin 拿不到 CORS 头', async () => {
    const res = await d.request('/api/agents', { headers: { Origin: 'https://evil.example' } });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  await t.test('未列入白名单的 Origin 预检被拒', async () => {
    const res = await fetch(`${d.base}/api/agents`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
    });

    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

// 白名单生效的另一半。允许列表按请求读取环境变量，所以这里直接改环境变量即可，
// 不需要重载模块或起独立进程。
test('NEXUS_ALLOWED_ORIGINS 放行指定来源', async (t) => {
  process.env.NEXUS_ALLOWED_ORIGINS = 'https://allowed.example,https://other.example';
  t.after(() => delete process.env.NEXUS_ALLOWED_ORIGINS);

  const d = await startTestDaemon();
  t.after(() => d.close());

  await t.test('白名单内的 Origin 被回显', async () => {
    const res = await d.request('/api/agents', {
      headers: { Origin: 'https://allowed.example' }
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
    assert.equal(res.headers.get('vary'), 'Origin', '应声明按 Origin 变化，避免缓存串味');
  });

  await t.test('白名单内的 Origin 预检通过', async () => {
    const res = await fetch(`${d.base}/api/agents`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://allowed.example', 'Access-Control-Request-Method': 'POST' }
    });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
  });

  await t.test('白名单外的 Origin 仍拿不到头', async () => {
    const res = await d.request('/api/agents', {
      headers: { Origin: 'https://evil.example' }
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

// WebSocket 推送：面板的实时性依赖它，此前完全没有覆盖。
test('WebSocket 广播时间线与唤醒事件', async (t) => {
  const d = await startTestDaemon();
  // 登记在 socket 建立之前：连接握手失败时也要保证 daemon 被关掉。
  // stopDaemon 内部会 terminate 掉所有 ws 连接，这里不用重复收尾。
  t.after(() => d.close());
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);

  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  t.after(() => ws.terminate());

  await t.test('声明意图后收到 timeline 广播', async () => {
    await d.request('/api/intents/declare', {
      method: 'POST',
      body: {
        agent_id: 'codex-ws-1',
        summary: 'ws event check',
        claims: [{ type: 'file', target: 'src/ws.js' }]
      }
    });

    // 广播是异步的，等一个事件循环让消息抵达。
    await new Promise((r) => setTimeout(r, 100));

    const timeline = messages.find((m) => m.type === 'timeline');
    assert.ok(timeline, '应收到 timeline 事件');
    assert.equal(timeline.data.event_type, 'agent:registered');
  });

  await t.test('释放租约时向等待者广播 agent:woken', async () => {
    await d.request('/api/intents/declare', {
      method: 'POST',
      body: {
        agent_id: 'claude-ws-2',
        summary: 'waiting on ws.js',
        claims: [{ type: 'file', target: 'src/ws.js' }]
      }
    });

    const leaseId = d.db
      .prepare("SELECT id FROM leases WHERE agent_id = 'codex-ws-1'")
      .get().id;

    await d.request(`/api/leases/${leaseId}/release`, {
      method: 'POST',
      body: { agent_id: 'codex-ws-1' }
    });

    await new Promise((r) => setTimeout(r, 100));

    const woken = messages.find((m) => m.type === 'agent:woken');
    assert.ok(woken, '应收到 agent:woken 事件');
    assert.equal(woken.data.agent_id, 'claude-ws-2');
  });
});

// Hook 脚本按真实 Claude Code 的载荷形状解析目标文件。
// PreToolUse 的 stdin 里有 tool_name 和 tool_input；Write/Edit 带 file_path，
// Bash 只有 command，需要从中认出写入目标。
test('hook 脚本识别真实 Claude Code 载荷', async (t) => {
  const d = await startTestDaemon();
  t.after(() => d.close());

  const hook = join(import.meta.dirname, '../src/hook/nexus-hook.mjs');

  // 用真实的 PreToolUse 载荷跑一次 hook 脚本，拿退出码。
  const runHook = (payload, sessionId) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [hook], {
        env: {
          ...process.env,
          NEXUS_PORT: String(d.port),
          NEXUS_SESSION_ID: sessionId,
          // 继承宿主进程的环境会让所有用例塌成同一个 agent（都算"自己人"，
          // 于是永远放行）。显式清掉身份变量，行为才可预测。
          CLAUDE_CODE_SESSION_ID: undefined,
          NEXUS_AGENT_PROVIDER: undefined
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolve({ code, stderr }));
      child.stdin.end(JSON.stringify(payload));
    });

  const preToolUse = (toolName, toolInput) => ({
    session_id: 'hs1',
    cwd: process.cwd(),
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'toolu_test'
  });

  await d.request('/api/hook/check', {
    method: 'POST',
    body: { agent_id: 'holder', provider: 'claude', session_id: 'holder', file_path: 'src/locked.js' }
  });

  await t.test('Edit 他人锁定的文件被拦截', async () => {
    const res = await runHook(
      preToolUse('Edit', { file_path: 'src/locked.js', old_string: 'a', new_string: 'b' }),
      'intruder'
    );

    assert.equal(res.code, 2, '他人持锁时应以退出码 2 拦截');
    assert.match(res.stderr, /CONFLICT|BLOCKED/i);
  });

  await t.test('Bash 写入他人锁定的文件同样被拦截', async () => {
    const res = await runHook(
      preToolUse('Bash', { command: `echo "{}" > "src/locked.js"` }),
      'intruder2'
    );

    assert.equal(res.code, 2, 'Bash 重定向写入被锁文件时应拦截');
  });

  await t.test('Bash 读取被锁文件不被误拦', async () => {
    const read = await runHook(
      preToolUse('Bash', { command: 'cat src/locked.js' }),
      'reader'
    );
    assert.equal(read.code, 0, '读取不应被当成写入');

    // 写目标完全在工作目录之外：不该拿源文件去判冲，
    // 否则 `cp a.js /tmp/backup.js` 会被误判成"要写 a.js"。
    const outside = await runHook(
      preToolUse('Bash', { command: 'cp src/locked.js /tmp/backup-nx-test.js' }),
      'reader2'
    );
    assert.equal(outside.code, 0, '写目标在仓库外时不应判冲');
  });

  await t.test('cp 到工作目录内时按目的端判冲', async () => {
    await d.request('/api/hook/check', {
      method: 'POST',
      body: { agent_id: 'holder2', provider: 'claude', session_id: 'holder2', file_path: 'src/dest.js' }
    });

    const res = await runHook(
      preToolUse('Bash', { command: 'cp src/other.js src/dest.js' }),
      'copier'
    );

    assert.equal(res.code, 2, 'cp 的目的端被锁时应拦截');
  });

  await t.test('无目标文件时静默放行', async () => {
    // Read 工具没有写入语义，脚本不该把它的 file_path 当成写入目标。
    const res = await runHook(preToolUse('Read', { file_path: 'src/locked.js' }), 'readonly');

    assert.equal(res.code, 0, '只读工具不应被当成写入而拦截');
  });
});

test('安装器把 hook 写进宿主配置', async (t) => {
  const originalEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const originalCwd = process.cwd();
  const fakeHome = mkdtempSync(join(tmpdir(), 'nexus-home-'));
  t.after(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.chdir(originalCwd);
    rmSync(fakeHome, { recursive: true, force: true });
  });

  // os.homedir() 在 Windows 上读 USERPROFILE，POSIX 上读 HOME。
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  const readSettings = () =>
    JSON.parse(readFileSync(join(fakeHome, '.claude', 'settings.json'), 'utf8'));
  // Claude Code 的 PreToolUse 是 matcher 分组结构，不是命令字符串数组。
  const hookHandlers = (settings) =>
    settings.hooks.PreToolUse.flatMap((g) => g.hooks || []).filter((h) => h.command.includes('nexus-hook.mjs'));
  const hookCommands = (settings) => hookHandlers(settings).map((h) => h.command);

  await t.test('写出 Claude Code 期望的嵌套结构', () => {
    installClaudeHook();

    const settingsPath = join(fakeHome, '.claude', 'settings.json');
    assert.ok(existsSync(settingsPath), '应创建 Claude 配置文件');

    const settings = readSettings();
    for (const group of settings.hooks.PreToolUse) {
      assert.equal(typeof group, 'object', 'PreToolUse 元素应是 matcher 分组对象，不是字符串');
      assert.ok('matcher' in group, '分组应带 matcher');
      assert.ok(Array.isArray(group.hooks), '分组应带 hooks 数组');
    }

    const [handler] = hookHandlers(settings);
    assert.equal(handler.type, 'command', '处理器 type 必须是 command');
    assert.ok(handler.timeout > 0, '应设置超时，避免挂死宿主');
  });

  await t.test('重复安装不产生重复条目', () => {
    installClaudeHook();
    installClaudeHook();

    assert.equal(hookHandlers(readSettings()).length, 1, '重复安装应保持幂等');
  });

  await t.test('升级历史字符串写法的旧条目', () => {
    // 旧版写的是 ["node \"...\""]，宿主不认；再装一次应就地升级而不是叠加。
    const settingsPath = join(fakeHome, '.claude', 'settings.json');
    const script = hookCommands(readSettings())[0].replace(/^node\s+"|"$/g, '');
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { PreToolUse: [`node "${script}"`] } }, null, 2),
      'utf8'
    );

    installClaudeHook();

    const settings = readSettings();
    assert.equal(hookHandlers(settings).length, 1, '旧条目应被升级替换，不重复叠加');
    for (const group of settings.hooks.PreToolUse) {
      assert.equal(typeof group, 'object', '升级后不应再有字符串条目');
    }
  });

  await t.test('写出的路径真实存在', () => {
    // 写进用户配置的是一条长期生效的命令，路径必须指向实际文件。
    const scriptPath = hookCommands(readSettings())[0].replace(/^node\s+"|"$/g, '');

    assert.ok(isAbsolute(scriptPath), `hook 路径应为绝对路径: ${scriptPath}`);
    assert.ok(existsSync(scriptPath), `hook 路径必须真实存在: ${scriptPath}`);
  });

  await t.test('换工作目录安装，路径不受影响', () => {
    // 曾经用 process.cwd() 拼路径，从别处执行就会写进一条死路径。
    const elsewhere = mkdtempSync(join(tmpdir(), 'nexus-cwd-'));
    t.after(() => rmSync(elsewhere, { recursive: true, force: true }));

    process.chdir(elsewhere);
    installClaudeHook();

    const scriptPath = hookCommands(readSettings())[0].replace(/^node\s+"|"$/g, '');
    assert.ok(
      existsSync(scriptPath),
      `从 ${elsewhere} 执行安装，写出的 hook 路径仍应指向真实文件`
    );
  });

  await t.test('保留用户已有的其他 hook', () => {
    const settingsPath = join(fakeHome, '.claude', 'settings.json');
    const settings = readSettings();
    settings.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh' }] });
    settings.hooks.PostToolUse = [{ matcher: '*', hooks: [{ type: 'command', command: 'notify.sh' }] }];
    settings.model = 'opus';
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    installClaudeHook();

    const after = readSettings();
    const allCommands = after.hooks.PreToolUse.flatMap((g) => g.hooks || []).map((h) => h.command);
    assert.ok(allCommands.includes('lint.sh'), '不应抹掉别人的 PreToolUse hook');
    assert.equal(after.hooks.PostToolUse[0].hooks[0].command, 'notify.sh', '不应动其他事件');
    assert.equal(after.model, 'opus', '不应动无关配置');
  });

  await t.test('配置损坏时报错且不覆盖原文件', () => {
    const settingsPath = join(fakeHome, '.claude', 'settings.json');
    const broken = '{ this is not json';
    writeFileSync(settingsPath, broken, 'utf8');

    assert.throws(() => installClaudeHook(), /Cannot parse/);
    assert.equal(readFileSync(settingsPath, 'utf8'), broken, '原文件必须原样保留');
  });

  await t.test('Codex 与 ZCode 配置不丢已有字段', () => {
    const codexPath = join(fakeHome, '.agenthub', 'coordinator.json');
    mkdirSync(join(fakeHome, '.agenthub'), { recursive: true });
    writeFileSync(codexPath, JSON.stringify({ otherRuntime: { keepMe: true } }), 'utf8');

    installCodexHook();

    const codex = JSON.parse(readFileSync(codexPath, 'utf8'));
    assert.deepEqual(codex.otherRuntime, { keepMe: true }, '合并而非整份覆盖');
    assert.equal(codex.enabled, true);
    assert.ok(existsSync(codex.hook_script), 'hook_script 应指向真实脚本');

    const zcodePath = join(fakeHome, '.zcode', 'nexus-guard.json');
    installZCodeHook();
    const zcode = JSON.parse(readFileSync(zcodePath, 'utf8'));
    assert.equal(zcode.enabled, true);
    assert.ok(existsSync(zcode.pre_edit_hook));
  });
});
