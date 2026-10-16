---
name: nexus-setup
description: Agent-Nexus 项目级初始化、无损 MCP 注入、Hook 物理拦截与协同纪律对齐。支持任意目标工程一键接入 Nexus 架构师调度走廊、跨工作树路径对齐、排他命名资源锁、.mcp.json 智能合并与 .gitignore 零污染治理。当用户提到 nexus-setup、初始化 nexus、项目级 nexus、接入 nexus、配置多 agent 协调时使用。
---

# Agent-Nexus 项目级初始化与工程治理指南 (nexus-setup)

本 Skill 提供将任意目标工程接入 **Agent-Nexus** 多 Agent 协同与长期记忆中枢的权威标准化工程流水线。
确立**“项目级物理视界隔离”**、**“跨工作树路径自动对齐”**、**“宿主机配置零污染”**与**“与 AOCI 无损共存”**核心红线。

---

## 1. 核心工程铁律（违反即事故）

1. **项目级物理隔离与 Git Worktree 共享共同根**：
   - 每个工程必须以其物理根目录生成确定性 16 字符 hex `projectId`；
   - 在 Git Worktree 场景下，必须通过解析 `.git` 指针文件自动向上追溯主仓库，确保主仓库与各工作树共享相同的 `projectId` 与项目根，消除协同盲区。

2. **宿主机配置对外绝对零污染**：
   - 包含宿主机绝对路径的 `.mcp.json` 与本地状态 `.nexus` **严禁提交至远端 Git 仓库**；
   - 目标工程必须在 `.gitignore` 中显式忽略 `.mcp.json` 与 `.nexus`；
   - 若 `.mcp.json` 之前已被 Git 索引误追踪，必须通过 `git rm --cached` 彻底解挂。

3. **MCP 注入绝不可暴力覆盖（无损智能合并）**：
   - 目标工程若已接入 `aoci`（代码全局认知）或其他自建 MCP 服务，**绝对禁止覆盖抹除已有配置**；
   - 必须采用增量合并算法：仅注入或更新 `mcpServers.nexus` 节点，保持其他所有 MCP Server 原样无损。

4. **坚守 Fail-Closed 物理拦截门禁**：
   - PreToolUse 守卫必须挂载到写工具链路（`Edit|Write|MultiEdit|NotebookEdit|Update|apply_patch` 及 Bash 写重定向命令）；
   - 发生冲突时毫秒级退出码 2 硬拦截，坚决消除多 Agent 代码踩踏。

5. **不空谈计划，接入后必须真实运行验证闭环**：
   - 必须通过 `nexus status` 或运行一次轻量握手验证，带证据交付验收报告。

---

## 2. 仓库标准 `.gitignore` 模板

在任何接入 Agent-Nexus 的目标工程根目录，`.gitignore` 必须补齐以下隔离规则：

```gitignore
# ==============================================================================
# Agent-Nexus Local Coordination & Host Runtime (纯本地环境，严禁提交远端)
# ==============================================================================
.mcp.json
.nexus
```

若项目同时使用了 AOCI 或本地 Agent 垫片，建议采用如下统合隔离块：

```gitignore
# ==============================================================================
# AI Tooling & Local Coordination (纯本地辅助，严禁提交远端)
# ==============================================================================
# Agent-Nexus 本地配置与状态
.mcp.json
.nexus

# AOCI 全量本地认知资产与索引
aoci.*
.aoci/
AGENTS.md.backup.*

# 本地 Agent 垫片与私有上下文
AGENT.md
agent.md
*.local.md
CLAUDE.local.md
AGENTS.local.md
.claude/worktrees/
.claude/settings.local.json
.claude/scheduled_tasks.json
```

---

## 3. 标准接入流水线（六步完成项目初始化）

### 步骤一：识别目标项目物理边界与 Git Worktree
在目标项目工作区中执行环境识别与项目归属推导：

```bash
# 查看目标工程的项目识别结果（Project ID、Project Root、Git Worktree 状态）
node "<Agent-Nexus-Path>/src/cli.js" project "<目标工程根目录>"
```

- 确认识别出的 `projectId`（16 字符 hex 散列，例如 `1a7452fa760552e6`）；
- 若当前位于 Git Worktree 内，确认其自动追溯到了主仓库共同根，输出 `isWorktree: true`。

---

### 步骤二：项目级 `.mcp.json` 无损智能注入
调用 Agent-Nexus 提供的项目级安装命令，为目标工程配置 `.mcp.json`：

```bash
# 为指定工程一键注入项目级 MCP Server 配置
node "<Agent-Nexus-Path>/src/cli.js" mcp:install "<目标工程根目录>"
```

该命令将执行无损合并：
1. 若 `.mcp.json` 不存在，自动创建合法 JSON 骨架；
2. 若已有 `aoci` 等节点，完整保留其配置，仅增量写入 `mcpServers.nexus`：
   ```json
   {
     "mcpServers": {
       "nexus": {
         "command": "node",
         "args": [
           "<Agent-Nexus-Path>/src/cli.js",
           "mcp",
           "--project",
           "<目标工程规范化绝对路径>"
         ],
         "env": {}
       }
     }
   }
   ```

---

### 步骤三：PreToolUse 物理拦截 Hook 治理
确保当前开发环境（如 Claude Code）已安装 Nexus 物理拦截 Hook：

```bash
# 为 Claude Code 注册 PreToolUse 守卫脚本
node "<Agent-Nexus-Path>/src/cli.js" hook:install
```

安装器会自动在 `~/.claude/settings.json`（或项目级 `.claude/settings.json`）中注册针对以下工具的 Matcher Group 保护：
- `Edit|Write|MultiEdit|NotebookEdit|Update|apply_patch`
- `Bash`（自动提取 `>` 与 `>>` 写操作及 `npm test`/`dev-server`/`build` 资源锁）

---

### 步骤四：对齐 `.gitignore` 并清洗历史 Git 跟踪
1. 检查目标项目 `.gitignore`，确保已包含 `.mcp.json` 与 `.nexus`；
2. **至关重要**：检查 `.mcp.json` 是否已经被 Git 误追踪。若已被追踪，必须立即在目标仓库根目录执行：
   ```bash
   git rm --cached .mcp.json 2>/dev/null || true
   git rm --cached -r .nexus 2>/dev/null || true
   ```
   *注意：`git rm --cached` 仅将文件从 Git 暂存索引中解挂，本地物理文件分毫未损。*

---

### 步骤五：注入或增量对齐 `AGENTS.md` 协同纪律
在目标工程根目录的 `AGENTS.md` 中注入三级协同规范区块。若文件已存在，追加至末尾即可：

```markdown
<!-- NEXUS-COORDINATION-START -->
## Agent-Nexus 多 Agent 并发协同与工程记忆纪律

本工程已接入 **Agent-Nexus** 协同中枢与常驻 AI 架构师（Tech Lead）。所有在本工作区并发作业的 AI Agent 必须遵守以下协同三原则：

1. **进场声明意图（Onboarding）**：
   - 开工前调用 MCP 工具 `nexus_onboard` 申报任务意图与预期修改文件列表；
   - 若遇到资源占用，系统将自动划分出“安全施工走廊（safeToStart）”与“避障等待队列（mustWait）”，请优先开发空闲模块，避免盲目重试。

2. **排他资源锁与跨工作树防撞（Resource Locks & Worktree）**：
   - 运行独占性命令前申报排他资源锁（例如 `tests`、`dev-server`、`build`）；
   - 在 Git Worktree 中修改文件时，Nexus 会自动基于主仓库共同根做跨工作树相对化对齐，若出现 `CROSS-WORKTREE CONFLICT` 警示，必须立即规避以杜绝 Git 合并冲突。

3. **完工释放与经验沉淀（Release & Long-Term Memory）**：
   - 阶段任务完工后立即调用 `nexus_release_lease` 释放锁定，唤醒后排等待会话；
   - 重大架构决策、避坑经验与代码规约，调用 `nexus_save_memory` 沉淀到项目的长期记忆库中，供后续会话持续复用；
   - 达成里程碑时调用 `nexus_report_milestone` 广播战果。
<!-- NEXUS-COORDINATION-END -->
```

---

### 步骤六：端到端验证与接入验收
启动 Agent-Nexus 守护进程（若未启动）并执行状态自检：

```bash
# 1. 检查后台 Daemon 健康状态
node "<Agent-Nexus-Path>/src/cli.js" status

# 2. 验证目标项目状态
node "<Agent-Nexus-Path>/src/cli.js" project "<目标工程根目录>"
```

输出标准验收报告：
- [x] Project ID 唯一性与 Worktree 共同根识别完成
- [x] `.mcp.json` 无损智能合并（保留已有 `aoci`，注入 `nexus`）
- [x] PreToolUse 物理拦截 Hook 就绪（退出码 2 硬防御）
- [x] `.gitignore` 包含 `.mcp.json` 与 `.nexus`，Git 索引解挂确认干净
- [x] `AGENTS.md` 协同纪律注入完成
- [x] 实时可视化大屏就绪（War Room 与 Magpie Gateway 可视化调度大屏可查）

---

## 4. 与 AOCI 全局认知的协同共存最佳实践

当项目同时引入 **AOCI** 与 **Agent-Nexus** 时，两者职责分明、优势互补：
- **AOCI (Whole-Index & Cognition)**：负责全仓库代码架构认知、防幻觉全局索引、符号语义基线与只读加速。
- **Agent-Nexus (Traffic Control & Coordination)**：负责多 Agent 并发写入门禁拦截、冲突避障走廊、命名资源锁、动态容灾网关与项目长期工程记忆。

### 标准共存 `.mcp.json` 范例：
```json
{
  "mcpServers": {
    "aoci": {
      "command": "D:/AOCI/aoci.exe",
      "args": ["mcp"],
      "env": {}
    },
    "nexus": {
      "command": "node",
      "args": [
        "D:/Claudespace/Project/Agent-Nexus/src/cli.js",
        "mcp",
        "--project",
        "D:/Claudespace/Project/<目标项目>"
      ],
      "env": {}
    }
  }
}
```

---

## 5. 故障排查与速查

| 现象 | 根因排查 | 解决方案 |
|---|---|---|
| Hook 提示 401 Unauthorized | Daemon 重启后旧令牌作废，或未注入令牌 | 确保 Daemon 运行中，Hook 会自动拾取 `~/.agent-nexus/session.token`；亦可手动设置 `NEXUS_TOKEN` |
| Worktree 下 Project ID 变了 | `.git` 指针文件路径解析异常 | 执行 `nexus project` 检查是否输出了 `isWorktree: true`，确认 Git 指针文件中的 `gitdir` 路径真实存在 |
| 覆盖了现有的 aoci 配置 | 手工创建 `.mcp.json` 时误覆盖 | 一律使用 `nexus mcp:install` 执行无损合并，或在 JSON 中手工保留 `"aoci"` 节点 |
| Git 提交仍然带入了 `.mcp.json` | 仅改了 `.gitignore`，未从暂存区清除 | 执行 `git rm --cached .mcp.json` 即可解挂历史追踪 |
