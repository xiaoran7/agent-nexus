# Agent-Nexus 架构设计与实现原理

## 一、系统架构图

```
                     ┌─────────────────────────────────────────────────────────┐
                     │               Agent-Nexus Local Gateway                 │
                     │                     (127.0.0.1:4100)                    │
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
   - `messages.js`：Agent 之间的结构化协作通信管道。
3. **Transport Layer (`src/transport/`, `src/mcp/`)**：
   - `rest.js`：纯标准库 HTTP 路由，零框架轻量化分发。
   - `ws.js`：WebSocket 实时事件分发（向前端推流 Timeline、向 Agent 广播唤醒）。
   - `server.js` (`src/mcp/`)：仅提供工具集定义与处理函数，当前 daemon 尚未接入 MCP 传输。
4. **Interception Layer (`src/hook/`, `src/installer/`)**：
   - `nexus-hook.mjs`：脱离特定 Agent 的通用拦截脚本，从环境自愈解析 Agent 身份，拦截文件写入。
   - `installer/index.js`：写入 Claude / AgentHub / ZCode 配置文件；宿主是否读取并执行需另行验证，写入会覆盖部分配置。
5. **Observability Layer (`src/ui/`)**：
   - `index.html`：极简暗黑模式的可解释单页应用，纯原生 JS/CSS，由 Daemon 静态分发。

---

## 三、确定性冲突算法原理

```javascript
// 冲突判决算法简析 (src/daemon/coordinator.js)
for (const claim of normalizedClaims) {
  for (const active of activeClaims) {
    if (active.agent_id === agentId) continue; // 允许同 Agent 重入与追加

    // 1. File: 路径完全精确一致
    if (claim.type === 'file' && active.claim_type === 'file') {
      if (claim.target === active.claim_target) return CONFLICT;
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
  }
}
```

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
   - 前序 Agent 调用 `/api/leases/:id/release` 释放资源；
   - 从 `wait_queue` 捞出最优先的等待者，把该意图置为 `released` 并清除判冲留痕
     （否则陈旧的 `waiting` 记录会在面板快照里盖过重新声明后的 `granted` 意图）；
   - 通过 EventBus / WebSocket 发出 `agent:woken`；
   - 被唤醒的 Agent 收到信号后重新读取工作区代码，重新提交 Intent。
