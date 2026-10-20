import { randomUUID } from 'node:crypto';
import { normalize, resolve, isAbsolute, join } from 'node:path';
import { existsSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { ValidationError, requireString } from '../domain/errors.js';
import { resolveProject, resolveProjectDisplayName } from '../domain/project.js';

export { ValidationError };

/**
 * 判定会话名称是否为机械截断哈希、编号或系统默认占位符
 * 匹配形态：
 * - claude-4fcfc1, claude-02da4c, agent-9a8b7c
 * - Claude (02da4c9d), Claude (1), Agent (abc12345), Unknown (default)
 * - 纯十六进制哈希或简易编号: 02da4c9d, 123456, Claude 1
 */
export function isMechanicalAgentName(name) {
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

export function formatAgentDefaultName(provider, sessionId, agentId) {
  const prov = (provider || 'agent').toLowerCase();
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
  return provMap[prov] || `${prov.charAt(0).toUpperCase() + prov.slice(1)} 助手`;
}

export function sanitizeAgentName(name, agentId, provider, sessionId, intentSummary = null) {
  const parts = (agentId || '').split('-');
  const prov = provider || parts[0] || 'agent';
  const sess = sessionId || parts.slice(1).join('-') || '';

  if (typeof name === 'string' && name.trim()) {
    const trimmed = cleanUtf8String(name.trim(), '');
    // 过滤替换字符、私有区符号或控制字符、纯标点符号
    if (trimmed && !/^[?\s.\-=_]+$/.test(trimmed)) {
      if (!isMechanicalAgentName(trimmed)) {
        return trimmed;
      }
    }
  }

  // 尝试使用意图摘要进行语义化命名 (如 "AI检索优化")
  if (intentSummary && typeof intentSummary === 'string' && intentSummary.trim()) {
    const cleanIntent = cleanUtf8String(intentSummary.trim(), '');
    if (cleanIntent && !isMechanicalAgentName(cleanIntent) && !/^[?\s.\-=_]+$/.test(cleanIntent)) {
      return cleanIntent.length > 40 ? cleanIntent.slice(0, 40) : cleanIntent;
    }
  }

  return formatAgentDefaultName(prov, sess, agentId);
}

/**
 * 读取本机 Claude Code Desktop 维护的长效 Worker 进程会话注册表 (~/.claude/sessions/<pid>.json)
 * 每个文件文件名即为常驻 worker 进程 PID，内含真实 sessionId、工作目录 cwd 与语义化名称 name
 */
export function getClaudeSessionRegistry(customDir = null) {
  const dir = customDir || join(homedir(), '.claude', 'sessions');
  const sessions = [];
  try {
    if (!existsSync(dir)) return sessions;
    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const fullPath = join(dir, f);
        const data = JSON.parse(readFileSync(fullPath, 'utf8'));
        if (data && data.sessionId && data.pid) {
          const alive = isPidAlive(data.pid);
          sessions.push({
            pid: data.pid,
            sessionId: data.sessionId,
            name: data.name ? cleanUtf8String(data.name, '') : null,
            cwd: data.cwd || null,
            status: data.status || 'idle',
            startedAt: data.startedAt,
            updatedAt: data.updatedAt,
            alive
          });
        }
      } catch {}
    }
  } catch {}
  return sessions;
}

/**
 * 通用 UTF-8 字符串净洗器：
 * 1. 彻底剔除 Unicode 替换符 (� / ) 与各类损坏字节碎片
 * 2. 剥离不可见 ASCII 控制字符（保留正常标点、换行与空格）
 * 3. 拦截类似 "????" 的无效占位符，返回安全兜底描述
 */
export function cleanUtf8String(str, fallback = '') {
  if (str == null) return fallback;
  if (typeof str !== 'string') return String(str);
  let s = str.trim();
  if (!s) return fallback;
  if (s.includes('�') || s.includes('')) {
    s = s.replace(/[�]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  if (!s) return fallback;
  if (/^[?\s.\-=_]+$/.test(s) && s.length > 2) {
    return fallback;
  }
  return s;
}

/**
 * 操作系统进程存活无感探针：
 * 使用 process.kill(pid, 0) 发送探测信号（不终止进程）
 * ESRCH 表明进程已消亡；EPERM 表明进程依然存活运行
 */
export function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    if (err.code === 'EPERM') return true;
    return false;
  }
}

const CLAIM_TYPES = new Set(['file', 'module', 'symbol', 'resource']);

const CLAIM_TARGET_RE = /^[^\s/\\][^\s]*$/;

function isPathAbsolute(p) {
  if (!p || typeof p !== 'string') return false;
  return p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:[/\\]/.test(p);
}

function resolveSafe(baseDir, value) {
  if (!value) return '';
  if (isPathAbsolute(value)) {
    return value;
  }
  if (baseDir && /^[a-zA-Z]:[/\\]/.test(baseDir) && process.platform !== 'win32') {
    const cleanBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const cleanRel = value.replace(/\\/g, '/').replace(/^\/+/, '');
    return `${cleanBase}/${cleanRel}`;
  }
  return baseDir ? resolve(baseDir, value) : resolve(value);
}

function toComparablePath(value, baseDir, projectRoot) {
  let resolved = resolveSafe(baseDir, value);
  try {
    if (existsSync(resolved)) {
      resolved = realpathSync(resolved);
    }
  } catch {}

  // 跨 Worktree 相对化对齐：若指定了 projectRoot 且 baseDir 与 projectRoot 不一致，将工作树内的文件映射到主工程路径
  if (projectRoot && baseDir) {
    const canonicalBase = baseDir.replace(/\\/g, '/').toLowerCase();
    const canonicalProj = projectRoot.replace(/\\/g, '/').toLowerCase();
    const canonicalTarget = resolved.replace(/\\/g, '/').toLowerCase();

    if (canonicalBase !== canonicalProj && canonicalTarget.startsWith(canonicalBase + '/')) {
      const rel = canonicalTarget.slice(canonicalBase.length + 1);
      resolved = resolveSafe(projectRoot, rel);
    }
  }

  let normalized = resolved.replace(/\\/g, '/');
  return normalize(normalized).replace(/\\/g, '/').toLowerCase();
}

function requireAgentId(value) {
  return requireString(value, 'agent_id');
}

function splitTargetAnchor(target) {
  if (typeof target !== 'string') return { baseTarget: '', anchor: null };
  const hashIdx = target.indexOf('#');
  if (hashIdx === -1) return { baseTarget: target, anchor: null };
  const baseTarget = target.slice(0, hashIdx).trim();
  const anchor = target.slice(hashIdx + 1).trim().toLowerCase();
  return { baseTarget, anchor: anchor || null };
}

function assertClaimTarget(raw, claimType, baseDir, projectRoot) {
  const target = requireString(raw, 'claims[].target');

  if (!CLAIM_TYPES.has(claimType)) {
    throw new ValidationError(
      `Unsupported claim type "${claimType}"; expected one of ${[...CLAIM_TYPES].join(', ')}`,
      'claims[].type'
    );
  }

  if (claimType === 'symbol') {
    if (!CLAIM_TARGET_RE.test(target)) {
      throw new ValidationError('Symbol target must not start with a path separator or whitespace', 'claims[].target');
    }
    return { type: claimType, target: target.toLowerCase() };
  }

  if (claimType === 'resource') {
    const cleanTarget = target.trim().toLowerCase();
    if (!cleanTarget || !CLAIM_TARGET_RE.test(cleanTarget)) {
      throw new ValidationError('Resource target must not be empty or contain whitespace/path separators', 'claims[].target');
    }
    return { type: claimType, target: cleanTarget };
  }

  // 支持大文件局部锁 file#anchor（如 admin.html#header-nav）
  const { baseTarget, anchor } = splitTargetAnchor(target);
  const normalizedBase = toComparablePath(baseTarget, baseDir, projectRoot);
  if (normalizedBase === toComparablePath('.', baseDir, projectRoot) || normalizedBase === toComparablePath('/', baseDir, projectRoot)) {
    throw new ValidationError(
      `Claim target "${target}" resolves to a directory root or the working directory, not a specific resource`,
      'claims[].target'
    );
  }
  const normalized = anchor ? `${normalizedBase}#${anchor}` : normalizedBase;
  return { type: claimType, target: normalized };
}

// 只有真正修改代码/文件的写工具（Write/Edit/MultiEdit/NotebookEdit/Update/apply_patch）才计入施工活跃状态；
// 只读或查询工具（Read/Grep/Glob）不引起代码修改冲突，在席保持在线待命 (idle)
export const WRITE_TOOLS_SET = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Update', 'apply_patch'
]);

export function isExecutingWorkingTool(tool, heartbeat, now) {
  if (!tool || typeof tool !== 'string' || !tool.trim()) return false;
  if (WRITE_TOOLS_SET.has(tool)) {
    return (now - (heartbeat || 0)) <= 60000;
  }
  return false;
}

export function computeAgentLifecycleState(agent, now) {
  const isPidActive = agent.pid ? isPidAlive(agent.pid) : false;
  const isHeartbeatFresh = (now - (agent.last_heartbeat || 0)) <= 120000;
  const isOnline = isPidActive || isHeartbeatFresh;

  if (!isOnline) {
    return { lifecycleState: 'departed', isOnline: false };
  }

  // 1. 待命 (waiting): 专指因资源冲突、锁争用或显式进入等待队列而阻塞排队的状态
  if (agent.current_intent_status === 'waiting' || agent.status === 'waiting' || agent.blocked_reason) {
    return { lifecycleState: 'waiting', isOnline: true };
  }

  // 2. 施工中 (working): 只要有工作（包括持有有效租约、或执行 Read/Grep/Glob/Bash/Edit/Write 等任何工具并在活跃窗口内）
  if (
    (agent.active_leases_count || 0) > 0 ||
    agent.status === 'running' ||
    agent.current_intent_status === 'running' ||
    agent.current_intent_status === 'granted' ||
    isExecutingWorkingTool(agent.last_tool, agent.last_heartbeat, now)
  ) {
    return { lifecycleState: 'working', isOnline: true };
  }

  // 3. 空闲待命 (idle): 在线且无工作、未被阻塞
  return { lifecycleState: 'idle', isOnline: true };
}

export class CoordinatorEngine {
  constructor(db, eventBus, options = {}) {
    this.db = db;
    this.eventBus = eventBus;
    this.options = options;
    const isTest = !!(options.isTest || process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT || process.env.npm_lifecycle_event === 'test');
    this.claudeSessionsDir = options.claudeSessionsDir !== undefined ? options.claudeSessionsDir : (isTest ? null : join(homedir(), '.claude', 'sessions'));
  }

  normalizePath(filePath, baseDir, projectRoot) {
    if (!filePath) return '';
    return toComparablePath(filePath, baseDir, projectRoot);
  }

  pathsOverlap(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.startsWith(b + '/') || b.startsWith(a + '/');
  }

  // 四级冲突判定的唯一实现，加入 projectId 作用域与资源锁互斥，支持 #anchor 大文件细粒度锁
  findConflict(normalizedClaims, agentId, now, projectId = 'default') {
    const activeClaims = this.db.prepare(`
      SELECT c.claim_type, c.claim_target, c.agent_id, l.intent_id, l.expires_at,
             a.name as agent_name, a.workspace_dir as holder_workspace
      FROM claims c
      JOIN leases l ON c.intent_id = l.intent_id
      JOIN agents a ON c.agent_id = a.id
      WHERE (l.project_id = ? OR l.project_id = 'default' OR ? = 'default') AND l.expires_at > ? AND (c.project_id = ? OR c.project_id = 'default' OR ? = 'default')
    `).all(projectId, projectId, now, projectId, projectId);

    for (const claim of normalizedClaims) {
      for (const active of activeClaims) {
        if (active.agent_id === agentId) {
          continue;
        }

        const remainingSec = Math.max(0, Math.ceil((active.expires_at - now) / 1000));
        const meta = {
          blockedByAgentId: active.agent_id,
          blockedByAgentName: active.agent_name,
          holderWorkspace: active.holder_workspace || '',
          claimType: active.claim_type,
          claimTarget: active.claim_target,
          expiresAt: active.expires_at,
          remainingSec
        };

        // Rule 1: 文件精确重合或大文件锚点判定 (#anchor)
        if (claim.type === 'file' && active.claim_type === 'file') {
          const { baseTarget: baseA, anchor: anchorA } = splitTargetAnchor(claim.target);
          const { baseTarget: baseB, anchor: anchorB } = splitTargetAnchor(active.claim_target);

          if (baseA === baseB) {
            // 如果双方都显式指定了不同的 anchor，属于文件不同逻辑区域，允许并发施工
            if (anchorA && anchorB && anchorA !== anchorB) {
              continue;
            }

            const isAnchorConflict = Boolean(anchorA && anchorB);
            const reason = isAnchorConflict
              ? `Anchor conflict: Section '#${anchorA}' in '${baseA}' is currently locked by ${active.agent_name}`
              : `File conflict: '${baseA}' ${!anchorB ? 'whole file is locked by' : "section '#" + anchorB + "' is locked by"} ${active.agent_name}`;

            return {
              ...meta,
              reason
            };
          }
        }

        // Rule 2: 模块 / 目录包含关系 (模块锁包含文件及其所有 anchor 锚点)
        if (claim.type === 'module' || active.claim_type === 'module') {
          const targetA = claim.type === 'file' ? splitTargetAnchor(claim.target).baseTarget : claim.target;
          const targetB = active.claim_type === 'file' ? splitTargetAnchor(active.claim_target).baseTarget : active.claim_target;

          if (this.pathsOverlap(targetA, targetB)) {
            return {
              ...meta,
              reason: `Module conflict between '${claim.target}' and '${active.claim_target}' held by ${active.agent_name}`
            };
          }
        }

        // Rule 3: 符号精确重合
        if (claim.type === 'symbol' && active.claim_type === 'symbol') {
          if (claim.target === active.claim_target) {
            return {
              ...meta,
              reason: `Symbol conflict: '${claim.target}' is being modified by ${active.agent_name}`
            };
          }
        }

        // Rule 4: 命名资源互斥 (Resource Mutual Exclusion)
        if (claim.type === 'resource' && active.claim_type === 'resource') {
          if (claim.target === active.claim_target) {
            return {
              ...meta,
              reason: `Resource conflict: '${claim.target}' is currently held by ${active.agent_name}`
            };
          }
        }
      }
    }
    return null;
  }


  // 0.1 扫描并长效同步系统 Claude Code 会话进程状态
  syncClaudeSessions(now = Date.now(), customDir = null) {
    const targetDir = customDir !== null && customDir !== undefined ? customDir : this.claudeSessionsDir;
    if (!targetDir) return;
    const sessions = getClaudeSessionRegistry(targetDir);
    for (const sess of sessions) {
      if (!sess.alive) continue;

      let agent = this.db.prepare(`
        SELECT * FROM agents
        WHERE session_id = ? OR id = ? OR id = ? OR (provider = 'claude' AND session_id LIKE ? || '%')
      `).get(sess.sessionId, sess.sessionId, `claude-${sess.sessionId}`, sess.sessionId.slice(0, 8));

      const cleanName = sess.name && !isMechanicalAgentName(sess.name) ? sess.name : null;

      if (agent) {
        const shouldUpdateName = cleanName && (isMechanicalAgentName(agent.name) || !agent.name);
        const targetName = shouldUpdateName ? cleanName : agent.name;
        const newHeartbeat = Math.max(agent.last_heartbeat || 0, sess.updatedAt || now);
        const mappedStatus = sess.status === 'busy' ? 'running' : 'idle';

        this.db.prepare(`
          UPDATE agents
          SET pid = ?,
              name = ?,
              last_heartbeat = ?,
              status = CASE
                WHEN status = 'waiting' THEN status
                ELSE ?
              END
          WHERE id = ?
        `).run(sess.pid, targetName, newHeartbeat, mappedStatus, agent.id);
      } else {
        let projectId = 'default';
        let projectRoot = sess.cwd || '';
        if (sess.cwd) {
          try {
            const pInfo = resolveProject(sess.cwd);
            if (pInfo && pInfo.projectId) {
              projectId = pInfo.projectId;
              projectRoot = pInfo.projectRoot;
            }
          } catch {}
        }

        const agentId = `claude-${sess.sessionId}`;
        const finalName = cleanName || 'Claude 助手';
        const initialStatus = sess.status === 'busy' ? 'running' : 'idle';

        this.db.prepare(`
          INSERT INTO agents (id, project_id, name, provider, session_id, workspace_dir, status, last_heartbeat, registered_at, pid)
          VALUES (?, ?, ?, 'claude', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = CASE WHEN excluded.name != '' THEN excluded.name ELSE agents.name END,
            pid = excluded.pid,
            last_heartbeat = excluded.last_heartbeat,
            status = CASE
              WHEN agents.status = 'waiting' THEN agents.status
              ELSE excluded.status
            END
        `).run(agentId, projectId, finalName, sess.sessionId, sess.cwd || '', initialStatus, now, sess.startedAt || now, sess.pid);

        if (sess.cwd && projectId && projectId !== 'all') {
          try {
            const canonicalRoot = toComparablePath(sess.cwd);
            const displayName = resolveProjectDisplayName(sess.cwd, canonicalRoot, projectId);
            this.db.prepare(`
              INSERT INTO projects (id, root_path, display_name, created_at, last_activity)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                root_path = CASE WHEN projects.root_path IS NULL OR projects.root_path = '' THEN excluded.root_path ELSE projects.root_path END,
                display_name = CASE WHEN excluded.display_name IS NOT NULL AND excluded.display_name != '' THEN excluded.display_name ELSE projects.display_name END,
                last_activity = excluded.last_activity
            `).run(projectId, projectRoot, displayName, now, now);
          } catch {}
        }
      }
    }
  }

  // 1. Agent 注册或心跳续期
  registerAgent(params = {}) {
    const id = params.id || params.agentId || params.agent_id;
    requireAgentId(id);

    const now = Date.now();
    const finalSessionId = (params.sessionId ?? params.session_id) == null ? 'default' : String(params.sessionId ?? params.session_id);
    const finalProvider = (params.provider ?? 'unknown') == null ? 'unknown' : String(params.provider);
    let finalName = sanitizeAgentName(params.name, id, finalProvider, finalSessionId);
    if (isMechanicalAgentName(finalName)) {
      const existing = this.db.prepare('SELECT name FROM agents WHERE id = ?').get(id);
      if (existing?.name && !isMechanicalAgentName(existing.name)) {
        finalName = existing.name;
      } else if (this.claudeSessionsDir) {
        const reg = getClaudeSessionRegistry(this.claudeSessionsDir);
        const matched = reg.find(s => s.sessionId === finalSessionId || `claude-${s.sessionId}` === id);
        if (matched?.name && !isMechanicalAgentName(matched.name)) {
          finalName = matched.name;
        }
      }
    }
    const finalProjectId = params.projectId || params.project_id || 'default';
    const workspaceDir = params.workspaceDir || params.workspace_dir || '';
    const rawPid = params.pid;
    const parsedPid = rawPid ? parseInt(rawPid, 10) : null;
    const finalPid = Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;
    const cleanTool = cleanUtf8String(params.lastTool || params.tool || params.toolName, null);
    const cleanAction = cleanUtf8String(params.lastAction || params.action || params.toolAction, null);
    const cleanTarget = cleanUtf8String(params.lastTarget || params.target || params.toolTarget, null);

    const stmt = this.db.prepare(`
      INSERT INTO agents (id, project_id, name, provider, session_id, workspace_dir, status, last_heartbeat, registered_at, pid, last_tool, last_action, last_target)
      VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        workspace_dir = excluded.workspace_dir,
        last_heartbeat = excluded.last_heartbeat,
        pid = CASE WHEN excluded.pid IS NOT NULL THEN excluded.pid ELSE agents.pid END,
        last_tool = CASE WHEN excluded.last_tool IS NOT NULL THEN excluded.last_tool ELSE agents.last_tool END,
        last_action = CASE WHEN excluded.last_action IS NOT NULL THEN excluded.last_action ELSE agents.last_action END,
        last_target = CASE WHEN excluded.last_target IS NOT NULL THEN excluded.last_target ELSE agents.last_target END
    `);
    stmt.run(id, finalProjectId, finalName, finalProvider, finalSessionId, workspaceDir || '', now, now, finalPid, cleanTool, cleanAction, cleanTarget);

    if (workspaceDir && finalProjectId && finalProjectId !== 'all') {
      try {
        const canonicalRoot = toComparablePath(workspaceDir);
        const displayName = resolveProjectDisplayName(workspaceDir, canonicalRoot, finalProjectId);
        this.db.prepare(`
          INSERT INTO projects (id, root_path, display_name, created_at, last_activity)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            root_path = CASE WHEN projects.root_path IS NULL OR projects.root_path = '' THEN excluded.root_path ELSE projects.root_path END,
            display_name = CASE
              WHEN excluded.display_name IS NOT NULL
                AND excluded.display_name != ''
                AND NOT excluded.display_name LIKE 'Project %'
              THEN excluded.display_name
              WHEN projects.display_name IS NULL
                OR projects.display_name = ''
                OR projects.display_name LIKE 'Project %'
              THEN excluded.display_name
              ELSE projects.display_name
            END,
            last_activity = excluded.last_activity
        `).run(finalProjectId, canonicalRoot, displayName, now, now);
      } catch {}
    }

    this.logActivity(id, 'agent:registered', null, `Agent ${finalName} (${finalProvider}) registered/heartbeat`, finalProjectId);
    return this.getAgent(id);
  }

  // 1.1 实时工具与调用态势上报 (Tool Telemetry)
  recordTelemetry(params = {}) {
    const agentId = params.agentId || params.agent_id || params.id;
    requireAgentId(agentId);
    const now = Date.now();
    const finalProjectId = params.projectId || params.project_id || 'default';
    const cleanTool = cleanUtf8String(params.toolName || params.tool || params.lastTool, null);
    const cleanAction = cleanUtf8String(params.toolAction || params.action || params.lastAction, cleanTool);
    const cleanTarget = cleanUtf8String(params.toolTarget || params.target || params.lastTarget, null);
    const rawPid = params.pid;
    const parsedPid = rawPid ? parseInt(rawPid, 10) : null;
    const finalPid = Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;

    let agent = this.getAgent(agentId, finalProjectId);
    if (params.name && !isMechanicalAgentName(params.name)) {
      this.db.prepare('UPDATE agents SET name = ? WHERE id = ?').run(params.name, agentId);
    }
    if (!agent) {
      this.registerAgent({
        id: agentId,
        provider: params.provider,
        sessionId: params.sessionId || params.session_id,
        workspaceDir: params.workspaceDir || params.workspace_dir,
        projectId: finalProjectId,
        pid: finalPid,
        lastTool: cleanTool,
        lastAction: cleanAction,
        lastTarget: cleanTarget
      });
    } else {
      this.db.prepare(`
        UPDATE agents
        SET last_heartbeat = ?,
            last_tool = COALESCE(?, last_tool),
            last_action = COALESCE(?, last_action),
            last_target = COALESCE(?, last_target),
            pid = CASE WHEN ? IS NOT NULL THEN ? ELSE pid END
        WHERE id = ?
      `).run(now, cleanTool, cleanAction, cleanTarget, finalPid, finalPid, agentId);
    }

    this.eventBus.emit('agent:telemetry', {
      agent_id: agentId,
      project_id: finalProjectId,
      tool: cleanTool,
      action: cleanAction,
      target: cleanTarget,
      timestamp: now
    });

    // 方案二：活动心跳滑动续约 (Sliding Window Touch)
    // 只要该 Agent 还在发出工具调用，其名下活跃租约自动顺延滑动窗口，保证干活期间永不掉锁，
    // 而一旦停止活动，短约自然到期快速释放给后排。
    const touchResult = this.touchAgentLeases(agentId, finalProjectId || agent?.project_id || null, 60);

    return { success: true, touchedCount: touchResult.touchedCount };
  }

  getAgent(id, projectId = null) {
    const raw = projectId
      ? this.db.prepare('SELECT * FROM agents WHERE id = ? AND project_id = ?').get(id, projectId)
      : this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    if (!raw) return null;
    const { lifecycleState, isOnline } = computeAgentLifecycleState(raw, Date.now());
    return {
      ...raw,
      lifecycle_state: lifecycleState,
      is_online: isOnline
    };
  }

  listAgents(projectId = null) {
    if (projectId) {
      return this.db.prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY last_heartbeat DESC').all(projectId);
    }
    return this.db.prepare('SELECT * FROM agents ORDER BY last_heartbeat DESC').all();
  }

  updateAgentStatus(id, status) {
    this.db.prepare('UPDATE agents SET status = ?, last_heartbeat = ? WHERE id = ?').run(status, Date.now(), id);
    this.eventBus.emit('agent:status', { agent_id: id, status });
  }

  // 2. 意图声明与确定性冲突检查 (Core Algorithm)
  declareIntent({ agentId, intentSummary, claims = [], ttlSeconds = 300, projectId = 'default', projectRoot = null }) {
    requireAgentId(agentId);
    const rawSummary = requireString(intentSummary, 'summary');
    const summary = cleanUtf8String(rawSummary, 'Coordinated Task');
    const finalProjectId = projectId || 'default';

    if (!Array.isArray(claims)) {
      throw new ValidationError('"claims" must be an array', 'claims');
    }

    const agent = this.getAgent(agentId);
    const baseDir = agent?.workspace_dir || '';

    // 优先使用传入的 projectRoot，否则尝试从已登记的 projects 表查出项目根
    let effectiveProjectRoot = projectRoot;
    if (!effectiveProjectRoot && finalProjectId !== 'default') {
      try {
        const pRow = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(finalProjectId);
        if (pRow?.root_path) effectiveProjectRoot = pRow.root_path;
      } catch {}
    }

    const normalizedClaims = claims.map((c) => {
      if (!c || typeof c !== 'object') {
        throw new ValidationError('"claims" entries must be objects', 'claims');
      }
      return assertClaimTarget(c.target, c.type, baseDir, effectiveProjectRoot);
    });

    this.reapDeadAgentLeases();
    this.expireLeases();
    const now = Date.now();
    this.reapStaleIntentsAndAgents(now);
    const intentId = `intent_${randomUUID().slice(0, 8)}`;

    if (!agent) {
      const parts = agentId.split('-');
      const provider = parts[0] || 'agent';
      const sessionId = parts.slice(1).join('-') || `${now}`;
      const defaultName = formatAgentDefaultName(provider, sessionId, agentId);
      this.registerAgent({
        id: agentId,
        name: defaultName,
        provider,
        sessionId,
        workspaceDir: '',
        projectId: finalProjectId
      });
    }

    let conflict = this.findConflict(normalizedClaims, agentId, now, finalProjectId);

    if (!conflict) {
      this.db.prepare(`
        INSERT INTO intents (id, project_id, agent_id, summary, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'granted', ?, ?)
      `).run(intentId, finalProjectId, agentId, summary, now, now);

      const claimInsert = this.db.prepare(`
        INSERT INTO claims (project_id, intent_id, agent_id, claim_type, claim_target, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const c of normalizedClaims) {
        claimInsert.run(finalProjectId, intentId, agentId, c.type, c.target, now);
      }

      const leaseId = `lease_${randomUUID().slice(0, 8)}`;
      const expiresAt = now + (ttlSeconds * 1000);
      this.db.prepare(`
        INSERT INTO leases (id, project_id, intent_id, agent_id, ttl_seconds, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(leaseId, finalProjectId, intentId, agentId, ttlSeconds, expiresAt, now);

      this.updateAgentStatus(agentId, 'running');
      this.logActivity(agentId, 'intent:granted', claims.map(c => c.target).join(', '), `Granted lease for intent: "${summary}"`, finalProjectId);

      return {
        status: 'GRANTED',
        intentId,
        leaseId,
        expiresAt,
        claims: normalizedClaims
      };
    } else {
      const safeReason = cleanUtf8String(conflict.reason, 'Resource is locked by another agent');
      const safeBlockedByName = sanitizeAgentName(conflict.blockedByAgentName, conflict.blockedByAgentId);

      this.db.prepare(`
        INSERT INTO intents (id, project_id, agent_id, summary, status, blocked_by_agent_id, blocked_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?)
      `).run(intentId, finalProjectId, agentId, summary, conflict.blockedByAgentId, safeReason, now, now);

      const claimInsert = this.db.prepare(`
        INSERT INTO claims (project_id, intent_id, agent_id, claim_type, claim_target, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const c of normalizedClaims) {
        claimInsert.run(finalProjectId, intentId, agentId, c.type, c.target, now);
      }

      this.db.prepare(`
        INSERT INTO wait_queue (project_id, intent_id, agent_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(finalProjectId, intentId, agentId, now);

      this.updateAgentStatus(agentId, 'waiting');
      this.logActivity(agentId, 'intent:blocked', claims.map(c => c.target).join(', '), `Blocked by ${safeBlockedByName}: ${safeReason}`, finalProjectId);

      return {
        status: 'WAITING',
        intentId,
        blockedBy: conflict.blockedByAgentId,
        blockedByName: safeBlockedByName,
        holderWorkspace: conflict.holderWorkspace || '',
        expiresAt: conflict.expiresAt,
        remainingSec: conflict.remainingSec,
        reason: safeReason,
        claims: normalizedClaims
      };
    }
  }

  // 3. 租约释放与等待者主动唤醒
  releaseLease(leaseIdOrIntentId, agentId) {
    if (leaseIdOrIntentId == null || leaseIdOrIntentId === '') {
      return { success: false, message: 'Lease not found or not owned by agent' };
    }

    const now = Date.now();
    const lease = this.db.prepare(`
      SELECT * FROM leases WHERE (id = ? OR intent_id = ?) AND agent_id = ?
    `).get(leaseIdOrIntentId, leaseIdOrIntentId, agentId);

    if (!lease) {
      return { success: false, message: 'Lease not found or not owned by agent' };
    }

    const projectId = lease.project_id || 'default';

    // 查出被释放的 claims 便于发布 resource:freed 事件
    const releasedClaims = this.db.prepare(`
      SELECT claim_type, claim_target FROM claims WHERE intent_id = ?
    `).all(lease.intent_id).map(c => ({ type: c.claim_type, target: c.claim_target }));

    const intentRow = this.db.prepare('SELECT summary FROM intents WHERE id = ?').get(lease.intent_id);
    const agentRow = this.db.prepare('SELECT name, provider FROM agents WHERE id = ?').get(agentId);
    const releasedByName = sanitizeAgentName(agentRow?.name, agentId, agentRow?.provider);

    // 沉淀到演进拓扑服务
    if (this.topologyService && releasedClaims.length > 0) {
      try {
        this.topologyService.recordNode({
          projectId,
          agentId,
          agentName: releasedByName,
          provider: agentRow?.provider || 'agent',
          nodeType: 'completed',
          title: intentRow?.summary ? `完成: ${intentRow.summary}` : `释放意图 ${lease.intent_id}`,
          description: `任务闭环完成，释放了持有的 ${releasedClaims.length} 项资源锁`,
          intentId: lease.intent_id,
          claims: releasedClaims,
          causalityType: 'sequence'
        });
      } catch {}
    }

    this.db.prepare(`UPDATE intents SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, lease.intent_id);
    this.db.prepare(`DELETE FROM leases WHERE id = ?`).run(lease.id);
    this.db.prepare(`DELETE FROM claims WHERE intent_id = ?`).run(lease.intent_id);

    this._syncAgentRunningStatus(agentId, projectId, now);
    this.logActivity(agentId, 'lease:released', lease.id, `Agent released lease for intent ${lease.intent_id}`, projectId);

    this.eventBus.emit('resource:freed', {
      project_id: projectId,
      resources: releasedClaims,
      released_by: agentId,
      released_by_name: releasedByName
    });

    const { nextWaiter, skipped } = this._wakeNextEligibleWaiter(projectId, now, {
      resources: releasedClaims,
      releasedBy: agentId,
      releasedByName
    });

    return {
      success: true,
      releasedLeaseId: lease.id,
      notifiedWaiter: nextWaiter ? {
        agent_id: nextWaiter.agent_id,
        intent_id: nextWaiter.intent_id
      } : null,
      stillBlocked: skipped
    };
  }

  // 3.1 批量释放指定 Agent 的全部或指定范围租约 (用于 git commit / git push 后的零感自动释放)
  releaseAgentLeases({ agentId, projectId = 'default', reason = 'git_action', scope = 'all' }) {
    requireAgentId(agentId);
    const now = Date.now();
    const finalProjectId = projectId || 'default';

    const activeLeases = (projectId && projectId !== 'all')
      ? this.db.prepare(`
          SELECT l.id, l.intent_id, l.project_id
          FROM leases l
          WHERE l.agent_id = ? AND (l.project_id = ? OR l.project_id = 'default') AND l.expires_at > ?
        `).all(agentId, finalProjectId, now)
      : this.db.prepare(`
          SELECT l.id, l.intent_id, l.project_id
          FROM leases l
          WHERE l.agent_id = ? AND l.expires_at > ?
        `).all(agentId, now);

    if (activeLeases.length === 0) {
      return {
        success: true,
        releasedCount: 0,
        releasedLeases: [],
        notifiedWaiters: []
      };
    }

    const agentRow = this.db.prepare('SELECT name, provider FROM agents WHERE id = ?').get(agentId);
    const releasedByName = sanitizeAgentName(agentRow?.name, agentId, agentRow?.provider);

    const allReleasedClaims = [];
    const releasedLeaseIds = [];

    for (const lease of activeLeases) {
      const claims = this.db.prepare(`
        SELECT claim_type, claim_target FROM claims WHERE intent_id = ?
      `).all(lease.intent_id).map(c => ({ type: c.claim_type, target: c.claim_target }));

      const intentRow = this.db.prepare('SELECT summary FROM intents WHERE id = ?').get(lease.intent_id);

      allReleasedClaims.push(...claims);
      releasedLeaseIds.push(lease.id);

      const isProcessExit = reason === 'process_exit';
      const finalStatus = isProcessExit ? 'aborted' : 'completed';
      const nodeType = isProcessExit ? 'handoff' : 'completed';
      const nodeTitle = isProcessExit
        ? (intentRow?.summary ? `进程退出异常释放: ${intentRow.summary}` : `进程退出租约提前回收 (Intent ${lease.intent_id})`)
        : (intentRow?.summary ? `提交完成: ${intentRow.summary}` : `Git 提交完工 (Intent ${lease.intent_id})`);
      const nodeDesc = isProcessExit
        ? `监测到进程退出 (${reason})，提前安全回收了 ${claims.length} 项资源锁并唤醒等待者`
        : `生命周期自动感知完成 (${reason})，释放了 ${claims.length} 项资源锁`;

      if (this.topologyService && claims.length > 0) {
        try {
          this.topologyService.recordNode({
            projectId: finalProjectId,
            agentId,
            agentName: releasedByName,
            provider: agentRow?.provider || 'agent',
            nodeType,
            title: nodeTitle,
            description: nodeDesc,
            intentId: lease.intent_id,
            claims,
            causalityType: 'sequence'
          });
        } catch {}
      }

      this.db.prepare(`UPDATE intents SET status = ?, updated_at = ? WHERE id = ?`).run(finalStatus, now, lease.intent_id);
      this.db.prepare(`DELETE FROM leases WHERE id = ?`).run(lease.id);
      this.db.prepare(`DELETE FROM claims WHERE intent_id = ?`).run(lease.intent_id);

      this.logActivity(agentId, 'lease:released', lease.id, `Auto-released lease upon ${reason} for intent ${lease.intent_id}`, finalProjectId);
    }

    this._syncAgentRunningStatus(agentId, finalProjectId, now);

    this.eventBus.emit('resource:freed', {
      project_id: finalProjectId,
      resources: allReleasedClaims,
      released_by: agentId,
      released_by_name: releasedByName,
      reason
    });

    // 循环唤醒所有当前可能已经无冲突的等待者
    const notifiedWaiters = [];
    while (true) {
      const { nextWaiter } = this._wakeNextEligibleWaiter(finalProjectId, now, {
        resources: allReleasedClaims,
        releasedBy: agentId,
        releasedByName
      });
      if (!nextWaiter) break;
      notifiedWaiters.push({
        agent_id: nextWaiter.agent_id,
        intent_id: nextWaiter.intent_id
      });
    }

    return {
      success: true,
      releasedCount: releasedLeaseIds.length,
      releasedLeases: releasedLeaseIds,
      releasedClaims: allReleasedClaims,
      notifiedWaiters
    };
  }

  // 3.2 活跃会话租约滑动顺延 (Sliding Window Touch)
  // 每次 Agent 发出工具调用 (遥测) 时自动顺延名下活跃租约，干活期间绝不掉锁，停工后短约快速过期
  touchAgentLeases(agentId, projectId = null, extendSeconds = 60, maxTotalTtlSeconds = 600) {
    if (!agentId) return { touchedCount: 0 };
    const now = Date.now();

    const query = projectId && projectId !== 'all'
      ? `SELECT id, ttl_seconds, expires_at, created_at FROM leases WHERE agent_id = ? AND (project_id = ? OR project_id = 'default') AND expires_at > ?`
      : `SELECT id, ttl_seconds, expires_at, created_at FROM leases WHERE agent_id = ? AND expires_at > ?`;

    const activeLeases = (projectId && projectId !== 'all')
      ? this.db.prepare(query).all(agentId, projectId, now)
      : this.db.prepare(query).all(agentId, now);

    if (activeLeases.length === 0) return { touchedCount: 0 };

    let touchedCount = 0;
    const updateStmt = this.db.prepare(`
      UPDATE leases
      SET expires_at = ?
      WHERE id = ?
    `);

    for (const lease of activeLeases) {
      const maxExpiry = lease.created_at + (maxTotalTtlSeconds * 1000);
      const proposedExpiry = now + (extendSeconds * 1000);
      const newExpiry = Math.min(proposedExpiry, maxExpiry);
      // 只有在新延期时间晚于现有到期时间时才顺延，不缩短显式指定的大 TTL 租约
      if (newExpiry > lease.expires_at) {
        updateStmt.run(newExpiry, lease.id);
        touchedCount++;
      }
    }

    return { touchedCount };
  }

  // 内部辅助方法：依据剩余活跃租约准确同步 Agent 运行状态
  _syncAgentRunningStatus(agentId, projectId, now) {
    const active = this.db.prepare(`
      SELECT count(*) as count FROM leases WHERE agent_id = ? AND project_id = ? AND expires_at > ?
    `).get(agentId, projectId, now);
    if ((active?.count || 0) === 0) {
      this.updateAgentStatus(agentId, 'idle');
    } else {
      this.updateAgentStatus(agentId, 'running');
    }
  }

  // 内部辅助方法：复核并唤醒等待队列中首个满足条件的 Agent
  _wakeNextEligibleWaiter(projectId, now, freedInfo = null) {
    const breadthOf = (intentId) => this.db.prepare(`
      SELECT COALESCE(SUM(
        CASE WHEN claim_type = 'file' THEN 1
             ELSE LENGTH(claim_target) - LENGTH(REPLACE(claim_target, '/', '')) + 1
        END
      ), 0) AS segments, COUNT(*) AS n
      FROM claims WHERE intent_id = ?
    `).get(intentId);

    const candidates = this.db.prepare(`
      SELECT w.intent_id, w.agent_id, i.summary, a.name as agent_name
      FROM wait_queue w
      JOIN intents i ON w.intent_id = i.id
      JOIN agents a ON w.agent_id = a.id
      WHERE w.project_id = ?
      ORDER BY w.id ASC
    `).all(projectId).map((c) => ({ ...c, breadth: breadthOf(c.intent_id) }))
      .sort((a, b) => (b.breadth.segments - a.breadth.segments) || (b.breadth.n - a.breadth.n));

    let nextWaiter = null;
    let waiterClaims = [];
    let skipped = 0;
    for (const cand of candidates) {
      const claims = this.db.prepare(`
        SELECT claim_type, claim_target FROM claims WHERE intent_id = ?
      `).all(cand.intent_id).map((c) => ({ type: c.claim_type, target: c.claim_target }));

      if (claims.length === 0 || this.findConflict(claims, cand.agent_id, now, projectId)) {
        skipped++;
        continue;
      }
      nextWaiter = cand;
      waiterClaims = claims;
      break;
    }

    if (nextWaiter) {
      this.db.prepare(`DELETE FROM wait_queue WHERE intent_id = ?`).run(nextWaiter.intent_id);

      this.db.prepare(`
        UPDATE intents
        SET status = 'released', blocked_by_agent_id = NULL, blocked_reason = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, nextWaiter.intent_id);

      this.logActivity(nextWaiter.agent_id, 'agent:woken', nextWaiter.intent_id, `Notified waiter ${nextWaiter.agent_name} to recheck`, projectId);

      const targetDesc = freedInfo?.resources?.map(r => r.target).join(', ') || 'locked resource';
      const freedByName = freedInfo?.releasedByName || freedInfo?.releasedBy || 'previous holder';
      const resumeHint = `Resource '${targetDesc}' held by [${freedByName}] has been released. Your claimed targets (${waiterClaims.map(c => c.target).join(', ')}) are now conflict-free. Refresh workspace and proceed.`;

      const wokenPayload = {
        project_id: projectId,
        agent_id: nextWaiter.agent_id,
        agent_name: nextWaiter.agent_name,
        intent_id: nextWaiter.intent_id,
        summary: nextWaiter.summary,
        verified: true,
        freed_resources: freedInfo?.resources || [],
        freed_by: freedInfo?.releasedBy || null,
        freed_by_name: freedByName,
        claims: waiterClaims,
        resume_hint: resumeHint,
        message: resumeHint
      };

      this.eventBus.emit('agent:woken', wokenPayload);

      // 持久化通知到 messages 表中，确保通过 nexus_dialogue_read 轮询的会话可检索到
      try {
        if (this.messageService) {
          const senderId = freedInfo?.releasedBy || 'nexus';
          if (!this.getAgent(senderId)) {
            this.registerAgent({
              id: senderId,
              name: freedByName || 'Nexus Coordinator',
              provider: 'system',
              sessionId: 'coordinator',
              projectId
            });
          }
          this.messageService.send({
            from: senderId,
            to: nextWaiter.agent_id,
            intentId: nextWaiter.intent_id,
            content: `[Resource Woken] ${resumeHint}`,
            importance: 'urgent',
            projectId,
            dialogueType: 'handoff',
            status: 'unread'
          });
        }
      } catch (err) {
        // 消息持久化作为辅助增强，不阻断主唤醒链路
      }
    }

    return { nextWaiter, skipped };
  }

  // 4. 过期租约定时清理（联动释放事件与排队唤醒）
  expireLeases() {
    const now = Date.now();
    const expired = this.db.prepare('SELECT * FROM leases WHERE expires_at <= ?').all(now);
    if (expired.length === 0) return;

    const affectedProjects = new Set();
    const affectedAgents = new Set();

    for (const l of expired) {
      const pid = l.project_id || 'default';
      affectedProjects.add(pid);
      affectedAgents.add({ agentId: l.agent_id, projectId: pid });

      // 提取释放的 claims
      const releasedClaims = this.db.prepare(`
        SELECT claim_type, claim_target FROM claims WHERE intent_id = ?
      `).all(l.intent_id).map(c => ({ type: c.claim_type, target: c.claim_target }));

      this.db.prepare(`UPDATE intents SET status = 'aborted', updated_at = ? WHERE id = ?`).run(now, l.intent_id);
      this.db.prepare(`DELETE FROM leases WHERE id = ?`).run(l.id);
      this.db.prepare(`DELETE FROM claims WHERE intent_id = ?`).run(l.intent_id);
      this.logActivity(l.agent_id, 'lease:expired', l.id, `Lease ${l.id} expired due to TTL timeout`, pid);

      if (releasedClaims.length > 0) {
        this.eventBus.emit('resource:freed', {
          project_id: pid,
          resources: releasedClaims,
          released_by: l.agent_id
        });
      }
    }

    // 同步涉及到的 Agent 状态
    for (const { agentId, projectId } of affectedAgents) {
      this._syncAgentRunningStatus(agentId, projectId, now);
    }

    // 释放资源后，复核并唤醒等待者
    for (const pid of affectedProjects) {
      this._wakeNextEligibleWaiter(pid, now);
    }
  }

  // 4.1 进程存活监测与死亡 Agent 租约提前回收 (Early Lease Reclamation)
  reapDeadAgentLeases() {
    const now = Date.now();
    // 查找所有持有活跃未过期租约且登记了 pid 的 Agent
    const activeHolders = this.db.prepare(`
      SELECT DISTINCT a.id, a.name, a.pid, l.project_id
      FROM agents a
      JOIN leases l ON a.id = l.agent_id
      WHERE a.pid IS NOT NULL AND a.pid > 0 AND l.expires_at > ?
    `).all(now);

    if (activeHolders.length === 0) return { reapedCount: 0, deadAgents: [] };

    let totalReaped = 0;
    const deadAgents = [];

    for (const holder of activeHolders) {
      let isAlive = true;
      try {
        // 在 POSIX 与 Windows 上，process.kill(pid, 0) 不发送终止信号，
        // 仅检测进程是否存在。如果进程已死，抛出 ESRCH。
        process.kill(holder.pid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') {
          isAlive = false;
        } else if (err.code === 'EPERM') {
          // 进程存在但无权限探测，表明进程依然活跃存活
          isAlive = true;
        }
      }

      if (!isAlive) {
        // 立即提前回收该死亡 Agent 在对应项目下的所有租约，并唤醒所有等待会话
        const releaseRes = this.releaseAgentLeases({
          agentId: holder.id,
          projectId: holder.project_id,
          reason: 'process_exit',
          scope: 'all'
        });

        // 标记 agent 状态为 departed（必须在 releaseAgentLeases 之后，避免被 _syncAgentRunningStatus 覆盖为 idle）
        this.updateAgentStatus(holder.id, 'departed');

        this.logActivity(
          holder.id,
          'process:dead',
          String(holder.pid),
          `Detected agent process exit (PID ${holder.pid}). Reclaimed ${releaseRes.releasedCount} lease(s) early.`,
          holder.project_id
        );

        if (releaseRes.releasedCount > 0) {
          totalReaped += releaseRes.releasedCount;
          deadAgents.push({
            agentId: holder.id,
            pid: holder.pid,
            releasedCount: releaseRes.releasedCount
          });
        }
      }
    }

    return { reapedCount: totalReaped, deadAgents };
  }

  // 4.2 僵尸等待者与超时会话收割器 (Stale Waiter & Agent Reaper)
  reapStaleIntentsAndAgents(now = Date.now()) {
    try {
      // 1. 清理超过 5 分钟的陈旧等待队列记录
      this.db.prepare('DELETE FROM wait_queue WHERE (? - created_at) > 300000').run(now);

      // 2. 将超过 10 分钟无心跳且依然处于 waiting/running 的意图标记为 aborted
      this.db.prepare(`
        UPDATE intents
        SET status = 'aborted', updated_at = ?
        WHERE status IN ('waiting', 'running') AND (? - updated_at) > 600000
      `).run(now, now);

      // 3. 检查所有处于 waiting 的意图，若其等待的 agent 已经超时或者 blocker 已经不再持有任何租约，解除阻塞
      const waitingIntents = this.db.prepare(`
        SELECT i.id, i.agent_id, i.project_id, i.blocked_by_agent_id
        FROM intents i
        WHERE i.status = 'waiting'
      `).all();

      for (const wi of waitingIntents) {
        const waiterAgent = this.db.prepare('SELECT last_heartbeat, pid FROM agents WHERE id = ?').get(wi.agent_id);
        const isWaiterAlive = waiterAgent && (((now - waiterAgent.last_heartbeat) <= 120000) || (waiterAgent.pid && isPidAlive(waiterAgent.pid)));
        if (!isWaiterAlive) {
          this.db.prepare(`UPDATE intents SET status = 'aborted', updated_at = ? WHERE id = ?`).run(now, wi.id);
          this.db.prepare('DELETE FROM wait_queue WHERE intent_id = ?').run(wi.id);
          continue;
        }

        if (wi.blocked_by_agent_id) {
          const blockerLease = this.db.prepare(`
            SELECT count(*) as count FROM leases WHERE agent_id = ? AND expires_at > ?
          `).get(wi.blocked_by_agent_id, now);
          if (!blockerLease || blockerLease.count === 0) {
            this._wakeNextEligibleWaiter(wi.project_id, now);
          }
        }
      }

      // 4. 将超过 2 分钟无心跳且无存活 PID 的会话同步为 departed
      const unconfirmedAgents = this.db.prepare(`
        SELECT id, pid, last_heartbeat FROM agents
        WHERE status IN ('running', 'waiting') AND (? - last_heartbeat) > 120000
      `).all(now);

      for (const ag of unconfirmedAgents) {
        const alive = ag.pid && isPidAlive(ag.pid);
        if (!alive) {
          this.db.prepare(`UPDATE agents SET status = 'departed' WHERE id = ?`).run(ag.id);
        } else {
          this.db.prepare(`UPDATE agents SET last_heartbeat = ? WHERE id = ?`).run(now, ag.id);
        }
      }
    } catch {
      // 容错处理
    }
  }

  // 5. 极速权限检查与自动补报 (针对通用 Hook 与资源锁)
  fastCheckAndAutoClaim({ agentId, provider, sessionId, filePath, resourceName, promptHint, projectId = 'default', workspaceDir = '', projectRoot = null, pid = null }) {
    requireAgentId(agentId);
    const finalProjectId = projectId || 'default';
    const now = Date.now();

    // 尝试解析项目根目录
    let finalProjectRoot = projectRoot;
    if (!finalProjectRoot && finalProjectId !== 'default') {
      try {
        const pRow = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(finalProjectId);
        if (pRow?.root_path) finalProjectRoot = pRow.root_path;
      } catch {}
    }

    this.registerAgent({
      id: agentId,
      name: (promptHint && !isMechanicalAgentName(promptHint)) ? promptHint.slice(0, 40) : sanitizeAgentName(null, agentId, provider, sessionId, promptHint),
      provider,
      sessionId,
      workspaceDir: workspaceDir || '',
      projectId: finalProjectId,
      pid
    });

    this.reapDeadAgentLeases();
    this.expireLeases();

    // 5.1 命名资源锁快速检查 (例如命令推导出的 tests, dev-server, build 等)
    if (resourceName) {
      const cleanResource = resourceName.trim().toLowerCase();
      assertClaimTarget(cleanResource, 'resource', workspaceDir, finalProjectRoot);

      const existingResourceLock = this.db.prepare(`
        SELECT c.agent_id, a.name as agent_name, a.workspace_dir, i.summary, l.id as lease_id, l.expires_at
        FROM claims c
        JOIN leases l ON c.intent_id = l.intent_id
        JOIN agents a ON c.agent_id = a.id
        JOIN intents i ON c.intent_id = i.id
        WHERE (c.project_id = ? OR c.project_id = 'default' OR ? = 'default') AND c.claim_type = 'resource' AND c.claim_target = ? AND l.expires_at > ?
      `).get(finalProjectId, finalProjectId, cleanResource, now);

      if (existingResourceLock) {
        if (existingResourceLock.agent_id === agentId) {
          return { allow: true, reason: 'self-held-resource-lease' };
        } else {
          this.logActivity(agentId, 'hook:blocked', cleanResource, `Blocked access to resource '${cleanResource}' (held by ${existingResourceLock.agent_name})`, finalProjectId);
          const remainingSec = Math.max(0, Math.ceil((existingResourceLock.expires_at - now) / 1000));
          return {
            allow: false,
            holder: existingResourceLock.agent_name,
            holderWorkspace: '',
            expiresAt: existingResourceLock.expires_at,
            remainingSec,
            advice: `Resource '${cleanResource}' is busy. You can work on independent code or wait for the process to finish (ETA ~${remainingSec}s).`,
            reason: `BLOCKED: Resource '${cleanResource}' is currently locked by [${existingResourceLock.agent_name}] for "${existingResourceLock.summary}". Please wait for the current run to finish.`
          };
        }
      }

      const intentRes = this.declareIntent({
        agentId,
        intentSummary: promptHint ? `Running ${cleanResource}: ${promptHint.slice(0, 40)}` : `Auto-claimed resource lock on '${cleanResource}'`,
        claims: [{ type: 'resource', target: cleanResource }],
        ttlSeconds: 60, // 瞬态命令锁由 PostToolUse 毫秒级释放，安全兜底 TTL 降至 60 秒
        projectId: finalProjectId,
        projectRoot: finalProjectRoot
      });

      if (intentRes.status === 'WAITING') {
        this.logActivity(agentId, 'hook:blocked', cleanResource, `Blocked access to resource '${cleanResource}' (${intentRes.reason})`, finalProjectId);
        const remainingSec = intentRes.remainingSec || 0;
        return {
          allow: false,
          holder: intentRes.blockedByName,
          holderWorkspace: intentRes.holderWorkspace || '',
          expiresAt: intentRes.expiresAt || null,
          remainingSec,
          advice: `Resource '${cleanResource}' is blocked. Please wait for previous job to finish (ETA ~${remainingSec}s).`,
          reason: `BLOCKED: Resource '${cleanResource}' is blocked by [${intentRes.blockedByName}] (${intentRes.reason}). Please wait.`
        };
      }

      return {
        allow: true,
        autoClaimed: true,
        leaseId: intentRes.leaseId
      };
    }

    // 5.2 文件与模块路径冲突拦截 (支持跨工作树相对化对齐与 #anchor 细粒度锁)
    assertClaimTarget(filePath, 'file', workspaceDir, finalProjectRoot);
    const normalizedFile = this.normalizePath(filePath, workspaceDir, finalProjectRoot);
    const { baseTarget: baseFile, anchor: fileAnchor } = splitTargetAnchor(normalizedFile);

    const existingLock = this.db.prepare(`
      SELECT c.agent_id, c.claim_target, a.name as agent_name, a.workspace_dir as holder_workspace, i.summary, l.id as lease_id, l.expires_at
      FROM claims c
      JOIN leases l ON c.intent_id = l.intent_id
      JOIN agents a ON c.agent_id = a.id
      JOIN intents i ON c.intent_id = i.id
      WHERE (c.project_id = ? OR c.project_id = 'default' OR ? = 'default') AND c.claim_type = 'file' AND (c.claim_target = ? OR c.claim_target LIKE ? || '#%') AND l.expires_at > ?
    `).all(finalProjectId, finalProjectId, baseFile, baseFile, now);

    // 检查是否存在冲突锁
    let conflictingLock = null;
    let selfHeld = false;
    for (const lock of existingLock) {
      if (lock.agent_id === agentId) {
        selfHeld = true;
        continue;
      }
      const { anchor: lockAnchor } = splitTargetAnchor(lock.claim_target);
      // 如果双方都有不同 anchor，允许并发
      if (fileAnchor && lockAnchor && fileAnchor !== lockAnchor) {
        continue;
      }
      conflictingLock = lock;
      break;
    }

    if (conflictingLock) {
      const isCrossWorktree = workspaceDir && conflictingLock.holder_workspace &&
        toComparablePath(workspaceDir, '') !== toComparablePath(conflictingLock.holder_workspace, '');
      const conflictPrefix = isCrossWorktree ? 'CROSS-WORKTREE CONFLICT' : 'BLOCKED';
      const worktreeNote = isCrossWorktree ? ' in another worktree (concurrent edits will cause git merge conflicts)' : '';
      const remainingSec = Math.max(0, Math.ceil((conflictingLock.expires_at - now) / 1000));

      this.logActivity(agentId, 'hook:blocked', normalizedFile, `Blocked write to ${normalizedFile} (held by ${conflictingLock.agent_name}${worktreeNote})`, finalProjectId);
      return {
        allow: false,
        holder: conflictingLock.agent_name,
        holderWorkspace: conflictingLock.holder_workspace || '',
        expiresAt: conflictingLock.expires_at,
        remainingSec,
        advice: `File '${filePath}' is locked by [${conflictingLock.agent_name}]. You can: 1) Read and analyze code, 2) Work on other independent modules/anchors, 3) Wait for holder to git commit/push (ETA ~${remainingSec}s).`,
        reason: `${conflictPrefix}: File '${filePath}' is locked by [${conflictingLock.agent_name}]${worktreeNote} for "${conflictingLock.summary}". Please wait or choose another task.`
      };
    }

    if (selfHeld) {
      return { allow: true, reason: 'self-held-lease' };
    }

    const intentRes = this.declareIntent({
      agentId,
      intentSummary: promptHint ? `Editing ${filePath}: ${promptHint.slice(0, 40)}` : `Auto-claimed edit on ${filePath}`,
      claims: [{ type: 'file', target: filePath }],
      ttlSeconds: 60, // 施工走廊短约 + 遥测滑动续期 (Sliding Window)，停工后快速释放
      projectId: finalProjectId,
      projectRoot: finalProjectRoot
    });

    // 关键防御：如果意图被判定为冲突等待（例如命中模块锁或符号锁），坚决实施拦截
    if (intentRes.status === 'WAITING') {
      this.logActivity(agentId, 'hook:blocked', normalizedFile, `Blocked write to ${normalizedFile} (${intentRes.reason})`, finalProjectId);
      const remainingSec = intentRes.remainingSec || 0;
      return {
        allow: false,
        holder: intentRes.blockedByName,
        holderWorkspace: intentRes.holderWorkspace || '',
        expiresAt: intentRes.expiresAt || null,
        remainingSec,
        advice: `Target '${filePath}' is blocked (${intentRes.reason}). Switch to an independent file or wait for holder to git commit/push (ETA ~${remainingSec}s).`,
        reason: `BLOCKED: File '${filePath}' is blocked by [${intentRes.blockedByName}] (${intentRes.reason}). Please wait or choose another task.`
      };
    }

    return {
      allow: true,
      autoClaimed: true,
      leaseId: intentRes.leaseId
    };
  }

  // 6. 显式命名资源锁（Resource Locks）支持：测试、开发服务器、构建等
  acquireResourceLock({ agentId, resourceName, ttlSeconds = 300, reason = 'Resource held', projectId = 'default', projectRoot = null }) {
    requireAgentId(agentId);
    const target = requireString(resourceName, 'resourceName').trim().toLowerCase();
    const res = this.declareIntent({
      agentId,
      intentSummary: reason,
      claims: [{ type: 'resource', target }],
      ttlSeconds,
      projectId,
      projectRoot
    });

    return {
      success: res.status === 'GRANTED',
      resource_name: target,
      ...res
    };
  }

  releaseResourceLock({ agentId, resourceName, projectId = 'default' }) {
    requireAgentId(agentId);
    const target = requireString(resourceName, 'resourceName').trim().toLowerCase();
    const activeClaim = this.db.prepare(`
      SELECT c.intent_id
      FROM claims c
      JOIN leases l ON c.intent_id = l.intent_id
      WHERE (c.project_id = ? OR ? = 'all' OR c.project_id = 'default') AND c.agent_id = ? AND c.claim_type = 'resource' AND c.claim_target = ?
    `).get(projectId, projectId, agentId, target);

    if (activeClaim) {
      const releaseRes = this.releaseLease(activeClaim.intent_id, agentId);
      return {
        ...releaseRes,
        resource_name: target
      };
    }
    return { success: false, reason: 'No active resource lock found' };
  }

  listResourceLocks(projectId = 'default') {
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT c.claim_target as resource_name, c.agent_id, a.name as agent_name, i.summary, l.expires_at, l.created_at
      FROM claims c
      JOIN leases l ON c.intent_id = l.intent_id
      JOIN agents a ON c.agent_id = a.id
      JOIN intents i ON c.intent_id = i.id
      WHERE c.project_id = ? AND c.claim_type = 'resource' AND l.expires_at > ?
      ORDER BY l.created_at ASC
    `).all(projectId, now);

    return rows.map(r => ({
      resourceName: r.resource_name,
      resource_name: r.resource_name,
      agentId: r.agent_id,
      agent_id: r.agent_id,
      agentName: r.agent_name,
      agent_name: r.agent_name,
      summary: r.summary,
      expiresAt: r.expires_at,
      createdAt: r.created_at
    }));
  }

  logActivity(agentId, eventType, target, description, projectId = 'default') {
    const now = Date.now();
    const finalProjectId = projectId || 'default';
    this.db.prepare(`
      INSERT INTO activity_log (project_id, agent_id, event_type, target, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(finalProjectId, agentId, eventType, target, description, now);

    this.eventBus.emit('timeline:event', {
      project_id: finalProjectId,
      agent_id: agentId,
      event_type: eventType,
      target,
      description,
      created_at: now
    });
  }

  getWaitQueue(projectId = 'default') {
    return this.db.prepare(`
      SELECT w.intent_id, w.agent_id, i.summary, a.name as agent_name
      FROM wait_queue w
      JOIN intents i ON w.intent_id = i.id
      JOIN agents a ON w.agent_id = a.id
      WHERE w.project_id = ?
      ORDER BY w.id ASC
    `).all(projectId);
  }

  getDashboardSnapshot(projectId = null) {
    const now = Date.now();
    this.syncClaudeSessions(now);
    this.reapStaleIntentsAndAgents(now);
    this.reapDeadAgentLeases();
    this.expireLeases();

    const finalProjectId = projectId && projectId !== 'all' ? projectId : null;

    let rawAgents;
    let rawActiveClaims;
    let rawTimeline;

    if (finalProjectId) {
      rawAgents = this.db.prepare(`
        SELECT a.*,
          (SELECT count(*) FROM leases l WHERE l.agent_id = a.id AND l.expires_at > ?) as active_leases_count,
          (SELECT i.summary FROM intents i WHERE i.agent_id = a.id AND i.status IN ('granted', 'running', 'waiting') ORDER BY i.created_at DESC LIMIT 1) as current_intent,
          (SELECT i.status FROM intents i WHERE i.agent_id = a.id AND i.status IN ('granted', 'running', 'waiting') ORDER BY i.created_at DESC LIMIT 1) as current_intent_status,
          (SELECT i.blocked_reason FROM intents i WHERE i.agent_id = a.id AND i.status = 'waiting' ORDER BY i.created_at DESC LIMIT 1) as blocked_reason,
          (SELECT i.blocked_by_agent_id FROM intents i WHERE i.agent_id = a.id AND i.status = 'waiting' ORDER BY i.created_at DESC LIMIT 1) as blocked_by_agent_id
        FROM agents a
        WHERE a.project_id = ?
      `).all(now, finalProjectId);

      rawActiveClaims = this.db.prepare(`
        SELECT c.*, a.name as agent_name, l.expires_at
        FROM claims c
        JOIN leases l ON c.intent_id = l.intent_id
        JOIN agents a ON c.agent_id = a.id
        WHERE l.expires_at > ? AND c.project_id = ?
      `).all(now, finalProjectId);

      rawTimeline = this.db.prepare(`
        SELECT al.*, a.name as agent_name, a.provider
        FROM activity_log al
        LEFT JOIN agents a ON al.agent_id = a.id
        WHERE al.project_id = ?
        ORDER BY al.id DESC LIMIT 50
      `).all(finalProjectId);
    } else {
      rawAgents = this.db.prepare(`
        SELECT a.*,
          (SELECT count(*) FROM leases l WHERE l.agent_id = a.id AND l.expires_at > ?) as active_leases_count,
          (SELECT i.summary FROM intents i WHERE i.agent_id = a.id AND i.status IN ('granted', 'running', 'waiting') ORDER BY i.created_at DESC LIMIT 1) as current_intent,
          (SELECT i.status FROM intents i WHERE i.agent_id = a.id AND i.status IN ('granted', 'running', 'waiting') ORDER BY i.created_at DESC LIMIT 1) as current_intent_status,
          (SELECT i.blocked_reason FROM intents i WHERE i.agent_id = a.id AND i.status = 'waiting' ORDER BY i.created_at DESC LIMIT 1) as blocked_reason,
          (SELECT i.blocked_by_agent_id FROM intents i WHERE i.agent_id = a.id AND i.status = 'waiting' ORDER BY i.created_at DESC LIMIT 1) as blocked_by_agent_id
        FROM agents a
      `).all(now);

      rawActiveClaims = this.db.prepare(`
        SELECT c.*, a.name as agent_name, l.expires_at
        FROM claims c
        JOIN leases l ON c.intent_id = l.intent_id
        JOIN agents a ON c.agent_id = a.id
        WHERE l.expires_at > ?
      `).all(now);

      rawTimeline = this.db.prepare(`
        SELECT al.*, a.name as agent_name, a.provider
        FROM activity_log al
        LEFT JOIN agents a ON al.agent_id = a.id
        ORDER BY al.id DESC LIMIT 50
      `).all();
    }

    const agents = rawAgents.map((a) => {
      const { lifecycleState, isOnline } = computeAgentLifecycleState(a, now);

      return {
        ...a,
        name: sanitizeAgentName(a.name, a.id, a.provider, a.session_id, a.current_intent),
        current_intent: cleanUtf8String(a.current_intent, ''),
        blocked_reason: cleanUtf8String(a.blocked_reason, null),
        last_tool: cleanUtf8String(a.last_tool, null),
        last_action: cleanUtf8String(a.last_action, a.last_tool || null),
        last_target: cleanUtf8String(a.last_target, null),
        lifecycle_state: lifecycleState,
        is_online: isOnline
      };
    });

    const activeClaims = rawActiveClaims.map((c) => ({
      ...c,
      agent_name: sanitizeAgentName(c.agent_name, c.agent_id),
      claim_target: cleanUtf8String(c.claim_target, c.claim_target)
    }));

    const timeline = rawTimeline.map((t) => ({
      ...t,
      agent_name: sanitizeAgentName(t.agent_name, t.agent_id, t.provider),
      description: cleanUtf8String(t.description, ''),
      target: cleanUtf8String(t.target, '')
    }));

    return {
      agents,
      activeClaims,
      timeline
    };
  }

  // 7. 实时多 Session 协同图谱 (Live Collaboration Graph)
  getCollaborationGraph(projectId = null) {
    const now = Date.now();
    this.syncClaudeSessions(now);
    this.reapStaleIntentsAndAgents(now);
    this.reapDeadAgentLeases();
    this.expireLeases();

    const finalProjectId = projectId && projectId !== 'all' ? projectId : null;

    let agentsQuery = `
      SELECT a.*,
        (SELECT count(*) FROM leases l WHERE l.agent_id = a.id AND l.expires_at > ?) as active_leases_count,
        (SELECT i.summary FROM intents i WHERE i.agent_id = a.id AND i.status IN ('granted', 'running', 'waiting') ORDER BY i.created_at DESC LIMIT 1) as current_intent_summary,
        (SELECT i.status FROM intents i WHERE i.agent_id = a.id AND i.status IN ('granted', 'running', 'waiting') ORDER BY i.created_at DESC LIMIT 1) as current_intent_status,
        (SELECT i.blocked_reason FROM intents i WHERE i.agent_id = a.id AND i.status = 'waiting' ORDER BY i.created_at DESC LIMIT 1) as blocked_reason,
        (SELECT i.blocked_by_agent_id FROM intents i WHERE i.agent_id = a.id AND i.status = 'waiting' ORDER BY i.created_at DESC LIMIT 1) as blocked_by_agent_id
      FROM agents a
    `;
    const params = [now];
    if (finalProjectId) {
      agentsQuery += ' WHERE a.project_id = ?';
      params.push(finalProjectId);
    }
    const rawAgents = this.db.prepare(agentsQuery).all(...params);

    let claimsQuery = `
      SELECT c.*, l.expires_at, l.id as lease_id, i.status as intent_status, i.summary as intent_summary, a.name as agent_name
      FROM claims c
      JOIN intents i ON c.intent_id = i.id
      JOIN agents a ON c.agent_id = a.id
      LEFT JOIN leases l ON c.intent_id = l.intent_id
      WHERE (l.expires_at > ? OR i.status = 'waiting')
    `;
    const claimParams = [now];
    if (finalProjectId) {
      claimsQuery += ' AND c.project_id = ?';
      claimParams.push(finalProjectId);
    }
    const rawClaims = this.db.prepare(claimsQuery).all(...claimParams);

    const nodes = [];
    const edges = [];
    const resourceNodeMap = new Map();

    let workingCount = 0;
    let waitingCount = 0;
    let idleCount = 0;
    let departedCount = 0;

    for (const a of rawAgents) {
      const { lifecycleState, isOnline } = computeAgentLifecycleState(a, now);

      if (lifecycleState === 'working') {
        workingCount++;
      } else if (lifecycleState === 'waiting') {
        waitingCount++;
      } else if (lifecycleState === 'idle') {
        idleCount++;
      } else {
        departedCount++;
      }

      // 彻底排除已离线的 session，只保留在线会话（避免历史离线僵尸节点污染拓扑）
      if (lifecycleState === 'departed') {
        continue;
      }

      const safeName = sanitizeAgentName(a.name, a.id, a.provider, a.session_id, a.current_intent_summary);
      const safeIntent = cleanUtf8String(a.current_intent_summary, a.current_intent || (lifecycleState === 'idle' ? '待命中' : ''));
      const safeTool = cleanUtf8String(a.last_tool, null);
      const safeAction = cleanUtf8String(a.last_action, safeTool);
      const safeTarget = cleanUtf8String(a.last_target, null);

      const activeTool = lifecycleState === 'working' ? safeTool : null;
      const activeAction = lifecycleState === 'working' ? safeAction : null;
      const activeTarget = lifecycleState === 'working' ? safeTarget : null;

      nodes.push({
        id: a.id,
        node_type: 'session',
        name: safeName,
        provider: a.provider || 'agent',
        session_id: a.session_id,
        project_id: a.project_id,
        lifecycle_state: lifecycleState,
        is_online: isOnline,
        pid: a.pid,
        current_intent: safeIntent,
        current_intent_status: a.current_intent_status,
        last_tool: safeTool,
        last_action: safeAction,
        last_target: safeTarget,
        current_tool: activeTool,
        current_action: activeAction,
        current_target: activeTarget,
        last_heartbeat: a.last_heartbeat,
        active_leases_count: a.active_leases_count || 0
      });

      if (lifecycleState === 'waiting' && a.blocked_by_agent_id) {
        edges.push({
          source: a.id,
          target: a.blocked_by_agent_id,
          type: 'conflict',
          label: cleanUtf8String(a.blocked_reason, '等待锁释放')
        });
      }
    }

    for (const c of rawClaims) {
      const cleanTarget = cleanUtf8String(c.claim_target, c.claim_target);
      const resKey = `res:${c.claim_type}:${cleanTarget}`;
      if (!resourceNodeMap.has(resKey)) {
        const resNode = {
          id: resKey,
          node_type: 'resource',
          claim_type: c.claim_type,
          target: cleanTarget,
          project_id: c.project_id,
          status: c.expires_at && c.expires_at > now ? 'locked' : 'contended',
          expires_at: c.expires_at || null,
          remaining_sec: c.expires_at ? Math.max(0, Math.ceil((c.expires_at - now) / 1000)) : 0
        };
        resourceNodeMap.set(resKey, resNode);
        nodes.push(resNode);
      }

      if (c.expires_at && c.expires_at > now) {
        edges.push({
          source: c.agent_id,
          target: resKey,
          type: 'holds_lease',
          label: `持有租约 (~${Math.max(0, Math.ceil((c.expires_at - now) / 1000))}s)`
        });
      } else if (c.intent_status === 'waiting') {
        edges.push({
          source: c.agent_id,
          target: resKey,
          type: 'waiting_for',
          label: '排队请求'
        });
      }
    }

    const validNodeIds = new Set(nodes.map(n => n.id));
    const cleanEdges = edges.filter(e => validNodeIds.has(e.source) && validNodeIds.has(e.target));

    return {
      project_id: finalProjectId || 'all',
      timestamp: now,
      stats: {
        total_sessions: rawAgents.length,
        working_sessions: workingCount,
        waiting_sessions: waitingCount,
        idle_sessions: idleCount,
        departed_sessions: departedCount,
        locked_resources: resourceNodeMap.size,
        active_edges: cleanEdges.length
      },
      nodes,
      edges: cleanEdges
    };
  }

  // 8. 综合全览驾驶舱聚合快照 (Unified Cockpit Aggregate)
  getUnifiedCockpit(projectId = null) {
    const finalProjectId = projectId && projectId !== 'all' ? projectId : null;
    const dashboard = this.getDashboardSnapshot(finalProjectId);
    const collab = this.getCollaborationGraph(finalProjectId);
    const topology = this.topologyService
      ? this.topologyService.getTopologyGraph(finalProjectId || 'default', { limit: 30 })
      : { nodes: [], edges: [], totalNodes: 0, modules: [] };

    const onlineAgents = (dashboard.agents || []).filter(a => a.is_online);
    const workingSessions = onlineAgents.filter(a => a.lifecycle_state === 'working');
    const waitingSessions = onlineAgents.filter(a => a.lifecycle_state === 'waiting');
    const idleSessions = onlineAgents.filter(a => a.lifecycle_state === 'idle');

    // 活跃施工与排队中工作者
    const activeWorkers = (collab.nodes || []).filter(n => n.lifecycle_state === 'working' || n.lifecycle_state === 'waiting');

    // 冲突与排他资源锁
    const activeClaims = dashboard.activeClaims || [];
    const resourceLocks = collab.exclusiveLocks || [];
    const waitQueue = dashboard.waitQueue || [];

    // 对话与广播
    const dialogues = dashboard.recentDialogues || [];
    const broadcasts = dashboard.recentBroadcasts || [];

    const metrics = {
      workingAgents: workingSessions.length,
      waitingAgents: waitingSessions.length,
      idleAgents: idleSessions.length,
      totalOnline: onlineAgents.length,
      activeLocks: activeClaims.length + resourceLocks.length,
      topologyNodes: topology.totalNodes || topology.nodes?.length || 0,
      dialogueCount: dialogues.length + broadcasts.length
    };

    return {
      projectId: finalProjectId || 'all',
      timestamp: Date.now(),
      metrics,
      activeWorkers,
      topologySnapshot: topology,
      lockContention: {
        activeClaims,
        resourceLocks,
        waitQueue
      },
      dialogues,
      broadcasts,
      summary: {
        totalOnline: onlineAgents.length,
        workingCount: workingSessions.length,
        waitingCount: waitingSessions.length,
        idleCount: idleSessions.length,
        activeLocksCount: activeClaims.length + resourceLocks.length,
        topologyNodesCount: topology.totalNodes || topology.nodes?.length || 0
      },
      dashboard,
      collab,
      topology
    };
  }
}

export { CoordinatorEngine as Coordinator };
