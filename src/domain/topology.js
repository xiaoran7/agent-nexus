import { randomUUID } from 'node:crypto';

/**
 * 拓扑节点与因果图服务 (Topology & Changelog Service)
 * 将 Agent 任务闭环、功能实现、问题解决与交接记录沉淀为时间序拓扑图
 */

/**
 * 拓扑模块分类解析器
 * 根据 claims 涉及的文件路径或任务标题智能推导功能子系统
 */
export function detectModule(claims = [], title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase();
  const filePaths = (claims || []).map(c => (typeof c === 'string' ? c : c.target || '')).filter(Boolean);

  for (const fp of filePaths) {
    const norm = fp.replace(/\\/g, '/').toLowerCase();
    if (norm.includes('src/daemon/') || norm.includes('coordinator')) return 'daemon';
    if (norm.includes('src/transport/') || norm.includes('rest') || norm.includes('ws.')) return 'transport';
    if (norm.includes('src/domain/') || norm.includes('topology') || norm.includes('memory') || norm.includes('messages')) return 'domain';
    if (norm.includes('src/ui/') || norm.includes('index.html') || norm.includes('app.js') || norm.includes('.css')) return 'ui';
    if (norm.includes('src/hook/') || norm.includes('hook')) return 'hook';
    if (norm.includes('src/mcp/') || norm.includes('mcp')) return 'mcp';
    if (norm.includes('test/') || norm.includes('tests/')) return 'tests';
    if (norm.endsWith('.md') || norm.includes('docs/')) return 'docs';
  }

  if (text.includes('daemon') || text.includes('coordinator') || text.includes('调度') || text.includes('租约') || text.includes('进程')) return 'daemon';
  if (text.includes('websocket') || text.includes('rest') || text.includes('长连接') || text.includes('推送') || text.includes('transport')) return 'transport';
  if (text.includes('ui') || text.includes('前端') || text.includes('驾驶舱') || text.includes('视图') || text.includes('页面') || text.includes('css')) return 'ui';
  if (text.includes('hook') || text.includes('拦截') || text.includes('pretooluse')) return 'hook';
  if (text.includes('mcp') || text.includes('工具') || text.includes('protocol')) return 'mcp';
  if (text.includes('test') || text.includes('测试') || text.includes('验证')) return 'tests';
  if (text.includes('doc') || text.includes('文档') || text.includes('规范') || text.includes('readme')) return 'docs';
  if (text.includes('topology') || text.includes('拓扑') || text.includes('memory') || text.includes('记忆') || text.includes('消息')) return 'domain';

  return 'core';
}

/**
 * 拓扑节点与因果图服务 (Topology & Changelog Service)
 * 将 Agent 任务闭环、功能实现、问题解决与交接记录沉淀为多分支、有条理的 DAG 演进拓扑图
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
   * @param {string} [params.causalityType] - 'sequence' | 'handoff' | 'unblocked' | 'causal_file' | 'module_branch'
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
    const moduleName = metadata.module || detectModule(claims, title, description);
    const enrichedMetadata = { ...metadata, module: moduleName };

    // 多分支有向图 (DAG) 智能因果前驱推导：坚决打破单一单线死板链表
    let finalParents = Array.isArray(parentNodeIds) ? [...parentNodeIds] : [];
    let finalCausality = causalityType;

    if (finalParents.length === 0) {
      const claimTargets = (claims || []).map(c => (typeof c === 'string' ? c : c.target || '')).filter(Boolean);

      // 1. 优先寻找修改相同文件的最近前驱节点（真正的代码因果链）
      if (claimTargets.length > 0) {
        const candidateNodes = this.db.prepare(`
          SELECT id, claims_snapshot, metadata FROM topology_nodes
          WHERE project_id = ?
          ORDER BY created_at DESC LIMIT 20
        `).all(projectId);

        for (const candidate of candidateNodes) {
          try {
            const prevClaims = JSON.parse(candidate.claims_snapshot || '[]');
            const prevTargets = prevClaims.map(c => (typeof c === 'string' ? c : c.target || '')).filter(Boolean);
            const hasCommonFile = claimTargets.some(t => prevTargets.includes(t));
            if (hasCommonFile) {
              finalParents.push(candidate.id);
              finalCausality = 'causal_file';
              break;
            }
          } catch {}
        }
      }

      // 2. 次选同模块主线前驱（保持功能子系统分支的延续性）
      if (finalParents.length === 0) {
        const candidateNodes = this.db.prepare(`
          SELECT id, metadata FROM topology_nodes
          WHERE project_id = ?
          ORDER BY created_at DESC LIMIT 20
        `).all(projectId);

        for (const candidate of candidateNodes) {
          try {
            const meta = JSON.parse(candidate.metadata || '{}');
            if (meta.module && meta.module === moduleName) {
              finalParents.push(candidate.id);
              finalCausality = 'module_branch';
              break;
            }
          } catch {}
        }
      }

      // 3. 再次关联最近的里程碑节点（作为多分支汇聚的因果枢纽）
      if (finalParents.length === 0) {
        const milestone = this.db.prepare(`
          SELECT id FROM topology_nodes
          WHERE project_id = ? AND node_type = 'milestone'
          ORDER BY created_at DESC LIMIT 1
        `).get(projectId);
        if (milestone) {
          finalParents.push(milestone.id);
          finalCausality = 'milestone_convergence';
        }
      }

      // 4. 兜底使用最近的上一节点
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
    }

    const claimsSnapshot = JSON.stringify(claims || []);
    const parentIdsStr = JSON.stringify(finalParents);
    const metadataStr = JSON.stringify(enrichedMetadata);

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
      finalCausality,
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
      causality_type: finalCausality,
      module: moduleName,
      metadata: enrichedMetadata,
      created_at: now
    };

    if (this.eventBus) {
      this.eventBus.emit('topology:node_created', node);
    }

    return node;
  }

  /**
   * 获取项目的演进拓扑图 (Nodes & Edges, 带 DAG 层级计算与详略分级)
   * @param {string} projectId
   * @param {Object} options
   * @param {number} [options.limit=100]
   * @param {number} [options.since=0]
   */
  getTopologyGraph(projectId = 'default', { limit = 100, since = 0 } = {}) {
    const isAll = !projectId || projectId === 'all';
    const rawNodes = isAll
      ? this.db.prepare(`
          SELECT * FROM topology_nodes
          WHERE created_at >= ?
          ORDER BY created_at ASC
          LIMIT ?
        `).all(since, limit)
      : this.db.prepare(`
          SELECT * FROM topology_nodes
          WHERE project_id = ? AND created_at >= ?
          ORDER BY created_at ASC
          LIMIT ?
        `).all(projectId, since, limit);

    const nodes = [];
    const edges = [];
    const nodeMap = new Map();
    const childrenMap = new Map();
    const modulesSet = new Set();

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

      const moduleName = metadata.module || detectModule(claims, row.title, row.description);
      modulesSet.add(moduleName);

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
        module: moduleName,
        metadata: { ...metadata, module: moduleName },
        depth: 0,
        createdAt: row.created_at
      };

      nodes.push(node);
      nodeMap.set(node.id, node);
      childrenMap.set(node.id, []);
    }

    // 构建因果边集合并计算 DAG 拓扑层级 (Layer / Depth)
    for (const node of nodes) {
      if (Array.isArray(node.parentNodeIds)) {
        for (const parentId of node.parentNodeIds) {
          if (nodeMap.has(parentId)) {
            const parent = nodeMap.get(parentId);
            node.depth = Math.max(node.depth, (parent.depth || 0) + 1);
            if (childrenMap.has(parentId)) {
              childrenMap.get(parentId).push(node.id);
            }

            const labelMap = {
              'handoff': '任务交接',
              'unblocked': '解除冲突唤醒',
              'causal_file': '同文件延续',
              'module_branch': '模块演进',
              'milestone_convergence': '阶段汇聚',
              'sequence': '时序演进'
            };

            edges.push({
              id: `edge_${parentId}_${node.id}`,
              from: parentId,
              to: node.id,
              causalityType: node.causalityType || 'sequence',
              label: labelMap[node.causalityType] || '演进推进'
            });
          }
        }
      }
    }

    // 附带子节点引用，方便前端展开详细卡片时追溯因果关系
    for (const node of nodes) {
      node.childNodeIds = childrenMap.get(node.id) || [];
    }

    return {
      projectId,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      modules: Array.from(modulesSet),
      nodes,
      edges
    };
  }
}

