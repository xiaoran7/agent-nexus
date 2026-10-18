# 开源目录与 Awesome 列表提交指南 (Community Submissions)

本文件整理了向全球各大权威 Awesome 仓库和 MCP 目录收录 Agent-Nexus 的现成 PR 内容与提交步骤。

---

## 1. 提交至 `awesome-claude-code`

- **目标仓库**: `https://github.com/hesreallyhim/awesome-claude-code`
- **建议分类**: `Developer Tools` 或 `Hooks & Workflow Automation`
- **PR 标题**: `Add Agent-Nexus: Zero-overhead concurrency coordinator & multi-agent gatekeeper`

### PR 内容 / Description
```markdown
### What does this tool do?
[Agent-Nexus](https://github.com/xiaoran7/agent-nexus) is a zero-overhead local concurrency coordinator and resilient AI gateway for running multiple Claude Code sessions simultaneously.

### Why is it useful for Claude Code users?
When running multiple Claude Code sessions concurrently, agents frequently overwrite each other's edits, conflict on test/dev ports, or create severe Git merge conflicts across Git Worktrees.

Agent-Nexus intercepts actions at the `PreToolUse` hook level without requiring repository edits, providing:
- 3-tier fine-grained conflict arbitration (file / module / symbol).
- Cross-Worktree root normalization (detects collisions across worktree directories).
- Real-time host PID liveness detection (instantly reclaims abandoned locks on crash/exit).
- Resilient AI Gateway with circuit breaker cooling and failover.
- Zero repository pollution (0 files added to working codebases).

Package: `npx @xiaoran7/agent-nexus start`
```

### 插入 README 建议行
```markdown
- [Agent-Nexus](https://github.com/xiaoran7/agent-nexus) - Zero-overhead concurrency coordinator and resilient AI gateway for concurrent Claude Code sessions. Prevents file edit collisions and Git worktree conflicts via PreToolUse hooks.
```

---

## 2. 提交至 `awesome-mcp-servers`

- **目标仓库**: `https://github.com/punkpeye/awesome-mcp-servers`
- **建议分类**: `Utilities` 或 `Coordination & Memory`
- **PR 标题**: `Add Agent-Nexus: Concurrency coordinator & project memory MCP server`

### 插入 README 建议行
```markdown
- [Agent-Nexus](https://github.com/xiaoran7/agent-nexus) - Concurrency coordinator, exclusive resource lock manager, and long-term project memory server for multi-agent workflows.
```

---

## 3. 提交至 Smithery.ai (全球最大 MCP 注册表)

- **网址**: https://smithery.ai/
- **准备工作**: 项目根目录已内置 `smithery.yaml`。
- **操作步骤**:
  1. 登录 Smithery.ai（使用 GitHub 账号授权）；
  2. 点击右上角 **"Add Server"**；
  3. 输入 GitHub 仓库地址：`https://github.com/xiaoran7/agent-nexus`；
  4. 点击 **"Index Server"**，Smithery 会自动识别 `smithery.yaml` 和 package `@xiaoran7/agent-nexus` 并完成上架！

---

## 4. 提交至 Glama.ai MCP Directory

- **网址**: https://glama.ai/mcp/servers
- **操作步骤**:
  1. 访问 https://glama.ai/mcp/servers；
  2. 点击 **"Submit Server"**；
  3. 填入仓库地址 `https://github.com/xiaoran7/agent-nexus` 和简介；
  4. 提交后系统会自动爬取 README 和标签进行索引。
