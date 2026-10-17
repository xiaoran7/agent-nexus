// Agent-Nexus War Room UI Controller

const NEXUS_TOKEN = (() => {
  const fromQuery = new URLSearchParams(location.search).get('token');
  if (fromQuery) {
    sessionStorage.setItem('nexusToken', fromQuery);
    return fromQuery;
  }
  return sessionStorage.getItem('nexusToken') || '';
})();

let currentProjectId = 'default';
const authHeaders = () => (
  NEXUS_TOKEN
    ? { Authorization: `Bearer ${NEXUS_TOKEN}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' }
);

// HTML 安全转义函数，杜绝存储型与反射型 XSS
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 通用防抖函数，避免事件风暴引发网络雪崩与渲染卡顿
function debounce(fn, delay = 200) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// DOM 元素缓存
const dom = {
  projectSelector: document.getElementById('project-selector'),
  drawerOverlay: document.getElementById('drawer-overlay'),
  memoryDrawer: document.getElementById('memory-drawer'),
  openMemoryDrawerBtn: document.getElementById('open-memory-drawer-btn'),
  closeMemoryDrawerBtn: document.getElementById('close-memory-drawer-btn'),
  memoryItemsContainer: document.getElementById('memory-items-container'),
  memorySearchInput: document.getElementById('memory-search-input'),
  saveMemBtn: document.getElementById('save-mem-btn'),
  newMemCat: document.getElementById('new-mem-cat'),
  newMemKey: document.getElementById('new-mem-key'),
  newMemContent: document.getElementById('new-mem-content'),
  masterBroadcastInput: document.getElementById('master-broadcast-input'),
  masterBroadcastUrgent: document.getElementById('master-broadcast-urgent'),
  masterBroadcastBtn: document.getElementById('master-broadcast-btn'),
  leadAdviceContainer: document.getElementById('lead-advice-container'),
  leadStatusChip: document.getElementById('lead-status-chip'),
  leadSessionStats: document.getElementById('lead-session-stats'),
  leadAwakenedDetail: document.getElementById('lead-awakened-detail'),
  dialogueContainer: document.getElementById('dialogue-stream'),
  dialogueCounter: document.getElementById('dialogue-counter'),
  refreshDialogueBtn: document.getElementById('refresh-dialogue-btn'),
  matrixStatus: document.getElementById('matrix-last-updated'),
  lanesContainer: document.getElementById('lanes-container'),
  lanesStatus: document.getElementById('lanes-status'),
  agentsContainer: document.getElementById('agents-container'),
  timelineContainer: document.getElementById('timeline-container'),
  metricTotalAgents: document.getElementById('metric-total-agents'),
  metricRunning: document.getElementById('metric-running'),
  metricWaiting: document.getElementById('metric-waiting'),
  metricMemories: document.getElementById('metric-memories'),
  memoryCountBadge: document.getElementById('memory-count-badge'),

  // View Switcher Tabs & Panes
  tabWarRoom: document.getElementById('tab-war-room'),
  tabTopology: document.getElementById('tab-topology'),
  tabGateway: document.getElementById('tab-gateway'),
  tabUnified: document.getElementById('tab-unified'),
  viewWarRoom: document.getElementById('view-war-room'),
  viewTopology: document.getElementById('view-topology'),
  viewGateway: document.getElementById('view-gateway'),
  gatewayTabBadge: document.getElementById('gateway-tab-badge'),
  topologyTabBadge: document.getElementById('topology-tab-badge'),

  // Functional Topology DOM Elements
  topoStatNodes: document.getElementById('topo-stat-nodes'),
  topoStatEdges: document.getElementById('topo-stat-edges'),
  topoStatAgents: document.getElementById('topo-stat-agents'),
  topoSearchInput: document.getElementById('topo-search-input'),
  topoRefreshBtn: document.getElementById('topo-refresh-btn'),
  topoViewport: document.getElementById('topo-viewport'),
  topoCanvasInner: document.getElementById('topo-canvas-inner'),
  topoSvgLayer: document.getElementById('topo-svg-layer'),
  topoNodesLayer: document.getElementById('topo-nodes-layer'),

  // Gateway Controls & Metric Cards
  gwStrategySelect: document.getElementById('gw-strategy-select'),
  gwHealthDot: document.getElementById('gw-health-dot'),
  gwHealthText: document.getElementById('gw-health-text'),
  gwCandidateCountText: document.getElementById('gw-candidate-count-text'),
  gwResetAllBtn: document.getElementById('gw-reset-all-btn'),
  gwTotalRequests: document.getElementById('gw-total-requests'),
  gwActiveNodes: document.getElementById('gw-active-nodes'),
  gwRestingNodes: document.getElementById('gw-resting-nodes'),
  gwAvgLatency: document.getElementById('gw-avg-latency'),

  // Topology Elements
  topoAffinityKey: document.getElementById('topo-affinity-key'),
  topoStrategyDisplay: document.getElementById('topo-strategy-display'),
  topoCandidatesCluster: document.getElementById('topo-candidates-cluster'),
  topologyFlowStatus: document.getElementById('topology-flow-status'),

  // Upstream Candidate Pool Grid
  gwCandidatesContainer: document.getElementById('gw-candidates-container'),
  candidatesPoolMeta: document.getElementById('candidates-pool-meta'),
  gwDemoLoadBtn: document.getElementById('gw-demo-load-btn'),

  // Live Probe Console
  probeUserMessage: document.getElementById('probe-user-message'),
  probeDispatchBtn: document.getElementById('probe-dispatch-btn'),
  probeOutputContainer: document.getElementById('probe-output-container')
};

// 抽屉与项目交互
if (dom.openMemoryDrawerBtn) {
  dom.openMemoryDrawerBtn.onclick = () => {
    dom.drawerOverlay?.classList.add('open');
    dom.memoryDrawer?.classList.add('open');
    fetchMemories();
  };
}

if (dom.closeMemoryDrawerBtn && dom.drawerOverlay) {
  dom.closeMemoryDrawerBtn.onclick = dom.drawerOverlay.onclick = () => {
    dom.drawerOverlay?.classList.remove('open');
    dom.memoryDrawer?.classList.remove('open');
  };
}

if (dom.projectSelector) {
  dom.projectSelector.onchange = () => {
    currentProjectId = dom.projectSelector.value;
    fetchDashboard();
    fetchMemories();
  };
}

// 项目列表加载
async function loadProjects() {
  try {
    const res = await fetch('/api/projects', { headers: authHeaders() });
    if (!res.ok) return;
    const list = await res.json();
    if (list && list.length > 0 && dom.projectSelector) {
      dom.projectSelector.innerHTML = list.map(p => {
        const idSafe = escapeHtml(p.id);
        const nameSafe = escapeHtml(p.display_name || p.id);
        const selected = p.id === currentProjectId ? 'selected' : '';
        return `<option value="${idSafe}" ${selected}>Project: ${nameSafe}</option>`;
      }).join('');
    }
  } catch {}
}

// 态势大盘拉取
async function fetchDashboard() {
  try {
    const res = await fetch(`/api/dashboard?project_id=${encodeURIComponent(currentProjectId)}`, { headers: authHeaders() });
    if (res.status === 401) {
      if (dom.matrixStatus) dom.matrixStatus.textContent = 'NEEDS TOKEN';
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    renderMetrics(data);
    renderLanes(data.activeClaims || [], data.agents || []);
    renderAgents(data.agents || [], data.activeClaims || []);
    renderTimeline(data.timeline || []);
  } catch (err) {
    console.error('Fetch dashboard error:', err);
  }
}

// 施工泳道渲染
function renderLanes(claims, agents) {
  if (!dom.lanesContainer || !dom.lanesStatus) return;

  if (!claims || claims.length === 0) {
    dom.lanesStatus.textContent = '0 ACTIVE LANES';
    dom.lanesContainer.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-faint); font-size: 12px; border: 1px dashed var(--border-subtle); border-radius: 12px;">
        No concurrent lock contentions. Construction lanes are completely open for parallel sprints.
      </div>
    `;
    return;
  }

  dom.lanesStatus.textContent = `${claims.length} ACTIVE LANES`;
  const now = Date.now();

  dom.lanesContainer.innerHTML = claims.map(c => {
    const holder = agents.find(a => a.id === c.agent_id);
    const holderName = escapeHtml(holder ? holder.name : c.agent_id);
    const remainingSec = Math.max(0, Math.ceil((c.expires_at - now) / 1000));
    const totalDuration = 300;
    const progressPct = Math.min(100, Math.max(5, (remainingSec / totalDuration) * 100));

    const shortTarget = escapeHtml(c.claim_target.split('/').pop());
    const fullTarget = escapeHtml(c.claim_target);
    const claimType = escapeHtml(c.claim_type);

    const waitingAgents = agents.filter(a => a.status === 'waiting' && a.blocked_reason && a.blocked_reason.includes(c.claim_target.split('/').pop()));

    return `
      <div class="lane-card">
        <div class="lane-header">
          <span class="lane-target" title="${fullTarget}">[${claimType}] ${shortTarget}</span>
          <span class="lane-tag busy">倒计时: ${remainingSec}s</span>
        </div>
        <div class="lane-flow">
          <span class="lane-holder">${holderName}</span>
          <span class="lane-arrow">[独占修改中]</span>
          ${waitingAgents.length > 0
            ? `<span class="lane-waiter">下一位接力: ${waitingAgents.map(w => escapeHtml(w.name)).join(', ')}</span>`
            : `<span style="color: var(--text-faint); font-size: 12px;">(无其他助手排队)</span>`}
        </div>
        <div class="lane-countdown-bar" style="height: 4px; background: rgba(255,255,255,0.06); border-radius: 9999px; margin-top: 10px; overflow: hidden;">
          <div class="lane-progress" style="width: ${progressPct}%; height: 100%; background: #38bdf8; border-radius: 9999px;"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderMetrics(data) {
  const agents = data.agents || [];
  if (dom.metricTotalAgents) dom.metricTotalAgents.textContent = agents.length;
  if (dom.metricRunning) dom.metricRunning.textContent = agents.filter(a => a.status === 'running').length;
  if (dom.metricWaiting) dom.metricWaiting.textContent = agents.filter(a => a.status === 'waiting').length;

  // 动态同步 Tech Lead 架构师视窗
  updateLeadConsole(agents);
}

function updateLeadConsole(agents) {
  if (!dom.leadStatusChip) return;
  const activeCount = agents.filter(a => a.status !== 'departed').length;

  if (dom.leadSessionStats) {
    dom.leadSessionStats.textContent = `${activeCount} 个会话正在干活`;
  }

  if (activeCount <= 1) {
    dom.leadStatusChip.className = 'lead-chip chip-silent';
    dom.leadStatusChip.textContent = '静默守望（单人施工不打扰）';
    if (dom.leadAdviceContainer && !dom.leadAdviceContainer.getAttribute('data-sticky')) {
      dom.leadAdviceContainer.innerHTML = `[Nexus 架构师静默保驾] 当前只有单会话独立施工，架构师保持静默，绝不产生干扰。当检测到新会话带着并发修改计划加入时，将实时唤醒并提供避让重排与交接路线。`;
    }
  } else {
    dom.leadStatusChip.className = 'lead-chip chip-awakened';
    dom.leadStatusChip.textContent = '已唤醒（多会话协同避障）';
  }
}

function handleLeadAwakened(data) {
  if (!dom.leadStatusChip || !dom.leadAdviceContainer) return;
  dom.leadStatusChip.className = 'lead-chip chip-awakened';
  dom.leadStatusChip.textContent = '已唤醒（多会话协同避障）';

  const joiningId = escapeHtml(data.joining_agent_id);
  const activeCount = data.active_peer_count || 1;
  const conflictsCount = data.conflicts_count || 0;

  dom.leadAdviceContainer.setAttribute('data-sticky', 'true');
  dom.leadAdviceContainer.innerHTML = `
    <strong>[架构师实时唤醒提醒]</strong>
    检测到新会话 <strong>${joiningId}</strong> 加入工作区（在席活跃施工会话: ${activeCount} 个，潜在写冲突: ${conflictsCount} 项）。
    已完成全景信息聚合（各方施工进度、持有的文件锁与长期备忘），避让重排指引已就绪！
  `;

  if (dom.leadAwakenedDetail && data.peer_sessions && data.peer_sessions.length > 0) {
    dom.leadAwakenedDetail.style.display = 'block';
    dom.leadAwakenedDetail.innerHTML = `
      <div style="font-weight: 700; color: #38bdf8; margin-bottom: 6px;">【在席会话施工现场快照】</div>
      ${data.peer_sessions.map(p => `
        <div style="padding: 4px 8px; background: rgba(0,0,0,0.3); border-radius: 6px; margin-bottom: 4px; font-size: 11px;">
          • 会话 [${escapeHtml(p.name)}]: 意图 "${escapeHtml(p.currentIntent || '无')}" | 进度 "${escapeHtml(p.progressSummary || '进行中')}" | 独占锁 ${p.activeLeasesCount || 0} 个
        </div>
      `).join('')}
    `;
  }
}

function renderAgents(agents, activeClaims) {
  if (!dom.agentsContainer) return;
  if (!agents || agents.length === 0) {
    dom.agentsContainer.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 36px 20px; text-align: center; color: var(--text-faint); font-size: 13px; border: 1px dashed var(--border-subtle); border-radius: 14px;">
        当前项目暂无活跃的 AI 助手。
      </div>
    `;
    return;
  }

  const statusMap = {
    running: '正在改文件',
    waiting: '排队等待中',
    idle: '空闲就绪',
    departed: '已离开'
  };

  dom.agentsContainer.innerHTML = agents.map(a => {
    const status = a.status || 'idle';
    const statusSafe = escapeHtml(status);
    const statusLabel = escapeHtml(statusMap[status] || status);
    const nameSafe = escapeHtml(a.name);
    const claims = (activeClaims || []).filter(c => c.agent_id === a.id);
    const providerShort = escapeHtml((a.provider || 'A').toUpperCase().slice(0, 2));

    return `
      <div class="agent-card ${statusSafe}">
        <div class="agent-top-row">
          <div class="agent-id-name">
            <div class="agent-icon">${providerShort}</div>
            <div class="agent-title-text" title="${nameSafe}">${nameSafe}</div>
          </div>
          <span class="status-tag ${statusSafe}">${statusLabel}</span>
        </div>
        <div class="intent-box">
          ${a.current_intent ? `<strong>当前意图:</strong> ${escapeHtml(a.current_intent)}` : '<span style="color: var(--text-faint);">暂未声明修改意图</span>'}
        </div>
        ${a.progress_summary ? `
          <div class="progress-box" style="margin-top: 8px; padding: 6px 10px; background: rgba(14, 165, 233, 0.08); border-left: 2px solid #0ea5e9; border-radius: 4px; font-size: 11px;">
            <strong style="color: #38bdf8;">施工进度:</strong> ${escapeHtml(a.progress_summary)}
          </div>
        ` : ''}
        ${a.blocked_reason ? `
          <div class="blocked-callout" style="display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 8px 12px; background: rgba(251, 113, 133, 0.12); border-radius: 10px; color: #fecdd3; font-size: 13px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            <span>${escapeHtml(a.blocked_reason)}</span>
          </div>
        ` : ''}
        ${claims.length > 0 ? `
          <div class="claims-zone">
            <span class="claims-label">已独占锁定的文件/资源 (${claims.length})</span>
            <div class="claims-flex">
              ${claims.map(c => `
                <span class="claim-pill" title="${escapeHtml(c.claim_target)}">[${escapeHtml(c.claim_type)}] ${escapeHtml(c.claim_target.split('/').pop())}</span>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function renderTimeline(timeline) {
  if (!dom.timelineContainer) return;
  if (!timeline || timeline.length === 0) {
    dom.timelineContainer.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-faint); font-size: 12px;">暂无动态记录。</div>';
    return;
  }

  dom.timelineContainer.innerHTML = timeline.map(item => {
    const timeStr = escapeHtml(new Date(item.created_at).toTimeString().split(' ')[0]);
    let typeClass = 'granted';
    let badgeSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';

    if (item.event_type.includes('blocked')) {
      typeClass = 'blocked';
      badgeSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
    } else if (item.event_type.includes('released')) {
      typeClass = 'released';
      badgeSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle></svg>';
    } else if (item.event_type.includes('woken')) {
      typeClass = 'woken';
      badgeSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>';
    } else if (item.event_type.includes('broadcast')) {
      typeClass = 'broadcast';
      badgeSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 5L6 9H2v6h4l5 4V5z"></path></svg>';
    }

    const actor = escapeHtml(item.agent_name || item.agent_id);
    const eventType = escapeHtml(item.event_type);
    const desc = escapeHtml(item.description);

    return `
      <div class="timeline-item">
        <div class="timeline-badge ${typeClass}">${badgeSvg}</div>
        <div class="timeline-content-box">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;">
            <span style="font-size: 13px; font-weight: 700; color: #fff;">[${actor}] ${eventType}</span>
            <span class="timeline-time">${timeStr}</span>
          </div>
          <div class="timeline-desc">${desc}</div>
        </div>
      </div>
    `;
  }).join('');
}

// 记忆读取与保存
async function fetchMemories(query = '') {
  try {
    const url = query
      ? `/api/projects/${encodeURIComponent(currentProjectId)}/memories?q=${encodeURIComponent(query)}`
      : `/api/projects/${encodeURIComponent(currentProjectId)}/memories`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    const list = await res.json();
    if (dom.metricMemories) dom.metricMemories.textContent = list.length;
    if (dom.memoryCountBadge) dom.memoryCountBadge.textContent = list.length;

    if (!dom.memoryItemsContainer) return;
    if (list.length === 0) {
      dom.memoryItemsContainer.innerHTML = '<div style="padding: 30px; text-align: center; color: var(--text-faint); font-size: 13px;">No long-term memories saved yet.</div>';
      return;
    }

    dom.memoryItemsContainer.innerHTML = list.map(m => {
      const catSafe = escapeHtml(m.category);
      const srcSafe = m.source_agent_id ? `@${escapeHtml(m.source_agent_id)}` : '';
      const keySafe = escapeHtml(m.key);
      const contentSafe = escapeHtml(m.content);

      return `
        <div class="memory-item">
          <div class="memory-item-top">
            <span class="memory-cat-pill cat-${catSafe}">${catSafe}</span>
            <span style="font-size: 11px; color: var(--text-faint);">${srcSafe}</span>
          </div>
          <div class="memory-key">${keySafe}</div>
          <div class="memory-content">${contentSafe}</div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Fetch memories error:', err);
  }
}

if (dom.saveMemBtn) {
  dom.saveMemBtn.onclick = async () => {
    const category = dom.newMemCat?.value || 'general';
    const key = dom.newMemKey?.value.trim() || '';
    const content = dom.newMemContent?.value.trim() || '';
    if (!key || !content) return alert('Key and content are required');

    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(currentProjectId)}/memories`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ category, key, content, source_agent_id: 'sensei' })
      });
      if (res.ok) {
        if (dom.newMemKey) dom.newMemKey.value = '';
        if (dom.newMemContent) dom.newMemContent.value = '';
        fetchMemories();
      }
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  };
}

// 搜索框防抖 250ms
const debouncedSearchMemories = debounce((q) => fetchMemories(q), 250);

if (dom.memorySearchInput) {
  dom.memorySearchInput.oninput = (e) => {
    debouncedSearchMemories(e.target.value.trim());
  };
}

// Master Broadcast 指令广播
if (dom.masterBroadcastBtn) {
  dom.masterBroadcastBtn.onclick = async () => {
    const content = dom.masterBroadcastInput ? dom.masterBroadcastInput.value.trim() : '';
    if (!content) return;
    const importance = dom.masterBroadcastUrgent?.checked ? 'urgent' : 'normal';

    try {
      dom.masterBroadcastBtn.disabled = true;
      dom.masterBroadcastBtn.style.opacity = '0.6';
      const res = await fetch(`/api/projects/${encodeURIComponent(currentProjectId)}/broadcast`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ from: 'sensei', content, importance })
      });
      const data = await res.json();
      if (res.ok) {
        if (dom.masterBroadcastInput) dom.masterBroadcastInput.value = '';
        if (dom.leadAdviceContainer) {
          dom.leadAdviceContainer.innerHTML = `<strong>[Sensei 广播已下发至 ${escapeHtml(data.agents_count)} 个会话]</strong>: ${escapeHtml(content)}`;
        }
        fetchDashboard();
      } else {
        alert('Broadcast failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Broadcast network error: ' + err.message);
    } finally {
      dom.masterBroadcastBtn.disabled = false;
      dom.masterBroadcastBtn.style.opacity = '1';
    }
  };
}

// 刷新防抖，避免事件风暴冲击服务端
const debouncedFetchDashboard = debounce(fetchDashboard, 100);
const debouncedFetchMemories = debounce(fetchMemories, 150);
const debouncedFetchDialogues = debounce(fetchDialogues, 150);

// 会话间对话网络拉取与渲染
async function fetchDialogues() {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProjectId)}/dialogue`, { headers: authHeaders() });
    if (!res.ok) return;
    const list = await res.json();
    if (!Array.isArray(list)) return;

    if (dom.dialogueCounter) dom.dialogueCounter.textContent = `${list.length} DIALOGUES`;
    if (!dom.dialogueContainer) return;

    if (list.length === 0) {
      dom.dialogueContainer.innerHTML = '<div class="dialogue-empty-hint">暂无跨 Session 对话，当多会话并发沟通接口、交接进度时将在此呈现。</div>';
      return;
    }

    dom.dialogueContainer.innerHTML = list.map(m => {
      const timeStr = escapeHtml(new Date(m.created_at).toTimeString().split(' ')[0]);
      const fromSafe = escapeHtml(m.from_agent_name || m.from_agent);
      const toSafe = m.to_agent ? `@${escapeHtml(m.to_agent_name || m.to_agent)}` : 'BROADCAST';
      const typeSafe = escapeHtml((m.dialogue_type || 'chat').toUpperCase());
      const contentSafe = escapeHtml(m.content);
      const threadSafe = m.thread_id ? `#${escapeHtml(m.thread_id)}` : '';
      const statusSafe = escapeHtml(m.status || 'read');

      return `
        <div class="dialogue-card type-${escapeHtml(m.dialogue_type || 'chat')}">
          <div class="dialogue-header-row">
            <div class="dialogue-tags">
              <span class="dialogue-type-pill">${typeSafe}</span>
              ${threadSafe ? `<span class="dialogue-thread-pill">${threadSafe}</span>` : ''}
              <span class="dialogue-status-pill ${statusSafe}">${statusSafe}</span>
            </div>
            <span class="dialogue-time">${timeStr}</span>
          </div>
          <div class="dialogue-body-content">
            <span class="dialogue-route">[${fromSafe} → ${toSafe}]:</span>
            <span class="dialogue-text">${contentSafe}</span>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Fetch dialogues error:', err);
  }
}

if (dom.refreshDialogueBtn) {
  dom.refreshDialogueBtn.onclick = () => fetchDialogues();
}

// ==========================================
// View Switcher (War Room / Topology / Magpie Gateway / Unified)
// ==========================================
let currentViewMode = 'war-room';

function setViewMode(mode) {
  currentViewMode = mode;
  [dom.tabWarRoom, dom.tabTopology, dom.tabGateway, dom.tabUnified].forEach(t => t?.classList.remove('active'));
  [dom.viewWarRoom, dom.viewTopology, dom.viewGateway].forEach(v => v?.classList.remove('active'));

  if (mode === 'war-room') {
    dom.tabWarRoom?.classList.add('active');
    dom.viewWarRoom?.classList.add('active');
  } else if (mode === 'topology') {
    dom.tabTopology?.classList.add('active');
    dom.viewTopology?.classList.add('active');
    fetchTopologyGraph();
  } else if (mode === 'gateway') {
    dom.tabGateway?.classList.add('active');
    dom.viewGateway?.classList.add('active');
    fetchGatewayStatus();
  } else if (mode === 'unified') {
    dom.tabUnified?.classList.add('active');
    dom.viewWarRoom?.classList.add('active');
    dom.viewTopology?.classList.add('active');
    dom.viewGateway?.classList.add('active');
    fetchTopologyGraph();
    fetchGatewayStatus();
  }
}

if (dom.tabWarRoom) dom.tabWarRoom.onclick = () => setViewMode('war-room');
if (dom.tabTopology) dom.tabTopology.onclick = () => setViewMode('topology');
if (dom.tabGateway) dom.tabGateway.onclick = () => setViewMode('gateway');
if (dom.tabUnified) dom.tabUnified.onclick = () => setViewMode('unified');

// ==========================================
// Functional Topology Controller (功能演进拓扑大屏)
// ==========================================
let currentTopologyData = null;
let topoSearchQuery = '';

async function fetchTopologyGraph() {
  try {
    const res = await fetch(`/api/topology?project_id=${encodeURIComponent(currentProjectId)}&limit=100`, {
      headers: authHeaders()
    });
    if (!res.ok) return;
    const data = await res.json();
    currentTopologyData = data;
    renderTopologyView(data);
  } catch (err) {
    console.error('Fetch topology error:', err);
  }
}

if (dom.topoRefreshBtn) {
  dom.topoRefreshBtn.onclick = () => fetchTopologyGraph();
}

if (dom.topoSearchInput) {
  dom.topoSearchInput.oninput = (e) => {
    topoSearchQuery = (e.target.value || '').trim().toLowerCase();
    if (currentTopologyData) {
      renderTopologyView(currentTopologyData);
    }
  };
}

function renderTopologyView(data) {
  if (!dom.topoNodesLayer || !dom.topoSvgLayer) return;

  const rawNodes = data?.nodes || [];
  const edges = data?.edges || [];

  // 过滤节点
  const filteredNodes = rawNodes.filter(n => {
    if (!topoSearchQuery) return true;
    const matchTitle = (n.title || '').toLowerCase().includes(topoSearchQuery);
    const matchDesc = (n.description || '').toLowerCase().includes(topoSearchQuery);
    const matchAgent = (n.agentName || n.agentId || '').toLowerCase().includes(topoSearchQuery);
    const matchFiles = (n.claims || []).some(c => (c.target || '').toLowerCase().includes(topoSearchQuery));
    return matchTitle || matchDesc || matchAgent || matchFiles;
  });

  // 更新指标
  const distinctAgents = new Set(rawNodes.map(n => n.agentId)).size;
  if (dom.topoStatNodes) dom.topoStatNodes.textContent = rawNodes.length;
  if (dom.topoStatEdges) dom.topoStatEdges.textContent = edges.length;
  if (dom.topoStatAgents) dom.topoStatAgents.textContent = distinctAgents;

  if (filteredNodes.length === 0) {
    dom.topoSvgLayer.innerHTML = '';
    dom.topoNodesLayer.innerHTML = `
      <div class="topo-empty-state" style="text-align: center; padding: 60px 20px;">
        <div class="topo-empty-icon" style="width: 48px; height: 48px; margin: 0 auto 16px auto; border-radius: 14px; background: rgba(56, 189, 248, 0.12); color: #38bdf8; display: flex; align-items: center; justify-content: center;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="18" cy="5" r="3"></circle>
            <circle cx="6" cy="12" r="3"></circle>
            <circle cx="18" cy="19" r="3"></circle>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
          </svg>
        </div>
        <div style="font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 6px;">
          ${rawNodes.length === 0 ? '暂无演进拓扑记录' : '没有匹配的节点'}
        </div>
        <div style="font-size: 13px; color: var(--text-faint);">
          ${rawNodes.length === 0
            ? '当各会话完成意图释放、上报里程碑或 Git 提交时，系统将自动按时间线绘制功能开发与问题解决拓扑图。'
            : '尝试更换搜索关键词（支持按功能标题、Agent 名称或修改的文件路径筛选）。'
          }
        </div>
      </div>
    `;
    return;
  }

  // 1. 渲染卡片 HTML
  dom.topoNodesLayer.innerHTML = filteredNodes.map((node, index) => {
    const isMilestone = node.nodeType === 'milestone';
    const isHandoff = node.nodeType === 'handoff';
    const typeChipClass = isMilestone ? 'chip-topo-milestone' : isHandoff ? 'chip-topo-handoff' : 'chip-topo-completed';
    const typeLabel = isMilestone ? '里程碑达成' : isHandoff ? '会话交接' : '功能完工释放';

    const timeStr = new Date(node.createdAt).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateStr = new Date(node.createdAt).toLocaleDateString([], { month: '2-digit', day: '2-digit' });

    // 文件标签
    const claimsHtml = (node.claims && node.claims.length > 0) ? `
      <div class="topo-claims-box">
        ${node.claims.map(c => `
          <span class="topo-claim-pill" title="${escapeHtml(c.target)}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            <span>${escapeHtml(c.target.split('/').pop() || c.target)}</span>
          </span>
        `).join('')}
      </div>
    ` : '';

    return `
      <div class="topo-card" id="card-${escapeHtml(node.id)}" data-node-id="${escapeHtml(node.id)}">
        <div class="topo-card-header">
          <div class="topo-agent-badge">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="10" rx="2"></rect>
              <circle cx="12" cy="5" r="2"></circle>
              <path d="M12 7v4"></path>
              <line x1="8" y1="16" x2="8.01" y2="16"></line>
              <line x1="16" y1="16" x2="16.01" y2="16"></line>
            </svg>
            <span>${escapeHtml(node.agentName || node.agentId)}</span>
          </div>
          <span class="topo-type-chip ${typeChipClass}">${typeLabel}</span>
        </div>
        <div class="topo-card-title">${escapeHtml(node.title)}</div>
        ${node.description ? `<div class="topo-card-desc">${escapeHtml(node.description)}</div>` : ''}
        ${claimsHtml}
        <div class="topo-time-footer">
          <span>${dateStr} ${timeStr} • 节点 #${index + 1}</span>
        </div>
      </div>
    `;
  }).join('');

  // 2. 动态计算并绘制平滑 SVG 贝塞尔曲线
  // 等待 DOM 布局稳定后计算连线
  requestAnimationFrame(() => {
    drawTopologyEdges(filteredNodes, edges);
    bindTopologyInteractions(filteredNodes, edges);
  });
}

function drawTopologyEdges(nodes, edges) {
  if (!dom.topoSvgLayer || !dom.topoCanvasInner) return;

  const nodeMap = new Map();
  nodes.forEach(n => nodeMap.set(n.id, n));

  const canvasRect = dom.topoCanvasInner.getBoundingClientRect();
  dom.topoSvgLayer.setAttribute('width', `${canvasRect.width}`);
  dom.topoSvgLayer.setAttribute('height', `${canvasRect.height}`);

  const pathsHtml = [];

  for (const edge of edges) {
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) continue;

    const fromEl = document.getElementById(`card-${edge.from}`);
    const toEl = document.getElementById(`card-${edge.to}`);
    if (!fromEl || !toEl) continue;

    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();

    // 锚点坐标相对 canvasRect
    const x1 = fromRect.left - canvasRect.left + (fromRect.width / 2);
    const y1 = fromRect.bottom - canvasRect.top;
    const x2 = toRect.left - canvasRect.left + (toRect.width / 2);
    const y2 = toRect.top - canvasRect.top;

    // 平滑三次贝塞尔曲线
    const midY = (y1 + y2) / 2;
    const pathD = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;

    pathsHtml.push(`
      <path d="${pathD}"
            class="topo-edge-line"
            id="edge-${escapeHtml(edge.from)}-${escapeHtml(edge.to)}"
            data-from="${escapeHtml(edge.from)}"
            data-to="${escapeHtml(edge.to)}" />
    `);
  }

  dom.topoSvgLayer.innerHTML = pathsHtml.join('');
}

function bindTopologyInteractions(nodes, edges) {
  const cards = dom.topoNodesLayer.querySelectorAll('.topo-card');
  const edgeLines = dom.topoSvgLayer.querySelectorAll('.topo-edge-line');

  cards.forEach(card => {
    const nodeId = card.getAttribute('data-node-id');

    card.onmouseenter = () => {
      // 找出所有前驱与后继
      const relatedNodes = new Set([nodeId]);
      const relatedEdges = new Set();

      edges.forEach(e => {
        if (e.from === nodeId || e.to === nodeId) {
          relatedNodes.add(e.from);
          relatedNodes.add(e.to);
          relatedEdges.add(`edge-${e.from}-${e.to}`);
        }
      });

      cards.forEach(c => {
        const id = c.getAttribute('data-node-id');
        if (relatedNodes.has(id)) {
          c.classList.add('highlighted');
          c.classList.remove('dimmed');
        } else {
          c.classList.add('dimmed');
          c.classList.remove('highlighted');
        }
      });

      edgeLines.forEach(l => {
        const from = l.getAttribute('data-from');
        const to = l.getAttribute('data-to');
        if (from === nodeId || to === nodeId) {
          l.classList.add('highlighted');
          l.classList.remove('dimmed');
        } else {
          l.classList.add('dimmed');
          l.classList.remove('highlighted');
        }
      });
    };

    card.onmouseleave = () => {
      cards.forEach(c => {
        c.classList.remove('highlighted', 'dimmed');
      });
      edgeLines.forEach(l => {
        l.classList.remove('highlighted', 'dimmed');
      });
    };
  });
}

// ==========================================
// Magpie Elastic Gateway Controller
// ==========================================
let currentGatewayData = null;
let isDemoMode = false;

async function fetchGatewayStatus() {
  if (isDemoMode) {
    renderGateway(currentGatewayData);
    return;
  }
  try {
    const res = await fetch('/api/gateway/status', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    currentGatewayData = data;
    renderGateway(data);
  } catch (err) {
    console.error('Fetch gateway status error:', err);
  }
}

function renderGateway(data) {
  if (!data) return;

  const strategy = data.strategy || 'smart';
  const candidates = data.candidates || [];
  const candidateCount = data.candidateCount != null ? data.candidateCount : candidates.length;

  // 1. 同步策略下拉框与拓扑策略展示
  if (dom.gwStrategySelect && dom.gwStrategySelect.value !== strategy) {
    dom.gwStrategySelect.value = strategy;
  }
  if (dom.topoStrategyDisplay) {
    const stratNames = {
      smart: '策略: 智能亲和（优先缓存）',
      ordered: '策略: 按优先级瀑布降级',
      rotate: '策略: 轮流分担',
      'least-used': '策略: 最少使用优先'
    };
    dom.topoStrategyDisplay.textContent = stratNames[strategy] || `策略: ${strategy}`;
  }
  if (dom.topoAffinityKey) {
    dom.topoAffinityKey.textContent = escapeHtml(currentProjectId || 'default');
  }

  // 2. 统计指标与健康判定
  let totalReqs = 0;
  let activeNodes = 0;
  let restingNodes = 0;
  let lastLatency = 0;

  candidates.forEach(c => {
    totalReqs += (c.totalRequests || 0);
    if (c.resting) {
      restingNodes++;
    } else {
      activeNodes++;
    }
    if (c.lastLatencyMs && c.lastLatencyMs > 0) {
      lastLatency = c.lastLatencyMs;
    }
  });

  if (dom.gwTotalRequests) dom.gwTotalRequests.textContent = totalReqs;
  if (dom.gwActiveNodes) dom.gwActiveNodes.textContent = activeNodes;
  if (dom.gwRestingNodes) dom.gwRestingNodes.textContent = restingNodes;
  if (dom.gwAvgLatency) dom.gwAvgLatency.textContent = `${lastLatency}ms`;

  if (dom.gwCandidateCountText) {
    dom.gwCandidateCountText.textContent = `${candidateCount} 个模型节点`;
  }

  // 顶部健康胶囊与标签 Badge
  const allDead = candidateCount > 0 && activeNodes === 0;
  if (dom.gwHealthDot && dom.gwHealthText) {
    if (candidateCount === 0) {
      dom.gwHealthText.textContent = '等待配置';
      dom.gwHealthDot.style.background = '#64748b';
      dom.gwHealthDot.style.boxShadow = '0 0 8px #64748b';
    } else if (allDead) {
      dom.gwHealthText.textContent = '全部休眠中';
      dom.gwHealthDot.style.background = '#ef4444';
      dom.gwHealthDot.style.boxShadow = '0 0 8px #ef4444';
    } else if (restingNodes > 0) {
      dom.gwHealthText.textContent = '部分节点避让中';
      dom.gwHealthDot.style.background = '#f59e0b';
      dom.gwHealthDot.style.boxShadow = '0 0 8px #f59e0b';
    } else {
      dom.gwHealthText.textContent = '全部正常运行';
      dom.gwHealthDot.style.background = '#10b981';
      dom.gwHealthDot.style.boxShadow = '0 0 8px #10b981';
    }
  }

  // 3. 渲染拓扑集群通道
  if (dom.topoCandidatesCluster) {
    if (candidates.length === 0) {
      dom.topoCandidatesCluster.innerHTML = `
        <div class="topo-channel-row" style="color: var(--text-faint); font-size: 11px; justify-content: center;">
          当前未配置上游模型节点。
        </div>
      `;
    } else {
      dom.topoCandidatesCluster.innerHTML = candidates.map((c, idx) => {
        const isResting = !!c.resting;
        const channelClass = isResting ? 'resting' : 'active';
        const statusClass = isResting ? 'cooldown' : 'healthy';
        const statusLabel = isResting
          ? `冷却休眠 (${c.remainingRestSeconds || 0}秒)`
          : `正常服务 (优先级:${c.priority})`;
        return `
          <div class="topo-channel-row ${channelClass}">
            <span class="topo-channel-name">
              <span class="topo-channel-dot ${statusClass}"></span>
              <span>[#${idx + 1}] ${escapeHtml(c.name || c.id)}</span>
            </span>
            <span class="topo-channel-status ${statusClass}">${statusLabel}</span>
          </div>
        `;
      }).join('');
    }
  }

  // 4. 渲染 Upstream Candidate Pool Grid 卡片
  renderCandidatesGrid(candidates);
}

function renderCandidatesGrid(candidates) {
  if (!dom.gwCandidatesContainer) return;

  if (!candidates || candidates.length === 0) {
    dom.gwCandidatesContainer.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 40px 20px; text-align: center; color: var(--text-faint); font-size: 13px; border: 1px dashed var(--border-subtle); border-radius: 16px;">
        <div>当前后台未配置上游模型节点。</div>
        <div style="margin-top: 8px; font-size: 12px;">提示：点击上方“载入双模型演示（体验自动换路线）”可立刻体验当主力模型 429 报错时，系统如何毫秒级自动切换到备用模型！</div>
      </div>
    `;
    return;
  }

  const errorTypeMap = {
    'rate-limit': '429 频率限流',
    'overloaded': '上游过载拥堵',
    'auth': '认证鉴权失败',
    'billing': '账户余额不足',
    'timeout': '响应超时',
    'bad-request': '请求格式非法',
    'server-error': '5xx 服务端故障',
    'none': '无异常'
  };

  dom.gwCandidatesContainer.innerHTML = candidates.map(c => {
    const isResting = !!c.resting;
    const isDead = c.consecutiveFailures >= 5;
    const cardClass = isDead ? 'dead' : (isResting ? 'resting' : '');
    const badgeClass = isDead ? 'dead' : (isResting ? 'resting' : 'active');
    const badgeText = isDead ? '已停用' : (isResting ? '冷却休眠中' : '正常服务中');

    const lastFailureType = c.lastFailureType || 'none';
    const failureLabel = errorTypeMap[lastFailureType] || lastFailureType;
    const pillClass = `pill-${lastFailureType}`;

    const remainingSec = c.remainingRestSeconds || 0;
    const totalCooldownSec = Math.max(60, remainingSec);
    const progressPct = isResting ? Math.min(100, Math.max(5, (remainingSec / totalCooldownSec) * 100)) : 0;

    return `
      <div class="candidate-card ${cardClass}">
        <div class="cand-header">
          <div class="cand-title-box">
            <div class="cand-name-row">
              <span class="cand-name" title="${escapeHtml(c.id)}">${escapeHtml(c.name || c.id)}</span>
              <span class="cand-provider-tag">${escapeHtml((c.provider || 'unknown').toUpperCase())}</span>
            </div>
            <span class="cand-model">${escapeHtml(c.model || 'adaptive-llm')}</span>
          </div>
          <span class="cand-status-badge ${badgeClass}">${badgeText}</span>
        </div>

        <div class="cand-stats-grid">
          <div class="cand-stat-item">
            <span class="cand-stat-label">优先级 / 权重</span>
            <span class="cand-stat-val">P${c.priority || 0} / W${c.weight || 1}</span>
          </div>
          <div class="cand-stat-item">
            <span class="cand-stat-label">成功请求率</span>
            <span class="cand-stat-val" style="color: #34d399;">${c.successCount || 0} / ${c.totalRequests || 0}</span>
          </div>
          <div class="cand-stat-item">
            <span class="cand-stat-label">最近耗时</span>
            <span class="cand-stat-val" style="color: #38bdf8;">${c.lastLatencyMs || 0}ms</span>
          </div>
        </div>

        <div class="cand-breaker-box">
          <div class="cand-breaker-row">
            <span style="color: var(--text-faint);">最近错误归因:</span>
            ${lastFailureType !== 'none'
              ? `<span class="cand-error-pill ${pillClass}">${escapeHtml(failureLabel)}</span>`
              : `<span style="color: var(--text-faint); font-family: var(--font-mono); font-size: 10px;">无异常 (0 故障)</span>`
            }
          </div>

          ${isResting ? `
            <div class="cooldown-wrap">
              <div class="cooldown-meta">
                <span>防频繁冲击保护中</span>
                <span>还剩 ${remainingSec} 秒恢复</span>
              </div>
              <div class="cooldown-track">
                <div class="cooldown-progress" style="width: ${progressPct}%;"></div>
              </div>
            </div>
          ` : ''}

          <div class="cand-footer-row">
            <span style="font-size: 10px; color: var(--text-faint); font-family: var(--font-mono);">
              累计失败: ${c.failureCount || 0} (连续失败: ${c.consecutiveFailures || 0})
            </span>
            <button class="cand-unrest-btn" data-unrest-id="${escapeHtml(c.id)}">
              ${isResting ? '立即唤醒' : '重置统计'}
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // 绑定各卡片独立 Reset 按钮
  dom.gwCandidatesContainer.querySelectorAll('.cand-unrest-btn').forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-unrest-id');
      if (id) unrestCandidate(id);
    };
  });
}

// 切换路由策略
if (dom.gwStrategySelect) {
  dom.gwStrategySelect.onchange = async () => {
    const strategy = dom.gwStrategySelect.value;
    try {
      const res = await fetch('/api/gateway/strategy', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ strategy })
      });
      if (res.ok) {
        if (isDemoMode && currentGatewayData) {
          currentGatewayData.strategy = strategy;
        }
        fetchGatewayStatus();
      } else {
        const err = await res.json();
        alert('Strategy update failed: ' + (err.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Strategy update error: ' + err.message);
    }
  };
}

// 单个节点解除休眠
window.unrestCandidate = async function (id) {
  if (isDemoMode && currentGatewayData) {
    const c = currentGatewayData.candidates.find(item => item.id === id);
    if (c) {
      c.resting = false;
      c.remainingRestSeconds = 0;
      c.consecutiveFailures = 0;
      c.lastFailureType = 'none';
    }
    renderGateway(currentGatewayData);
    return;
  }
  try {
    const res = await fetch('/api/gateway/reset', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id })
    });
    if (res.ok) {
      fetchGatewayStatus();
    }
  } catch (err) {
    alert('Unrest error: ' + err.message);
  }
};

// 一键全局解除所有休眠
if (dom.gwResetAllBtn) {
  dom.gwResetAllBtn.onclick = async () => {
    if (isDemoMode && currentGatewayData) {
      currentGatewayData.candidates.forEach(c => {
        c.resting = false;
        c.remainingRestSeconds = 0;
        c.consecutiveFailures = 0;
        c.lastFailureType = 'none';
      });
      renderGateway(currentGatewayData);
      return;
    }
    try {
      const res = await fetch('/api/gateway/reset', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({})
      });
      if (res.ok) {
        fetchGatewayStatus();
      }
    } catch (err) {
      alert('Reset all error: ' + err.message);
    }
  };
}

// 实时路由拨测交互
if (dom.probeDispatchBtn && dom.probeUserMessage) {
  async function dispatchProbe() {
    const text = dom.probeUserMessage.value.trim();
    if (!text) return;

    if (dom.probeOutputContainer) {
      dom.probeOutputContainer.innerHTML = `
        <div style="color: #38bdf8; font-style: italic;">
          正在通过智能网关调度请求（当前项目缓存键="${escapeHtml(currentProjectId)}")...
        </div>
      `;
    }

    const startTime = Date.now();
    try {
      dom.probeDispatchBtn.disabled = true;
      dom.probeDispatchBtn.style.opacity = '0.6';

      if (isDemoMode) {
        // Demo 模拟路由响应
        await new Promise(r => setTimeout(r, 450));
        const latency = Date.now() - startTime;
        if (dom.probeOutputContainer) {
          dom.probeOutputContainer.innerHTML = `
            <div class="probe-res-line">
              <span class="probe-res-badge ok">HTTP 200 成功</span>
              <span class="probe-res-meta">实际服务节点: <strong>备用模型 (DeepSeek-V3)</strong> | 耗时: ${latency}ms | 策略: ${escapeHtml(currentGatewayData.strategy)}</span>
            </div>
            <div class="probe-res-body">【故障自动转移轨迹】
• 主力模型 "Claude 3.7 Sonnet" 当前处于 429 频率限流休眠状态。
• 系统触发零丢包快速降级 → 自动切换至备用模型 "DeepSeek-V3" 完成回答。
回答内容: 已成功处理您的测试请求："${escapeHtml(text)}"</div>
          `;
        }
        if (currentGatewayData) {
          const backup = currentGatewayData.candidates.find(c => c.id === 'backup-deepseek-v3');
          if (backup) {
            backup.totalRequests = (backup.totalRequests || 0) + 1;
            backup.successCount = (backup.successCount || 0) + 1;
            backup.lastLatencyMs = latency;
          }
          renderGateway(currentGatewayData);
        }
        return;
      }

      const res = await fetch('/api/gateway/chat', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          system_prompt: 'You are Magpie resilient gateway verification probe.',
          user_message: text,
          affinityKey: currentProjectId
        })
      });

      const latency = Date.now() - startTime;
      const json = await res.json();

      if (res.ok) {
        if (dom.probeOutputContainer) {
          dom.probeOutputContainer.innerHTML = `
            <div class="probe-res-line">
              <span class="probe-res-badge ok">HTTP 200 成功</span>
              <span class="probe-res-meta">服务节点: <strong>${escapeHtml(json.candidateId || 'gateway')}</strong> | 耗时: ${latency}ms</span>
            </div>
            <div class="probe-res-body">${escapeHtml(json.content || JSON.stringify(json, null, 2))}</div>
          `;
        }
      } else {
        if (dom.probeOutputContainer) {
          dom.probeOutputContainer.innerHTML = `
            <div class="probe-res-line">
              <span class="probe-res-badge fail">HTTP ${res.status} 错误</span>
              <span class="probe-res-meta">耗时: ${latency}ms</span>
            </div>
            <div class="probe-res-body" style="color: #f87171;">${escapeHtml(json.error || '所有可用模型节点均已耗尽')}</div>
          `;
        }
      }
      fetchGatewayStatus();
    } catch (err) {
      if (dom.probeOutputContainer) {
        dom.probeOutputContainer.innerHTML = `
          <div class="probe-res-line">
            <span class="probe-res-badge fail">网络连接异常</span>
          </div>
          <div class="probe-res-body" style="color: #f87171;">${escapeHtml(err.message)}</div>
        `;
      }
    } finally {
      dom.probeDispatchBtn.disabled = false;
      dom.probeDispatchBtn.style.opacity = '1';
    }
  }

  dom.probeDispatchBtn.onclick = dispatchProbe;
  dom.probeUserMessage.onkeydown = (e) => {
    if (e.key === 'Enter') dispatchProbe();
  };
}

// 载入演示拓扑 (Demo Mode)
if (dom.gwDemoLoadBtn) {
  dom.gwDemoLoadBtn.onclick = () => {
    isDemoMode = true;
    currentGatewayData = {
      strategy: 'smart',
      candidateCount: 2,
      candidates: [
        {
          id: 'primary-anthropic-claude',
          name: '主力模型 Claude 3.7 Sonnet',
          provider: 'anthropic',
          model: 'claude-3-7-sonnet-20250219',
          priority: 0,
          weight: 1,
          totalRequests: 42,
          successCount: 41,
          failureCount: 1,
          consecutiveFailures: 1,
          lastLatencyMs: 380,
          resting: true,
          remainingRestSeconds: 48,
          lastFailureType: 'rate-limit'
        },
        {
          id: 'backup-deepseek-v3',
          name: '备用模型 DeepSeek V3 (容灾备选)',
          provider: 'openai',
          model: 'deepseek-chat',
          priority: 1,
          weight: 1,
          totalRequests: 18,
          successCount: 18,
          failureCount: 0,
          consecutiveFailures: 0,
          lastLatencyMs: 240,
          resting: false,
          remainingRestSeconds: 0,
          lastFailureType: 'none'
        }
      ]
    };
    if (dom.candidatesPoolMeta) {
      dom.candidatesPoolMeta.textContent = '双模型自动容灾演练运行中';
    }
    renderGateway(currentGatewayData);
  };
}

// 倒计时自然衰减计算（每 1000ms 刷新一次休眠倒计时）
setInterval(() => {
  if (currentGatewayData && currentGatewayData.candidates) {
    let changed = false;
    currentGatewayData.candidates.forEach(c => {
      if (c.resting && c.remainingRestSeconds > 0) {
        c.remainingRestSeconds--;
        changed = true;
        if (c.remainingRestSeconds <= 0) {
          c.resting = false;
          c.lastFailureType = 'none';
        }
      }
    });
    if (changed) {
      renderGateway(currentGatewayData);
    }
  }
}, 1000);

// 初始化
const statusEl = document.getElementById('daemon-status');
if (statusEl && window.location.host) {
  statusEl.textContent = window.location.host;
}

const urlTab = new URLSearchParams(window.location.search).get('tab') || (window.location.hash ? window.location.hash.slice(1) : null);
if (urlTab && ['war-room', 'topology', 'gateway', 'unified'].includes(urlTab)) {
  setViewMode(urlTab);
}

loadProjects();
fetchDashboard();
fetchMemories();
fetchDialogues();
fetchTopologyGraph();
fetchGatewayStatus();

// 定时保底轮询（2500ms 刷新频率完全符合 60 FPS 规约）
setInterval(() => {
  fetchDashboard();
  fetchDialogues();
  if (currentViewMode === 'topology' || currentViewMode === 'unified') {
    fetchTopologyGraph();
  }
  if (currentViewMode === 'gateway' || currentViewMode === 'unified') {
    fetchGatewayStatus();
  }
}, 2500);

// WebSocket 协议自适应与自动重连
function connectWebSocket() {
  try {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = NEXUS_TOKEN
      ? `${protocol}//${location.host}/?token=${encodeURIComponent(NEXUS_TOKEN)}`
      : `${protocol}//${location.host}`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      if (dom.matrixStatus) dom.matrixStatus.textContent = 'LIVE WS';
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type && payload.type.startsWith('memory:')) {
          debouncedFetchMemories();
        } else if (payload.type === 'topology:node_created') {
          fetchTopologyGraph();
        } else if (payload.type === 'message:sent' || payload.type === 'messages:read') {
          debouncedFetchDialogues();
          debouncedFetchDashboard();
        } else if (payload.type === 'lead:awakened') {
          handleLeadAwakened(payload.data);
          debouncedFetchDashboard();
          debouncedFetchDialogues();
        } else {
          debouncedFetchDashboard();
        }
      } catch {
        debouncedFetchDashboard();
      }
    };

    ws.onclose = () => {
      if (dom.matrixStatus) dom.matrixStatus.textContent = 'POLLING';
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch {
    setTimeout(connectWebSocket, 5000);
  }
}

connectWebSocket();
