# Agent-Nexus 架构设计与实现原理

## 一、系统总体架构 (Hub + Edge Probe + Global Hook)

```
  [本机 Claude Code 会话群]                      [远端机器 Claude Code 会话群 (如 us-zenix)]
       │               │                                    │                     │
       │ ~/.claude/    │ PreToolUse / PostToolUse           │ ~/.claude/          │ PreToolUse / PostToolUse
       │ sessions      │ (nexus-hook.mjs)                   │ sessions            │ (nexus-hook.mjs)
       ▼               ▼                                    ▼                     │
  ┌─────────────────────────┐                        ┌──────────────────┐         │
  │ 本机会话监听器 (fs.watch)│                        │ 无状态边缘探针    │         │
  └────────────┬────────────┘                        │ (probe --edge)   │         │
               │                                     └────────┬─────────┘         │
               ▼                                              │ POST /api/agents/ │
  ┌───────────────────────────────────────────────────────────▼───────────────────▼──┐
  │                        Agent-Nexus Central Hub (Port 4300)                       │
  │                                                                                  │
  │  ┌────────────────────────────────────────────────────────────────────────────┐  │
  │  │ Transport Layer: REST API (src/transport/rest.js) + WS + Stdio MCP (7项)   │  │
  │  └──────────────────────────────────────▲─────────────────────────────────────┘  │
  │                                         │                                        │
  │  ┌──────────────────────────────────────▼─────────────────────────────────────┐  │
  │  │ Domain & Coordination Core:                                                │  │
  │  │  - CoordinatorEngine: File(#anchor) / Module / Symbol / Resource 冲突仲裁   │  │
  │  │  - Project & Git Root: Worktree 共同根 (crewmates) + git_remote 指纹对齐   │  │
  │  │  - ClusterNodeService: 多机算力节点注册表与在线健康度                       │  │
  │  │  - ProjectHandoffService: 跨机阶段工作交接工单合成与按 Agent 投递去重       │  │
  │  │  - ProjectMemoryService: 跨机全局工程记忆 (architecture/rule/gotcha/...)   │  │
  │  └──────────────────────────────────────▲─────────────────────────────────────┘  │
  │                                         │                                        │
  │  ┌──────────────────────────────────────▼─────────────────────────────────────┐  │
  │  │ Storage Layer: Node.js 24 原生 node:sqlite (WAL 模式 + 预编译语句缓存)      │  │
  │  └────────────────────────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、核心分层与职责解耦

1. **Storage Layer (`src/storage/database.js`)**：
   - 使用 Node.js 24 原生 `node:sqlite`（开启 WAL 模式、外键级联约束与同步策略），只维护 8 张真实业务表：`projects`、`agents`、`intents`、`claims`、`leases`、`wait_queue`、`activity_log`、`cluster_nodes`、`project_handoffs`、`project_memories`。
2. **Coordination & Domain Core (`src/daemon/coordinator.js`, `src/domain/`)**：
   - `coordinator.js`：核心状态机与仲裁器。负责会话注册与存活探测、Intent/Lease 生命周期、四级冲突判定（`file` / `module` / `symbol` / `resource`）、窄声明优先唤醒、Git 生命周期锁释放与交接工单自动合成。
   - `project.js` & `project-registry.js`：负责向上探测项目根、解析 Git Worktree 共同根（`resolveGitCommonRoot`）、提取归一化 `git_remote` 指纹（`host/owner/repo`），实现跨工作树与跨操作系统的同源仓库自动关联。
   - `cluster-nodes.js`：常驻算力节点拓扑（Hub 与各 Edge 节点心跳、在线/离线状态）。
   - `handoff.js`：跨机阶段工作交接工单管理（`pending` -> `in_progress` -> `completed`），支持按 `forHostId` 与 `delivered_to_agents` 精确投递去重。
   - `memory.js`：跨机全局长期工程记忆（`architecture` / `rule` / `gotcha` / `milestone` / `general`）。
   - `errors.js`：`ValidationError`，调用方非法输入的唯一异常类型，REST 层统一映射为 400 且不留脏数据。
3. **Transport & MCP Layer (`src/transport/`, `src/mcp/`)**：
   - `rest.js`：纯标准库 HTTP 路由，内置静态资源内存缓存、SSE 实时流（`/api/events`）与认证校验。
   - `auth.js`：Operator 令牌与 Agent 令牌签发校验，以及 `~/.agent-nexus/session.token` / `remote.json` 端点解析。
   - `ws.js`：WebSocket 实时推送（在 HTTP `upgrade` 阶段完成令牌鉴权）。
   - `server.js` & `stdio.js`：精简高效的标准 JSON-RPC 2.0 stdio MCP 服务，提供 7 个核心工具（`nexus_declare_intent`、`nexus_release_lease`、`nexus_lock_resource`、`nexus_unlock_resource`、`nexus_search_memory`、`nexus_save_memory`、`nexus_status`）。
4. **Interception & Probe Layer (`src/hook/`, `src/probe/`, `src/daemon/bridge.js`)**：
   - `nexus-hook.mjs`：Claude Code 全局 `PreToolUse` 与 `PostToolUse` 钩子，负责写入判冲、排他命令锁推导、命令完工即时释放、`git commit`/`push` 自动释放与 `hookSpecificOutput.additionalContext` 上下文注入。
   - `probe/index.js` & `bridge.js`：支持本机 Hub 探针与远端无状态 Edge 探针的开机自启、端口反查（含纯 `/proc/net/tcp` 容器兜底）与会话快照同步。
5. **UI & Desktop Client (`src/ui/`, `desktop/`)**：
   - `src/ui/`：三栏高密度控制台（`会话与防撞`、`协同路由`、`接力与记忆`），真实展示在席会话、独占文件锁、排他命令锁、冲突等待队列、跨机交接工单与工程记忆。
   - `desktop/`：纯客户端 Electron 托盘外壳，绝不自拉起冲突进程。

---

## 三、确定性冲突仲裁与跨机同源对齐

```javascript
// 冲突判决核心规则 (src/daemon/coordinator.js)
// 1. File: 路径经 toComparablePath 归一化 + 剥离各宿主 projectRoot 后按仓库相对路径比对
//    支持 #anchor 细粒度大文件锚点锁：同文件不同锚点放行并发，整文件锁或同锚点互斥
// 2. Module: 按 '/' 分段前缀包含判定 (pathsOverlap)，避免 src/network 误拦 src/network-legacy
// 3. Symbol: 相同符号名互斥
// 4. Resource: 命名排他资源锁 (tests, dev-server, build) 按同宿主节点 (host_id) 互斥，跨机器各自独立运行测试与构建
```

### 同源工程跨机等价识别 (`getEquivalentProjectIds`)

当开发者的 Windows 主力机（`D:/Claudespace/Project/Repo`）与远端 Linux 机器（`/root/work/repo-clone`）克隆自同一个 Git 远端时：
1. `resolveGitRemoteUrl` 自动提取并归一化 `remote.origin.url` 为 `host/owner/repo` 指纹；
2. 即使两台机器的文件夹名称不同、绝对路径完全异构，`getEquivalentProjectIds` 也会通过相同的 `git_remote` 将它们识别为同一逻辑工程；
3. 若一方正在修改 `src/core.js`，另一方修改同一相对路径 `src/core.js` 时会立即触发跨机写锁互斥；而双方各自运行 `npm test`（`resource: tests`）则按 `host_id` 隔离，互不阻塞。

---

## 四、租约策略、等待唤醒与会话在席判定

- **租约策略 (`LEASE_POLICY`)**：文件租约默认 `300s`，命名资源锁默认 `900s`，持有者再次操作同一目标滑动续期 `120s`，单条租约总时长上限 `1800s`。
- **窄优先可用性复核唤醒 (`_wakeNextEligibleWaiter`)**：当租约释放或过期时，按等待者声明路径的段数降序排列（范围窄的优先），逐个通过 `findConflict` 复核此刻是否真正无冲突；跳过仍被其他锁阻塞的项，唤醒第一个真正可执行的目标并发出 `agent:woken`（`verified: true`）。
- **双通道会话在席验证**：
  - 优先检查 `~/.claude/sessions/<pid>.json` 中的 `messagingSocketPath` 命名管道，辅以 `process.kill(pid, 0)`；
  - 针对 Windows 命名管道瞬时采样抖动与远端桥 15 秒周期，设置 `45 秒` 消失宽限期（`SESSION_DISAPPEAR_GRACE_MS`），单帧漏检绝不误收割锁；
  - 经全局 Hook 注册的纯终端会话（不在桌面端 `~/.claude/sessions` 注册表内）豁免快照缺席收割，仅按心跳超时与 PID 存活探测回收。
