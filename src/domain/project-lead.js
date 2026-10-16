import { NullAdapter } from './llm-adapter.js';

export const LEAD_STATES = {
  STANDBY: 'STANDBY',   // 项目内无活跃 Agent
  OBSERVING: 'OBSERVING', // 仅单一 Agent 施工中，架构师静默保驾，不插手干预
  AWAKENED: 'AWAKENED'    // 检测到多 Session 并发（新 Agent 进场与在席 Agent 协同/冲突），架构师唤醒并重排指导
};

export class ProjectLead {
  constructor(projectId, coordinator, eventBus, llmAdapter = new NullAdapter(), memoryService = null) {
    this.projectId = projectId;
    this.coordinator = coordinator;
    this.eventBus = eventBus;
    this.llmAdapter = llmAdapter;
    this.memoryService = memoryService;
    this.sessionPlans = new Map(); // agentId -> { plannedWork, registeredAt }
    this.state = LEAD_STATES.STANDBY;
    this.lastAwakenedAt = null;
    this.lastArbitration = null;
  }

  getProjectContext() {
    const snapshot = this.coordinator.getDashboardSnapshot(this.projectId);
    const waitQueue = this.coordinator.getWaitQueue(this.projectId);
    let rootPath = '';
    try {
      const row = this.coordinator.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(this.projectId);
      if (row && row.root_path) rootPath = row.root_path;
    } catch {}
    return {
      projectId: this.projectId,
      rootPath,
      agents: snapshot.agents,
      activeClaims: snapshot.activeClaims,
      waitQueue,
      activePlans: Array.from(this.sessionPlans.entries()).map(([agentId, data]) => ({
        agentId,
        plannedWork: data.plannedWork,
        registeredAt: data.registeredAt
      }))
    };
  }

  /**
   * 汇总在席其他 Session 的现场与实际完成进度（A 已经干了多少）
   */
  _summarizePeerSessions(currentAgentId, context) {
    const peerSessions = [];
    const now = Date.now();
    const agents = context.agents || [];

    for (const agent of agents) {
      if (agent.id === currentAgentId || agent.status === 'departed') {
        continue;
      }

      // 提取该 Agent 当前活跃持有的锁
      const heldClaims = (context.activeClaims || []).filter(c => c.agent_id === agent.id);

      // 提取该 Agent 达成的历史里程碑 (从 project_memories 中或 activity_log 中)
      let milestones = [];
      try {
        milestones = this.coordinator.db.prepare(`
          SELECT key, content, created_at
          FROM project_memories
          WHERE project_id = ? AND category = 'milestone' AND source_agent_id = ?
          ORDER BY created_at DESC LIMIT 5
        `).all(this.projectId, agent.id);
      } catch {}

      // 提取该 Agent 最近的写操作或事件流水
      let recentActivities = [];
      try {
        recentActivities = this.coordinator.db.prepare(`
          SELECT event_type, target, description, created_at
          FROM activity_log
          WHERE project_id = ? AND agent_id = ?
          ORDER BY id DESC LIMIT 5
        `).all(this.projectId, agent.id);
      } catch {}

      // 提取登记的计划
      const plan = this.sessionPlans.get(agent.id);

      peerSessions.push({
        agentId: agent.id,
        name: agent.name || agent.id,
        status: agent.status,
        provider: agent.provider,
        currentIntent: agent.current_intent || null,
        progressSummary: agent.progress_summary || null,
        activeLeasesCount: agent.active_leases_count || heldClaims.length,
        heldClaims: heldClaims.map(c => ({
          type: c.claim_type,
          target: c.claim_target,
          expiresAt: c.expires_at,
          remainingSec: c.expires_at ? Math.max(0, Math.ceil((c.expires_at - now) / 1000)) : 0
        })),
        milestones: milestones.map(m => m.content),
        recentActivities: recentActivities.map(a => a.description),
        plannedWorkCount: plan ? plan.plannedWork.length : 0
      });
    }

    return peerSessions;
  }

  /**
   * 动态评估并转移架构师状态（STANDBY -> OBSERVING -> AWAKENED）
   */
  _evaluateLeadState(currentAgentId, peerSessions, conflicts) {
    const totalActivePeers = peerSessions.length;

    if (totalActivePeers === 0) {
      // 只有当前 Agent，无并发冲突，架构师进入静默观察态
      this.state = LEAD_STATES.OBSERVING;
      return {
        state: LEAD_STATES.OBSERVING,
        reason: 'Solo session sprint: Tech Lead remains in silent observation without interfering.'
      };
    }

    // 存在其他在席施工 Agent，架构师被唤醒进行全局重排与指导
    this.state = LEAD_STATES.AWAKENED;
    this.lastAwakenedAt = Date.now();
    const eventPayload = {
      project_id: this.projectId,
      joining_agent_id: currentAgentId,
      state: LEAD_STATES.AWAKENED,
      active_peer_count: totalActivePeers,
      conflicts_count: conflicts.length,
      peer_sessions: peerSessions.map(p => ({
        agentId: p.agentId,
        name: p.name,
        currentIntent: p.currentIntent,
        progressSummary: p.progressSummary,
        activeLeasesCount: p.activeLeasesCount
      })),
      timestamp: this.lastAwakenedAt
    };

    this.eventBus.emit('lead:awakened', eventPayload);
    return {
      state: LEAD_STATES.AWAKENED,
      reason: `Multi-session detected (${totalActivePeers} peer sessions active). Tech Lead awakened to provide coordination and re-planning.`
    };
  }

  _findPlanConflicts(plannedWork, context, currentAgentId) {
    const conflicts = [];
    const safeToStart = [];
    const now = Date.now();
    const rootPath = context.rootPath || '';

    for (const item of plannedWork) {
      const normalizedTarget = this.coordinator.normalizePath(item.target, rootPath);
      const fakeClaim = {
        type: item.type || 'file',
        target: item.type === 'symbol' ? item.target.toLowerCase() : normalizedTarget
      };

      const conflict = this.coordinator.findConflict([fakeClaim], currentAgentId, now, this.projectId);
      if (conflict) {
        // 查找持有该锁的租约到期时间
        const holderClaim = context.activeClaims.find(
          c => c.agent_id === conflict.blockedByAgentId &&
               (c.claim_target === normalizedTarget || this.coordinator.pathsOverlap(c.claim_target, normalizedTarget))
        );
        const estimatedRemainingSec = holderClaim && holderClaim.expires_at
          ? Math.max(0, Math.ceil((holderClaim.expires_at - now) / 1000))
          : 120;

        conflicts.push({
          target: item.target,
          type: item.type || 'file',
          blockedBy: conflict.blockedByAgentId,
          blockedByName: conflict.blockedByAgentName,
          reason: conflict.reason,
          estimatedRemainingSec
        });
      } else {
        safeToStart.push(item);
      }
    }

    return { conflicts, safeToStart };
  }

  _generateDeterministicAdvice(safeToStart, conflicts, peerSessions = []) {
    // 场景 1：无并发 Agent 且无冲突，单兵静默放行
    if (peerSessions.length === 0 && conflicts.length === 0) {
      return `[Nexus 架构师静默保驾] 当前项目无其他并发 Session，申报的 ${safeToStart.length} 项资源全部空闲。架构师保持静默，你可以全速施工。`;
    }

    // 场景 2：存在其他 Session，生成包含 A 施工现场的针对性建议
    let peerContextSection = '';
    if (peerSessions.length > 0) {
      const peerSummaries = peerSessions.map(p => {
        let desc = `• Session [${p.name} (${p.agentId})]: `;
        if (p.currentIntent) desc += `意图为 "${p.currentIntent}"；`;
        if (p.progressSummary) desc += `已完成进展: "${p.progressSummary}"；`;
        if (p.milestones && p.milestones.length > 0) desc += `已达成里程碑: [${p.milestones.join('; ')}]；`;
        if (p.heldClaims.length > 0) {
          const locksDesc = p.heldClaims.map(c => `${c.target} (余 ${c.remainingSec}s)`).join(', ');
          desc += `当前持有锁: [${locksDesc}]`;
        } else {
          desc += `当前无独占锁`;
        }
        return desc;
      }).join('\n');
      peerContextSection = `【在席 Session 施工实况 (A 已经干了多少)】:\n${peerSummaries}\n\n`;
    }

    if (conflicts.length === 0) {
      let advice = `[Nexus 架构师唤醒指引 - 并发通道确认]\n${peerContextSection}`;
      advice += `✅ 经核验，你申报的 ${safeToStart.length} 项资源与正在施工的会话无直接重叠，可安全并发开工。建议保持独立模块解耦。`;
      return advice;
    }

    const blockedList = conflicts.map(c => `• ${c.target}（由 ${c.blockedByName} 锁定，预计剩余约 ${c.estimatedRemainingSec} 秒）`).join('\n');
    const safeList = safeToStart.map(s => `• ${s.target}`).join('\n');

    let advice = `[Nexus 架构师唤醒指引 - 避障重排建议]\n${peerContextSection}`;
    advice += `⚠️ 检测到以下资源正在被其他活跃 Session 热写入：\n${blockedList}\n\n`;
    if (safeToStart.length > 0) {
      advice += `💡 最佳施工路线建议：优先完成以下 ${safeToStart.length} 个空闲资源：\n${safeList}\n\n【避障与解耦建议】：对于冲突模块，请勿直接修改；建议先编写外部 Mock 数据或定义独立接口契约；\n【自动唤醒接力】：待前序会话完成并释放锁后，Nexus 将自动向你发送唤醒通知接力剩余任务。`;
    } else {
      advice += `⚠️ 你的计划全部处于热写入锁定中。建议：\n1. 与持有锁的 Session 发起会话间对话（nexus_dialogue_send）确认接口与进度；\n2. 或进入监听等待模式，待其释放后再行开工。`;
    }
    return advice;
  }

  _buildLlmPrompt(agentId, plannedWork, safeToStart, conflicts, context, deterministicAdvice, peerSessions = []) {
    const memories = this.memoryService
      ? this.memoryService.list(this.projectId, { limit: 12 })
      : [];

    const memoryPromptSection = memories.length > 0
      ? memories.map(m => `  • [${m.category.toUpperCase()}] ${m.key}: ${m.content}`).join('\n')
      : '  (暂无先验工程记忆，此为初始阶段)';

    const peerDesc = peerSessions.length > 0
      ? peerSessions.map(p => {
          let str = `  - 会话 [${p.name}] (${p.agentId}):\n`;
          if (p.currentIntent) str += `    * 正在进行意图: ${p.currentIntent}\n`;
          if (p.progressSummary) str += `    * 已完成进度: ${p.progressSummary}\n`;
          if (p.milestones.length > 0) str += `    * 已达里程碑: ${p.milestones.join('; ')}\n`;
          if (p.heldClaims.length > 0) {
            str += `    * 持有独占锁: ${p.heldClaims.map(c => `${c.target} (余 ${c.remainingSec}s)`).join(', ')}\n`;
          }
          return str;
        }).join('\n')
      : '  (无其他活跃会话)';

    const systemPrompt = `你作为 Agent-Nexus 的项目常驻技术主管兼系统架构师（AI Tech Lead）。
你的职责是在多智能体并发开发环境下，为新进场的编码 Agent 提供高维度的工程协同与任务编排指引，最大化并发吞吐，彻底杜绝代码写踩踏。

【核心不可变铁律】：
1. 冲突判定矩阵是绝对事实（Ground Truth）。你绝对不能告诉 Agent 去直接修改正处于锁定状态（mustWait）的文件。
2. 架构师唤醒机制：新会话进场时，若已有会话（A）在施工，必须结合 A 已经干了多少（milestones/progress）与持有的锁，给出精密的重排与解耦策略。
3. 严格遵守【项目长期工程记忆与先验契约】中固化的架构约束（architecture）、代码规约（rule）与历史避坑经验（gotchas）。在提供解耦或编码建议时，不得违背既有架构规约。
4. 调度建议结构：
   - 优先施工通道：引导 Agent 立即全速实现空闲（safeToStart）的模块；
   - 依赖解耦策略：对于暂时被锁的模块，建议 Agent 抽离 Mock 数据、定义接口契约、编写独立单元测试或编写周边逻辑，而不是原地干等；
   - 倒计时与交接：告知锁持有者和预计释放倒计时，强调完工后系统会自动触发唤醒通知。
5. 风格要求：中文输出、通俗接地气、专业高效、篇幅精炼（300 字以内），直接给出可执行的施工路线，不要废话套话。`;

    const safeDesc = safeToStart.length > 0
      ? safeToStart.map(s => `  - [${s.type || 'file'}] ${s.target}`).join('\n')
      : '  (无，全部计划均受阻)';

    const conflictDesc = conflicts.length > 0
      ? conflicts.map(c => `  - [${c.type}] ${c.target} -> 被 [${c.blockedByName}] 锁定，预计剩余约 ${c.estimatedRemainingSec} 秒`).join('\n')
      : '  (无冲突)';

    const userMessage = `项目 ID: ${this.projectId}
申报进场 Agent ID: ${agentId}

【在席 Session 施工实况 (A 已经干了多少)】:
${peerDesc}

【项目长期工程记忆与先验契约 (Project Long-term Memories)】:
${memoryPromptSection}

【已核验冲突矩阵 (Ground Truth)】:
1. 安全可立即施工资源 (${safeToStart.length} 项):
${safeDesc}

2. 冲突锁定中资源 (${conflicts.length} 项):
${conflictDesc}

【当前规则引擎计算的基线建议】：
${deterministicAdvice}

请基于上述实际工程事实、在席 Session 已经干了多少与项目先验契约，作为技术主管向此新进场 Agent 给出具体的施工编排与避障解耦建议。`;

    return { systemPrompt, userMessage };
  }

  async _getEnhancedAdvice(agentId, plannedWork, safeToStart, conflicts, context, deterministicAdvice, peerSessions = []) {
    if (!this.llmAdapter || (this.llmAdapter instanceof NullAdapter)) {
      return { advice: deterministicAdvice, adviceSource: 'deterministic' };
    }

    try {
      const { systemPrompt, userMessage } = this._buildLlmPrompt(
        agentId,
        plannedWork,
        safeToStart,
        conflicts,
        context,
        deterministicAdvice,
        peerSessions
      );

      const resp = await this.llmAdapter.chat(systemPrompt, userMessage, {
        affinityKey: this.projectId
      });
      if (resp && typeof resp.content === 'string' && resp.content.trim().length > 0) {
        return { advice: resp.content.trim(), adviceSource: 'llm' };
      }
    } catch {}

    return { advice: deterministicAdvice, adviceSource: 'deterministic' };
  }

  async onboard({ agentId, plannedWork = [], capabilities = [] }) {
    const context = this.getProjectContext();
    const { conflicts, safeToStart } = this._findPlanConflicts(plannedWork, context, agentId);
    const peerSessions = this._summarizePeerSessions(agentId, context);
    const leadState = this._evaluateLeadState(agentId, peerSessions, conflicts);

    // 记录该 session 的施工计划
    this.sessionPlans.set(agentId, {
      plannedWork,
      capabilities,
      registeredAt: Date.now()
    });

    const deterministicAdvice = this._generateDeterministicAdvice(safeToStart, conflicts, peerSessions);
    const { advice, adviceSource } = await this._getEnhancedAdvice(
      agentId,
      plannedWork,
      safeToStart,
      conflicts,
      context,
      deterministicAdvice,
      peerSessions
    );

    this.lastArbitration = {
      agentId,
      leadState: leadState.state,
      safeToStart,
      mustWait: conflicts,
      advice,
      adviceSource,
      peerSessionsCount: peerSessions.length,
      evaluatedAt: Date.now()
    };

    this.eventBus.emit('project:onboarded', {
      project_id: this.projectId,
      agent_id: agentId,
      planned_count: plannedWork.length,
      conflicts_count: conflicts.length,
      advice_source: adviceSource,
      lead_state: leadState.state
    });

    return {
      projectId: this.projectId,
      agentId,
      leadState: leadState.state,
      safeToStart,
      mustWait: conflicts,
      peerSessions,
      advice,
      adviceSource,
      deterministicAdvice
    };
  }

  async advisePlan({ agentId, plannedWork = [] }) {
    const context = this.getProjectContext();
    const { conflicts, safeToStart } = this._findPlanConflicts(plannedWork, context, agentId);
    const peerSessions = this._summarizePeerSessions(agentId, context);
    const leadState = this._evaluateLeadState(agentId, peerSessions, conflicts);

    const deterministicAdvice = this._generateDeterministicAdvice(safeToStart, conflicts, peerSessions);
    const { advice, adviceSource } = await this._getEnhancedAdvice(
      agentId,
      plannedWork,
      safeToStart,
      conflicts,
      context,
      deterministicAdvice,
      peerSessions
    );

    this.lastArbitration = {
      agentId,
      leadState: leadState.state,
      safeToStart,
      mustWait: conflicts,
      advice,
      adviceSource,
      peerSessionsCount: peerSessions.length,
      evaluatedAt: Date.now()
    };

    return {
      projectId: this.projectId,
      agentId,
      leadState: leadState.state,
      safeToStart,
      mustWait: conflicts,
      peerSessions,
      advice,
      adviceSource,
      deterministicAdvice
    };
  }

  reportMilestone({ agentId, description, leaseIdToRelease = null, memory = null }) {
    let releaseResult = null;
    if (leaseIdToRelease) {
      releaseResult = this.coordinator.releaseLease(leaseIdToRelease, agentId);
    }

    if (this.memoryService) {
      if (memory && typeof memory === 'object' && memory.key && memory.content) {
        this.memoryService.set(this.projectId, {
          category: memory.category || 'milestone',
          key: memory.key,
          content: memory.content,
          sourceAgentId: agentId
        });
      } else if (description) {
        this.memoryService.set(this.projectId, {
          category: 'milestone',
          key: `milestone_${Date.now()}`,
          content: description,
          sourceAgentId: agentId
        });
      }
    }

    // 同步更新 agent 表的 progress_summary
    if (description) {
      try {
        this.coordinator.db.prepare(`
          UPDATE agents
          SET progress_summary = ?, last_heartbeat = ?
          WHERE id = ? AND project_id = ?
        `).run(description.trim(), Date.now(), agentId, this.projectId);
      } catch {}
    }

    this.coordinator.logActivity(agentId, 'milestone:reached', null, description || 'Milestone completed', this.projectId);
    this.eventBus.emit('milestone:reached', {
      project_id: this.projectId,
      agent_id: agentId,
      description,
      released: releaseResult
    });

    return {
      success: true,
      milestone: description,
      released: releaseResult
    };
  }

  broadcast({ from = 'sensei', content, importance = 'normal', messageService = null, token = null }) {
    if (!content || typeof content !== 'string' || !content.trim()) {
      throw new Error('"content" is required and must be a non-empty string');
    }

    const trimmed = content.trim();
    const finalImportance = importance === 'urgent' ? 'urgent' : 'normal';

    if (!this.coordinator.getAgent(from)) {
      this.coordinator.registerAgent({
        id: from,
        name: from === 'sensei' ? 'Sensei (Human Operator)' : (from === 'lead' ? 'Tech Lead' : 'Master Orchestrator'),
        provider: 'system',
        sessionId: 'broadcast',
        projectId: this.projectId
      });
    }

    let msg = null;
    if (messageService) {
      msg = messageService.send({
        from,
        to: null,
        content: trimmed,
        importance: finalImportance,
        projectId: this.projectId
      }, token);
    }

    const activeAgents = this.coordinator.listAgents(this.projectId)
      .filter(a => a.status !== 'departed' && a.id !== from);

    this.eventBus.emit('lead:broadcast', {
      project_id: this.projectId,
      from,
      content: trimmed,
      importance: finalImportance,
      message_id: msg ? msg.id : null,
      created_at: msg ? msg.created_at : Date.now(),
      active_agents_count: activeAgents.length,
      recipients: activeAgents.map(a => a.id)
    });

    this.coordinator.logActivity(from, 'lead:broadcast', null, trimmed, this.projectId);

    return {
      success: true,
      message: msg,
      broadcast_to: activeAgents.map(a => a.id),
      agents_count: activeAgents.length
    };
  }

  depart(agentId) {
    const existed = this.sessionPlans.delete(agentId);
    if (existed) {
      this.eventBus.emit('project:departed', {
        project_id: this.projectId,
        agent_id: agentId
      });
    }

    // 重新评估架构师状态
    const remainingPlans = Array.from(this.sessionPlans.keys());
    if (remainingPlans.length <= 1) {
      this.state = remainingPlans.length === 1 ? LEAD_STATES.OBSERVING : LEAD_STATES.STANDBY;
    }

    return { success: true };
  }
}

