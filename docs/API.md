# Agent-Nexus API 参考手册

所有 REST 接口默认监听 `http://127.0.0.1:4100`，返回标准 JSON，支持 CORS。

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
      "intent_id": "intent_2a7fc900",
      "agent_id": "claude-sess_02",
      "agent_name": "视觉点击兜底"
    }
  }
  ```

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

---

## 二、共享状态与 CAS 接口 (State & CAS Endpoints)

对齐 `agent-comm`，支持命名空间、自动过期与原子并发互斥。

| 方法 | 路径 | 参数说明 | 描述 |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/state` | `?namespace=default&prefix=` | 列出指定命名空间下的键值对 |
| `GET` | `/api/state/:ns/:key` | - | 获取特定 Key 的状态内容 |
| `POST` | `/api/state/:ns/:key` | `{ "value": "...", "updated_by": "a1", "ttl_seconds": 60 }` | 写入或更新状态 |
| `POST` | `/api/state/:ns/:key/cas` | `{ "expected": "...", "new_value": "...", "updated_by": "a1" }` | **原子 Compare-And-Swap** |
| `DELETE` | `/api/state/:ns/:key` | - | 删除状态键 |

---

## 三、消息管道接口 (Messaging Endpoints)

| 方法 | 路径 | 参数说明 | 描述 |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/messages` | `{ "from": "a1", "to": "a2", "content": "hello", "importance": "normal" }` | 发送点对点或广播消息（to 为空为广播） |
| `GET` | `/api/messages` | `?to=agent-id` | 查询收件箱或全局消息流水 |

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
- `agent:woken`：资源被释放后的主动唤醒信号（携带目标 `agent_id` 与 `intent_id`）。
- `state:changed`：共享状态键值发生变动。
- `message:sent`：接收到新的协调消息。

---

## 六、MCP 工具协议定义

`src/mcp/server.js` 定义以下工具及处理函数；当前 daemon 未接入标准 MCP 传输，仍需适配后才能供客户端连接：
1. `nexus_declare_intent`：声明意图与三级资源 Claims；
2. `nexus_release_lease`：完成任务后释放租约；
3. `nexus_state`：共享状态 CRUD 与 CAS 原子操作；
4. `nexus_message`：向同工作区其他 Agent 投递消息；
5. `nexus_status`：检索全局协调矩阵与阻塞快照。
