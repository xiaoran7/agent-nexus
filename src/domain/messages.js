export class MessageService {
  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  send({ from, to = null, intentId = null, content, importance = 'normal' }) {
    const now = Date.now();
    const res = this.db.prepare(`
      INSERT INTO messages (from_agent, to_agent, intent_id, content, importance, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(from, to, intentId, content, importance, now);

    const msg = {
      id: Number(res.lastInsertRowid),
      from,
      to,
      intent_id: intentId,
      content,
      importance,
      created_at: now
    };

    this.eventBus.emit('message:sent', msg);
    return msg;
  }

  inbox(agentId, limit = 50) {
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
