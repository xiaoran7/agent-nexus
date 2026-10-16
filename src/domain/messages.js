import { ValidationError, requireString, optionalString } from './errors.js';

const IMPORTANCES = new Set(['normal', 'urgent']);
const DIALOGUE_TYPES = new Set(['chat', 'query', 'response', 'handoff', 'milestone']);
const MESSAGE_STATUSES = new Set(['unread', 'read']);

export class MessageService {
  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  send({
    from,
    to = null,
    intentId = null,
    content,
    importance = 'normal',
    projectId = 'default',
    threadId = null,
    replyToId = null,
    dialogueType = 'chat',
    status = 'unread'
  }, token = null) {
    if (token && token.agent_id) {
      if (from !== undefined && from !== token.agent_id) {
        throw new ValidationError(
          `"from" does not match the token's agent "${token.agent_id}"`, 'from'
        );
      }
      from = token.agent_id;
    }

    const agentResolver = this.agentResolver || ((id) => !!this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(id));

    requireString(from, 'from');
    requireString(content, 'content');
    const finalTo = optionalString(to, 'to', null);
    const finalIntentId = optionalString(intentId, 'intent_id', null);
    const finalImportance = optionalString(importance, 'importance', 'normal');
    const finalProjectId = optionalString(projectId, 'project_id', 'default');
    const finalThreadId = optionalString(threadId, 'thread_id', null);
    const finalDialogueType = optionalString(dialogueType, 'dialogue_type', 'chat');
    const finalStatus = optionalString(status, 'status', 'unread');

    let finalReplyToId = null;
    if (replyToId !== undefined && replyToId !== null) {
      if (typeof replyToId === 'number' && Number.isInteger(replyToId) && replyToId > 0) {
        finalReplyToId = replyToId;
      } else if (typeof replyToId === 'string' && /^\d+$/.test(replyToId)) {
        finalReplyToId = parseInt(replyToId, 10);
      } else {
        throw new ValidationError('"reply_to_id" must be a positive integer ID', 'reply_to_id');
      }
    }

    if (!IMPORTANCES.has(finalImportance)) {
      throw new ValidationError(
        `"importance" must be one of ${[...IMPORTANCES].join(', ')}`, 'importance'
      );
    }

    if (!DIALOGUE_TYPES.has(finalDialogueType)) {
      throw new ValidationError(
        `"dialogue_type" must be one of ${[...DIALOGUE_TYPES].join(', ')}`, 'dialogue_type'
      );
    }

    if (!MESSAGE_STATUSES.has(finalStatus)) {
      throw new ValidationError(
        `"status" must be one of ${[...MESSAGE_STATUSES].join(', ')}`, 'status'
      );
    }

    if (!agentResolver) {
      throw new Error('MessageService.send requires an agentResolver to validate the sender');
    }
    if (!agentResolver(from)) {
      throw new ValidationError(`"from" refers to an unknown agent "${from}"; register it first`, 'from');
    }
    this.assertAgentExists(finalTo, 'to');
    this.assertIntentExists(finalIntentId, 'intent_id');
    this.assertMessageExists(finalReplyToId, 'reply_to_id');

    // 如果未传 threadId 但传了 replyToId，则自动继承父消息的 threadId 或以父消息 id 作为 threadId
    let effectiveThreadId = finalThreadId;
    if (!effectiveThreadId && finalReplyToId) {
      const parent = this.db.prepare('SELECT thread_id, id FROM messages WHERE id = ?').get(finalReplyToId);
      if (parent) {
        effectiveThreadId = parent.thread_id || `thread_${parent.id}`;
      }
    }

    const now = Date.now();
    const res = this.db.prepare(`
      INSERT INTO messages (project_id, from_agent, to_agent, intent_id, content, importance, created_at, thread_id, reply_to_id, status, dialogue_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      finalProjectId,
      from,
      finalTo,
      finalIntentId,
      content,
      finalImportance,
      now,
      effectiveThreadId,
      finalReplyToId,
      finalStatus,
      finalDialogueType
    );

    const messageId = Number(res.lastInsertRowid);
    // 若此前没有 threadId，且是首条发起的消息，可将自身作为 thread_id 归类
    if (!effectiveThreadId) {
      effectiveThreadId = `thread_${messageId}`;
      this.db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?').run(effectiveThreadId, messageId);
    }

    const msg = {
      id: messageId,
      project_id: finalProjectId,
      from,
      to: finalTo,
      intent_id: finalIntentId,
      content,
      importance: finalImportance,
      created_at: now,
      thread_id: effectiveThreadId,
      reply_to_id: finalReplyToId,
      status: finalStatus,
      dialogue_type: finalDialogueType
    };

    this.eventBus.emit('message:sent', msg);
    return msg;
  }

  sendDialogue(options, token = null) {
    return this.send(options, token);
  }

  assertAgentExists(agentId, field) {
    if (agentId === null) return;
    const found = this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId);
    if (!found) {
      throw new ValidationError(`"${field}" refers to an unknown agent "${agentId}"; register it first`, field);
    }
  }

  assertIntentExists(intentId, field) {
    if (intentId === null) return;
    const found = this.db.prepare('SELECT 1 FROM intents WHERE id = ?').get(intentId);
    if (!found) {
      throw new ValidationError(`"${field}" refers to an unknown intent "${intentId}"`, field);
    }
  }

  assertMessageExists(messageId, field) {
    if (messageId === null) return;
    const found = this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId);
    if (!found) {
      throw new ValidationError(`"${field}" refers to an unknown message ID "${messageId}"`, field);
    }
  }

  inbox(agentId, limit = 50, projectId = 'default') {
    requireString(agentId, 'to');
    if (projectId) {
      return this.db.prepare(`
        SELECT * FROM messages
        WHERE project_id = ? AND (to_agent = ? OR to_agent IS NULL)
        ORDER BY id DESC LIMIT ?
      `).all(projectId, agentId, limit);
    }
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE to_agent = ? OR to_agent IS NULL
      ORDER BY id DESC LIMIT ?
    `).all(agentId, limit);
  }

  list(limit = 50, projectId = null) {
    if (projectId) {
      return this.db.prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit);
    }
    return this.db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?').all(limit);
  }

  getThread(threadId, projectId = 'default') {
    requireString(threadId, 'thread_id');
    const finalProjectId = projectId || 'default';
    return this.db.prepare(`
      SELECT m.*, fa.name as from_agent_name, ta.name as to_agent_name
      FROM messages m
      LEFT JOIN agents fa ON m.from_agent = fa.id
      LEFT JOIN agents ta ON m.to_agent = ta.id
      WHERE m.project_id = ? AND m.thread_id = ?
      ORDER BY m.id ASC
    `).all(finalProjectId, threadId);
  }

  readDialogue(agentId, { threadId = null, unreadOnly = false, markAsRead = true, limit = 50, projectId = 'default' } = {}) {
    requireString(agentId, 'agent_id');
    const finalProjectId = projectId || 'default';
    const limitNum = Math.min(Math.max(1, Number(limit) || 50), 200);

    let query = `
      SELECT m.*, fa.name as from_agent_name, ta.name as to_agent_name
      FROM messages m
      LEFT JOIN agents fa ON m.from_agent = fa.id
      LEFT JOIN agents ta ON m.to_agent = ta.id
      WHERE m.project_id = ? AND (m.to_agent = ? OR m.to_agent IS NULL)
    `;
    const params = [finalProjectId, agentId];

    if (threadId) {
      query += ` AND m.thread_id = ?`;
      params.push(threadId);
    }

    if (unreadOnly) {
      query += ` AND m.status = 'unread'`;
    }

    query += ` ORDER BY m.id DESC LIMIT ?`;
    params.push(limitNum);

    const messages = this.db.prepare(query).all(...params);

    if (markAsRead && messages.length > 0) {
      const unreadIds = messages.filter(m => m.status === 'unread' && m.to_agent === agentId).map(m => m.id);
      if (unreadIds.length > 0) {
        const placeholders = unreadIds.map(() => '?').join(',');
        this.db.prepare(`UPDATE messages SET status = 'read' WHERE id IN (${placeholders})`).run(...unreadIds);
        this.eventBus.emit('messages:read', {
          project_id: finalProjectId,
          agent_id: agentId,
          message_ids: unreadIds
        });
      }
    }

    return messages;
  }

  reportProgress(agentId, summary, projectId = 'default') {
    requireString(agentId, 'agent_id');
    requireString(summary, 'summary');
    const finalProjectId = projectId || 'default';
    const now = Date.now();

    const trimmed = summary.trim();
    this.db.prepare(`
      UPDATE agents
      SET progress_summary = ?, last_heartbeat = ?
      WHERE id = ? AND project_id = ?
    `).run(trimmed, now, agentId, finalProjectId);

    this.eventBus.emit('agent:progress', {
      project_id: finalProjectId,
      agent_id: agentId,
      progress_summary: trimmed,
      updated_at: now
    });

    return {
      success: true,
      agent_id: agentId,
      progress_summary: trimmed,
      updated_at: now
    };
  }
}

