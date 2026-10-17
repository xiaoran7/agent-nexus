# Agent-Nexus 更新日志

本文件记录项目历史。契约类内容看 [docs/API.md](docs/API.md) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，启动方式看 [README.md](README.md)。

---

## 2026-10-17 修复 MCP Stdio 客户端 Token 热重试与自愈机制

### 改了什么

- **常驻 MCP 进程 Token 动态感知与 401 自动热重试 (`src/mcp/stdio.js`)**：
  - **根因消除**：过去 `startMcpStdio` 在进程初始化时静态读取一次 `session.token`，当 Nexus 守护进程重启生成新令牌后，常驻 MCP 仍持旧令牌导致请求报 `[Nexus 401]`；
  - **动态获取与无感重试**：封装 `getActiveToken` 动态函数，并在收到 401 时强制重读磁盘 `~/.agent-nexus/session.token` 自动热重试一次；
  - **测试与协同保障**：全量 230 项单元测试全部通过，保证跨 Session 协同与 MCP 工具调用平滑自愈。

---

## 2026-10-17 补齐 package-lock.json 恢复 GitHub Actions CI 干净构建

### 改了什么

- **对齐 package-lock.json 与 package.json (`package-lock.json`)**：
  - 同步补充 `electron`（^34.2.0）及其完整依赖树声明；
  - 修复 GitHub Actions 在 `npm ci` 阶段因 lockfile 缺少 electron 导致中断退出的问题；
  - 本地与远端 CI 干净构建与 230 个测试全部 100% 通过。

---

## 2026-10-17 默认端口避让迁移至 4300（彻底避开 AgentHub 4100）

### 改了什么

- **默认监听端口整体迁移至 4300 (`src/`, `desktop/`, `docs/`)**：
  - **避让 AgentHub 冲突**：由于 AgentHub 默认占用 `4100` 端口，Agent-Nexus 将全套系统默认端口从 `4100` 优雅迁移到 `4300`；
  - **全链路无感同步**：
    - 后台守护进程 `src/daemon/index.js` 与 CLI `src/cli.js` 默认监听 `4300`，会话凭据按 4300 判定；
    - 通用钩子 `src/hook/nexus-hook.mjs` 与 MCP Stdio `src/mcp/stdio.js` 默认直连 `4300`；
    - 桌面端托盘 `desktop/main.cjs` 与守护探测器 `desktop/daemon-runner.cjs` 默认探活 `4300`；
    - 前端控制台顶栏动态绑定 `window.location.host`，文档与安装器配置全面对齐 `4300`；
  - **全量测试通过**：230 个单元与集成测试全部 100% 通过。

---

## 2026-10-17 nexus-setup 零感自检闭环与全局 Skill 热同步

### 改了什么

- **nexus-setup 前置 3 秒快速判定门禁 (`skills/nexus-setup/SKILL.md`)**：
  - 新增“第 0 步：查验全局 Hook 判定”，强制 AI 在执行技能时优先检查 `~/.claude/settings.json` 是否已包含 `nexus-hook.mjs`；
  - 明确断言：若本机已安装全局 Hook，则全机所有业务项目早已处于全自动防护之下，AI 必须立即向用户汇报并结束流程，严禁往业务项目新建 `.mcp.json` 或修改 `.gitignore`，达成绝对零污染。
- **全局用户技能库无缝热同步 (`~/.claude/skills/nexus-setup/SKILL.md`)**：
  - 彻底清理覆盖全局遗留的旧版侵入式规则，实现项目源码与全机全局 Skill 100% 同步一致；
  - 系统技能描述同步更新为通俗自检说明，确保全机任意新开会话均遵循免配置零负担铁律。

---

## 2026-10-17 桌面端系统托盘常驻与功能演进拓扑图 (v0.2.6)

### 改了什么

- **现代卡片风与圆润大字体体系重构 (Modern Card & Rounded UI - `src/ui/`)**
  - **无死黑边框与全透光微渐变卡片 (`src/ui/style.css`)**：
    - 彻底告别传统深色死黑硬边框设计，全站改用通透柔和微晶磨砂玻璃卡片（`rgba(23, 32, 51, 0.65)`）配合细腻半透明高斯模糊；
    - 边框采用极细浅色光感边缘（`rgba(255, 255, 255, 0.08)`）配合多层柔和漫反射阴影（`0 12px 36px -8px rgba(0, 0, 0, 0.35)`），营造悬浮空间层次感；
  - **全面剔除 Emoji 与全量精细内嵌矢量 SVG 替换 (`src/ui/index.html`, `src/ui/app.js`, `src/ui/style.css`)**：
    - 彻底移除导航 Tab、看板指标、广播条、时间线徽章、拓扑大屏、Agent 详情卡片和空状态等各处的系统 Emoji；
    - 统一换装高质感现代线条式 SVG 图标（如协同看板网格、拓扑连通图分支、广播天线、网络网关、记忆芯片、对勾校验等），在各种 DPI 下锐利一致；
  - **圆润大号字体系统与现代组件规范 (`src/ui/style.css`)**：
    - 采用现代大号圆润字族栈（`'Plus Jakarta Sans'`, `-apple-system`, `Quicksand`, `PingFang SC`）；正文字号提升至 15px，核心度量提升至 32px，大圆角体系（14px / 18px / 24px / 9999px 胶囊）；
    - 胶囊型药丸切换器、微光点状呼吸灯、磨砂半透明输入框与通透投影按键全面落地，保持 60 FPS 无卡顿流畅渲染。
- **桌面端系统托盘常驻与 Daemon 托管绑定 (Desktop Tray & Daemon Binding - `desktop/`)**
  - **基于 Electron 的无感桌面端封装 (`desktop/main.cjs`, `desktop/daemon-runner.cjs`, `desktop/preload.cjs`)**：
    - **系统单实例锁 (`app.requestSingleInstanceLock`)**：多开应用时自动唤醒并激活已有窗口，防止多实例冲突；
    - **右下角系统托盘常驻与右键菜单**：支持“显示协同控制台”、“查看演进拓扑”、“在系统浏览器中打开”、“退出”等核心操作；双击托盘图标随叫随到，点击窗口右上角“X”拦截关闭并平滑最小化至系统托盘，保证后台协同防碰撞持续生效；
    - **智能 Daemon 生命期托管与探活**：启动时自动探活 `127.0.0.1:4300/health`，若已有外部 Daemon 进程运行则无缝连接复用；若未启动则自动拉起托管子进程并在退出时优雅停机；
    - **无感令牌注入**：主进程自动读取 `~/.agent-nexus/session.token` 并透明附加至前端加载 URL，开发者无需输入密码或配置令牌；
    - **动态状态气泡与指示图标 (`desktop/assets/`)**：每 3 秒自动轮询协同状态，动态切换托盘图标与状态提示（绿色=待命就绪、蓝色=施工中、橙色=冲突排队等待中）。
- **按时间顺序的功能开发与问题解决拓扑图 (Changelog & Topology DAG)**
  - **数据层持久化 (`src/storage/database.js`)**：
    - 新建 `topology_nodes` 表及关联索引（`idx_topology_project_created`, `idx_topology_agent`, `idx_topology_intent`），记录演进节点类型（`milestone` / `completed` / `handoff` / `unblocked`）、功能标题、解决问题描述、触达文件快照（`claims_snapshot`）、前驱节点列表（`parent_node_ids`）与因果类型；
    - 数据库启动时自动执行热升级平滑建表，向后完全兼容。
  - **拓扑领域服务与因果推断 (`src/domain/topology.js`)**：
    - 实现 `TopologyService`，提供 `recordNode` 与 `getTopologyGraph` 方法；
    - 支持前驱节点自动推导（无显式挂接时自动按时间序追溯上一节点）、支持交接与解锁因果边生成，保障项目级隔离。
  - **业务层自动沉淀与因果闭环 (`src/domain/project-lead.js`, `src/daemon/coordinator.js`)**：
    - 在 `reportMilestone` 处自动将结构化里程碑录入演进图谱；
    - 在租约释放（`releaseLease` / `releaseAgentLeases`，含 Git Commit 自动释放）时，捕获任务意图与触及文件快照，自动沉淀为 `completed` 拓扑节点。
  - **REST API 与实时 WebSocket 广播 (`src/transport/rest.js`, `src/transport/ws.js`)**：
    - 暴露 `GET /api/topology` 接口（支持 `project_id`、`limit`、`since` 过滤）；
    - WebSocket 实时监听 `topology:node_created` 并向所有连接客户端实时推送。
  - **Aozora UI 纯原生 SVG 拓扑大屏渲染 (`src/ui/index.html`, `src/ui/style.css`, `src/ui/app.js`)**：
    - 顶部导航新增“演进拓扑 (Topology)”标签页；
    - 采用纯原生 SVG 三次贝塞尔曲线（`<path d="M... C...">`）绘制因果依赖流动边，具备发光流动微动画与青空设计规范透光卡片；
    - 每个节点清晰展示：产生时间、执行 Agent 代号、解决的问题/功能标题、涉及文件胶囊标签；
    - 交互体验增强：支持搜索关键词高亮过滤、鼠标悬浮因果链路穿透高亮（自动点亮所有祖先和后继节点与连线，淡化无关节点）。
- **自动化测试闭环 (`test/topology.test.js`, `test/desktop-runner.test.js`)**
  - 新增拓扑节点记录、因果图生成、项目隔离、Daemon 探活与 Token 读取等专项测试；
  - 全套 230 个测试用例保持 100% 绿色通过。

---

## 2026-10-17 控制台界面全面人话化汉化与 Hook 写入正则误伤修复 (v0.2.5)

### 改了什么

- **控制台界面全面人话化汉化 (Plain-Language Localization & De-geekification)**
  - **彻底去除技术黑话与生硬英文 (`src/ui/index.html`, `src/ui/app.js`)**：
    - 顶栏与品牌："WAR ROOM" 改为 "协同大屏"，"Master Orchestration Core" 改为 "多会话防撞车中枢"，"Project Memory" 改为 "项目备忘录"，"Sensei Active" 改为 "调度服务在线"；
    - 统计卡片："Active Agents" 改为 "在线 AI 助手"，"Running Leases" 改为 "正在改文件的助手"，"Waiting in Queue" 改为 "排队等待中"，"Project Memories" 改为 "已记录备忘"；
    - 施工流水："Construction Lanes" 改为 "正在修改的文件与交接流水"，"[Exclusive Lock]" 改为 "[独占修改中]"，"TTL: Xs" 改为 "倒计时: Xs"，"(No queue backlog)" 改为 "(无其他助手排队)"；
    - 状态矩阵："Agent Matrix & Claims" 改为 "各助手施工状态与持锁明细"，意图与进度展示人话化，助手状态精确映射为 "正在改文件"、"排队等待中"、"空闲就绪"、"已离开"；
    - 架构师视窗："Embedded AI Tech Lead" 改为 "常驻架构师协同视窗"，"OBSERVING (SILENT SPRINT)" 改为 "静默守望（单人施工不打扰）"，"AWAKENED" 改为 "已唤醒（多会话协同避障）"；
    - 模型网关大屏："Magpie Elastic Gateway Router" 改为 "多模型弹性智能网关"，分发策略、健康状态（"全部正常运行"、"部分节点避让中"、"全部休眠中"）、可用模型池与实时拨测控制台全链路人话化，Demo 轨迹输出完全本地化。
- **Skill 零负担重构与项目零污染准则 (`skills/nexus-setup/SKILL.md`, `README.md`)**
  - **确立“绝不给业务项目产生任何一点负担”最高准则**：彻底废除过去要求业务项目修改 `.gitignore`、并在 `AGENTS.md` 强塞样板规章的侵入式做法；
  - **主推全局零感静默防护**：开发机全局只装一次 Hook，所有业务项目无需创建任何文件、无需改动任何配置、无任何 Git 痕迹，零侵入享受文件防撞车、Git 提交自动释放与跨 Worktree 对齐；
  - **接入说明通俗人话化**：剔除学术黑话，清晰说明常见问题与防撞机制。
- **通用 Hook 写入正则误伤修复 (`src/hook/nexus-hook.mjs`)**
  - **排除箭头函数与比较符**：修复 `WRITE_COMMAND_RE` 正则表达式因误把 `=>`（ES6 箭头函数）、`->`（指针语法）中的 `>` 当作重定向符号而错误阻断 Node 代码执行与 Bash 检查的缺陷；
  - **后台启动父目录自动创建与令牌隔离 (`src/daemon/index.js`, `test/helpers.js`)**：在持久化当前活动 `session.token` 时自动检查并递归创建 `.agent-nexus` 目录，杜绝全新环境因目录缺失而静默丢失令牌；新增 `writeSessionToken` 守卫参数，并在 Node 测试环境感知（`isTest || NODE_TEST_CONTEXT`）下禁止改写或销毁用户当前会话的 `session.token`，避免自动化测试影响开发者正在使用的活跃 Hook 门禁；
  - **自动化测试断言健壮性优化 (`test/mcp-stdio.test.js`, `test/notification.test.js`)**：在 MCP Stdio 测试中采用动态轮询条件 `waitForCount` 替代脆弱的固定等待 `setTimeout`，避免高并发测试调度下 0 !== 1 误报；同步放宽监控大屏页面标题断言以兼容全面汉化后的中文标题。

---

## 2026-10-17 生产级并发协同优化：生命周期零感释放、大文件锚点锁与高信息诊断 (v0.2.4)

### 改了什么

- **生命周期零感自动释放 (Zero-Touch Auto-Release on Git Commit / Push)**
  - **Hook 态生命周期命令捕获 (`src/hook/nexus-hook.mjs`)**：在 Claude Code `PreToolUse` Hook 中精准嗅探 `git commit` 与 `git push` 命令，一旦当前施工单元完成提交或推送，立即触发零感批量释放，无需等待 5 分钟 TTL 超时或人工干预；
  - **批量租约释放与连锁唤醒 (`src/daemon/coordinator.js`)**：新增 `releaseAgentLeases({ agentId, projectId, reason, scope })`，一次性解除持有的全部独占文件锁与排他命名资源锁，自动将意图转为 `completed`，重新同步 Agent 闲置状态，并驱动等待队列首位候选者复核唤醒；
  - **REST 端点直通 (`src/transport/rest.js`)**：新增 `POST /api/hook/git-release` 与 `POST /api/leases/release-agent`，无缝联动 Hook 通道与外部自动化脚本。
- **大文件局部锚点锁 (#anchor Granular File Locking)**
  - **锚点语法解析与校验 (`src/daemon/coordinator.js`)**：支持形如 `path/to/file.ext#anchor-name` 的区域锁声明（如 `admin.html#header-nav` 与 `admin.html#traffic-stream`）；
  - **安全并发区间仲裁**：当两个 Agent 操作同一文件但声明不同非空 `#anchor` 时，判定为安全并发施工；若任一方未声明 anchor（全文件排他锁）或双方声明相同 anchor，则严格互斥拦截；
  - **模块锁全包围兼容**：父级目录/模块锁依旧完全覆盖子文件的全部 anchor 锚点，守住目录级重构底线。
- **高信息密度冲突拦截诊断与避障指引 (Enriched Conflict Diagnostics & Actionable Advice)**
  - **丰富冲突元数据抽取 (`src/daemon/coordinator.js`)**：在冲突拦截返回中补全锁定者详情、持有者工作区路径（`holderWorkspace`）、租约到期时间戳与剩余预估秒数（`remainingSec`）；
  - **格式化诊断卡片输出 (`src/hook/nexus-hook.mjs`)**：在 exit code 2 阻断时输出结构化诊断控制台卡片，明确告知剩余 ETA、对方所在工作树（跨 Worktree 警示），并给出具体的并行工作建议（先读代码、施工其他解耦模块、或等待对方 git commit 触发释放）。
- **持久化唤醒通知与端到端传输对齐 (Durable Waiter Notifications & Transport Parity)**
  - **消息表持久化落地 (`src/daemon/coordinator.js`, `src/daemon/index.js`, `test/helpers.js`)**：当 Coordinator 唤醒排队等待者时，除了派发 `agent:woken` 广播，自动向 `messages` 表落盘一条类型为 `handoff`、重要度为 `urgent` 的未读唤醒通知，确保通过 `nexus_dialogue_read` 轮询的会话绝对不漏通知；
  - **传输总线事件对齐 (`src/transport/ws.js`, `src/transport/rest.js`)**：WS 与 SSE 完整同步 `resource:freed`、`lead:awakened`、`agent:progress`、`messages:read` 事件广播，彻底消除多端异构事件丢失。
- **自动化测试闭环 (`test/optimizations.test.js`)**
  - 新增 5 项生产级优化专项测试，全面覆盖 Git 提交释放、大文件局部锚点并发与互斥、冲突拦截诊断卡片、持久化唤醒信箱及 REST 端点集成；
  - 全套 221 项自动化测试 100% 绿色通过，零回归。

---

## 2026-10-16 内嵌项目级常驻架构师 (Tech Lead) 唤醒规划与 Session 间结构化对话网络 (v0.2.3)

### 改了什么

- **内嵌项目级常驻架构师（Tech Lead）非侵入静默与多 Session 唤醒机制 (`src/domain/project-lead.js`)**
  - **非侵入静默保驾（Solo Sprint / OBSERVING）**：当项目内仅有单 Session（如 Session A）独立施工时，架构师保持静默观察态，绝不盲目插手打扰单会话自主开发，给出安全施工与全速前进指引。
  - **多 Session 动态唤醒与避障重排（Multi-Session Arbitration / AWAKENED）**：当 Session A 施工未完、新会话 Session B 进场申报计划时，架构师自动唤醒并派发 `lead:awakened` 事件。
  - **施工现场与进度画像深度聚合（"A 已经干了多少"）**：
    - 采集在席会话声明的意图（`current_intent`）、锁定的独占资源与租约剩余秒数（`heldClaims` / `activeLeasesCount`）；
    - 聚合在席会话达成的阶段性里程碑（`project_memories` 中 `category='milestone'`）与活动流水（`activity_log`）；
    - 读取在席会话实时申报的施工进度摘要（`progress_summary`）。
  - **两级路线规划与避障重排建议**：
    - 确定性基线（Ground Truth）：精确切分可立即施工的安全走廊（`safeToStart`）与必须等待交接的重叠冲突模块（`mustWait`）；
    - 智能架构师指导建议（LLM 增强 + 规则保底）：向 Session B 明确说明在席 Session A 当前干了多少、何时预估交接，并给出先写独立接口/周边单测/Mock 解耦的工程重排建议。
- **Session 间结构化对话网络与已读状态追踪 (`src/domain/messages.js`, `src/storage/database.js`)**
  - **数据库 Schema 迁移升级**：
    - `agents` 表新增 `current_intent TEXT` 与 `progress_summary TEXT`；
    - `messages` 表新增 `thread_id TEXT`、`reply_to_id INTEGER`、`status TEXT ('unread'|'read')` 与 `dialogue_type TEXT ('chat'|'query'|'response'|'handoff'|'milestone')`；
    - 增设 `idx_messages_thread` 与 `idx_messages_status` 索引，并平滑支持历史旧库迁移。
  - **跨 Session 结构化对话（Inter-Session Dialogue）**：
    - `sendDialogue` / `send`：支持话题线程（Thread）绑定、引用回复（Reply-To）与多种会话类型；
    - `readDialogue`：支持按 Session、Thread、未读过滤读取，并提供自动标记已读与 `messages:read` 事件总线广播；
    - `getThread`：按时间序完整追踪特定技术讨论流；
    - `reportProgress`：支持 Session 随时上报阶段进展并同步更新架构师画像。
- **MCP 工具与 Transport 接口扩展 (`src/mcp/server.js`, `src/mcp/stdio.js`, `src/transport/rest.js`, `src/transport/ws.js`)**
  - **新增与强化 MCP 工具**：
    - `nexus_onboard` / `nexus_advise_plan`：自动触发架构师全景抽取与重排指引；
    - `nexus_report_progress`：随时上报 Session 当前已完成进度与下一阶段诉求；
    - `nexus_dialogue_send`：跨 Session 发起问答、交接说明与技术沟通；
    - `nexus_dialogue_read`：拉取定向未读消息并自动标记已读；
    - `stdio.js` 补齐 MCP Stdio 对 `nexus_lock_resource`、`nexus_unlock_resource` 及对话类工具的直通支持。
  - **REST API 端点增设**：
    - `POST /api/projects/:id/progress`：上报 Session 进度画像；
    - `POST /api/projects/:id/dialogue`：跨会话发送结构化消息；
    - `GET /api/projects/:id/dialogue`：读取会话与 Thread 对答。
  - **WebSocket / SSE 实时广播**：
    - 广播 `lead:awakened`、`agent:progress`、`messages:read`。
- **War Room 架构师可视化工作台与对话视窗 (`src/ui/index.html`, `src/ui/style.css`, `src/ui/app.js`)**
  - **Tech Lead 架构师实况控制台**：动态展示当前架构师状态芯片（`STANDBY`、`OBSERVING` 静默保驾、`AWAKENED` 实时唤醒），并卡片式呈现各 Session 施工实况、进度摘要与避障指引。
  - **Inter-Session 对话抽屉**：实时滚动呈现各 Session 间 Technical Thread、交接通知与双向问答，支持人类 Sensei 与 Agent 跨会话透明协同。
- **自动化测试闭环**
  - 新增 `test/architect-awakening.test.js`：覆盖单 Session 静默保驾、进度汇报与多 Session 并发唤醒避障重排全流程；
  - 新增 `test/inter-session-dialogue.test.js`：覆盖跨会话提问、Thread 继承、未读过滤与已读状态流转；
  - 全套 217 项自动化单测全部通过。

---

## 2026-10-16 Magpie 弹性 AI 网关可视化调度大屏落地与项目级初始化 Skill (nexus-setup) (v0.2.2)

### 改了什么

- **Magpie 弹性 AI 网关可视化调度大屏落地 (`src/ui/index.html`, `src/ui/style.css`, `src/ui/app.js`, `src/transport/rest.js`)**
  - **三态视图切换系统**：在 Header 顶部引入平滑三态 View 切换 Tab（`War Room` / `Magpie Gateway` / `Unified`），支持多 Agent 协同施工泳道与 AI 网关拓扑按需或统揽查看。
  - **策略动态热切换 REST 端点 (`POST /api/gateway/strategy`)**：支持前端控制台毫秒级热切换 4 种路由策略（`smart` 缓存亲和、`ordered` 瀑布流、`rotate` 轮询、`least-used` 最小负载），并实施非法参数校验拦截（HTTP 400）。
  - **Visual Dispatch Pipeline Topology（调度拓扑画布）**：直观可视化 Agent Request ➔ 亲和哈希 ➔ Magpie Core ➔ 上游候选集群通道 ➔ 弹性容灾输出的全链路动态流动，采用 `will-change: transform; transform: translateZ(0);` 启用独立 GPU 合成层，严格遵守 60 FPS 性能铁律与 Aozora UI 玻璃拟态设计。
  - **Upstream Candidate Pool Grid（候选节点断路器网格）**：动态渲染各候选节点优先级、权重、调用量、成功率、最后时延与连续失败数；集成启发式 7 类错误分类药丸（`rate`、`credit`、`quota`、`server`、`timeout`、`auth`、`other`）与动态冷却休眠倒计时条。
  - **交互式运维控制**：支持一键全局解除熔断（Reset All / Unrest）与单节点独立解除休眠；支持一键载入双通道演练拓扑（Demo Mode）。
  - **Live Route Dispatch Console（实时拨测控制台）**：提供控制台实时向网关路由发起测试请求，高亮打印路由走向、故障转移轨迹（Failover Traces）、响应时延与回复正文。
- **项目级初始化 Skill (`nexus-setup`) 权威落地 (`skills/nexus-setup/SKILL.md`)**
  - **标准化六步工程接入流水线**：以当前工程目录为上下文，提供环境检测、Git Worktree 共同根识别、项目级 `.mcp.json` 无损智能合并（与 AOCI 和谐共存）、PreToolUse 物理拦截 Hook 治理、`.gitignore` 零污染对齐与 `AGENTS.md` 协同纪律注入。
  - **双端同步分发**：在仓库内受控归档 `skills/nexus-setup/SKILL.md`，并同步部署至本机 Claude Code 全局 Skill 目录 `C:\Users\tanner\.claude\skills\nexus-setup\SKILL.md`，任意目标项目均可通过 `/nexus-setup` 一键接入。
- **测试与文档闭环**
  - 在 `test/gateway-router.test.js` 中补齐 `POST /api/gateway/strategy` 成功切换与非法拦截单测断言；全套 208 项单测全部通过。
  - 更新 `README.md` 与 `docs/API.md`，对齐网关策略接口与可视化大屏事实。

---

## 2026-10-16 借鉴 crewmates 吸收跨工作树路径对齐与排他命名资源锁 (v0.2.1)

### 改了什么

- **Git Worktree 共同根识别与跨工作树相对化对齐 (`src/domain/project.js`, `src/daemon/coordinator.js`)**
  - **Git 共同根探测 (`resolveGitCommonRoot`)**：针对 Git Worktree 下 `.git` 为指针文件的形态，自动解析 `gitdir` 与 `commondir`，向上追溯至主仓库 `.git`，确保主仓库与各工作树共享同一个 `projectId` 与 `projectRoot`，消除多工作树环境下的项目视界隔离。
  - **跨工作树路径映射 (`toRepoRelativePath`, `toComparablePath`)**：将各工作树内的绝对物理路径统一映射到相对于 `projectRoot` 的规范相对路径进行冲突比对；当检测到并发修改来自不同工作树时，显式标记 `CROSS-WORKTREE CONFLICT` 高危警示，提醒并发修改将引发 Git 合并冲突。
  - **Linux/POSIX 大小写敏感与 Windows 盘符跨平台兼容加固**：
    - 修复 `canonicalizePath` 在 Linux 下全局小写化导致真实大小写敏感路径 `ENOENT` 的严重缺陷，改为仅在 Windows（`win32`）或显式盘符特征下小写化，Linux 下严格保留物理真实大小写；
    - 修复在 Linux 环境下对携带 Windows 盘符的虚拟/跨平台绝对路径误调用 POSIX `path.resolve` 导致前缀拼接 cwd 与工作树无法映射的问题（引入 `isPathAbsolute` 与 `resolveCrossPath`/`resolveSafe`）；
    - 全面修复 GitHub Actions CI (Ubuntu) 构建与测试。
- **命令级排他性命名资源锁 (`src/daemon/coordinator.js`, `src/transport/rest.js`, `src/mcp/server.js`)**
  - **扩展 `CLAIM_TYPES` 支持 `resource` 类型**：针对测试套件（`tests`）、本地开发服务（`dev-server`）、打包构建（`build`）等系统级排他性共享资源实施排他性租约互斥，阻断端口争用与测试状态污染。
  - **核心协调层方法**：提供 `acquireResourceLock`、`releaseResourceLock` 和 `listResourceLocks`；在四级冲突判定（`findConflict`）中增加 Rule 4 资源互斥规则。
  - **REST API 与 MCP 工具暴露**：
    - REST 端点：`GET /api/resources/locks`、`POST /api/resources/lock`、`POST /api/resources/unlock`；
    - MCP 工具：在 `NEXUS_PROJECT_TOOLS` 中暴露 `nexus_lock_resource` 与 `nexus_unlock_resource`。
- **Hook 命令自动推导与无感加锁 (`src/hook/nexus-hook.mjs`)**
  - **Bash 命令特征提取 (`extractBashResource`)**：正则匹配 `npm test`、`cargo test`、`vite`、`npm run build` 等高排他命令，在 Agent 未显式声明的情况下自动在 `/api/hook/check` 阶段申请或检查资源锁，冲突时以退出码 2 安全拦截。
  - **Fail-Open 稳健降级**：当协调感知层发生非预期异常或网络波动时透明放行，杜绝阻塞主干工作流。
- **自动化测试闭环**
  - **新增 `test/resource-lock.test.js`**：全面覆盖资源锁申领、排他互斥、锁列举、释放再领、Bash 命令推导判冲、跨工作树相对路径碰撞与 MCP 工具调用。
  - **更新 `test/project.test.js`**：补充 Git Worktree 识别主仓库与工作树共享同一个 `projectId` 及跨工作树路径计算用例。
  - 全量自动化测试套件扩增至 208 项用例，100% 通过。
- **文档体系洁癖级对齐与开源溯源规范化 (Docs & Architecture Alignment)**
  - **`README.md`**：对齐 208 项全量单测事实；纠正 MCP 接入状态陈述（补充 `src/mcp/stdio.js` 真实实现与 13 项核心工具）；新增“外部开源引用与上游溯源”章节，明确标明 `crewmates`、`Magpie` 与 `agent-comm` 的模块职责与故障排查第一准则（先拉上游后自修）。
  - **`docs/ARCHITECTURE.md`**：扩充确定性冲突判决算法至四级（加入 Rule 4 资源互斥）；详述 Git Worktree 共同根识别与相对化对齐机制；新增开源生态上游溯源表格。
  - **`docs/API.md`**：增补命名资源锁 REST 端点（`GET /api/resources/locks`, `POST /api/resources/lock`, `POST /api/resources/unlock`）、`claims[].type` 资源规范及 13 项 MCP 工具完整清单。
  - **`docs/HOOKS.md`**：补充 Bash 命令自动推导 `tests`/`dev-server`/`build` 资源锁特征提取与跨工作树阻断逻辑。
  - **`AGENTS.md`**：写入开源项目引用留痕与上游溯源铁律（2.6）。

---

## 2026-10-16 借鉴 Magpie 架构落地弹性高可用 AI 网关路由层 (v0.2.0)

### 改了什么

- **借鉴 Magpie 的弹性高可用网关路由器 (`src/domain/gateway-router.js`)**
  - **精准语义级错误归因 (`classifyFailure`)**：从 HTTP 状态码、响应标头与响应体内容，启发式精准归因 7 类异常：`credit`（欠费/余额耗尽）、`quota`（周期用量限额）、`rate`（突发高频限流）、`server`（上游 5xx/529 故障）、`timeout`（超时中断）、`auth`（密钥失效）与 `other`。
  - **熔断与动态冷却机制 (`resetsIn`, `Candidate.recordFailure`)**：提取 `Retry-After`、Anthropic 与 OpenAI 标准重置时间戳；针对 5xx 服务端错误实施基于连续失败次数的指数退避；故障节点自动进入休眠冷却（`restingUntil`），后续请求 0 延时自动跳过故障节点，彻底解决高频撞墙超时痛点。
  - **多策略分发算法**：
    - `smart`（默认）：缓存亲和性优先，基于 `affinityKey`（如项目 ID）哈希确定性绑定主选节点，最大化命中上游 Prompt Cache；
    - `ordered`：按优先级严格执行主备瀑布流；
    - `rotate`：多 Key 轮询负载分发；
    - `least-used`：基于请求数与权重的平滑负载均衡。
  - **无感故障转移调用 (`routeAndExecute`)**：候选节点遇错自动透明切入下一候选节点，并在成功时回传完整溯源与时延数据。
- **大模型适配层扩展与多候选自组网 (`src/domain/llm-adapter.js`)**
  - **`OpenAiAdapter`**：支持标准 OpenAI Chat Completions 协议（兼容 DeepSeek、Ollama、Groq 等），支持 Bearer 鉴权与地址规范化 `formatOpenAiUrl`。
  - **`GatewayRouterAdapter`**：将 `GatewayRouter` 无损适配为 `LlmAdapter`，与上层 `ProjectLead` 确定性规则引擎 100% 兼容。
  - **多候选自动组网 (`parseLlmConfig`)**：若同时提供 Anthropic 与 OpenAI 凭证，自动组装双通道主备故障转移链；支持通过 `NEXUS_GATEWAY_CANDIDATES` 传入 JSON 自定义多模型节点拓扑。
- **Tech Lead 架构师调度与缓存亲和优化 (`src/domain/project-lead.js`, `src/domain/project-registry.js`)**
  - `ProjectRegistry` 启动时自适应挂载全局 `GatewayRouter`；
  - `ProjectLead` 调度进场建议时携带 `{ affinityKey: this.projectId }`，同项目稳定复用同一模型与节点。
- **运维与代理 REST 端点 (`src/transport/rest.js`)**
  - `GET /api/gateway/route` / `GET /api/gateway/status`：输出各候选节点的健康度、熔断倒计时、成功率与时延统计；
  - `POST /api/gateway/chat`：提供通用多模型自动故障转移代理通道；
  - `POST /api/gateway/reset`：提供运维一键解除指定节点或全部节点熔断休眠通道（Unrest）。
- **自动化测试套件扩建**
  - **新增 `test/gateway-router.test.js`**：覆盖 7 类错误精准分类、限流标头与指数退避解析、Candidate 状态机、4 种路由策略、透明故障转移与熔断休眠、REST 端点端到端测试。
  - **扩展 `test/llm-adapter.test.js`**：增加 `OpenAiAdapter` 协议解析、`GatewayRouterAdapter` 包装与多候选环境变量组网用例。
  - 全量自动化测试套件扩增至 198 项用例，100% 通过。

---

## 2026-10-15 项目级 MCP 注入架构实现、stdio JSON-RPC 传输与试点项目落地

### 改了什么

- **对齐 AOCI 架构的项目级 MCP 自动化注入 (`src/installer/index.js`)**
  - **`installProjectMcp(targetProjectDir)`**：实现无损智能合并算法，读取目标工程根目录的 `.mcp.json`；若已有 `aoci` 等其他服务配置，完整保留既有节点，精准注入 `mcpServers.nexus` 节点；支持完全幂等重复安装。
  - **CLI 子命令扩展 (`src/cli.js`)**：
    - 新增 `nexus mcp:install [dir]`：为指定项目一键配置 `.mcp.json`；
    - 新增 `nexus mcp [--project <path>]`：以标准 stdio JSON-RPC 模式运行项目级 MCP 协调服务。
- **MCP Stdio JSON-RPC 2.0 传输协议栈 (`src/mcp/stdio.js`)**
  - **协议握手闭环**：完整实现 `initialize`（规范版本 `2024-11-05`）、`notifications/initialized`、`ping`、`tools/list` 与 `tools/call`。
  - **全量工具暴露与路由映射**：对外提供 11 项核心协调与记忆工具，包括 `nexus_onboard`、`nexus_advise_plan`、`nexus_declare_intent`、`nexus_release_lease`、`nexus_report_milestone`、`nexus_search_memory`、`nexus_save_memory`、`nexus_broadcast`、`nexus_status`、`nexus_state`、`nexus_message`。
  - **免配置上下文智能推断**：自动识别绑定当前工程根目录与 Project ID，推导当前会话 Agent 身份（适配 Claude Code、Codex 会话环境变量），大幅降低 Agent 进场心智负担。
- **无感凭证穿透机制 (`src/transport/auth.js`, `src/daemon/index.js`, `src/hook/nexus-hook.mjs`)**
  - **会话活动凭据文件 (`session.token`)**：Daemon 启动时自动将当前活动操作者凭证安全写入 `~/.agent-nexus/session.token`（`0600` 权限），在正常关停时自动销毁清理。
  - **链路自动拾取**：Hook、CLI 与 Stdio MCP 进程按 `NEXUS_TOKEN` -> `NEXUS_ADMIN_TOKEN` -> `readSessionToken()` 顺序自适应读取凭证，消除必须手动导出环境变量的摩擦。
- **工具链扩充与对齐 (`src/mcp/server.js`)**
  - 在 `NEXUS_PROJECT_TOOLS` 中补齐 `nexus_search_memory`、`nexus_save_memory` 与 `nexus_broadcast` 定义，在 `handleMcpTool` 中打通项目工程记忆的持久化存储与检索。
- **单测套件与试点工程落地**
  - **新增 `test/mcp-install.test.js`**：覆盖空白项目创建、已有 AOCI 配置合并、幂等性等用例。
  - **新增 `test/mcp-stdio.test.js`**：覆盖 JSON-RPC 2.0 握手、工具发现、记忆存取调用、冲突申报走廊端到端调用。
  - **试点工程落地 (`openrouter-monitor`)**：对 `D:/Claudespace/Project/openrouter-monitor` 实施 `mcp:install`，成功实现 `aoci`（代码全局认知）与 `nexus`（多 Agent 并发与长期记忆）在同一 `.mcp.json` 中和谐共存。

---

## 2026-10-12 AOCI 本地认知资产 Git 边界治理与解挂清洗

### 改了什么

- **Git 仓库零污染与 AOCI 纯本地化隐形隔离**
  - **规范 `.gitignore` 规则**：根据 `aoci-setup` 铁律，全面补齐 AOCI 全量本地认知资产与索引忽略规则（`aoci.*`、`.aoci/`、`.mcp.json`、`AGENTS.md.backup.*`）、本地 Agent 垫片与私有配置（`AGENT.md`、`agent.md`、`*.local.md`、`CLAUDE.local.md`、`AGENTS.local.md`）及 Claude 本地运行态（`.claude/worktrees/`、`.claude/settings.local.json`、`.claude/scheduled_tasks.json`）。
  - **历史追踪无损清洗**：使用 `git rm --cached -r` 从 Git 索引中解挂误追踪的 AOCI 本地认知资产（`.aoci/`、`aoci.*`）与 Agent 垫片（`AGENT.md`），确保本地物理文件完好无损，远端 Git 仓库零污染。
  - **开源零泄密审查**：验证项目无私有敏感 IP、内部域名或凭据泄露，满足开源纯净交付标准。

---

## 2026-10-06 AOCI-CODE 全局认知架构与 MCP 治理接入

### 改了什么

- **AOCI-CODE 项目初始化与基线建立**
  - 执行 `aoci init` 标准工程流水线（`--locale zh-CN --agent claude --hooks`），生成认知架构骨架资产 `aoci.txt`、`aoci.meta.txt` 与 `aoci.code.txt`。
  - 自动生成 `.gitattributes`（规范跨平台检出 LF 行尾）与 `.aoci/` 认知治理配置基线（`config.json`、`baseline.json`）。
  - 在 `AGENTS.md` 中追加 AOCI 规范区块，声明模型认知闭环与维护纪律。
  - 安装 PreToolUse 守卫脚本至 `.aoci/hooks/claude-pretool.sh`，并在 `.claude/settings.json` 中注册对 `Edit|Write|MultiEdit` 的前置拦截保护。
  - 在 `.gitignore` 中完善对 `.mcp.json` 与 `.claude/settings.json` 等宿主机环境绝对路径配置的隔离忽略。
  - 运行 `aoci scan` 建立项目全量 52 个文件基线，完成 `aoci verify` 结构合法性校验。

---

## 2026-10-04 核心状态机闭环、模块锁门禁穿透修复与 CLI 优雅停机

### 改了什么

- **`src/daemon/coordinator.js`**
  - **修复致命级门禁穿透缺陷**：在 `fastCheckAndAutoClaim` 中增加对 `intentRes.status === 'WAITING'` 的严格拦截，杜绝其他 Agent 持有父模块锁（如 `src/daemon`）时下游文件写操作被误放行的严重安全隐患，贯彻 fail-closed 门禁原则。
  - **超时租约释放联动排队唤醒（Anti-Starvation）**：抽离通用唤醒方法 `_wakeNextEligibleWaiter(projectId, now)`，并在 `expireLeases()` 租约自然超时路径中补齐 `resource:freed` 事件派发与等待队列唤醒，根除超时失效导致的排队 Agent 死锁与永久饿死问题。
  - **多租约并发状态机准确性**：实现 `_syncAgentRunningStatus(agentId, projectId, now)`，按剩余活跃有效租约数量流转 Agent 状态；避免某一租约释放时粗暴将仍有活跃意图的 Agent 误置为 `idle`。
  - **热点查询索引命中优化**：在 `findConflict` 的查询语句中补全 `l.project_id = ?`，精准命中 `(project_id, expires_at)` 复合索引。
- **`src/cli.js`**
  - **CLI 优雅停机（Graceful Shutdown）**：为 `nexus start` 监听 `SIGINT` 与 `SIGTERM` 操作系统信号，安全调用 `stopDaemon(daemon)` 释放 HTTP/WebSocket 连接并确保 SQLite WAL 完整刷盘关闭，消除非正常退出造成的文件锁与数据库异常。
- **`src/mcp/server.js`**
  - **MCP 路由参数边界校验**：在 `nexus_state` 处理分支中对未知 `action` 主动抛出 `ValidationError`，替代隐式返回 `undefined`。
- **`src/installer/index.js`**
  - **Hook 匹配器范围对齐**：在 `makeHookGroup` 的正则 matcher 中补齐 `Update` 与 `apply_patch`，确保与底层通用拦截脚本支持的写工具范围保持一致。
- **测试套件扩充与全量验证**
  - 在 `test/comprehensive.test.js` 中新增核心状态机闭环与门禁防御增强专项测试：
    1. 模块锁下通过 Hook 写入子文件严格拦截；
    2. 租约 TTL 超时自动派发事件并唤醒后排等待者；
    3. 多租约并发释放时的状态流转准确性；
    4. MCP `nexus_state` 遇到未知动作时的校验异常断言。
  - 全套单元测试由 179 项扩充至 **184 项全部通过**，0 失败，0 跳过。

---

## 2026-10-04 全面代码审查修复、传输安全加固与 60 FPS 性能优化

### 改了什么

- **`src/transport/rest.js` & `src/transport/ws.js`**
  - **修复致命级 SSE 监听器误删缺陷**：将 `/api/events` 断开时的全局 `removeAllListeners` 替换为独立函数引用的精确解绑（`removeListener`），彻底解决单客户端断开时抹除系统所有并发客户端与 WebSocket 事件流的严重隐患。
  - **静态前端资源内存缓存**：引入 `staticCache` 内存级驻留缓存机制，消除高频同步磁盘 I/O（`readFileSync`），大幅降低首屏资产分发延迟。
  - **WebSocket 连接稳健性加固**：在 `broadcast` 中为 `client.send` 增加异常处理回调；增加 30 秒心跳保活检测（Ping/Pong），自动清理僵死 socket 释放句柄。
- **`src/storage/database.js`**
  - **热点复合索引补齐**：新增 `idx_intents_proj_status`、`idx_intents_agent_status`、`idx_agents_proj_heartbeat` 与 `idx_claims_intent_id`，优化状态机、Dashboard 快照及冲突关联删除的高频查询效率。
  - **消除冗余迁移**：剔除初始化时重复调用的 `migrateOldSchemaIfNeeded(db)`。
- **`src/domain/state.js` & `src/domain/memory.js`**
  - **State 过期清理节流优化**：为 `expireSweep()` 添加 3000ms 时间窗口节流，消除业务写入和查询路径上重复执行全表 `DELETE` 的数据库事务开销；结合惰性过期判定保证数据严密性。
  - **Daemon 定时器协同清理**：在 `daemon/index.js` 的 5 秒定时器中主动调用 `stateService.expireSweep(true)`。
  - **SQL LIKE 通配符安全转义**：在 `ProjectMemoryService.search` 中对 `%`、`_` 及 `\` 进行精确转义，防止非预期的模糊匹配放大。
- **`src/ui/app.js` & `src/ui/style.css`**
  - **XSS 安全防御**：实现 `escapeHtml` 机制，对动态上报的 Agent 名称、意图描述、冲突原因、时间线流水与记忆内容进行严密转义，杜绝跨会话存储型 XSS。
  - **防抖与事件风暴规避**：对 WebSocket 触发的刷新引入 100ms 防抖，对搜索框引入 250ms 防抖；并依据消息类型（`memory:*` 与通用态势）实现选择性精准刷新。
  - **WebSocket 协议自适应与自动重连**：根据当前协议自适应 `wss://` / `ws://`，并在断线时实施自动退避重连。
  - **60 FPS 性能铁律保障**：为动画与动态光效节点补充 `will-change: transform; transform: translateZ(0);` 启用独立 GPU 渲染合成层。
- **测试套件扩充**
  - 在 `test/notification.test.js` 增加“单客户端断开不破坏多客户端事件分发”与“静态资源内存缓存”测试；
  - 在 `test/memory.test.js` 增加特殊字符通配符搜索单测；
  - 单元测试由 176 项扩充至 **179 项**，全部无警告高标准通过。

---

## 2026-10-04 项目长期工程记忆引擎、总调度广播与指挥作战大屏（War Room）升级

### 改了什么

- **`src/storage/database.js`**
  - 新增持久化表 `project_memories`：支持 `id`, `project_id`, `category` (`architecture`/`rule`/`gotcha`/`milestone`/`general`), `key`, `content`, `source_agent_id`, `created_at`, `updated_at`。
  - 创建联合唯一索引 `idx_project_memories_proj_cat_key (project_id, category, key)`，支持原子 Upsert（`INSERT ... ON CONFLICT DO UPDATE`）无锁幂等更新。
- **`src/domain/memory.js`**
  - 新建 `ProjectMemoryService`：提供 `set`, `get`, `getById`, `list`, `search`, `delete` 完备生命周期管理与严格输入校验。
  - 项目作用域隔离：不同项目记忆彼此独立，互不污染。
  - 总线事件挂载：记忆保存与删除时派发 `memory:saved` 与 `memory:deleted`。
- **`src/domain/project-lead.js` & `src/domain/project-registry.js`**
  - AI Tech Lead 深度结合长期记忆：在 `_buildLlmPrompt` 中自动检索并注入项目的核心架构决策（architecture）、代码规约（rule）与历史避坑经验（gotchas），指导新进场 Agent 时严格遵照既定契约。
  - 里程碑持久化沉淀：`reportMilestone` 支持将完工成果自动固化至项目的长期记忆库中。
- **`src/transport/rest.js` & `src/transport/ws.js`**
  - 新增 REST 路由：`GET/POST/DELETE /api/projects/:id/memories`，支持分类过滤与模糊搜索。
  - 新增 Master Broadcast 路由：`POST /api/projects/:id/broadcast`，支持人类指挥官（Sensei）或主调度一键向项目所有活跃会话的收件箱推送优先级指令。
  - **业务逻辑下沉与传输层解耦**：将广播编排（发件人登记、信箱投递、日志归档与总线事件）从 `rest.js` 中彻底抽离下沉到 `ProjectLead.broadcast` 领域方法中，传输层仅负责参数校验、鉴权与状态回传。
  - **静态资源分发解耦**：升级静态文件分发器，基于 `dirname(uiPath)` 和 MIME 表动态解析 `index.html`、`style.css` 与 `app.js`，避免把前端单页硬编码绑死在单一 HTML 文件。
  - SSE 与 WebSocket 全量转发 `lead:broadcast`、`memory:saved`、`memory:deleted` 事件。
- **前端架构分层与工程解耦 (`src/ui/`)**
  - 彻底拆分巨型 HTML，实现**视觉表现、交互控制与 DOM 骨架三权分立**：
    - `src/ui/style.css`：专注于 Aozora UI 视觉变量、卡片、泳道与动效；
    - `src/ui/app.js`：专注于 UI 状态驱动（API Fetch、WebSocket 事件消费、DOM 渲染与事件委托）；
    - `src/ui/index.html`：仅保留语义清晰的骨架标签。
  - 提升了组件可维护性，彻底杜绝前端逻辑修改引发的样式回退。
- **自动化测试**
  - 新增 `test/memory.test.js`（6 项单测）：覆盖记忆 CRUD、原子 Upsert、模糊搜索、项目隔离与删除。
  - 新增 `test/broadcast.test.js`：覆盖全项目活跃 Agent 广播、收件箱接收、多项目隔离与总线事件。
  - 扩充 `test/project-lead.test.js`：覆盖记忆注入 AI Prompt 与里程碑自动持久化。
  - 全套单元测试总数扩充至 **176** 项，全部通过。

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
- **生产级端到端实测验证**
  - 配置真实云端大模型代理（模型 `claude-sonnet-4-6`），编写并执行自动化压测 `test/test-ai-lead-live.mjs`。
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
- **生产级端到端实测验证**
  - 配置 Claude Code CLI + CPA 动态 SSE 转换垫片（`cpa-shim.mjs`），成功打通与大模型 API（`claude-sonnet-4-6`）的稳定直连。
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