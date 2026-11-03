// =============================================================================
// Agent-Nexus Console Controller
// 只做三件事：把 Hub 上报的事实摆出来、把真实网关健康度摆出来、把操作递回 Hub。
// =============================================================================

function getNexusToken() {
  const fromQuery = new URLSearchParams(location.search).get('token');
  if (fromQuery) {
    try { sessionStorage.setItem('nexusToken', fromQuery); } catch {}
    try { localStorage.setItem('nexusToken', fromQuery); } catch {}
    return fromQuery;
  }
  const stored = sessionStorage.getItem('nexusToken');
  if (stored) return stored;
  if (typeof window !== 'undefined' && window.__NEXUS_TOKEN__) {
    try { sessionStorage.setItem('nexusToken', window.__NEXUS_TOKEN__); } catch {}
    try { localStorage.setItem('nexusToken', window.__NEXUS_TOKEN__); } catch {}
    return window.__NEXUS_TOKEN__;
  }
  try {
    const local = localStorage.getItem('nexusToken');
    if (local) return local;
  } catch {}
  return '';
}

function showTokenPrompt(reason = 'missing') {
  let modal = document.getElementById('nexus-token-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'nexus-token-modal';
    modal.className = 'nexus-modal-overlay';
    modal.innerHTML = `
      <div class="nexus-modal-card">
        <div class="nexus-modal-header">
          <span class="nexus-modal-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <span>访问令牌</span>
          </span>
          <button class="nexus-modal-close" id="nexus-token-close-btn" aria-label="关闭">&times;</button>
        </div>
        <p class="nexus-modal-desc">${reason === 'invalid' ? '令牌无效，请重新输入。' : '需要 Hub 的 Operator Token 才能读取数据。'}</p>
        <div class="nexus-modal-input-row">
          <input type="password" id="nexus-token-input" class="nexus-modal-input" placeholder="粘贴 Token" autocomplete="off" />
          <button id="nexus-token-save-btn" class="nexus-modal-btn primary">连接</button>
        </div>
        <div class="nexus-modal-hint">位于 Hub 的 <code>~/.agent-nexus/session.token</code></div>
      </div>
    `;
    document.body.appendChild(modal);

    const input = modal.querySelector('#nexus-token-input');
    const saveBtn = modal.querySelector('#nexus-token-save-btn');
    const closeBtn = modal.querySelector('#nexus-token-close-btn');

    const handleSave = () => {
      const val = input.value.trim();
      if (!val) return;
      try { sessionStorage.setItem('nexusToken', val); } catch {}
      try { localStorage.setItem('nexusToken', val); } catch {}
      modal.remove();
      initApp();
    };

    saveBtn.addEventListener('click', handleSave);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSave();
    });
    closeBtn.addEventListener('click', () => modal.remove());
  } else {
    const desc = modal.querySelector('.nexus-modal-desc');
    if (desc) {
      desc.textContent = reason === 'invalid'
        ? '令牌无效，请重新输入。'
        : '需要 Hub 的 Operator Token 才能读取数据。';
    }
  }
  const input = modal.querySelector('#nexus-token-input');
  if (input) setTimeout(() => input.focus(), 100);
}

let currentProjectId = 'default';
let currentTimelineFilter = 'all';
let currentDashboardData = null;
let currentTimelineData = [];
const globalProjectsMap = new Map();
let totalGlobalOnlineAgents = 0;

function getProjectDisplayName(projectId, workspaceDir) {
  if (projectId && globalProjectsMap.has(projectId)) {
    return globalProjectsMap.get(projectId).display_name || projectId;
  }
  if (workspaceDir) {
    const clean = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const base = clean.split('/').pop();
    if (base) return base;
  }
  return '';
}

const authHeaders = () => {
  const token = getNexusToken();
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
};

// HTML 安全转义，杜绝存储型与反射型 XSS
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function debounce(fn, delay = 250) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// 机械截断哈希、编号与默认占位符不当作人读名字
function isMechanicalAgentName(name) {
  if (!name || typeof name !== 'string') return true;
  const t = name.trim();
  if (!t) return true;
  if (/^(Claude|Claude\s+Fable|Claude\s+Sonnet|Claude\s+Opus|Agent|Codex|ZCode|System|Nexus)\s*\([a-z0-9_\-]{1,16}\)$/i.test(t)) return true;
  if (/^(claude|agent|codex|zcode|nexus)-[a-z0-9]{4,}/i.test(t)) return true;
  if (/^[a-f0-9]{6,}$/i.test(t)) return true;
  if (/^(claude|agent|codex|zcode)\s*\d+$/i.test(t)) return true;
  if (/^(unknown|agent|default)[-_\s]*(default|\(default\))?$/i.test(t)) return true;
  return false;
}

function formatAgentDisplayName(name, agentId, provider, sessionId, intentSummary = null) {
  if (name && typeof name === 'string' && name.trim()) {
    const trimmed = name.trim();
    if (!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(trimmed) && !/^[?\s.\-=_]+$/.test(trimmed)) {
      if (!isMechanicalAgentName(trimmed)) return trimmed;
    }
  }

  if (intentSummary && typeof intentSummary === 'string' && intentSummary.trim()) {
    const cleanIntent = intentSummary.trim();
    if (!isMechanicalAgentName(cleanIntent) && !/^[?\s.\-=_]+$/.test(cleanIntent)) {
      return cleanIntent.length > 36 ? cleanIntent.slice(0, 36) : cleanIntent;
    }
  }

  const parts = (agentId || '').split('-');
  const prov = (provider || parts[0] || 'agent').toLowerCase();
  const provMap = {
    'claude': 'Claude',
    'claude-fable': 'Claude Fable',
    'claude-sonnet': 'Claude Sonnet',
    'claude-opus': 'Claude Opus',
    'codex': 'Codex',
    'system': 'Nexus',
    'nexus': 'Nexus',
    'agent': '助手'
  };
  return provMap[prov] || (prov.charAt(0).toUpperCase() + prov.slice(1));
}

const globalAgentMap = new Map();

function updateGlobalAgentRegistry(agents = [], claims = [], timeline = []) {
  (agents || []).forEach(a => {
    if (!a || !a.id) return;
    const resolvedName = formatAgentDisplayName(a.name, a.id, a.provider, a.session_id, a.current_intent_summary || a.current_intent);
    globalAgentMap.set(a.id, {
      id: a.id,
      name: a.name || resolvedName,
      displayName: resolvedName,
      provider: a.provider,
      hostId: a.host_id || null,
      isRemote: Boolean(a.is_remote)
    });
  });

  (claims || []).forEach(c => {
    if (!c || !c.agent_id) return;
    const candidateName = c.agent_name || (c.holder_name && !isMechanicalAgentName(c.holder_name) ? c.holder_name : null);
    if (candidateName) {
      const existing = globalAgentMap.get(c.agent_id);
      if (!existing || isMechanicalAgentName(existing.name)) {
        globalAgentMap.set(c.agent_id, {
          id: c.agent_id,
          name: candidateName,
          displayName: formatAgentDisplayName(candidateName, c.agent_id)
        });
      }
    }
  });

  (timeline || []).forEach(t => {
    if (!t || !t.agent_id) return;
    if (t.agent_name && (!globalAgentMap.has(t.agent_id) || isMechanicalAgentName(globalAgentMap.get(t.agent_id).name))) {
      globalAgentMap.set(t.agent_id, {
        id: t.agent_id,
        name: t.agent_name,
        displayName: formatAgentDisplayName(t.agent_name, t.agent_id)
      });
    }
  });
}

function resolveAgentName(agentId, fallbackName = null) {
  if (!agentId || agentId === 'system' || agentId === 'nexus') return 'Nexus';
  if (fallbackName && typeof fallbackName === 'string' && fallbackName.trim()) {
    const clean = fallbackName.trim();
    if (!isMechanicalAgentName(clean)) return clean;
  }
  if (globalAgentMap.has(agentId)) {
    const reg = globalAgentMap.get(agentId);
    if (reg.name && !isMechanicalAgentName(reg.name)) return reg.name;
    if (reg.displayName && !isMechanicalAgentName(reg.displayName)) return reg.displayName;
  }
  return formatAgentDisplayName(fallbackName, agentId);
}

const dom = {
  liveDot: document.getElementById('live-dot'),
  daemonStatus: document.getElementById('daemon-status'),
  projectSelector: document.getElementById('project-selector'),
  themeToggleBtn: document.getElementById('theme-toggle-btn'),
  btnRefresh: document.getElementById('btn-refresh'),

  statWorking: document.getElementById('stat-working'),
  statWaiting: document.getElementById('stat-waiting'),
  statLocks: document.getElementById('stat-locks'),
  statSpawns: document.getElementById('stat-spawns'),
  statSpawnsPill: document.getElementById('stat-spawns-pill'),
  tabSpawnsBadge: document.getElementById('tab-spawns-badge'),
  statGateway: document.getElementById('stat-gateway'),
  gatewayDot: document.getElementById('gateway-dot'),
  statGatewayPill: document.getElementById('stat-gateway-pill'),

  navSegmented: document.getElementById('nav-segmented'),
  segBtns: document.querySelectorAll('.seg-btn'),
  viewPanels: document.querySelectorAll('.view-panel'),

  agentsMeta: document.getElementById('agents-meta'),
  agentsContainer: document.getElementById('agents-container'),
  locksMeta: document.getElementById('locks-meta'),
  locksContainer: document.getElementById('locks-container'),
  conflictAlert: document.getElementById('conflict-alert'),
  timelineContainer: document.getElementById('timeline-container'),
  streamFilterBtns: document.querySelectorAll('.stream-filters .filter-pill'),
  paneLeft: document.getElementById('pane-sessions-left'),
  flexAgents: document.getElementById('section-agents'),
  resizerAgentsLocks: document.getElementById('resizer-agents-locks'),
  resizerSessionsSplit: document.getElementById('resizer-sessions-split'),

  tabRouting: document.getElementById('tab-routing'),
  viewRouting: document.getElementById('view-routing'),
  routingSummaryMeta: document.getElementById('routing-summary-meta'),
  routingCanvasWrapper: document.getElementById('routing-canvas-wrapper'),
  routingSvgLayer: document.getElementById('routing-svg-layer'),
  routingSessionsContainer: document.getElementById('routing-sessions-container'),
  badgeSessionsCount: document.getElementById('badge-sessions-count'),
  nexusHubCard: document.getElementById('nexus-hub-card'),
  hubEndpoint: document.getElementById('hub-endpoint'),
  hubStatusText: document.getElementById('hub-status-text'),
  hubStatusDot: document.getElementById('hub-status-dot'),
  hubCpaDot: document.getElementById('hub-cpa-dot'),
  hubCpaText: document.getElementById('hub-cpa-text'),
  hubCpaIndicator: document.getElementById('hub-cpa-indicator'),
  routingTargetsContainer: document.getElementById('routing-targets-container'),
  badgeTargetsCount: document.getElementById('badge-targets-count'),
  routingDecisionsPanel: document.getElementById('routing-decisions-panel'),
  routingDecisionsStream: document.getElementById('routing-decisions-stream'),
  decisionsCountBadge: document.getElementById('decisions-count-badge'),
  decisionsFilterBtns: document.querySelectorAll('.d-filter-btn'),
  btnToggleDecisions: document.getElementById('btn-toggle-decisions'),
  resizerRoutingDecisions: document.getElementById('resizer-routing-decisions'),

  // CPA 网关卡片
  gatewayCard: document.getElementById('gateway-card'),
  gatewayBadge: document.getElementById('gateway-badge'),
  gatewayEndpoint: document.getElementById('gateway-endpoint'),
  gatewayAccounts: document.getElementById('gateway-accounts'),
  gatewayEnabled: document.getElementById('gateway-enabled'),
  gatewayCooling: document.getElementById('gateway-cooling'),
  gatewayProviders: document.getElementById('gateway-providers'),
  gatewayPeers: document.getElementById('gateway-peers'),
  gatewayNote: document.getElementById('gateway-note'),

  // 子代理派发树
  spawnContainer: document.getElementById('spawn-container'),
  spawnSummary: document.getElementById('spawn-summary'),
  viewAgents: document.getElementById('view-agents'),

  clusterNodesBar: document.getElementById('cluster-nodes-bar'),
  handoffAlertBanner: document.getElementById('handoff-alert-banner'),

  tabMemory: document.getElementById('tab-memory'),
  viewMemory: document.getElementById('view-memory'),
  paneMemoryLeft: document.getElementById('pane-memory-left'),
  paneMemoryRight: document.getElementById('pane-memory-right'),
  handoffsContainer: document.getElementById('handoffs-container'),
  memoriesContainer: document.getElementById('memories-container'),
  resizerMemorySplit: document.getElementById('resizer-memory-split'),
  btnCreateHandoffOpen: document.getElementById('btn-create-handoff-open'),
  btnCreateMemoryOpen: document.getElementById('btn-create-memory-open'),
  modalHandoff: document.getElementById('modal-handoff'),
  modalMemory: document.getElementById('modal-memory'),
  btnModalHandoffClose: document.getElementById('btn-modal-handoff-close'),
  btnModalHandoffCancel: document.getElementById('btn-modal-handoff-cancel'),
  btnModalHandoffSubmit: document.getElementById('btn-modal-handoff-submit'),
  btnModalMemoryClose: document.getElementById('btn-modal-memory-close'),
  btnModalMemoryCancel: document.getElementById('btn-modal-memory-cancel'),
  btnModalMemorySubmit: document.getElementById('btn-modal-memory-submit'),
  memoryCategoryPills: document.querySelectorAll('.memory-filter-pills .filter-pill'),
  memorySearchInput: document.getElementById('memory-search-input')
};

const MEMORY_CATEGORY_LABEL = {
  gotcha: '避坑',
  rule: '规约',
  architecture: '架构',
  milestone: '里程碑',
  general: '常规'
};

// =============================================================================
// 外观
// =============================================================================
function getPreferredTheme() {
  const qTheme = new URLSearchParams(location.search).get('theme');
  if (qTheme === 'dark' || qTheme === 'light') return qTheme;
  const saved = localStorage.getItem('nexusTheme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateThemeUI(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (dom.themeToggleBtn) {
    dom.themeToggleBtn.setAttribute('title', theme === 'dark' ? '切换为亮色' : '切换为暗色');
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || getPreferredTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('nexusTheme', next);
  updateThemeUI(next);
}

if (dom.themeToggleBtn) dom.themeToggleBtn.onclick = toggleTheme;

try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('nexusTheme')) updateThemeUI(e.matches ? 'dark' : 'light');
  });
} catch {}

updateThemeUI(getPreferredTheme());

// =============================================================================
// 视图切换
// =============================================================================
function switchView(viewName) {
  dom.segBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.view === viewName));
  dom.viewPanels.forEach(panel => panel.classList.toggle('active', panel.id === `view-${viewName}`));

  if (viewName === 'routing') {
    fetchRoutingTopology();
    fetchGateway();
    setTimeout(() => requestAnimationFrame(drawRoutingConnectors), 60);
  } else if (viewName === 'agents') {
    fetchDashboard();
  } else if (viewName === 'memory') {
    fetchHandoffs();
    fetchMemories();
  } else {
    fetchDashboard();
  }
}
window.switchView = switchView;

function switchToSpawnsView(sessionId) {
  switchView('agents');
  if (sessionId) {
    setTimeout(() => {
      const el = document.querySelector(`[data-session="${CSS.escape(sessionId)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('highlight-target');
        setTimeout(() => el.classList.remove('highlight-target'), 2500);
      }
    }, 80);
  }
}
window.switchToSpawnsView = switchToSpawnsView;

dom.segBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    if (view) switchView(view);
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (dom.modalHandoff) dom.modalHandoff.setAttribute('hidden', '');
    if (dom.modalMemory) dom.modalMemory.setAttribute('hidden', '');
    document.getElementById('nexus-token-modal')?.remove();
  }
});

if (dom.btnRefresh) {
  dom.btnRefresh.onclick = () => {
    loadProjects();
    fetchDashboard();
    fetchGateway({ refresh: true });
    if (dom.viewRouting?.classList.contains('active')) fetchRoutingTopology();
    if (dom.viewMemory?.classList.contains('active')) {
      fetchHandoffs();
      fetchMemories(dom.memorySearchInput?.value || '', currentMemoryCategory);
    }
  };
}

// =============================================================================
// 工程选择
// =============================================================================
function selectProject(projectId) {
  currentProjectId = projectId;
  localStorage.setItem('nexusProjectId', currentProjectId);
  if (dom.projectSelector) dom.projectSelector.value = currentProjectId;
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    try { activeWs.send(JSON.stringify({ type: 'sync:request', project_id: currentProjectId })); } catch {}
  }
  fetchDashboard();
  if (dom.viewRouting?.classList.contains('active')) fetchRoutingTopology();
  if (dom.viewMemory?.classList.contains('active')) {
    fetchHandoffs();
    fetchMemories(dom.memorySearchInput?.value || '', currentMemoryCategory);
  }
}
window.nexusSelectProject = selectProject;

let loadProjectsTimer = null;
function debouncedLoadProjects() {
  if (loadProjectsTimer) return;
  loadProjectsTimer = setTimeout(() => {
    loadProjectsTimer = null;
    loadProjects();
  }, 500);
}

if (dom.projectSelector) {
  dom.projectSelector.onchange = () => selectProject(dom.projectSelector.value);
}

async function loadProjects() {
  try {
    const res = await fetch('/api/projects', { headers: authHeaders() });
    if (res.status === 401) {
      updateConnectionIndicators(false, '令牌无效');
      showTokenPrompt('invalid');
      return;
    }
    if (!res.ok) return;
    const list = await res.json();
    if (!list || list.length === 0 || !dom.projectSelector) return;

    const validProjects = list.filter(p => p && p.id && p.id !== 'all' && p.id !== '');
    const seen = new Set();
    const uniqueProjects = [];
    for (const p of validProjects) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        uniqueProjects.push(p);
      }
    }

    globalProjectsMap.clear();
    for (const p of uniqueProjects) globalProjectsMap.set(p.id, p);
    totalGlobalOnlineAgents = uniqueProjects.reduce((sum, p) => sum + (p.online_agents_count || 0), 0);

    const qProject = new URLSearchParams(location.search).get('project') || new URLSearchParams(location.search).get('project_id');
    const savedProjectId = qProject || localStorage.getItem('nexusProjectId');

    let effectiveSavedId = savedProjectId;
    if (effectiveSavedId === 'Agent-Nexus') {
      const realNexus = uniqueProjects.find(p => p.display_name === 'Agent-Nexus' || p.id === 'b7e6c7a3e3b4182e');
      if (realNexus) effectiveSavedId = realNexus.id;
    }

    let targetProject = null;
    if (qProject) {
      targetProject = qProject === 'all' ? { id: 'all' } : uniqueProjects.find(p => p.id === qProject);
    } else if (effectiveSavedId === 'all') {
      targetProject = { id: 'all' };
    } else if (effectiveSavedId) {
      targetProject = uniqueProjects.find(p => p.id === effectiveSavedId) || null;
    }
    if (!targetProject) targetProject = { id: 'all' };

    currentProjectId = targetProject.id;
    localStorage.setItem('nexusProjectId', currentProjectId);
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      try { activeWs.send(JSON.stringify({ type: 'sync:request', project_id: currentProjectId })); } catch {}
    }

    const allOption = `<option value="all" ${currentProjectId === 'all' ? 'selected' : ''}>全部工程</option>`;
    const projectOptions = uniqueProjects.map(p => {
      const idSafe = escapeHtml(p.id);
      const nameSafe = escapeHtml(p.display_name || p.id);
      const selected = (p.id === currentProjectId && currentProjectId !== 'all') ? 'selected' : '';
      return `<option value="${idSafe}" ${selected}>${nameSafe}</option>`;
    }).join('');

    dom.projectSelector.innerHTML = allOption + projectOptions;

    fetchDashboard();
    if (dom.viewRouting?.classList.contains('active')) fetchRoutingTopology();
    if (dom.viewMemory?.classList.contains('active')) {
      fetchHandoffs();
      fetchMemories(dom.memorySearchInput?.value || '', currentMemoryCategory);
    }
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
}

// =============================================================================
// 面板数据
// =============================================================================
async function fetchDashboard() {
  try {
    const res = await fetch(`/api/dashboard?project_id=${encodeURIComponent(currentProjectId)}`, { headers: authHeaders() });
    if (res.status === 401) {
      updateConnectionIndicators(false, '令牌无效');
      showTokenPrompt('invalid');
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    currentDashboardData = data;
    renderDashboardSnapshot(data);
  } catch (err) {
    console.error('Fetch dashboard error:', err);
  }
}

function renderDashboardSnapshot(data) {
  if (!data) return;
  const agents = data.agents || [];
  const activeClaims = data.activeClaims || [];
  const timeline = data.timeline || [];

  updateGlobalAgentRegistry(agents, activeClaims, timeline);
  currentTimelineData = timeline;

  // 统计与列表共用同一份视图模型，避免"数量对不上"的假象。
  const agentViews = buildAgentViews(agents, activeClaims);
  const workingCount = agentViews.filter(a => a.uiState === 'working').length;
  const waitingCount = agentViews.filter(a => a.uiState === 'waiting').length;

  const allSpawnNodes = (data.agentSpawns || []).flatMap(t => (Array.isArray(t.roots) ? t.roots : []));
  const totalSpawns = countSpawnNodes(allSpawnNodes, () => true);

  if (dom.statWorking) dom.statWorking.textContent = workingCount;
  if (dom.statWaiting) dom.statWaiting.textContent = waitingCount;
  if (dom.statLocks) dom.statLocks.textContent = activeClaims.length;
  if (dom.statSpawns) dom.statSpawns.textContent = totalSpawns;
  if (dom.tabSpawnsBadge) {
    if (totalSpawns > 0) {
      dom.tabSpawnsBadge.textContent = totalSpawns;
      dom.tabSpawnsBadge.style.display = 'inline-flex';
    } else {
      dom.tabSpawnsBadge.style.display = 'none';
    }
  }

  renderAgentSpawns(data.agentSpawns || []);
  renderActiveAgents(agentViews);
  renderActiveLocks(activeClaims, agents);
  renderLiveTimeline(timeline);

  if (data.clusterNodes) renderClusterNodes(data.clusterNodes);
  renderHandoffAlertBanner(data.activeHandoffs || []);
}

// 在席会话的唯一判定入口：列表、统计、路由三处都走这里。
function buildAgentViews(agents, claims) {
  const claimsList = claims || [];
  const views = [];
  for (const a of (agents || [])) {
    if (a.lifecycle_state === 'departed' || a.is_online === false) continue;
    const owned = claimsList.filter(c => c.agent_id === a.id);
    const isWorking = a.lifecycle_state === 'working' || a.status === 'running' || owned.length > 0;
    const isWaiting = !isWorking && (a.lifecycle_state === 'waiting' || a.status === 'waiting' || !!a.blocked_reason);
    const uiState = isWorking ? 'working' : (isWaiting ? 'waiting' : 'idle');
    const badgeText = uiState === 'working' ? '修改中' : (uiState === 'waiting' ? '排队' : '待命');
    views.push({ ...a, resolvedClaims: owned, uiState, badgeText });
  }
  return views;
}

function makeEmptyHint(iconType, text, subtext = '') {
  let glyph = '';
  if (iconType === 'agent') {
    glyph = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18"/></svg>';
  } else if (iconType === 'lock') {
    glyph = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  } else if (iconType === 'stream') {
    glyph = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';
  } else if (iconType === 'handoff') {
    glyph = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/><path d="M12 13v2"/></svg>';
  } else if (iconType === 'memory') {
    glyph = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
  } else if (iconType === 'spawn') {
    glyph = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="5" rx="1.5"/><rect x="2" y="17" width="6" height="5" rx="1.5"/><rect x="16" y="17" width="6" height="5" rx="1.5"/><path d="M12 7v4M5 17v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"/></svg>';
  }
  return `
    <div class="empty-hint">
      <div class="empty-hint-icon">${glyph}</div>
      <div class="empty-hint-text">${escapeHtml(text)}</div>
      ${subtext ? `<div class="empty-hint-sub">${escapeHtml(subtext)}</div>` : ''}
    </div>
  `;
}

let lastAgentsHtml = null;
let lastAgentsMetaHtml = null;

function renderActiveAgents(validAgents) {
  if (!dom.agentsContainer) return;

  if (dom.agentsMeta) {
    const remoteOnlineCount = validAgents.filter(a => a.is_remote).length;
    const metaHtml = remoteOnlineCount > 0
      ? `${validAgents.length} 个 · 远端 ${remoteOnlineCount}`
      : `${validAgents.length} 个`;
    if (metaHtml !== lastAgentsMetaHtml) {
      dom.agentsMeta.textContent = metaHtml;
      lastAgentsMetaHtml = metaHtml;
    }
  }

  if (validAgents.length === 0) {
    const emptyHtml = makeEmptyHint('agent', '尚无活跃会话', '运行中的 Claude 会话将自动接入中枢');
    if (emptyHtml !== lastAgentsHtml) {
      dom.agentsContainer.innerHTML = emptyHtml;
      lastAgentsHtml = emptyHtml;
    }
    return;
  }

  const agentsHtml = validAgents.map(a => {
    const displayName = formatAgentDisplayName(a.name, a.id, a.provider, a.session_id, a.current_intent || a.current_intent_summary);
    const nameSafe = escapeHtml(displayName);
    const providerSafe = escapeHtml(a.provider || 'Claude');
    const intentRaw = a.current_intent || a.current_action || '';
    // 状态已经在徽章里说过了，就别在下一行再重复一遍。
    const intentSafe = escapeHtml(intentRaw === a.badgeText ? '' : intentRaw);
    const toolSafe = a.last_tool ? escapeHtml(a.last_tool) : null;
    const targetSafe = a.last_target ? escapeHtml(a.last_target.split(/[\/\\]/).pop()) : null;
    const claims = a.resolvedClaims || [];
    const projName = getProjectDisplayName(a.project_id, a.workspace_dir);
    const projSafe = escapeHtml(projName);
    const showProj = (currentProjectId === 'all' || !currentProjectId) && projSafe;
    const hostSafe = a.is_remote && a.host_id ? escapeHtml(a.host_id) : '';
    const showHost = Boolean(hostSafe) && (!showProj || !projName.includes(`[${a.host_id}]`));
    const spawnTree = (currentAgentSpawns || []).find(t => t.session_id === a.id || t.agent_id === a.id || t.session_name === a.name);
    const spawnCount = spawnTree && Array.isArray(spawnTree.roots) ? countSpawnNodes(spawnTree.roots, () => true) : 0;
    const spawnBtn = spawnCount > 0 ? `
      <button class="agent-spawns-link-btn" onclick="switchToSpawnsView('${escapeHtml(spawnTree.session_id || a.id)}')" title="查看该会话的子代理派发树">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="2" width="6" height="5" rx="1.5"></rect>
          <rect x="2" y="17" width="6" height="5" rx="1.5"></rect>
          <rect x="16" y="17" width="6" height="5" rx="1.5"></rect>
          <path d="M12 7v4M5 17v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"></path>
        </svg>
        <span>派发树 ${spawnCount}</span>
      </button>
    ` : '';

    return `
      <div class="agent-card-item is-${a.uiState}">
        <div class="agent-card-header">
          <div class="agent-name-group">
            <span class="agent-status-badge badge-${a.uiState}"><i class="status-badge-dot"></i>${a.badgeText}</span>
            <span class="agent-title" title="${nameSafe}">${nameSafe}</span>
            ${showHost ? `<span class="agent-host-badge" title="节点 ${hostSafe}">${hostSafe}</span>` : ''}
            ${showProj ? `<span class="agent-project-badge" title="工程 ${projSafe}">${projSafe}</span>` : ''}
            ${spawnBtn}
          </div>
          <span class="agent-runtime-tag">${providerSafe}</span>
        </div>

        ${toolSafe || intentSafe ? `
          <div class="agent-intent-line" title="${intentSafe || toolSafe}">
            ${toolSafe ? `<span class="agent-claim-target">${toolSafe}${targetSafe ? ' ' + targetSafe : ''}</span>` : ''}
            ${toolSafe && intentSafe ? ' ' : ''}${intentSafe}
          </div>
        ` : ''}

        ${claims.length > 0 ? `
          <div class="agent-card-footer">
            锁定 ${claims.length} 项：${claims.map(c => escapeHtml(c.claim_target.split(/[\/\\]/).pop())).join('，')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  if (agentsHtml !== lastAgentsHtml) {
    dom.agentsContainer.innerHTML = agentsHtml;
    lastAgentsHtml = agentsHtml;
  }
}

function renderActiveLocks(claims, agents) {
  if (!dom.locksContainer) return;

  if (dom.locksMeta) dom.locksMeta.textContent = `${(claims || []).length} 项`;

  const waitingAgents = (agents || []).filter(a => a.lifecycle_state === 'waiting' || a.status === 'waiting' || !!a.blocked_reason);
  if (dom.conflictAlert) {
    if (waitingAgents.length > 0) {
      dom.conflictAlert.style.display = 'flex';
      const waiter = waitingAgents[0];
      const waiterName = escapeHtml(formatAgentDisplayName(waiter.name, waiter.id));
      const reason = escapeHtml(waiter.blocked_reason || '等待文件解锁');
      dom.conflictAlert.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <span><strong>${waiterName}</strong> 等待中：${reason}</span>
      `;
    } else {
      dom.conflictAlert.style.display = 'none';
    }
  }

  if (!claims || claims.length === 0) {
    dom.locksContainer.innerHTML = makeEmptyHint('lock', '当前没有生效的文件锁', '会话编辑代码时自动独占锁定');
    return;
  }

  const now = Date.now();
  dom.locksContainer.innerHTML = claims.map(c => {
    const holder = (agents || []).find(a => a.id === c.agent_id) || globalAgentMap.get(c.agent_id);
    const resolvedHolder = resolveAgentName(c.agent_id, c.agent_name || holder?.name);
    const holderName = escapeHtml(resolvedHolder);
    const holderHost = (holder?.is_remote || holder?.isRemote) ? escapeHtml(holder.host_id || holder.hostId || '') : '';
    const shortTarget = escapeHtml(c.claim_target.split(/[\/\\]/).pop());
    const fullTarget = escapeHtml(c.claim_target);
    const remainingSec = Math.max(0, Math.ceil((c.expires_at - now) / 1000));
    const leaseId = escapeHtml(c.lease_id || '');

    return `
      <div class="lock-card-item">
        <div class="lock-target-info">
          <span class="lock-target-name" title="${fullTarget}">${shortTarget}</span>
          <span class="lock-holder-desc"><span class="holder-name" title="${escapeHtml(c.agent_id)}">${holderName}</span>${holderHost ? ` · ${holderHost}` : ''} · ${remainingSec}s</span>
        </div>
        <div class="lock-actions">
          ${leaseId ? `<button class="btn-release-sm" onclick="releaseLock('${leaseId}', '${escapeHtml(c.agent_id)}')">释放</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

window.releaseLock = async function(leaseId, agentId) {
  try {
    const res = await fetch(`/api/leases/${encodeURIComponent(leaseId)}/release`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent_id: agentId })
    });
    if (res.ok) fetchDashboard();
  } catch (err) {
    console.error('Failed to release lock:', err);
  }
};

function renderLiveTimeline(timeline) {
  if (!dom.timelineContainer) return;

  let filtered = timeline || [];
  if (currentTimelineFilter === 'conflict') {
    filtered = filtered.filter(item => item.event_type && (item.event_type.includes('blocked') || item.event_type.includes('waiting') || item.event_type.includes('conflict')));
  } else if (currentTimelineFilter === 'release') {
    filtered = filtered.filter(item => item.event_type && (item.event_type.includes('release') || item.event_type.includes('freed')));
  }

  if (filtered.length === 0) {
    dom.timelineContainer.innerHTML = makeEmptyHint('stream', '暂无协同事件', '冲突拦截与文件解锁流水将在此实时展现');
    return;
  }

  dom.timelineContainer.innerHTML = filtered.map(item => {
    const timeStr = escapeHtml(new Date(item.created_at).toTimeString().split(' ')[0]);
    let badgeClass = 'badge-grant';
    let badgeLabel = '锁定';

    const evt = item.event_type || '';
    if (evt.includes('blocked') || evt.includes('conflict') || evt.includes('waiting')) {
      badgeClass = 'badge-intercept';
      badgeLabel = '拦截';
    } else if (evt.includes('release') || evt.includes('freed')) {
      badgeClass = 'badge-release';
      badgeLabel = '解锁';
    } else if (evt.includes('handoff')) {
      badgeClass = '';
      badgeLabel = '接力';
    }

    const actor = escapeHtml(formatAgentDisplayName(item.agent_name, item.agent_id));
    let rawDesc = item.description || '';
    if (item.agent_name && rawDesc.endsWith(': ' + item.agent_name)) {
      rawDesc = rawDesc.slice(0, rawDesc.length - (item.agent_name.length + 2));
    } else if (actor && rawDesc.endsWith(': ' + actor)) {
      rawDesc = rawDesc.slice(0, rawDesc.length - (actor.length + 2));
    }
    const desc = escapeHtml(rawDesc);

    return `
      <div class="stream-item">
        <div class="stream-item-top">
          <span class="stream-badge ${badgeClass}">${badgeLabel}</span>
          <span class="stream-time">${timeStr}</span>
        </div>
        <div class="stream-item-desc"><strong>${actor}</strong> ${desc}</div>
      </div>
    `;
  }).join('');
}

dom.streamFilterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    dom.streamFilterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTimelineFilter = btn.dataset.filter || 'all';
    renderLiveTimeline(currentTimelineData);
  });
});

// =============================================================================
// 子代理派发树
//
// 树上的每一项都来自后端的真实派发记录（SubagentStart / SubagentStop）。
// 状态只有三种，全部有据可查：
//   running —— 收到了开始事件，还没收到结束事件
//   done    —— 收到了结束事件
//   lost    —— 开始后长时间无活动，由后端收敛（界面照实说"失联"）
// 不显示成本、不猜成功失败：我们没有这些数据。
// =============================================================================
let currentAgentSpawns = [];
// 已经绘制过的节点 id。看板每次轮询都会重渲染整棵树，
// 只有真的新出现的节点才播入场动画，否则面板每隔几秒闪一次。
let seenSpawnIds = new Set();

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const restMin = min % 60;
  return restMin ? `${hr}h ${restMin}m` : `${hr}h`;
}

function spawnStatusLabel(status) {
  if (status === 'done') return '已完成';
  if (status === 'lost') return '失联';
  return '运行中';
}

const AGENT_TYPE_ICON = {
  Explore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>',
  Plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1z"></path><rect x="4" y="5" width="16" height="16" rx="2"></rect><path d="M8 11h8M8 15h5"></path></svg>',
  'general-purpose': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 8v4l3 2"></path></svg>',
  default: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 7.5 12 12l9-4.5L12 3z"></path><path d="M3 16.5 12 21l9-4.5"></path></svg>'
};

function agentTypeIcon(agentType) {
  return AGENT_TYPE_ICON[agentType] || AGENT_TYPE_ICON.default;
}

function toolIcon(tool) {
  const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  switch (tool) {
    case 'Read': return `<svg ${common} aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"></path><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"></path></svg>`;
    case 'Grep': return `<svg ${common} aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="m20 20-4-4"></path></svg>`;
    case 'Glob': return `<svg ${common} aria-hidden="true"><path d="M3 7h6l2 2h10v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"></path></svg>`;
    case 'Bash': return `<svg ${common} aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="m7 9 3 3-3 3M13 15h4"></path></svg>`;
    case 'Edit': case 'Write': case 'MultiEdit': return `<svg ${common} aria-hidden="true"><path d="M4 20h4l10-10a2.8 2.8 0 1 0-4-4L4 16z"></path></svg>`;
    case 'WebFetch': case 'WebSearch': return `<svg ${common} aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M4 12h16M12 4a14 14 0 0 1 0 16 14 14 0 0 1 0-16z"></path></svg>`;
    default: return `<svg ${common} aria-hidden="true"><path d="M14.5 5.5 18.5 9.5 8 20H4v-4z"></path></svg>`;
  }
}

function renderSpawnNode(node, depth, freshIds) {
  const status = node.status || 'running';
  const duration = formatDuration(node.duration_ms);
  const typeLabel = node.agent_type ? escapeHtml(node.agent_type) : '未知类型';
  const modelLabel = node.model ? escapeHtml(node.model) : null;
  const isFresh = freshIds.has(node.id);

  const taskLine = node.description
    ? escapeHtml(node.description)
    : '<span class="spawn-task-missing">未记录任务描述</span>';

  const toolChip = node.last_tool
    ? `<span class="spawn-tool" title="${escapeHtml(node.last_action || node.last_tool)}">${toolIcon(node.last_tool)}${escapeHtml(node.last_tool)}</span>`
    : '';

  const bgChip = node.run_in_background ? '<span class="spawn-flag">后台</span>' : '';

  const childHtml = Array.isArray(node.children) && node.children.length
    ? `<div class="spawn-children">${node.children.map(c => renderSpawnNode(c, depth + 1, freshIds)).join('')}</div>`
    : '';

  return `
    <div class="spawn-node${isFresh ? ' is-fresh' : ''}" data-status="${status}" data-depth="${depth}" data-node-id="${escapeHtml(node.id)}">
      <div class="spawn-elbow" aria-hidden="true"><i class="spawn-joint"></i></div>
      <div class="spawn-card">
        <div class="spawn-card-top">
          <span class="spawn-icon">${agentTypeIcon(node.agent_type)}</span>
          <span class="spawn-type">${typeLabel}</span>
          ${modelLabel ? `<span class="spawn-model">${modelLabel}</span>` : ''}
          ${bgChip}
          <span class="spawn-spacer"></span>
          <span class="spawn-status" data-status="${status}">
            <i class="spawn-status-dot"></i>${spawnStatusLabel(status)}
          </span>
        </div>
        <div class="spawn-task">${taskLine}</div>
        <div class="spawn-card-bottom">
          ${toolChip}
          <span class="spawn-duration" title="${node.started_at ? new Date(node.started_at).toLocaleString() : ''}">${duration}</span>
        </div>
      </div>
      ${childHtml}
    </div>
  `;
}

function countSpawnNodes(nodes, predicate) {
  let n = 0;
  const walk = (list) => {
    for (const node of (list || [])) {
      if (predicate(node)) n++;
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return n;
}

function renderAgentSpawns(trees) {
  if (!dom.spawnContainer) return;
  currentAgentSpawns = Array.isArray(trees) ? trees : [];

  // 统计必须数子代理节点本身，不是数树。每棵树的根在 roots 里，status 只在节点上。
  const allNodes = currentAgentSpawns.flatMap(t => (Array.isArray(t.roots) ? t.roots : []));
  const running = countSpawnNodes(allNodes, n => n.status === 'running');
  const done = countSpawnNodes(allNodes, n => n.status === 'done');
  const lost = countSpawnNodes(allNodes, n => n.status === 'lost');

  if (dom.spawnSummary) {
    const total = running + done + lost;
    dom.spawnSummary.textContent = total === 0
      ? '暂无记录'
      : `${total} 个 · 运行中 ${running} · 完成 ${done}${lost ? ` · 失联 ${lost}` : ''}`;
  }

  if (currentAgentSpawns.length === 0) {
    dom.spawnContainer.innerHTML = makeEmptyHint('spawn', '暂无子代理派发记录', 'SubagentStart / SubagentStop 触发时在此自动构建派发树');
    seenSpawnIds = new Set();
    return;
  }

  // 只给这一轮真正新增的节点播入场动画。
  const allIds = new Set();
  const collectIds = (list) => {
    for (const n of (list || [])) {
      allIds.add(n.id);
      if (n.children) collectIds(n.children);
    }
  };
  currentAgentSpawns.forEach(t => collectIds(t.roots));
  const freshIds = new Set([...allIds].filter(id => !seenSpawnIds.has(id)));
  seenSpawnIds = allIds;

  dom.spawnContainer.innerHTML = currentAgentSpawns.map((tree) => {
    const sessionKey = String(tree.session_id || '');
    const cleanSessionDisplay = sessionKey.length <= 28
      ? sessionKey
      : (sessionKey.startsWith('claude-') ? sessionKey.replace('claude-', '').slice(0, 12) : sessionKey.slice(0, 16));
    const sessionName = tree.session_name
      ? tree.session_name
      : (tree.agent_id ? resolveAgentName(tree.agent_id, null) : `会话 ${cleanSessionDisplay}`);
    const roots = Array.isArray(tree.roots) ? tree.roots : [];
    const rootCount = countSpawnNodes(roots, () => true);
    const liveTag = tree.is_live ? '' : '<span class="spawn-session-flag">会话已离席</span>';
    const hostTag = tree.host_id && tree.host_id !== 'local' ? `<span class="spawn-session-host">${escapeHtml(tree.host_id)}</span>` : '';

    return `
      <article class="spawn-tree" data-session="${escapeHtml(sessionKey)}">
        <header class="spawn-session">
          <span class="spawn-session-name" title="${escapeHtml(sessionKey)}">${escapeHtml(sessionName)}</span>
          ${hostTag}
          ${liveTag}
          <span class="spawn-spacer"></span>
          <span class="spawn-session-count">${rootCount} 个子代理</span>
        </header>
        <div class="spawn-roots">
          ${roots.map(r => renderSpawnNode(r, 1, freshIds)).join('')}
        </div>
      </article>
    `;
  }).join('');
}

// =============================================================================
// CPA 网关（只读观测）
// 面板只展示 Hub 与各节点探针实际观测到的事实，Nexus 不参与模型流量转发。
// =============================================================================
let currentGatewayStatus = null;

async function fetchGateway({ refresh = false } = {}) {
  try {
    const url = refresh ? '/api/gateway?refresh=1' : '/api/gateway';
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    const status = await res.json();
    currentGatewayStatus = status;
    renderGateway(status);
  } catch (err) {
    console.error('Fetch gateway error:', err);
  }
}

function gatewayAccountLabel(status) {
  if (!status || !status.reachable) return null;
  if (status.unauthorized) return null;
  const auth = status.auth || null;
  if (!auth) return null;
  return `${auth.enabledAccounts}/${auth.totalAccounts}`;
}

function updateHubCpaDisplay(status) {
  if (!dom.hubCpaText) return;
  const reachable = Boolean(status?.reachable);
  const unauthorized = Boolean(status?.unauthorized);
  const auth = status?.auth || null;
  const peers = Array.isArray(status?.peers) ? status.peers : [];
  const peersUp = peers.filter(p => p.gateway?.reachable && !p.gateway?.unauthorized && p.gateway?.enabledAccounts != null);

  if (reachable && !unauthorized && auth) {
    const topP = auth.providers?.[0] ? ` · ${auth.providers[0].name}` : '';
    dom.hubCpaText.textContent = `CPA 算力: ${auth.enabledAccounts}/${auth.totalAccounts} 账号可用${topP}`;
    dom.hubCpaDot?.classList.remove('dot-offline', 'dot-warning');
    dom.hubCpaDot?.classList.add('dot-online');
    if (dom.hubCpaIndicator) {
      dom.hubCpaIndicator.title = `CPA 接口: ${status.baseUrl}\n可用: ${auth.enabledAccounts}/${auth.totalAccounts} | 冷却: ${auth.coolingAccounts || 0}\n近期请求: ${auth.recentRequests?.success || 0} 成功 / ${auth.recentRequests?.failed || 0} 失败`;
    }
  } else if (peersUp.length > 0) {
    dom.hubCpaText.textContent = `CPA 算力: 远端 ${peersUp.length} 节点在线`;
    dom.hubCpaDot?.classList.remove('dot-offline', 'dot-warning');
    dom.hubCpaDot?.classList.add('dot-online');
    if (dom.hubCpaIndicator) {
      dom.hubCpaIndicator.title = `远端 ${peersUp.length} 个节点运行 CPA 算力网关`;
    }
  } else if (reachable && unauthorized) {
    dom.hubCpaText.textContent = 'CPA 算力: 鉴权失败';
    dom.hubCpaDot?.classList.remove('dot-online');
    dom.hubCpaDot?.classList.add('dot-warning');
  } else {
    dom.hubCpaText.textContent = 'CPA 算力: 未检测到网关';
    dom.hubCpaDot?.classList.remove('dot-online');
    dom.hubCpaDot?.classList.add('dot-offline');
  }
}

function renderGateway(status) {
  const reachable = Boolean(status?.reachable);
  const unauthorized = Boolean(status?.unauthorized);
  const auth = status?.auth || null;
  const peers = Array.isArray(status?.peers) ? status.peers : [];
  const peersUp = peers.filter(p => p.gateway?.reachable && !p.gateway?.unauthorized && p.gateway?.enabledAccounts != null);

  if (dom.statGatewayPill) {
    dom.statGatewayPill.classList.toggle('is-up', reachable && !unauthorized && Boolean(auth));
    dom.statGatewayPill.classList.toggle('is-unauthorized', reachable && unauthorized);
    dom.statGatewayPill.classList.toggle('is-down', !reachable && peersUp.length === 0);
    const titleParts = [`本机 ${reachable ? (unauthorized ? '鉴权失败' : status.baseUrl) : '未发现 CPA'}`];
    for (const p of peers) {
      titleParts.push(`${p.display_name}：${!p.gateway ? '无上报' : p.gateway.reachable ? (p.gateway.unauthorized ? '鉴权失败' : `可用 ${p.gateway.enabledAccounts}/${p.gateway.totalAccounts}`) : '未发现 CPA'}`);
    }
    dom.statGatewayPill.title = titleParts.join('\n');
  }
  if (dom.statGateway) {
    if (reachable && !unauthorized && auth) {
      dom.statGateway.textContent = `${auth.enabledAccounts}/${auth.totalAccounts}`;
    } else if (peersUp.length > 0) {
      dom.statGateway.textContent = `远端 ${peersUp.length}`;
    } else if (reachable && unauthorized) {
      dom.statGateway.textContent = '鉴权';
    } else {
      dom.statGateway.textContent = '离线';
    }
  }

  if (!dom.gatewayCard) return;

  if (dom.gatewayBadge) dom.gatewayBadge.textContent = !reachable ? '本机离线' : (unauthorized ? '鉴权失败' : '在线');
  if (dom.gatewayEndpoint) {
    dom.gatewayEndpoint.textContent = status?.baseUrl || '—';
    dom.gatewayEndpoint.title = status?.baseUrl || '';
  }

  if (!reachable || unauthorized || !auth) {
    if (dom.gatewayAccounts) dom.gatewayAccounts.textContent = '—';
    if (dom.gatewayEnabled) dom.gatewayEnabled.textContent = '—';
    if (dom.gatewayCooling) dom.gatewayCooling.textContent = '—';
    if (dom.gatewayProviders) dom.gatewayProviders.innerHTML = '';
  } else {
    if (dom.gatewayAccounts) dom.gatewayAccounts.textContent = auth.totalAccounts;
    if (dom.gatewayEnabled) dom.gatewayEnabled.textContent = auth.enabledAccounts;
    if (dom.gatewayCooling) dom.gatewayCooling.textContent = auth.coolingAccounts;
    if (dom.gatewayProviders) {
      dom.gatewayProviders.innerHTML = (auth.providers || []).map(p => `
        <span class="gateway-provider">${escapeHtml(p.name)}<b>${p.count}</b></span>
      `).join('');
    }
  }

  if (dom.gatewayPeers) {
    dom.gatewayPeers.innerHTML = peers.length === 0 ? '' : peers.map(p => {
      const gw = p.gateway;
      const dot = !gw ? 'offline' : gw.unauthorized ? 'stale' : (gw.reachable ? 'online' : 'offline');
      const value = !gw
        ? '无上报'
        : gw.unauthorized
          ? '鉴权失败'
          : gw.reachable
            ? `${gw.enabledAccounts}/${gw.totalAccounts}`
            : '未发现 CPA';
      return `
        <div class="gateway-peer" title="${escapeHtml(p.display_name)} · ${escapeHtml(p.status || '')}">
          <span class="node-status-dot ${dot}"></span>
          <span class="gateway-peer-name">${escapeHtml(p.display_name)}</span>
          <span class="gateway-peer-value">${escapeHtml(value)}</span>
        </div>
      `;
    }).join('');
  }

  if (dom.gatewayNote) {
    const success = auth?.recentRequests?.success ?? 0;
    const failed = auth?.recentRequests?.failed ?? 0;
    const observed = status.observedAt ? new Date(status.observedAt).toLocaleTimeString() : '';

    if (!reachable && peersUp.length > 0) {
      dom.gatewayNote.textContent = `本机未发现 CPA；${peersUp.length} 个节点可观测到网关`;
    } else if (!reachable) {
      dom.gatewayNote.textContent = '本机未发现 CPA，探针也未上报网关';
    } else if (unauthorized) {
      dom.gatewayNote.textContent = '管理接口拒绝鉴权，请配置 NEXUS_CPA_MGMT_SECRET';
    } else if (success + failed > 0) {
      dom.gatewayNote.textContent = `近期请求 ${success} 成功 / ${failed} 失败 · ${observed}`;
    } else {
      dom.gatewayNote.textContent = `近期无请求记录 · ${observed}`;
    }
  }

  updateHubCpaDisplay(status);
  if (lastClusterNodes && dom.clusterNodesBar) {
    renderClusterNodes(lastClusterNodes);
  }
}

// =============================================================================
// 集群节点
// =============================================================================
let lastClusterNodes = null;

function renderClusterNodes(nodes) {
  if (!dom.clusterNodesBar) return;
  lastClusterNodes = nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    dom.clusterNodesBar.innerHTML = '';
    return;
  }

  dom.clusterNodesBar.innerHTML = nodes.map(node => {
    const isOnline = node.status === 'online';
    const isStale = node.status === 'stale';
    const statusClass = isOnline ? 'online' : (isStale ? 'stale' : 'offline');
    const isHub = node.role === 'hub';
    const nameSafe = escapeHtml(node.display_name || node.id);
    const roleSafe = isHub ? 'Hub' : 'Edge';
    const timeDiff = Math.max(0, Math.round((Date.now() - (node.last_heartbeat || Date.now())) / 1000));

    const gw = node.metadata?.gateway || (isHub && currentGatewayStatus?.reachable && currentGatewayStatus.auth ? currentGatewayStatus.auth : null);
    let gwText = '';
    if (gw && gw.reachable !== false && !gw.unauthorized && gw.enabledAccounts != null) {
      gwText = `<span class="node-chip-gw" title="该节点 CPA 账号池">${gw.enabledAccounts}/${gw.totalAccounts}</span>`;
    }

    return `
      <div class="node-chip ${statusClass}" title="节点 ${escapeHtml(node.id)} · ${escapeHtml(node.platform || 'node')} · 心跳 ${timeDiff}s 前">
        <span class="node-status-dot"></span>
        <span class="node-chip-name">${nameSafe}</span>
        <span class="node-chip-role">${roleSafe}</span>
        ${gwText}
      </div>
    `;
  }).join('');
}

// =============================================================================
// 接力横幅
// =============================================================================
function renderHandoffAlertBanner(handoffs) {
  if (!dom.handoffAlertBanner) return;
  const pending = (handoffs || []).filter(h => h.status === 'pending');
  if (pending.length === 0) {
    dom.handoffAlertBanner.style.display = 'none';
    dom.handoffAlertBanner.innerHTML = '';
    return;
  }

  const h = pending[0];
  const objSafe = escapeHtml(h.objective);
  const nextSafe = escapeHtml(h.next_action || '');
  const srcSafe = escapeHtml(h.source_host_id || '本地');
  const tgtSafe = escapeHtml(h.target_host_id || '任意');
  const idSafe = escapeHtml(h.id);

  dom.handoffAlertBanner.style.display = 'flex';
  dom.handoffAlertBanner.innerHTML = `
    <div class="handoff-banner-head">
      <div class="handoff-banner-title">待认领接力 ${pending.length > 1 ? `· 共 ${pending.length} 项` : ''}</div>
      <span class="handoff-route-badge">${srcSafe} → ${tgtSafe}</span>
    </div>
    <div class="handoff-banner-body">
      <div class="handoff-banner-objective">${objSafe}</div>
      ${nextSafe ? `<div class="handoff-banner-next">下一步：${nextSafe}</div>` : ''}
    </div>
    <div class="handoff-banner-actions">
      <button class="btn-ghost-sm" onclick="switchView('memory')">查看全部</button>
      <button class="btn-primary-sm" onclick="claimHandoff('${idSafe}')">认领</button>
    </div>
  `;
}

// =============================================================================
// 接力工单与工程记忆
// =============================================================================
let currentMemoryCategory = 'all';

async function fetchHandoffs() {
  try {
    const res = await fetch(`/api/handoffs?project_id=${encodeURIComponent(currentProjectId)}`, { headers: authHeaders() });
    if (!res.ok) return;
    const list = await res.json();
    renderHandoffs(list);
  } catch (err) {
    console.error('Fetch handoffs error:', err);
  }
}

function renderHandoffs(list) {
  if (!dom.handoffsContainer) return;
  if (!Array.isArray(list) || list.length === 0) {
    dom.handoffsContainer.innerHTML = makeEmptyHint('handoff', '暂无跨主机交接记录', '提交 Git 或通过 MCP 移交上下文时自动生成');
    return;
  }

  dom.handoffsContainer.innerHTML = list.map(h => {
    const timeStr = escapeHtml(new Date(h.created_at || Date.now()).toLocaleDateString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
    const idSafe = escapeHtml(h.id);
    const objSafe = escapeHtml(h.objective);
    const stateSafe = escapeHtml(h.state_summary || '');
    const nextSafe = escapeHtml(h.next_action || '');
    const srcSafe = escapeHtml(h.source_host_id || '本地');
    const tgtSafe = escapeHtml(h.target_host_id || '任意');
    const statusClass = escapeHtml(h.status || 'pending');
    const statusText = statusClass === 'pending' ? '待认领' : (statusClass === 'in_progress' ? '进行中' : '已完成');

    let filesArr = [];
    try {
      filesArr = typeof h.modified_files === 'string' ? JSON.parse(h.modified_files) : (h.modified_files || []);
    } catch {
      filesArr = [];
    }

    const filesHtml = filesArr.length > 0 ? `
      <div class="handoff-files-list">
        ${filesArr.slice(0, 6).map(f => `<span class="handoff-file-pill">${escapeHtml(f)}</span>`).join('')}
        ${filesArr.length > 6 ? `<span class="handoff-file-pill">+${filesArr.length - 6}</span>` : ''}
      </div>
    ` : '';

    const nextBox = nextSafe ? `
      <div class="handoff-next-box">
        <span class="handoff-next-label">下一步</span>
        <span>${nextSafe}</span>
      </div>
    ` : '';

    const actionBtn = statusClass === 'pending'
      ? `<button class="btn-primary-sm" onclick="claimHandoff('${idSafe}', 'in_progress')">认领</button>`
      : (statusClass === 'in_progress'
        ? `<button class="btn-secondary" onclick="claimHandoff('${idSafe}', 'completed')">标记完成</button>`
        : `<span>已由 ${escapeHtml(h.consumed_by_agent_id || '助手')} 完成</span>`);

    return `
      <div class="handoff-card">
        <div class="handoff-card-head">
          <span class="handoff-route-badge">${srcSafe} → ${tgtSafe}</span>
          <span class="handoff-status-badge ${statusClass}">${statusText}</span>
        </div>
        <div class="handoff-objective">${objSafe}</div>
        ${stateSafe ? `<div class="handoff-state-summary">${stateSafe}</div>` : ''}
        ${filesHtml}
        ${nextBox}
        <div class="handoff-card-footer">
          <span>${timeStr} · ${escapeHtml(h.source_agent_id || '助手')}</span>
          ${actionBtn}
        </div>
      </div>
    `;
  }).join('');
}

async function claimHandoff(handoffId, targetStatus = null) {
  try {
    const res = await fetch(`/api/handoffs/${encodeURIComponent(handoffId)}/consume`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent_id: 'operator', ...(targetStatus ? { status: targetStatus } : {}) })
    });
    if (res.ok) {
      fetchDashboard();
      if (dom.viewMemory?.classList.contains('active')) fetchHandoffs();
    }
  } catch (err) {
    console.error('Claim handoff error:', err);
  }
}
window.claimHandoff = claimHandoff;

async function fetchMemories(query = '', category = currentMemoryCategory) {
  try {
    let url = `/api/projects/${encodeURIComponent(currentProjectId)}/memories?limit=100`;
    if (category && category !== 'all') url += `&category=${encodeURIComponent(category)}`;
    if (query && query.trim()) url += `&query=${encodeURIComponent(query.trim())}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    const list = await res.json();
    renderMemories(list);
  } catch (err) {
    console.error('Fetch memories error:', err);
  }
}

function renderMemories(list) {
  if (!dom.memoriesContainer) return;
  if (!Array.isArray(list) || list.length === 0) {
    dom.memoriesContainer.innerHTML = makeEmptyHint('memory', '暂无沉淀记忆', '通过 MCP save_memory 沉淀架构规则与决策');
    return;
  }

  dom.memoriesContainer.innerHTML = list.map(m => {
    const timeStr = escapeHtml(new Date(m.updated_at || m.created_at || Date.now()).toLocaleDateString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
    const idSafe = escapeHtml(String(m.id || ''));
    const keySafe = escapeHtml(m.key);
    const cat = m.category || 'general';
    const catSafe = escapeHtml(MEMORY_CATEGORY_LABEL[cat] || cat);
    const contentSafe = escapeHtml(m.content);
    const authorSafe = escapeHtml(m.source_agent_id || '团队');

    return `
      <div class="memory-card">
        <div class="memory-card-head">
          <span class="memory-key">${keySafe}</span>
          <span class="memory-cat-pill">${catSafe}</span>
        </div>
        <div class="memory-content-box">${contentSafe}</div>
        <div class="memory-card-footer">
          <span>${authorSafe} · ${timeStr}</span>
          ${idSafe ? `<button class="btn-ghost-sm" onclick="deleteMemory('${idSafe}')">删除</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function deleteMemory(id) {
  if (!confirm('删除这条工程记忆？')) return;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProjectId)}/memories?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    if (res.ok) fetchMemories(dom.memorySearchInput?.value || '', currentMemoryCategory);
  } catch (err) {
    console.error('Delete memory error:', err);
  }
}
window.deleteMemory = deleteMemory;

if (dom.memoryCategoryPills) {
  dom.memoryCategoryPills.forEach(pill => {
    pill.addEventListener('click', () => {
      dom.memoryCategoryPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentMemoryCategory = pill.dataset.category || 'all';
      fetchMemories(dom.memorySearchInput ? dom.memorySearchInput.value : '', currentMemoryCategory);
    });
  });
}

if (dom.memorySearchInput) {
  dom.memorySearchInput.addEventListener('input', debounce(() => {
    fetchMemories(dom.memorySearchInput.value, currentMemoryCategory);
  }, 250));
}

if (dom.btnCreateHandoffOpen) {
  dom.btnCreateHandoffOpen.addEventListener('click', () => {
    if (!dom.modalHandoff) return;
    document.getElementById('modal-handoff-objective').value = '';
    document.getElementById('modal-handoff-state').value = '';
    document.getElementById('modal-handoff-files').value = '';
    document.getElementById('modal-handoff-next').value = '';
    dom.modalHandoff.removeAttribute('hidden');
  });
}

const closeHandoffModal = () => {
  if (dom.modalHandoff) dom.modalHandoff.setAttribute('hidden', '');
};
if (dom.btnModalHandoffClose) dom.btnModalHandoffClose.addEventListener('click', closeHandoffModal);
if (dom.btnModalHandoffCancel) dom.btnModalHandoffCancel.addEventListener('click', closeHandoffModal);

if (dom.btnModalHandoffSubmit) {
  dom.btnModalHandoffSubmit.addEventListener('click', async () => {
    const objective = document.getElementById('modal-handoff-objective').value.trim();
    const stateSummary = document.getElementById('modal-handoff-state').value.trim();
    const filesRaw = document.getElementById('modal-handoff-files').value.trim();
    const nextAction = document.getElementById('modal-handoff-next').value.trim();

    if (!objective) {
      alert('请填写目标');
      return;
    }

    const filesArr = filesRaw ? filesRaw.split(/[,，\n]/).map(f => f.trim()).filter(Boolean) : [];
    try {
      const res = await fetch('/api/handoffs', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          project_id: currentProjectId === 'all' ? 'default' : currentProjectId,
          source_host_id: 'operator',
          source_agent_id: 'operator',
          objective,
          state_summary: stateSummary || objective,
          modified_files: filesArr,
          next_action: nextAction
        })
      });
      if (res.ok) {
        closeHandoffModal();
        fetchHandoffs();
        fetchDashboard();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.error || '创建失败');
      }
    } catch (err) {
      console.error('Create handoff error:', err);
    }
  });
}

if (dom.btnCreateMemoryOpen) {
  dom.btnCreateMemoryOpen.addEventListener('click', () => {
    if (!dom.modalMemory) return;
    document.getElementById('modal-memory-key').value = '';
    document.getElementById('modal-memory-content').value = '';
    dom.modalMemory.removeAttribute('hidden');
  });
}

const closeMemoryModal = () => {
  if (dom.modalMemory) dom.modalMemory.setAttribute('hidden', '');
};
if (dom.btnModalMemoryClose) dom.btnModalMemoryClose.addEventListener('click', closeMemoryModal);
if (dom.btnModalMemoryCancel) dom.btnModalMemoryCancel.addEventListener('click', closeMemoryModal);

if (dom.btnModalMemorySubmit) {
  dom.btnModalMemorySubmit.addEventListener('click', async () => {
    const category = document.getElementById('modal-memory-cat').value;
    const key = document.getElementById('modal-memory-key').value.trim();
    const content = document.getElementById('modal-memory-content').value.trim();

    if (!key || !content) {
      alert('请填写标识和内容');
      return;
    }

    try {
      const targetProj = currentProjectId === 'all' ? 'default' : currentProjectId;
      const res = await fetch(`/api/projects/${encodeURIComponent(targetProj)}/memories`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          category,
          key,
          content,
          source_agent_id: 'operator'
        })
      });
      if (res.ok) {
        closeMemoryModal();
        fetchMemories(dom.memorySearchInput?.value || '', currentMemoryCategory);
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.error || '保存失败');
      }
    } catch (err) {
      console.error('Save memory error:', err);
    }
  });
}

// =============================================================================
// 路由拓扑
// =============================================================================
let lastRoutingData = null;
let currentDecisionFilter = 'all';

async function fetchRoutingTopology() {
  try {
    const res = await fetch(`/api/cockpit?project_id=${encodeURIComponent(currentProjectId)}`, {
      headers: authHeaders()
    });
    if (!res.ok) {
      const fallbackRes = await fetch(`/api/dashboard?project_id=${encodeURIComponent(currentProjectId)}`, {
        headers: authHeaders()
      });
      if (fallbackRes.ok) {
        const dashboard = await fallbackRes.json();
        renderRoutingDiagram({ dashboard, lockContention: dashboard, collab: { nodes: [], edges: [] } });
      }
      return;
    }
    const data = await res.json();
    renderRoutingDiagram(data);
  } catch (err) {
    console.error('Fetch routing topology error:', err);
  }
}

const debouncedFetchRoutingTopology = debounce(() => fetchRoutingTopology(), 200);

function splitPathForDisplay(fullPath) {
  if (!fullPath) return { dir: '', name: '未知目标', full: '' };
  const normalized = String(fullPath).replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) return { dir: '', name: normalized, full: normalized };
  const dir = normalized.slice(0, lastSlash + 1);
  const name = normalized.slice(lastSlash + 1);
  const parts = dir.split('/').filter(Boolean);
  let shortDir = dir;
  if (parts.length > 2) shortDir = '…/' + parts.slice(-2).join('/') + '/';
  return { dir: shortDir, name, full: normalized };
}

function renderRoutingDiagram(cockpitData) {
  if (!dom.routingCanvasWrapper) return;
  lastRoutingData = cockpitData;

  const dashboard = cockpitData.dashboard || cockpitData;
  const collab = cockpitData.collab || { nodes: [], edges: [] };
  const rawAgents = dashboard.agents || collab.nodes?.filter(n => n.node_type === 'session') || [];
  const activeClaims = cockpitData.lockContention?.activeClaims || (dashboard.activeClaims || []).filter(c => c.claim_type !== 'resource');
  const resourceLocks = cockpitData.lockContention?.resourceLocks || (dashboard.activeClaims || []).filter(c => c.claim_type === 'resource');
  const waitQueue = cockpitData.lockContention?.waitQueue || dashboard.waitQueue || [];
  const timeline = dashboard.recentTimeline || dashboard.timeline || [];

  updateGlobalAgentRegistry(rawAgents, [...activeClaims, ...resourceLocks], timeline);

  const validAgents = buildAgentViews(rawAgents, [...activeClaims, ...resourceLocks]);

  if (dom.routingSummaryMeta) {
    const cpaSnippet = currentGatewayStatus?.auth ? ` · CPA 算力 ${currentGatewayStatus.auth.enabledAccounts}/${currentGatewayStatus.auth.totalAccounts}` : '';
    dom.routingSummaryMeta.textContent =
      `${validAgents.length} 会话 · ${activeClaims.length + resourceLocks.length} 项锁定 · ${waitQueue.length} 处等待${cpaSnippet}`;
  }
  if (dom.badgeSessionsCount) dom.badgeSessionsCount.textContent = validAgents.length;

  if (dom.hubStatusText) {
    if (waitQueue.length > 0) {
      dom.hubStatusText.textContent = `协调中 · ${waitQueue.length} 处等待`;
      dom.hubStatusDot?.classList.add('dot-waiting');
    } else {
      dom.hubStatusText.textContent = '协同调度';
      dom.hubStatusDot?.classList.remove('dot-waiting');
    }
  }

  updateHubCpaDisplay(currentGatewayStatus);

  // 会话列
  if (dom.routingSessionsContainer) {
    if (validAgents.length === 0) {
      dom.routingSessionsContainer.innerHTML = makeEmptyHint('agent', '无在线会话', '当前没有已接入的会话');
    } else {
      dom.routingSessionsContainer.innerHTML = validAgents.map(a => {
        const idSafe = escapeHtml(a.id);
        const resolvedName = resolveAgentName(a.id, a.name);
        const nameSafe = escapeHtml(resolvedName);
        const providerSafe = escapeHtml(a.provider || (a.id.includes('claude') ? 'Claude' : 'Agent'));
        // 没有真实意图就留空，状态徽章已经说明在做什么，不补占位话术。
        const intentSafe = escapeHtml(a.current_intent_summary || a.current_intent || '');
        const toolSafe = a.last_tool || a.last_action ? escapeHtml(a.last_tool || a.last_action) : '';
        const claimsCount = a.resolvedClaims.length;
        const projName = getProjectDisplayName(a.project_id, a.workspace_dir);
        const projSafe = escapeHtml(projName);
        const showProj = (currentProjectId === 'all' || !currentProjectId) && projSafe;
        const hostSafe = a.is_remote && a.host_id ? escapeHtml(a.host_id) : '';
        const showHost = Boolean(hostSafe) && (!showProj || !projName.includes(`[${a.host_id}]`));

        let statusBadge = '<span class="session-status-tag status-idle"><span class="dot"></span>待命</span>';
        if (a.uiState === 'working') {
          statusBadge = '<span class="session-status-tag status-working"><span class="dot"></span>修改中</span>';
        } else if (a.uiState === 'waiting') {
          statusBadge = '<span class="session-status-tag status-waiting"><span class="dot"></span>排队</span>';
        }

        return `
          <div class="session-route-card state-${a.uiState}" data-session-id="${idSafe}">
            <div class="route-card-header">
              <div class="route-card-identity">
                <span class="route-agent-name" title="${idSafe}">${nameSafe}</span>
                ${showHost ? `<span class="route-host-badge" title="节点 ${hostSafe}">${hostSafe}</span>` : ''}
                ${showProj ? `<span class="route-project-badge" title="工程 ${projSafe}">${projSafe}</span>` : ''}
              </div>
              ${statusBadge}
            </div>
            ${intentSafe ? `
            <div class="route-card-intent" title="${intentSafe}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
              </svg>
              <span>${intentSafe}</span>
            </div>` : ''}
            ${(toolSafe || claimsCount > 0) ? `
            <div class="route-card-footer">
              ${toolSafe ? `<span class="route-action-tag"><code>${toolSafe}</code></span>` : '<span></span>'}
              ${claimsCount > 0 ? `<span class="route-leases-tag">${claimsCount} 项锁定</span>` : ''}
            </div>` : ''}
          </div>
        `;
      }).join('');
    }
  }

  const targetsTotal = activeClaims.length + resourceLocks.length + waitQueue.length;
  if (dom.badgeTargetsCount) dom.badgeTargetsCount.textContent = targetsTotal;

  if (dom.routingTargetsContainer) {
    let targetsHtml = '';

    if (activeClaims.length > 0) {
      targetsHtml += `<div class="target-group-label">文件锁定 ${activeClaims.length}</div>`;
      activeClaims.forEach(c => {
        const rawPath = c.claim_target || c.path || '';
        const pathSafe = escapeHtml(rawPath);
        const pathInfo = splitPathForDisplay(rawPath);
        const agentSafe = escapeHtml(c.agent_id);
        const holderDisplay = escapeHtml(resolveAgentName(c.agent_id, c.agent_name));
        const now = Date.now();
        const remainingSec = c.expires_at ? Math.max(0, Math.ceil((c.expires_at - now) / 1000)) : 300;
        const resKey = `res:file:${pathSafe}`;

        targetsHtml += `
          <div class="target-route-card type-file" data-target-id="${resKey}" data-holder-id="${agentSafe}">
            <div class="target-card-header">
              <div class="target-icon-wrap file-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                  <polyline points="13 2 13 9 20 9"></polyline>
                </svg>
              </div>
              <div class="target-file-info" title="${pathSafe}">
                <span class="target-file-name">${escapeHtml(pathInfo.name)}</span>
                ${pathInfo.dir ? `<span class="target-file-dir">${escapeHtml(pathInfo.dir)}</span>` : ''}
              </div>
              <span class="target-status-badge badge-locked">已锁定</span>
            </div>
            <div class="target-card-meta">
              <span class="target-holder" title="${agentSafe}">${holderDisplay}</span>
              <span class="target-ttl-badge">${remainingSec}s</span>
            </div>
          </div>
        `;
      });
    }

    if (resourceLocks.length > 0) {
      targetsHtml += `<div class="target-group-label">资源锁 ${resourceLocks.length}</div>`;
      resourceLocks.forEach(l => {
        const rawName = l.claim_target || l.resource_name || l.name || 'resource';
        const nameSafe = escapeHtml(rawName);
        const agentSafe = escapeHtml(l.agent_id);
        const holderDisplay = escapeHtml(resolveAgentName(l.agent_id, l.agent_name));
        const resKey = `res:resource:${nameSafe}`;

        targetsHtml += `
          <div class="target-route-card type-lock" data-target-id="${resKey}" data-holder-id="${agentSafe}">
            <div class="target-card-header">
              <div class="target-icon-wrap lock-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
              </div>
              <div class="target-file-info" title="${nameSafe}">
                <span class="target-file-name">${nameSafe}</span>
                <span class="target-file-dir">命名资源</span>
              </div>
              <span class="target-status-badge badge-exclusive">排他</span>
            </div>
            <div class="target-card-meta">
              <span class="target-holder" title="${agentSafe}">${holderDisplay}</span>
              <span class="target-hook-badge">Hook 释放</span>
            </div>
          </div>
        `;
      });
    }

    if (waitQueue.length > 0) {
      targetsHtml += `<div class="target-group-label">等待队列 ${waitQueue.length}</div>`;
      waitQueue.forEach(w => {
        const summarySafe = escapeHtml(w.summary || w.target || '等待文件解锁');
        const reasonSafe = escapeHtml(w.blocked_reason || '等待前序操作解锁');
        const agentSafe = escapeHtml(w.agent_id);
        const waiterDisplay = escapeHtml(resolveAgentName(w.agent_id, w.agent_name));
        const resKey = `res:wait:${escapeHtml(w.intent_id || w.agent_id)}`;

        targetsHtml += `
          <div class="target-route-card type-waiting" data-target-id="${resKey}" data-holder-id="${agentSafe}">
            <div class="target-card-header">
              <div class="target-icon-wrap waiting-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
              </div>
              <div class="target-file-info" title="${summarySafe}">
                <span class="target-file-name">${summarySafe}</span>
                <span class="target-file-dir">${reasonSafe}</span>
              </div>
              <span class="target-status-badge badge-waiting-queue">等待</span>
            </div>
            <div class="target-card-meta">
              <span class="target-holder" title="${agentSafe}">${waiterDisplay}</span>
              <span class="target-waiting-badge">释放即唤醒</span>
            </div>
          </div>
        `;
      });
    }

    if (!targetsHtml) {
      targetsHtml = makeEmptyHint('lock', '暂无文件锁定', '当前没有文件被独占或排队');
    }
    dom.routingTargetsContainer.innerHTML = targetsHtml;
  }

  renderRoutingDecisions(timeline, [...activeClaims, ...resourceLocks], waitQueue);
  requestAnimationFrame(drawRoutingConnectors);
  attachRouteHighlightEvents();
}

function drawRoutingConnectors() {
  if (!dom.routingSvgLayer || !dom.routingCanvasWrapper || !dom.nexusHubCard) return;

  const wrapperRect = dom.routingCanvasWrapper.getBoundingClientRect();
  if (wrapperRect.width === 0 || wrapperRect.height === 0) return;

  dom.routingSvgLayer.setAttribute('viewBox', `0 0 ${wrapperRect.width} ${wrapperRect.height}`);
  dom.routingSvgLayer.style.width = `${wrapperRect.width}px`;
  dom.routingSvgLayer.style.height = `${wrapperRect.height}px`;

  const hubRect = dom.nexusHubCard.getBoundingClientRect();
  const hubLeftX = hubRect.left - wrapperRect.left;
  const hubRightX = hubRect.right - wrapperRect.left;

  const sessionCards = Array.from(dom.routingSessionsContainer?.querySelectorAll('.session-route-card') || []);
  const targetCards = Array.from(dom.routingTargetsContainer?.querySelectorAll('.target-route-card') || []);

  let svgHtml = '';

  const hubTopY = hubRect.top - wrapperRect.top + 16;
  const hubBottomY = hubRect.bottom - wrapperRect.top - 16;
  const hubAvailH = Math.max(20, hubBottomY - hubTopY);

  sessionCards.forEach((card, idx) => {
    const sRect = card.getBoundingClientRect();
    const x1 = sRect.right - wrapperRect.left;
    const y1 = sRect.top - wrapperRect.top + sRect.height / 2;

    const sStep = sessionCards.length > 1 ? hubAvailH / (sessionCards.length - 1) : 0;
    const y2 = sessionCards.length > 1 ? (hubTopY + idx * sStep) : (hubTopY + hubAvailH / 2);
    const x2 = hubLeftX;

    const span = Math.max(35, x2 - x1);
    const dx = span * 0.45;
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

    const sessionId = card.dataset.sessionId || '';
    const isWorking = card.classList.contains('state-working');
    const isWaiting = card.classList.contains('state-waiting');

    let lineClass = 'route-path route-session-line route-idle';
    if (isWorking) lineClass = 'route-path route-session-line route-active';
    else if (isWaiting) lineClass = 'route-path route-session-line route-waiting';

    svgHtml += `<path d="${d}" class="${lineClass}" data-from-session="${escapeHtml(sessionId)}" data-edge-type="session-hub" />`;
  });

  targetCards.forEach((card, idx) => {
    const tRect = card.getBoundingClientRect();
    const x2 = tRect.left - wrapperRect.left;
    const y2 = tRect.top - wrapperRect.top + tRect.height / 2;

    const tStep = targetCards.length > 1 ? hubAvailH / (targetCards.length - 1) : 0;
    const y1 = targetCards.length > 1 ? (hubTopY + idx * tStep) : (hubTopY + hubAvailH / 2);
    const x1 = hubRightX;

    const span = Math.max(45, x2 - x1);
    const dx = span * 0.48;
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

    const targetId = card.dataset.targetId || '';
    const holderId = card.dataset.holderId || '';
    const isWaitingTarget = card.classList.contains('type-waiting');
    const isFileOrLock = card.classList.contains('type-file') || card.classList.contains('type-lock');

    let lineClass = 'route-path route-target-line route-idle';
    if (isWaitingTarget) lineClass = 'route-path route-target-line route-waiting';
    else if (isFileOrLock) lineClass = 'route-path route-target-line route-active';

    svgHtml += `<path d="${d}" class="${lineClass}" data-to-target="${escapeHtml(targetId)}" data-holder-id="${escapeHtml(holderId)}" data-edge-type="hub-target" />`;
  });

  dom.routingSvgLayer.innerHTML = svgHtml;
}

function attachRouteHighlightEvents() {
  const sessionCards = dom.routingSessionsContainer?.querySelectorAll('.session-route-card') || [];
  const targetCards = dom.routingTargetsContainer?.querySelectorAll('.target-route-card') || [];

  sessionCards.forEach(card => {
    const sId = card.dataset.sessionId;
    card.onmouseenter = () => highlightSessionRoutes(sId);
    card.onmouseleave = resetRouteHighlights;
  });

  targetCards.forEach(card => {
    const tId = card.dataset.targetId;
    const hId = card.dataset.holderId;
    card.onmouseenter = () => highlightTargetRoutes(tId, hId);
    card.onmouseleave = resetRouteHighlights;
  });
}

function highlightSessionRoutes(sessionId) {
  if (!dom.routingSvgLayer) return;
  dom.routingSvgLayer.querySelectorAll('.route-path').forEach(p => {
    const fromSession = p.dataset.fromSession;
    const holderId = p.dataset.holderId;
    if (fromSession === sessionId || holderId === sessionId) {
      p.classList.add('route-highlighted');
      p.classList.remove('route-dimmed');
    } else {
      p.classList.add('route-dimmed');
      p.classList.remove('route-highlighted');
    }
  });

  dom.routingTargetsContainer?.querySelectorAll('.target-route-card').forEach(tc => {
    if (tc.dataset.holderId === sessionId) tc.classList.add('card-highlighted');
    else tc.classList.add('card-dimmed');
  });
}

function highlightTargetRoutes(targetId, holderId) {
  if (!dom.routingSvgLayer) return;
  dom.routingSvgLayer.querySelectorAll('.route-path').forEach(p => {
    const toTarget = p.dataset.toTarget;
    const fromSession = p.dataset.fromSession;
    if (toTarget === targetId || (holderId && fromSession === holderId)) {
      p.classList.add('route-highlighted');
      p.classList.remove('route-dimmed');
    } else {
      p.classList.add('route-dimmed');
      p.classList.remove('route-highlighted');
    }
  });

  if (holderId) {
    dom.routingSessionsContainer?.querySelectorAll('.session-route-card').forEach(sc => {
      if (sc.dataset.sessionId === holderId) sc.classList.add('card-highlighted');
      else sc.classList.add('card-dimmed');
    });
  }
}

function resetRouteHighlights() {
  if (!dom.routingSvgLayer) return;
  dom.routingSvgLayer.querySelectorAll('.route-path').forEach(p => {
    p.classList.remove('route-highlighted', 'route-dimmed');
  });
  dom.routingSessionsContainer?.querySelectorAll('.session-route-card').forEach(sc => {
    sc.classList.remove('card-highlighted', 'card-dimmed');
  });
  dom.routingTargetsContainer?.querySelectorAll('.target-route-card').forEach(tc => {
    tc.classList.remove('card-highlighted', 'card-dimmed');
  });
}

function renderRoutingDecisions(timeline, activeClaims, waitQueue) {
  if (!dom.routingDecisionsStream) return;

  const decisions = [];

  (timeline || []).forEach(item => {
    const type = item.event_type || item.type || '';
    const desc = item.description || item.detail || '';
    const agent = item.agent_id || 'system';
    const agentDisplay = escapeHtml(resolveAgentName(agent, item.agent_name));
    const rawTs = item.created_at || item.timestamp;
    const time = rawTs ? new Date(rawTs).toLocaleTimeString() : new Date().toLocaleTimeString();

    if (type.includes('grant') || type.includes('claim') || desc.includes('拿到租约') || desc.includes('声明') || desc.includes('锁定')) {
      decisions.push({
        type: 'grant',
        time,
        badge: '锁定',
        title: `<strong class="decision-agent" title="${escapeHtml(agent)}">${agentDisplay}</strong> 锁定文件`,
        detail: escapeHtml(desc)
      });
    } else if (type.includes('conflict') || type.includes('intercept') || type.includes('blocked') || type.includes('waiting') || desc.includes('冲突') || desc.includes('拦截') || desc.includes('WAITING')) {
      decisions.push({
        type: 'intercept',
        time,
        badge: '拦截',
        title: `<strong class="decision-agent" title="${escapeHtml(agent)}">${agentDisplay}</strong> 写入被拦截`,
        detail: escapeHtml(desc)
      });
    } else if (type.includes('freed') || type.includes('release') || desc.includes('释放') || desc.includes('解锁') || desc.includes('PostToolUse')) {
      decisions.push({
        type: 'release',
        time,
        badge: '解锁',
        title: `<strong class="decision-agent" title="${escapeHtml(agent)}">${agentDisplay}</strong> 释放文件锁`,
        detail: escapeHtml(desc)
      });
    }
  });

  if (decisions.length === 0) {
    (activeClaims || []).forEach(c => {
      const pathInfo = splitPathForDisplay(c.claim_target || c.path);
      decisions.push({
        type: 'grant',
        time: new Date().toLocaleTimeString(),
        badge: '锁定',
        title: `<strong class="decision-agent" title="${escapeHtml(c.agent_id)}">${escapeHtml(resolveAgentName(c.agent_id, c.agent_name))}</strong> 锁定中`,
        detail: `<code>${escapeHtml(pathInfo.name)}</code> <span class="decision-path-dir">${escapeHtml(pathInfo.dir)}</span>`
      });
    });
    (waitQueue || []).forEach(w => {
      const pathInfo = splitPathForDisplay(w.summary || w.target || '');
      decisions.push({
        type: 'intercept',
        time: new Date().toLocaleTimeString(),
        badge: '拦截',
        title: `<strong class="decision-agent" title="${escapeHtml(w.agent_id)}">${escapeHtml(resolveAgentName(w.agent_id, w.agent_name))}</strong> 排队中`,
        detail: `<code>${escapeHtml(pathInfo.name)}</code> 等待解锁`
      });
    });
  }

  const filtered = currentDecisionFilter === 'all'
    ? decisions
    : decisions.filter(d => d.type === currentDecisionFilter);

  if (dom.decisionsCountBadge) dom.decisionsCountBadge.textContent = String(filtered.length);

  if (filtered.length === 0) {
    dom.routingDecisionsStream.innerHTML = makeEmptyHint('stream', '暂无调度记录', '冲突拦截与文件解锁动态将在此实时展现');
    return;
  }

  dom.routingDecisionsStream.innerHTML = filtered.map(d => `
    <div class="decision-item item-${d.type}">
      <span class="decision-badge badge-${d.type}">${d.badge}</span>
      <span class="decision-time">${d.time}</span>
      <div class="decision-body">
        <div class="decision-title">${d.title}</div>
        <div class="decision-detail">${d.detail}</div>
      </div>
    </div>
  `).join('');
}

if (dom.decisionsFilterBtns) {
  dom.decisionsFilterBtns.forEach(btn => {
    btn.onclick = () => {
      dom.decisionsFilterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentDecisionFilter = btn.dataset.filter || 'all';
      if (lastRoutingData) renderRoutingDiagram(lastRoutingData);
    };
  });
}

if (window.ResizeObserver && dom.routingCanvasWrapper) {
  const ro = new ResizeObserver(() => {
    if (dom.viewRouting?.classList.contains('active')) requestAnimationFrame(drawRoutingConnectors);
  });
  ro.observe(dom.routingCanvasWrapper);
}
window.addEventListener('resize', () => {
  if (dom.viewRouting?.classList.contains('active')) requestAnimationFrame(drawRoutingConnectors);
});

if (dom.routingTargetsContainer) {
  dom.routingTargetsContainer.addEventListener('scroll', () => {
    if (dom.viewRouting?.classList.contains('active')) requestAnimationFrame(drawRoutingConnectors);
  });
}
if (dom.routingSessionsContainer) {
  dom.routingSessionsContainer.addEventListener('scroll', () => {
    if (dom.viewRouting?.classList.contains('active')) requestAnimationFrame(drawRoutingConnectors);
  });
}

// =============================================================================
// 面板拖拽
// =============================================================================
function setupPanelResizers() {
  const resizerDecisions = dom.resizerRoutingDecisions;
  const decisionsPanel = dom.routingDecisionsPanel;
  const toggleBtn = dom.btnToggleDecisions;
  const routingPanelCard = document.querySelector('.routing-panel-card');

  const savedDecisionsHeight = localStorage.getItem('nexus_routing_decisions_height');
  if (savedDecisionsHeight && decisionsPanel) {
    document.documentElement.style.setProperty('--routing-decisions-height', savedDecisionsHeight);
  }
  const savedDecisionsCollapsed = localStorage.getItem('nexus_routing_decisions_collapsed');
  if (savedDecisionsCollapsed === 'true' && decisionsPanel) {
    decisionsPanel.classList.add('is-collapsed');
  }

  function toggleDecisionsPanel() {
    if (!decisionsPanel) return;
    const isCollapsed = decisionsPanel.classList.toggle('is-collapsed');
    localStorage.setItem('nexus_routing_decisions_collapsed', isCollapsed ? 'true' : 'false');
    requestAnimationFrame(drawRoutingConnectors);
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDecisionsPanel();
    });
  }

  if (resizerDecisions && decisionsPanel && routingPanelCard) {
    resizerDecisions.addEventListener('dblclick', toggleDecisionsPanel);

    resizerDecisions.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY;
      const startH = decisionsPanel.getBoundingClientRect().height;
      decisionsPanel.classList.remove('is-collapsed');
      decisionsPanel.classList.add('is-dragging');
      resizerDecisions.classList.add('is-dragging');
      document.body.classList.add('resizing-row');
      resizerDecisions.setPointerCapture(e.pointerId);

      const onPointerMove = (moveEvt) => {
        const delta = startY - moveEvt.clientY;
        const containerH = routingPanelCard.getBoundingClientRect().height;
        const minH = 38;
        const maxH = Math.max(140, containerH - 160);
        const newH = Math.min(maxH, Math.max(minH, startH + delta));
        document.documentElement.style.setProperty('--routing-decisions-height', `${Math.round(newH)}px`);
        requestAnimationFrame(drawRoutingConnectors);
      };

      const onPointerUp = (upEvt) => {
        resizerDecisions.releasePointerCapture(upEvt.pointerId);
        resizerDecisions.removeEventListener('pointermove', onPointerMove);
        resizerDecisions.removeEventListener('pointerup', onPointerUp);
        resizerDecisions.removeEventListener('pointercancel', onPointerUp);
        decisionsPanel.classList.remove('is-dragging');
        resizerDecisions.classList.remove('is-dragging');
        document.body.classList.remove('resizing-row');

        const finalH = decisionsPanel.getBoundingClientRect().height;
        if (finalH <= 45) {
          decisionsPanel.classList.add('is-collapsed');
          localStorage.setItem('nexus_routing_decisions_collapsed', 'true');
        } else {
          localStorage.setItem('nexus_routing_decisions_collapsed', 'false');
          localStorage.setItem('nexus_routing_decisions_height', `${Math.round(finalH)}px`);
        }
        requestAnimationFrame(drawRoutingConnectors);
      };

      resizerDecisions.addEventListener('pointermove', onPointerMove);
      resizerDecisions.addEventListener('pointerup', onPointerUp);
      resizerDecisions.addEventListener('pointercancel', onPointerUp);
    });
  }

  const resizerAgentsLocks = dom.resizerAgentsLocks;
  const paneLeft = dom.paneLeft;
  const flexAgents = dom.flexAgents;

  const savedAgentsH = localStorage.getItem('nexus_agents_section_height');
  if (savedAgentsH) document.documentElement.style.setProperty('--agents-section-height', savedAgentsH);

  if (resizerAgentsLocks && paneLeft && flexAgents) {
    resizerAgentsLocks.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--agents-section-height', '52%');
      localStorage.removeItem('nexus_agents_section_height');
    });

    resizerAgentsLocks.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY;
      const startH = flexAgents.getBoundingClientRect().height;
      const containerH = paneLeft.getBoundingClientRect().height;
      resizerAgentsLocks.classList.add('is-dragging');
      document.body.classList.add('resizing-row');
      resizerAgentsLocks.setPointerCapture(e.pointerId);

      const onPointerMove = (mEvt) => {
        const delta = mEvt.clientY - startY;
        const minH = 110;
        const maxH = containerH - 110;
        const newH = Math.min(maxH, Math.max(minH, startH + delta));
        const pct = Math.round((newH / containerH) * 100);
        document.documentElement.style.setProperty('--agents-section-height', `${pct}%`);
      };

      const onPointerUp = (uEvt) => {
        resizerAgentsLocks.releasePointerCapture(uEvt.pointerId);
        resizerAgentsLocks.removeEventListener('pointermove', onPointerMove);
        resizerAgentsLocks.removeEventListener('pointerup', onPointerUp);
        resizerAgentsLocks.removeEventListener('pointercancel', onPointerUp);
        resizerAgentsLocks.classList.remove('is-dragging');
        document.body.classList.remove('resizing-row');
        const finalPct = document.documentElement.style.getPropertyValue('--agents-section-height');
        if (finalPct) localStorage.setItem('nexus_agents_section_height', finalPct);
      };

      resizerAgentsLocks.addEventListener('pointermove', onPointerMove);
      resizerAgentsLocks.addEventListener('pointerup', onPointerUp);
      resizerAgentsLocks.addEventListener('pointercancel', onPointerUp);
    });
  }

  const resizerSessionsSplit = dom.resizerSessionsSplit;
  const splitLayout = document.getElementById('sessions-split-layout');

  const savedSessionsW = localStorage.getItem('nexus_sessions_left_width');
  if (savedSessionsW) document.documentElement.style.setProperty('--sessions-left-width', savedSessionsW);

  if (resizerSessionsSplit && splitLayout && paneLeft) {
    resizerSessionsSplit.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--sessions-left-width', '56%');
      localStorage.removeItem('nexus_sessions_left_width');
    });

    resizerSessionsSplit.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = paneLeft.getBoundingClientRect().width;
      const containerW = splitLayout.getBoundingClientRect().width;
      resizerSessionsSplit.classList.add('is-dragging');
      document.body.classList.add('resizing-col');
      resizerSessionsSplit.setPointerCapture(e.pointerId);

      const onPointerMove = (mEvt) => {
        const delta = mEvt.clientX - startX;
        const newW = Math.min(containerW - 260, Math.max(260, startW + delta));
        const pct = Math.round((newW / containerW) * 100);
        document.documentElement.style.setProperty('--sessions-left-width', `${pct}%`);
      };

      const onPointerUp = (uEvt) => {
        resizerSessionsSplit.releasePointerCapture(uEvt.pointerId);
        resizerSessionsSplit.removeEventListener('pointermove', onPointerMove);
        resizerSessionsSplit.removeEventListener('pointerup', onPointerUp);
        resizerSessionsSplit.removeEventListener('pointercancel', onPointerUp);
        resizerSessionsSplit.classList.remove('is-dragging');
        document.body.classList.remove('resizing-col');
        const finalPct = document.documentElement.style.getPropertyValue('--sessions-left-width');
        if (finalPct) localStorage.setItem('nexus_sessions_left_width', finalPct);
      };

      resizerSessionsSplit.addEventListener('pointermove', onPointerMove);
      resizerSessionsSplit.addEventListener('pointerup', onPointerUp);
      resizerSessionsSplit.addEventListener('pointercancel', onPointerUp);
    });
  }

  const resizerMemorySplit = dom.resizerMemorySplit;
  const memorySplitLayout = document.getElementById('memory-split-layout');
  const paneMemoryLeft = dom.paneMemoryLeft;

  const savedMemoryW = localStorage.getItem('nexus_memory_left_width');
  if (savedMemoryW) document.documentElement.style.setProperty('--memory-left-width', savedMemoryW);

  if (resizerMemorySplit && memorySplitLayout && paneMemoryLeft) {
    resizerMemorySplit.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--memory-left-width', '50%');
      localStorage.removeItem('nexus_memory_left_width');
    });

    resizerMemorySplit.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = paneMemoryLeft.getBoundingClientRect().width;
      const containerW = memorySplitLayout.getBoundingClientRect().width;
      resizerMemorySplit.classList.add('is-dragging');
      document.body.classList.add('resizing-col');
      resizerMemorySplit.setPointerCapture(e.pointerId);

      const onPointerMove = (mEvt) => {
        const delta = mEvt.clientX - startX;
        const newW = Math.min(containerW - 240, Math.max(240, startW + delta));
        const pct = Math.round((newW / containerW) * 100);
        document.documentElement.style.setProperty('--memory-left-width', `${pct}%`);
      };

      const onPointerUp = (uEvt) => {
        resizerMemorySplit.releasePointerCapture(uEvt.pointerId);
        resizerMemorySplit.removeEventListener('pointermove', onPointerMove);
        resizerMemorySplit.removeEventListener('pointerup', onPointerUp);
        resizerMemorySplit.removeEventListener('pointercancel', onPointerUp);
        resizerMemorySplit.classList.remove('is-dragging');
        document.body.classList.remove('resizing-col');
        const finalPct = document.documentElement.style.getPropertyValue('--memory-left-width');
        if (finalPct) localStorage.setItem('nexus_memory_left_width', finalPct);
      };

      resizerMemorySplit.addEventListener('pointermove', onPointerMove);
      resizerMemorySplit.addEventListener('pointerup', onPointerUp);
      resizerMemorySplit.addEventListener('pointercancel', onPointerUp);
    });
  }
}

// =============================================================================
// WebSocket
// =============================================================================
let activeWs = null;
let isWsConnected = false;
let fallbackPollTimer = null;
let wsPingTimer = null;
let gatewayPollTimer = null;

const debouncedFetchDashboard = debounce(fetchDashboard, 500);
const debouncedFetchHandoffs = debounce(fetchHandoffs, 500);
const debouncedFetchMemories = debounce(() => {
  fetchMemories(dom.memorySearchInput?.value || '', currentMemoryCategory);
}, 500);

function updateConnectionIndicators(connected, customStatus = null) {
  if (dom.liveDot) dom.liveDot.classList.toggle('disconnected', !connected);
  if (dom.daemonStatus) {
    if (customStatus) {
      dom.daemonStatus.textContent = customStatus;
      dom.daemonStatus.style.cursor = 'pointer';
      dom.daemonStatus.onclick = () => showTokenPrompt();
    } else {
      dom.daemonStatus.textContent = connected ? '已连接' : '重连中';
      dom.daemonStatus.style.cursor = connected ? 'default' : 'pointer';
      dom.daemonStatus.onclick = connected ? null : () => showTokenPrompt();
    }
  }
}

function startFallbackPolling() {
  if (fallbackPollTimer) return;
  fallbackPollTimer = setInterval(() => {
    if (isWsConnected) return;
    fetchDashboard();
    fetchGateway();
  }, 10000);
}

function stopFallbackPolling() {
  if (fallbackPollTimer) {
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
  }
}

function connectWebSocket() {
  try {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getNexusToken();
    if (!token) {
      updateConnectionIndicators(false, '需要令牌');
      showTokenPrompt('missing');
      return;
    }
    const params = new URLSearchParams();
    params.set('token', token);
    if (currentProjectId) params.set('project', currentProjectId);
    const wsUrl = `${protocol}//${location.host}/?${params.toString()}`;

    const ws = new WebSocket(wsUrl);
    activeWs = ws;

    ws.onopen = () => {
      isWsConnected = true;
      stopFallbackPolling();
      updateConnectionIndicators(true);

      if (wsPingTimer) clearInterval(wsPingTimer);
      wsPingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'ping' }));
            if (typeof document === 'undefined' || !document.hidden) {
              ws.send(JSON.stringify({ type: 'sync:request', project_id: currentProjectId }));
            }
          } catch {}
        }
      }, 4000);

      try { ws.send(JSON.stringify({ type: 'sync:request', project_id: currentProjectId })); } catch {}
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);

        if (payload.type === 'init:state' || payload.type === 'sync:response') {
          const incomingPid = payload.data?.project_id;
          if (incomingPid && currentProjectId && incomingPid !== currentProjectId && incomingPid !== 'all' && currentProjectId !== 'all') {
            return;
          }
          if (payload.data?.snapshot) {
            currentDashboardData = payload.data.snapshot;
            renderDashboardSnapshot(payload.data.snapshot);
          }
          debouncedLoadProjects();
          if (payload.data?.cockpit && dom.viewRouting?.classList.contains('active')) {
            renderRoutingDiagram({
              ...payload.data.cockpit,
              dashboard: payload.data.snapshot || payload.data.cockpit.dashboard
            });
          } else if (dom.viewRouting?.classList.contains('active')) {
            debouncedFetchRoutingTopology();
          }
          return;
        }

        if (payload.type === 'agent:telemetry' || payload.type === 'agent:status' || payload.type === 'resource:freed' || payload.type === 'agent:woken') {
          debouncedFetchDashboard();
          debouncedLoadProjects();
          if (dom.viewRouting?.classList.contains('active')) debouncedFetchRoutingTopology();
          return;
        }

        if (payload.type === 'handoff:created' || payload.type === 'handoff:consumed' || payload.type === 'node:status') {
          debouncedFetchDashboard();
          if (payload.type === 'node:status') debouncedFetchGateway();
          if (dom.viewMemory?.classList.contains('active')) debouncedFetchHandoffs();
          return;
        }

        if (payload.type === 'memory:saved' || payload.type === 'memory:deleted') {
          if (dom.viewMemory?.classList.contains('active')) debouncedFetchMemories();
          return;
        }

        debouncedFetchDashboard();
        if (dom.viewRouting?.classList.contains('active')) debouncedFetchRoutingTopology();
        if (dom.viewMemory?.classList.contains('active')) {
          debouncedFetchHandoffs();
          debouncedFetchMemories();
        }
      } catch (err) {
        console.error('Failed to parse WS payload:', err);
      }
    };

    ws.onclose = () => {
      isWsConnected = false;
      if (wsPingTimer) {
        clearInterval(wsPingTimer);
        wsPingTimer = null;
      }
      const token = getNexusToken();
      if (!token) {
        updateConnectionIndicators(false, '需要令牌');
        showTokenPrompt('missing');
        return;
      }
      updateConnectionIndicators(false);
      startFallbackPolling();
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => ws.close();
  } catch (err) {
    console.error('WebSocket connection error:', err);
    isWsConnected = false;
    updateConnectionIndicators(false);
    startFallbackPolling();
    setTimeout(connectWebSocket, 5000);
  }
}

const debouncedFetchGateway = debounce(() => fetchGateway(), 400);

// =============================================================================
// 启动
// =============================================================================
setupPanelResizers();

const initialView = new URLSearchParams(location.search).get('view') || new URLSearchParams(location.search).get('tab');
if (initialView && ['sessions', 'routing', 'agents', 'memory'].includes(initialView)) {
  switchView(initialView);
}

async function initApp() {
  if (dom.hubEndpoint && location?.host) {
    dom.hubEndpoint.textContent = location.host;
    dom.hubEndpoint.title = `Hub 端点 ${location.host}`;
  }
  await loadProjects();
  fetchGateway();
  connectWebSocket();
  if (gatewayPollTimer) clearInterval(gatewayPollTimer);
  gatewayPollTimer = setInterval(() => fetchGateway(), 15000);
}

initApp();
