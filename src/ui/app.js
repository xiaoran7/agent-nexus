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
  matrixStatus: document.getElementById('matrix-last-updated'),
  lanesContainer: document.getElementById('lanes-container'),
  lanesStatus: document.getElementById('lanes-status'),
  agentsContainer: document.getElementById('agents-container'),
  timelineContainer: document.getElementById('timeline-container'),
  metricTotalAgents: document.getElementById('metric-total-agents'),
  metricRunning: document.getElementById('metric-running'),
  metricWaiting: document.getElementById('metric-waiting'),
  metricMemories: document.getElementById('metric-memories'),
  memoryCountBadge: document.getElementById('memory-count-badge')
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

// 初始化
loadProjects();
fetchDashboard();
fetchMemories();

// 定时保底轮询（2500ms 刷新频率完全符合 60 FPS 规约）
setInterval(fetchDashboard, 2500);

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
