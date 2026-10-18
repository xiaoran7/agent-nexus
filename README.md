# Agent-Nexus

> ⚡ **多 AI 编程助手（Claude Code / Codex / Cursor）零负担并发防撞协调器与弹性高可用网关**
> 
> [English](README_EN.md) | [中文](README.md)

Agent-Nexus 专为解决多 Agent 并发写代码时的**文件互相覆盖、测试端口争抢、Git Worktree 跨工作树合并冲突**而设计。通过轻量全局 Hook 门禁、三级细粒度资源锁（File / Module / Symbol）与等待唤醒机制，实现**目标项目 0 改动、0 文件、0 污染**的静默防撞保护，并内置具备启发式错误归因与熔断冷却的弹性 AI 网关。

---

### 为什么需要 Agent-Nexus？(Problem & Solution)

- ❌ **痛点**：当你同时开启多个 Claude Code 或并发 Agent 会话时，它们缺乏全局感知，容易同时修改同一文件导致代码覆盖、抢占相同测试端口导致进程崩溃、或在不同 Git Worktree 中修改同一模块导致后续合并灾难。
-  **解法**：Agent-Nexus 在 Agent 写入底层拦截（PreToolUse），进行毫秒级冲突裁决；无冲突即秒级放行并锁定，遇冲突自动将后排 Agent 置入安全等待队列（Safe Corridor），前排完工或进程意外退出（PID 存活探测）时毫秒级唤醒，彻底告别盲目代码踩踏与无谓重试。

---

### 特性矩阵与方案对比 (Feature Matrix)

| 核心特性 / 维度 | 裸跑多个 Agent / 传统方式 | 传统重型分布式锁 | **Agent-Nexus** |
|---|---|---|---|
| **接入负担** | 零防护，频繁发生写覆盖与 Git 冲突 | 需要侵入业务代码，修改各 Agent 框架 | **全局 Hook 零负担接入，业务项目 0 改动、0 污染** |
| **冲突裁决粒度** | 依赖开发者人肉检查或 Git 冲突合并 | 粗粒度文件锁或整库排他 | **File / Module / Symbol 三级精准判定与宽窄重排** |
| **跨工作树支持** | 跨 Git Worktree 路径不一致，极易踩踏 | 完全不感知 Worktree 结构 | **自动基于主仓库共同根识别并相对化对齐 (`crewmates`)** |
| **异常恢复机制** | 崩溃或中断后死锁长久残留 | 必须苦等长 TTL 租约超时 | **进程 PID 级存活探测，崩溃意外退场立即自动释放** |
| **AI 请求弹性** | 遇到限流（429）或上游故障直接报错中断 | 需要额外配置繁重反向代理 | **内置 `Magpie` 网关，智能错误归因、熔断与动态退避** |
| **系统资源消耗** | - | 依赖 Redis / Docker / 复杂后台服务 | **纯原生 Node.js + 原生 `node:sqlite` WAL，常驻仅数兆内存** |

---

## 启动与验证

### 1. 免安装秒级启动 (npx 推荐)

```bash
# 无需克隆代码，直接单命令拉起协调中枢与实时面板
npx @xiaoran7/agent-nexus start

# 或者全局安装为系统 CLI
npm install -g @xiaoran7/agent-nexus
nexus start
```

### 2. 源码本地运行与二次开发

使用支持 `node:sqlite` 的 Node 环境（项目设计基线为 Node 24），从本目录执行：

```powershell
npm.cmd ci
npm.cmd start
npm.cmd test
```

### 桌面端常驻与 Windows 独立 EXE 打包

- **开发态桌面托盘启动**：`npm run desktop`（启动 Electron 桌面托盘常驻，自动探测/拉起后台服务并无感注入免密 Token）；
- **Windows 独立图标 EXE 打包**：`npm run package:win`（自动编译多分辨率青空微晶 `icon.ico`，打包为 Windows Standalone `Agent-Nexus.exe`，并遵循归档铁律归档至工作区 `Deliverables/Agent-Nexus/`）。

默认面板为 `http://127.0.0.1:4300`，端口可通过 `NEXUS_PORT` 修改；数据库使用 `NEXUS_DB_PATH` 或用户目录下 `.agent-nexus/nexus.db`，`NEXUS_DB_PATH` 的父目录不存在时会自动创建。必须用 `npm ci`（或 `npm install`）安装依赖后再启动：唯一运行时依赖是 `ws`，缺失时 daemon 会在 `src/transport/ws.js` 直接报 `ERR_MODULE_NOT_FOUND`。端口被占用时启动会失败并提示改用 `NEXUS_PORT`，不会带原始堆栈崩溃。

前端控制台支持 **三态视图切换**：
- **协同大屏（War Room）**：展示常驻架构师态势、活跃施工流水（带动态倒计时）、各助手持锁明细与实时事件时间线；
- **智能网关大屏（Magpie Gateway）**：可视化请求流转与 Cache 亲和分发，直观呈现各候选上游节点健康度、错误归因与熔断冷却倒计时，支持策略热切换与拨测控制台；
- **综合大屏（Unified）**：上下协同统览。

**零负担协同接入（Skill）**：
遵循**“绝不给业务项目产生任何一点负担”**原则。参考 `skills/nexus-setup/SKILL.md`：
- **目标项目 0 改动、0 文件、0 污染**：无需建 `.mcp.json`，无需改 `.gitignore`，严禁向项目 `AGENTS.md` 塞样板文本；
- **全局一次配置，全机项目受益**：宿主机安装全局 Hook 后，所有项目的并发会话自动享受写冲突拦截、Git 提交自动释放与跨 Worktree 对齐。

**启动需要令牌。** daemon 启动时打印一枚 operator 令牌（read + write + mint），只打印一次、不落盘，重启即轮换。除 `/health` 和面板 HTML 外，`/api/*` 与 WebSocket 缺令牌一律 401。换一枚绑定具体 agent 的令牌：

```bash
NEXUS_ADMIN_TOKEN=<启动时打印的令牌> node src/cli.js token <agent-id>
```

agent 令牌只能读自己的收件箱（读别人的 403），也不能签发令牌。身份以令牌为准，不采信请求体里的 `from`——那是调用方可控的字段，自称 `claude` 的陌生进程和真 Claude Code 无法区分。面板打开 `http://127.0.0.1:4300/?token=<你的令牌>`，令牌会存进 sessionStorage；WebSocket 令牌只能走查询参数，浏览器发不了自定义头。

测试用 `node --test` 跑 `test/**/*.test.js`，共 208 个用例：`comprehensive.test.js` 覆盖协调判冲、路径分段边界、等待队列的可用性复核与宽窄重排、共享状态与 CAS、消息总线、MCP 工具分发、核心状态机闭环与模块锁门禁拦截，`runner.test.js` 覆盖完整协调链路，`transport.test.js` 起真实 HTTP/WS 栈跑端到端、输入校验、认证与令牌隔离、跨源策略、Hook 载荷解析、安装器和启动失败处理，`project.test.js` 覆盖多层目录的项目边界探测、Git Worktree 共同根识别与路径归一化，`project-scope.test.js` 覆盖多项目资源与状态隔离，`project-lead.test.js` 覆盖 Project Lead 进场避障排期与 MCP 联动，`notification.test.js` 覆盖主动释放通知与 SSE 实时事件通道，`memory.test.js` 覆盖项目长期工程记忆引擎，`broadcast.test.js` 覆盖总指挥广播与信箱直达，`llm-adapter.test.js` 覆盖大模型适配器（Anthropic、OpenAI 与多候选组网），`gateway-router.test.js` 覆盖 Magpie 启发式错误分类、熔断冷却与多策略路由，`resource-lock.test.js` 覆盖 crewmates 命名资源锁申领、排他互斥与跨工作树相对化路径碰撞。测试不证明宿主工具已接入。

daemon 只监听本机，跨源请求默认不放行（浏览器不理会目标地址是否本机，任何网站都能读写你的协调库）。确需跨源时用 `NEXUS_ALLOWED_ORIGINS` 列出来源，逗号分隔；该变量按请求读取，改完无需重启。令牌与跨源白名单是两道独立的闸：白名单管"哪个网页"，令牌管"哪个进程"。

## 外部开源引用与上游溯源 (Open-Source Lineage)

本项目严格遵循开源溯源与模块化协作边界准则，关键架构机制吸收借鉴自成熟开源生态：

1. **`crewmates` ([asutekku/crewmates](https://github.com/asutekku/crewmates))**：
   - **负责模块**：Git Worktree 主仓库共同根识别（`resolveGitCommonRoot`）、跨工作树相对化路径碰撞检测（`toRepoRelativePath`）与排他性命名资源锁（`tests`, `dev-server`, `build` 等）。
   - **维护边界**：模块算法契约归属上游；遇相关碰撞异常或工作树识别缺陷，**优先拉取上游最新提交/Issue 对齐方案**，后考虑本地补丁。
2. **`Magpie` ([magpie-ai/magpie](https://github.com/magpie-ai/magpie))**：
   - **负责模块**：弹性高可用 AI 网关路由器（`src/domain/gateway-router.js`），包括启发式错误精准归因（`classifyFailure`）、熔断休眠与动态退避冷却（`resetsIn`）、以及基于项目亲和哈希（`smart`）的多候选无感故障转移。
   - **维护边界**：错误分类模式与重试状态机逻辑对齐上游设计。
3. **`agent-comm`**：
   - **负责模块**：命名空间共享状态管理与原子 CAS（`src/domain/state.js`）。

## 实现与限制

- `src/daemon/coordinator.js` 实现 file/module/symbol/resource claim、默认 300 秒租约与等待唤醒；输入非法（缺 `agent_id`、claim 目标为空或解析后落在工作目录/盘符根）时抛 `ValidationError`，REST 层映射为 400 且不落任何记录。
- `src/domain/project.js` 支持向上探测主工程与 Git Worktree，解析 `.git` 为文件的指针，统一主仓库与各工作树共享相同的 `projectId` 与 `projectRoot`。
- `src/domain/errors.js` 是调用方非法输入的唯一类型；协调、状态、消息三个入口共用它，transport 层统一映射成 400。
- `src/transport/auth.js` 负责令牌签发与校验。令牌只在运行中的 daemon 内存里，不落盘。
- `src/transport/` 提供 REST 和 WebSocket；`src/ui/` 提供面板。
- `src/mcp/stdio.js` 完整实现了标准 JSON-RPC 2.0 stdio MCP 传输端点（可通过 `nexus mcp` 启动），对外提供意图声明、资源互斥锁、长期记忆与 Project Lead 进场排期等 13 项工具。同时可通过 `nexus mcp:install` 一键无损注入工程根目录的 `.mcp.json`。
- Hook 按真实 PreToolUse 载荷解析写入目标：写入类工具取 `file_path`，Bash 从命令里解析重定向/tee/sed -i/cp/mv 的写入目标（按目的端判定，且必须落在工作目录内），并支持自动推导 `tests`、`dev-server`、`build` 等排他资源锁；只读工具不判冲。离线、超时或无法解析响应时放行，daemon 拒绝请求时拦截。**daemon 拒绝含 401/403 时同样拦截**：拿不到令牌就无法证明协调库知道这个文件，此时放行等于没检查。它不是操作系统文件锁或强制沙箱。
- Hook 从 `NEXUS_TOKEN` 读令牌。装到全局的 hook 不继承用户 shell 环境，这个变量得由宿主注入或写进安装器写下的配置——`hook:install` 目前不写它，这是接入前必须补的一步。
- `hook:install` 写的是 Claude Code 期望的 matcher 分组结构（已按官方文档核对），并会把历史的字符串写法就地升级；目标配置无法解析时直接报错，不会用空配置覆盖。安装文件存在仍不证明宿主真的会执行。
- WebSocket 广播仍是全员可见：令牌挡的是"谁能连上"，连上之后看到的是所有 agent 的时间线与状态变更。按连接区分推送范围没有做。

## 文档

- [API](docs/API.md)：REST、事件和工具处理函数。
- [架构](docs/ARCHITECTURE.md)：组件与租约状态机。
- [Hook](docs/HOOKS.md)：检查流程、安装副作用与接入验收。
