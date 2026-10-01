import { ValidationError, requireString, optionalString } from './errors.js';

const IMPORTANCES = new Set(['normal', 'urgent']);

export class MessageService {
  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  send({ from, to = null, intentId = null, content, importance = 'normal', projectId = 'default' }, token = null) {
    if (token && token.agent_id) {
      if (from !== undefined && from !== token.agent_id) {
        throw new ValidationError(
          `"from" does not match the token's agent "${token.agent_id}"`, 'from'
        );
      }
      from = token.agent_id;
    }

    const agentResolver = this.agentResolver;

    requireString(from, 'from');
    requireString(content, 'content');
    const finalTo = optionalString(to, 'to', null);
    const finalIntentId = optionalString(intentId, 'intent_id', null);
    const finalImportance = optionalString(importance, 'importance', 'normal');
    const finalProjectId = optionalString(projectId, 'project_id', 'default');

    if (!IMPORTANCES.has(finalImportance)) {
      throw new ValidationError(
        `"importance" must be one of ${[...IMPORTANCES].join(', ')}`, 'importance'
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

    const now = Date.now();
    const res = this.db.prepare(`
      INSERT INTO messages (project_id, from_agent, to_agent, intent_id, content, importance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(finalProjectId, from, finalTo, finalIntentId, content, finalImportance, now);

    const msg = {
      id: Number(res.lastInsertRowid),
      project_id: finalProjectId,
      from,
      to: finalTo,
      intent_id: finalIntentId,
      content,
      importance: finalImportance,
      created_at: now
    };

    this.eventBus.emit('message:sent', msg);
    return msg;
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
}
