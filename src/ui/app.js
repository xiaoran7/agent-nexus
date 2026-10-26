// =============================================================================
// Agent-Nexus Companion Console Controller (Compact 800x560 High-Density UX)
// =============================================================================

function getNexusToken() {
  const fromQuery = new URLSearchParams(location.search).get('token');
  if (fromQuery) {
    try { sessionStorage.setItem('nexusToken', fromQuery); } catch {}
    try { localStorage.setItem('nexusToken', fromQuery); } catch {}
    return fromQuery;
  }
  const stored = sessionStorage.getItem('nexusToken');
  if (stored) {
    return stored;
  }
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
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <span>Nexus 访问认证</span>
          </span>
          <button class="nexus-modal-close" id="nexus-token-close-btn" title="关闭">&times;</button>
        </div>
        <p class="nexus-modal-desc">
          ${reason === 'invalid' ? '当前令牌 (Token) 校验失败 (401 Unauthorized)，请重新输入：' : '未检测到有效访问令牌。请输入 Nexus Hub Operator Token：'}
        </p>
        <div class="nexus-modal-input-row">
          <input type="password" id="nexus-token-input" class="nexus-modal-input" placeholder="输入 Token（或在 URL 中添加 ?token=...）" autocomplete="off" />
          <button id="nexus-token-save-btn" class="nexus-modal-btn primary">保存并连接</button>
        </div>
        <div class="nexus-modal-hint">提示：Token 位于 Hub 宿主机 <code>~/.agent-nexus/session.token</code> 或 <code>hub.json</code></div>
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
    closeBtn.addEventListener('click', () => {
      modal.remove();
    });
  } else {
    const desc = modal.querySelector('.nexus-modal-desc');
    if (desc) {
      desc.textContent = reason === 'invalid'
        ? '当前令牌 (Token) 校验失败 (401 Unauthorized)，请重新输入：'
        : '未检测到有效访问令牌。请输入 Nexus Hub Operator Token：';
    }
  }
  const input = modal.querySelector('#nexus-token-input');
  if (input) {
    setTimeout(() => input.focus(), 100);
  }
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
function debounce(fn, delay = 250) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// 判定会话名称是否为机械截断哈希、编号或系统默认占位符
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

// 规范化 Agent 显示名称，剔除乱码并提供标准化身份标识
function formatAgentDisplayName(name, agentId, provider, sessionId, intentSummary = null) {
  if (name && typeof name === 'string' && name.trim()) {
    const trimmed = name.trim();
    if (!/[-\x00-\x08\x0B\x0C\x0E-\x1F]/.test(trimmed) && !/^[?\s.\-=_]+$/.test(trimmed)) {
      if (!isMechanicalAgentName(trimmed)) {
        return trimmed;
      }
    }
  }

  // 优先尝试使用意图摘要进行语义化命名
  if (intentSummary && typeof intentSummary === 'string' && intentSummary.trim()) {
    const cleanIntent = intentSummary.trim();
    if (!isMechanicalAgentName(cleanIntent) && !/^[?\s.\-=_]+$/.test(cleanIntent)) {
      return cleanIntent.length > 36 ? cleanIntent.slice(0, 36) : cleanIntent;
    }
  }

  const parts = (agentId || '').split('-');
  const prov = (provider || parts[0] || 'agent').toLowerCase();
  const provMap = {
    'claude': 'Claude 助手',
    'claude-fable': 'Claude Fable 助手',
    'claude-sonnet': 'Claude Sonnet 助手',
    'claude-opus': 'Claude Opus 助手',
    'codex': 'Codex 助手',
    'zcode': 'ZCode 助手',
    'system': 'Nexus 协调器',
    'nexus': 'Nexus 协调器',
    'agent': '协同助手'
  };
  return provMap[prov] || (prov.charAt(0).toUpperCase() + prov.slice(1) + ' 助手');
}

// 全局在席 Agent 响应式注册表与精准名称解析器
const globalAgentMap = new Map(); // agentId -> { id, name, displayName, provider }

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
        const resolved = formatAgentDisplayName(candidateName, c.agent_id);
        globalAgentMap.set(c.agent_id, {
          id: c.agent_id,
          name: candidateName,
          displayName: resolved
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
  if (!agentId || agentId === 'system' || agentId === 'nexus') {
    return 'Nexus 协调器';
  }
  // 1. 若外部提供了合法的人类赋予名称，优先采用
  if (fallbackName && typeof fallbackName === 'string' && fallbackName.trim()) {
    const clean = fallbackName.trim();
    if (!isMechanicalAgentName(clean)) {
      return clean;
    }
  }
  // 2. 从全局会话注册表查找
  if (globalAgentMap.has(agentId)) {
    const reg = globalAgentMap.get(agentId);
    if (reg.name && !isMechanicalAgentName(reg.name)) return reg.name;
    if (reg.displayName && !isMechanicalAgentName(reg.displayName)) return reg.displayName;
  }
  // 3. 回退至格式化标准化名称 (例如 Claude 助手，绝非机械编号)
  return formatAgentDisplayName(fallbackName, agentId);
}

// DOM 元素缓存
const dom = {
  // 顶栏与状态条
  liveDot: document.getElementById('live-dot'),
  daemonStatus: document.getElementById('daemon-status'),
  projectSelector: document.getElementById('project-selector'),
  btnBroadcastToggle: document.getElementById('btn-broadcast-toggle'),
  themeToggleBtn: document.getElementById('theme-toggle-btn'),
  btnRefresh: document.getElementById('btn-refresh'),

  // 统计指标
  statWorking: document.getElementById('stat-working'),
  statWaiting: document.getElementById('stat-waiting'),
  statLocks: document.getElementById('stat-locks'),
  leadStatusChip: document.getElementById('lead-status-chip'),
  leadTickerText: document.getElementById('lead-ticker-text'),

  // 浮动气泡
  broadcastPopover: document.getElementById('broadcast-popover'),
  btnBroadcastClose: document.getElementById('btn-broadcast-close'),
  masterBroadcastInput: document.getElementById('master-broadcast-input'),
  masterBroadcastUrgent: document.getElementById('master-broadcast-urgent'),
  masterBroadcastBtn: document.getElementById('master-broadcast-btn'),

  leadAdvicePopover: document.getElementById('lead-advice-popover'),
  btnLeadClose: document.getElementById('btn-lead-close'),
  leadAdviceContainer: document.getElementById('lead-advice-container'),
  leadAwakenedDetail: document.getElementById('lead-awakened-detail'),

  // 导航切换
  navSegmented: document.getElementById('nav-segmented'),
  segBtns: document.querySelectorAll('.seg-btn'),
  viewPanels: document.querySelectorAll('.view-panel'),

  // View 1: Sessions & Collision Prevention
  agentsMeta: document.getElementById('agents-meta'),
  agentsContainer: document.getElementById('agents-container'),
  locksMeta: document.getElementById('locks-meta'),
  locksContainer: document.getElementById('locks-container'),
  conflictAlert: document.getElementById('conflict-alert'),
  timelineContainer: document.getElementById('timeline-container'),
  streamFilterBtns: document.querySelectorAll('.filter-pill'),
  paneLeft: document.querySelector('.pane-left'),
  flexAgents: document.querySelector('.flex-agents'),
  resizerAgentsLocks: document.getElementById('resizer-agents-locks'),
  resizerSessionsSplit: document.getElementById('resizer-sessions-split'),

  // View 2: Stream & Logs
  dialogueCounter: document.getElementById('dialogue-counter'),
  dialogueStream: document.getElementById('dialogue-stream'),
  milestonesCounter: document.getElementById('milestones-counter'),
  milestonesContainer: document.getElementById('milestones-container'),
  resizerDialogueMilestones: document.getElementById('resizer-dialogue-milestones'),

  // View 3: Routing & Conflict Map (会话路由与走廊网关)
  tabRouting: document.getElementById('tab-routing'),
  viewRouting: document.getElementById('view-routing'),
  routingSummaryMeta: document.getElementById('routing-summary-meta'),
  routingCanvasWrapper: document.getElementById('routing-canvas-wrapper'),
  routingSvgLayer: document.getElementById('routing-svg-layer'),
  routingSessionsContainer: document.getElementById('routing-sessions-container'),
  badgeSessionsCount: document.getElementById('badge-sessions-count'),
  nexusHubCard: document.getElementById('nexus-hub-card'),
  hubStatusText: document.getElementById('hub-status-text'),
  hubStatusDot: document.getElementById('hub-status-dot'),
  routingTargetsContainer: document.getElementById('routing-targets-container'),
  badgeTargetsCount: document.getElementById('badge-targets-count'),
  routingDecisionsPanel: document.getElementById('routing-decisions-panel'),
  routingDecisionsStream: document.getElementById('routing-decisions-stream'),
  decisionsCountBadge: document.getElementById('decisions-count-badge'),
  decisionsFilterBtns: document.querySelectorAll('.d-filter-btn'),
  btnToggleDecisions: document.getElementById('btn-toggle-decisions'),
  resizerRoutingDecisions: document.getElementById('resizer-routing-decisions')
};

// =============================================================================
// Theme Management (暗色 / 亮色持久化与实时切换)
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
    dom.themeToggleBtn.setAttribute('title', theme === 'dark' ? '当前暗色外观，点击切换亮色' : '当前亮色外观，点击切换暗色');
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || getPreferredTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('nexusTheme', next);
  updateThemeUI(next);
}

if (dom.themeToggleBtn) {
  dom.themeToggleBtn.onclick = toggleTheme;
}

try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('nexusTheme')) {
      updateThemeUI(e.matches ? 'dark' : 'light');
    }
  });
} catch {}

updateThemeUI(getPreferredTheme());

// =============================================================================
// View Navigation (3-Tab Segmented Control)
// =============================================================================
function switchView(viewName) {
  dom.segBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  dom.viewPanels.forEach(panel => {
    panel.classList.toggle('active', panel.id === `view-${viewName}`);
  });

  // 切换到视图后若尚未加载数据，立即触发一次
  if (viewName === 'timeline') {
    fetchDialogues();
    fetchMilestones();
  } else if (viewName === 'routing') {
    fetchRoutingTopology();
    setTimeout(() => requestAnimationFrame(drawRoutingConnectors), 60);
  } else {
    fetchDashboard();
  }
}

dom.segBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    if (view) switchView(view);
  });
});

// =============================================================================
// Popover Toggle Handlers (Broadcast & Tech Lead)
// =============================================================================
function toggleBroadcastPopover(show) {
  if (!dom.broadcastPopover) return;
  const isCurrentlyHidden = dom.broadcastPopover.hasAttribute('hidden') || dom.broadcastPopover.style.display === 'none';
  const shouldShow = typeof show === 'boolean' ? show : isCurrentlyHidden;

  if (shouldShow) {
    dom.broadcastPopover.removeAttribute('hidden');
    dom.broadcastPopover.style.display = 'flex';
    if (dom.leadAdvicePopover) {
      dom.leadAdvicePopover.setAttribute('hidden', '');
      dom.leadAdvicePopover.style.display = 'none';
    }
    setTimeout(() => dom.masterBroadcastInput?.focus(), 50);
  } else {
    dom.broadcastPopover.setAttribute('hidden', '');
    dom.broadcastPopover.style.display = 'none';
  }
}

function toggleLeadPopover(show) {
  if (!dom.leadAdvicePopover) return;
  const isCurrentlyHidden = dom.leadAdvicePopover.hasAttribute('hidden') || dom.leadAdvicePopover.style.display === 'none';
  const shouldShow = typeof show === 'boolean' ? show : isCurrentlyHidden;

  if (shouldShow) {
    dom.leadAdvicePopover.removeAttribute('hidden');
    dom.leadAdvicePopover.style.display = 'flex';
    if (dom.broadcastPopover) {
      dom.broadcastPopover.setAttribute('hidden', '');
      dom.broadcastPopover.style.display = 'none';
    }
  } else {
    dom.leadAdvicePopover.setAttribute('hidden', '');
    dom.leadAdvicePopover.style.display = 'none';
  }
}

if (dom.btnBroadcastToggle) {
  dom.btnBroadcastToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBroadcastPopover();
  });
}

if (dom.btnBroadcastClose) {
  dom.btnBroadcastClose.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    toggleBroadcastPopover(false);
  });
}

if (dom.leadStatusChip) {
  dom.leadStatusChip.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLeadPopover();
  });
}

if (dom.btnLeadClose) {
  dom.btnLeadClose.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    toggleLeadPopover(false);
  });
}

// 快捷键 ESC 退出弹窗
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    toggleBroadcastPopover(false);
    toggleLeadPopover(false);
  }
});

// 点击空白区域自动收起弹出气泡
document.addEventListener('click', (e) => {
  if (dom.broadcastPopover && !dom.broadcastPopover.hasAttribute('hidden') && dom.broadcastPopover.style.display !== 'none') {
    if (!dom.broadcastPopover.contains(e.target) && !dom.btnBroadcastToggle?.contains(e.target)) {
      toggleBroadcastPopover(false);
    }
  }
  if (dom.leadAdvicePopover && !dom.leadAdvicePopover.hasAttribute('hidden') && dom.leadAdvicePopover.style.display !== 'none') {
    if (!dom.leadAdvicePopover.contains(e.target) && !dom.leadStatusChip?.contains(e.target)) {
      toggleLeadPopover(false);
    }
  }
});

// 刷新按钮
if (dom.btnRefresh) {
  dom.btnRefresh.onclick = () => {
    loadProjects();
    fetchDashboard();
    fetchDialogues();
    fetchMilestones();
    if (dom.viewRouting?.classList.contains('active')) {
      fetchRoutingTopology();
    }
  };
}

// =============================================================================
// Project Selection & Persistence
// =============================================================================
function selectProject(projectId) {
  currentProjectId = projectId;
  localStorage.setItem('nexusProjectId', currentProjectId);
  if (dom.projectSelector) {
    dom.projectSelector.value = currentProjectId;
  }
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    try {
      activeWs.send(JSON.stringify({ type: 'sync:request', project_id: currentProjectId }));
    } catch {}
  }
  fetchDashboard();
  fetchDialogues();
  fetchMilestones();
  if (dom.viewRouting?.classList.contains('active')) {
    fetchRoutingTopology();
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
  dom.projectSelector.onchange = () => {
    selectProject(dom.projectSelector.value);
  };
}

async function loadProjects() {
  try {
    const res = await fetch('/api/projects', { headers: authHeaders() });
    if (res.status === 401) {
      updateConnectionIndicators(false, '令牌无效 (401)');
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
    for (const p of uniqueProjects) {
      globalProjectsMap.set(p.id, p);
    }
    totalGlobalOnlineAgents = uniqueProjects.reduce((sum, p) => sum + (p.online_agents_count || 0), 0);

    const qProject = new URLSearchParams(location.search).get('project') || new URLSearchParams(location.search).get('project_id');
    const savedProjectId = qProject || localStorage.getItem('nexusProjectId');

    // 自动迁移历史存留的 'Agent-Nexus' 字符串为真实的 project hash ID
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
      const found = uniqueProjects.find(p => p.id === effectiveSavedId);
      if (found) {
        targetProject = found;
      }
    }

    // 默认工程策略：优先全景工程 (跨项目总览)，避免用户开启多会话却被默认锁进单工程只显示两三个
    if (!targetProject) {
      targetProject = { id: 'all' };
    }

    if (targetProject) {
      currentProjectId = targetProject.id;
      localStorage.setItem('nexusProjectId', currentProjectId);
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        try {
          activeWs.send(JSON.stringify({ type: 'sync:request', project_id: currentProjectId }));
        } catch {}
      }
    }

    const totalOnline = uniqueProjects.reduce((sum, p) => sum + (p.online_agents_count || 0), 0);
    const allLabel = totalOnline > 0 ? `全景工程 (跨项目 · ${totalOnline} 在席)` : '全景工程 (跨项目)';
    const allOption = `<option value="all" ${currentProjectId === 'all' ? 'selected' : ''}>${allLabel}</option>`;
    const projectOptions = uniqueProjects.map(p => {
      const idSafe = escapeHtml(p.id);
      const baseName = p.display_name || p.id;
      const countSuffix = (p.online_agents_count && p.online_agents_count > 0) ? ` (${p.online_agents_count} 在席)` : '';
      const nameSafe = escapeHtml(baseName + countSuffix);
      const selected = (p.id === currentProjectId && currentProjectId !== 'all') ? 'selected' : '';
      return `<option value="${idSafe}" ${selected}>${nameSafe}</option>`;
    }).join('');

    dom.projectSelector.innerHTML = allOption + projectOptions;

    fetchDashboard();
    fetchDialogues();
    fetchMilestones();
    if (dom.viewRouting?.classList.contains('active')) {
      fetchRoutingTopology();
    }
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
}

// =============================================================================
// Dashboard Data & Rendering
// =============================================================================
async function fetchDashboard() {
  try {
    const res = await fetch(`/api/dashboard?project_id=${encodeURIComponent(currentProjectId)}`, { headers: authHeaders() });
    if (res.status === 401) {
      updateConnectionIndicators(false, '令牌无效 (401)');
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

  // 1. 统计计算
  const workingCount = agents.filter(a => a.lifecycle_state === 'working' || a.status === 'running').length;
  const waitingCount = agents.filter(a => a.lifecycle_state === 'waiting' || a.status === 'waiting' || !!a.blocked_reason).length;
  const locksCount = activeClaims.length;

  if (dom.statWorking) dom.statWorking.textContent = workingCount;
  if (dom.statWaiting) dom.statWaiting.textContent = waitingCount;
  if (dom.statLocks) dom.statLocks.textContent = locksCount;

  // 2. 架构师 Ticker 胶囊更新
  updateLeadStatus(workingCount, waitingCount);

  // 3. 渲染在席助手与锁定资源
  renderActiveAgents(agents, activeClaims);
  renderActiveLocks(activeClaims, agents);
  renderLiveTimeline(timeline);
}

function updateLeadStatus(workingCount, waitingCount) {
  if (!dom.leadStatusChip || !dom.leadTickerText) return;
  const activeCount = workingCount + waitingCount;

  if (activeCount <= 1 && waitingCount === 0) {
    dom.leadStatusChip.className = 'lead-ticker-btn chip-silent';
    dom.leadTickerText.textContent = 'Tech Lead: 静默保驾';
    if (dom.leadAdviceContainer && !dom.leadAdviceContainer.getAttribute('data-sticky')) {
      dom.leadAdviceContainer.innerHTML = '[Nexus 架构师静默保驾] 当前无多会话写冲突，架构师保持静默。当检测到并发修改同文件或排队时，将实时唤醒并提供避让重排与交接路线。';
    }
  } else {
    dom.leadStatusChip.className = 'lead-ticker-btn chip-active';
    dom.leadTickerText.textContent = waitingCount > 0 ? `Tech Lead: 避障排队中 (${waitingCount})` : 'Tech Lead: 多人协同保驾';
  }
}

function handleLeadAwakened(data) {
  if (!dom.leadStatusChip || !dom.leadAdviceContainer) return;
  dom.leadStatusChip.className = 'lead-ticker-btn chip-active';
  dom.leadTickerText.textContent = 'Tech Lead: 协同避障已唤醒';

  const joiningId = escapeHtml(data.joining_agent_id);
  const activeCount = data.active_peer_count || 1;
  const conflictsCount = data.conflicts_count || 0;

  dom.leadAdviceContainer.setAttribute('data-sticky', 'true');
  dom.leadAdviceContainer.innerHTML = `
    <strong>[架构师实时唤醒提醒]</strong>
    检测到新会话 <strong>${joiningId}</strong> 加入工作区（在席活跃会话: ${activeCount} 个，潜在写冲突: ${conflictsCount} 项）。
    已完成全景信息聚合，避让重排指引已就绪！
  `;

  if (dom.leadAwakenedDetail && data.peer_sessions && data.peer_sessions.length > 0) {
    dom.leadAwakenedDetail.style.display = 'block';
    dom.leadAwakenedDetail.innerHTML = `
      <div class="lead-peer-title">在席会话施工现场</div>
      ${data.peer_sessions.map(p => `
        <div class="lead-peer-item">
          <span class="lead-peer-name">${escapeHtml(p.name)}</span>
          <span class="lead-peer-intent">意图 "${escapeHtml(p.currentIntent || '无')}"</span>
          <span class="lead-peer-locks">独占锁 ${p.activeLeasesCount || 0} 个</span>
        </div>
      `).join('')}
    `;
  }
}

// 渲染活跃助手 (只渲染 working / waiting / idle，过滤掉离线僵尸会话)
let lastAgentsHtml = null;
let lastAgentsMetaHtml = null;

function renderActiveAgents(agents, activeClaims) {
  if (!dom.agentsContainer) return;

  const validAgents = [];
  const claimsList = activeClaims || [];

  for (const a of (agents || [])) {
    if (a.lifecycle_state === 'departed' || a.is_online === false) continue;

    const claims = claimsList.filter(c => c.agent_id === a.id);
    const isWorking = a.lifecycle_state === 'working' ||
                      a.status === 'running' ||
                      claims.length > 0;

    const isWaiting = !isWorking && (
      a.lifecycle_state === 'waiting' ||
      a.status === 'waiting' ||
      !!a.blocked_reason
    );

    if (isWorking) {
      validAgents.push({ ...a, resolvedClaims: claims, uiState: 'working', badgeText: '施工中' });
    } else if (isWaiting) {
      validAgents.push({ ...a, resolvedClaims: claims, uiState: 'waiting', badgeText: '排队中' });
    } else {
      // 保持在线但暂未持有写锁的就绪助手
      validAgents.push({ ...a, resolvedClaims: claims, uiState: 'idle', badgeText: '待命' });
    }
  }

  if (dom.agentsMeta) {
    const remoteOnlineCount = validAgents.filter(a => a.is_remote).length;
    const remoteTag = remoteOnlineCount > 0 ? ` · 含远端 ${remoteOnlineCount}` : '';
    let metaHtml;
    if (currentProjectId === 'all') {
      metaHtml = `<span class="agents-count-highlight">${validAgents.length}</span> 个在席 · 跨项目全景${remoteTag}`;
    } else {
      const globalCount = totalGlobalOnlineAgents > validAgents.length ? totalGlobalOnlineAgents : validAgents.length;
      const overviewHint = globalCount > validAgents.length
        ? ` <span class="global-overview-hint">(全局跨项目 ${globalCount} 个会话 · <a href="javascript:void(0)" onclick="nexusSelectProject('all')" class="view-all-link">查看全景</a>)</span>`
        : '';
      metaHtml = `<span class="agents-count-highlight">${validAgents.length}</span> 个在席${remoteTag}${overviewHint}`;
    }
    if (metaHtml !== lastAgentsMetaHtml) {
      dom.agentsMeta.innerHTML = metaHtml;
      lastAgentsMetaHtml = metaHtml;
    }
  }

  if (validAgents.length === 0) {
    const emptyHtml = '<div class="empty-hint">暂无活跃会话，当 Coding Assistant / Codex 启动时将自动感知接入</div>';
    if (emptyHtml !== lastAgentsHtml) {
      dom.agentsContainer.innerHTML = emptyHtml;
      lastAgentsHtml = emptyHtml;
    }
    return;
  }

  const agentsHtml = validAgents.map(a => {
    const displayName = formatAgentDisplayName(a.name, a.id, a.provider, a.session_id, a.current_intent || a.current_intent_summary);
    const nameSafe = escapeHtml(displayName);
    const providerSafe = escapeHtml((a.provider || 'Claude').toUpperCase());
    const intentSafe = escapeHtml(a.current_intent || a.current_action || '就绪待命中');
    const toolSafe = a.last_tool ? escapeHtml(a.last_tool) : null;
    const targetSafe = a.last_target ? escapeHtml(a.last_target.split(/[\/\\]/).pop()) : null;
    const claims = a.resolvedClaims || [];
    const projName = getProjectDisplayName(a.project_id, a.workspace_dir);
    const projSafe = escapeHtml(projName);
    const showProj = (currentProjectId === 'all' || !currentProjectId) && projSafe;
    const hostSafe = a.is_remote && a.host_id ? escapeHtml(a.host_id) : '';
    const showHost = Boolean(hostSafe) && (!showProj || !projName.includes(`[${a.host_id}]`));

    return `
      <div class="agent-card-item is-${a.uiState}">
        <div class="agent-card-header">
          <div class="agent-name-group">
            <span class="agent-status-badge badge-${a.uiState}">${a.badgeText}</span>
            <span class="agent-title" title="${nameSafe}">${nameSafe}</span>
            ${showHost ? `<span class="agent-host-badge" title="远端工作区节点: ${hostSafe}"><svg class="inline-badge-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:3px;opacity:0.85"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>${hostSafe}</span>` : ''}
            ${showProj ? `<span class="agent-project-badge" title="所属工程: ${projSafe}">${projSafe}</span>` : ''}
          </div>
          <span class="agent-runtime-tag">${providerSafe}</span>
        </div>

        <div class="agent-intent-line" title="${intentSafe}">
          ${toolSafe ? `<span class="agent-claim-target">[${toolSafe}] ${targetSafe || ''}</span> ` : ''}
          ${intentSafe}
        </div>

        ${claims.length > 0 ? `
          <div class="agent-card-footer">
            <span>持锁 (${claims.length}): ${claims.map(c => escapeHtml(c.claim_target.split(/[\/\\]/).pop())).join(', ')}</span>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  // 内容没变就不重写 DOM：整块 innerHTML 重建会让卡片里的脉冲动画
  // 每 3 秒从头播放，看起来像"一直闪"。
  if (agentsHtml !== lastAgentsHtml) {
    dom.agentsContainer.innerHTML = agentsHtml;
    lastAgentsHtml = agentsHtml;
  }
}

// 渲染锁定资源与文件
function renderActiveLocks(claims, agents) {
  if (!dom.locksContainer) return;

  if (dom.locksMeta) {
    dom.locksMeta.textContent = `${(claims || []).length} 项锁定`;
  }

  // 检查是否有排队冲突并置顶提示
  const waitingAgents = (agents || []).filter(a => a.lifecycle_state === 'waiting' || a.status === 'waiting' || !!a.blocked_reason);
  if (dom.conflictAlert) {
    if (waitingAgents.length > 0) {
      dom.conflictAlert.style.display = 'flex';
      const waiter = waitingAgents[0];
      const waiterName = escapeHtml(formatAgentDisplayName(waiter.name, waiter.id));
      const reason = escapeHtml(waiter.blocked_reason || '等待资源锁释放');
      dom.conflictAlert.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <span><strong>${waiterName}</strong> 避让中: ${reason}</span>
      `;
    } else {
      dom.conflictAlert.style.display = 'none';
    }
  }

  if (!claims || claims.length === 0) {
    dom.locksContainer.innerHTML = '<div class="empty-hint">当前无活跃独占锁，所有写入与命令均可畅行</div>';
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
          <span class="lock-holder-desc"><strong class="holder-name" title="完整会话标识: ${escapeHtml(c.agent_id)}">${holderName}</strong>${holderHost ? ` <span class="agent-host-badge"><svg class="inline-badge-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:3px;opacity:0.85"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"></path></svg>${holderHost}</span>` : ''} · 剩余 ${remainingSec}s</span>
        </div>
        <div class="lock-actions">
          ${leaseId ? `<button class="btn-release-sm" onclick="releaseLock('${leaseId}', '${escapeHtml(c.agent_id)}')">释放</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// 释放锁
window.releaseLock = async function(leaseId, agentId) {
  try {
    const res = await fetch(`/api/leases/${encodeURIComponent(leaseId)}/release`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent_id: agentId })
    });
    if (res.ok) {
      fetchDashboard();
    }
  } catch (err) {
    console.error('Failed to release lock:', err);
  }
};

// 渲染时间线流水 (Live Stream)
function renderLiveTimeline(timeline) {
  if (!dom.timelineContainer) return;

  let filtered = timeline || [];
  if (currentTimelineFilter === 'conflict') {
    filtered = filtered.filter(item => item.event_type && (item.event_type.includes('blocked') || item.event_type.includes('waiting') || item.event_type.includes('conflict')));
  } else if (currentTimelineFilter === 'release') {
    filtered = filtered.filter(item => item.event_type && (item.event_type.includes('release') || item.event_type.includes('freed')));
  }

  if (filtered.length === 0) {
    dom.timelineContainer.innerHTML = '<div class="empty-hint">暂无匹配的协同事件</div>';
    return;
  }

  dom.timelineContainer.innerHTML = filtered.map(item => {
    const timeStr = escapeHtml(new Date(item.created_at).toTimeString().split(' ')[0]);
    let badgeClass = 'badge-claim';
    let badgeLabel = 'CLAIM';

    const evt = item.event_type || '';
    if (evt.includes('blocked') || evt.includes('conflict') || evt.includes('waiting')) {
      badgeClass = 'badge-conflict';
      badgeLabel = 'BLOCKED';
    } else if (evt.includes('release') || evt.includes('freed')) {
      badgeClass = 'badge-release';
      badgeLabel = 'RELEASE';
    } else if (evt.includes('broadcast') || evt.includes('lead')) {
      badgeClass = 'badge-lead';
      badgeLabel = 'LEAD';
    }

    const actor = escapeHtml(formatAgentDisplayName(item.agent_name, item.agent_id));
    const desc = escapeHtml(item.description);

    return `
      <div class="stream-item">
        <div class="stream-item-top">
          <span class="stream-badge ${badgeClass}">${badgeLabel}</span>
          <span>${timeStr}</span>
        </div>
        <div class="stream-item-desc">
          <strong>${actor}</strong>: ${desc}
        </div>
      </div>
    `;
  }).join('');
}

// 切换时间线过滤 Pill
dom.streamFilterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    dom.streamFilterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTimelineFilter = btn.dataset.filter || 'all';
    renderLiveTimeline(currentTimelineData);
  });
});

// =============================================================================
// Dialogue & Milestones (View 2)
// =============================================================================
async function fetchDialogues() {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProjectId)}/dialogue`, { headers: authHeaders() });
    if (!res.ok) return;
    const list = await res.json();
    if (!Array.isArray(list)) return;

    if (dom.dialogueCounter) {
      dom.dialogueCounter.textContent = `${list.length} 条记录`;
    }
    if (!dom.dialogueStream) return;

    if (list.length === 0) {
      dom.dialogueStream.innerHTML = '<div class="empty-hint">暂无跨会话对答，当助手之间发送协作消息时将在此实时呈现</div>';
      return;
    }

    dom.dialogueStream.innerHTML = list.map(m => {
      const timeStr = escapeHtml(new Date(m.created_at).toTimeString().split(' ')[0]);
      const fromSafe = escapeHtml(formatAgentDisplayName(m.from_agent_name, m.from_agent));
      const toSafe = m.to_agent ? `@${escapeHtml(formatAgentDisplayName(m.to_agent_name, m.to_agent))}` : 'BROADCAST';
      const typeSafe = escapeHtml((m.dialogue_type || 'chat').toUpperCase());
      const contentSafe = escapeHtml(m.content);

      return `
        <div class="dialogue-item">
          <div class="dialogue-meta">
            <span class="dialogue-actors">${fromSafe} → ${toSafe}</span>
            <span>[${typeSafe}] ${timeStr}</span>
          </div>
          <div class="dialogue-content">${contentSafe}</div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Fetch dialogues error:', err);
  }
}

async function fetchMilestones() {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProjectId)}/memories?category=milestone`, { headers: authHeaders() });
    if (!res.ok) return;
    const list = await res.json();
    if (!Array.isArray(list)) return;

    if (dom.milestonesCounter) {
      dom.milestonesCounter.textContent = `${list.length} 项闭环产出`;
    }
    if (!dom.milestonesContainer) return;

    if (list.length === 0) {
      dom.milestonesContainer.innerHTML = '<div class="empty-hint">暂无里程碑记录，当调用 nexus_report_milestone 或任务闭环释放时沉淀于此</div>';
      return;
    }

    dom.milestonesContainer.innerHTML = list.map(m => {
      const timeStr = escapeHtml(new Date(m.created_at || Date.now()).toLocaleDateString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
      const keySafe = escapeHtml(m.key);
      const contentSafe = escapeHtml(m.content);

      return `
        <div class="milestone-item">
          <span class="milestone-dot"></span>
          <div class="milestone-text">
            <div class="milestone-desc"><strong>${keySafe}</strong>: ${contentSafe}</div>
            <div class="milestone-time">${timeStr}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Fetch milestones error:', err);
  }
}

// =============================================================================
// Routing Topology & Conflict Map (View 3: 会话路由与走廊网关)
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

function computeSafeCorridors(activeClaims, resourceLocks, topology) {
  const lockedTargets = new Set();
  (activeClaims || []).forEach(c => {
    const t = c.claim_target || c.path || '';
    if (t) lockedTargets.add(t.toLowerCase().replace(/\\/g, '/'));
  });
  (resourceLocks || []).forEach(l => {
    const n = l.resource_name || l.name || '';
    if (n) lockedTargets.add(n.toLowerCase());
  });

  const candidateCorridors = [
    { id: 'corridor:test', name: 'test/ 单元与回归测试', desc: '测试用例套件 · 互不干扰推荐并发区', prefix: 'test/' },
    { id: 'corridor:desktop', name: 'desktop/ 桌面主进程与托盘', desc: 'Electron 壳体与原生交互通道', prefix: 'desktop/' },
    { id: 'corridor:docs', name: 'docs/ 架构文档与规约', desc: '工程文档与设计说明走廊', prefix: 'docs/' },
    { id: 'corridor:scripts', name: 'scripts/ 构建与打包流水线', desc: 'CI/CD 与本地发布脚本走廊', prefix: 'scripts/' },
    { id: 'corridor:gateway', name: 'src/gateway/ AI 弹性网关', desc: '模型故障转移与熔断路由器', prefix: 'src/gateway/' },
    { id: 'corridor:transport', name: 'src/transport/ 通信传输层', desc: 'HTTP/REST 与 WebSocket 协议通道', prefix: 'src/transport/' }
  ];

  return candidateCorridors.map(cor => {
    let hasContention = false;
    for (const locked of lockedTargets) {
      if (locked.startsWith(cor.prefix.toLowerCase()) || locked === cor.prefix.replace('/', '').toLowerCase()) {
        hasContention = true;
        break;
      }
    }
    return {
      ...cor,
      status: hasContention ? 'contended' : 'safe'
    };
  });
}

function formatShortAgent(agentId) {
  if (!agentId) return '未知会话';
  if (agentId === 'system' || agentId === 'nexus') return 'Nexus 协调器';
  const resolved = resolveAgentName(agentId);
  if (resolved && !isMechanicalAgentName(resolved)) {
    return resolved;
  }
  const str = String(agentId);
  if (str.startsWith('claude-')) {
    const rest = str.slice(7);
    const shortPart = rest.split('-')[0] || rest.slice(0, 8);
    return `claude-${shortPart}`;
  }
  if (str.startsWith('codex-')) {
    const rest = str.slice(6);
    const shortPart = rest.split('-')[0] || rest.slice(0, 8);
    return `codex-${shortPart}`;
  }
  if (str.length > 18) {
    return str.slice(0, 14) + '...';
  }
  return str;
}

function splitPathForDisplay(fullPath) {
  if (!fullPath) return { dir: '', name: '未知目标', full: '' };
  const normalized = String(fullPath).replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) {
    return { dir: '', name: normalized, full: normalized };
  }
  const dir = normalized.slice(0, lastSlash + 1);
  const name = normalized.slice(lastSlash + 1);
  const parts = dir.split('/').filter(Boolean);
  let shortDir = dir;
  if (parts.length > 2) {
    shortDir = '.../' + parts.slice(-2).join('/') + '/';
  }
  return { dir: shortDir, name, full: normalized };
}

function renderRoutingDiagram(cockpitData) {
  if (!dom.routingCanvasWrapper) return;
  lastRoutingData = cockpitData;

  const dashboard = cockpitData.dashboard || cockpitData;
  const collab = cockpitData.collab || { nodes: [], edges: [] };
  const rawAgents = dashboard.agents || collab.nodes?.filter(n => n.node_type === 'session') || [];
  const activeClaims = cockpitData.lockContention?.activeClaims || dashboard.activeClaims || [];
  const resourceLocks = cockpitData.lockContention?.resourceLocks || collab.exclusiveLocks || [];
  const waitQueue = cockpitData.lockContention?.waitQueue || dashboard.waitQueue || [];
  const timeline = dashboard.recentTimeline || dashboard.timeline || [];

  updateGlobalAgentRegistry(rawAgents, activeClaims, timeline);

  // 过滤离线僵尸会话
  const validAgents = [];
  for (const a of rawAgents) {
    if (a.lifecycle_state === 'departed' || a.is_online === false) continue;
    const claims = activeClaims.filter(c => c.agent_id === a.id);
    const isWorking = a.lifecycle_state === 'working' || a.status === 'running' || claims.length > 0;
    const isWaiting = !isWorking && (a.lifecycle_state === 'waiting' || a.status === 'waiting' || !!a.blocked_reason);
    const uiState = isWorking ? 'working' : (isWaiting ? 'waiting' : 'idle');
    validAgents.push({ ...a, resolvedClaims: claims, uiState });
  }

  // 1. 顶部指标摘要
  if (dom.routingSummaryMeta) {
    if (currentProjectId === 'all') {
      dom.routingSummaryMeta.innerHTML = `<span class="routing-metric-highlight">${validAgents.length}</span> 个在席会话 · ${activeClaims.length + resourceLocks.length} 项独占锁 · ${waitQueue.length} 处冲突等待 <span class="routing-scope-pill">全景跨项目</span>`;
    } else {
      const globalCount = totalGlobalOnlineAgents > validAgents.length ? totalGlobalOnlineAgents : validAgents.length;
      const overviewHint = globalCount > validAgents.length
        ? ` <span class="global-overview-hint">(跨项目共 ${globalCount} 个会话 · <a href="javascript:void(0)" onclick="nexusSelectProject('all')" class="view-all-link">查看全景</a>)</span>`
        : '';
      dom.routingSummaryMeta.innerHTML = `${validAgents.length} 个在席会话 · ${activeClaims.length + resourceLocks.length} 项独占锁 · ${waitQueue.length} 处冲突等待${overviewHint}`;
    }
  }
  if (dom.badgeSessionsCount) dom.badgeSessionsCount.textContent = validAgents.length;

  // 2. Nexus 中枢实时状态更新 (去除假数据与硬编码，真实响应排队与施工状态)
  if (dom.hubStatusText) {
    if (waitQueue.length > 0) {
      dom.hubStatusText.textContent = `冲突排队避让中 (${waitQueue.length} 处)`;
      dom.hubStatusDot?.classList.add('dot-waiting');
      dom.nexusHubCard?.classList.add('hub-state-waiting');
    } else if (activeClaims.length > 0 || resourceLocks.length > 0) {
      dom.hubStatusText.textContent = '实时并发仲裁中 · 通道畅通';
      dom.hubStatusDot?.classList.remove('dot-waiting');
      dom.nexusHubCard?.classList.remove('hub-state-waiting');
    } else {
      dom.hubStatusText.textContent = '并发仲裁就绪 · 零碰撞保驾';
      dom.hubStatusDot?.classList.remove('dot-waiting');
      dom.nexusHubCard?.classList.remove('hub-state-waiting');
    }
  }

  // 3. 渲染左侧 Lane 1: 会话源 (Sessions)
  if (dom.routingSessionsContainer) {
    if (validAgents.length === 0) {
      dom.routingSessionsContainer.innerHTML = '<div class="empty-hint">暂无在席会话，当 Claude Code / Codex 接入时自动路由</div>';
    } else {
      dom.routingSessionsContainer.innerHTML = validAgents.map(a => {
        const idSafe = escapeHtml(a.id);
        const resolvedName = resolveAgentName(a.id, a.name);
        const nameSafe = escapeHtml(resolvedName);
        const providerSafe = escapeHtml(a.provider || (a.id.includes('claude') ? 'Claude' : (a.id.includes('codex') ? 'Codex' : 'AI Agent')));
        const intentSafe = escapeHtml(a.current_intent_summary || a.current_intent || (a.uiState === 'idle' ? '待命中 · 监听工作区变更' : '执行任务中'));
        const toolSafe = escapeHtml(a.last_tool || a.last_action || (a.uiState === 'working' ? 'file:edit' : 'idle'));
        const claimsCount = a.resolvedClaims.length;
        const projName = getProjectDisplayName(a.project_id, a.workspace_dir);
        const projSafe = escapeHtml(projName);
        const showProj = (currentProjectId === 'all' || !currentProjectId) && projSafe;
        const hostSafe = a.is_remote && a.host_id ? escapeHtml(a.host_id) : '';
        const showHost = Boolean(hostSafe) && (!showProj || !projName.includes(`[${a.host_id}]`));

        let statusBadge = '<span class="session-status-tag status-idle"><span class="dot"></span>待命</span>';
        if (a.uiState === 'working') {
          statusBadge = '<span class="session-status-tag status-working"><span class="dot"></span>施工中</span>';
        } else if (a.uiState === 'waiting') {
          statusBadge = '<span class="session-status-tag status-waiting"><span class="dot"></span>排队避让</span>';
        }

        return `
          <div class="session-route-card state-${a.uiState}" data-session-id="${idSafe}">
            <div class="route-card-header">
              <div class="route-card-identity">
                <span class="route-agent-name" title="完整会话标识: ${idSafe}">${nameSafe}</span>
                <span class="route-provider-badge">${providerSafe}</span>
                ${showHost ? `<span class="route-host-badge" title="远端工作区节点: ${hostSafe}"><svg class="inline-badge-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:3px;opacity:0.85"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"></path></svg>${hostSafe}</span>` : ''}
                ${showProj ? `<span class="route-project-badge" title="所属工程: ${projSafe}">${projSafe}</span>` : ''}
              </div>
              ${statusBadge}
            </div>
            <div class="route-card-intent" title="${intentSafe}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
              </svg>
              <span>${intentSafe}</span>
            </div>
            <div class="route-card-footer">
              <span class="route-action-tag"><code>${toolSafe}</code></span>
              <span class="route-leases-tag">${claimsCount > 0 ? `独占 ${claimsCount} 项` : '无独占锁'}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 4. 计算走廊并渲染右侧 Lane 3: 目标文件与走廊 (Target Files & Corridors)
  const safeCorridors = computeSafeCorridors(activeClaims, resourceLocks, cockpitData.topologySnapshot || {});
  const targetsTotal = activeClaims.length + resourceLocks.length + safeCorridors.filter(c => c.status === 'safe').length;
  if (dom.badgeTargetsCount) dom.badgeTargetsCount.textContent = targetsTotal;

  if (dom.routingTargetsContainer) {
    let targetsHtml = '';

    // A. 独占施工文件 (File Leases)
    if (activeClaims.length > 0) {
      targetsHtml += `<div class="target-group-label">独占施工文件 (${activeClaims.length})</div>`;
      activeClaims.forEach(c => {
        const rawPath = c.claim_target || c.path || '';
        const pathSafe = escapeHtml(rawPath);
        const pathInfo = splitPathForDisplay(rawPath);
        const agentSafe = escapeHtml(c.agent_id);
        const resolvedHolder = resolveAgentName(c.agent_id, c.agent_name);
        const holderDisplay = escapeHtml(resolvedHolder);
        const now = Date.now();
        const remainingSec = c.expires_at ? Math.max(0, Math.ceil((c.expires_at - now) / 1000)) : 300;
        const resKey = `res:file:${pathSafe}`;

        targetsHtml += `
          <div class="target-route-card type-file" data-target-id="${resKey}" data-holder-id="${agentSafe}">
            <div class="target-card-header">
              <div class="target-icon-wrap file-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                  <polyline points="13 2 13 9 20 9"></polyline>
                </svg>
              </div>
              <div class="target-file-info" title="${pathSafe}">
                <span class="target-file-name">${escapeHtml(pathInfo.name)}</span>
                ${pathInfo.dir ? `<span class="target-file-dir">${escapeHtml(pathInfo.dir)}</span>` : ''}
              </div>
              <span class="target-status-badge badge-locked">LOCKED</span>
            </div>
            <div class="target-card-meta">
              <span class="target-holder">由 <strong class="holder-name" title="完整会话标识: ${agentSafe}">${holderDisplay}</strong> 独占</span>
              <span class="target-ttl-badge">~${remainingSec}s TTL</span>
            </div>
          </div>
        `;
      });
    }

    // B. 排他命名锁 (Named Locks)
    if (resourceLocks.length > 0) {
      targetsHtml += `<div class="target-group-label">排他命令与环境锁 (${resourceLocks.length})</div>`;
      resourceLocks.forEach(l => {
        const rawName = l.resource_name || l.name;
        const nameSafe = escapeHtml(rawName);
        const agentSafe = escapeHtml(l.agent_id);
        const resolvedHolder = resolveAgentName(l.agent_id, l.agent_name);
        const holderDisplay = escapeHtml(resolvedHolder);
        const resKey = `res:resource:${nameSafe}`;

        targetsHtml += `
          <div class="target-route-card type-lock" data-target-id="${resKey}" data-holder-id="${agentSafe}">
            <div class="target-card-header">
              <div class="target-icon-wrap lock-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
              </div>
              <div class="target-file-info" title="${nameSafe}">
                <span class="target-file-name">${nameSafe}</span>
                <span class="target-file-dir">命令排他锁</span>
              </div>
              <span class="target-status-badge badge-exclusive">EXCLUSIVE</span>
            </div>
            <div class="target-card-meta">
              <span class="target-holder">由 <strong class="holder-name" title="完整会话标识: ${agentSafe}">${holderDisplay}</strong> 持有</span>
              <span class="target-hook-badge">PostToolUse 释放</span>
            </div>
          </div>
        `;
      });
    }

    // C. 安全施工走廊 (Safe Corridors)
    const uncontendedCorridors = safeCorridors.filter(c => c.status === 'safe').slice(0, 3);
    if (uncontendedCorridors.length > 0) {
      targetsHtml += `<div class="target-group-label">安全施工走廊 (${uncontendedCorridors.length})</div>`;
      uncontendedCorridors.forEach(cor => {
        const corIdSafe = escapeHtml(cor.id);
        const corNameSafe = escapeHtml(cor.name);
        const corDescSafe = escapeHtml(cor.desc);

        targetsHtml += `
          <div class="target-route-card type-corridor" data-target-id="${corIdSafe}">
            <div class="target-card-header">
              <div class="target-icon-wrap corridor-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                  <polyline points="2 17 12 22 22 17"></polyline>
                  <polyline points="2 12 12 17 22 12"></polyline>
                </svg>
              </div>
              <div class="target-file-info" title="${corNameSafe}">
                <span class="target-file-name">${corNameSafe}</span>
                <span class="target-file-dir">${corDescSafe}</span>
              </div>
              <span class="target-status-badge badge-safe">SAFE 走廊</span>
            </div>
            <div class="target-card-meta">
              <span class="target-desc">架构师绿色通道</span>
              <span class="target-free-badge">零竞争可并发</span>
            </div>
          </div>
        `;
      });
    }

    if (!targetsHtml) {
      targetsHtml = '<div class="empty-hint">当前工作区无活跃独占锁，所有施工走廊均安全畅通</div>';
    }
    dom.routingTargetsContainer.innerHTML = targetsHtml;
  }

  // 5. 渲染底部路由与裁决决策流
  renderRoutingDecisions(timeline, activeClaims, waitQueue, safeCorridors);

  // 6. 绘制动态 Bezier 曲线连接器
  requestAnimationFrame(drawRoutingConnectors);

  // 7. 绑定卡片双向 Hover 高亮交互
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

  // 1. Sessions -> Nexus Hub 连线 (阶梯式进站导轨，彻底消除同点重合)
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

    svgHtml += `
      <path d="${d}" class="${lineClass}" data-from-session="${escapeHtml(sessionId)}" data-edge-type="session-hub" />
    `;
  });

  // 2. Nexus Hub -> Target Files / Corridors 连线 (阶梯式出站导轨，彻底消除汇聚重合)
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
    const isCorridor = card.classList.contains('type-corridor');
    const isFile = card.classList.contains('type-file');

    let lineClass = 'route-path route-target-line route-idle';
    if (isCorridor) {
      lineClass = 'route-path route-target-line route-corridor';
    } else if (isFile || card.classList.contains('type-lock')) {
      lineClass = 'route-path route-target-line route-active';
    }

    svgHtml += `
      <path d="${d}" class="${lineClass}" data-to-target="${escapeHtml(targetId)}" data-holder-id="${escapeHtml(holderId)}" data-edge-type="hub-target" />
    `;
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
  const paths = dom.routingSvgLayer.querySelectorAll('.route-path');
  paths.forEach(p => {
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
    if (tc.dataset.holderId === sessionId) {
      tc.classList.add('card-highlighted');
    } else {
      tc.classList.add('card-dimmed');
    }
  });
}

function highlightTargetRoutes(targetId, holderId) {
  if (!dom.routingSvgLayer) return;
  const paths = dom.routingSvgLayer.querySelectorAll('.route-path');
  paths.forEach(p => {
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
      if (sc.dataset.sessionId === holderId) {
        sc.classList.add('card-highlighted');
      } else {
        sc.classList.add('card-dimmed');
      }
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

function renderRoutingDecisions(timeline, activeClaims, waitQueue, safeCorridors) {
  if (!dom.routingDecisionsStream) return;

  const decisions = [];

  (timeline || []).forEach(item => {
    const type = item.type || '';
    const desc = item.description || item.detail || '';
    const agent = item.agent_id || 'system';
    const resolvedAgent = resolveAgentName(agent, item.agent_name);
    const agentDisplay = escapeHtml(resolvedAgent);
    const time = item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();

    if (type.includes('grant') || type.includes('claim') || desc.includes('拿到租约') || desc.includes('声明')) {
      decisions.push({
        type: 'grant',
        time,
        badge: 'GRANT 授权',
        title: `独占租约授予: 会话 <strong class="decision-agent" title="完整会话标识: ${escapeHtml(agent)}">${agentDisplay}</strong>`,
        detail: escapeHtml(desc || '零冲突快速放行，写入租约已下发')
      });
    } else if (type.includes('conflict') || type.includes('intercept') || desc.includes('冲突') || desc.includes('拦截') || desc.includes('WAITING')) {
      decisions.push({
        type: 'intercept',
        time,
        badge: 'INTERCEPT 拦截',
        title: `并发写入拦截: 会话 <strong class="decision-agent" title="完整会话标识: ${escapeHtml(agent)}">${agentDisplay}</strong>`,
        detail: escapeHtml(desc || '检测到文件写冲突，已安全挂起至排队队列')
      });
    } else if (type.includes('freed') || type.includes('release') || desc.includes('释放') || desc.includes('PostToolUse')) {
      decisions.push({
        type: 'release',
        time,
        badge: 'RELEASE 释放',
        title: `毫秒级租约释放: 会话 <strong class="decision-agent" title="完整会话标识: ${escapeHtml(agent)}">${agentDisplay}</strong>`,
        detail: escapeHtml(desc || 'PostToolUse 触发毫秒级锁回收，并自动唤醒队首排队者')
      });
    }
  });

  if (decisions.length === 0) {
    if ((activeClaims || []).length > 0) {
      activeClaims.forEach(c => {
        const pathInfo = splitPathForDisplay(c.claim_target || c.path);
        const resolvedAgent = resolveAgentName(c.agent_id, c.agent_name);
        const agentDisplay = escapeHtml(resolvedAgent);
        decisions.push({
          type: 'grant',
          time: new Date().toLocaleTimeString(),
          badge: 'GRANT 授权',
          title: `当前活跃独占租约: <strong class="decision-agent" title="完整会话标识: ${escapeHtml(c.agent_id)}">${agentDisplay}</strong>`,
          detail: `锁定目标 <code>${escapeHtml(pathInfo.name)}</code> <span class="decision-path-dir">${escapeHtml(pathInfo.dir)}</span> · 滑动窗口 TTL 续期中`
        });
      });
    }
    if ((waitQueue || []).length > 0) {
      waitQueue.forEach(w => {
        const pathInfo = splitPathForDisplay(w.target || '');
        const resolvedAgent = resolveAgentName(w.agent_id, w.agent_name);
        const agentDisplay = escapeHtml(resolvedAgent);
        decisions.push({
          type: 'intercept',
          time: new Date().toLocaleTimeString(),
          badge: 'INTERCEPT 拦截',
          title: `排队避障中: <strong class="decision-agent" title="完整会话标识: ${escapeHtml(w.agent_id)}">${agentDisplay}</strong>`,
          detail: `目标 <code>${escapeHtml(pathInfo.name)}</code> 受保护 · 等待当前持有者释放`
        });
      });
    }
    const safeList = (safeCorridors || []).filter(c => c.status === 'safe').map(c => c.name || c.prefix).join(', ');
    if (safeList) {
      decisions.push({
        type: 'grant',
        time: new Date().toLocaleTimeString(),
        badge: 'CORRIDOR 走廊',
        title: `架构师空闲走廊计算就绪`,
        detail: `安全并发走廊: <code>${escapeHtml(safeList)}</code> 畅通无阻`
      });
    }
  }

  const filtered = currentDecisionFilter === 'all'
    ? decisions
    : decisions.filter(d => d.type === currentDecisionFilter);

  if (dom.decisionsCountBadge) {
    dom.decisionsCountBadge.textContent = `${filtered.length} 条`;
  }

  if (filtered.length === 0) {
    dom.routingDecisionsStream.innerHTML = '<div class="empty-hint">暂无符合条件的路由裁决记录</div>';
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
      if (lastRoutingData) {
        renderRoutingDiagram(lastRoutingData);
      }
    };
  });
}

if (window.ResizeObserver && dom.routingCanvasWrapper) {
  const ro = new ResizeObserver(() => {
    if (dom.viewRouting?.classList.contains('active')) {
      requestAnimationFrame(drawRoutingConnectors);
    }
  });
  ro.observe(dom.routingCanvasWrapper);
}
window.addEventListener('resize', () => {
  if (dom.viewRouting?.classList.contains('active')) {
    requestAnimationFrame(drawRoutingConnectors);
  }
});

if (dom.routingTargetsContainer) {
  dom.routingTargetsContainer.addEventListener('scroll', () => {
    if (dom.viewRouting?.classList.contains('active')) {
      requestAnimationFrame(drawRoutingConnectors);
    }
  });
}
if (dom.routingSessionsContainer) {
  dom.routingSessionsContainer.addEventListener('scroll', () => {
    if (dom.viewRouting?.classList.contains('active')) {
      requestAnimationFrame(drawRoutingConnectors);
    }
  });
}

// =============================================================================
// Panel Split-Resizers & Dynamic Layout Manager (多模块可拖拽缩放与折叠管理)
// =============================================================================
function setupPanelResizers() {
  // 1. View 3: 底部裁决决策面板纵向拖拽与折叠 (#resizer-routing-decisions)
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
    resizerDecisions.addEventListener('dblclick', () => {
      toggleDecisionsPanel();
    });

    const onPointerDown = (e) => {
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
        const delta = startY - moveEvt.clientY; // 往上拉增大高度
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
    };

    resizerDecisions.addEventListener('pointerdown', onPointerDown);
  }

  // 2. View 1: 会话列表与独占锁分割条 (#resizer-agents-locks)
  const resizerAgentsLocks = dom.resizerAgentsLocks;
  const paneLeft = dom.paneLeft;
  const flexAgents = dom.flexAgents;

  const savedAgentsH = localStorage.getItem('nexus_agents_section_height');
  if (savedAgentsH) {
    document.documentElement.style.setProperty('--agents-section-height', savedAgentsH);
  }

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

  // 3. View 1: 左右两栏横向分割条 (#resizer-sessions-split)
  const resizerSessionsSplit = dom.resizerSessionsSplit;
  const splitLayout = document.querySelector('.split-layout');

  const savedSessionsW = localStorage.getItem('nexus_sessions_left_width');
  if (savedSessionsW) {
    document.documentElement.style.setProperty('--sessions-left-width', savedSessionsW);
  }

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
        const minW = 260;
        const maxW = containerW - 260;
        const newW = Math.min(maxW, Math.max(minW, startW + delta));
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

  // 4. View 2: 对话与里程碑垂直分割条 (#resizer-dialogue-milestones)
  const resizerDialogue = dom.resizerDialogueMilestones;
  const sectionDialogue = document.getElementById('section-dialogue');
  const splitVLayout = document.querySelector('.split-v-layout');

  const savedDialogueH = localStorage.getItem('nexus_dialogue_section_height');
  if (savedDialogueH) {
    document.documentElement.style.setProperty('--dialogue-section-height', savedDialogueH);
  }

  if (resizerDialogue && sectionDialogue && splitVLayout) {
    resizerDialogue.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--dialogue-section-height', '50%');
      localStorage.removeItem('nexus_dialogue_section_height');
    });

    resizerDialogue.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY;
      const startH = sectionDialogue.getBoundingClientRect().height;
      const containerH = splitVLayout.getBoundingClientRect().height;
      resizerDialogue.classList.add('is-dragging');
      document.body.classList.add('resizing-row');
      resizerDialogue.setPointerCapture(e.pointerId);

      const onPointerMove = (mEvt) => {
        const delta = mEvt.clientY - startY;
        const minH = 110;
        const maxH = containerH - 110;
        const newH = Math.min(maxH, Math.max(minH, startH + delta));
        const pct = Math.round((newH / containerH) * 100);
        document.documentElement.style.setProperty('--dialogue-section-height', `${pct}%`);
      };

      const onPointerUp = (uEvt) => {
        resizerDialogue.releasePointerCapture(uEvt.pointerId);
        resizerDialogue.removeEventListener('pointermove', onPointerMove);
        resizerDialogue.removeEventListener('pointerup', onPointerUp);
        resizerDialogue.removeEventListener('pointercancel', onPointerUp);
        resizerDialogue.classList.remove('is-dragging');
        document.body.classList.remove('resizing-row');
        const finalPct = document.documentElement.style.getPropertyValue('--dialogue-section-height');
        if (finalPct) localStorage.setItem('nexus_dialogue_section_height', finalPct);
      };

      resizerDialogue.addEventListener('pointermove', onPointerMove);
      resizerDialogue.addEventListener('pointerup', onPointerUp);
      resizerDialogue.addEventListener('pointercancel', onPointerUp);
    });
  }
}

// Master Broadcast 发送
if (dom.masterBroadcastBtn) {
  dom.masterBroadcastBtn.onclick = async () => {
    const content = dom.masterBroadcastInput ? dom.masterBroadcastInput.value.trim() : '';
    if (!content) return;
    const importance = dom.masterBroadcastUrgent?.checked ? 'urgent' : 'normal';

    try {
      dom.masterBroadcastBtn.disabled = true;
      const res = await fetch(`/api/projects/${encodeURIComponent(currentProjectId)}/broadcast`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ from: 'sensei', content, importance })
      });
      if (res.ok) {
        if (dom.masterBroadcastInput) dom.masterBroadcastInput.value = '';
        toggleBroadcastPopover(false);
        fetchDashboard();
        fetchDialogues();
      }
    } catch (err) {
      alert('广播失败: ' + err.message);
    } finally {
      dom.masterBroadcastBtn.disabled = false;
    }
  };
}

// =============================================================================
// Full-Duplex WebSocket Long Connection & Zero-Polling Event Stream
// =============================================================================
let activeWs = null;
let isWsConnected = false;
let fallbackPollTimer = null;
let wsPingTimer = null;

const debouncedFetchDashboard = debounce(fetchDashboard, 500);
const debouncedFetchDialogues = debounce(fetchDialogues, 500);
const debouncedFetchMilestones = debounce(fetchMilestones, 500);

function updateConnectionIndicators(connected, customStatus = null) {
  if (dom.liveDot) {
    dom.liveDot.classList.toggle('disconnected', !connected);
  }
  if (dom.daemonStatus) {
    if (customStatus) {
      dom.daemonStatus.textContent = customStatus;
      dom.daemonStatus.style.cursor = 'pointer';
      dom.daemonStatus.onclick = () => showTokenPrompt();
    } else {
      dom.daemonStatus.textContent = connected ? '守护就绪' : '脱机重连中';
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
    fetchDialogues();
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
      updateConnectionIndicators(false, '需要令牌 (点击配置)');
      showTokenPrompt('missing');
      return;
    }
    const params = new URLSearchParams();
    params.set('token', token);
    if (currentProjectId) params.set('project', currentProjectId);
    const qs = params.toString();
    const wsUrl = `${protocol}//${location.host}/?${qs}`;

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
            ws.send(JSON.stringify({ type: 'sync:request', project_id: currentProjectId }));
          } catch {}
        }
      }, 4000);

      try {
        ws.send(JSON.stringify({ type: 'sync:request', project_id: currentProjectId }));
      } catch {}
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
            // 推送帧里 cockpit 不带 dashboard/collab（同帧的 snapshot 就是那份 dashboard，
            // 重复发一遍只是浪费带宽），渲染时补回去。
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
          if (dom.viewRouting?.classList.contains('active')) {
            debouncedFetchRoutingTopology();
          }
          return;
        }

        if (payload.type === 'lead:broadcast' || payload.type === 'message:sent' || payload.type === 'messages:read') {
          debouncedFetchDialogues();
          debouncedFetchDashboard();
          return;
        }

        if (payload.type === 'lead:awakened') {
          handleLeadAwakened(payload.data);
          debouncedFetchDashboard();
          debouncedFetchDialogues();
          if (dom.viewRouting?.classList.contains('active')) {
            debouncedFetchRoutingTopology();
          }
          return;
        }

        debouncedFetchDashboard();
        if (dom.viewRouting?.classList.contains('active')) {
          debouncedFetchRoutingTopology();
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
        updateConnectionIndicators(false, '需要令牌 (点击配置)');
        showTokenPrompt('missing');
        return;
      }
      updateConnectionIndicators(false);
      startFallbackPolling();
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch (err) {
    console.error('WebSocket connection error:', err);
    isWsConnected = false;
    updateConnectionIndicators(false);
    startFallbackPolling();
    setTimeout(connectWebSocket, 5000);
  }
}

// =============================================================================
// Bootstrap Execution
// =============================================================================
setupPanelResizers();

const initialView = new URLSearchParams(location.search).get('view') || new URLSearchParams(location.search).get('tab');
if (initialView && ['sessions', 'timeline', 'routing'].includes(initialView)) {
  switchView(initialView);
}

async function initApp() {
  try {
    const pill = document.querySelector('.hub-status-pill');
    if (pill && location?.host) {
      pill.textContent = location.host;
      pill.title = `Nexus Hub 端点: ${location.host}`;
    }
  } catch {}
  await loadProjects();
  connectWebSocket();
}

initApp();
