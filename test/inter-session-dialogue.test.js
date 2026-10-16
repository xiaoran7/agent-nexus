import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/storage/database.js';
import { CoordinatorEngine } from '../src/daemon/coordinator.js';
import { MessageService } from '../src/domain/messages.js';
import { EventEmitter } from 'node:events';

test('Inter-Session 对话网络与进度更新机制', async (t) => {
  let db, bus, coordinator, messageService;
  const readEvents = [];

  t.beforeEach(() => {
    db = createDatabase(':memory:');
    bus = new EventEmitter();
    readEvents.length = 0;
    bus.on('messages:read', (e) => readEvents.push(e));

    coordinator = new CoordinatorEngine(db, bus);
    messageService = new MessageService(db, bus);

    // 注册两个并发 Session
    coordinator.registerAgent({
      id: 'session-a',
      name: 'Session A (Backend)',
      provider: 'claude',
      sessionId: 'sa',
      projectId: 'test-proj'
    });

    coordinator.registerAgent({
      id: 'session-b',
      name: 'Session B (Frontend)',
      provider: 'claude',
      sessionId: 'sb',
      projectId: 'test-proj'
    });
  });

  t.afterEach(() => {
    try { db.close(); } catch {}
  });

  await t.test('用例 1: Session A 更新进度画像 (reportProgress)', async () => {
    const res = messageService.reportProgress('session-a', '已完成用户中心数据库迁移，正在封装认证中间件', 'test-proj');
    assert.equal(res.agent_id, 'session-a');
    assert.equal(res.progress_summary, '已完成用户中心数据库迁移，正在封装认证中间件');

    const agentRow = db.prepare('SELECT progress_summary FROM agents WHERE id = ?').get('session-a');
    assert.equal(agentRow.progress_summary, '已完成用户中心数据库迁移，正在封装认证中间件');
  });

  await t.test('用例 2: Session B 向 Session A 发起结构化提问并创建 Thread (sendDialogue)', async () => {
    const msg = messageService.sendDialogue({
      from: 'session-b',
      to: 'session-a',
      content: '请问用户认证中间件返回的 Token 结构体包含哪些字段？',
      dialogueType: 'query',
      importance: 'urgent',
      projectId: 'test-proj'
    });

    assert.ok(msg.id);
    assert.equal(msg.from, 'session-b');
    assert.equal(msg.to, 'session-a');
    assert.equal(msg.dialogue_type, 'query');
    assert.equal(msg.status, 'unread');
    assert.ok(msg.thread_id, '未显式指定时应自动生成 thread_id');
  });

  await t.test('用例 3: Session A 查看未读消息并自动标记为已读 (readDialogue)', async () => {
    // Session B 发送一条消息
    const sent = messageService.sendDialogue({
      from: 'session-b',
      to: 'session-a',
      content: '前端需要对接接口 mock',
      dialogueType: 'query',
      projectId: 'test-proj'
    });

    // Session A 读取自己的未读消息并自动标记已读
    const msgs = messageService.readDialogue('session-a', {
      unreadOnly: true,
      markAsRead: true,
      projectId: 'test-proj'
    });

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].id, sent.id);
    assert.equal(msgs[0].from_agent_name, 'Session B (Frontend)');
    assert.equal(msgs[0].content, '前端需要对接接口 mock');

    // 验证事件广播
    assert.equal(readEvents.length, 1);
    assert.equal(readEvents[0].agent_id, 'session-a');
    assert.deepEqual(readEvents[0].message_ids, [sent.id]);

    // 验证数据库状态已转为 read
    const inDb = db.prepare('SELECT status FROM messages WHERE id = ?').get(sent.id);
    assert.equal(inDb.status, 'read');

    // 再次以 unreadOnly 读取应返回空
    const emptyMsgs = messageService.readDialogue('session-a', {
      unreadOnly: true,
      projectId: 'test-proj'
    });
    assert.equal(emptyMsgs.length, 0);
  });

  await t.test('用例 4: Session A 回复 Session B 并继承 thread_id', async () => {
    // B 发出 Query
    const queryMsg = messageService.sendDialogue({
      from: 'session-b',
      to: 'session-a',
      content: 'A 你改完了吗？',
      dialogueType: 'query',
      projectId: 'test-proj'
    });

    // A 回复 Response
    const replyMsg = messageService.sendDialogue({
      from: 'session-a',
      to: 'session-b',
      threadId: queryMsg.thread_id,
      replyToId: queryMsg.id,
      content: '刚提交了 PR，文件已释放，你可以继续。',
      dialogueType: 'response',
      projectId: 'test-proj'
    });

    assert.equal(replyMsg.thread_id, queryMsg.thread_id);
    assert.equal(replyMsg.reply_to_id, queryMsg.id);
    assert.equal(replyMsg.dialogue_type, 'response');

    // 拉取整个 Thread
    const thread = messageService.getThread(queryMsg.thread_id, 'test-proj');
    assert.equal(thread.length, 2);
    assert.equal(thread[0].content, 'A 你改完了吗？');
    assert.equal(thread[1].content, '刚提交了 PR，文件已释放，你可以继续。');
  });
});
