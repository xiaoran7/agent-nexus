import { existsSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename, relative, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

const PROJECT_MARKERS = ['.nexus', '.git', 'package.json', 'CLAUDE.md'];

/**
 * 获取当前节点的标准身份标识 (Node / Host ID)
 * 优先读取 NEXUS_NODE_ID 环境变量，否则使用操作系统主机名
 *
 * 结果必须缓存：os.hostname() 在 Windows 上要走一次名称解析（实测 ~0.09ms），
 * 而本函数位于快照序列化的每个 agent 循环里（单库 293 行 → 每次快照上千次调用），
 * 不缓存会把主线程吃满，/health 从 1ms 抖到数秒，面板随之闪断重连。
 */
let cachedNodeId = null;
let cachedNodeIdEnv = undefined;

export function getLocalNodeId() {
  const envNode = process.env.NEXUS_NODE_ID;
  if (cachedNodeId !== null && cachedNodeIdEnv === envNode) return cachedNodeId;
  const raw = envNode || hostname() || 'local';
  cachedNodeId = normalizeNodeId(raw);
  cachedNodeIdEnv = envNode;
  return cachedNodeId;
}

// 测试需要覆盖 NEXUS_NODE_ID 或模拟主机名时调用；生产路径不应调用。
export function resetLocalNodeIdCache() {
  cachedNodeId = null;
  cachedNodeIdEnv = undefined;
}

export function normalizeNodeId(raw) {
  if (!raw || typeof raw !== 'string') return 'local';
  const clean = raw.trim();
  return clean || 'local';
}

export function isSameNode(hostA, hostB) {
  const a = normalizeNodeId(hostA).toLowerCase();
  const b = normalizeNodeId(hostB).toLowerCase();
  if (a === b) return true;
  const local = getLocalNodeId().toLowerCase();
  const aIsLocal = a === 'local' || a === local;
  const bIsLocal = b === 'local' || b === local;
  return aIsLocal && bIsLocal;
}

/**
 * 规范化文件系统路径：统一转为物理路径（解析软链接）、正斜杠，并处理 Windows 盘符与跨平台大小写。
 * 跨平台保护：Windows 宿主机收到远端 POSIX 绝对路径（以 / 开头且非 // UNC）时，保持纯 POSIX 路径与原始大小写，
 * 确保远端 Linux 计算的 hashProjectId 与 Windows Hub 计算结果 100% 字节级一致，不被拼上 d: 盘符。
 */
export function canonicalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  // 若是 Windows 盘符绝对路径 (如 C:/... 或 c:\...)，遵循 Windows 大小写不敏感契约规范为小写
  if (/^[a-zA-Z]:[/\\]/.test(p)) {
    let normalized = posix.normalize(p.replace(/\\/g, '/'));
    if (normalized.length > 3 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized.toLowerCase();
  }

  // 在 Windows 平台上收到纯 POSIX 绝对路径（如美西 Linux 的 /root/Claudespace/Project/foo）
  if (process.platform === 'win32' && p.startsWith('/') && !p.startsWith('//')) {
    let normalized = posix.normalize(p);
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }

  let resolved = resolve(p);
  try {
    if (existsSync(resolved)) {
      resolved = realpathSync(resolved);
    }
  } catch {}
  let normalized = resolved.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  if (normalized.length > 3 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  // Windows 平台下文件系统大小写不敏感，统一小写；POSIX (Linux/macOS) 平台保留真实物理大小写以保证真实文件路径可寻址
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 根据规范化后的根路径生成唯一且确定的 projectId (16 字符 hex)
 */
export function hashProjectId(canonicalRoot) {
  if (!canonicalRoot) return 'default';
  return createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
}

/**
 * 归一化 Git Remote URL 为跨协议、跨机器一致的仓库指纹（如 "github.com/owner/repo"）
 * 支持 https://, http://, ssh://, git@host:owner/repo.git 等格式
 */
export function normalizeGitRemoteUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let s = rawUrl.trim().replace(/\\/g, '/');
  if (!s) return null;

  // 去除末尾斜杠与 .git 后缀
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '');

  // 幂等支持：若已是归一化后的 host/owner/repo 指纹（如 github.com/acme/repo）
  if (!s.includes('://') && !s.includes(':') && !/\s/.test(s)) {
    const slashIdx = s.indexOf('/');
    if (slashIdx > 0) {
      const host = s.slice(0, slashIdx).toLowerCase();
      const pathPart = s.slice(slashIdx + 1).replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
      if ((host.includes('.') || host === 'localhost') && pathPart) {
        return `${host}/${pathPart}`;
      }
    }
  }

  // 处理 SCP 风格 SSH URL: git@github.com:owner/repo
  const scpMatch = s.match(/^(?:[^@/\s]+@)?([a-zA-Z0-9._-]+):([a-zA-Z0-9._/-]+)$/);
  if (scpMatch && !s.includes('://')) {
    const host = scpMatch[1].toLowerCase();
    const pathPart = scpMatch[2].replace(/^\/+/, '').toLowerCase();
    return `${host}/${pathPart}`;
  }

  // 处理标准 URL: https://, ssh://, git://
  try {
    const parsed = new URL(s);
    const host = parsed.hostname.toLowerCase();
    const pathPart = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
    if (host && pathPart) {
      return `${host}/${pathPart}`;
    }
  } catch {}

  return null;
}

/**
 * 从 Git 仓库目录或 .git 条目中提取归一化后的 remote origin 指纹
 */
export function extractGitRemoteFingerprint(repoRootOrGitPath) {
  if (!repoRootOrGitPath || typeof repoRootOrGitPath !== 'string') return null;
  try {
    let gitDir = repoRootOrGitPath;
    if (!gitDir.endsWith('.git')) {
      gitDir = resolve(repoRootOrGitPath, '.git');
    }
    if (!existsSync(gitDir)) return null;

    const stat = statSync(gitDir);
    if (stat.isFile()) {
      const content = readFileSync(gitDir, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/i);
      if (!match) return null;
      const resolvedGitDir = resolve(dirname(gitDir), match[1].trim());
      const commondirFile = resolve(resolvedGitDir, 'commondir');
      if (existsSync(commondirFile)) {
        const commondirRel = readFileSync(commondirFile, 'utf8').trim();
        gitDir = resolve(resolvedGitDir, commondirRel);
      } else {
        gitDir = resolve(resolvedGitDir, '../..');
      }
    }

    const configPath = resolve(gitDir, 'config');
    if (!existsSync(configPath)) return null;
    const content = readFileSync(configPath, 'utf8');

    // 优先提取 [remote "origin"] 下的 url
    const originBlockMatch = content.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/i);
    if (originBlockMatch) {
      const urlMatch = originBlockMatch[1].match(/^\s*url\s*=\s*(.+)$/m);
      if (urlMatch) {
        return normalizeGitRemoteUrl(urlMatch[1]);
      }
    }

    // 回退提取任意第一个 remote 的 url
    const anyUrlMatch = content.match(/\[remote\s+"[^"]+"\][\s\S]*?^\s*url\s*=\s*(.+)$/m);
    if (anyUrlMatch) {
      return normalizeGitRemoteUrl(anyUrlMatch[1]);
    }
  } catch {}
  return null;
}

const GENERIC_DIR_NAMES = new Set([
  'server', 'client', 'frontend', 'backend', 'web', 'app', 'ui', 'src', 'demo', 'test', 'workspace', 'repo', 'main'
]);

/**
 * 提取项目的归一化可比对仓库标识（含通用目录的父级限定，防止同名通用目录串味）
 */
export function extractComparableProjectKey(displayName, rootPath) {
  const cleanDisplay = (displayName || '')
    .replace(/\s*\[[^\]]+\]\s*$/, '')
    .replace(/\s*\([0-9a-f]{6}\)\s*$/i, '')
    .trim();

  if (cleanDisplay && cleanDisplay.toLowerCase() !== 'default project' && !/^project\s*\(/i.test(cleanDisplay)) {
    // 如果 displayName 已经带有 parent/dir 或并非通用单层目录名，则可作为有效标识
    if (!GENERIC_DIR_NAMES.has(cleanDisplay.toLowerCase())) {
      return cleanDisplay.toLowerCase();
    }
  }

  if (rootPath && typeof rootPath === 'string') {
    const clean = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = clean.split('/').filter(Boolean);
    if (parts.length > 0) {
      const last = parts[parts.length - 1].toLowerCase();
      if (GENERIC_DIR_NAMES.has(last)) {
        if (parts.length >= 2 && !parts[parts.length - 2].includes(':')) {
          return `${parts[parts.length - 2].toLowerCase()}/${last}`;
        }
        return null; // 顶层单字通用名（如 /app 或 D:/app）不参与跨机模糊合并，防止误串味
      }
      return last;
    }
  }

  return null;
}

/**
 * 解析跨机同源工程 ID 集合：
 * 1. 强等价：若存在 git_remote 指纹，相同 git_remote 的工程 100% 视为同一仓库；若双方均有 git_remote 但不相同，严格隔离绝不合并（即使目录同名）。
 * 2. 弱等价（无冲突 git_remote 时）：比对经过通用目录防碰撞保护的 extractComparableProjectKey。
 */
export function resolveEquivalentProjectIds(db, pid, stmtFn = null) {
  if (!pid || pid === 'all' || pid === 'default') return [pid || 'default'];
  const ids = new Set([pid]);
  const prepare = stmtFn || ((sql) => db.prepare(sql));
  try {
    const row = prepare(`SELECT id, display_name, root_path, git_remote FROM projects WHERE id = ?`).get(pid);
    if (!row) return [...ids];

    const selfRemote = row.git_remote ? normalizeGitRemoteUrl(row.git_remote) : extractGitRemoteFingerprint(row.root_path);
    const selfKey = extractComparableProjectKey(row.display_name, row.root_path);
    if (!selfRemote && !selfKey) return [...ids];

    const peers = prepare(`
      SELECT id, display_name, root_path, git_remote FROM projects
      WHERE id != 'all' AND id != '' AND id != 'default'
    `).all();

    for (const p of peers) {
      if (p.id === pid) continue;
      const peerRemote = p.git_remote ? normalizeGitRemoteUrl(p.git_remote) : extractGitRemoteFingerprint(p.root_path);

      // 若双方都有明确 Git Remote 指纹：指纹相同即合并，指纹不同则严禁合并（哪怕目录同名）
      if (selfRemote && peerRemote) {
        if (selfRemote === peerRemote) {
          ids.add(p.id);
        }
        continue;
      }

      // 至少一方无 Git Remote 指纹时，使用带父目录消歧的仓库键匹配
      if (selfKey) {
        const peerKey = extractComparableProjectKey(p.display_name, p.root_path);
        if (peerKey && peerKey === selfKey) {
          ids.add(p.id);
        }
      }
    }
  } catch {}
  return [...ids];
}

/**
 * 探测 Git Worktree 并提取共同主仓库根路径（Git Common Dir Root）
 * 参考 crewmates 架构实践：一个 Git 仓库的所有工作树共享同一个 Roster 与 Project ID
 */
function resolveGitCommonRoot(gitCandidatePath, currentDir) {
  try {
    const stat = statSync(gitCandidatePath);
    if (!stat.isFile()) {
      // 正常主仓库 .git 目录
      return {
        commonRoot: currentDir,
        worktree: { isWorktree: false, name: null, worktreeRoot: currentDir }
      };
    }

    // .git 是一个文件，表明当前处于 Git Worktree 中
    // 文件内容格式为：gitdir: /path/to/main-repo/.git/worktrees/<name>
    const content = readFileSync(gitCandidatePath, 'utf8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/i);
    if (!match) {
      return {
        commonRoot: currentDir,
        worktree: { isWorktree: false, name: null, worktreeRoot: currentDir }
      };
    }

    const rawGitDir = match[1].trim();
    const resolvedGitDir = resolve(currentDir, rawGitDir);
    const worktreeName = basename(resolvedGitDir);

    // 检查是否存在 commondir 指针文件 (Git 官方 worktree 规范)
    const commondirFile = resolve(resolvedGitDir, 'commondir');
    let commonGitDir;
    if (existsSync(commondirFile)) {
      const commondirRel = readFileSync(commondirFile, 'utf8').trim();
      commonGitDir = resolve(resolvedGitDir, commondirRel);
    } else {
      // 缺省结构为：<main-repo>/.git/worktrees/<name> -> 向上两级为 .git 目录
      commonGitDir = resolve(resolvedGitDir, '../..');
    }

    // commonGitDir 的上一层即为主仓库工作区根目录
    const mainRepoRoot = dirname(commonGitDir);
    return {
      commonRoot: mainRepoRoot,
      worktree: {
        isWorktree: true,
        name: worktreeName,
        worktreeRoot: currentDir
      }
    };
  } catch {
    return {
      commonRoot: currentDir,
      worktree: { isWorktree: false, name: null, worktreeRoot: currentDir }
    };
  }
}

/**
 * 从 startDir 向上追溯，寻找最近的项目根目录标记
 * 返回 { projectId, projectRoot, marker, worktree }
 */
export function resolveProject(startDir) {
  const targetDir = startDir || process.cwd();
  // 跨系统异构绝对路径（Windows 收到 POSIX /root/... 或 Linux 收到 Windows D:\...）：不查本机磁盘，直接按目录本身规范化
  const isForeignPosix = process.platform === 'win32' && typeof targetDir === 'string' && targetDir.startsWith('/') && !targetDir.startsWith('//');
  const isForeignWin = process.platform !== 'win32' && typeof targetDir === 'string' && /^[a-zA-Z]:[/\\]/.test(targetDir);
  if (isForeignPosix || isForeignWin) {
    const foreignRoot = canonicalizePath(targetDir);
    return {
      projectId: hashProjectId(foreignRoot),
      projectRoot: foreignRoot,
      displayName: resolveProjectDisplayName(targetDir, foreignRoot),
      gitRemote: null,
      marker: null,
      worktree: { isWorktree: false, name: null, worktreeRoot: foreignRoot }
    };
  }

  let current = resolve(targetDir);

  while (true) {
    for (const marker of PROJECT_MARKERS) {
      const candidate = resolve(current, marker);
      if (existsSync(candidate)) {
        let rootToUse = current;
        let worktreeInfo = { isWorktree: false, name: null, worktreeRoot: canonicalizePath(current) };

        if (marker === '.git') {
          const gitResolved = resolveGitCommonRoot(candidate, current);
          rootToUse = gitResolved.commonRoot;
          worktreeInfo = {
            ...gitResolved.worktree,
            worktreeRoot: canonicalizePath(gitResolved.worktree.worktreeRoot)
          };
        }

        const canonicalRoot = canonicalizePath(rootToUse);
        const gitRemote = extractGitRemoteFingerprint(rootToUse);
        return {
          projectId: hashProjectId(canonicalRoot),
          projectRoot: canonicalRoot,
          displayName: resolveProjectDisplayName(rootToUse, canonicalRoot),
          gitRemote,
          marker,
          worktree: worktreeInfo
        };
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      // 达到文件系统根目录，仍未找到标记
      break;
    }
    current = parent;
  }

  // 兜底：以当前起始目录为项目边界
  const fallbackRoot = canonicalizePath(targetDir);
  return {
    projectId: hashProjectId(fallbackRoot),
    projectRoot: fallbackRoot,
    displayName: resolveProjectDisplayName(targetDir, fallbackRoot),
    gitRemote: extractGitRemoteFingerprint(targetDir),
    marker: null,
    worktree: { isWorktree: false, name: null, worktreeRoot: fallbackRoot }
  };
}

/**
 * 解析并提取用户友好、真实可读的项目展示名称
 * 1. 优先提取物理文件系统路径真实大小写（Windows 下通过 fs.realpathSync.native 反查真实盘符与大小写）
 * 2. 识别通用单层目录名（如 server, client, frontend, backend, web, app, ui, src），结合上一级目录组合命名（例如 solum/server）
 * 3. 若路径在本地文件系统中不存在或不可寻址，回退为规范化路径的 basename（并处理跨平台与斜杠规范）
 * 4. 若无路径且传入显式 ID：
 *    - 'default' -> 'Default Project'
 *    - 非 16-hex 纯哈希的自定义名称（如 'cliproxyapi', 'my-proj'）-> 去除冗余 'Project ' 前缀后返回
 *    - 纯 16-hex 哈希（如 'b7e6c7a3e3b4182e'）-> 返回 'Project (b7e6c7)' 作为兜底
 * 5. 全空回退为 'Default Project'
 */
export function resolveProjectDisplayName(rawPath, canonicalPath, explicitId) {
  if (explicitId && typeof explicitId === 'string' && explicitId.toLowerCase() === 'default') {
    return 'Default Project';
  }

  const candidatePath = rawPath || canonicalPath;
  if (candidatePath && typeof candidatePath === 'string') {
    try {
      if (existsSync(candidatePath)) {
        const nativePath = realpathSync.native ? realpathSync.native(candidatePath) : realpathSync(candidatePath);
        const dirName = basename(nativePath);
        const genericNames = new Set(['server', 'client', 'frontend', 'backend', 'web', 'app', 'ui', 'src']);
        if (genericNames.has(dirName.toLowerCase())) {
          const parentDir = basename(dirname(nativePath));
          if (parentDir && parentDir !== '.' && parentDir !== '/' && parentDir !== '\\') {
            return `${parentDir}/${dirName}`;
          }
        }
        if (dirName && dirName !== '.' && dirName !== '/' && dirName !== '\\' && !dirName.includes(':')) {
          return dirName;
        }
      }
    } catch {}

    const clean = candidatePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = clean.split('/').filter(Boolean);
    if (parts.length > 0) {
      const dirName = parts[parts.length - 1];
      const genericNames = new Set(['server', 'client', 'frontend', 'backend', 'web', 'app', 'ui', 'src']);
      if (genericNames.has(dirName.toLowerCase()) && parts.length >= 2) {
        const parentDir = parts[parts.length - 2];
        if (parentDir && !parentDir.includes(':')) {
          return `${parentDir}/${dirName}`;
        }
      }
      if (dirName && !dirName.includes(':')) {
        return dirName;
      }
    }
  }

  if (explicitId && typeof explicitId === 'string') {
    const cleanId = explicitId.replace(/^Project\s+/i, '').trim();
    if (!cleanId || cleanId.toLowerCase() === 'default') {
      return 'Default Project';
    }
    // 如果不是 16 位 16 进制小写 hash，说明是用户显式命名的项目标识符（例如 cliproxyapi）
    if (!/^[0-9a-f]{16}$/i.test(cleanId)) {
      return cleanId;
    }
    return `Project (${cleanId.slice(0, 6)})`;
  }

  return 'Default Project';
}

function isPathAbsolute(p) {
  if (!p || typeof p !== 'string') return false;
  return p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:[/\\]/.test(p);
}

function resolveCrossPath(baseDir, filePath) {
  if (!filePath) return '';
  if (isPathAbsolute(filePath)) {
    return filePath;
  }
  if (baseDir && /^[a-zA-Z]:[/\\]/.test(baseDir) && process.platform !== 'win32') {
    const cleanBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const cleanRel = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    return `${cleanBase}/${cleanRel}`;
  }
  if (baseDir && baseDir.startsWith('/') && !baseDir.startsWith('//') && process.platform === 'win32') {
    return posix.resolve(baseDir, filePath.replace(/\\/g, '/'));
  }
  return resolve(baseDir || process.cwd(), filePath);
}

/**
 * 将给定的绝对或相对路径转为相对于项目根（projectRoot）的规范化跨工作树相对路径
 */
export function toRepoRelativePath(filePath, projectRoot, workspaceDir) {
  if (!filePath || typeof filePath !== 'string') return '';
  const baseDir = workspaceDir || projectRoot || process.cwd();
  const absolutePath = resolveCrossPath(baseDir, filePath);
  const canonicalProjectRoot = canonicalizePath(projectRoot);
  const canonicalTarget = canonicalizePath(absolutePath);

  if (canonicalProjectRoot && canonicalTarget.startsWith(canonicalProjectRoot + '/')) {
    return canonicalTarget.slice(canonicalProjectRoot.length + 1);
  }
  if (canonicalProjectRoot && canonicalTarget === canonicalProjectRoot) {
    return '.';
  }

  // 若处于工作树目录内，先转为相对于工作树根的路径
  const canonicalWorkspace = canonicalizePath(baseDir);
  if (canonicalWorkspace && canonicalTarget.startsWith(canonicalWorkspace + '/')) {
    return canonicalTarget.slice(canonicalWorkspace.length + 1);
  }

  return canonicalTarget;
}
