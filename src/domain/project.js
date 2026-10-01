import { existsSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const PROJECT_MARKERS = ['.nexus', '.git', 'package.json', 'CLAUDE.md'];

/**
 * 规范化文件系统路径：统一转为物理路径（解析软链接）、小写、正斜杠，并处理 Windows 盘符
 */
export function canonicalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  let resolved = resolve(p);
  try {
    if (existsSync(resolved)) {
      resolved = realpathSync(resolved);
    }
  } catch {}
  let normalized = resolved.replace(/\\/g, '/');
  // 统一 Windows 盘符为小写 (如 C:/ -> c:/)
  if (/^[A-Za-z]:\//.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  // 去除末尾冗余斜杠（除根目录外）
  if (normalized.length > 3 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.toLowerCase();
}

/**
 * 根据规范化后的根路径生成唯一且确定的 projectId (16 字符 hex)
 */
export function hashProjectId(canonicalRoot) {
  if (!canonicalRoot) return 'default';
  return createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
}

/**
 * 从 startDir 向上追溯，寻找最近的项目根目录标记
 * 返回 { projectId, projectRoot, marker }
 */
export function resolveProject(startDir) {
  const targetDir = startDir || process.cwd();
  let current = resolve(targetDir);

  while (true) {
    for (const marker of PROJECT_MARKERS) {
      const candidate = resolve(current, marker);
      if (existsSync(candidate)) {
        const canonicalRoot = canonicalizePath(current);
        return {
          projectId: hashProjectId(canonicalRoot),
          projectRoot: canonicalRoot,
          marker
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
    marker: null
  };
}
