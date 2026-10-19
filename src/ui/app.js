// Agent-Nexus War Room UI Controller

function getNexusToken() {
  if (typeof window !== 'undefined' && window.__NEXUS_TOKEN__) {
    return window.__NEXUS_TOKEN__;
  }
  const fromQuery = new URLSearchParams(location.search).get('token');
  if (fromQuery) {
    sessionStorage.setItem('nexusToken', fromQuery);
    return fromQuery;
  }
  return sessionStorage.getItem('nexusToken') || '';
}

let currentProjectId = 'default';
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
function debounce(fn, delay = 200) {
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

// 规范化 Agent 显示名称，剔除乱码/损坏字符并提供标准化身份标识
function formatAgentDisplayName(name, agentId, provider, sessionId, intentSummary = null) {
  if (name && typeof name === 'string' && name.trim()) {
    const trimmed = name.trim();
    if (!/[-\x00-\x08\x0B\x0C\x0E-\x1F]/.test(trimmed) && !/^[?\s.\-=_]+$/.test(trimmed)) {
      if (!isMechanicalAgentName(trimmed)) {
        return trimmed;
      }
    }
  }

  // 优先尝试使用意图摘要进行语义化命名 (如 "AI检索优化")
  if (intentSummary && typeof intentSummary === 'string' && intentSummary.trim()) {
    const cleanIntent = intentSummary.trim();
    if (!isMechanicalAgentName(cleanIntent) && !/^[?\s.\-=_]+$/.test(cleanIntent)) {
      return cleanIntent.length > 40 ? cleanIntent.slice(0, 40) : cleanIntent;
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
  tabCollab: document.getElementById('tab-collab'),
  tabUnified: document.getElementById('tab-unified'),
  viewWarRoom: document.getElementById('view-war-room'),
  viewTopology: document.getElementById('view-topology'),
  viewCollab: document.getElementById('view-collab'),
  viewUnified: document.getElementById('view-unified'),
  collabTabBadge: document.getElementById('collab-tab-badge'),
  topologyTabBadge: document.getElementById('topology-tab-badge'),

  // Unified Cockpit Elements
  cockpitLiveDot: document.getElementById('cockpit-live-dot'),
  cockpitConnStatus: document.getElementById('cockpit-conn-status'),
  cockpitLastSync: document.getElementById('cockpit-last-sync'),
  cockpitRefreshBtn: document.getElementById('cockpit-refresh-btn'),
  cockpitStatWorking: document.getElementById('cockpit-stat-working'),
  cockpitStatWaiting: document.getElementById('cockpit-stat-waiting'),
  cockpitStatLocks: document.getElementById('cockpit-stat-locks'),
  cockpitStatNodes: document.getElementById('cockpit-stat-nodes'),
  cockpitStatMessages: document.getElementById('cockpit-stat-messages'),
  cockpitWorkingMeta: document.getElementById('cockpit-working-meta'),
  cockpitAgentsList: document.getElementById('cockpit-agents-list'),
  cockpitGotoTopoBtn: document.getElementById('cockpit-goto-topo-btn'),
  cockpitTopologyList: document.getElementById('cockpit-topology-list'),
  cockpitLocksMeta: document.getElementById('cockpit-locks-meta'),
  cockpitLocksList: document.getElementById('cockpit-locks-list'),
  cockpitDialogueList: document.getElementById('cockpit-dialogue-list'),

  // Functional Topology DOM Elements & Detail Drawer
  topoStatNodes: document.getElementById('topo-stat-nodes'),
  topoStatEdges: document.getElementById('topo-stat-edges'),
  topoStatAgents: document.getElementById('topo-stat-agents'),
  topoSearchInput: document.getElementById('topo-search-input'),
  topoRefreshBtn: document.getElementById('topo-refresh-btn'),
  topoViewport: document.getElementById('topo-viewport'),
  topoCanvasInner: document.getElementById('topo-canvas-inner'),
  topoSvgLayer: document.getElementById('topo-svg-layer'),
  topoNodesLayer: document.getElementById('topo-nodes-layer'),
  topoModuleChips: document.getElementById('topo-module-chips'),
  topoNodeDrawer: document.getElementById('topo-node-drawer'),
  topoDrawerClose: document.getElementById('topo-drawer-close'),
  drawerNodeTypeBadge: document.getElementById('drawer-node-type-badge'),
  drawerNodeTitle: document.getElementById('drawer-node-title'),
  drawerModuleTag: document.getElementById('drawer-module-tag'),
  drawerCausalityTag: document.getElementById('drawer-causality-tag'),
  drawerDepthTag: document.getElementById('drawer-depth-tag'),
  drawerAgentId: document.getElementById('drawer-agent-id'),
  drawerTime: document.getElementById('drawer-time'),
  drawerIntentId: document.getElementById('drawer-intent-id'),
  drawerDescription: document.getElementById('drawer-description'),
  drawerClaimsCount: document.getElementById('drawer-claims-count'),
  drawerClaimsList: document.getElementById('drawer-claims-list'),
  drawerParentsList: document.getElementById('drawer-parents-list'),
  drawerChildrenList: document.getElementById('drawer-children-list'),

  // Multi-Session Collaboration Graph DOM Elements
  collabLiveDot: document.getElementById('collab-live-dot'),
  collabLiveStatus: document.getElementById('collab-live-status'),
  collabLastUpdatedText: document.getElementById('collab-last-updated-text'),
  collabRefreshBtn: document.getElementById('collab-refresh-btn'),
  collabStatWorking: document.getElementById('collab-stat-working'),
  collabStatWaiting: document.getElementById('collab-stat-waiting'),
  collabStatIdle: document.getElementById('collab-stat-idle'),
  collabStatLockedRes: document.getElementById('collab-stat-locked-res'),
  collabStatConflicts: document.getElementById('collab-stat-conflicts'),
  collabViewport: document.getElementById('collab-viewport'),
  collabCanvasInner: document.getElementById('collab-canvas-inner'),
  collabSvgLayer: document.getElementById('collab-svg-layer'),
  collabNodesLayer: document.getElementById('collab-nodes-layer'),
  collabTableBody: document.getElementById('collab-table-body'),
  collabTableMeta: document.getElementById('collab-table-meta'),

  // Theme Toggle Button
  themeToggleBtn: document.getElementById('theme-toggle-btn'),
  themeToggleLabel: document.getElementById('theme-toggle-label')
};

// ==========================================
// Theme Management (亮色 / 暗色两套主题无缝切换与持久化)
// ==========================================
function getPreferredTheme() {
  const saved = localStorage.getItem('nexusTheme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateThemeUI(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (dom.themeToggleLabel) {
    dom.themeToggleLabel.textContent = theme === 'dark' ? '暗色' : '亮色';
  }
  if (dom.themeToggleBtn) {
    dom.themeToggleBtn.setAttribute('title', theme === 'dark' ? '当前暗色模式，点击切换至亮色模式' : '当前亮色模式，点击切换至暗色模式');
    dom.themeToggleBtn.setAttribute('aria-label', theme === 'dark' ? '切换至亮色模式' : '切换至暗色模式');
  }
}

function applyTheme(theme) {
  localStorage.setItem('nexusTheme', theme);
  updateThemeUI(theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || getPreferredTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
}

if (dom.themeToggleBtn) {
  dom.themeToggleBtn.onclick = toggleTheme;
}

// 监听系统级颜色变化（未手动覆盖时自动同步）
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('nexusTheme')) {
      updateThemeUI(e.matches ? 'dark' : 'light');
    }
  });
} catch {}

// 初始化当前主题 UI 状态
updateThemeUI(getPreferredTheme());

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
    localStorage.setItem('nexusProjectId', currentProjectId);
    fetchDashboard();
    fetchMemories();
    fetchDialogues();
    if (currentViewMode === 'topology' || currentViewMode === 'unified') {
      fetchTopologyGraph();
    }
    if (currentViewMode === 'collab' || currentViewMode === 'unified') {
      fetchCollabGraph();
    }
  };
}

// 项目列表加载 (支持记住上次选择与自动聚焦真实活跃项目)
async function loadProjects() {
  try {
    const res = await fetch('/api/projects', { headers: authHeaders() });
    if (!res.ok) return;
    const list = await res.json();
    if (!list || list.length === 0 || !dom.projectSelector) return;

    // 过滤保留的虚拟全景 'all' 标识与无效 ID，并依据 id 严格去重
    const validProjects = list.filter(p => p && p.id && p.id !== 'all' && p.id !== '');
    const seen = new Set();
    const uniqueProjects = [];
    for (const p of validProjects) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        uniqueProjects.push(p);
      }
    }

    // 优先读取本地持久化项目，若无则优先选取有真实活跃度或非 default 的有效项目
    const savedProjectId = localStorage.getItem('nexusProjectId');
    let targetProject = savedProjectId === 'all' ? { id: 'all' } : uniqueProjects.find(p => p.id === savedProjectId);
    if (!targetProject) {
      targetProject = uniqueProjects.find(p => p.id === 'Agent-Nexus') ||
                      uniqueProjects.find(p => p.id !== 'default' && (p.last_activity > 0 || p.node_count > 0)) ||
                      uniqueProjects.find(p => p.id !== 'default') ||
                      uniqueProjects[0] ||
                      { id: 'all' };
    }

    if (targetProject) {
      currentProjectId = targetProject.id;
      localStorage.setItem('nexusProjectId', currentProjectId);
    }

    const allOption = `<option value="all" ${currentProjectId === 'all' ? 'selected' : ''}>全部项目 (跨工程协同全景)</option>`;
    const projectOptions = uniqueProjects.map(p => {
      const idSafe = escapeHtml(p.id);
      const nameSafe = escapeHtml(p.display_name || p.id);
      const selected = (p.id === currentProjectId && currentProjectId !== 'all') ? 'selected' : '';
      return `<option value="${idSafe}" ${selected}>${nameSafe}</option>`;
    }).join('');

    dom.projectSelector.innerHTML = allOption + projectOptions;

    // 项目切换就绪后，立即拉取一次该项目的专属数据
    fetchDashboard();
    fetchMemories();
    fetchDialogues();
    if (currentViewMode === 'topology' || currentViewMode === 'unified') {
      fetchTopologyGraph();
    }
    if (currentViewMode === 'collab' || currentViewMode === 'unified') {
      fetchCollabGraph();
    }
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
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
    renderDashboardSnapshot(data);
  } catch (err) {
    console.error('Fetch dashboard error:', err);
  }
}

// 统一态势渲染：/api/dashboard 响应与 WebSocket init:state / sync:response 快照共用
function renderDashboardSnapshot(data) {
  if (!data) return;
  renderMetrics(data);
  renderLanes(data.activeClaims || [], data.agents || []);
  renderAgents(data.agents || [], data.activeClaims || []);
  renderTimeline(data.timeline || []);
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
        <div class="lane-countdown-bar" style="height: 4px; background: var(--border-subtle); border-radius: 9999px; margin-top: 10px; overflow: hidden;">
          <div class="lane-progress" style="width: ${progressPct}%; height: 100%; background: var(--sky-primary); border-radius: 9999px;"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderMetrics(data) {
  const agents = data.agents || [];
  // 严格依据四级生命周期状态机统计真实活跃会话：
  // 1. working: 持有活跃文件租约、运行态意图或正在调用写工具改代码
  // 2. waiting: 因锁冲突正在排队等待
  const workingCount = agents.filter(a => a.lifecycle_state === 'working').length;
  const waitingCount = agents.filter(a => a.lifecycle_state === 'waiting').length;
  const activeCount = workingCount + waitingCount;

  if (dom.metricTotalAgents) dom.metricTotalAgents.textContent = activeCount;
  if (dom.metricRunning) dom.metricRunning.textContent = workingCount;
  if (dom.metricWaiting) dom.metricWaiting.textContent = waitingCount;

  // 动态同步 Tech Lead 架构师视窗，消除数据二义性与指标矛盾
  updateLeadConsole(agents, workingCount, waitingCount);
}

function updateLeadConsole(agents, workingCount, waitingCount) {
  if (!dom.leadStatusChip) return;

  if (dom.leadSessionStats) {
    if (workingCount === 0 && waitingCount === 0) {
      dom.leadSessionStats.textContent = '0 个在席施工会话';
    } else if (waitingCount > 0) {
      dom.leadSessionStats.textContent = `${workingCount} 个会话施工中 · ${waitingCount} 个排队中`;
    } else {
      dom.leadSessionStats.textContent = `${workingCount} 个会话正在干活`;
    }
  }

  const activeCount = workingCount + waitingCount;
  if (activeCount <= 1) {
    dom.leadStatusChip.className = 'lead-chip chip-silent';
    dom.leadStatusChip.textContent = '静默守望（单人施工不打扰）';
    if (dom.leadAdviceContainer && !dom.leadAdviceContainer.getAttribute('data-sticky')) {
      dom.leadAdviceContainer.innerHTML = `[Nexus 架构师静默保驾] 当前无多会话写冲突，架构师保持静默，绝不产生干扰。当检测到多个会话并发修改同一文件或排队时，将实时唤醒并提供避让重排与交接路线。`;
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
      <div style="font-weight: 700; color: var(--sky-primary); margin-bottom: 6px;">【在席会话施工现场快照】</div>
      ${data.peer_sessions.map(p => `
        <div style="padding: 6px 10px; background: var(--card-nested); border: 1px solid var(--border-subtle); border-radius: 6px; margin-bottom: 4px; font-size: 12px; color: var(--text-main);">
          • 会话 [${escapeHtml(p.name)}]: 意图 "${escapeHtml(p.currentIntent || '无')}" | 进度 "${escapeHtml(p.progressSummary || '进行中')}" | 独占锁 ${p.activeLeasesCount || 0} 个
        </div>
      `).join('')}
    `;
  }
}

function renderAgents(agents, activeClaims) {
  if (!dom.agentsContainer) return;

  const claimsList = activeClaims || [];

  // 用户铁律：不要显示离线的 session，只显示在工作的和等待的！
  const workingAgents = [];
  const waitingAgents = [];

  for (const a of (agents || [])) {
    // 严格过滤掉所有已离线会话，不渲染历史离线僵尸卡片
    if (a.lifecycle_state === 'departed' || a.status === 'departed') continue;

    const claims = claimsList.filter(c => c.agent_id === a.id);
    const isWorking = a.lifecycle_state === 'working' ||
                      a.status === 'running' ||
                      (claims.length > 0 && a.status !== 'departed');

    const isWaiting = !isWorking && (
      a.lifecycle_state === 'waiting' ||
      a.status === 'waiting' ||
      !!a.blocked_reason
    );

    if (isWorking) {
      workingAgents.push({ ...a, resolvedClaims: claims, stateClass: 'working', stateLabel: '在线施工中' });
    } else if (isWaiting) {
      waitingAgents.push({ ...a, resolvedClaims: claims, stateClass: 'waiting', stateLabel: '排队等待中' });
    }
  }

  if (workingAgents.length === 0 && waitingAgents.length === 0) {
    dom.agentsContainer.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 48px 24px; text-align: center; color: var(--text-faint); font-size: 14px; border: 1px dashed var(--border-subtle); border-radius: 16px; background: var(--card-nested);">
        <div style="font-size: 16px; font-weight: 700; color: var(--text-title); margin-bottom: 8px;">
          当前无正在施工或排队的助手
        </div>
        <div style="color: var(--text-muted); font-size: 13px;">
          历史离线会话已自动隐去。当助手调用工具修改代码、独占持锁或因冲突排队等待时，将在此实时呈现。
        </div>
      </div>
    `;
    return;
  }

  function renderSingleAgentCard(a) {
    const displayName = formatAgentDisplayName(a.name, a.id, a.provider, a.session_id, a.current_intent || a.current_intent_summary);
    const nameSafe = escapeHtml(displayName);
    const providerShort = escapeHtml((a.provider || displayName || 'A').toUpperCase().slice(0, 2));
    const claims = a.resolvedClaims || [];

    const shortTarget = a.last_target ? a.last_target.split(/[\/\\]/).pop() : null;

    return `
      <div class="agent-card ${a.stateClass}">
        <div class="agent-top-row">
          <div class="agent-id-name">
            <div class="agent-icon">${providerShort}</div>
            <div class="agent-title-text" title="${nameSafe}">
              ${nameSafe}
              ${a.pid ? `<span style="font-size: 11px; opacity: 0.6; font-weight: normal; margin-left: 4px;">(PID: ${escapeHtml(String(a.pid))})</span>` : ''}
            </div>
          </div>
          <span class="status-tag ${a.stateClass}">
            ${a.stateClass === 'working' ? '<span class="status-pulse-dot"></span>' : ''}
            ${a.stateLabel}
          </span>
        </div>

        ${a.last_tool ? `
          <div class="agent-tool-telemetry">
            <span class="tool-tag ${escapeHtml(a.last_tool.toLowerCase())}">${escapeHtml(a.last_tool)}</span>
            <span class="tool-target" title="${escapeHtml(a.last_target || a.last_action || '')}">
              ${escapeHtml(shortTarget || a.last_action || '执行中')}
            </span>
          </div>
        ` : ''}

        <div class="intent-box">
          ${a.current_intent ? `<strong>当前意图:</strong> ${escapeHtml(a.current_intent)}` : '<span style="color: var(--text-faint);">暂未声明修改意图</span>'}
        </div>

        ${a.progress_summary ? `
          <div class="progress-box">
            <strong>施工进度:</strong> ${escapeHtml(a.progress_summary)}
          </div>
        ` : ''}

        ${a.blocked_reason ? `
          <div class="blocked-callout">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            <span>${escapeHtml(a.blocked_reason)}</span>
          </div>
        ` : ''}

        ${claims.length > 0 ? `
          <div class="claims-zone">
            <span class="claims-label">已独占锁定的文件/资源 (${claims.length})</span>
            <div class="claims-flex">
              ${claims.map(c => `
                <span class="claim-pill" title="${escapeHtml(c.claim_target)}">[${escapeHtml(c.claim_type)}] ${escapeHtml(c.claim_target.split(/[\/\\]/).pop())}</span>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  let html = '';

  if (workingAgents.length > 0) {
    html += `
      <!-- 1. 在线施工中 -->
      <div class="lifecycle-tier-group tier-working">
        <div class="lifecycle-tier-header">
          <div class="tier-heading-title">
            <span class="tier-indicator-dot working"></span>
            <span>在线施工中 (Working)</span>
          </div>
          <span class="tier-count-badge working">${workingAgents.length} 个会话</span>
        </div>
        <div class="agents-grid">
          ${workingAgents.map(renderSingleAgentCard).join('')}
        </div>
      </div>
    `;
  }

  if (waitingAgents.length > 0) {
    html += `
      <!-- 2. 排队等待中 -->
      <div class="lifecycle-tier-group tier-waiting">
        <div class="lifecycle-tier-header">
          <div class="tier-heading-title">
            <span class="tier-indicator-dot waiting"></span>
            <span>排队等待中 (Waiting)</span>
          </div>
          <span class="tier-count-badge waiting">${waitingAgents.length} 个会话</span>
        </div>
        <div class="agents-grid">
          ${waitingAgents.map(renderSingleAgentCard).join('')}
        </div>
      </div>
    `;
  }

  dom.agentsContainer.innerHTML = html;
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

    const actor = escapeHtml(formatAgentDisplayName(item.agent_name, item.agent_id));
    const eventType = escapeHtml(item.event_type);
    const desc = escapeHtml(item.description);

    return `
      <div class="timeline-item">
        <div class="timeline-badge ${typeClass}">${badgeSvg}</div>
        <div class="timeline-content-box">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;">
            <span style="font-size: 13px; font-weight: 700; color: var(--text-title);">[${actor}] ${eventType}</span>
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
      const srcSafe = m.source_agent_id ? `@${escapeHtml(formatAgentDisplayName(null, m.source_agent_id))}` : '';
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

// 刷新防抖，严格遵循 60 FPS 性能铁律（>=500ms），避免高频 DOM 重排与事件风暴冲击
const debouncedFetchDashboard = debounce(fetchDashboard, 500);
const debouncedFetchMemories = debounce(fetchMemories, 500);
const debouncedFetchDialogues = debounce(fetchDialogues, 500);
const debouncedFetchCollab = debounce(fetchCollabGraph, 500);
const debouncedFetchTopology = debounce(fetchTopologyGraph, 500);
const debouncedFetchCockpit = debounce(fetchCockpit, 500);

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
      const fromSafe = escapeHtml(formatAgentDisplayName(m.from_agent_name, m.from_agent));
      const toSafe = m.to_agent ? `@${escapeHtml(formatAgentDisplayName(m.to_agent_name, m.to_agent))}` : 'BROADCAST';
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
// View Switcher (War Room / Topology / Live Collaboration Graph / Unified)
// ==========================================
let currentViewMode = 'collab';

function setViewMode(mode) {
  currentViewMode = mode;
  [dom.tabWarRoom, dom.tabTopology, dom.tabCollab, dom.tabUnified].forEach(t => t?.classList.remove('active'));
  [dom.viewWarRoom, dom.viewTopology, dom.viewCollab, dom.viewUnified].forEach(v => v?.classList.remove('active'));

  if (mode === 'war-room') {
    dom.tabWarRoom?.classList.add('active');
    dom.viewWarRoom?.classList.add('active');
    fetchDashboard();
  } else if (mode === 'topology') {
    dom.tabTopology?.classList.add('active');
    dom.viewTopology?.classList.add('active');
    fetchTopologyGraph();
    requestAnimationFrame(() => redrawTopologyEdges());
  } else if (mode === 'collab') {
    dom.tabCollab?.classList.add('active');
    dom.viewCollab?.classList.add('active');
    fetchCollabGraph();
    requestAnimationFrame(() => redrawCollabEdges());
  } else if (mode === 'unified') {
    dom.tabUnified?.classList.add('active');
    dom.viewUnified?.classList.add('active');
    fetchCockpit();
  }
}

if (dom.tabWarRoom) dom.tabWarRoom.onclick = () => setViewMode('war-room');
if (dom.tabTopology) dom.tabTopology.onclick = () => setViewMode('topology');
if (dom.tabCollab) dom.tabCollab.onclick = () => setViewMode('collab');
if (dom.tabUnified) dom.tabUnified.onclick = () => setViewMode('unified');

// ==========================================
// Unified Cockpit Controller (综合全览驾驶舱)
// ==========================================
let currentCockpitData = null;

async function fetchCockpit() {
  try {
    const res = await fetch(`/api/cockpit?project_id=${encodeURIComponent(currentProjectId)}`, {
      headers: authHeaders()
    });
    if (!res.ok) return;
    const data = await res.json();
    currentCockpitData = data;
    renderUnifiedCockpit(data);
  } catch (err) {
    console.error('Fetch cockpit error:', err);
  }
}

if (dom.cockpitRefreshBtn) {
  dom.cockpitRefreshBtn.onclick = () => fetchCockpit();
}

if (dom.cockpitGotoTopoBtn) {
  dom.cockpitGotoTopoBtn.onclick = () => setViewMode('topology');
}

function renderUnifiedCockpit(cockpit) {
  if (!cockpit) return;
  const metrics = cockpit.metrics || {};

  // 1. 顶栏指标
  if (dom.cockpitStatWorking) dom.cockpitStatWorking.textContent = metrics.workingAgents || 0;
  if (dom.cockpitStatWaiting) dom.cockpitStatWaiting.textContent = metrics.waitingAgents || 0;
  if (dom.cockpitStatLocks) dom.cockpitStatLocks.textContent = metrics.activeLocks || 0;
  if (dom.cockpitStatNodes) dom.cockpitStatNodes.textContent = metrics.topologyNodes || 0;
  if (dom.cockpitStatMessages) dom.cockpitStatMessages.textContent = metrics.dialogueCount || 0;
  if (dom.cockpitLastSync) dom.cockpitLastSync.textContent = new Date().toLocaleTimeString([], { hour12: false });

  // 2. 象限 1: 实时施工助手态势矩阵
  const activeWorkers = cockpit.activeWorkers || [];
  if (dom.cockpitWorkingMeta) {
    dom.cockpitWorkingMeta.textContent = `${activeWorkers.length} 个助手施工中`;
  }
  if (dom.cockpitAgentsList) {
    if (activeWorkers.length === 0) {
      dom.cockpitAgentsList.innerHTML = `
        <div class="cockpit-empty-state">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          <div style="font-weight: 600; margin-top: 8px;">当前暂无施工中助手</div>
          <div style="font-size: 12px; color: var(--text-faint); margin-top: 4px;">所有工作区处于就绪状态，无排他修改冲突</div>
        </div>
      `;
    } else {
      dom.cockpitAgentsList.innerHTML = activeWorkers.map(w => {
        const name = escapeHtml(formatAgentDisplayName(w.name, w.id, w.provider, w.session_id, w.intent_summary));
        const tool = escapeHtml(w.current_tool || 'Working');
        const action = escapeHtml(w.current_action || '执行任务中');
        const target = w.current_target ? escapeHtml(w.current_target.split('/').pop() || w.current_target) : null;
        const stateBadge = w.lifecycle_state === 'waiting'
          ? '<span class="status-pill waiting" style="margin-left: auto;">待命中 (排队)</span>'
          : '<span class="status-pill working" style="margin-left: auto;">工作中 (施工)</span>';

        return `
          <div class="cockpit-worker-card">
            <div class="cockpit-worker-head">
              <span class="cockpit-worker-avatar">${name.slice(0, 2)}</span>
              <div class="cockpit-worker-identity">
                <div class="cockpit-worker-name">${name}</div>
                <div class="cockpit-worker-id">${escapeHtml(w.id)}</div>
              </div>
              ${stateBadge}
            </div>
            <div class="cockpit-worker-action-box">
              <div class="cockpit-worker-tool ${(w.current_tool || 'working').toLowerCase()}">${tool}</div>
              <div class="cockpit-worker-action" title="${escapeHtml(w.current_action || '')}">${action}</div>
            </div>
            ${target ? `
              <div class="cockpit-worker-target">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
                <span>${target}</span>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
    }
  }

  // 3. 象限 2: 演进拓扑主线脉络
  const topologyNodes = (cockpit.topologySnapshot && cockpit.topologySnapshot.nodes) || [];
  if (dom.cockpitTopologyList) {
    if (topologyNodes.length === 0) {
      dom.cockpitTopologyList.innerHTML = `
        <div class="cockpit-empty-state">
          <div style="font-weight: 600;">暂无演进拓扑节点</div>
          <div style="font-size: 12px; color: var(--text-faint); margin-top: 4px;">完成任务或提交 Git 后将自动记录拓扑</div>
        </div>
      `;
    } else {
      const recentNodes = [...topologyNodes].reverse().slice(0, 10);
      dom.cockpitTopologyList.innerHTML = recentNodes.map((n) => {
        const timeStr = new Date(n.createdAt).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
        const moduleTag = escapeHtml(n.module || 'core');
        const causalityLabel = n.causalityType === 'causal_file' ? '同文件延续' :
                               n.causalityType === 'module_branch' ? '模块分支' :
                               n.causalityType === 'milestone_convergence' ? '阶段汇聚' :
                               n.causalityType === 'handoff' ? '交接' : '时序演进';
        return `
          <div class="cockpit-topo-item" onclick="openTopologyDrawerById('${escapeHtml(n.id)}')">
            <div class="cockpit-topo-left">
              <span class="cockpit-topo-module">${moduleTag}</span>
              <span class="cockpit-topo-causality">${causalityLabel}</span>
            </div>
            <div class="cockpit-topo-main">
              <div class="cockpit-topo-title">${escapeHtml(n.title)}</div>
              <div class="cockpit-topo-meta">
                <span>${escapeHtml(formatAgentDisplayName(n.agentName, n.agentId))}</span>
                <span>•</span>
                <span>${timeStr}</span>
              </div>
            </div>
            <span class="cockpit-topo-arrow">&rarr;</span>
          </div>
        `;
      }).join('');
    }
  }

  // 4. 象限 3: 独占资源锁与排队争用看板
  const lockContention = cockpit.lockContention || {};
  const activeClaims = lockContention.activeClaims || [];
  const resourceLocks = lockContention.resourceLocks || [];
  const waitQueue = lockContention.waitQueue || [];
  const totalLocks = activeClaims.length + resourceLocks.length;

  if (dom.cockpitLocksMeta) {
    dom.cockpitLocksMeta.textContent = `${totalLocks} 个锁定, ${waitQueue.length} 个排队`;
  }
  if (dom.cockpitLocksList) {
    if (totalLocks === 0 && waitQueue.length === 0) {
      dom.cockpitLocksList.innerHTML = `
        <div class="cockpit-empty-state">
          <div style="font-weight: 600;">资源通道完全畅通</div>
          <div style="font-size: 12px; color: var(--text-faint); margin-top: 4px;">无锁争用，支持多 Agent 无冲突并行施工</div>
        </div>
      `;
    } else {
      let itemsHtml = '';
      for (const c of activeClaims) {
        const shortFile = escapeHtml(c.claim_target.split('/').pop() || c.claim_target);
        itemsHtml += `
          <div class="cockpit-lock-card">
            <div class="cockpit-lock-header">
              <span class="cockpit-lock-tag file">文件锁: ${shortFile}</span>
              <span class="cockpit-lock-holder">${escapeHtml(c.agent_id)}</span>
            </div>
            <div class="cockpit-lock-path" title="${escapeHtml(c.claim_target)}">${escapeHtml(c.claim_target)}</div>
          </div>
        `;
      }
      for (const r of resourceLocks) {
        itemsHtml += `
          <div class="cockpit-lock-card">
            <div class="cockpit-lock-header">
              <span class="cockpit-lock-tag resource">命名资源: ${escapeHtml(r.resource_name)}</span>
              <span class="cockpit-lock-holder">${escapeHtml(r.agent_id)}</span>
            </div>
            <div class="cockpit-lock-path">${escapeHtml(r.reason || 'Exclusive resource')}</div>
          </div>
        `;
      }
      for (const w of waitQueue) {
        itemsHtml += `
          <div class="cockpit-lock-card waiting">
            <div class="cockpit-lock-header">
              <span class="cockpit-lock-tag wait">排队中 (等待释放)</span>
              <span class="cockpit-lock-holder">${escapeHtml(w.agent_id)}</span>
            </div>
            <div class="cockpit-lock-path">等待资源: ${escapeHtml(w.resource_target || w.target || 'locked resource')}</div>
          </div>
        `;
      }
      dom.cockpitLocksList.innerHTML = itemsHtml;
    }
  }

  // 5. 象限 4: 跨会话调度与流水
  const dialogues = cockpit.dialogues || [];
  const broadcasts = cockpit.broadcasts || [];
  const combined = [
    ...broadcasts.map(b => ({ ...b, isBroadcast: true })),
    ...dialogues.map(d => ({ ...d, isBroadcast: false }))
  ].sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 15);

  if (dom.cockpitDialogueList) {
    if (combined.length === 0) {
      dom.cockpitDialogueList.innerHTML = `
        <div class="cockpit-empty-state">
          <div style="font-weight: 600;">暂无跨会话调度记录</div>
          <div style="font-size: 12px; color: var(--text-faint); margin-top: 4px;">架构师调度广播与 Agent 间协同消息将实时流式展示</div>
        </div>
      `;
    } else {
      dom.cockpitDialogueList.innerHTML = combined.map(item => {
        const timeStr = new Date(item.created_at).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
        const sender = escapeHtml(item.from_agent_id || item.agent_id || 'System');
        const content = escapeHtml(item.content || item.description || '');
        const badge = item.isBroadcast
          ? '<span class="cockpit-dialogue-badge broadcast">全员广播</span>'
          : '<span class="cockpit-dialogue-badge direct">协同对话</span>';

        return `
          <div class="cockpit-dialogue-item ${item.isBroadcast ? 'broadcast' : ''}">
            <div class="cockpit-dialogue-header">
              ${badge}
              <span class="cockpit-dialogue-sender">${sender}</span>
              <span class="cockpit-dialogue-time">${timeStr}</span>
            </div>
            <div class="cockpit-dialogue-content">${content}</div>
          </div>
        `;
      }).join('');
    }
  }
}

// ==========================================
// Functional Topology Controller (功能演进拓扑大屏与详略得当抽屉)
// ==========================================
let currentTopologyData = null;
let topoSearchQuery = '';
let selectedTopoModule = 'all';

async function fetchTopologyGraph() {
  try {
    const res = await fetch(`/api/topology?project_id=${encodeURIComponent(currentProjectId)}&limit=100`, {
      headers: authHeaders()
    });
    if (!res.ok) return;
    const data = await res.json();
    currentTopologyData = data;
    renderModuleChips(data.modules || []);
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

if (dom.topoDrawerClose) {
  dom.topoDrawerClose.onclick = () => {
    if (dom.topoNodeDrawer) dom.topoNodeDrawer.style.display = 'none';
  };
}

function renderModuleChips(modules = []) {
  if (!dom.topoModuleChips) return;
  const moduleLabels = {
    'all': '全景总览',
    'daemon': 'daemon 守护调度',
    'transport': 'transport 传输通信',
    'domain': 'domain 领域协同',
    'ui': 'ui 前端交互',
    'hook': 'hook 拦截门禁',
    'mcp': 'mcp 协议工具',
    'tests': 'tests 自动化测试',
    'docs': 'docs 架构规范',
    'core': 'core 核心工程'
  };

  const list = ['all', ...modules.filter(m => m !== 'all')];
  dom.topoModuleChips.innerHTML = list.map(m => {
    const label = moduleLabels[m] || m;
    const active = m === selectedTopoModule ? 'active' : '';
    return `<button class="topo-filter-chip ${active}" data-module="${escapeHtml(m)}">${escapeHtml(label)}</button>`;
  }).join('');

  dom.topoModuleChips.querySelectorAll('.topo-filter-chip').forEach(btn => {
    btn.onclick = () => {
      selectedTopoModule = btn.getAttribute('data-module') || 'all';
      renderModuleChips(modules);
      if (currentTopologyData) {
        renderTopologyView(currentTopologyData);
      }
    };
  });
}

function openTopologyDrawer(node) {
  if (!node || !dom.topoNodeDrawer) return;

  if (dom.drawerNodeTypeBadge) {
    dom.drawerNodeTypeBadge.textContent = node.nodeType === 'milestone' ? '里程碑达成' :
                                         node.nodeType === 'handoff' ? '会话交接' : '功能完工释放';
    dom.drawerNodeTypeBadge.className = node.nodeType === 'milestone' ? 'badge-collab-live' : 'badge-collab-waiting';
  }
  if (dom.drawerNodeTitle) dom.drawerNodeTitle.textContent = node.title || '节点详情';
  if (dom.drawerModuleTag) dom.drawerModuleTag.textContent = `模块: ${node.module || 'core'}`;

  const causalityMap = {
    'causal_file': '同文件延续',
    'module_branch': '模块演进',
    'milestone_convergence': '阶段汇聚',
    'handoff': '任务交接',
    'unblocked': '冲突解除唤醒',
    'sequence': '时序演进'
  };
  if (dom.drawerCausalityTag) {
    dom.drawerCausalityTag.textContent = `因果: ${causalityMap[node.causalityType] || node.causalityType || '演进'}`;
  }
  if (dom.drawerDepthTag) dom.drawerDepthTag.textContent = `DAG 层级: ${node.depth || 0}`;
  if (dom.drawerAgentId) dom.drawerAgentId.textContent = formatAgentDisplayName(node.agentName, node.agentId);
  if (dom.drawerTime) dom.drawerTime.textContent = new Date(node.createdAt).toLocaleString();
  if (dom.drawerIntentId) dom.drawerIntentId.textContent = node.intentId || '无特定 Intent';
  if (dom.drawerDescription) dom.drawerDescription.textContent = node.description || '暂无详细解决说明';

  // 资源 Claims 快照
  const claims = node.claims || [];
  if (dom.drawerClaimsCount) dom.drawerClaimsCount.textContent = claims.length;
  if (dom.drawerClaimsList) {
    if (claims.length === 0) {
      dom.drawerClaimsList.innerHTML = '<span style="color: var(--text-faint); font-size: 12px;">无具体修改文件快照</span>';
    } else {
      dom.drawerClaimsList.innerHTML = claims.map(c => {
        const target = typeof c === 'string' ? c : (c?.target || '');
        const type = typeof c === 'object' && c?.type ? `[${c.type}] ` : '';
        return `
          <div class="drawer-file-pill" title="${escapeHtml(target)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            <span>${escapeHtml(type + target)}</span>
          </div>
        `;
      }).join('');
    }
  }

  // 前驱节点
  if (dom.drawerParentsList) {
    const parentIds = node.parentNodeIds || [];
    if (parentIds.length === 0) {
      dom.drawerParentsList.innerHTML = '<span style="color: var(--text-faint); font-size: 12px;">无前驱 (初始源点)</span>';
    } else {
      dom.drawerParentsList.innerHTML = parentIds.map(pid => {
        const parentNode = (currentTopologyData?.nodes || []).find(n => n.id === pid);
        const title = parentNode ? parentNode.title : pid;
        return `
          <button class="drawer-node-link-btn" onclick="openTopologyDrawerById('${escapeHtml(pid)}')">
            <span>&uarr; ${escapeHtml(title)}</span>
          </button>
        `;
      }).join('');
    }
  }

  // 后继节点
  if (dom.drawerChildrenList) {
    const childIds = node.childNodeIds || [];
    if (childIds.length === 0) {
      dom.drawerChildrenList.innerHTML = '<span style="color: var(--text-faint); font-size: 12px;">无衍生分支</span>';
    } else {
      dom.drawerChildrenList.innerHTML = childIds.map(cid => {
        const childNode = (currentTopologyData?.nodes || []).find(n => n.id === cid);
        const title = childNode ? childNode.title : cid;
        return `
          <button class="drawer-node-link-btn" onclick="openTopologyDrawerById('${escapeHtml(cid)}')">
            <span>&darr; ${escapeHtml(title)}</span>
          </button>
        `;
      }).join('');
    }
  }

  dom.topoNodeDrawer.style.display = 'flex';
}

function openTopologyDrawerById(nodeId) {
  if (!currentTopologyData) return;
  const node = (currentTopologyData.nodes || []).find(n => n.id === nodeId);
  if (node) {
    if (currentViewMode !== 'topology') {
      setViewMode('topology');
    }
    openTopologyDrawer(node);
    requestAnimationFrame(() => {
      const cardEl = document.getElementById(`card-${nodeId}`);
      if (cardEl) {
        cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        cardEl.classList.add('highlighted');
        setTimeout(() => cardEl.classList.remove('highlighted'), 2000);
      }
    });
  }
}
window.openTopologyDrawerById = openTopologyDrawerById;

function renderTopologyView(data) {
  if (!dom.topoNodesLayer || !dom.topoSvgLayer) return;

  const rawNodes = data?.nodes || [];
  const edges = data?.edges || [];

  // 双重过滤：模块分类分支 + 搜索关键词
  const filteredNodes = rawNodes.filter(n => {
    if (selectedTopoModule !== 'all' && n.module !== selectedTopoModule) {
      return false;
    }
    if (!topoSearchQuery) return true;
    const matchTitle = (n.title || '').toLowerCase().includes(topoSearchQuery);
    const matchDesc = (n.description || '').toLowerCase().includes(topoSearchQuery);
    const matchAgent = (n.agentName || n.agentId || '').toLowerCase().includes(topoSearchQuery);
    const matchFiles = (n.claims || []).some(c => {
      const targetStr = typeof c === 'string' ? c : (c?.target || '');
      return targetStr.toLowerCase().includes(topoSearchQuery);
    });
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
        <div class="topo-empty-icon" style="width: 48px; height: 48px; margin: 0 auto 16px auto; border-radius: 14px; background: rgba(56, 189, 248, 0.12); color: var(--sky-primary); display: flex; align-items: center; justify-content: center;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="18" cy="5" r="3"></circle>
            <circle cx="6" cy="12" r="3"></circle>
            <circle cx="18" cy="19" r="3"></circle>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
          </svg>
        </div>
        <div style="font-size: 15px; font-weight: 700; color: var(--text-title); margin-bottom: 6px;">
          ${rawNodes.length === 0 ? '暂无演进拓扑记录' : '没有匹配的节点'}
        </div>
        <div style="font-size: 13px; color: var(--text-faint);">
          ${rawNodes.length === 0
            ? '当各会话完成意图释放、上报里程碑或 Git 提交时，系统将自动按时间线绘制功能开发与问题解决拓扑图。'
            : '尝试更换模块分支或搜索关键词（支持按功能标题、Agent 名称或修改的文件路径筛选）。'
          }
        </div>
      </div>
    `;
    return;
  }

  const causalityLabels = {
    'causal_file': '同文件延续',
    'module_branch': '模块分支',
    'milestone_convergence': '阶段汇聚',
    'handoff': '会话交接',
    'unblocked': '解除冲突唤醒',
    'sequence': '时序演进'
  };

  // 1. 渲染多分支 DAG 卡片 HTML
  dom.topoNodesLayer.innerHTML = filteredNodes.map((node) => {
    const isMilestone = node.nodeType === 'milestone';
    const isHandoff = node.nodeType === 'handoff';
    const typeChipClass = isMilestone ? 'chip-topo-milestone' : isHandoff ? 'chip-topo-handoff' : 'chip-topo-completed';
    const typeLabel = isMilestone ? '里程碑达成' : isHandoff ? '会话交接' : '功能完工释放';
    const moduleName = escapeHtml(node.module || 'core');
    const causalityLabel = escapeHtml(causalityLabels[node.causalityType] || '演进');

    const timeStr = new Date(node.createdAt).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateStr = new Date(node.createdAt).toLocaleDateString([], { month: '2-digit', day: '2-digit' });

    // 文件标签
    const claimsHtml = (node.claims && node.claims.length > 0) ? `
      <div class="topo-claims-box">
        ${node.claims.map(c => {
          const targetStr = typeof c === 'string' ? c : (c?.target || '');
          if (!targetStr) return '';
          return `
            <span class="topo-claim-pill" title="${escapeHtml(targetStr)}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
              <span>${escapeHtml(targetStr.split('/').pop() || targetStr)}</span>
            </span>
          `;
        }).join('')}
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
            <span>${escapeHtml(formatAgentDisplayName(node.agentName, node.agentId))}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="drawer-meta-tag" style="font-size: 10px; padding: 2px 7px;">${moduleName}</span>
            <span class="topo-type-chip ${typeChipClass}">${typeLabel}</span>
          </div>
        </div>
        <div class="topo-card-title">${escapeHtml(node.title)}</div>
        ${node.description ? `<div class="topo-card-desc">${escapeHtml(node.description)}</div>` : ''}
        ${claimsHtml}
        <div class="topo-time-footer" style="justify-content: space-between;">
          <span style="color: var(--sky-primary); font-size: 11px;">因果: ${causalityLabel} • L${node.depth || 0}</span>
          <span>${dateStr} ${timeStr} • 点击展开详情</span>
        </div>
      </div>
    `;
  }).join('');

  // 2. 动态计算并绘制平滑 SVG 贝塞尔曲线
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

    const x1 = fromRect.left - canvasRect.left + (fromRect.width / 2);
    const y1 = fromRect.bottom - canvasRect.top;
    const x2 = toRect.left - canvasRect.left + (toRect.width / 2);
    const y2 = toRect.top - canvasRect.top;

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
  const nodeMap = new Map();
  nodes.forEach(n => nodeMap.set(n.id, n));

  cards.forEach(card => {
    const nodeId = card.getAttribute('data-node-id');
    const nodeObj = nodeMap.get(nodeId);

    // 点击卡片展开详略得当详情抽屉 (点击展开详细)
    card.onclick = () => {
      if (nodeObj) {
        openTopologyDrawer(nodeObj);
      }
    };

    card.onmouseenter = () => {
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

// 拓扑连线重绘函数（自适应视口尺寸与节点位置）
function redrawTopologyEdges() {
  if (!currentTopologyData) return;
  if (currentViewMode !== 'topology' && currentViewMode !== 'unified') return;
  const rawNodes = currentTopologyData?.nodes || [];
  const edges = currentTopologyData?.edges || [];
  const filteredNodes = rawNodes.filter(n => {
    if (!topoSearchQuery) return true;
    const matchTitle = (n.title || '').toLowerCase().includes(topoSearchQuery);
    const matchDesc = (n.description || '').toLowerCase().includes(topoSearchQuery);
    const matchAgent = (n.agentName || n.agentId || '').toLowerCase().includes(topoSearchQuery);
    const matchFiles = (n.claims || []).some(c => {
      const targetStr = typeof c === 'string' ? c : (c?.target || '');
      return targetStr.toLowerCase().includes(topoSearchQuery);
    });
    return matchTitle || matchDesc || matchAgent || matchFiles;
  });
  drawTopologyEdges(filteredNodes, edges);
}

// 监听窗口尺寸变化，自适应动态重算拓扑与协同图谱贝塞尔曲线坐标
window.addEventListener('resize', debounce(() => {
  redrawTopologyEdges();
  redrawCollabEdges();
}, 60));

// ==========================================
// Multi-Session Collaboration Graph Controller (多会话实时协同防撞车图谱)
// ==========================================
let currentCollabData = null;
let collabFilterMode = 'all'; // 'all' (全景在席含待命) or 'working' (仅看活跃施工与排队)
let standbyPoolCollapsed = false; // 是否折叠在席待命池

window.setCollabFilterMode = function(mode) {
  collabFilterMode = mode;
  const btnAll = document.getElementById('collab-filter-all');
  const btnWorking = document.getElementById('collab-filter-working');
  const btnTableAll = document.getElementById('collab-table-filter-all');
  const btnTableWorking = document.getElementById('collab-table-filter-working');

  if (btnAll) btnAll.classList.toggle('active', mode === 'all');
  if (btnWorking) btnWorking.classList.toggle('active', mode === 'working');
  if (btnTableAll) btnTableAll.classList.toggle('active', mode === 'all');
  if (btnTableWorking) btnTableWorking.classList.toggle('active', mode === 'working');

  if (currentCollabData) {
    renderCollabCanvas(currentCollabData);
    renderCollabTable(currentCollabData);
  }
};

window.toggleStandbyPool = function() {
  standbyPoolCollapsed = !standbyPoolCollapsed;
  if (currentCollabData) {
    renderCollabCanvas(currentCollabData);
  }
};

function initCollabFilters() {
  const btnAll = document.getElementById('collab-filter-all');
  const btnWorking = document.getElementById('collab-filter-working');
  const btnTableAll = document.getElementById('collab-table-filter-all');
  const btnTableWorking = document.getElementById('collab-table-filter-working');

  if (btnAll) btnAll.onclick = () => window.setCollabFilterMode('all');
  if (btnWorking) btnWorking.onclick = () => window.setCollabFilterMode('working');
  if (btnTableAll) btnTableAll.onclick = () => window.setCollabFilterMode('all');
  if (btnTableWorking) btnTableWorking.onclick = () => window.setCollabFilterMode('working');
}

async function fetchCollabGraph() {
  try {
    const res = await fetch(`/api/collaboration-graph?project_id=${encodeURIComponent(currentProjectId)}`, {
      headers: authHeaders()
    });
    if (!res.ok) return;
    const data = await res.json();
    currentCollabData = data;
    renderCollabView(data);
  } catch (err) {
    console.error('Fetch collab graph error:', err);
  }
}

if (dom.collabRefreshBtn) {
  dom.collabRefreshBtn.onclick = () => fetchCollabGraph();
}

function renderCollabView(data) {
  if (!data) return;

  const stats = data.stats || {};
  if (dom.collabStatWorking) dom.collabStatWorking.textContent = stats.working_sessions || 0;
  if (dom.collabStatWaiting) dom.collabStatWaiting.textContent = stats.waiting_sessions || 0;
  if (dom.collabStatIdle) dom.collabStatIdle.textContent = stats.idle_sessions || 0;
  if (dom.collabStatLockedRes) dom.collabStatLockedRes.textContent = stats.locked_resources || 0;
  if (dom.collabStatConflicts) {
    const conflictEdges = (data.edges || []).filter(e => e.type === 'conflict');
    dom.collabStatConflicts.textContent = conflictEdges.length;
  }

  if (dom.collabLastUpdatedText) {
    const timeStr = new Date(data.timestamp || Date.now()).toTimeString().split(' ')[0];
    dom.collabLastUpdatedText.textContent = `更新于 ${timeStr}`;
  }

  renderCollabCanvas(data);
  renderCollabTable(data);
}

function renderCollabCanvas(data) {
  if (!dom.collabNodesLayer || !dom.collabSvgLayer) return;

  const nodes = data.nodes || [];
  const edges = data.edges || [];

  if (nodes.length === 0) {
    dom.collabNodesLayer.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 60px 20px; text-align: center; color: var(--text-faint); font-size: 14px; width: 100%;">
        <div style="font-size: 16px; font-weight: 700; color: var(--text-title); margin-bottom: 8px;">当前项目暂无活跃会话或被锁定的文件</div>
        <div>当多会话启动并调用工具修改代码时，实时协同节点与防撞车依赖边将在此全景展开。</div>
      </div>
    `;
    dom.collabSvgLayer.innerHTML = '';
    return;
  }

  // 严格过滤离线会话，只感知在席会话
  const allSessionNodes = nodes.filter(n => n.node_type === 'session' && n.lifecycle_state !== 'departed');
  const resourceNodes = nodes.filter(n => n.node_type === 'resource');

  // 分层划分：活跃施工与排队 vs 在席完工待命
  const activeSessions = allSessionNodes.filter(s => s.lifecycle_state === 'working' || s.lifecycle_state === 'waiting');
  const idleSessions = allSessionNodes.filter(s => s.lifecycle_state === 'idle');

  const showIdle = (collabFilterMode === 'all');
  const displayedSessionCount = showIdle ? allSessionNodes.length : activeSessions.length;

  let sessionCardsHtml = '';

  // 1. 活跃施工与排队会话 (绝对置顶并突出显示)
  if (activeSessions.length > 0) {
    sessionCardsHtml += activeSessions.map(s => {
      const shortTarget = s.current_target ? s.current_target.split(/[\/\\]/).pop() : (s.last_target ? s.last_target.split(/[\/\\]/).pop() : null);
      const provShort = escapeHtml((s.provider || 'A').toUpperCase().slice(0, 2));
      const stateLabels = {
        working: '施工中',
        waiting: '排队中'
      };
      const stateLabel = stateLabels[s.lifecycle_state] || s.lifecycle_state;
      const toolName = s.current_tool || s.last_tool;

      return `
        <div class="collab-card session-card state-${escapeHtml(s.lifecycle_state)}" data-node-id="${escapeHtml(s.id)}">
          <div class="collab-card-top">
            <div class="collab-agent-info">
              <span class="collab-agent-avatar">${provShort}</span>
              <span class="collab-agent-name" title="${escapeHtml(s.name)}">
                ${escapeHtml(s.name)}
                ${s.pid ? `<small class="collab-pid">(PID: ${s.pid})</small>` : ''}
              </span>
            </div>
            <span class="collab-state-pill ${escapeHtml(s.lifecycle_state)}">${stateLabel}</span>
          </div>

          ${toolName ? `
            <div class="collab-tool-badge-row">
              <span class="tool-tag ${escapeHtml(toolName.toLowerCase())}">${escapeHtml(toolName)}</span>
              <span class="tool-target-text" title="${escapeHtml(s.current_target || s.last_target || s.current_action || '')}">
                ${escapeHtml(shortTarget || s.current_action || '执行中')}
              </span>
            </div>
          ` : ''}

          <div class="collab-intent-text">
            ${s.current_intent ? escapeHtml(s.current_intent) : '<span style="color: var(--text-faint); font-style: italic;">暂无意图声明</span>'}
          </div>

          ${s.active_leases_count > 0 ? `
            <div class="collab-lock-badge">
              <span>独占持锁: ${s.active_leases_count} 项</span>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  } else if (!showIdle || idleSessions.length === 0) {
    sessionCardsHtml += `
      <div class="collab-empty-column" style="padding: 24px 14px; text-align: center; color: var(--text-faint); font-size: 13px;">
        当前暂无正在修改代码或排队争用的活跃会话。
      </div>
    `;
  }

  // 2. 在席待命池 (Standby Pool) - 完工会话收拢，去噪不干扰
  if (showIdle && idleSessions.length > 0) {
    sessionCardsHtml += `
      <div class="collab-standby-pool">
        <div class="collab-standby-header" onclick="window.toggleStandbyPool()">
          <div class="collab-standby-title">
            <span class="status-hollow-dot"></span>
            <span>在席待命池 (${idleSessions.length})</span>
            <span class="collab-standby-tag">任务已完成 · 就绪</span>
          </div>
          <span class="collab-standby-toggle-btn">${standbyPoolCollapsed ? '展开 ▼' : '收起 ▲'}</span>
        </div>
        ${!standbyPoolCollapsed ? `
          <div class="collab-standby-list">
            ${idleSessions.map(s => `
              <div class="collab-card session-card state-idle compact" data-node-id="${escapeHtml(s.id)}">
                <div class="collab-card-top">
                  <div class="collab-agent-info">
                    <span class="collab-agent-avatar idle">${escapeHtml((s.provider || 'A').toUpperCase().slice(0, 2))}</span>
                    <span class="collab-agent-name" title="${escapeHtml(s.name)}">
                      ${escapeHtml(s.name)}
                      ${s.pid ? `<small class="collab-pid">(PID: ${s.pid})</small>` : ''}
                    </span>
                  </div>
                  <span class="collab-state-pill idle"><span class="status-hollow-dot"></span>待命中</span>
                </div>
                <div class="collab-idle-hint-text">会话待命就绪 · 无独占锁争用</div>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  let html = `
    <div class="collab-columns-wrapper">
      <!-- 左列：协同会话节点 (Sessions) -->
      <div class="collab-column sessions-column">
        <div class="collab-column-header">
          <span class="collab-col-title">在席助手会话 (${displayedSessionCount})</span>
          <span class="collab-col-hint">${showIdle ? '施工置顶 · 完工自动收拢待命池' : '已过滤待命会话 · 仅看活跃施工'}</span>
        </div>
        <div class="collab-cards-list">
          ${sessionCardsHtml}
        </div>
      </div>

      <!-- 右列：互斥资源与文件 (Resources / Files) -->
      <div class="collab-column resources-column">
        <div class="collab-column-header">
          <span class="collab-col-title">互斥文件与锁定资源 (${resourceNodes.length})</span>
          <span class="collab-col-hint">独占修改租约与排队申请目标</span>
        </div>
        <div class="collab-cards-list">
          ${resourceNodes.length > 0 ? resourceNodes.map(r => {
            const shortName = r.target.split(/[\/\\]/).pop();
            const isLocked = r.status === 'locked';
            const statusLabel = isLocked ? `独占锁定中 (${r.remaining_sec}s)` : '产生争用';
            const statusClass = isLocked ? 'locked' : 'contended';

            return `
              <div class="collab-card resource-card ${statusClass}" data-node-id="${escapeHtml(r.id)}">
                <div class="collab-card-top">
                  <div class="collab-res-info">
                    <span class="collab-res-icon">
                      ${r.claim_type === 'resource'
                        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"></rect><rect x="2" y="14" width="20" height="8" rx="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>'
                        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>'
                      }
                    </span>
                    <span class="collab-res-name" title="${escapeHtml(r.target)}">
                      [${escapeHtml((r.claim_type || 'file').toUpperCase())}] ${escapeHtml(shortName)}
                    </span>
                  </div>
                  <span class="collab-lock-status-pill ${statusClass}">${statusLabel}</span>
                </div>
                <div class="collab-res-path">${escapeHtml(r.target)}</div>
              </div>
            `;
          }).join('') : '<div class="collab-empty-column">当前无文件被独占锁定</div>'}
        </div>
      </div>
    </div>
  `;

  dom.collabNodesLayer.innerHTML = html;
  requestAnimationFrame(() => drawCollabEdges(nodes, edges));
}

function drawCollabEdges(nodes, edges) {
  if (!dom.collabSvgLayer || !dom.collabNodesLayer || !dom.collabCanvasInner) return;

  const innerRect = dom.collabCanvasInner.getBoundingClientRect();
  dom.collabSvgLayer.setAttribute('width', innerRect.width);
  dom.collabSvgLayer.setAttribute('height', innerRect.height);

  let svgHtml = `
    <defs>
      <linearGradient id="edge-grad-lease" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#34d399" stop-opacity="0.8" />
        <stop offset="100%" stop-color="#10b981" stop-opacity="0.9" />
      </linearGradient>
      <linearGradient id="edge-grad-waiting" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.8" />
        <stop offset="100%" stop-color="#f59e0b" stop-opacity="0.9" />
      </linearGradient>
      <linearGradient id="edge-grad-conflict" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#f87171" stop-opacity="0.9" />
        <stop offset="100%" stop-color="#ef4444" stop-opacity="1" />
      </linearGradient>
    </defs>
  `;

  const nodeElements = new Map();
  dom.collabNodesLayer.querySelectorAll('.collab-card').forEach(el => {
    const id = el.getAttribute('data-node-id');
    if (id) nodeElements.set(id, el);
  });

  edges.forEach((edge, idx) => {
    const srcEl = nodeElements.get(edge.source);
    const dstEl = nodeElements.get(edge.target);
    if (!srcEl || !dstEl) return;

    const rSrc = srcEl.getBoundingClientRect();
    const rDst = dstEl.getBoundingClientRect();

    const x1 = (rSrc.right - innerRect.left);
    const y1 = (rSrc.top + rSrc.height / 2 - innerRect.top);
    const x2 = (rDst.left - innerRect.left);
    const y2 = (rDst.top + rDst.height / 2 - innerRect.top);

    const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
    const pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

    let strokeGrad = 'url(#edge-grad-lease)';
    let strokeClass = 'edge-lease';
    if (edge.type === 'waiting_for') {
      strokeGrad = 'url(#edge-grad-waiting)';
      strokeClass = 'edge-waiting';
    } else if (edge.type === 'conflict') {
      strokeGrad = 'url(#edge-grad-conflict)';
      strokeClass = 'edge-conflict';
    }

    svgHtml += `
      <path
        id="collab-edge-${idx}"
        class="collab-edge-line ${strokeClass}"
        d="${pathD}"
        stroke="${strokeGrad}"
        data-source="${escapeHtml(edge.source)}"
        data-target="${escapeHtml(edge.target)}"
        data-type="${escapeHtml(edge.type)}"
      />
    `;
  });

  dom.collabSvgLayer.innerHTML = svgHtml;
  bindCollabHoverEvents(edges);
}

function bindCollabHoverEvents(edges) {
  if (!dom.collabNodesLayer || !dom.collabSvgLayer) return;

  const cards = dom.collabNodesLayer.querySelectorAll('.collab-card');
  const edgeLines = dom.collabSvgLayer.querySelectorAll('.collab-edge-line');

  cards.forEach(card => {
    const nodeId = card.getAttribute('data-node-id');

    card.onmouseenter = () => {
      const relatedNodes = new Set([nodeId]);
      edges.forEach(e => {
        if (e.source === nodeId || e.target === nodeId) {
          relatedNodes.add(e.source);
          relatedNodes.add(e.target);
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
        const src = l.getAttribute('data-source');
        const dst = l.getAttribute('data-target');
        if (src === nodeId || dst === nodeId) {
          l.classList.add('highlighted');
          l.classList.remove('dimmed');
        } else {
          l.classList.add('dimmed');
          l.classList.remove('highlighted');
        }
      });
    };

    card.onmouseleave = () => {
      cards.forEach(c => c.classList.remove('highlighted', 'dimmed'));
      edgeLines.forEach(l => l.classList.remove('highlighted', 'dimmed'));
    };
  });
}

function redrawCollabEdges() {
  if (!currentCollabData) return;
  if (currentViewMode !== 'collab' && currentViewMode !== 'unified') return;
  drawCollabEdges(currentCollabData.nodes || [], currentCollabData.edges || []);
}

function renderCollabTable(data) {
  if (!dom.collabTableBody) return;

  // 严格过滤掉已离线会话，只感知在席会话
  let sessionNodes = (data.nodes || []).filter(n => n.node_type === 'session' && n.lifecycle_state !== 'departed');

  if (collabFilterMode === 'working') {
    sessionNodes = sessionNodes.filter(s => s.lifecycle_state === 'working' || s.lifecycle_state === 'waiting');
  }

  if (sessionNodes.length === 0) {
    dom.collabTableBody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-faint); padding: 30px;">
          ${collabFilterMode === 'working' ? '当前项目暂无活跃施工或排队会话（待命会话已隐去）。' : '当前项目暂无在席会话记录。'}
        </td>
      </tr>
    `;
    return;
  }

  // 权重排序：施工中 (0) -> 排队中 (1) -> 在席待命 (2)
  const stateWeight = { working: 0, waiting: 1, idle: 2, departed: 3 };
  sessionNodes.sort((a, b) => {
    const wa = stateWeight[a.lifecycle_state] ?? 99;
    const wb = stateWeight[b.lifecycle_state] ?? 99;
    if (wa !== wb) return wa - wb;
    return (b.last_heartbeat || 0) - (a.last_heartbeat || 0);
  });

  const now = Date.now();
  dom.collabTableBody.innerHTML = sessionNodes.map(s => {
    const isIdle = s.lifecycle_state === 'idle';
    const shortTarget = s.current_target ? s.current_target.split(/[\/\\]/).pop() : (s.last_target ? s.last_target.split(/[\/\\]/).pop() : '-');
    const stateMap = {
      working: '<span class="status-tag working"><span class="status-pulse-dot"></span>在线施工中</span>',
      waiting: '<span class="status-tag waiting">排队等待中</span>',
      idle: '<span class="status-tag idle"><span class="status-hollow-dot"></span>在线待命</span>',
      departed: '<span class="status-tag departed">历史离线</span>'
    };
    const stateBadge = stateMap[s.lifecycle_state] || s.lifecycle_state;

    let heartbeatText = '未知';
    if (s.last_heartbeat) {
      const diffSec = Math.max(0, Math.round((now - s.last_heartbeat) / 1000));
      if (diffSec < 10) heartbeatText = '刚刚';
      else if (diffSec < 60) heartbeatText = `${diffSec} 秒前`;
      else if (diffSec < 3600) heartbeatText = `${Math.floor(diffSec / 60)} 分钟前`;
      else heartbeatText = `${Math.floor(diffSec / 3600)} 小时前`;
    }

    // 状态与工具展示清洗：idle 状态彻底去噪，消除误导
    let toolBadgeHtml = '<span style="color: var(--text-faint);">-</span>';
    let targetPillHtml = '<span style="color: var(--text-faint);">-</span>';

    if (!isIdle && (s.current_tool || s.last_tool)) {
      const t = s.current_tool || s.last_tool;
      toolBadgeHtml = `<span class="tool-tag ${escapeHtml(t.toLowerCase())}">${escapeHtml(t)}</span>`;
      targetPillHtml = (s.current_target || s.last_target)
        ? `<code class="target-code-pill" title="${escapeHtml(s.current_target || s.last_target)}">${escapeHtml(shortTarget)}</code>`
        : (s.current_action ? `<span style="font-size: 12px; color: var(--text-muted);">${escapeHtml(s.current_action)}</span>` : '<span style="color: var(--text-faint);">-</span>');
    } else if (isIdle) {
      toolBadgeHtml = '<span class="tool-tag idle-standby" title="会话已执行完当前任务，处于在席待命状态">待命中 (无调用)</span>';
      targetPillHtml = '<span style="color: var(--text-faint);">-</span>';
    }

    return `
      <tr class="${isIdle ? 'collab-row-idle' : ''}">
        <td>
          <div style="display: flex; align-items: center; gap: 8px;">
            <strong style="color: var(--text-title);">${escapeHtml(s.name)}</strong>
            ${s.pid ? `<span style="font-size: 11px; color: var(--text-faint); font-family: var(--font-mono);">(PID: ${s.pid})</span>` : ''}
          </div>
        </td>
        <td>${stateBadge}</td>
        <td>${toolBadgeHtml}</td>
        <td>${targetPillHtml}</td>
        <td>
          <span style="font-size: 13px; color: var(--text-main);">${escapeHtml(s.current_intent || '-')}</span>
        </td>
        <td>
          ${s.active_leases_count > 0
            ? `<span class="collab-table-lock-pill">独占 ${s.active_leases_count} 个锁</span>`
            : '<span style="color: var(--text-faint); font-size: 12px;">无持锁</span>'
          }
        </td>
        <td>
          <span style="font-family: var(--font-mono); font-size: 12px; color: var(--text-faint);">${heartbeatText}</span>
        </td>
      </tr>
    `;
  }).join('');
}

// 初始化
initCollabFilters();
const statusEl = document.getElementById('daemon-status');
if (statusEl && window.location.host) {
  statusEl.textContent = window.location.host;
}

const urlTab = new URLSearchParams(window.location.search).get('tab') || (window.location.hash ? window.location.hash.slice(1) : null);
if (urlTab && ['war-room', 'topology', 'collab', 'unified'].includes(urlTab)) {
  currentViewMode = urlTab;
}
setViewMode(currentViewMode);

loadProjects();
fetchDashboard();
fetchMemories();
fetchDialogues();
fetchTopologyGraph();
fetchCollabGraph();

// ==========================================
// Full-Duplex WebSocket Long Connection & Zero-Polling Event Stream
// ==========================================
let activeWs = null;
let isWsConnected = false;
let fallbackPollTimer = null;
let wsPingTimer = null;

function updateConnectionIndicators(connected) {
  if (connected) {
    if (dom.matrixStatus) dom.matrixStatus.textContent = 'LIVE WS (长连接)';
    if (dom.cockpitConnStatus) dom.cockpitConnStatus.textContent = 'WS 实时长连接';
    if (dom.cockpitLiveDot) {
      dom.cockpitLiveDot.style.background = 'var(--emerald-border)';
      dom.cockpitLiveDot.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.6)';
    }
  } else {
    if (dom.matrixStatus) dom.matrixStatus.textContent = 'POLLING (降级)';
    if (dom.cockpitConnStatus) dom.cockpitConnStatus.textContent = '保底轮询中';
    if (dom.cockpitLiveDot) {
      dom.cockpitLiveDot.style.background = '#f59e0b';
      dom.cockpitLiveDot.style.boxShadow = '0 0 10px rgba(245, 158, 11, 0.6)';
    }
  }
}

function startFallbackPolling() {
  if (fallbackPollTimer) return;
  // 当且仅当 WebSocket 断开时，才启动保底慢轮询（10s），彻底告别暴力轮询
  fallbackPollTimer = setInterval(() => {
    if (isWsConnected) return;
    fetchDashboard();
    fetchDialogues();
    if (currentViewMode === 'topology') debouncedFetchTopology();
    else if (currentViewMode === 'collab') debouncedFetchCollab();
    else if (currentViewMode === 'unified') debouncedFetchCockpit();
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
    const wsUrl = token
      ? `${protocol}//${location.host}/?token=${encodeURIComponent(token)}`
      : `${protocol}//${location.host}`;

    const ws = new WebSocket(wsUrl);
    activeWs = ws;

    ws.onopen = () => {
      isWsConnected = true;
      stopFallbackPolling();
      updateConnectionIndicators(true);

      // 启动心跳维持，避免代理或浏览器闲置关闭连接
      if (wsPingTimer) clearInterval(wsPingTimer);
      wsPingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'ping' }));
          } catch {}
        }
      }, 25000);

      // 请求最新快照
      try {
        ws.send(JSON.stringify({ type: 'sync:request', project_id: currentProjectId }));
      } catch {}
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);

        // 1. 服务端直推的完整初始化状态与即时全景同步
        if (payload.type === 'init:state' || payload.type === 'sync:response') {
          if (payload.data?.snapshot) {
            currentDashboardData = payload.data.snapshot;
            // 快照与 /api/dashboard 响应结构一致，直接走同一组渲染器；
            // 早先调用的 renderDashboard 从未定义，会让整段推送处理抛错中断。
            renderDashboardSnapshot(payload.data.snapshot);
          }
          if (payload.data?.cockpit) {
            currentCockpitData = payload.data.cockpit;
            renderUnifiedCockpit(payload.data.cockpit);
          }
          if (currentViewMode === 'topology') {
            debouncedFetchTopology();
          } else if (currentViewMode === 'collab') {
            debouncedFetchCollab();
          }
          return;
        }

        // 2. 演进拓扑节点创建事件
        if (payload.type === 'topology:node_created') {
          debouncedFetchTopology();
          debouncedFetchCockpit();
          return;
        }

        // 3. Agent 施工遥测、状态转移、资源释放事件
        if (payload.type === 'agent:telemetry' || payload.type === 'agent:status' || payload.type === 'resource:freed' || payload.type === 'agent:woken') {
          debouncedFetchDashboard();
          debouncedFetchCollab();
          debouncedFetchCockpit();
          return;
        }

        // 4. 跨会话调度、对话与架构师广播事件
        if (payload.type === 'lead:broadcast' || payload.type === 'message:sent' || payload.type === 'messages:read') {
          debouncedFetchDialogues();
          debouncedFetchCockpit();
          debouncedFetchDashboard();
          return;
        }

        // 5. 记忆存取事件
        if (payload.type && payload.type.startsWith('memory:')) {
          debouncedFetchMemories();
          return;
        }

        // 6. Lead 唤醒事件
        if (payload.type === 'lead:awakened') {
          handleLeadAwakened(payload.data);
          debouncedFetchDashboard();
          debouncedFetchDialogues();
          debouncedFetchCockpit();
          debouncedFetchCollab();
          return;
        }

        // 其他未知通知统一触发防抖刷新
        debouncedFetchDashboard();
        debouncedFetchCollab();
        debouncedFetchCockpit();
      } catch (err) {
        console.error('Failed to parse WS event payload:', err);
      }
    };

    ws.onclose = () => {
      isWsConnected = false;
      if (wsPingTimer) {
        clearInterval(wsPingTimer);
        wsPingTimer = null;
      }
      updateConnectionIndicators(false);
      startFallbackPolling();
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch (err) {
    console.error('WebSocket connection initialization error:', err);
    isWsConnected = false;
    updateConnectionIndicators(false);
    startFallbackPolling();
    setTimeout(connectWebSocket, 5000);
  }
}

connectWebSocket();
