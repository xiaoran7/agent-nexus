# Agent-Nexus 架构设计与实现原理

## 一、系统架构图

```
                     ┌─────────────────────────────────────────────────────────┐
                     │               Agent-Nexus Local Gateway                 │
                     │                     (127.0.0.1:4300)                    │
                     │                                                         │
                     │   ┌─────────────────────────────────────────────────┐   │
                     │   │             Transport Layer (接入层)             │   │
                     │   │   REST API  │  WebSocket Server  │  MCP Server  │   │
                     │   └───────▲───────────────▲─────────────────▲───────┘   │
                     │           │               │                 │           │
                     │   ┌───────▼───────────────▼─────────────────▼───────┐   │
                     │   │              Domain Core (领域核心层)            │   │
                     │   │  - CoordinatorEngine (冲突判决/租约/唤醒)        │   │
                     │   │  - StateService (命名空间共享状态 & 原子 CAS)    │   │
                     │   │  - MessageService (点对点 & 广播协调消息流)     │   │
                     │   └───────────────────────▲─────────────────────────┘   │
                     │                           │                             │
                     │   ┌───────────────────────▼─────────────────────────┐   │
                     │   │             Storage Layer (持久化层)            │   │
                     │   │      SQLite (WAL Mode, node:sqlite 原生引擎)    │   │
                     │   └─────────────────────────────────────────────────┘   │
                     └─────────────▲───────────────────────────▲───────────────┘
                                   │                           │
                   ① 宏观主动报备  │                           │ ② 微观强制拦截 (Hook 门禁)
                  (提前排队避免白写) │                           │
                                   │                           │
                        ┌──────────┴────────┐        ┌─────────┴─────────┐
                        │    Coding Agent   │──Edit─►│ Universal Hook    │
                        │ (Claude/Codex/etc)│        │ (nexus-hook.mjs)  │
                        └───────────────────┘        └───────────────────┘
```

---

## 二、核心分层与职责解耦

系统遵循明确的分层解耦原则：

1. **Storage Layer (`src/storage/`)**：
   - `database.js`：单一真理来源。使用 Node.js 24 原生 `node:sqlite`（开启 WAL 模式、外键级联约束与同步策略），保证高频写入与零外部编译依赖。
2. **Domain Core (`src/domain/`, `src/daemon/coordinator.js`)**：
   - `coordinator.js`：核心状态机与仲裁器。负责 Agent 注册、Intent 账本、Lease 租期管理、三级冲突判定（file/module/symbol）、自动补报与等待队列唤醒。
   - `state.js`：共享状态与 CAS（Compare-And-Swap）服务，专用于协调参数与锁管理。
   - `messages.js`：Agent 之间的结构化协作通信管道。发件人外键靠装配时注入的 `agentResolver` 核实。
   - `errors.js`：`ValidationError`，调用方非法输入的唯一类型。放在这里而不是 `coordinator.js`，是为了让 domain 层不反向依赖 daemon；`coordinator.js` 继续转出它以保持既有 import 路径可用。
3. **Transport Layer (`src/transport/`, `src/mcp/`)**：
   - `rest.js`：纯标准库 HTTP 路由，零框架轻量化分发。认证在读 body 之前完成，没令牌的请求一个字节都不进。
   - `auth.js`：令牌签发与校验。只在运行中的 daemon 内存里，不落盘。
   - `ws.js`：WebSocket 实时事件分发（向前端推流 Timeline、向 Agent 广播唤醒）。用 `noServer` 模式在 HTTP upgrade 阶段校验令牌——先握手再关的方案有窗口，未授权客户端可能已被算进广播接收方。
   - `stdio.js` (`src/mcp/`)：提供标准 JSON-RPC 2.0 stdio MCP 服务，支持客户端一键接入。
   - `server.js` (`src/mcp/`)：提供工具集定义、参数 Schema 校验与路由处理函数。
4. **Interception Layer (`src/hook/`, `src/installer/`)**：
   - `nexus-hook.mjs`：脱离特定 Agent 的通用拦截脚本，从环境自愈解析 Agent 身份，拦截文件写入与命名排他资源抢占。
   - `installer/index.js`：写入 Claude / AgentHub / ZCode 配置文件及项目级 `.mcp.json`；宿主是否读取并执行需另行验证，写入采用无损智能合并。
5. **Observability Layer (`src/ui/`)**：
   - `index.html`：极简暗黑模式的可解释单页应用，纯原生 JS/CSS，由 Daemon 静态分发。

---

## 三、确定性冲突算法原理

```javascript
// 冲突判决算法简析 (src/daemon/coordinator.js)
for (const claim of normalizedClaims) {
  for (const active of activeClaims) {
    if (active.agent_id === agentId) continue; // 允许同 Agent 重入与追加

    // 1. File: 路径完全精确一致 (经 toComparablePath 跨工作树映射对齐)
    //    支持细粒度大文件锚点锁 (#anchor): 同文件不同锚点放行安全并发，任意一方整文件锁互斥
    if (claim.type === 'file' && active.claim_type === 'file') {
      const [baseA, anchorA] = claim.target.split('#');
      const [baseB, anchorB] = active.claim_target.split('#');
      if (baseA === baseB) {
        if (!anchorA || !anchorB || anchorA === anchorB) return CONFLICT;
      }
    }

    // 2. Module: 路径包含关系 (父目录包含子文件，或子文件处于已锁定的父目录中)
    //    按 '/' 分段比较，避免 src/network 误判为包含 src/network-legacy
    if (claim.type === 'module' || active.claim_type === 'module') {
      if (this.pathsOverlap(claim.target, active.claim_target)) return CONFLICT;
    }

    // 3. Symbol: 相同符号名重合
    if (claim.type === 'symbol' && active.claim_type === 'symbol') {
      if (claim.target === active.claim_target) return CONFLICT;
    }

    // 4. Resource: 命名排他性资源互斥 (tests, dev-server, build 等)
    if (claim.type === 'resource' && active.claim_type === 'resource') {
      if (claim.target === active.claim_target) return CONFLICT;
    }
  }
}
```

### Git Worktree 跨工作树路径对齐 (借鉴 crewmates)

在大型并发多工作树（Git Worktree）开发环境下，各工作树位于不同绝对物理路径下。Nexus 采用双层映射机制：
1. **共同根解析 (`resolveGitCommonRoot`)**：读取工作树下的 `.git` 文件并解析 `gitdir` 与 `commondir`，计算主仓库根路径作为统一的 `projectRoot` 与 `projectId`，消除工作树视界隔离。
2. **相对化对齐 (`toRepoRelativePath`)**：将工作树绝对路径转化为相对于 `projectRoot` 的规范相对路径进行判冲。如果发现两个处于不同工作树的 Agent 并发改动同一文件，直接触发 `CROSS-WORKTREE CONFLICT` 高危警示，提示并发修改会导致 Git 合并冲突。

---

## 四、开源生态上游溯源与职责划分

本项目严格遵循开源项目引用与维护边界铁律：

| 模块名称 | 职责定位 | 借鉴上游 | 维护与排查第一准则 |
|---|---|---|---|
| 跨工作树碰撞与资源锁 | Git Worktree 共同根识别、跨树路径对齐、排他性资源锁（`tests`, `dev-server`, `build`） | [asutekku/crewmates](https://github.com/asutekku/crewmates) | 出现工作树定位异常或资源互斥故障时，**第一时间拉取上游最新 Release / Commit / Issue** 对齐官方方案，严禁盲目魔改脱离上游演进 |
| 弹性 AI 网关路由层 | 启发式错误分类、自动熔断与动态退避冷却、项目亲和多候选无感故障转移 | [magpie-ai/magpie](https://github.com/magpie-ai/magpie) | 错误状态识别与退避策略对齐上游算法实现 |
| 共享状态与 CAS | 命名空间共享 KV、TTL 过期与原子 CAS 并发保障 | agent-comm | 契约对齐标准分布式原子状态更新规范 |

---

## 四、租约生命周期与等待唤醒时序

1. **DECLARED**：Agent 报备意图及 claims。
2. **CHECKING**：排查当前有效期内的租约 claims。
3. **GRANTED**：
   - 创建 Lease 记录，设置 `expires_at = now + ttl * 1000`；
   - 状态标记为 `running`，写入 Activity Log。
4. **WAITING**：
   - 命中冲突，将 Intent 标记为 `waiting`，记录 `blocked_by_agent_id` 与原因；
   - 入队 `wait_queue`，写入 Activity Log。
5. **RELEASE / WAKE-UP**：
   - **主动释放**：前序 Agent 调用 `/api/leases/:id/release` 或 `nexus_release_lease` 显式释放资源；
   - **Git 提交零感自动释放**：Agent 执行 `git commit` 或 `git push` 时，全局 Hook 瞬时捕获并派发 `/api/hook/git-release`，批量释放该 Agent 的全部租约，无需人工介入也无需等待 5 分钟 TTL；
   - 选出下一个该唤醒的等待者，**不是纯 FIFO**（见下）；
   - 把该意图置为 `released` 并清除判冲留痕
     （否则陈旧的 `waiting` 记录会在面板快照里盖过重新声明后的 `granted` 意图）；
   - 向被唤醒 Agent 信箱持久化定向 handoff 通知，并通过 EventBus / WebSocket 发出 `agent:woken`，带 `verified: true`；
   - 被唤醒的 Agent 收到信号后重新读取工作区代码，重新提交 Intent。

### 唤醒队列的选取

等待期间资源可能被别人抢走或继续被锁着，所以"唤醒队首"经常是白唤醒一轮——它重新声明后仍然 WAITING，而后面那个其实已经能拿到的等待者被饿着。等待者的 claim 在入队时留在 `claims` 表里（只有租约过期或释放才删），因此释放时可以**直接复核**：

1. 候选取 `wait_queue` 全量，按 **claim 段数降序**重排——段数多 = 钻得深 = 要的范围小，窄的先过，减少反复惊群。段数不能用 `LENGTH(claim_target)`：claim 存的是归一化后的绝对路径，长度被工作目录前缀和目录名长度主导，与范围无关（`src/zzz…` 字符很长却只是个浅目录）。
2. 逐个复核该等待者此刻是否真的无冲突（走 `findConflict`，与 `declareIntent` 同一份实现）。仍在冲突的**留在队列里**，计入 `stillBlocked`，不唤醒。
3. 第一个无冲突的出队并唤醒。

`releaseLease` 的返回里带 `notifiedWaiter` 与 `stillBlocked`，便于调用方知道是"没人可唤醒"还是"有人仍在等"。
