# Agent-Nexus API 参考手册

所有 REST 接口默认监听 `http://127.0.0.1:4100`，返回标准 JSON。

## 认证

`/api/*` 与 WebSocket 都需要令牌，只放行 `/health` 与面板 HTML 本身。

令牌在 daemon 启动时签发、只打印一次、不落盘，重启即轮换。启动日志里那枚是 **operator 令牌**（read + write + mint），用它换绑定具体 agent 的令牌：

```bash
NEXUS_ADMIN_TOKEN=<启动时打印的令牌> nexus token <agent-id>
```

两种令牌：

| 令牌 | 作用域 | 能做什么 |
| --- | --- | --- |
| operator | `read` `write` `mint` | 读写全部接口，并签发 agent 令牌；`?to=` 可读任意收件箱 |
| agent | `read` `write` | 只能读**自己**的收件箱；不能签发令牌 |

- HTTP：`Authorization: Bearer <token>`，或查询参数 `?token=`（浏览器面板发不了自定义头，只能走后者）。
- WebSocket：查询参数 `?token=`。令牌在 HTTP upgrade 阶段校验，不通过直接 401，**不会先握手成功再关闭**——那中间有窗口，未授权客户端可能已被算进广播接收方。
- 对同一 agent 重复签发会**作废上一枚**。
- 签发令牌会顺带登记该 agent，否则新令牌会撞上 `messages.from_agent` 的外键。
- agent 令牌不能签发令牌；签发权只留在 operator 手上，否则任何 agent 都能给自己领一个新身份。

**身份以令牌为准，不采信请求体里的 `from`。** 令牌绑定了 agent_id 时，`from` 与之不符直接 400；请求体里不带 `from` 也行，由令牌填。`provider` 字段只作展示，不参与任何准入判断——它是调用方可控的字符串，自称 `claude` 的陌生进程和真 Claude Code 无法区分。

跨源默认不放行：`NEXUS_ALLOWED_ORIGINS` 白名单外的来源既拿不到 CORS 响应头，预检也返回 403。该变量按请求读取，改完无需重启。

## 〇、错误约定

| 状态码 | 含义 |
| --- | --- |
| 400 | 请求体不是合法 JSON，或字段不满足契约。响应为 `{"error": "...", "field": "claims[].target"}` |
| 401 | 缺少令牌，或令牌无效/已被轮换作废 |
| 403 | 令牌作用域不足（只读令牌发写请求、agent 令牌读别人收件箱、agent 令牌试图签发令牌），或预检来源不在白名单内 |
| 404 | 资源不存在（含租约不存在或不属于该 agent） |
| 500 | 服务端内部错误，只回 `{"error": "Internal Server Error"}`，细节写服务端日志 |

入参硬性要求，任何一条不满足都返回 400 且**不写入任何协调记录**（不会留下半截 intent 或 claim）：

- `agent_id`：非空字符串。协调核心与 hook 通道都必须有它。
- `summary` / `prompt_hint` 之类的描述字段：非空字符串。
- `claims[].type`：`file` | `module` | `symbol` | `resource` 之一。
- `claims[].target`：
  - `file` / `module`——可相对可绝对，但归一化后不得落在工作目录或盘符根。空串、纯空白、`.`、`./` 都会被拒。
  - `symbol`——非空且不以空白或路径分隔符开头。
  - `resource`——非空且不含空白或路径分隔符的命名资源标示符（如 `tests`、`dev-server`、`build`）。
- hook 通道的 `file_path` 或 `resource_name` 必填，与 `claims[].target` 同规则。

状态与消息通道的硬性要求（同样返回 400 且不写入）：

- 状态的 `value`、`updated_by`、`namespace`、`key`：非空字符串。`value` 必须是字符串——复杂载荷由调用方自己序列化，和 `messages.content` 一致。传数字、对象或 `null` 一律拒绝。
- 状态的 `ttl_seconds`：正数或不给。给 `0`、负数或非数字都拒绝。
- CAS 的 `expected`：字符串或 `null`（键不存在时就是 `null`）。
- CAS 的 `new_value`：字符串或 `null`，`''` 和 `null` 表示删除该键。这两个字段语义不同，必须分开校验。
- 消息的 `from` / `content`：非空字符串。`from` 必须指向已注册的 agent。
- 消息的 `to` / `intent_id`：给了就必须指向真实存在的 agent / intent，不存在返回 400。
- 消息的 `importance`：`normal` | `urgent`。

字段名按请求体原样回报：CAS 的字段叫 `new_value`，错误里的 `field` 也是 `new_value`。

---

## 一、协调核心接口 (Coordinator Endpoints)

### 1. 意图声明与冲突检查
- **路径**：`POST /api/intents/declare`
- **请求体**：
  ```json
  {
    "agent_id": "codex-sess_01",
    "summary": "重构 InteractionResolver 的候选决策逻辑",
    "claims": [
      { "type": "file", "target": "src/InteractionResolver.kt" },
      { "type": "symbol", "target": "buildClickCandidates" }
    ],
    "ttl_seconds": 300
  }
  ```
- **响应 (无冲突 GRANTED)**：
  ```json
  {
    "status": "GRANTED",
    "intentId": "intent_47c91dbd",
    "leaseId": "lease_8a49f3a3",
    "expiresAt": 1774218000000,
    "claims": [...]
  }
  ```
- **响应 (冲突 WAITING)**：
  ```json
  {
    "status": "WAITING",
    "intentId": "intent_2a7fc900",
    "blockedBy": "codex-sess_01",
    "blockedByName": "重构 InteractionResolver",
    "reason": "File conflict: 'src/InteractionResolver.kt' is currently locked by 重构 InteractionResolver",
    "claims": [...]
  }
  ```

### 2. 租约释放与唤醒
- **路径**：`POST /api/leases/:id/release`
- **请求体**：
  ```json
  {
    "agent_id": "codex-sess_01"
  }
  ```
- **响应**：
  ```json
  {
    "success": true,
    "releasedLeaseId": "lease_8a49f3a3",
    "notifiedWaiter": {
      "agent_id": "claude-sess_02",
      "intent_id": "intent_2a7fc900"
    },
    "stillBlocked": 1
  }
  ```

  唤醒谁不是纯 FIFO：候选项按 claim 段数降序（范围窄的先过）排列，再逐个复核此刻是否真的无冲突——仍在冲突的留在队列里计入 `stillBlocked`，不唤醒。选中的那枚 `agent:woken` 事件带 `verified: true`，表示它的 claim 在唤醒瞬间已确认无冲突。`notifiedWaiter` 为 `null` 表示当前无人可唤醒。

### 3. 通用 Hook 毫秒级极速校验与自动补报
- **路径**：`POST /api/hook/check`
- **请求体**：
  ```json
  {
    "agent_id": "claude-sess_02",
    "provider": "claude",
    "session_id": "sess_02",
    "file_path": "src/InteractionResolver.kt",
    "prompt_hint": "增加视觉兜底"
  }
  ```
- **响应 (放行)**：
  ```json
  { "allow": true, "autoClaimed": true, "leaseId": "lease_999" }
  ```
- **响应 (阻断)**：
  ```json
  {
    "allow": false,
    "holder": "重构 InteractionResolver",
    "reason": "BLOCKED: File 'src/InteractionResolver.kt' is locked by [重构 InteractionResolver] for \"重构 InteractionResolver 的候选决策逻辑\"."
  }
  ```
- **响应 (跨工作树阻断)**：
  ```json
  {
    "allow": false,
    "holder": "重构 InteractionResolver",
    "reason": "CROSS-WORKTREE CONFLICT: File 'src/InteractionResolver.kt' is locked by [重构 InteractionResolver] in another worktree (concurrent edits will cause git merge conflicts)."
  }
  ```
- **响应 (入参非法)**：`400`，`{"error": "\"claims[].target\" is required and must be a non-empty string", "field": "claims[].target"}`。Hook 收到 4xx 会按"协调库无法评估"处理并拦截（退出码 2），不会当成放行。

### 4. 命名资源锁接口 (Resource Locks)
针对 `tests`（全量测试）、`dev-server`（开发服务器端口）、`build`（打包构建）等系统排他性资源提供互斥锁定。

- **`GET /api/resources/locks?project_id=default`**：列出当前项目所有活跃的排他资源锁。
- **`POST /api/resources/lock`**：
  - 请求体：`{ "agent_id": "a1", "resource_name": "tests", "ttl_seconds": 300, "reason": "Running tests" }`
  - 响应：`{ "success": true, "status": "GRANTED", "resource_name": "tests", "leaseId": "lease_xxx" }` 或 `{ "success": false, "status": "WAITING", "blockedBy": "...", "reason": "..." }`
- **`POST /api/resources/unlock`**：
  - 请求体：`{ "agent_id": "a1", "resource_name": "tests" }`
  - 响应：`{ "success": true, "resource_name": "tests" }`

---

## 二、共享状态与 CAS 接口 (State & CAS Endpoints)

对齐 `agent-comm`，支持命名空间、自动过期与原子并发互斥。

| 方法 | 路径 | 参数说明 | 描述 |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/state` | `?namespace=default&prefix=` | 列出指定命名空间下的键值对 |
| `GET` | `/api/state/:ns/:key` | - | 获取特定 Key 的状态内容 |
| `POST` | `/api/state/:ns/:key` | `{ "value": "...", "updated_by": "a1", "ttl_seconds": 60 }` | 写入或更新状态 |
| `POST` | `/api/state/:ns/:key/cas` | `{ "expected": "...", "new_value": "...", "updated_by": "a1" }` | **原子 Compare-And-Swap** |
| `POST` | `/api/state/:ns/cas` | `{ "key": "...", "expected": "...", "new_value": "...", "updated_by": "a1" }` | 同上，键名放在请求体的 `key` 里 |
| `DELETE` | `/api/state/:ns/:key` | - | 删除状态键 |

CAS 的两种写法等价。路径里的 `cas` 是保留段：它不会被当成键名，所以键名要么来自它前面那一段，要么来自请求体的 `key`。两者都缺返回 400。

---

## 三、消息管道接口 (Messaging Endpoints)

| 方法 | 路径 | 参数说明 | 描述 |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/messages` | `{ "from": "a1", "to": "a2", "content": "hello", "importance": "normal" }` | 发送点对点或广播消息（to 为空为广播）。agent 令牌可省略 `from`，由令牌填 |
| `GET` | `/api/messages` | `?to=agent-id` | 查询收件箱。**agent 令牌只能 `?to=` 自己的 id**，读别人的返回 403 |
| `GET` | `/api/messages` | 无参数 | 全局消息流水。**agent 令牌调用返回 403**（否则等于绕过收件箱隔离）；operator 令牌可用 |

`POST /api/tokens`：用 operator 令牌调用，`{ "agent_id": "a1" }` → 201 `{ agent_id, token }`。重复对同一 agent 签发会作废上一枚。

---

## 四、Dashboard 与观察者接口

- **路径**：`GET /api/dashboard`
- **响应**：
  ```json
  {
    "agents": [
      {
        "id": "codex-sess_01",
        "name": "重构 InteractionResolver",
        "provider": "codex",
        "status": "running",
        "active_leases_count": 1,
        "current_intent": "重构 InteractionResolver 的候选决策逻辑",
        "current_intent_status": "granted"
      }
    ],
    "activeClaims": [
      {
        "claim_type": "file",
        "claim_target": "src/InteractionResolver.kt",
        "agent_id": "codex-sess_01",
        "agent_name": "重构 InteractionResolver"
      }
    ],
    "timeline": [
      {
        "id": 1,
        "agent_name": "重构 InteractionResolver",
        "event_type": "intent:granted",
        "description": "Granted lease for intent: ...",
        "created_at": 1774217000000
      }
    ]
  }
  ```

---

## 五、WebSocket 实时推送事件

连接地址：`ws://127.0.0.1:4100`

- `timeline`：时间线新增事件（Intent 声明、放行、冲突阻断、释放租约等）。
- `agent:woken`：资源被释放后的主动唤醒信号（携带目标 `agent_id`、`intent_id` 与 `verified: true`）。`verified` 表示该等待者的 claim 在唤醒瞬间已复核无冲突，收到即可刷新工作区开工，不必再问一次。
- `state:changed`：共享状态键值发生变动。
- `message:sent`：接收到新的协调消息。

---

## 六、AI 网关路由 REST 端点

### 1. `GET /api/gateway/route` 或 `GET /api/gateway/status`
检索 AI 智能网关当前各候选节点（Candidate）的运行态数据、健康熔断状态与请求指标。

- 响应：`200 OK`
  ```json
  {
    "strategy": "smart",
    "candidateCount": 2,
    "candidates": [
      {
        "id": "anthropic-primary",
        "name": "Anthropic Messages",
        "provider": "anthropic",
        "model": "claude-3-5-sonnet-latest",
        "priority": 0,
        "weight": 1,
        "resting": false,
        "remainingRestSeconds": 0,
        "consecutiveFailures": 0,
        "totalRequests": 12,
        "successCount": 12,
        "failureCount": 0,
        "lastLatencyMs": 850
      },
      {
        "id": "openai-fallback",
        "name": "OpenAI Chat",
        "provider": "openai",
        "model": "gpt-4o-mini",
        "priority": 1,
        "weight": 1,
        "resting": false,
        "remainingRestSeconds": 0,
        "consecutiveFailures": 0,
        "totalRequests": 0,
        "successCount": 0,
        "failureCount": 0,
        "lastLatencyMs": 0
      }
    ]
  }
  ```

### 2. `POST /api/gateway/chat`
通过网关实施多模型多候选自动故障转移调用。

- 请求体：
  ```json
  {
    "system_prompt": "You are a tech lead.",
    "user_message": "How should we schedule task A and B?",
    "affinity_key": "project-01",
    "strategy": "smart"
  }
  ```
- 响应：`200 OK`
  ```json
  {
    "content": "建议先执行任务 A 解耦数据模型，再并行推进任务 B。",
    "candidateId": "anthropic-primary",
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-latest",
    "latencyMs": 760,
    "tries": [
      { "id": "anthropic-primary", "success": true, "latencyMs": 760 }
    ]
  }
  ```

### 3. `POST /api/gateway/reset`
运维手动一键解除指定候选节点或全部节点的熔断冷却（Unrest）。

- 请求体（解除单个节点）：`{ "id": "anthropic-primary" }`
- 请求体（重置全部节点）：`{}`
- 响应：`200 OK`，返回 `{ "success": true, "resetId": "..." }` 或 `{ "success": true, "resetCount": N }`

---

## 七、MCP 工具协议定义

`src/mcp/stdio.js` 现已提供标准 JSON-RPC 2.0 stdio 服务（通过 `nexus mcp` 运行），`src/mcp/server.js` 提供以下工具定义与处理函数：

### 核心协调工具 (NEXUS_TOOLS)
1. `nexus_declare_intent`：声明意图与三级/四级资源 Claims（file, module, symbol, resource）；
2. `nexus_release_lease`：完成任务后释放租约；
3. `nexus_state`：共享状态 CRUD 与 CAS 原子操作；
4. `nexus_message`：向同工作区其他 Agent 投递消息；
5. `nexus_status`：检索全局协调矩阵与阻塞快照。

### 项目级进阶工具 (NEXUS_PROJECT_TOOLS)
6. `nexus_lock_resource`：申请命名排他资源锁（如 `tests`, `dev-server`, `build`）；
7. `nexus_unlock_resource`：释放命名排他资源锁；
8. `nexus_onboard`：进场向 AI Project Lead 申报工作计划并获取避障通道；
9. `nexus_advise_plan`：重新评估工作计划与当前系统锁并获取更新建议；
10. `nexus_report_milestone`：汇报阶段性里程碑、释放资源并沉淀长期记忆；
11. `nexus_search_memory`：检索项目长期工程记忆（架构决策、规则、踩坑、里程碑）；
12. `nexus_save_memory`：存入或更新长期工程记忆；
13. `nexus_broadcast`：向全项目活跃 Agent 会话广播高优先级指令与避障警示。
