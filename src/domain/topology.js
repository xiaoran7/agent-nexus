import { randomUUID } from 'node:crypto';

/**
 * 拓扑节点与因果图服务 (Topology & Changelog Service)
 * 将 Agent 任务闭环、功能实现、问题解决与交接记录沉淀为时间序拓扑图
 */
export class TopologyService {
  constructor(db, eventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  /**
   * 记录一个拓扑节点
   * @param {Object} params
   * @param {string} params.projectId
   * @param {string} params.agentId
   * @param {string} [params.agentName]
   * @param {string} [params.provider]
   * @param {string} [params.nodeType] - 'milestone' | 'completed' | 'handoff' | 'unblocked'
   * @param {string} params.title
   * @param {string} [params.description]
   * @param {string} [params.intentId]
   * @param {Array} [params.claims] - 影响文件或模块
   * @param {Array<string>} [params.parentNodeIds] - 显式前驱节点 ID 列表
   * @param {string} [params.causalityType] - 'sequence' | 'handoff' | 'unblocked'
   * @param {Object} [params.metadata]
   */
  recordNode({
    projectId = 'default',
    agentId,
    agentName = null,
    provider = null,
    nodeType = 'completed',
    title,
    description = '',
    intentId = null,
    claims = [],
    parentNodeIds = [],
    causalityType = 'sequence',
    metadata = {}
  }) {
    if (!agentId || !title) {
      throw new Error('agentId and title are required for topology node');
    }

    const id = `topo_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const now = Date.now();

    // 自动前驱推导：若未显式指定前驱，自动寻找该项目下最近的节点作为默认时间序依赖
    let finalParents = Array.isArray(parentNodeIds) ? [...parentNodeIds] : [];
    if (finalParents.length === 0) {
      const prev = this.db.prepare(`
        SELECT id FROM topology_nodes
        WHERE project_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(projectId);
      if (prev) {
        finalParents.push(prev.id);
      }
    }

    const claimsSnapshot = JSON.stringify(claims || []);
    const parentIdsStr = JSON.stringify(finalParents);
    const metadataStr = JSON.stringify(metadata || {});

    this.db.prepare(`
      INSERT INTO topology_nodes (
        id, project_id, agent_id, agent_name, provider,
        node_type, title, description, intent_id,
        claims_snapshot, parent_node_ids, causality_type, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      agentId,
      agentName || agentId,
      provider || 'agent',
      nodeType,
      title,
      description,
      intentId,
      claimsSnapshot,
      parentIdsStr,
      causalityType,
      metadataStr,
      now
    );

    const node = {
      id,
      project_id: projectId,
      agent_id: agentId,
      agent_name: agentName || agentId,
      provider: provider || 'agent',
      node_type: nodeType,
      title,
      description,
      intent_id: intentId,
      claims: claims || [],
      parent_node_ids: finalParents,
      causality_type: causalityType,
      metadata: metadata || {},
      created_at: now
    };

    if (this.eventBus) {
      this.eventBus.emit('topology:node_created', node);
    }

    return node;
  }

  /**
   * 获取项目的演进拓扑图 (Nodes & Edges)
   * @param {string} projectId
   * @param {Object} options
   * @param {number} [options.limit=100]
   * @param {number} [options.since=0]
   */
  getTopologyGraph(projectId = 'default', { limit = 100, since = 0 } = {}) {
    const rawNodes = this.db.prepare(`
      SELECT * FROM topology_nodes
      WHERE project_id = ? AND created_at >= ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(projectId, since, limit);

    const nodes = [];
    const edges = [];
    const nodeMap = new Map();

    for (const row of rawNodes) {
      let claims = [];
      try {
        claims = JSON.parse(row.claims_snapshot || '[]');
      } catch {}

      let parentNodeIds = [];
      try {
        parentNodeIds = JSON.parse(row.parent_node_ids || '[]');
      } catch {}

      let metadata = {};
      try {
        metadata = JSON.parse(row.metadata || '{}');
      } catch {}

      const node = {
        id: row.id,
        projectId: row.project_id,
        agentId: row.agent_id,
        agentName: row.agent_name || row.agent_id,
        provider: row.provider,
        nodeType: row.node_type,
        title: row.title,
        description: row.description,
        intentId: row.intent_id,
        claims,
        parentNodeIds,
        causalityType: row.causality_type,
        metadata,
        createdAt: row.created_at
      };

      nodes.push(node);
      nodeMap.set(node.id, node);
    }

    // 生成边集合
    for (const node of nodes) {
      if (Array.isArray(node.parentNodeIds)) {
        for (const parentId of node.parentNodeIds) {
          if (nodeMap.has(parentId)) {
            edges.push({
              id: `edge_${parentId}_${node.id}`,
              from: parentId,
              to: node.id,
              causalityType: node.causalityType || 'sequence',
              label: node.causalityType === 'handoff' ? '任务交接' :
                     node.causalityType === 'unblocked' ? '解除冲突唤醒' : '顺序推进'
            });
          }
        }
      }
    }

    return {
      projectId,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      nodes,
      edges
    };
  }
}
