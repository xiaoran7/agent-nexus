// =============================================================================
// Agent-Nexus Companion Console Controller (Compact 800x560 High-Density UX)
// =============================================================================

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
let currentTimelineFilter = 'all';
let currentDashboardData = null;
let currentTimelineData = [];

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

  // View 2: Stream & Logs
  dialogueCounter: document.getElementById('dialogue-counter'),
  dialogueStream: document.getElementById('dialogue-stream'),
  milestonesCounter: document.getElementById('milestones-counter'),
  milestonesContainer: document.getElementById('milestones-container'),

  // View 3: Memory & Rules
  memoryCounter: document.getElementById('memory-counter'),
  memorySearchInput: document.getElementById('memory-search-input'),
  memoryItemsContainer: document.getElementById('memory-items-container'),
  newMemCat: document.getElementById('new-mem-cat'),
  newMemKey: document.getElementById('new-mem-key'),
  newMemContent: document.getElementById('new-mem-content'),
  saveMemBtn: document.getElementById('save-mem-btn')
};

// =============================================================================
// Theme Management (暗色 / 亮色持久化与实时切换)
// =============================================================================
function getPreferredTheme() {
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
  } else if (viewName === 'memory') {
    fetchMemories();
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
    fetchDashboard();
    fetchDialogues();
    fetchMilestones();
    fetchMemories();
  };
}

// =============================================================================
// Project Selection & Persistence
// =============================================================================
if (dom.projectSelector) {
  dom.projectSelector.onchange = () => {
    currentProjectId = dom.projectSelector.value;
    localStorage.setItem('nexusProjectId', currentProjectId);
    fetchDashboard();
    fetchDialogues();
    fetchMilestones();
    fetchMemories();
  };
}

async function loadProjects() {
  try {
    const res = await fetch('/api/projects', { headers: authHeaders() });
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

    const allOption = `<option value="all" ${currentProjectId === 'all' ? 'selected' : ''}>全景工程 (跨项目)</option>`;
    const projectOptions = uniqueProjects.map(p => {
      const idSafe = escapeHtml(p.id);
      const nameSafe = escapeHtml(p.display_name || p.id);
      const selected = (p.id === currentProjectId && currentProjectId !== 'all') ? 'selected' : '';
      return `<option value="${idSafe}" ${selected}>${nameSafe}</option>`;
    }).join('');

    dom.projectSelector.innerHTML = allOption + projectOptions;

    fetchDashboard();
    fetchDialogues();
    fetchMilestones();
    fetchMemories();
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
      if (dom.daemonStatus) dom.daemonStatus.textContent = 'NEEDS TOKEN';
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

// 渲染活跃助手 (只渲染 working / waiting，过滤掉历史离线僵尸会话)
function renderActiveAgents(agents, activeClaims) {
  if (!dom.agentsContainer) return;

  const validAgents = [];
  const claimsList = activeClaims || [];

  for (const a of (agents || [])) {
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
      validAgents.push({ ...a, resolvedClaims: claims, uiState: 'working', badgeText: '施工中' });
    } else if (isWaiting) {
      validAgents.push({ ...a, resolvedClaims: claims, uiState: 'waiting', badgeText: '排队中' });
    } else {
      // 保持在线但暂未持有写锁的就绪助手
      validAgents.push({ ...a, resolvedClaims: claims, uiState: 'idle', badgeText: '待命' });
    }
  }

  if (dom.agentsMeta) {
    dom.agentsMeta.textContent = `${validAgents.length} 个在席`;
  }

  if (validAgents.length === 0) {
    dom.agentsContainer.innerHTML = '<div class="empty-hint">暂无活跃会话，当 Claude Code / Codex 启动时将自动感知接入</div>';
    return;
  }

  dom.agentsContainer.innerHTML = validAgents.map(a => {
    const displayName = formatAgentDisplayName(a.name, a.id, a.provider, a.session_id, a.current_intent || a.current_intent_summary);
    const nameSafe = escapeHtml(displayName);
    const providerSafe = escapeHtml((a.provider || 'Claude').toUpperCase());
    const intentSafe = escapeHtml(a.current_intent || a.current_action || '就绪待命中');
    const toolSafe = a.last_tool ? escapeHtml(a.last_tool) : null;
    const targetSafe = a.last_target ? escapeHtml(a.last_target.split(/[\/\\]/).pop()) : null;
    const claims = a.resolvedClaims || [];

    return `
      <div class="agent-card-item is-${a.uiState}">
        <div class="agent-card-header">
          <div class="agent-name-group">
            <span class="agent-status-badge badge-${a.uiState}">${a.badgeText}</span>
            <span class="agent-title" title="${nameSafe}">${nameSafe}</span>
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
    const holder = (agents || []).find(a => a.id === c.agent_id);
    const holderName = escapeHtml(holder ? formatAgentDisplayName(holder.name, holder.id) : c.agent_id);
    const shortTarget = escapeHtml(c.claim_target.split(/[\/\\]/).pop());
    const fullTarget = escapeHtml(c.claim_target);
    const remainingSec = Math.max(0, Math.ceil((c.expires_at - now) / 1000));
    const leaseId = escapeHtml(c.lease_id || '');

    return `
      <div class="lock-card-item">
        <div class="lock-target-info">
          <span class="lock-target-name" title="${fullTarget}">${shortTarget}</span>
          <span class="lock-holder-desc">${holderName} · 剩余 ${remainingSec}s</span>
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
// Memory & Rules (View 3)
// =============================================================================
async function fetchMemories(query = '') {
  try {
    const url = query
      ? `/api/projects/${encodeURIComponent(currentProjectId)}/memories?q=${encodeURIComponent(query)}`
      : `/api/projects/${encodeURIComponent(currentProjectId)}/memories`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    const list = await res.json();
    if (!Array.isArray(list)) return;

    if (dom.memoryCounter) {
      dom.memoryCounter.textContent = `${list.length} 项规约`;
    }
    if (!dom.memoryItemsContainer) return;

    if (list.length === 0) {
      dom.memoryItemsContainer.innerHTML = '<div class="empty-hint">暂无长期备忘或规约记录</div>';
      return;
    }

    dom.memoryItemsContainer.innerHTML = list.map(m => {
      const catSafe = escapeHtml(m.category || 'general');
      const keySafe = escapeHtml(m.key);
      const contentSafe = escapeHtml(m.content);

      return `
        <div class="memory-card">
          <div class="memory-card-head">
            <span class="memory-cat-badge cat-${catSafe}">${catSafe}</span>
            <span class="memory-key">${keySafe}</span>
          </div>
          <div class="memory-body">${contentSafe}</div>
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
    if (!key || !content) return alert('Key 和内容均为必填项');

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
      alert('保存失败: ' + err.message);
    }
  };
}

const debouncedSearchMemories = debounce((q) => fetchMemories(q), 250);
if (dom.memorySearchInput) {
  dom.memorySearchInput.oninput = (e) => {
    debouncedSearchMemories(e.target.value.trim());
  };
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
const debouncedFetchMemories = debounce(fetchMemories, 500);

function updateConnectionIndicators(connected) {
  if (dom.liveDot) {
    dom.liveDot.classList.toggle('disconnected', !connected);
  }
  if (dom.daemonStatus) {
    dom.daemonStatus.textContent = connected ? '守护就绪' : '脱机重连中';
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
    const wsUrl = token
      ? `${protocol}//${location.host}/?token=${encodeURIComponent(token)}`
      : `${protocol}//${location.host}`;

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
          } catch {}
        }
      }, 25000);

      try {
        ws.send(JSON.stringify({ type: 'sync:request', project_id: currentProjectId }));
      } catch {}
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);

        if (payload.type === 'init:state' || payload.type === 'sync:response') {
          if (payload.data?.snapshot) {
            currentDashboardData = payload.data.snapshot;
            renderDashboardSnapshot(payload.data.snapshot);
          }
          return;
        }

        if (payload.type === 'agent:telemetry' || payload.type === 'agent:status' || payload.type === 'resource:freed' || payload.type === 'agent:woken') {
          debouncedFetchDashboard();
          return;
        }

        if (payload.type === 'lead:broadcast' || payload.type === 'message:sent' || payload.type === 'messages:read') {
          debouncedFetchDialogues();
          debouncedFetchDashboard();
          return;
        }

        if (payload.type && payload.type.startsWith('memory:')) {
          debouncedFetchMemories();
          debouncedFetchMilestones();
          return;
        }

        if (payload.type === 'lead:awakened') {
          handleLeadAwakened(payload.data);
          debouncedFetchDashboard();
          debouncedFetchDialogues();
          return;
        }

        debouncedFetchDashboard();
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
loadProjects();
connectWebSocket();
