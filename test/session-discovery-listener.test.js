import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createDatabase } from '../src/storage/database.js';
import { CoordinatorEngine } from '../src/daemon/coordinator.js';
import { startDaemon } from '../src/daemon/index.js';

test('新会话主动发现与目录变更监听 (Session Discovery & Directory Watcher)', async (t) => {
  const tempBase = mkdtempSync(join(tmpdir(), 'nexus-sess-test-'));
  const sessionsDir = join(tempBase, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  const db = createDatabase(':memory:');
  const eventBus = new EventEmitter();
  const coordinator = new CoordinatorEngine(db, eventBus, { isTest: true, claudeSessionsDir: sessionsDir });

  t.after(() => {
    coordinator.unwatchClaudeSessions();
    db.close();
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {}
  });

  await t.test('1. 目录中生成新会话文件时，syncClaudeSessions 发现并广播 agent:status (is_new: true)', async () => {
    const events = [];
    eventBus.on('agent:status', (e) => events.push(e));

    const sess1Path = join(sessionsDir, `${process.pid}.json`);
    writeFileSync(sess1Path, JSON.stringify({
      pid: process.pid,
      sessionId: 'sess-new-123',
      name: '自动化测试新会话',
      cwd: 'D:/mock/test-workspace',
      status: 'busy',
      startedAt: Date.now(),
      updatedAt: Date.now()
    }), 'utf8');

    const result = coordinator.syncClaudeSessions(Date.now(), sessionsDir);
    assert.equal(result.scanned, 1);
    assert.equal(result.added.length, 1);
    assert.equal(result.added[0].id, 'claude-sess-new-123');
    assert.equal(result.added[0].name, '自动化测试新会话');

    const agentInDb = db.prepare('SELECT * FROM agents WHERE id = ?').get('claude-sess-new-123');
    assert.ok(agentInDb);
    assert.equal(agentInDb.name, '自动化测试新会话');
    assert.equal(agentInDb.status, 'running');

    assert.ok(events.length >= 1);
    const newEvent = events.find(e => e.agent_id === 'claude-sess-new-123' && e.is_new === true);
    assert.ok(newEvent, '必须发射含有 is_new: true 的 agent:status 事件');
  });

  await t.test('2. 会话状态由 busy 变为 idle 时，更新并广播状态变更事件', async () => {
    const events = [];
    eventBus.on('agent:status', (e) => events.push(e));

    const sess1Path = join(sessionsDir, `${process.pid}.json`);
    writeFileSync(sess1Path, JSON.stringify({
      pid: process.pid,
      sessionId: 'sess-new-123',
      name: '自动化测试新会话',
      cwd: 'D:/mock/test-workspace',
      status: 'idle',
      startedAt: Date.now(),
      updatedAt: Date.now()
    }), 'utf8');

    const result = coordinator.syncClaudeSessions(Date.now(), sessionsDir);
    assert.equal(result.updated.length, 1);
    assert.equal(result.updated[0].status, 'idle');

    const agentInDb = db.prepare('SELECT * FROM agents WHERE id = ?').get('claude-sess-new-123');
    assert.equal(agentInDb.status, 'idle');

    const statusEvent = events.find(e => e.agent_id === 'claude-sess-new-123' && e.status === 'idle');
    assert.ok(statusEvent, '会话状态变更时必须广播 agent:status');
  });

  await t.test('3. watchClaudeSessions 挂载后，新增文件通过文件系统监视器自动触发同步', async () => {
    const watcher = coordinator.watchClaudeSessions(sessionsDir);
    assert.ok(watcher, '应成功返回文件监视器实例');

    const events = [];
    eventBus.on('agent:status', (e) => events.push(e));

    const sess2Path = join(sessionsDir, `${process.pid + 99999}.json`);
    // 写入一个虚拟的新会话文件（由于 PID 无关但进程已死或无管道，此处模拟通过）
    writeFileSync(sess2Path, JSON.stringify({
      pid: process.pid,
      sessionId: 'sess-watched-456',
      name: 'Watch 感知新会话',
      cwd: 'D:/mock/test-workspace-2',
      status: 'busy',
      startedAt: Date.now(),
      updatedAt: Date.now()
    }), 'utf8');

    // 等待 debounce 300ms 触发
    await new Promise(r => setTimeout(r, 600));

    const agent2 = db.prepare('SELECT * FROM agents WHERE id = ?').get('claude-sess-watched-456');
    assert.ok(agent2, 'watch 监视器应在文件变动后自动同步入库');
    assert.equal(agent2.name, 'Watch 感知新会话');

    coordinator.unwatchClaudeSessions();
  });
});

test('REST API /api/status 接口健康与在席统计', async (t) => {
  const daemon = await startDaemon({ port: 0, dbPath: ':memory:', isTest: true });
  t.after(async () => {
    clearInterval(daemon.cleanupTimer);
    daemon.coordinator.unwatchClaudeSessions?.();
    daemon.db.close();
    await new Promise((r) => daemon.server.close(r));
  });

  const res = await fetch(`http://127.0.0.1:${daemon.port}/api/status`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(typeof data.active_agents_count, 'number');
  assert.equal(typeof data.working, 'number');
  assert.equal(typeof data.waiting, 'number');
  assert.equal(typeof data.idle, 'number');
});
