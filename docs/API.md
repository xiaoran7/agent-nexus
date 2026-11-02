# Agent-Nexus API 与 MCP 参考手册

所有 REST 接口默认监听 `http://127.0.0.1:4300`，返回标准 JSON。

## 认证与安全边界

`/api/*` 与 WebSocket 均需携带令牌，仅放行 `/health`、`/api/status` 与静态面板资源（`/`、`/index.html`、`/style.css`、`/app.js`）。

- **Operator 令牌**（`read` + `write` + `mint`）：daemon 启动时自动生成并写入 `~/.agent-nexus/session.token`（权限 `0600`），供本机 CLI、Hook 与 MCP 自动读取；也可通过 `NEXUS_ADMIN_TOKEN` 环境变量固定。
- **Agent 令牌**（`read` + `write`）：通过 `POST /api/tokens` 签发，绑定特定 `agent_id`，不可伪造其他 `agent_id`，也不可签发新令牌。
- **传递方式**：HTTP 请求头 `Authorization: Bearer <token>` 或查询参数 `?token=<token>`；WebSocket 连接在 HTTP `upgrade` 阶段校验 `?token=<token>`。
- **跨源保护**：默认拒绝非白名单跨源请求；可通过 `NEXUS_ALLOWED_ORIGINS`（逗号分隔）按需放行。

---

## 一、健康检查与全景看板接口

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/health` | 公开 | 健康探针，返回 `{ status: "healthy", service: "agent-nexus", version }` |
| `GET` | `/api/status` | 公开 | 轻量在席计数（`active_agents_count`, `working`, `waiting`, `idle`, `active_leases`, `waiting_intents`），供桌面托盘轮询 |
| `GET` | `/api/dashboard` | 需令牌 | 返回指定项目（`?project_id=all` 或具体 ID）的在席 `agents`、`activeClaims`、`waitQueue`、`timeline`、`clusterNodes` 与 `activeHandoffs` |
| `GET` | `/api/cockpit` | 需令牌 | 返回协同路由视图所需的聚合数据（`metrics`、`lockContention`、`dashboard`、`collab`） |
| `GET` | `/api/events` | 需令牌 | SSE 实时事件流（转发 `timeline:event`、`agent:status`、`agent:woken`、`resource:freed`、`memory:saved`、`handoff:created`、`handoff:consumed`、`node:status`） |
| `GET` | `/api/projects` | 需令牌 | 列出已登记的所有工程及其实时在席会话数（`online_agents_count`） |

---

## 二、协调核心与锁接口 (Coordinator & Resource Locks)

### 1. 声明意图与申请租约
- **路径**：`POST /api/intents/declare`
- **请求体**：
  ```json
  {
    "agent_id": "claude-sess_01",
    "summary": "重构认证中间件",
    "claims": [
      { "type": "file", "target": "src/auth.js" }
    ],
    "ttl_seconds": 300,
    "project_id": "default"
  }
  ```
- **响应**：无冲突返回 `{ "status": "GRANTED", "intentId": "...", "leaseId": "...", "expiresAt": ... }`；冲突返回 `{ "status": "WAITING", "intentId": "...", "blockedBy": "...", "reason": "..." }`。

### 2. 释放租约与唤醒排队者
- **路径**：`POST /api/leases/:id/release`
- **请求体**：`{ "agent_id": "claude-sess_01" }`
- **响应**：`{ "success": true, "releasedLeaseId": "...", "notifiedWaiter": { "agent_id": "...", "intent_id": "..." }, "stillBlocked": 0 }`

### 3. 批量释放会话租约与 Git 生命周期释放
- **路径**：`POST /api/hook/git-release` 或 `POST /api/leases/release-agent`
- **请求体**：
  ```json
  {
    "agent_id": "claude-sess_01",
    "project_id": "default",
    "reason": "git_lifecycle",
    "git_context": {
      "commitMessage": "feat: add pkce verifier",
      "modifiedFiles": ["src/auth.js"]
    }
  }
  ```
- **说明**：一次性释放该会话持有的全部活跃租约，唤醒排队等待者，并基于 `git_context` 或近期授权流水自动合成跨机阶段工作交接工单（Handoff）。

### 4. 命名排他资源锁 (`tests`, `dev-server`, `build`)
- **`GET /api/resources/locks?project_id=default`**：列出当前活跃的排他资源锁。
- **`POST /api/resources/lock`**：申请排他资源锁 `{ "agent_id": "a1", "resource_name": "tests", "ttl_seconds": 900, "reason": "Running test suite" }`。
- **`POST /api/resources/unlock`**：释放排他资源锁 `{ "agent_id": "a1", "resource_name": "tests", "project_id": "default" }`。

### 5. 全局 Hook 极速判冲与释放接口
- **`POST /api/hook/check`**：供 `PreToolUse` 调用，支持文件锁与命令资源锁极速校验、自动补报租约、捎带 `peer_sessions` 同步，并在同源工程存在待接力工单时返回 `handoff_context`。
- **`POST /api/hook/resource-release`**：供 `PostToolUse` 在排他命令执行完毕后毫秒级释放资源锁。
- **`POST /api/hook/telemetry`**：供 Hook 上报非阻塞工具活动遥测。

---

## 三、多机探针、阶段交接工单与全局工程记忆接口

### 1. 算力节点与远端会话同步
- **`GET /api/nodes`**：列出集群内所有常驻算力节点（Hub 与 Edge）及其在线状态。
- **`POST /api/nodes/heartbeat`**：边缘节点上报心跳。
- **`POST /api/agents/sync-remote`**：边缘探针（`nexus probe --edge` 或 `nexus bridge`）批量推送远端机器上已验活的 Claude 会话快照。

### 2. 跨机阶段工作交接工单 (Work Handoffs)
- **`GET /api/handoffs?project_id=default`**：查询当前项目（含同源关联项目）的交接工单列表。
- **`POST /api/handoffs`**：创建阶段交接工单 `{ "project_id": "...", "source_host_id": "...", "source_agent_id": "...", "objective": "...", "state_summary": "...", "modified_files": [...], "next_action": "..." }`。
- **`POST /api/handoffs/:id/consume`**：认领或闭环交接工单 `{ "agent_id": "operator", "status": "in_progress" | "completed" }`。

### 3. 全局长期工程记忆 (Engineering Memories)
- **`GET /api/projects/:id/memories?category=all&query=...`**：检索项目长期工程记忆（自动聚合相同 `git_remote` 的同源项目记忆）。
- **`POST /api/projects/:id/memories`**：保存或更新工程记忆 `{ "category": "architecture" | "rule" | "gotcha" | "milestone" | "general", "key": "...", "content": "...", "source_agent_id": "..." }`。
- **`DELETE /api/projects/:id/memories?id=<memory_id>`**：按 ID 或 `category + key` 删除指定工程记忆。

---

## 四、WebSocket 实时推送协议

连接地址：`ws://127.0.0.1:4300/?token=<TOKEN>&project=<PROJECT_ID>`

- `init:state` / `sync:response`：下发看板快照 `data.snapshot` 与路由聚合 `data.cockpit`。
- `timeline`：新增协调时间线事件。
- `agent:woken`：租约释放后向首个无冲突等待者派发的唤醒信号（含 `verified: true`）。
- `resource:freed`：租约或排他资源锁释放事件。
- `handoff:created` / `handoff:consumed`：跨机交接工单生成或状态变更。
- `memory:saved` / `memory:deleted`：工程记忆新增、更新或删除。
- `node:status`：集群算力节点状态变更。

---

## 五、Stdio MCP 工具协议定义 (7 项核心工具)

通过 `nexus mcp` 启动标准 JSON-RPC 2.0 stdio 服务，`src/mcp/server.js` 暴露以下 7 项核心工具：

| 工具名 | 职责说明 | 必填参数 |
|---|---|---|
| `nexus_declare_intent` | 修改代码前声明工作意图与 `file` / `module` / `symbol` 资源声明 | `agent_id`, `summary`, `claims` |
| `nexus_release_lease` | 完工或中止任务时主动释放持有的租约，触发排队唤醒 | `agent_id`, `lease_id` |
| `nexus_lock_resource` | 申请命名排他资源锁（如 `tests`, `dev-server`, `build`） | `agent_id`, `resource_name` |
| `nexus_unlock_resource` | 释放命名排他资源锁 | `agent_id`, `resource_name` |
| `nexus_search_memory` | 按关键词或分类检索跨机共享的长期工程记忆 | 无（可选 `query`, `category`, `limit`, `project_id`） |
| `nexus_save_memory` | 将架构决策、项目规约、踩坑经验或里程碑沉淀至长期工程记忆 | `category`, `key`, `content` |
| `nexus_status` | 查询当前项目的在席会话、活跃锁、等待队列与时间线快照 | 无（可选 `project_id`） |
