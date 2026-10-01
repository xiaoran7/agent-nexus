import { NullAdapter } from './llm-adapter.js';

export class ProjectLead {
  constructor(projectId, coordinator, eventBus, llmAdapter = new NullAdapter()) {
    this.projectId = projectId;
    this.coordinator = coordinator;
    this.eventBus = eventBus;
    this.llmAdapter = llmAdapter;
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

  onboard({ agentId, plannedWork = [], capabilities = [] }) {
    const context = this.getProjectContext();
    const { conflicts, safeToStart } = this._findPlanConflicts(plannedWork, context, agentId);

    // 记录该 session 的施工计划
    this.sessionPlans.set(agentId, {
      plannedWork,
      capabilities,
      registeredAt: Date.now()
    });

    const advice = this._generateDeterministicAdvice(safeToStart, conflicts);

    this.eventBus.emit('project:onboarded', {
      project_id: this.projectId,
      agent_id: agentId,
      planned_count: plannedWork.length,
      conflicts_count: conflicts.length
    });

    return {
      projectId: this.projectId,
      agentId,
      safeToStart,
      mustWait: conflicts,
      advice
    };
  }

  advisePlan({ agentId, plannedWork = [] }) {
    const context = this.getProjectContext();
    const { conflicts, safeToStart } = this._findPlanConflicts(plannedWork, context, agentId);
    const advice = this._generateDeterministicAdvice(safeToStart, conflicts);

    return {
      projectId: this.projectId,
      agentId,
      safeToStart,
      mustWait: conflicts,
      advice
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
