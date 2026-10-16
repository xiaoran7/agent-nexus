import { NullAdapter } from './llm-adapter.js';

export class ProjectLead {
  constructor(projectId, coordinator, eventBus, llmAdapter = new NullAdapter(), memoryService = null) {
    this.projectId = projectId;
    this.coordinator = coordinator;
    this.eventBus = eventBus;
    this.llmAdapter = llmAdapter;
    this.memoryService = memoryService;
    this.sessionPlans = new Map(); // agentId -> { plannedWork, registeredAt }
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

  _generateDeterministicAdvice(safeToStart, conflicts) {
    if (conflicts.length === 0) {
      return `[Nexus 调度指引] 当前申报的 ${safeToStart.length} 项资源全部空闲，无冲突风险，你可以全速并发施工。`;
    }

    const blockedList = conflicts.map(c => `• ${c.target}（由 ${c.blockedByName} 锁定，预计剩余约 ${c.estimatedRemainingSec} 秒）`).join('\n');
    const safeList = safeToStart.map(s => `• ${s.target}`).join('\n');

    let advice = `[Nexus 调度指引 - 避障重排建议]\n检测到部分目标资源正在被其他活跃 Session 写入：\n${blockedList}\n\n`;
    if (safeToStart.length > 0) {
      advice += `💡 最佳施工路线：建议你先调整任务顺序，优先完成以下 ${safeToStart.length} 个空闲资源：\n${safeList}\n待上述被锁资源释放后，系统将自动唤醒你接力剩余部分。`;
    } else {
      advice += `⚠️ 你的计划全部处于热写入锁定中。建议切换到该项目的其他独立功能模块，或进入监听模式等待前序会话完工。`;
    }
    return advice;
  }

  _buildLlmPrompt(agentId, plannedWork, safeToStart, conflicts, context, deterministicAdvice) {
    const memories = this.memoryService
      ? this.memoryService.list(this.projectId, { limit: 12 })
      : [];

    const memoryPromptSection = memories.length > 0
      ? memories.map(m => `  • [${m.category.toUpperCase()}] ${m.key}: ${m.content}`).join('\n')
      : '  (暂无先验工程记忆，此为初始阶段)';

    const systemPrompt = `你作为 Agent-Nexus 的项目常驻技术主管兼系统架构师（AI Tech Lead）。
你的职责是在多智能体并发开发环境下，为新进场的编码 Agent 提供高维度的工程协同与任务编排指引，最大化并发吞吐，彻底杜绝代码写踩踏。

【核心不可变铁律】：
1. 冲突判定矩阵是绝对事实（Ground Truth）。你绝对不能告诉 Agent 去直接修改正处于锁定状态（mustWait）的文件。
2. 严格遵守【项目长期工程记忆与先验契约】中固化的架构约束（architecture）、代码规约（rule）与历史避坑经验（gotchas）。在提供解耦或编码建议时，不得违背既有架构规约。
3. 调度建议结构：
   - 优先施工通道：引导 Agent 立即全速实现空闲（safeToStart）的模块；
   - 依赖解耦策略：对于暂时被锁的模块，建议 Agent 抽离 Mock 数据、定义接口契约、编写独立单元测试或编写周边逻辑，而不是原地干等；
   - 倒计时与交接：告知锁持有者和预计释放倒计时，强调完工后系统会自动触发唤醒通知。
4. 风格要求：中文输出、通俗接地气、专业高效、篇幅精炼（250 字以内），直接给出可执行的施工路线，不要废话套话。`;

    const safeDesc = safeToStart.length > 0
      ? safeToStart.map(s => `  - [${s.type || 'file'}] ${s.target}`).join('\n')
      : '  (无，全部计划均受阻)';

    const conflictDesc = conflicts.length > 0
      ? conflicts.map(c => `  - [${c.type}] ${c.target} -> 被 [${c.blockedByName}] 锁定，预计剩余约 ${c.estimatedRemainingSec} 秒`).join('\n')
      : '  (无冲突)';

    const userMessage = `项目 ID: ${this.projectId}
申报 Agent ID: ${agentId}

【项目长期工程记忆与先验契约 (Project Long-term Memories)】:
${memoryPromptSection}

【已核验冲突矩阵 (Ground Truth)】:
1. 安全可立即施工资源 (${safeToStart.length} 项):
${safeDesc}

2. 冲突锁定中资源 (${conflicts.length} 项):
${conflictDesc}

【当前规则引擎计算的基线建议】：
${deterministicAdvice}

请基于上述实际工程事实与先验契约，作为技术主管向此 Agent 给出具体的施工编排与避障解耦建议。`;

    return { systemPrompt, userMessage };
  }

  async _getEnhancedAdvice(agentId, plannedWork, safeToStart, conflicts, context, deterministicAdvice) {
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
        deterministicAdvice
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

    // 记录该 session 的施工计划
    this.sessionPlans.set(agentId, {
      plannedWork,
      capabilities,
      registeredAt: Date.now()
    });

    const deterministicAdvice = this._generateDeterministicAdvice(safeToStart, conflicts);
    const { advice, adviceSource } = await this._getEnhancedAdvice(
      agentId,
      plannedWork,
      safeToStart,
      conflicts,
      context,
      deterministicAdvice
    );

    this.eventBus.emit('project:onboarded', {
      project_id: this.projectId,
      agent_id: agentId,
      planned_count: plannedWork.length,
      conflicts_count: conflicts.length,
      advice_source: adviceSource
    });

    return {
      projectId: this.projectId,
      agentId,
      safeToStart,
      mustWait: conflicts,
      advice,
      adviceSource,
      deterministicAdvice
    };
  }

  async advisePlan({ agentId, plannedWork = [] }) {
    const context = this.getProjectContext();
    const { conflicts, safeToStart } = this._findPlanConflicts(plannedWork, context, agentId);
    const deterministicAdvice = this._generateDeterministicAdvice(safeToStart, conflicts);
    const { advice, adviceSource } = await this._getEnhancedAdvice(
      agentId,
      plannedWork,
      safeToStart,
      conflicts,
      context,
      deterministicAdvice
    );

    return {
      projectId: this.projectId,
      agentId,
      safeToStart,
      mustWait: conflicts,
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
    return { success: true };
  }
}
