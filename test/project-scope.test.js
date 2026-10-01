import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/storage/database.js';
import { Coordinator } from '../src/daemon/coordinator.js';
import { StateService } from '../src/domain/state.js';
import { MessageService } from '../src/domain/messages.js';
import { EventEmitter } from 'node:events';

test('项目级作用域与隔离验证 (Project Scoping)', async (t) => {
  let db, bus, coordinator, stateService, messageService;

  t.beforeEach(() => {
    db = createDatabase(':memory:');
    bus = new EventEmitter();
    coordinator = new Coordinator(db, bus);
    stateService = new StateService(db, bus);
    messageService = new MessageService(db, bus);
    messageService.agentResolver = (id) => Boolean(coordinator.getAgent(id));

    coordinator.registerAgent({ id: 'agent-p1', name: 'Agent 1', provider: 'test', sessionId: 's1', projectId: 'proj-1' });
    coordinator.registerAgent({ id: 'agent-p2', name: 'Agent 2', provider: 'test', sessionId: 's2', projectId: 'proj-2' });
  });

  t.afterEach(() => {
    try { db.close(); } catch {}
  });

  await t.test('不同项目的同名文件声明互不冲突', () => {
    const res1 = coordinator.declareIntent({
      agentId: 'agent-p1',
      intentSummary: 'Edit common file in P1',
      claims: [{ type: 'file', target: 'src/config.js' }],
      projectId: 'proj-1'
    });
    assert.equal(res1.status, 'GRANTED');

    // 在另一个项目声明同样路径，应各自拥有租约，互不阻塞
    const res2 = coordinator.declareIntent({
      agentId: 'agent-p2',
      intentSummary: 'Edit common file in P2',
      claims: [{ type: 'file', target: 'src/config.js' }],
      projectId: 'proj-2'
    });
    assert.equal(res2.status, 'GRANTED');
  });

  await t.test('同项目内的文件声明依然严格判冲', () => {
    coordinator.registerAgent({ id: 'agent-p1-b', name: 'Agent 1-B', provider: 'test', sessionId: 's1b', projectId: 'proj-1' });

    const res1 = coordinator.declareIntent({
      agentId: 'agent-p1',
      intentSummary: 'Lock file',
      claims: [{ type: 'file', target: 'src/user.js' }],
      projectId: 'proj-1'
    });
    assert.equal(res1.status, 'GRANTED');

    const res2 = coordinator.declareIntent({
      agentId: 'agent-p1-b',
      intentSummary: 'Attempt conflict',
      claims: [{ type: 'file', target: 'src/user.js' }],
      projectId: 'proj-1'
    });
    assert.equal(res2.status, 'WAITING');
  });

  await t.test('不同项目的 symbol 声明互不冲突', () => {
    const res1 = coordinator.declareIntent({
      agentId: 'agent-p1',
      intentSummary: 'Refactor handleAuth in P1',
      claims: [{ type: 'symbol', target: 'handleAuth' }],
      projectId: 'proj-1'
    });
    assert.equal(res1.status, 'GRANTED');

    const res2 = coordinator.declareIntent({
      agentId: 'agent-p2',
      intentSummary: 'Refactor handleAuth in P2',
      claims: [{ type: 'symbol', target: 'handleAuth' }],
      projectId: 'proj-2'
    });
    assert.equal(res2.status, 'GRANTED');
  });

  await t.test('共享状态按 project_id 严格隔离', () => {
    stateService.set('default', 'version', '1.0.0', 'agent-p1', null, 'proj-1');
    stateService.set('default', 'version', '2.0.0', 'agent-p2', null, 'proj-2');

    const v1 = stateService.get('default', 'version', 'proj-1');
    const v2 = stateService.get('default', 'version', 'proj-2');

    assert.equal(v1.value, '1.0.0');
    assert.equal(v2.value, '2.0.0');
  });

  await t.test('消息收件箱按 project_id 过滤', () => {
    messageService.send({ from: 'agent-p1', to: 'agent-p1', content: 'Msg in P1', projectId: 'proj-1' });
    messageService.send({ from: 'agent-p2', to: 'agent-p2', content: 'Msg in P2', projectId: 'proj-2' });

    const inboxP1 = messageService.inbox('agent-p1', 10, 'proj-1');
    const inboxP2 = messageService.inbox('agent-p2', 10, 'proj-2');

    assert.equal(inboxP1.length, 1);
    assert.equal(inboxP1[0].content, 'Msg in P1');
    assert.equal(inboxP2.length, 1);
    assert.equal(inboxP2[0].content, 'Msg in P2');
  });

  await t.test('Hook 快速判冲通道支持 project_id', () => {
    const r1 = coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-p1',
      filePath: 'src/index.js',
      projectId: 'proj-1'
    });
    assert.equal(r1.allow, true);

    // proj-2 的 agent 写同名文件：放行
    const r2 = coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-p2',
      filePath: 'src/index.js',
      projectId: 'proj-2'
    });
    assert.equal(r2.allow, true);

    // proj-1 的另一个 agent 写同名文件：硬拦截
    coordinator.registerAgent({ id: 'agent-p1-c', name: 'Agent 1-C', provider: 'test', sessionId: 's1c', projectId: 'proj-1' });
    const r3 = coordinator.fastCheckAndAutoClaim({
      agentId: 'agent-p1-c',
      filePath: 'src/index.js',
      projectId: 'proj-1'
    });
    assert.equal(r3.allow, false);
  });
});
