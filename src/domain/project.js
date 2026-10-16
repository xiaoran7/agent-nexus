import { existsSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename, relative } from 'node:path';
import { createHash } from 'node:crypto';

const PROJECT_MARKERS = ['.nexus', '.git', 'package.json', 'CLAUDE.md'];

/**
 * 规范化文件系统路径：统一转为物理路径（解析软链接）、正斜杠，并处理 Windows 盘符与跨平台大小写
 */
export function canonicalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  // 若是 Windows 盘符绝对路径 (如 C:/... 或 c:\...)，遵循 Windows 大小写不敏感契约规范为小写
  if (/^[a-zA-Z]:[/\\]/.test(p)) {
    let normalized = p.replace(/\\/g, '/');
    if (normalized.length > 3 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized.toLowerCase();
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
        return {
          projectId: hashProjectId(canonicalRoot),
          projectRoot: canonicalRoot,
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
    marker: null,
    worktree: { isWorktree: false, name: null, worktreeRoot: fallbackRoot }
  };
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
