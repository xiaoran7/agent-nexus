import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalizePath, hashProjectId, resolveProject, toRepoRelativePath, resolveProjectDisplayName } from '../src/domain/project.js';
import { ProjectRegistry } from '../src/domain/project-registry.js';
import { DatabaseSync } from 'node:sqlite';

test('项目识别与路径归一化', async (t) => {
  const baseTmp = mkdtempSync(join(tmpdir(), 'nexus-proj-test-'));

  t.after(() => {
    try {
      rmSync(baseTmp, { recursive: true, force: true });
    } catch {}
  });

  await t.test('canonicalizePath 规范化 Windows 盘符与反斜杠', () => {
    const p1 = canonicalizePath('C:\\Users\\test\\Project');
    const p2 = canonicalizePath('c:/users/test/project');
    assert.equal(p1, p2);
  });

  await t.test('hashProjectId 确定性与长度验证', () => {
    const h1 = hashProjectId('d:/claudespace/project/agent-nexus');
    const h2 = hashProjectId('d:/claudespace/project/agent-nexus');
    assert.equal(h1, h2);
    assert.equal(h1.length, 16);
    assert.equal(hashProjectId(''), 'default');
  });

  await t.test('向上探测命中 .git 标记', () => {
    const projRoot = join(baseTmp, 'my-git-repo');
    const subDir = join(projRoot, 'src', 'components');
    mkdirSync(join(projRoot, '.git'), { recursive: true });
    mkdirSync(subDir, { recursive: true });

    const res = resolveProject(subDir);
    assert.equal(res.marker, '.git');
    assert.equal(res.projectRoot, canonicalizePath(projRoot));
    assert.equal(res.projectId, hashProjectId(canonicalizePath(projRoot)));
  });

  await t.test('.nexus 优先级高于 .git', () => {
    const projRoot = join(baseTmp, 'nexus-priority');
    mkdirSync(join(projRoot, '.git'), { recursive: true });
    mkdirSync(join(projRoot, '.nexus'), { recursive: true });

    const res = resolveProject(projRoot);
    assert.equal(res.marker, '.nexus');
  });

  await t.test('无 .git 时可识别 package.json', () => {
    const projRoot = join(baseTmp, 'npm-pkg');
    mkdirSync(projRoot, { recursive: true });
    writeFileSync(join(projRoot, 'package.json'), '{}');

    const res = resolveProject(projRoot);
    assert.equal(res.marker, 'package.json');
    assert.equal(res.projectRoot, canonicalizePath(projRoot));
  });

  await t.test('仅有 CLAUDE.md 时能识别为项目', () => {
    const projRoot = join(baseTmp, 'claude-workspace');
    mkdirSync(projRoot, { recursive: true });
    writeFileSync(join(projRoot, 'CLAUDE.md'), '# Workspace');

    const res = resolveProject(projRoot);
    assert.equal(res.marker, 'CLAUDE.md');
    assert.equal(res.projectRoot, canonicalizePath(projRoot));
  });

  await t.test('没有任何标记时退回到当前目录', () => {
    const isolatedDir = join(baseTmp, 'empty-dir');
    mkdirSync(isolatedDir, { recursive: true });

    const res = resolveProject(isolatedDir);
    assert.equal(res.marker, null);
    assert.equal(res.projectRoot, canonicalizePath(isolatedDir));
  });

  await t.test('Git Worktree 识别：主仓库与工作树共享同一个 projectId 与 projectRoot', () => {
    const mainRepo = join(baseTmp, 'main-repo');
    const worktreeDir = join(baseTmp, 'main-repo-worktree-feat');
    const gitDir = join(mainRepo, '.git');
    const wtGitDir = join(gitDir, 'worktrees', 'feat-x');

    mkdirSync(wtGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    // 在 worktree 根目录写入 .git 文件，模拟 git worktree 行为
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${wtGitDir}\n`);

    const mainRes = resolveProject(mainRepo);
    const wtRes = resolveProject(worktreeDir);

    assert.equal(wtRes.marker, '.git');
    assert.equal(wtRes.worktree.isWorktree, true);
    assert.equal(wtRes.worktree.name, 'feat-x');
    assert.equal(mainRes.projectRoot, wtRes.projectRoot);
    assert.equal(mainRes.projectId, wtRes.projectId);
  });

  await t.test('toRepoRelativePath 计算跨工作树相对路径', () => {
    const projRoot = 'c:/workspace/my-repo';
    const wtRoot = 'c:/workspace/my-repo-feat';

    // 绝对路径位于主工程内
    assert.equal(toRepoRelativePath('c:/workspace/my-repo/src/domain/state.js', projRoot, projRoot), 'src/domain/state.js');

    // 相对路径
    assert.equal(toRepoRelativePath('src/domain/state.js', projRoot, wtRoot), 'src/domain/state.js');

    // 绝对路径位于 worktree 内，相对 worktree 解析出相同的相对路径
    assert.equal(toRepoRelativePath('c:/workspace/my-repo-feat/src/domain/state.js', projRoot, wtRoot), 'src/domain/state.js');

    // POSIX 风格绝对路径 (Linux / macOS 平台兼容性)
    const posixProj = '/workspace/my-repo';
    const posixWt = '/workspace/my-repo-feat';
    assert.equal(toRepoRelativePath('/workspace/my-repo/src/domain/state.js', posixProj, posixProj), 'src/domain/state.js');
    assert.equal(toRepoRelativePath('/workspace/my-repo-feat/src/domain/state.js', posixProj, posixWt), 'src/domain/state.js');
  });

  await t.test('resolveProjectDisplayName 解析真实目录名与大小写', () => {
    const namedDir = join(baseTmp, 'Agent-Nexus-Test');
    mkdirSync(namedDir, { recursive: true });

    const displayName = resolveProjectDisplayName(namedDir, namedDir);
    assert.equal(displayName, 'Agent-Nexus-Test');

    const res = resolveProject(namedDir);
    assert.equal(res.displayName, 'Agent-Nexus-Test');
  });

  await t.test('resolveProjectDisplayName 通用子目录名与父目录拼接', () => {
    const genericSub = join(baseTmp, 'solum', 'server');
    mkdirSync(genericSub, { recursive: true });

    const displayName = resolveProjectDisplayName(genericSub, genericSub);
    assert.equal(displayName, 'solum/server');

    // 针对不存在的虚拟路径规范化回退
    const mockPath = 'd:/workspace/project/demo-monorepo/client';
    assert.equal(resolveProjectDisplayName(mockPath, mockPath), 'demo-monorepo/client');
  });

  await t.test('resolveProjectDisplayName 处理默认与自定义显式标识符', () => {
    assert.equal(resolveProjectDisplayName('', '', 'default'), 'Default Project');
    assert.equal(resolveProjectDisplayName('', '', 'cliproxyapi'), 'cliproxyapi');
    assert.equal(resolveProjectDisplayName('', '', 'Project cliproxyapi'), 'cliproxyapi');
    assert.equal(resolveProjectDisplayName('', '', 'b7e6c7a3e3b4182e'), 'Project (b7e6c7)');
    assert.equal(resolveProjectDisplayName('', '', null), 'Default Project');
  });

  await t.test('ProjectRegistry 自动将存量 Project <hash> 数据库记录回填升级为真实名称', () => {
    const memDb = new DatabaseSync(':memory:');
    memDb.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, root_path TEXT NOT NULL, display_name TEXT, created_at INTEGER, last_activity INTEGER);');

    const sampleDir = join(baseTmp, 'My-Service');
    mkdirSync(sampleDir, { recursive: true });

    memDb.exec(`
      INSERT INTO projects VALUES ('default', '', 'Default Project', 0, 0);
      INSERT INTO projects VALUES ('1122334455667788', '${sampleDir.replace(/\\/g, '/')}', 'Project 1122334455667788', 1, 1);
      INSERT INTO projects VALUES ('cliproxyapi', '', 'Project cliproxyapi', 2, 2);
    `);

    const registry = new ProjectRegistry(memDb, null, null);
    const list = registry.listProjects();

    const migratedSample = list.find(p => p.id === '1122334455667788');
    assert.equal(migratedSample.display_name, 'My-Service');

    const migratedCli = list.find(p => p.id === 'cliproxyapi');
    assert.equal(migratedCli.display_name, 'cliproxyapi');

    const defProj = list.find(p => p.id === 'default');
    assert.equal(defProj.display_name, 'Default Project');
  });
});
