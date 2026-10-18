# 全平台推广文案物料包 (Community Launch Kit)

本文件整理了可以直接复制粘贴用于国内外各大高权重技术论坛的完整发帖文案。

---

## 1. V2EX (程序员节点 / 分享创造节点)

### 标题
**并发跑多个 Claude Code / Cursor 总互相踩踏改崩代码？做了一个本地零负担协调器 Agent-Nexus**

### 正文
```markdown
各位 V 友大家好，

最近在重度使用 Claude Code 和 Cursor 并发开发几个大项目，发现随着开的 Agent 会话变多，一个非常恼人的痛点频繁出现：

- 会话 A 在重构一个文件，会话 B 也突然把同一文件给改了，相互覆盖导致白干；
- 两个 Agent 跑同一个单测或启动 dev server，抢占 3000 或 8080 端口直接崩掉；
- 用 Git Worktree 在不同目录并发干活，因为路径不同，普通的锁完全感知不到，最后合并代码时产生大面积 Git 冲突。

市面上的分布式锁大多很重（要起 Redis、Docker，或者改业务仓库加一堆配置文件），对于本地多 Agent 开发来说太重了。

于是我们做了 **Agent-Nexus**，一个轻量级、面向多 Agent 的本地并发防撞协调器与弹性网关。

### 核心亮点

1. **业务项目零污染（Zero Repo Pollution）**：
   通过全局 PreToolUse Hook 拦截写入动作，你的所有业务项目不需要加任何 `.mcp.json`，不改 `.gitignore`，不污染代码库。
2. **三级细粒度资源仲裁**：
   支持 File、Module、Symbol 级别判冲。后到的 Agent 自动进入确定性等待队列（Safe Corridor），前排完工或 commit 后毫秒级唤醒。
3. **支持 Git Worktree 跨工作树对齐**：
   底层基于 `crewmates` 自动识别主仓库共同根，把不同工作树下的相对路径对齐，在提交前扼杀合并冲突。
4. **进程 PID 存活探测（早于超时释放）**：
   如果某个 Agent 会话崩溃或被 Ctrl+C 终止，系统探测到宿主 PID 死亡后立刻回收锁并唤醒排队者，不用傻等 TTL 超时。
5. **自带弹性 AI 网关 (Magpie)**：
   内置启发式错误归因与熔断机制，遇到上游 429 限流或服务异常时自动指数冷却并故障转移，并附带青空 UI / 暗黑风实时可视化控制台。

### 体验方式（免安装，一条命令直接跑）

```bash
npx @xiaoran7/agent-nexus start
```
默认会在后台启动协调器，并在浏览器打开实时 War Room 监控看板（http://127.0.0.1:4300）。

- GitHub 仓库：https://github.com/xiaoran7/agent-nexus
- npm 页面：https://www.npmjs.com/package/@xiaoran7/agent-nexus
- 纯原生 Node.js 24 + node:sqlite，内存占用 < 50MB，无本地原生编译依赖。

欢迎各位重度 Agent 玩家体验，有任何建议或 Issue 欢迎在 GitHub 砸过来！
```

---

## 2. Reddit (r/ClaudeAI / r/LocalLLaMA)

### Title
**Built a zero-overhead local concurrency coordinator for multi-session Claude Code to prevent file edit collisions & Git worktree disasters**

### Post Body
```markdown
Hey everyone,

If you run multiple concurrent Claude Code sessions, Cursor background agents, or Codex workflows on the same machine, you've probably encountered this headache:

- Agents silently overwrite each other's code in real-time.
- Concurrent sessions race for identical test ports or dev servers.
- When using Git Worktrees, path drift blinds standard locks, resulting in messy merge conflicts when branches merge.

Existing solutions usually require adding heavy Docker containers, Redis servers, or littering config files across every single repository.

We built **Agent-Nexus** (`@xiaoran7/agent-nexus`) to solve this with **zero repository pollution**.

### How it works:

1. **Zero-Overhead Hook Interception**: Runs at the host level (`PreToolUse` hook). 0 files added to your business repos, 0 gitignore modifications.
2. **3-Tier Conflict Arbitration**: Fine-grained arbitration across `file`, `module`, and `symbol` levels. Conflicting agents are placed in a deterministic waiting corridor and awakened in milliseconds when the active lease is released.
3. **Git Worktree Common Root Alignment**: Leverages `crewmates` to normalize paths across worktrees to the canonical repository root, preventing merge collisions before Git commits.
4. **Host PID Liveness Probe**: If an agent terminal crashes or is killed (Ctrl+C), its held locks are immediately reclaimed without waiting for TTL timeouts.
5. **Resilient AI Gateway (Magpie)**: Heuristic error categorization, dynamic circuit breaker cooling (`Retry-After`), and upstream failover.
6. **Real-time Visual Dashboard**: Beautiful Aozora Light & Dark dashboard monitoring active leases, countdowns, wait queues, and latency.

### Instant Try (no install required):
```bash
npx @xiaoran7/agent-nexus start
```

- GitHub: https://github.com/xiaoran7/agent-nexus
- npm: https://www.npmjs.com/package/@xiaoran7/agent-nexus
- Built on pure Node.js 24 + native `node:sqlite`. Zero native dependencies.

Feedback, feature requests, and PRs are warmly welcome!
```

---

## 3. Hacker News (Show HN)

### Title
**Show HN: Agent-Nexus – Zero-overhead concurrency coordinator for Claude Code & Cursor**

### Text
```markdown
Hi HN,

When running multiple autonomous AI coding agents (Claude Code, Cursor, Codex) concurrently on a codebase or across Git Worktrees, they frequently overwrite each other's edits, conflict on dev server ports, or create severe merge conflicts.

We built Agent-Nexus, a lightweight, self-hosted coordination daemon that prevents collisions with zero repository pollution.

Highlights:
- Intercepts edits and commands at the PreToolUse hook layer without adding files to the target repository.
- 3-tier arbitration (file, module, symbol) with deterministic wait-queue wakeups.
- Git worktree path normalization (built on `crewmates`) to prevent collisions across multiple checked-out worktrees.
- Host PID liveness probing for immediate lock recovery upon agent crashes.
- Embedded resilient AI gateway (`Magpie`) with circuit breaking and upstream failover.
- Standalone real-time web UI and Windows tray executable.

Requires Node.js 24+ (uses native `node:sqlite`). Zero native build dependencies.

Quick start:
`npx @xiaoran7/agent-nexus start`

Source: https://github.com/xiaoran7/agent-nexus
```

---

## 4. X (Twitter) 极简推文

```markdown
Run multiple concurrent Claude Code sessions without file collisions? ⚡

Meet Agent-Nexus: a zero-overhead local concurrency coordinator & resilient AI gateway for autonomous coding agents.

✅ 0 repo pollution (0 config files added)
✅ 3-tier file/module/symbol arbitration
✅ Cross-Git-Worktree collision detection
✅ Instant lock reclamation via host PID probing
✅ Real-time visual dashboard

Run instantly via npx:
npx @xiaoran7/agent-nexus start

GitHub: https://github.com/xiaoran7/agent-nexus
```
