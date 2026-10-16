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
  tabGateway: document.getElementById('tab-gateway'),
  tabUnified: document.getElementById('tab-unified'),
  viewWarRoom: document.getElementById('view-war-room'),
  viewGateway: document.getElementById('view-gateway'),
  gatewayTabBadge: document.getElementById('gateway-tab-badge'),

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
        <div class="lane-top">
          <span class="lane-target" title="${fullTarget}">[${claimType}] ${shortTarget}</span>
          <span class="lane-badge busy">TTL: ${remainingSec}s</span>
        </div>
        <div class="lane-flow">
          <span class="lane-holder">${holderName}</span>
          <span class="lane-arrow">➔ [Exclusive Lock]</span>
          ${waitingAgents.length > 0
            ? `<span class="lane-waiter">⏳ Next: ${waitingAgents.map(w => escapeHtml(w.name)).join(', ')}</span>`
            : `<span style="color: var(--text-faint); font-size: 11px;">(No queue backlog)</span>`}
        </div>
        <div class="lane-countdown-bar">
          <div class="lane-progress" style="width: ${progressPct}%;"></div>
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
    dom.leadSessionStats.textContent = `${activeCount} SESSION${activeCount === 1 ? '' : 'S'} ACTIVE`;
  }

  if (activeCount <= 1) {
    dom.leadStatusChip.className = 'lead-chip chip-silent';
    dom.leadStatusChip.textContent = 'OBSERVING (SILENT SPRINT)';
    if (dom.leadAdviceContainer && !dom.leadAdviceContainer.getAttribute('data-sticky')) {
      dom.leadAdviceContainer.innerHTML = `[Nexus 架构师静默保驾] 当前只有单 Session 独立施工，架构师保持静默，绝不产生干扰。当检测到新 Session 带着并发计划加入时，将实时唤醒并提供避障重排与接力路线。`;
    }
  } else {
    dom.leadStatusChip.className = 'lead-chip chip-awakened';
    dom.leadStatusChip.textContent = 'AWAKENED (MULTI-SESSION COORDINATION)';
  }
}

function handleLeadAwakened(data) {
  if (!dom.leadStatusChip || !dom.leadAdviceContainer) return;
  dom.leadStatusChip.className = 'lead-chip chip-awakened';
  dom.leadStatusChip.textContent = 'AWAKENED (MULTI-SESSION COORDINATION)';

  const joiningId = escapeHtml(data.joining_agent_id);
  const activeCount = data.active_peer_count || 1;
  const conflictsCount = data.conflicts_count || 0;

  dom.leadAdviceContainer.setAttribute('data-sticky', 'true');
  dom.leadAdviceContainer.innerHTML = `
    <strong>[Tech Lead 架构师实时唤醒]</strong>
    检测到新 Session <strong>${joiningId}</strong> 加入工作区（在席活跃施工 Session: ${activeCount} 个，潜在写冲突: ${conflictsCount} 项）。
    已完成全景信息聚合（A 施工进度、持有的排他锁与长期工程记忆），避障重排指引已就绪！
  `;

  if (dom.leadAwakenedDetail && data.peer_sessions && data.peer_sessions.length > 0) {
    dom.leadAwakenedDetail.style.display = 'block';
    dom.leadAwakenedDetail.innerHTML = `
      <div style="font-weight: 700; color: #38bdf8; margin-bottom: 6px;">【在席 Session 施工现场快照】</div>
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
        No active agents registered in this project.
      </div>
    `;
    return;
  }

  dom.agentsContainer.innerHTML = agents.map(a => {
    const status = a.status || 'idle';
    const statusSafe = escapeHtml(status);
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
          <span class="status-tag ${statusSafe}">${statusSafe}</span>
        </div>
        <div class="intent-box">
          ${a.current_intent ? `<strong>Intent:</strong> ${escapeHtml(a.current_intent)}` : '<span style="color: var(--text-faint);">No active declared intent</span>'}
        </div>
        ${a.progress_summary ? `
          <div class="progress-box" style="margin-top: 8px; padding: 6px 10px; background: rgba(14, 165, 233, 0.08); border-left: 2px solid #0ea5e9; border-radius: 4px; font-size: 11px;">
            <strong style="color: #38bdf8;">Progress:</strong> ${escapeHtml(a.progress_summary)}
          </div>
        ` : ''}
        ${a.blocked_reason ? `
          <div class="blocked-callout">
            <span>⚠️</span>
            <span>${escapeHtml(a.blocked_reason)}</span>
          </div>
        ` : ''}
        ${claims.length > 0 ? `
          <div class="claims-zone">
            <span class="claims-label">Locked Resources (${claims.length})</span>
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
    dom.timelineContainer.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-faint); font-size: 12px;">No events recorded.</div>';
    return;
  }

  dom.timelineContainer.innerHTML = timeline.map(item => {
    const timeStr = escapeHtml(new Date(item.created_at).toTimeString().split(' ')[0]);
    let typeClass = 'granted';
    let badgeIcon = '✓';
    if (item.event_type.includes('blocked')) { typeClass = 'blocked'; badgeIcon = '✕'; }
    else if (item.event_type.includes('released')) { typeClass = 'released'; badgeIcon = '○'; }
    else if (item.event_type.includes('woken')) { typeClass = 'woken'; badgeIcon = '⚡'; }
    else if (item.event_type.includes('broadcast')) { typeClass = 'broadcast'; badgeIcon = '📢'; }

    const actor = escapeHtml(item.agent_name || item.agent_id);
    const eventType = escapeHtml(item.event_type);
    const desc = escapeHtml(item.description);

    return `
      <div class="timeline-card">
        <div class="timeline-time-col">${timeStr}</div>
        <div class="timeline-body-col">
          <div class="timeline-action-tag ${typeClass}">
            <span>${badgeIcon}</span>
            <span>[${actor}] ${eventType}</span>
          </div>
          <div class="timeline-text">${desc}</div>
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
            <span class="dialogue-route">[${fromSafe} ➔ ${toSafe}]:</span>
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
// View Switcher (War Room / Magpie Gateway / Unified)
// ==========================================
let currentViewMode = 'war-room';

function setViewMode(mode) {
  currentViewMode = mode;
  [dom.tabWarRoom, dom.tabGateway, dom.tabUnified].forEach(t => t?.classList.remove('active'));

  if (mode === 'war-room') {
    dom.tabWarRoom?.classList.add('active');
    dom.viewWarRoom?.classList.add('active');
    dom.viewGateway?.classList.remove('active');
  } else if (mode === 'gateway') {
    dom.tabGateway?.classList.add('active');
    dom.viewWarRoom?.classList.remove('active');
    dom.viewGateway?.classList.add('active');
    fetchGatewayStatus();
  } else if (mode === 'unified') {
    dom.tabUnified?.classList.add('active');
    dom.viewWarRoom?.classList.add('active');
    dom.viewGateway?.classList.add('active');
    fetchGatewayStatus();
  }
}

if (dom.tabWarRoom) dom.tabWarRoom.onclick = () => setViewMode('war-room');
if (dom.tabGateway) dom.tabGateway.onclick = () => setViewMode('gateway');
if (dom.tabUnified) dom.tabUnified.onclick = () => setViewMode('unified');

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
      smart: 'Strategy: Smart (Affinity)',
      ordered: 'Strategy: Ordered Waterfall',
      rotate: 'Strategy: Round Robin',
      'least-used': 'Strategy: Least Used'
    };
    dom.topoStrategyDisplay.textContent = stratNames[strategy] || `Strategy: ${strategy}`;
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
    dom.gwCandidateCountText.textContent = `${candidateCount} Node${candidateCount === 1 ? '' : 's'}`;
  }

  // 顶部健康胶囊与标签 Badge
  const allDead = candidateCount > 0 && activeNodes === 0;
  if (dom.gwHealthDot && dom.gwHealthText) {
    if (candidateCount === 0) {
      dom.gwHealthText.textContent = 'STANDBY';
      dom.gwHealthDot.style.background = '#64748b';
      dom.gwHealthDot.style.boxShadow = '0 0 8px #64748b';
    } else if (allDead) {
      dom.gwHealthText.textContent = 'ALL RESTING';
      dom.gwHealthDot.style.background = '#ef4444';
      dom.gwHealthDot.style.boxShadow = '0 0 8px #ef4444';
    } else if (restingNodes > 0) {
      dom.gwHealthText.textContent = 'DEGRADED';
      dom.gwHealthDot.style.background = '#f59e0b';
      dom.gwHealthDot.style.boxShadow = '0 0 8px #f59e0b';
    } else {
      dom.gwHealthText.textContent = 'HEALTHY';
      dom.gwHealthDot.style.background = '#10b981';
      dom.gwHealthDot.style.boxShadow = '0 0 8px #10b981';
    }
  }

  // 3. 渲染拓扑集群通道
  if (dom.topoCandidatesCluster) {
    if (candidates.length === 0) {
      dom.topoCandidatesCluster.innerHTML = `
        <div class="topo-channel-row" style="color: var(--text-faint); font-size: 11px; justify-content: center;">
          No upstream candidates configured.
        </div>
      `;
    } else {
      dom.topoCandidatesCluster.innerHTML = candidates.map((c, idx) => {
        const isResting = !!c.resting;
        const channelClass = isResting ? 'resting' : 'active';
        const statusClass = isResting ? 'cooldown' : 'healthy';
        const statusLabel = isResting
          ? `Cooldown (${c.remainingRestSeconds || 0}s)`
          : `Active (P:${c.priority})`;
        return `
          <div class="topo-channel-row ${channelClass}">
            <span class="topo-channel-name">
              <span>${isResting ? '⚠️' : '⚡'}</span>
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
        <div>No upstream candidates registered in current daemon.</div>
        <div style="margin-top: 8px; font-size: 11px;">💡 点击上方 "✨ 载入演练拓扑 (Demo Mode)" 可即刻体验双通道故障转移与断路器调度！</div>
      </div>
    `;
    return;
  }

  dom.gwCandidatesContainer.innerHTML = candidates.map(c => {
    const isResting = !!c.resting;
    const isDead = c.consecutiveFailures >= 5;
    const cardClass = isDead ? 'dead' : (isResting ? 'resting' : '');
    const badgeClass = isDead ? 'dead' : (isResting ? 'resting' : 'active');
    const badgeText = isDead ? 'DEAD' : (isResting ? 'RESTING' : 'HEALTHY');

    const lastFailureType = c.lastFailureType || 'none';
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
            <span class="cand-stat-label">Priority / Wt</span>
            <span class="cand-stat-val">P${c.priority || 0} / W${c.weight || 1}</span>
          </div>
          <div class="cand-stat-item">
            <span class="cand-stat-label">Success Rate</span>
            <span class="cand-stat-val" style="color: #34d399;">${c.successCount || 0} / ${c.totalRequests || 0}</span>
          </div>
          <div class="cand-stat-item">
            <span class="cand-stat-label">Last Latency</span>
            <span class="cand-stat-val" style="color: #38bdf8;">${c.lastLatencyMs || 0}ms</span>
          </div>
        </div>

        <div class="cand-breaker-box">
          <div class="cand-breaker-row">
            <span style="color: var(--text-faint);">Heuristic Error Type:</span>
            ${lastFailureType !== 'none'
              ? `<span class="cand-error-pill ${pillClass}">${escapeHtml(lastFailureType)}</span>`
              : `<span style="color: var(--text-faint); font-family: var(--font-mono); font-size: 10px;">NONE (0 Faults)</span>`
            }
          </div>

          ${isResting ? `
            <div class="cooldown-wrap">
              <div class="cooldown-meta">
                <span>Circuit Breaker Active</span>
                <span>${remainingSec}s remaining</span>
              </div>
              <div class="cooldown-track">
                <div class="cooldown-progress" style="width: ${progressPct}%;"></div>
              </div>
            </div>
          ` : ''}

          <div class="cand-footer-row">
            <span style="font-size: 10px; color: var(--text-faint); font-family: var(--font-mono);">
              Failures: ${c.failureCount || 0} (Consecutive: ${c.consecutiveFailures || 0})
            </span>
            <button class="cand-unrest-btn" data-unrest-id="${escapeHtml(c.id)}">
              ${isResting ? '⚡ Reset (Unrest)' : 'Reset Stats'}
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
          ⏳ Routing request through Magpie gateway topology with affinityKey="${escapeHtml(currentProjectId)}"...
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
              <span class="probe-res-badge ok">HTTP 200 OK</span>
              <span class="probe-res-meta">Routed to: <strong>backup-deepseek-v3</strong> | Latency: ${latency}ms | Strategy: ${escapeHtml(currentGatewayData.strategy)}</span>
            </div>
            <div class="probe-res-body">[Magpie Resilient Failover Trace]
• Primary "primary-anthropic-claude" was RESTING (429 Rate Limit Cooldown).
• Zero-loss instant fallback engaged ➔ "backup-deepseek-v3" served request.
Response: Successfully processed: "${escapeHtml(text)}"</div>
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
              <span class="probe-res-badge ok">HTTP 200 OK</span>
              <span class="probe-res-meta">Routed to: <strong>${escapeHtml(json.candidateId || 'gateway')}</strong> | Latency: ${latency}ms</span>
            </div>
            <div class="probe-res-body">${escapeHtml(json.content || JSON.stringify(json, null, 2))}</div>
          `;
        }
      } else {
        if (dom.probeOutputContainer) {
          dom.probeOutputContainer.innerHTML = `
            <div class="probe-res-line">
              <span class="probe-res-badge fail">HTTP ${res.status} ERROR</span>
              <span class="probe-res-meta">Time: ${latency}ms</span>
            </div>
            <div class="probe-res-body" style="color: #f87171;">${escapeHtml(json.error || 'All candidate nodes exhausted')}</div>
          `;
        }
      }
      fetchGatewayStatus();
    } catch (err) {
      if (dom.probeOutputContainer) {
        dom.probeOutputContainer.innerHTML = `
          <div class="probe-res-line">
            <span class="probe-res-badge fail">NETWORK ERROR</span>
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
          name: 'Primary Claude 3.7 Sonnet',
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
          lastFailureType: 'rate'
        },
        {
          id: 'backup-deepseek-v3',
          name: 'Backup DeepSeek V3 (Failover)',
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
      dom.candidatesPoolMeta.textContent = 'DEMO TOPOLOGY SIMULATION ACTIVE';
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
loadProjects();
fetchDashboard();
fetchMemories();
fetchDialogues();
fetchGatewayStatus();

// 定时保底轮询（2500ms 刷新频率完全符合 60 FPS 规约）
setInterval(() => {
  fetchDashboard();
  fetchDialogues();
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
