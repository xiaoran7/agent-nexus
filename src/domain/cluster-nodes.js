import { requireString } from './errors.js';

/**
 * 跨机算力节点与探针拓扑管理服务 (Cluster Nodes Registry)
 * 解决"多机显示基本为0"的核心抓手：
 * 节点（如 Windows Hub、美西 Linux us-zenix）升格为常驻一等公民，
 * 即使节点暂时没有正在运行的 Claude 会话，探针心跳与连接态势依然常驻可见。
 */
export class ClusterNodeService {
  constructor(db, eventBus = null, localNodeId = 'local') {
    this.db = db;
    this.eventBus = eventBus;
    this.localNodeId = localNodeId || 'local';

    // 初始化确保本机 Hub 节点常驻登记
    this.recordHeartbeat(this.localNodeId, {
      role: 'hub',
      platform: process.platform,
      displayName: 'Hub (控制中枢)'
    });
  }

  /**
   * 记录或刷新节点探针心跳
   */
  recordHeartbeat(nodeIdOrOpts, opts = {}) {
    let cleanId;
    let options;
    if (typeof nodeIdOrOpts === 'object' && nodeIdOrOpts !== null) {
      cleanId = (nodeIdOrOpts.nodeId || nodeIdOrOpts.node_id || '').trim().toLowerCase();
      options = nodeIdOrOpts;
    } else {
      cleanId = (nodeIdOrOpts || '').trim().toLowerCase();
      options = opts || {};
    }
    if (!cleanId) return null;

    const {
      role = 'edge',
      platform = null,
      ip = null,
      displayName = null,
      display_name = null,
      metadata = {}
    } = options;

    const now = Date.now();
    const finalRole = cleanId === this.localNodeId ? 'hub' : (role || 'edge');
    const finalPlatform = platform || (cleanId === this.localNodeId ? process.platform : 'unknown');
    const finalDisplay = displayName || display_name || (cleanId === this.localNodeId ? 'Hub (控制中枢)' : cleanId);

    const existing = this.getNode(cleanId);
    const metaObj = {
      ...(existing?.metadata || {}),
      ...(metadata && typeof metadata === 'object' ? metadata : {})
    };
    const metaJson = JSON.stringify(metaObj);

    this.db.prepare(`
      INSERT INTO cluster_nodes (
        id, display_name, role, platform, ip, last_heartbeat, status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'online', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, cluster_nodes.display_name),
        role = excluded.role,
        platform = CASE WHEN excluded.platform != 'unknown' THEN excluded.platform ELSE cluster_nodes.platform END,
        ip = COALESCE(excluded.ip, cluster_nodes.ip),
        last_heartbeat = excluded.last_heartbeat,
        status = 'online',
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      cleanId, finalDisplay, finalRole, finalPlatform, ip || null,
      now, metaJson, existing?.created_at || now, now
    );

    const record = this.getNode(cleanId);

    if (this.eventBus && (!existing || existing.status !== 'online')) {
      this.eventBus.emit('node:status', {
        node_id: cleanId,
        status: 'online',
        node: record
      });
    }

    return record;
  }

  /**
   * 周期扫描并更新失联节点状态
   * 45 秒无心跳视为 stale，180 秒无心跳视为 offline
   */
  sweepStaleNodes(now = Date.now()) {
    // 自身 Hub 节点自动保持在线
    this.db.prepare(`
      UPDATE cluster_nodes
      SET last_heartbeat = ?, status = 'online', updated_at = ?
      WHERE id = ?
    `).run(now, now, this.localNodeId);

    const staleThreshold = now - 45000;
    const offlineThreshold = now - 180000;

    // 变更为 offline
    const newlyOffline = this.db.prepare(`
      SELECT id FROM cluster_nodes
      WHERE id != ? AND last_heartbeat < ? AND status != 'offline'
    `).all(this.localNodeId, offlineThreshold);

    if (newlyOffline.length > 0) {
      this.db.prepare(`
        UPDATE cluster_nodes
        SET status = 'offline', updated_at = ?
        WHERE id != ? AND last_heartbeat < ? AND status != 'offline'
      `).run(now, this.localNodeId, offlineThreshold);

      for (const n of newlyOffline) {
        this.eventBus?.emit?.('node:status', { node_id: n.id, status: 'offline' });
      }
    }

    // 变更为 stale (但尚未 offline)
    const newlyStale = this.db.prepare(`
      SELECT id FROM cluster_nodes
      WHERE id != ? AND last_heartbeat < ? AND last_heartbeat >= ? AND status = 'online'
    `).all(this.localNodeId, staleThreshold, offlineThreshold);

    if (newlyStale.length > 0) {
      this.db.prepare(`
        UPDATE cluster_nodes
        SET status = 'stale', updated_at = ?
        WHERE id != ? AND last_heartbeat < ? AND last_heartbeat >= ? AND status = 'online'
      `).run(now, this.localNodeId, staleThreshold, offlineThreshold);

      for (const n of newlyStale) {
        this.eventBus?.emit?.('node:status', { node_id: n.id, status: 'stale' });
      }
    }

    return newlyOffline.length + newlyStale.length;
  }

  /**
   * 获取所有注册节点，并聚合当前节点下的在席会话与活跃锁数量
   */
  listNodes(projectId = null) {
    const nodes = this.db.prepare(`
      SELECT * FROM cluster_nodes
      ORDER BY CASE WHEN role = 'hub' THEN 0 ELSE 1 END, last_heartbeat DESC
    `).all();

    const now = Date.now();

    return nodes.map(n => {
      let meta = {};
      try { meta = JSON.parse(n.metadata || '{}'); } catch {}

      // 统计挂在该节点下的实时在席 Agent 数量 (排除 departed)
      let agentCount = 0;
      let activeLockCount = 0;

      try {
        const agentCountRow = this.db.prepare(`
          SELECT COUNT(*) as count FROM agents
          WHERE host_id = ? AND status != 'departed'
          ${projectId && projectId !== 'all' ? 'AND project_id = ?' : ''}
        `).get(...(projectId && projectId !== 'all' ? [n.id, projectId] : [n.id]));
        agentCount = agentCountRow?.count || 0;

        const lockCountRow = this.db.prepare(`
          SELECT COUNT(*) as count FROM claims c
          JOIN leases l ON c.intent_id = l.intent_id
          JOIN agents a ON c.agent_id = a.id
          WHERE a.host_id = ? AND l.expires_at > ?
          ${projectId && projectId !== 'all' ? 'AND c.project_id = ?' : ''}
        `).get(...(projectId && projectId !== 'all' ? [n.id, now, projectId] : [n.id, now]));
        activeLockCount = lockCountRow?.count || 0;
      } catch {}

      // 算力节点健康度评分与延迟推测
      const timeSinceHeartbeat = Math.max(0, now - n.last_heartbeat);

      return {
        id: n.id,
        display_name: n.display_name || n.id,
        role: n.role,
        platform: n.platform,
        ip: n.ip,
        status: n.status,
        last_heartbeat: n.last_heartbeat,
        last_seen_sec: Math.floor(timeSinceHeartbeat / 1000),
        agent_count: agentCount,
        active_lock_count: activeLockCount,
        metadata: meta
      };
    });
  }

  getNode(nodeId) {
    if (!nodeId) return null;
    const row = this.db.prepare(`SELECT * FROM cluster_nodes WHERE id = ?`).get(nodeId.trim().toLowerCase());
    if (!row) return null;
    let meta = {};
    try { meta = JSON.parse(row.metadata || '{}'); } catch {}
    return {
      id: row.id,
      display_name: row.display_name || row.id,
      role: row.role,
      platform: row.platform,
      ip: row.ip,
      status: row.status,
      last_heartbeat: row.last_heartbeat,
      metadata: meta,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
}
