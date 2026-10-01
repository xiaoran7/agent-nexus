import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalizePath, hashProjectId, resolveProject } from '../src/domain/project.js';

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
});
