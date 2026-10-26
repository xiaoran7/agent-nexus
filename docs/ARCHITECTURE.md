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
   - **Git 提交零感自动释放**：Agent 执行 `git commit` 或 `git push` 时，全局 Hook 瞬时捕获并派发 `/api/hook/git-release`，批量释放该 Agent 的全部租约，无需人工介入也无需等待 TTL 到期；
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

### 租约时长

自动补报的租约统一走 `LEASE_POLICY`（`src/daemon/coordinator.js`）：文件 300 秒、命名资源 900 秒、滑动续期 120 秒、单条租约总时长上限 1800 秒。两组时长的取值依据不同：

- **文件租约**要覆盖一次“读代码 → 思考 → 改写”的完整间隔。只读工具（Read/Grep/Glob）不触发 Hook，纯阅读阶段没有任何续约来源；持有者再次写入同一文件会顺延租约，因此持续施工不会掉锁。
- **命名资源锁**要覆盖真实命令时长。`npm test`、`go test`、构建等常常超过一分钟，而 PostToolUse 在命令结束时毫秒级释放，TTL 只是进程崩溃的兜底。
- 上限防的是失联会话永久占锁，不针对正在干活的会话。

### 会话在席判定

会话注册表 `~/.claude/sessions/<pid>.json` 里的 `messagingSocketPath` 指向会话进程独占创建的命名管道。管道名含随机串、进程退出即消失，因此**管道存在是权威存活信号**，而 `process.kill(pid, 0)` 在 Windows 上会被 PID 复用欺骗（旧 PID 被分配给 `svchost.exe` 之类的常驻进程）。

同步时验证通过的会话写入 `agents.liveness_verified_at`，2 分钟内免于心急跳门禁——长回合（>10 分钟不调用工具）和等待用户输入的会话因此不会被误判离席。没有管道字段的旧注册表退回 PID 探针，并保留 10 分钟心跳门禁作为 PID 复用保护。

注册表里已声明管道的条目不再额外发 `process.kill(pid, 0)`：管道存在本身就是存活证明，而这段代码每 3 秒跑一遍。只有没有管道字段的旧注册表才付这次系统调用。

**单次探测失败不等于死亡。** Windows 上 `existsSync(管道)` 是瞬时读：实测每条管道每秒约 3.5% 的采样会漏检（30 秒内 265 次漏 3–15 次）。因此：

- 探测失败的那一帧只跳过该会话，不回收租约、不清 `liveness_verified_at`；该会话仍算「本帧见过」，不消耗宽限期；
- 收割统一走「会话从注册表快照里消失」这条路径，并带 `SESSION_DISAPPEAR_GRACE_MS`（45 秒）宽限：本地 3 秒刷新、远端桥 15 秒一帧，45 秒可容忍十几帧连续漏检；
- 本地会话还要求 PID 探针同时失败才判离席——断掉管道但进程仍在的会话不会被误杀，真死进程则由 PID 探针即时回收；
- 远端会话同样走这条宽限：边缘桥每 15 秒才推一帧，一次网络抖动或单帧漏检不该清掉远端文件锁。真死由「宽限期内每一帧都缺席」认定。

**全量快照的缺席只对「注册表追踪过的会话」有效。** 收割条件是 `liveness_verified_at IS NOT NULL`——即该会话至少被一次管道/PID 验证确认过。经全局 Hook 注册的终端会话从不写 `~/.claude/sessions`（那是桌面端维护的注册表），它的缺席不能作为死亡证据，否则刚拿到的租约会在首个 3 秒 tick 里被清掉。这类会话仍由 `reapStaleIntentsAndAgents` 按心跳超时收割。

离席时只改 `status`，不回写 `last_heartbeat`（否则面板永远显示不出「何时掉的线」）；`releaseAgentLeases` 在 `reason='process_exit'` 时也不做「无租约 → idle」的状态回写，避免把刚落的 departed 又改回在线。

### 快照刷新与查询成本

面板每 4 秒推一次 `sync:request`，daemon 另有 3 秒定时器，两条链路都会触发同一轮会话同步与租约回收。为避免重复劳动：

- `_refreshTick(now)` 是唯一刷新入口（`syncClaudeSessions + reapStaleIntentsAndAgents + reapDeadAgentLeases + expireLeases`）；顶层入口调用它，嵌套调用传 `skipRefresh: true`，一次 cockpit 请求只刷新一轮。
- `getUnifiedCockpit` 先算一次拓扑，同时用作 `topologySnapshot`；dashboard 与 collab 复用同一批 agent 行（`precomputedAgents`），不再各自跑一遍 5 个相关子查询与生命周期判定。
- 在席过滤下推到 SQL（`status != 'departed'`）：历史离席行是库存主体（实测 301 行里 292 行），先取出来再逐行判定、再丢掉，等于把 CPU 花在必然被丢弃的行上。会话复活只发生在 `syncClaudeSessions` 里，而同一次刷新里它已经把状态改回在线档位，因此 `status` 判定是安全的。
- SQL 语句按文本缓存（`_stmt/_run/_get/_all`）：`node:sqlite` 的 `prepare` 是 JIT 编译，热路径上每条 SQL 每次调用都重新编译，在 300 会话库上占单次快照约 10% 的自采样时间。
- `/api/status` 走一次窄列查询，只算计数；不序列化任何会话明细。桌面托盘每 3 秒轮询它。
- WebSocket 推送帧只带一份 dashboard（`data.snapshot`），`data.cockpit` 不再重复内嵌 `dashboard`/`collab`。

### 探针进程的定位与启停

探针的状态落在 `~/.agent-nexus/probe.json` 与 `probe.pid`，但**这两个文件不可当作事实来源**：它们只在探针「顺利启动」时写入，进程被强杀、崩溃或从旧版本升级时不会更新，会指向早已消失的 PID（真机上出现过文件写 33108、实际监听 4300 的是另一个孤儿进程）。

因此启停与状态查询都以「端口上到底是谁」为准：

- `probe:stop` 先按记录 PID 尝试，若该进程已不在而端口仍被占用，用 `findListeningPids(port)` 反查真实监听进程（Windows `netstat -ano -p TCP`，POSIX 依次试 `lsof` / `ss`）。
- **记录 PID 同样要自证**：PID 文件是不可信输入，Windows 会把旧号复用给无关进程，所以 `recordedPid` 也必须通过命令行核对才进入待杀列表——只有端口反查结果需要核对是旧版的行为，会把用户的编辑器 SIGTERM 掉。
- 反查结果必须通过 `isNexusProbeCommand(pid)` 自证才会被结束：命令行要匹配「`cli.js` + 完整 `probe` 子命令」。注意真机命令行每个参数都带引号（`"…\cli.js" "probe" "--port" "4300"`），匹配器不能假设 `probe` 前是裸空格，也不能把 `probe:install` 这类子命令算进来。
- 该检查是三态：`true` 确认是探针、`false` 确认不是、`null` 读不到命令行。`null` 只对记录 PID 放行（edge 探针没有端口兜底，一律拒绝就再也停不掉），端口反查结果则必须为 `true`。POSIX 优先读 `/proc/<pid>/cmdline`，读不到时退回 `ps -p <pid> -o args=`（macOS 没有 procfs）。
- 端口被陌生进程占用时绝不误杀，`probe:stop` 如实返回「未停止」并以非零退出码结束，而不是把失败说成「正在关闭」。
- `probe:status` 在 PID 文件失真但端口在监听时，报出反查到的真实 PID 并标注来源（`pidSource: 'port'`）。
- 探针进程注册了 `process.on('exit')` 兜底清理，且只清 `state.pid === process.pid` 的那一份，避免旧进程退出时误删新探针的状态文件。
