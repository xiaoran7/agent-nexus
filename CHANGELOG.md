# Agent-Nexus 更新日志

本文件记录项目历史。契约类内容看 [docs/API.md](docs/API.md) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，启动方式看 [README.md](README.md)。

---

## 2026-10-04 AI 常驻架构师调度（AI Project Lead）接通与确定性安全降级闭环

### 改了什么

- **`src/domain/llm-adapter.js`**
  - 重构 `AnthropicAdapter`：升级为 Node 原生 `fetch`，天然支持 `http:` 与 `https:` 双协议（无缝兼容本地 CPA 代理、反代网关与官方 API）。
  - 新增 `formatMessagesUrl`：智能规范化各类反向代理地址（自动补全 `/v1/messages`，兼容裸域名、路径前缀与末尾斜杠）。
  - 增加认证双头支持：兼容 `x-api-key` 与 `Authorization: Bearer <token>`。
  - 增加全链路防御机制：引入 `AbortController` 实施总耗时超时控制（默认 3000ms，支持 `NEXUS_LLM_TIMEOUT_MS`），引入 512KB 响应体积上限防御，所有网络/解析异常严格静默降级为 `null`，绝不抛出异常。
  - 新增 `parseLlmConfig`：统一集中解析 `NEXUS_LLM_ENABLED`、`NEXUS_LLM_MODEL`、`NEXUS_LLM_TIMEOUT_MS`、`ANTHROPIC_BASE_URL` 等环境变量。
- **`src/domain/project-lead.js`**
  - 升级 `onboard` 与 `advisePlan` 为 `async` 方法，正式接通 AI 架构师建议增强链路。
  - **坚持确定性安全为不可动摇的第一性原理**：资源冲突矩阵（`safeToStart` 与 `mustWait`）依然 100% 由底层规则引擎决定，LLM 绝无权力更改锁判定，杜绝任何 AI 幻觉引发的文件踩踏。
  - 注入专业 Tech Lead 系统提示词与工程上下文（包含受阻资源持有者、剩余锁定秒数倒计时、兄弟会话意图），由 AI 给出模块解耦、优先施工空闲区、先抽接口/Mock 等语义级施工编排建议。
  - 返回对象补充 `adviceSource: 'llm' | 'deterministic'` 与 `deterministicAdvice`（基线建议始终留痕，保障 100% 可观测性）。
  - 超时（>3s）、网络错误、无 API 密钥时，100% 透明降级回确定性规则建议，保证会话永不卡死。
- **`src/domain/project-registry.js` & `src/daemon/index.js`**
  - `ProjectRegistry` 启动时自动通过 `parseLlmConfig` 装配 `AnthropicAdapter` 或 `NullAdapter`。
  - 守护进程启动时明确打印 AI 架构师状态（启用/禁用、模型名称、端点地址），严格避免打印或泄露 API 密钥。
- **生产级端到端实测验证（`us-zenix`）**
  - 在美西生产机配置真实云端大模型代理（`cpa.tannerlab.xyz`，模型 `claude-sonnet-4-6`），编写并执行自动化压测 `test/test-ai-lead-live.mjs`。
  - 实测验证：Session Alpha 锁定 `src/user-service.js` 时，新进场的 Session Beta 申报包含受阻与空闲的多文件修改计划，成功触发 AI 常驻架构师分析（`adviceSource: "llm"`），输出了高水准的解耦指导语（建议立即开工 `order` 与 `payment` 独立跑道，并在锁释放前先为 `user` 模块抽 Mock 与接口契约）。
  - 确定性安全防线 100% 坚守：`safeToStart` 与 `mustWait` 数组分毫不差，AI 绝无权限擅自越权。
  - 容灾降级验证：模拟 1ms 网络中断或故障时，系统在 10ms 内极速无感降级为确定性规则建议（`adviceSource: "deterministic"`），保障会话零卡死。
  - 将适配器默认超时调优为 `8000ms`，max_tokens 收敛至 384 以最大化响应速度。
- **自动化测试**
  - 新增 `test/llm-adapter.test.js`（7 用例）：覆盖 URL 格式化、环境变量解析、HTTP 模拟调用、超时中止与错误降级。
  - 扩充 `test/project-lead.test.js`：覆盖 AI 增强成功（保留确定性冲突矩阵）、AI 超时降级、AI 抛错降级与 MCP 工具字段透传。
  - 全套单元测试总数扩充至 **167** 项，全部通过。

---

## 2026-10-01 实测验证与物理符号链接/Hook 提取/连接池稳定性加固

### 改了什么

- **`src/domain/project.js` & `src/daemon/coordinator.js`**
  - 在 `canonicalizePath`、`toComparablePath` 与 `normalizePath` 中全面引入 `realpathSync` 物理软链接解析，消除 Linux 符号链接路径（如 `/home/tanner/workspace` -> `/www/workspace`）与真实物理路径导致的 Project ID 和资源锁定哈希分叉。
  - 在 `coordinator.registerAgent` 中引入工作区根路径的自动物理规范化与项目 `root_path` 注册更新，确保架构师判冲时相对路径补全基准 100% 精确。
- **`src/hook/nexus-hook.mjs`**
  - 重构 Bash 工具写入目标提取引擎：彻底剥离 `/dev/null` 重定向（如 `2>/dev/null`、`2>&1`），修复 Agent 常规只读检查被误判为写操作导致意外锁定整个目录的缺陷；精确提取 `>` 与 `>>` 后紧随的真实目标文件。
- **`src/daemon/index.js`**
  - 配置 HTTP 服务器 `keepAliveTimeout = 65000` 与 `headersTimeout = 66000`，彻底解决客户端长连接套接字复用导致的 `UND_ERR_SOCKET / other side closed` 异常。
- **生产级端到端实测验证（`us-zenix`）**
  - 在美西生产机配置 Claude Code CLI + CPA 动态 SSE 转换垫片（`cpa-shim.mjs`），成功打通与 `cpa.tannerlab.xyz`（`claude-sonnet-4-6`）的稳定直连。
  - 编写并执行全链路端到端自动化压测 `test/test-parallel-live.mjs`：
    1. Session Alpha 声明并获得核心文件锁定；
    2. Session Beta 真实调用 Claude Code 全速并发完成独立文件，零阻塞零干扰；
    3. Session Beta 尝试并发写入锁中文件，PreToolUse Hook 毫秒级物理拦截（Fail-Closed，退出码 2），消除代码踩踏；
    4. Session Beta 咨询 Project Lead 架构师调度，实时获得避障重排建议（safeToStart 走廊与 mustWait 倒计时）；
    5. Session Beta 采纳架构师避障建议，优先并发施工空闲模块，平滑绕开锁中文件并成功产出代码；
    6. Session Alpha 完工释放租约，等待队列自动触发唤醒并平滑接力；
    7. Nexus Dashboard 实时面板时间线与指标记录完整闭环。

---

## 2026-10-01 项目级常驻架构师调度与 Session 自动识别

### 改了什么

- **`src/domain/project.js`** (新增)
  - 实现 `resolveProject(startDir)`：从调用目录向上递归探测项目标志（`.nexus` > `.git` > `package.json` > `CLAUDE.md`）。
  - 实现路径归一化 `canonicalizePath` 与确定性 Project ID 散列 `hashProjectId`，确保不同操作系统、盘符大小写或子目录下同一个项目的识别一致性。
- **`src/hook/nexus-hook.mjs`**
  - Hook 启动时自动解析项目归属，在向 daemon 请求 `/api/hook/check` 时透传 `project_id`、`project_root` 和 `workspace_dir`。
- **`src/storage/database.js`**
  - 新增 `projects` 基础登记表，并写入默认项目 `default`。
  - 所有协调表（`agents`、`intents`、`claims`、`leases`、`wait_queue`、`activity_log`、`state`、`messages`）新增 `project_id` 列与针对性复合索引，提供旧库幂等平滑升级。
- **`src/daemon/coordinator.js`**
  - 三级判冲（文件、模块路径重叠、符号）、意图申报与等待唤醒全面加入 `projectId` 作用域隔离，不同项目同名文件/符号互不干扰。
  - 租约释放时除唤醒等待者外，主动向总线派发带详细资源列表的 `resource:freed` 事件。
- **`src/domain/state.js` & `src/domain/messages.js`**
  - 共享状态树（CAS）与消息总线收件箱均按 `project_id` 实现严格隔离。
- **`src/domain/project-lead.js` & `src/domain/project-registry.js`** (新增)
  - 实现常驻项目的主架构师调度中枢（Project Lead）与实例池管理器。
  - 核心功能：进场申报（`onboard`）与计划咨询（`advisePlan`），自动提取冲突资源并生成无冲突的“安全施工走廊”与“任务避障重排建议”，免除被动拦截时模型的盲目重试。
  - 架构师计算设计为微秒级同步执行，同时预留通过 `llm-adapter.js` 接入长驻大模型增强建议的能力。
- **`src/mcp/server.js`**
  - 保持基础 5 个 MCP 工具（100% 同步执行与向后兼容），新增项目级调度工具：`nexus_onboard`、`nexus_advise_plan` 与 `nexus_report_milestone`。
- **`src/transport/rest.js` & `src/daemon/index.js`**
  - 增加 `/api/projects` 与 `/api/projects/:id/*` 路由组。
  - 增加 `/api/events`（Server-Sent Events 实时事件流通道），支持客户端按 `project_id` 进行订阅监听。
- **`src/cli.js`**
  - 新增 `nexus projects` 与 `nexus project [dir]` 命令，方便快速自检当前目录项目识别情况。
- **测试**
  - 新增 `test/project.test.js`（8 用例）、`test/project-scope.test.js`（7 用例）、`test/project-lead.test.js`（5 用例）、`test/notification.test.js`（3 用例）。测试用例总数扩充至 **158**，全部通过。

### 为什么

单项目多 Agent 并发的核心痛点是：纯串行等待极其低效，而并发写同一个文件又会撞车踩踏。如果仅在写文件的一瞬间粗暴报错阻断，Agent 会在缺少全局视野的情况下陷入盲目重试或任务中断。
本轮改造从第一性原理出发，确立了**“以项目为物理边界、在规划阶段由常驻 Lead 提前重排避障”**的最优解：让后进场的 Session 明确知晓“别人在写什么、自己先做哪些空闲模块”，实现全速并行。

### 验证

`npm test` → 158 tests / 158 pass / 0 fail。

---

## 2026-10-01 唤醒队列按可用性复核，不再是纯 FIFO

### 改了什么

- **`src/daemon/coordinator.js`**
  - 抽出 `findConflict(normalizedClaims, agentId, now)`，成为三级冲突判定的唯一实现。`declareIntent` 与释放时的复核走同一份代码，两条路径的判冲规则不会再各自漂移。
  - `releaseLease` 的选取逻辑换成"复核 + 按 claim 宽窄重排"：
    1. 候选取 `wait_queue` 全量，按 **claim 路径段数降序**重排——段数多 = 钻得深 = 要的范围小，窄的先过；
    2. 逐个复核该等待者此刻是否真的无冲突，仍冲突的**留在队列里**计入 `stillBlocked`，不唤醒；
    3. 第一个无冲突的出队并唤醒。
  - `releaseLease` 返回值新增 `stillBlocked`；`agent:woken` 事件新增 `verified: true`，表示选中时已复核过，agent 收到即可开工，不必再问一次。
- **`docs/ARCHITECTURE.md`**：新增"唤醒队列的选取"一节，写清为什么不用 FIFO、宽度怎么算。
- **`docs/API.md`**：释放接口的响应补 `stillBlocked`，`agent:woken` 补 `verified`。
- **`README.md`**：用例数 130 → 135。
- **`test/comprehensive.test.js`**：新增套件"唤醒队列按可用性复核并按 claim 宽窄重排"，3 个子用例。

### 为什么

纯 FIFO（`ORDER BY w.id`）有两个问题：等待期间资源可能已被别人抢走或继续被锁着，此时唤醒队首就是**白唤醒一轮**（它重新声明后仍然 WAITING）；而排在后面、此刻其实已经能拿到的等待者被饿着。

等待者的 claim 在入队时是留在 `claims` 表里的（只有租约过期或释放才删），所以释放时能直接复核，不必等对方再声明一次。

宽度必须按**语义**算，不能用 `LENGTH(claim_target)`：claim 存的是归一化后的绝对路径，长度被工作目录前缀和目录名长度主导。`pkg/other` 反而比 `src/network` 短，于是按长度排序完全错位。

### 两个踩过的坑

- **段数是"深度"不是"宽度"，方向极易写反。** 段数多 = 往下钻得深 = 要的范围小。升序排会把 `src/ab`（几乎和 `src` 一样宽）排在 `src/a/b/c/d`（只占一个叶子目录）前面，正好是最不该先放的那个。正确是**降序**。
- **测试重述了实现，所以恒绿。** 第一版测试直接断言排序 SQL 的中间量，和实现犯的是同一个错，两者互相抵消、全绿。已改为断言可观察行为（释放后谁被唤醒）。构造用例时也让"字符长度"与"路径段数"给出相反的顺序（`src/a/b` 42 字符 7 段 vs `src/zzz…` 69 字符 6 段），否则测不出排序是否真的生效。

### 验证

`npm test` → tests 135 / pass 135 / fail 0，连跑三轮稳定。

### 仍未解决

- `src/mcp/server.js` 只有工具定义，没有传输端点，daemon 未接入 MCP 传输，agent 目前无法真正发消息。
- `hook:install` 不写 `NEXUS_TOKEN`；装上 hook 但没有令牌时，所有写请求都会被 401。
- WebSocket 的广播对所有已连接的 agent 可见，没有按收件人隔离。