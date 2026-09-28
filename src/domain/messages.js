import { ValidationError, requireString, optionalString } from './errors.js';

const IMPORTANCES = new Set(['normal', 'urgent']);

export class MessageService {
  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  send({ from, to = null, intentId = null, content, importance = 'normal' }, token = null) {
    // 令牌在，就以令牌为准：agent_id 早先是调用方自报的，任何进程都能自称
    // claude。令牌是服务端签发、无法自造的那一半身份，优先于请求体。
    if (token && token.agent_id) {
      if (from !== undefined && from !== token.agent_id) {
        throw new ValidationError(
          `"from" does not match the token's agent "${token.agent_id}"`, 'from'
        );
      }
      from = token.agent_id;
    }

    // 从实例上读解析器，不要把它写进参数解构——解构出的形参会遮蔽同名的
    // 实例属性，守卫就会永远看到 undefined。
    const agentResolver = this.agentResolver;

    requireString(from, 'from');
    requireString(content, 'content');
    const finalTo = optionalString(to, 'to', null);
    const finalIntentId = optionalString(intentId, 'intent_id', null);
    const finalImportance = optionalString(importance, 'importance', 'normal');

    if (!IMPORTANCES.has(finalImportance)) {
      throw new ValidationError(
        `"importance" must be one of ${[...IMPORTANCES].join(', ')}`, 'importance'
      );
    }

    // messages.from_agent 与 intent_id 都带外键，插入前显式核实，非法引用
    // 变成 400。否则 SQLite 抛 FOREIGN KEY constraint failed：既是 500，
    // 又会把外键约束的细节连同错误码打进日志。
    // from 这一列 service 自己无法核实，解析器由装配它的 daemon 注入。
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
      INSERT INTO messages (from_agent, to_agent, intent_id, content, importance, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(from, finalTo, finalIntentId, content, finalImportance, now);

    const msg = {
      id: Number(res.lastInsertRowid),
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

  inbox(agentId, limit = 50) {
    requireString(agentId, 'to');
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE to_agent = ? OR to_agent IS NULL
      ORDER BY id DESC LIMIT ?
    `).all(agentId, limit);
  }

  list(limit = 50) {
    return this.db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?').all(limit);
  }
}
