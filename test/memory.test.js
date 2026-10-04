import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDatabase } from '../src/storage/database.js';
import { ProjectMemoryService } from '../src/domain/memory.js';

test('ProjectMemoryService: 核心功能与项目隔离', async (t) => {
  let db, bus, memoryService;

  t.beforeEach(() => {
    db = createDatabase(':memory:');
    bus = new EventEmitter();
    memoryService = new ProjectMemoryService(db, bus);
  });

  t.afterEach(() => {
    try { db.close(); } catch {}
  });

  await t.test('添加与读取记忆，支持分类与来源 Agent', () => {
    const mem = memoryService.set('proj-1', {
      category: 'architecture',
      key: 'db_engine',
      content: '使用 SQLite WAL 模式，确保并发高吞吐',
      sourceAgentId: 'agent-alpha'
    });

    assert.equal(mem.project_id, 'proj-1');
    assert.equal(mem.category, 'architecture');
    assert.equal(mem.key, 'db_engine');
    assert.equal(mem.content, '使用 SQLite WAL 模式，确保并发高吞吐');
    assert.equal(mem.source_agent_id, 'agent-alpha');

    const read = memoryService.get('proj-1', 'db_engine', 'architecture');
    assert.deepEqual(read, mem);
  });

  await t.test('同分类同 Key 原子更新 (Upsert) 不产生多余行', () => {
    memoryService.set('proj-1', {
      category: 'rule',
      key: 'code_style',
      content: '强制使用 ESLint 检查'
    });

    const updated = memoryService.set('proj-1', {
      category: 'rule',
      key: 'code_style',
      content: '强制使用 ESLint 和 Prettier 检查'
    });

    assert.equal(updated.content, '强制使用 ESLint 和 Prettier 检查');
    const list = memoryService.list('proj-1');
    assert.equal(list.length, 1);
  });

  await t.test('严格的项目作用域隔离', () => {
    memoryService.set('proj-A', {
      category: 'gotcha',
      key: 'proxy_bug',
      content: 'Node fetch 不走 HTTP_PROXY'
    });

    memoryService.set('proj-B', {
      category: 'gotcha',
      key: 'proxy_bug',
      content: 'Python requests 走 HTTP_PROXY'
    });

    const memA = memoryService.get('proj-A', 'proxy_bug');
    const memB = memoryService.get('proj-B', 'proxy_bug');

    assert.equal(memA.content, 'Node fetch 不走 HTTP_PROXY');
    assert.equal(memB.content, 'Python requests 走 HTTP_PROXY');

    assert.equal(memoryService.list('proj-A').length, 1);
    assert.equal(memoryService.list('proj-B').length, 1);
  });

  await t.test('模糊搜索与分类过滤', () => {
    memoryService.set('proj-1', {
      category: 'architecture',
      key: 'auth_jwt',
      content: 'JWT 签名必须采用 RS256'
    });
    memoryService.set('proj-1', {
      category: 'rule',
      key: 'git_commit',
      content: '遵循 Conventional Commits 格式'
    });

    const found = memoryService.search('proj-1', 'RS256');
    assert.equal(found.length, 1);
    assert.equal(found[0].key, 'auth_jwt');

    const byCat = memoryService.list('proj-1', { category: 'rule' });
    assert.equal(byCat.length, 1);
    assert.equal(byCat[0].key, 'git_commit');
  });

  await t.test('删除记忆支持按 ID 或按 Key', () => {
    const mem = memoryService.set('proj-1', {
      category: 'milestone',
      key: 'm1',
      content: '完成了基础搭建'
    });

    const delRes = memoryService.delete('proj-1', mem.id);
    assert.equal(delRes.success, true);
    assert.equal(delRes.deleted, 1);
    assert.equal(memoryService.get('proj-1', 'm1'), null);
  });
});
