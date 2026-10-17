import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDatabase } from '../src/storage/database.js';
import { CoordinatorEngine } from '../src/daemon/coordinator.js';
import { MessageService } from '../src/domain/messages.js';
import { ProjectRegistry } from '../src/domain/project-registry.js';
import { ProjectMemoryService } from '../src/domain/memory.js';
import { createRestRouter } from '../src/transport/rest.js';
import { TokenStore, generateToken } from '../src/transport/auth.js';

test('Master Command Broadcast: 全项目指令广播与信箱直达', async (t) => {
  let db, bus, coordinator, messageService, memoryService, projectRegistry, tokenStore, router;

  t.beforeEach(() => {
    db = createDatabase(':memory:');
    bus = new EventEmitter();
    coordinator = new CoordinatorEngine(db, bus);
    messageService = new MessageService(db, bus);
    memoryService = new ProjectMemoryService(db, bus);
    projectRegistry = new ProjectRegistry(db, coordinator, bus, null, memoryService);
    tokenStore = new TokenStore();
    tokenStore.issue(generateToken(null)); // operator token

    messageService.agentResolver = (id) => coordinator.getAgent(id);
    router = createRestRouter(coordinator, null, messageService, '', tokenStore, projectRegistry, memoryService);
  });

  t.afterEach(() => {
    try { db.close(); } catch {}
  });

  await t.test('向活跃 Agent 广播指令，自动写入信箱并派发 lead:broadcast 事件', async () => {
    const operatorToken = tokenStore.issue(generateToken(null)).secret;

    // 注册 2 个不同项目的 Agent
    coordinator.registerAgent({
      id: 'agent-worker-1',
      name: 'Worker 1',
      provider: 'claude',
      sessionId: 'sess-1',
      projectId: 'proj-alpha'
    });
    coordinator.registerAgent({
      id: 'agent-worker-2',
      name: 'Worker 2',
      provider: 'claude',
      sessionId: 'sess-2',
      projectId: 'proj-alpha'
    });
    coordinator.registerAgent({
      id: 'agent-other',
      name: 'Other Worker',
      provider: 'claude',
      sessionId: 'sess-3',
      projectId: 'proj-beta'
    });

    let broadcastEventPayload = null;
    bus.on('lead:broadcast', (payload) => {
      broadcastEventPayload = payload;
    });

    // 构造 HTTP Mock 请求
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/api/projects/proj-alpha/broadcast';
    req.headers = {
      host: '127.0.0.1:4300',
      authorization: `Bearer ${operatorToken}`
    };

    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers;
      },
      end(chunk) {
        if (chunk) this.body += chunk;
      }
    };

    const promise = router(req, res);
    req.emit('data', JSON.stringify({
      from: 'sensei',
      content: '🚨 架构调整：停止写入 db.js，优先重构 config.json',
      importance: 'urgent'
    }));
    req.emit('end');

    await promise;

    assert.equal(res.statusCode, 200);
    const result = JSON.parse(res.body);
    assert.equal(result.success, true);
    assert.equal(result.agents_count, 2);
    assert.deepEqual(result.broadcast_to.sort(), ['agent-worker-1', 'agent-worker-2']);

    // 校验总线事件
    assert.ok(broadcastEventPayload);
    assert.equal(broadcastEventPayload.project_id, 'proj-alpha');
    assert.equal(broadcastEventPayload.from, 'sensei');
    assert.equal(broadcastEventPayload.importance, 'urgent');

    // 校验 Agent 信箱是否能拉取到广播消息 (to_agent IS NULL or to_agent = id)
    const inbox1 = messageService.inbox('agent-worker-1', 10, 'proj-alpha');
    assert.equal(inbox1.length, 1);
    assert.equal(inbox1[0].from_agent, 'sensei');
    assert.equal(inbox1[0].importance, 'urgent');
    assert.ok(inbox1[0].content.includes('停止写入 db.js'));

    const inbox2 = messageService.inbox('agent-worker-2', 10, 'proj-alpha');
    assert.equal(inbox2.length, 1);
    assert.equal(inbox2[0].from_agent, 'sensei');

    // 跨项目的 agent-other 不应收到
    const inboxOther = messageService.inbox('agent-other', 10, 'proj-beta');
    assert.equal(inboxOther.length, 0);
  });
});
