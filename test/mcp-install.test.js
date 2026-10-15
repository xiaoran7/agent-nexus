import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installProjectMcp } from '../src/installer/index.js';

test('installProjectMcp: 项目级 .mcp.json 安装与合并', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-mcp-test-'));

  t.after(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('空白项目：自动创建 .mcp.json 并写入 nexus server 配置', () => {
    const res = installProjectMcp(tempDir);
    const mcpPath = join(tempDir, '.mcp.json');

    assert.ok(existsSync(mcpPath));
    const config = JSON.parse(readFileSync(mcpPath, 'utf8'));

    assert.ok(config.mcpServers);
    assert.ok(config.mcpServers.nexus);
    assert.equal(config.mcpServers.nexus.command, 'node');
    assert.ok(Array.isArray(config.mcpServers.nexus.args));
    assert.ok(config.mcpServers.nexus.args.includes('mcp'));
    assert.ok(config.mcpServers.nexus.args.includes('--project'));
  });

  await t.test('已存在 AOCI 配置的项目：平滑合并，绝不抹除已有的 aoci 节点', () => {
    const mcpPath = join(tempDir, '.mcp.json');

    // 预先写入现有的 aoci 配置
    const initialConfig = {
      mcpServers: {
        aoci: {
          command: 'D:/AOCI/aoci.exe',
          args: ['--repo', tempDir.replace(/\\/g, '/'), 'mcp']
        }
      }
    };
    writeFileSync(mcpPath, JSON.stringify(initialConfig, null, 2), 'utf8');

    // 执行安装
    installProjectMcp(tempDir);

    const merged = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(merged.mcpServers);
    assert.ok(merged.mcpServers.aoci, 'aoci 节点必须被完整保留');
    assert.equal(merged.mcpServers.aoci.command, 'D:/AOCI/aoci.exe');
    assert.ok(merged.mcpServers.nexus, 'nexus 节点必须成功注入');
    assert.equal(merged.mcpServers.nexus.command, 'node');
  });

  await t.test('重复执行安装：具备完全幂等性，不产生冗余字段', () => {
    const mcpPath = join(tempDir, '.mcp.json');
    installProjectMcp(tempDir);
    installProjectMcp(tempDir);

    const config = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.equal(Object.keys(config.mcpServers).length, 2); // aoci + nexus
  });
});
