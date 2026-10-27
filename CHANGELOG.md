# Agent-Nexus 更新日志

本文件记录项目历史。契约类内容看 [docs/API.md](docs/API.md) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，启动方式看 [README.md](README.md)。

---

## 2026-10-27 修复 Windows 下守护进程启动被 Windows Terminal 拦截弹黑框 (Probe Windows Windowless Daemon v0.2.30)

在 Windows 11 下，当系统默认终端应用设为 Windows Terminal 时，探针以守护进程拉起时会弹出可见黑框并在任务栏创建常驻标签页。

### 改了什么

- **同步生成 `probe-bg.vbs` (`src/probe/index.js`)**：
  - `writeWindowsLauncher` 在生成 `probe.cmd` 的同时，生成配套的 `probe-bg.vbs`，使用 `WScript.Shell.Run` 配合窗口模式 `0`（`SW_HIDE`）拉起 `node.exe`；
- **守护进程拉起优先走 `wscript.exe` (`src/probe/index.js`)**：
  - `startProbeDaemon` 在 Windows 平台下改用 `wscript.exe`（GUI 子系统）执行 `probe-bg.vbs`，不走 `cmd.exe /c probe.cmd`；
  - 彻底避免 Windows Terminal 拦截控制台创建、不再在前台新建黑框标签页，实现探针自转后台纯静默常驻；
- **卸载清理补齐**：`uninstallProbe` 移除列表同步纳入 `probe-bg.vbs`。

### 验证

- **单元测试**：`test/probe.test.js` 补齐 `probe-bg.vbs` 存在性与语法断言，全量 327 项通过。

> 提交前自查发现并顺带修正：`probe-bg.vbs` 初版把 `sh.CurrentDirectory` 写成
> `entry.cwd || dirname(entry.cliPath)`，与 v0.2.29 刚确立的「自启产物一律回落到
> 家目录」背道而驰 —— 未显式传 `cwd` 时会钉死源码路径，而源码路径在解包/临时目录
> 场景下会消失，正是 v0.2.29 无限重启事故的成因。现已改为 `entry?.cwd || homedir()`，
> 并补两条断言（显式 cwd 应沿用、未指定时回落到家目录且不等于安装时的 cwd）。

---

## 2026-10-27 修复探针用例误停宿主机生产探针 (Probe Test Isolation Fix)

在装有探针的机器上跑一次 `npm test`，宿主机正在运行的探针会被停掉。

### 改了什么

- **`test/probe.test.js` 与 `test/probe-orphan.test.js` 补上 `XDG_CONFIG_HOME` 重定向**：
  - 两个用例的 `withTempProbeDir()` 只隔离了 `NEXUS_PROBE_DIR` 与 `NEXUS_STARTUP_DIR`，但 `getSystemdUnitPath()` 的路径来源是 `XDG_CONFIG_HOME || ~/.config`，从未被重定向；
  - `stopProbe()` 结尾会无条件执行 `systemctl --user stop agent-nexus-probe.service`（`existsSync(unit) && systemdUnitReachable()` 两个前置条件在生产机上恒成立），于是用例里每一次 `stopProbe` 都真实作用于宿主机单元；
  - 现在两个 helper 都把 `XDG_CONFIG_HOME` 指向用例自己的临时目录，单元路径与 autostart 路径一起落在沙箱内。
- **回归用例**：新增「用例把 systemd 单元路径重定向到临时目录」，断言 `XDG_CONFIG_HOME` 已指向 `tmpdir()` 且不等于 `~/.config`。

### 验证

- **真实事故复现**：美西机探针连续运行 20 小时后，本机执行一次 `npm test`，服务在 19:11:24 变为 `inactive (dead)`，日志显示 `Stopping agent-nexus-probe.service... Stopped`，随后已手动 `systemctl --user start` 恢复（`NRestarts=0`，`/` 返回 200，单实例）；
- **修复后复查**：全量测试 **327 项**通过（原 326 项），测试前后 `systemctl --user is-active` 均为 `active`；
- **未改运行时代码**，不涉及版本号变更与重新打包。

---

## 2026-10-27 修复自启项钉死临时工作目录导致探针无限重启 (Probe Unit CWD Fix v0.2.29)

美西机的 edge 探针实际上**从未成功启动过**：systemd 单元把工作目录钉在一个已被清掉的 `/tmp` 解包目录上。

### 改了什么

- **`installProbe` 不再记录安装进程的 `process.cwd()` (`src/probe/index.js`)**：
  - `cwd` 原本默认取 `process.cwd()`。在临时目录里安装（解包目录、CI、`/tmp` 沙箱）时，这个路径会被写进 systemd 的 `WorkingDirectory=` 与各平台启动脚本；目录被清掉之后，systemd 每次启动都以 `status=200/CHDIR` 失败，`Restart=always` 于是变成无限重启；
  - 现在只有调用方显式传 `cwd` 才记录，缺省为 `null`；
- **三个平台的启动脚本统一回落到家目录**：systemd 单元 `WorkingDirectory=${cwd || homedir()}`、POSIX launcher `cd "$HOME" || cd /`、Windows VBScript `sh.CurrentDirectory` 同口径。家目录是唯一「一定存在且不会消失」的锚点。
- **影响面**：美西机 journal 显示重启计数已到 13，最后一次启动仍在 `Changing to the requested working directory failed`，探针进程从未真正运行。

### 验证

- **新增 `test/probe.test.js` 1 项**：未显式给 `cwd` 时，`entry.cwd` 为 `null`、单元里 `WorkingDirectory` 等于家目录、且不等于 `process.cwd()`；
- **全量测试**：**326 项**通过（原 325 项）；
- **未重新安装**：美西机探针需重新执行 `probe:install` 才会重写单元，本次仅入库修复。

---

## 2026-10-27 修复端口反查在 lsof 输出下失效 (Port Lookup Parse Fix v0.2.28)

`probe:stop` 的端口兜底在 macOS / BSD 上等于没有：`lsof -t` 的裸 PID 一个都解析不出来。

### 改了什么

- **`findListeningPids` 按命令分别解析 (`src/probe/index.js`)**：
  - 原实现让 `lsof -t` 与 `ss` 共用一条 `/(?:pid=|\s)(\d+)(?:,|\s|$)/g`。这条正则靠**前导空白**锚定，而 `lsof -t` 每行就是一个裸 PID（`46780\n`），行首没有空白 —— 单个监听者时反查结果为空，多个监听者时永远丢掉第一个；
  - 拆成 `parseLsofPids`（`/^\s*(\d+)\s*$/gm`）与 `parseSsPids`（`/pid=(\d+)/g`）两个解析器，各自匹配自己的输出格式，并导出以便直接测；
  - 影响面：Linux 上 `lsof` 通常没装、会回落到 `ss` 因而看不出来；**macOS 没有 `ss`，走的正是 `lsof` 这条路径**，端口兜底从未生效过。

### 验证

- **新增 `test/probe-orphan.test.js` 1 项**：lsof 单行/多行/空输出与 ss 单行/多行的解析断言；
- **全量测试**：**325 项**通过（原 324 项）；
- **未部署**：本机与美西机探针均未重启，本次改动在下次 `probe:start` 后生效。

---

## 2026-10-26 全面排查修复 UI 溢出、800x560 桌面伴侣布局与全矢量化图标 (UI Layout & Zero-Emoji Compliance v0.2.27)

全面审查前端在不同视口（特别是桌面端默认 800x560 伴侣窗口）下的布局与文本截断表现，彻底解决仲裁中枢端点胶囊溢出、三栏走廊拥挤与 Emoji 渲染跨平台字形差异。

### 改了什么

- **中枢卡片双行光学对齐与防溢出保护 (`src/ui/index.html`, `src/ui/style.css`)**：
  - 原中枢卡片宽限仅 290px，且将主标题 `Nexus Arbiter Core` 与长 IP 端口胶囊 (`100.72.34.104:4300`) 挤在同一水平行，导致右边界被强制撑破；
  - 重构 `.hub-info` 为双行布局：首行独占标题，次行 `.hub-sub-row` 容纳胶囊与副标题；
  - 胶囊增加 `max-width: 140px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex-shrink: 0;` 与原生 `title` 气泡提示；
  - 卡片宽度弹性拓宽至 `max-width: min(340px, 100%)`，并全量设置 `box-sizing: border-box; min-width: 0;`。
- **800x560 桌面伴侣态响应式适配 (`src/ui/style.css`)**：
  - 新增 `@media (max-width: 900px)` 响应断点：隐去路由主标题次级英文 `(Session Routing & Resource Map)`，杜绝顶栏挤压换行；
  - 三栏间距改用 `clamp(14px, 2.2vw, 32px)` 动态呼吸走廊，小窗口下收紧为 `clamp(10px, 1.8vw, 20px)`；
  - 会话卡片 `.route-card-identity`、在席卡片 `.agent-name-group` 开启 `flex-wrap: wrap`，为机器标识、项目标签提供多项自适应排布；
  - 目标卡片 `.target-card-meta` 与持有者标签 `.holder-name`、`.holder-mono` 增加截断截短保护 (`max-width: 130px`)。
- **全站零 Emoji 规范化与矢量图标替代 (`src/ui/app.js`)**：
  - 消除 Windows 11 与 Linux/macOS 下字形与色彩不一的 `🌐` Unicode Emoji；
  - 统一采用极简 inline SVG 经纬球矢量图标，融入深色高对比度主题。
- **双层令牌持久化与 401 拦截弹窗 (`src/ui/app.js`, `src/ui/style.css`)**：
  - URL `?token=...` 同时回写 `sessionStorage` 与 `localStorage`，防止刷新后凭据丢失；
  - 遇到 401 状态码时自动唤起高斯模糊认证弹窗，支持直接贴入 Operator Token 并实时重连。

### 验证

- **全量测试通过**：`npm test` 324/324 项测试通过；
- **东京 Hub 热更新**：UI 产物已同步部署至东京 Hub `/opt/agent-nexus/src/ui/`，并重启服务平稳载入。

---

## 2026-10-26 修复会话收割误杀与探针误杀 (Session Reap & Probe Kill Safety v0.2.26)

代码审查的 26 项发现里，先修最严重的四项：前三项都会让正在施工的会话掉锁，第四项会杀掉用户的无关进程。

### 改了什么

- **全量快照不再收割 Hook 会话 (`src/daemon/coordinator.js`)**：
  - 收割条件原本是「在全量快照里缺席」，但 `~/.claude/sessions` 是**桌面端**维护的注册表，经全局 Hook 注册的终端会话从不写进去。它们每一次 tick 都「缺席」，于是刚拿到的租约在首个 3 秒刷新里就被清掉；
  - 现在只有 `liveness_verified_at IS NOT NULL` 的行才走快照收割——即至少被一次管道/PID 验证确认过。Hook 会话改由 `reapStaleIntentsAndAgents` 按心跳超时收割。
- **`seenAgentIds` 不再形同虚设 (`src/daemon/coordinator.js`)**：
  - `seenAgentIds` 原本只在「存活」分支写入，与 `aliveAgentIds` 完全等价；而宽限逻辑是「本帧见过则不消耗宽限」。结果是单帧探测失败（Windows 管道 `existsSync` 实测约 3.5%/秒漏检）仍会立刻耗尽 45 秒宽限；
  - `!sess.alive` 分支现在也记下匹配到的 agent id，漏检帧算「见过」，宽限从最后一次真正验活起算。
- **远端会话同样享有 45 秒宽限 (`src/daemon/coordinator.js`)**：
  - 收割路径原本用 `isRemote && fullSnapshot` 限定为远端专属、且无宽限，边缘桥 15 秒才推一帧，一次网络抖动或单帧漏检就清掉远端文件锁；
  - 去掉 `isRemote` 限定，所有节点统一走 `SESSION_DISAPPEAR_GRACE_MS`。真死由「宽限期内每一帧都缺席」认定，本地会话仍额外要求 PID 探针同时失败。
- **按记录 PID 杀进程前必须自证 (`src/probe/index.js`)**：
  - PID 文件是不可信输入：探针被强杀或从旧版本升级后，文件会指向早已消失的 PID，Windows 又把这个号复用给无关进程。过去只有端口反查结果要过 `isNexusProbeCommand`，记录 PID 直接进待杀列表，会对着用户的编辑器发 `SIGTERM`；
  - `isNexusProbeCommand` 改为三态：`true` 确认是探针、`false` 确认不是、`null` 读不到命令行。记录 PID 只要不是 `false` 就放行（edge 探针没有端口兜底，一律拒绝就再也停不掉），端口反查结果仍必须为 `true`；
  - 新增 `readProcessCmdline`：POSIX 优先读 `/proc/<pid>/cmdline`，读不到退回 `ps -p <pid> -o args=`——macOS 没有 procfs，旧实现会让 edge 探针永远停不掉。

### 验证

- **全量测试 324 项通过**（原 320 项，新增 4 项回归）：
  - `test/probe-perf.test.js` 3 项：Hook 会话不被全量快照收割、单帧漏检不消耗宽限、远端会话单帧缺席保留锁而宽限期后照常收割；
  - `test/probe-orphan.test.js` 1 项：PID 文件指向无关进程时不得按文件误杀；
  - `test/remote-workspace-hub.test.js` 的端到端用例改为「先宽限、后收割」两步断言，不再断言单帧立即离席。
- **未部署**：本机探针仍运行 v0.2.25，需重启后才加载本次修复。

---

## 2026-10-26 修复探针启停：PID 文件失真时按端口兜底 (Probe Lifecycle Recovery v0.2.25)

### 改了什么

- **PID 文件失真不再让 `probe:stop` 空转 (`src/probe/index.js`)**：
  - 探针只在「顺利启动」时写 PID 文件；被强杀、崩溃或从旧版本升级时，文件会指向早已消失的 PID。真机上就出现过：`probe.pid` 指向 33108，实际监听 4300 的是另一个孤儿进程，`probe:stop` 只认文件 → 什么都没停，还打印「still shutting down」并以退出码 0 收场；
  - 新增 `findListeningPids(port)` 兜底：Windows 走 `netstat -ano -p TCP`，POSIX 依次尝试 `lsof` / `ss`。PID 文件里的进程已不在、而端口仍被占用时，按端口反查真实监听进程；
  - **只杀自证过的进程**：`isNexusProbeCommand(pid)` 读取命令行，必须匹配「`cli.js` + 完整 `probe` 子命令」才动手。端口被别的服务占用时绝不误杀，结果如实报告为「未停止」并给出排查命令。
- **命令行自证的正则修正 (`src/probe/index.js`)**：
  - 真机的命令行每个参数都带引号（`"…\cli.js" "probe" "--port" "4300"`），早期正则假设 `probe` 前是裸空格，**一个都识别不出来**；而当时的测试用无引号形态，把这个问题掩盖了；
  - 改为 `cli\.js(?=["'\s])[\s\S]*?(?<![\w.:-])probe(?=["'\s]|$)`：既认引号形态，也不会把 `probe:install` / `probe:status` 误判成探针进程。
- **`probe:stop` 如实报告结果 (`src/cli.js`)**：
  - 过去无论成功与否都打印「still shutting down」且退出码 0，把失败伪装成「正在关闭」；
  - 现在成功报 stopped（按端口兜底时注明），失败打印到 stderr 并置退出码 1。
- **`probe:status` 报真实 PID (`src/probe/index.js`, `src/cli.js`)**：
  - 端口在监听、但 PID 文件里的进程已经不在时，按端口反查真实进程并标注「按端口 N 反查」，不再把死 PID 标成 `stale` 让人以为探针没起来。
- **进程退出兜底清理状态 (`src/cli.js`)**：
  - 新增 `process.on('exit')` 钩子，只清自己写的那份状态（`state.pid === process.pid`），避免旧进程的退出钩子误删新探针的文件。

### 验证

- **真机复现并修复**：先把 `probe.pid` / `probe.json` 改写成不存在的 999999，探针实际在 46780 监听 4300。修复前 `probe:stop` 停不掉、`probe:status` 报 `999999 (stale)`；修复后 status 报 **`46780 (按端口 4300 反查)`**，stop 成功结束该进程并释放端口，随后 `probe:start` 正常拉起（PID 19144）。
- **正常路径不受影响**：PID 文件正确时再次 `probe:stop` → 正常停止、端口释放、状态文件干净清除；再 `probe:start` 正常。
- **全量测试**：**320 项**通过。新增 `test/probe-orphan.test.js` 3 项：PID 失真时按端口反查仍能停掉；status 报出端口上的真实 PID；端口被陌生进程占用时不得误杀。

---

## 2026-10-26 探针性能全面优化与代码审查 (Probe Performance & Review v0.2.24)

探针本体是 daemon（`nexus probe` → `runDaemon({managed:true})` → `CoordinatorEngine`），`src/probe/index.js` 只是安装器与生命周期管理。本轮审查覆盖 daemon 的快照链路、租约清理、会话在席判定与传输层。

### 改了什么

- **修复 `expireLeases` 去重失效 (`src/daemon/coordinator.js`)**：
  - `affectedAgents` 原本是 `Set<对象>`，每次 `add` 都是新对象字面量，集合永远去不了重。同一个 Agent 持有多份过期租约时，会重复查库、重复 emit `agent:status`；
  - 改为以 `agentId|projectId` 为键的 `Map`，每个 Agent 每轮只同步一次状态。
- **管道已证明存活时不再发 PID 探针 (`src/daemon/coordinator.js`)**：
  - `getClaudeSessionRegistry` 每 3 秒遍历一遍 `~/.claude/sessions/*.json`。声明了 `messagingSocketPath` 的条目，管道存在本身就是权威存活信号，此时再发一次 `process.kill(pid, 0)` 是纯多余的系统调用；
  - 只有管道不可用（或旧注册表没有管道字段）时才退回 PID 探测，未探测时 `pidAlive` 为 `null`（与 `verified` 区分“没探”和“探了不在”）。
- **SQL 语句缓存 (`src/daemon/coordinator.js`)**：
  - `node:sqlite` 的 `prepare` 是 JIT 编译。过去 88 处 `this.db.prepare(...)` 在每次调用时都重新编译，在 300 会话库上占单次快照约 **10%** 的自采样时间；
  - 新增 `_stmt/_run/_get/_all`，按 SQL 文本缓存语句对象；缓存按 db 实例隔离，测试关闭数据库后自动失效。
- **在席过滤下推到 SQL (`getDashboardSnapshot`)**：
  - 历史离席行是库存主体（实测 301 行里 292 行）。过去先全查出来、逐行算生命周期、再把这些行丢掉；
  - 改为 `WHERE a.status != 'departed'`。会话复活只发生在 `syncClaudeSessions` 里，而同一次刷新中它已经把状态改回在线档位，因此 `status` 判定安全。
- **驾驶舱不再重复算两遍 (`getUnifiedCockpit`)**：
  - 拓扑只算一次（同时用作 `topologySnapshot`），不再在 payload 里返回两份（过去 `topology` 与 `topologySnapshot` 各占一份，1500 节点规模下白序列化一遍）；
  - dashboard 与 collab 共用同一批 agent 行（`precomputedAgents`），不再各自跑一遍 5 个相关子查询与生命周期判定；collab 的 `total_sessions` 改由一次 COUNT 补齐，`departed_sessions` 由总数反推（复用行时过去恒为 0 的假报）。
- **驾驶舱两处长期空数据修复 (`src/daemon/coordinator.js`, `src/ui/app.js`)**：
  - `getDashboardSnapshot` 从不返回 `waitQueue`，驾驶舱的「N 处冲突等待」与决策流水因此永远是 0。现在如实返回等待队列（含 `blocked_reason` 与 `blocked_by_agent_id`）；
  - `resourceLocks` 读的是从未存在过的 `collab.exclusiveLocks`，「排他命令与环境锁」永远为空。现在把 `activeClaims` 按 `claim_type` 拆成文件锁与命名资源锁两类，计数不重不漏。
- **`/api/status` 改为轻量计数 (`src/daemon/coordinator.js`, `src/transport/rest.js`)**：
  - 桌面托盘每 3 秒轮询一次，过去这里跑完整 `getDashboardSnapshot('all')` 并序列化整份快照，再把 99% 的字段丢掉；
  - 新增 `getLiveAgentCounts()`：窄列查询 + 与快照完全相同的生命周期判定，只返回计数。托盘读的 `active_leases` / `waiting_intents` 过去从未被返回过，所以「协同施工中 / 冲突等待中」的提示永远停在「待命就绪」——现在有真实数据。
- **WebSocket 推送帧去重 (`src/transport/ws.js`, `src/ui/app.js`)**：
  - `init:state` 与 `sync:response` 过去先 `getDashboardSnapshot` 再 `getUnifiedCockpit`（后者内部又算一遍 dashboard + collab + 拓扑），然后把几乎相同的数据在同一帧里发两遍；
  - 现在只算一轮，帧内 `data.snapshot` 是唯一一份 dashboard，`data.cockpit` 不再内嵌 `dashboard`/`collab`。90 会话实测单帧 **160KB → 70KB**，前端渲染时用同帧 snapshot 补回。
- **收紧公开端点 (`src/transport/rest.js`)**：
  - `/api/dashboard` 与 `/api/cockpit` 原本在 `PUBLIC_PATHS` 里，匿名可读；这两份响应包含全部会话名、工作目录与文件锁，而 daemon 可以用 `NEXUS_HOST=0.0.0.0` 对外监听；
  - 移出白名单，对齐 `docs/API.md` 与既有测试一直声称的「`/api/*` 都要令牌」。`/health`、`/api/status`（只含计数）与面板静态资源仍公开。
- **修复会话「重连在线」抖动与租约误回收 (`src/daemon/coordinator.js`)**：
  - 实测本机真实库：`activity_log` 最近 600 条里 **475 条是「Claude 会话重连在线」**，同一会话每 15–30 秒一次，伴随 `Auto-released lease upon process_exit`（42 次/40 分钟）——正在编辑的会话会被莫名其妙地清锁；
  - 根因是 `getClaudeSessionRegistry` 的单次 `existsSync(命名管道)` 被当成权威死判决：实测每条管道每秒约 **3.5%** 的采样会瞬时漏检（30 秒内 265 次采样漏 3–15 次），3 秒刷新周期撞上漏检、下一周期又恢复，于是「离席→复活」反复上演；
  - `_ingestSessionEntries` 原本对本地会话同样在探测失败的那一帧立即回收租约、清空 `liveness_verified_at`。现在探测失败只跳过该帧，收割统一交给「从注册表消失」路径；
  - 新增 `SESSION_DISAPPEAR_GRACE_MS = 45000` 宽限期：本地会话从快照消失后，**且** PID 探针也失败，才判离席并回收租约。真死进程仍是一条不落（PID 探针即时生效），断掉管道但进程还在的会话也不会被误杀。远端桥的存活判定在远端完成、不会跨机抖动，缺席即离席，不加宽限。
  - `reapDeadAgentLeases` 不再走 `updateAgentStatus('departed')`：后者会把 `last_heartbeat` 刷成当前时刻，离席行永远显示不出「何时掉的线」。
  - `releaseAgentLeases` 在 `reason='process_exit'` 时不再回写「无租约 → idle」：过去这会把刚标好的 departed 又改回在线，并顺手刷新心跳。

### 验证

- **基准（合成库 300 会话 / 5 项目 / 3000 活动流水 / 200 拓扑节点）**：`getUnifiedCockpit(all)` 9–11ms → **4.7–5.3ms**，`getDashboardSnapshot` 2.1ms → **1.6–1.9ms**，`getCollaborationGraph` 2.1ms → **1.0–1.4ms**，`_refreshTick` 2.5ms → **2.2–2.5ms**（5 轮取中位）；
- **基准（本机真实库副本，301 agents / 292 departed / 5338 intents）**：`getDashboardSnapshot` 0.82ms，`getUnifiedCockpit` 3.9ms，`getCollaborationGraph` 0.30ms；
- **端到端（真实 HTTP + WS，90 在席会话）**：`/api/status` 182B，`/api/cockpit` 110KB / 7.9ms（无重复 topology、无 departed 行），WS `init:state` **70KB**、`sync:request` 往返 6.1ms；匿名访问 `/api/dashboard` 与 `/api/cockpit` 均返回 401；
- **浏览器实测**（Playwright，独立演示 daemon + 隔离会话目录）：面板正确显示 4 个在席 / 1 处排队 / 2 项锁，历史离席行未渲染；驾驶舱「1 处冲突等待」与「排他命令与环境锁」均有真实数据，修复前两者恒为空；
- **抖动修复前后（新探针 + 独立库，接本机真实 `~/.claude/sessions`）**：修复前同规模窗口每 10 分钟约 200+ 条 `agent:registered`、每分钟 1–5 次 `lease:released (process_exit)`；修复后 **70 秒内只有 6 条首次接入，0 条重连在线、0 次租约回收**，6 个会话的 `liveness_verified_at` 稳定在 1 秒内；
- **全量测试**：**317 项**通过（新增 `test/probe-perf.test.js` 11 项：过期租约去重、在席过滤 SQL 下推、驾驶舱等待队列与锁分类、collab 复用时统计口径、轻量计数与快照口径一致、管道漏检宽限期、PID 回收不改写心跳、公开端点边界）。

---

## 2026-10-26 修复面板闪断：主线程被快照刷新占满 (Panel Disconnect Fix v0.2.23)

### 改了什么

- **缓存本机节点标识 (`src/domain/project.js`)**：
  - 闪断根因不是探活阈值，而是 daemon 主线程被吃满。CPU profile（`--inspect` + `Profiler` 采样 8 秒）显示 `os.hostname()` 占 **90% 以上**的自采样；
  - `getLocalNodeId()` 每次调用都走一次 `hostname()`（Windows 上要过名称解析，实测 ~0.09ms），而它位于快照序列化的每个 agent 循环里——单库 293 行 agent，一次快照调用上千次；
  - 改为按 `NEXUS_NODE_ID` 缓存：值不变就复用，测试可用 `resetLocalNodeIdCache()` 重置。单次 `getUnifiedCockpit` 由 **486–654ms 降到 7–9ms**（约 90 倍）。
- **一次快照只刷新一轮 (`src/daemon/coordinator.js`)**：
  - `getDashboardSnapshot` 与 `getCollaborationGraph` 过去各自执行 `syncClaudeSessions + reapStaleIntentsAndAgents + reapDeadAgentLeases + expireLeases`，`getUnifiedCockpit` 又把两者串起来跑一遍；前端每 4 秒一次 `sync:request`、daemon 每 3 秒一次定时器，同一轮重活被重复执行 3 次以上；
  - 抽出 `_refreshTick(now)` 作为唯一刷新入口，两个快照函数支持 `skipRefresh`；`getUnifiedCockpit` 只在顶层刷新一次，内层两次调用复用同一轮结果。顶层单独调用语义不变。
- **探针真·无窗口 (`src/probe/index.js`)**：
  - 自启项不再经由 `probe.cmd`：`cmd.exe` 即使被 `wscript` 以窗口模式 0 拉起，部分 Windows 版本仍会闪一下控制台；改为 VBS 直接执行 node；
  - 修复 VBScript 语法错误：VBScript 没有转义引号，`sh.Run "a" "b", 0, False` 会被解析成「语句未结束」并**静默失败**，探针根本起不来。现在把整条命令行拼成一个 `""` 包裹、内部引号成对转义的字符串字面量再交给 `Run`。

### 验证

- **真机验证**：修复前 `/health` 实测 2.8–7.6 秒（含一次 8 秒超时），探针常驻 **108% CPU**（占满一核）；修复后 `/health` 稳定 **1.5–3ms**，CPU **9.4%**；`MainWindowHandle = 0`，窗口枚举确认无任何探针/控制台可见窗口；
- **自启**：用 `cscript //nologo` 校验 VBS 无语法错误，再经 `wscript` 实际拉起探针成功（PID 44816）；
- **全量测试**：**306 项**通过，新增「Windows 自启项是合法 VBScript」与「getUnifiedCockpit 只刷新一次」两组回归。

---


### 改了什么

- **窗口启动归位 (`desktop/main.cjs`)**：
  - 现象：升级后桌面端"启动了却看不见窗口"。真机抓到的窗口坐标是 `(2221, -51)`——落在已断开的外接屏区域里，Electron 记住了上次位置，`show()` 之后用户屏幕上什么都看不到；
  - 新增 `ensureWindowOnScreen(win)`：启动时用 `screen.getAllDisplays()` 逐个比对 `workArea`，窗口矩形与所有显示器都不相交就按主屏 `workArea` 居中并夹到可用尺寸，之后才 `showPanel()`。
- **导航诊断落盘 (`desktop/main.cjs`)**：`showPanel` / `showOffline` / `did-fail-load` / `did-finish-load` / `render-process-gone` 统一追加写入 `<userData>/nav.log`，闪屏类问题不必再靠猜。
- **导航竞态收口 (`desktop/main.cjs`)**：新增 `panelNavigating` 标记，`loadURL` 在途期间 `showPanel` 直接返回；`did-fail-load`（主框架）与 `did-finish-load` 负责清除，避免轮询与退避定时器叠加重定向。

### 验证

- **真机验证**：重新打包 `Agent-Nexus-v0.2.22-win32-x64` 并启动，窗口落在 `(560, 236)`、`800×560`，完整处于主屏工作区内；`nav.log` 在 2 分 30 秒内只有一对 `showPanel` → `did-finish-load`，无任何 `did-fail-load` 与二次导航；
- **全量测试**：**304 项**通过。

---

## 2026-10-26 探活超时放宽与进程兜底 (Health Timeout & PID Fallback v0.2.21)

### 改了什么

- **探活超时按实测抖动放宽 (`desktop/probe-client.cjs`, `src/probe/index.js`)**：
  - `checkAlive` 900ms → **2500ms**，CLI 侧 `checkProbeHealth` 1200ms → **3000ms**。实测 daemon 主线程被 SQLite 扫描或会话发现占住时，`/health` 延迟会从 1ms 抖到 600ms 以上，原阈值会把健康探针误判成离线；
  - 桌面端正是这条误判路径触发了残余闪屏：`nav.log` 里抓到一次 `showOffline` → 2 秒后 `showPanel` 且**没有** `did-fail-load`，证明是轮询翻页而非加载失败。
- **进程存活兜底 (`desktop/probe-client.cjs`, `src/probe/index.js`)**：
  - `ProbeClient.isAlive()`：HTTP 探活失败时读 `~/.agent-nexus/probe.json` 的 PID 并 `kill(pid, 0)`，进程还在就按 `{ alive: true, status: 'degraded' }` 上报，不翻离线页；
  - `probeStatus` 新增 `isPortListening()`：进程存活且端口仍在监听即判在线，`nexus probe:status` 不再出现"服务正常却显示 Running: no"。

### 验证

- **单元测试**：`test/desktop-runner.test.js` 增至 **14 项**，新增 `isAlive` 降级兜底断言；
- **真机验证**：修复后连续运行 5 分钟，`nav.log` 只保留启动时的初始导航，renderer 进程 PID 未变。

---


### 改了什么

- **展示名改用原始大小写路径反查 (`src/daemon/coordinator.js`)**：
  - 失败根因：`registerAgent` 用 `toComparablePath()` 的输出反查展示名，而该函数为保证跨机 `projectId` 一致会**强制小写**；Windows 上 `realpathSync.native` 能从磁盘还原真实目录名，Linux 上该路径不存在（如 `d:/claudespace/...`）只能降级取 basename，于是 `Agent-Nexus` 变成 `agent-nexus`；
  - 新增 `pickDisplayPath()`：只接受与项目根同源的候选路径（避免误把子目录名当项目名），优先取磁盘上可寻址的真实路径，本机不可寻址时取保留原始大小写的那个候选；
  - `registerAgent` 改为把 `projectRoot` 与 `workspaceDir` 一并作为候选，后者才是用户侧原始大小写。

### 验证

- **本地 (Windows)**：`node --test test/remote-workspace-hub.test.js` 6 项全绿；全量 **303 项**通过；
- **美西 (Linux, us-zenix)**：打补丁后同一用例由失败转全绿，全量 **303 项**通过——修复前该用例在 Linux 必挂（`agent-nexus` ≠ `Agent-Nexus`）。

---

## 2026-10-25 修复桌面端闪屏 (Panel Flicker Fix v0.2.20)

### 改了什么

- **面板切换状态机 (`desktop/panel-state.cjs`, `desktop/main.cjs`)**：
  - 闪屏根因：主进程每 3 秒轮询探针，一次探活失败就 `loadFile` 离线页，下次成功又 `loadURL` 面板，页面反复从头加载；`did-fail-load` 还会因子框架失败与 `ERR_ABORTED(-3)` 误触发，放大成每 3 秒一次的"连上→断开→连上"；
  - 新增 `PanelState`：连续 **3 次**探活失败才翻离线页（单次抖动不打断正在看的页面）；面板加载失败按 **3s→6s→12s→24s** 指数退避重试、封顶 60s；`did-finish-load` 成功后计数与退避归零；
  - 新增 `isPanelKillingFailure`：只认主框架（`isMainFrame !== false`）的真实失败，忽略子资源/子框架失败、`ERR_ABORTED(-3)` 与离线页自身的 `file://` 加载；
  - 切回面板前用 `webContents.getURL()` 比对当前 URL，已在面板上就不重复 `loadURL`；轮询在有退避定时器待执行时不再插手，避免两个来源同时导航。
- **活跃助手列表去抖 (`src/ui/app.js`)**：`renderActiveAgents` 生成 HTML 后与上次结果比对，内容未变不重写 `innerHTML`。此前每次轮询都整块重建 DOM，卡片内的脉冲动画会随之从头播放。
- **版本清单同步**：`package.json` / `package-lock.json` / `src/transport/rest.js` 统一至 `0.2.20`。

### 验证

- **单元测试**：`test/desktop-runner.test.js` 增至 **13 项**，新增 `PanelState` 六组断言（单次失败不翻页、达阈值才翻、恢复后切回、3s→6s→12s 退避、封顶 60s、只认主框架失败）；全量 **303 项**通过；
- **真机验证**：重新打包 `Agent-Nexus-v0.2.20-win32-x64` 并启动，3 分 24 秒内 renderer 进程始终为同一个（无重建），renderer 到 `127.0.0.1:4300` 的 7 条连接在 120 秒采样中**零变更**——页面未再重新加载。

---

## 2026-10-25 边缘探针取代远端同步桥 (Edge Probe Role v0.2.19)

### 改了什么

- **探针新增 `edge` 角色 (`src/probe/index.js`, `src/cli.js`)**：
  - `nexus probe --edge [--node <id>]` 与 `nexus probe:install --edge`：同一套探针产品可直接装在远端工作区（如美西 `us-zenix`），**不开端口、不建本地数据库、不跑面板**，只监听本机 `~/.claude/sessions` 并把会话快照推给中心 Hub——语义与 `nexus bridge` 一致，但自带开机自启与崩溃重启；
  - 安装时强制校验 `~/.agent-nexus/remote.json` 已有 `hubUrl` 与 `token`，缺失直接报错并提示先跑 `nexus connect`，避免装出一个永远推不出去的探针；
  - `probe-entry.json` 记录 `role` 与 `nodeId`（缺省取 `NEXUS_NODE_ID` → `remote.json` 的 nodeId → 主机名），启动器据此追加 `--edge` / `--node`，且不再写 `--port` / `--host`。
- **边缘探针按进程判活 (`src/probe/index.js`)**：
  - `probeStatus` / `startProbe` / `stopProbe` 对 `edge` 角色改用 PID 存活判断（不开端口就没有 `/health` 可打），状态里回传 `hubUrl` 供面板核对；
  - `probe:status` 新增 `Role` 与 `Edge node` 两行，edge 角色的 `Endpoint` 显示为 `edge -> http://<hub>:4300`。
- **Linux 交给 systemd 拉起 (`src/probe/index.js`)**：
  - 已写 `systemctl --user` 单元时，`probe:start` 改走 `systemctl --user start` 而不是直接 spawn：直接 spawn 会绕过 `Restart=always`，且开机后服务再拉一次会变成两个探针进程；
  - `isProbeInstalled` 同时认 XDG `.desktop` 与 systemd 单元（此前只认前者，Linux 上恒为「未安装」）；`probe:status` 的 `Auto-start` 也改为显示实际生效的 systemd 单元路径；
  - `resolveNodeRuntime` 优先用 `process.execPath`，并把裸命令名解析为绝对路径——真机部署时正是 `ExecStart='node'` 导致 systemd 拒绝启动（要求绝对路径）；
  - 非交互 SSH / cron 下没有 `XDG_RUNTIME_DIR`，`systemctl --user` 会报 `Failed to connect to bus: No medium found`；所有 systemctl 调用统一按 uid 补 `/run/user/<uid>`。
- **版本清单同步**：`package.json` / `package-lock.json` / `src/transport/rest.js` 统一至 `0.2.19`（上一版 `package-lock.json` 漏同步，仍停在 `0.2.17`）。

### 验证

- **单元测试**：`test/probe.test.js` 由 5 项增至 **9 项**，覆盖「未绑定 Hub 时拒绝安装 edge」「安装后记录 role/nodeId 且启动器带 `--edge`/`--node`、不带 `--port`」「edge 状态按进程判活并回传 hubUrl」；全量 **296 项**通过；
- **端到端**：以临时 `NEXUS_PROBE_DIR` / `NEXUS_REMOTE_CONFIG_PATH` / `NEXUS_CLAUDE_SESSIONS_DIR` 起真实 `nexus probe --edge --node us-zenix`，假 Hub 收到 `POST /api/agents/sync-remote`（`host_id: us-zenix`、`full_snapshot: true`、`Authorization: Bearer`），`probe.json` 写入 `role/nodeId/hubUrl`，日志落盘，`SIGTERM` 后进程退出；
- **美西机 `us-zenix` 真机部署**：`probe:install --edge` 装成 systemd user 单元（`enabled` + `Linger=yes`，重启后无需登录），`probe:status` 显示 `Role: edge / Endpoint: edge -> http://100.79.74.121:4300 / Edge node: us-zenix`；旧 `nexus-bridge.service` 已 stop、disable 并删除单元文件（备份 `/root/nexus-bridge.service.bak-20261025`），`systemctl list-units 'nexus-bridge*'` 为空；
- **存活与恢复**：`kill -9` 探针后 systemd 3 秒内拉起新 PID，中心 Hub `/api/agents` 中 `us-zenix` 的 4 个活跃会话心跳持续刷新（<10s），面板无需任何改动。

---

## 2026-10-25 后台探针与前端解耦 (Background Probe / Pure-Client Desktop v0.2.18)

### 改了什么

- **新增无窗口后台探针 (`src/probe/index.js`, `src/cli.js`)**：
  - 探针 = 无 UI、无窗口、开机自启的常驻协调进程，持有 Hub、SQLite 与全部协同逻辑；新增 `nexus probe` 子命令以托管模式运行 daemon，并写 `probe.pid` / `probe.json`；
  - 新增 `nexus probe:install [--port N] [--host H] [--no-start]`、`probe:uninstall`、`probe:start`、`probe:stop`、`probe:status` 全生命周期命令；
  - Windows 落点为 `~/.agent-nexus/probe.cmd` 启动器 + 启动文件夹 `Agent-Nexus Probe.vbs`（`WScript.Shell.Run(..., 0, False)` 以 0 号窗口运行，全程无控制台黑框）；Linux 优先 `systemctl --user` unit（`Restart=always`），无 systemd 时退回 XDG autostart；
  - 探针解释器独立探测系统 Node（必须支持 `node:sqlite`），不依赖打包后的 Electron 运行时，可用 `NEXUS_NODE_PATH` 覆盖。
- **日志自持，不依赖启动器重定向 (`src/cli.js`)**：
  - 实测 `detached` 启动下 cmd 的 `>>` 重定向会静默丢输出（日志恒为 0 字节）；改为探针进程启动时自行接管 `stdout/stderr` 写入 `~/.agent-nexus/probe.log`，崩溃与启动失败必定留痕，超过 4MB 自动清空。
- **桌面端降级为纯客户端 (`desktop/main.cjs`, `desktop/probe-client.cjs`, `desktop/offline.html`)**：
  - 删除 `desktop/daemon-runner.cjs`：桌面端不再探测、不再 spawn、不再关停任何 daemon，探针与前端彻底解耦、可分别安装升级；
  - 新增 `ProbeClient`：只做探活、读 `session.token`、拼面板地址三件事，不暴露任何拉起探针的能力；
  - 探针离线时加载 `desktop/offline.html` 指引页（提示 `nexus probe:install` / `probe:start`），每 3 秒自动重连；托盘菜单新增“重启探针”指引项。
- **打包产物瘦身 (`scripts/build-exe.cjs`, `package.json`)**：
  - EXE 不再内嵌 `src/`、daemon 与 `ws` 依赖，只打包 `desktop/` 客户端外壳；`package.json` 的 `files` 补入 `desktop/`，新增 `probe:install` / `probe:status` npm 脚本。

### 验证

- **全量回归**：`node --test "test/*.test.js"` 全量 **293 项**全部通过（0 失败），新增 `test/probe.test.js`（探针路径、PID/状态文件、损坏文件容错）并重写 `test/desktop-runner.test.js`（纯客户端边界断言）；
- **真机安装验收**：以独立 `NEXUS_PROBE_DIR` / `NEXUS_STARTUP_DIR` / `NEXUS_DB_PATH` 在 4313 端口完成 `probe:install → probe:status → probe:stop → probe:start → probe:uninstall` 全流程，确认自启 VBS、启动器、日志与 PID 文件落点正确，探针无窗口运行且 `/health` 返回 `0.2.18`。

---

## 2026-10-25 单中心 Hub 面板与跨区域工作区汇聚 (Single Hub + Remote Workspace Node Isolation & Edge Bridge v0.2.17)

### 改了什么

- **节点身份隔离与跨机 PID 误杀根治 (`src/storage/database.js`, `src/daemon/coordinator.js`, `src/domain/project.js`)**：
  - `agents` 与 `projects` 表新增 `host_id` 字段及自动平滑迁移；
  - `reapDeadAgentLeases`、`reapStaleIntentsAndAgents` 与 `computeAgentLifecycleState` 严格按 `isSameNode(agent.host_id, localNodeId)` 门控本机 `process.kill(pid, 0)` 探针，彻底解决远端工作区（如美西 `us-zenix`）会话上报异机 PID 后被本机 3 秒收割器误判 `ESRCH` 杀锁、闪烁离席的顽疾；
  - 新增 `resolveCanonicalAgentId` 与 8 位缩写会话精准归并规则，根除同一会话先被目录扫描发现、后经无环境变量 Hook 上报时分裂成 `claude-*` 与 `agent-*` 双卡片及同名 8 位前缀误吞并问题。
- **跨操作系统异构路径对齐与同名跨机工程区分 (`src/domain/project.js`, `src/domain/project-registry.js`, `src/hook/nexus-hook.mjs`)**：
  - Windows Hub 处理 Linux POSIX 路径（如 `/root/Claudespace/Project/...`）时走纯 `path.posix` 规范化，绝不污染本机盘符（`d:`），确保远端多会话在中心 Hub 上精确判冲拦截；
  - `ProjectRegistry.listProjects()` 保留不同 `root_path` 的同名跨机仓库并自动标注 `[<host_id>]`（如 `Agent-Nexus [us-zenix]`），不再被本机同名项目静默合并。
- **零守护远端连接配置与边缘同步桥 (`src/transport/auth.js`, `src/daemon/bridge.js`, `src/cli.js`, `src/mcp/stdio.js`, `src/transport/rest.js`)**：
  - 新增 `nexus connect <hub-url> --token <token> [--node-id <id>]` 与 `nexus disconnect`，将远端连接凭据持久化至 `~/.agent-nexus/remote.json`（`0600` 权限），使宿主派生的无环境变量全局 Hook 与 `nexus mcp` 自动直连中心 Hub，跨洋超时自适应放宽至 `1500ms / 2500ms`；
  - 新增 `POST /api/agents/sync-remote` 接口、远端 Hook `peer_sessions` 顺带捎带机制，以及零端口、零数据库的轻量同步命令 `nexus bridge [--once]`：远端新开空闲会话毫秒级上屏，远端关窗退出立即自动回收其持有的编辑锁。
- **前端跨节点徽标与回环令牌安全收敛 (`src/ui/app.js`, `src/ui/style.css`, `src/transport/rest.js`, `src/daemon/index.js`)**：
  - 面板在席会话、独占文件锁卡片与协同路由走廊新增 `🌐 <host_id>` 远端节点徽标及 `· 含远端 N` 统计；
  - 修复前端 `?token=` 查询参数被 `window.__NEXUS_TOKEN__` 覆盖导致 401 的缺陷，并收敛 `index.html` 仅对本机回环请求注入当前实例内存 `localOperatorToken`。

### 验证

- **全量回归与跨节点集成测试**：`node --test "test/*.test.js"` 全量 **285 项**测试全部通过（0 失败），新增 `test/remote-workspace-hub.test.js` 覆盖异构路径、跨机 PID 保活、同名跨机工程区分、真实 Hook 子进程互斥拦截、`sync-remote` 关窗锁回收与 `Edge Bridge` 生命周期；
- **真实浏览器渲染验收**：独立内存实例加载本机 + `us-zenix` 并发会话与文件锁，验证零控制台报错与青空 UI 徽标渲染。

---

## 2026-10-25 支持远端与 Tailnet 部署 (NEXUS_HOST / 固定 NEXUS_ADMIN_TOKEN / CORS Host 自动放行与面板地址动态感知 v0.2.16)

### 改了什么

- **多网卡监听与 Tailnet 支持 (`src/daemon/index.js`)**：
  - 支持 `NEXUS_HOST`（或 `options.host`）环境变量配置绑定地址，允许绑定到 `0.0.0.0` 或内网/Tailscale IP（如 `100.107.77.33`），缺省保持回环 `127.0.0.1` 安全基线；
  - 启动日志根据 host 智能呈现内网可达的面板地址与监听端口。
- **固定管理员凭据持久化支持 (`src/daemon/index.js`, `src/transport/auth.js`)**：
  - `startDaemon` 支持通过 `NEXUS_ADMIN_TOKEN` 环境变量（或 `options.adminToken`）注入固定 operator 令牌，避免服务器 systemd 重启后令牌轮换导致远程 Web 面板或长期脚本凭据失效。
- **同源与同 Host 跨域自动放行 (`src/transport/rest.js`)**：
  - `isOriginAllowed` 自动识别 `origin === 'http://' + req.headers.host` 与 `https`，杜绝远程浏览器通过内网 IP/域名访问时相同 Host 下预检或 POST 触发 403 Origin not allowed。
- **前端控制台服务地址动态感知 (`src/ui/app.js`)**：
  - `initApp` 动态同步页面顶部 `.hub-status-pill` 标签为当前 `location.host`，取代固定显示的 `127.0.0.1:4300`。

### 验证

- **全量回归验证**：`node --test "test/**/*.test.js"` 全量 280 项单测全部通过；
- **专项测试**：在 `test/transport.test.js` 中新增 `NEXUS_HOST 与固定 NEXUS_ADMIN_TOKEN 凭据支持` 用例，覆盖自定义 host 绑定、固定管理员令牌鉴权与 `/api/agents` 权限验证。

---

## 2026-10-23 新会话主动感知、目录监视与前端心跳探针修复 (Active Session Discovery & Watcher v0.2.15)

### 改了什么

- **服务端主动扫描与目录文件监视双引擎 (`src/daemon/coordinator.js`, `src/daemon/index.js`)**：
  - **毫秒级目录监视器 (`watchClaudeSessions`)**：守护进程启动即对 `~/.claude/sessions` 目录挂载带 300ms 防抖的文件监视器，新会话一旦开启并创建 `<pid>.json` 立即触发增量同步；
  - **周期主动扫描兜底**：守护进程主定时器（3s）主动调用 `syncClaudeSessions()`，彻底消除“仅在请求快照时被动顺带同步”的静默盲区；
  - **增量入库与状态事件广播**：`syncClaudeSessions` 发现新会话时发射包含 `is_new: true` 的 `agent:status` 事件与登记日志；当会话由 `departed` 重连复活或状态变更时实时广播，并补齐 `reapStaleIntentsAndAgents` 超时离席事件通知。
- **前端实时全景探针与工程列表联动 (`src/ui/app.js`)**：
  - **WebSocket 轻量周期同步探针**：客户端在保持 WebSocket 活跃连接的同时，定时（4s）向服务端发送轻量 `sync:request` 业务探针，不再仅发送无业务意义的空 ping，杜绝多端状态不同步；
  - **工程与全局在线总数联动 (`debouncedLoadProjects`)**：在收到会话状态、遥测及快照消息时自动防抖刷新工程清单与全局在线计数，彻底解决单工程视图下无法感知跨项目新会话总数的缺陷。
- **系统状态端点补齐 (`src/transport/rest.js`)**：
  - 新增公开端点 `GET /api/status`（包含在席统计、状态计数），彻底解决桌面端托盘 404 轮询报错。

### 验证

- **全量测试套件验证**：`node --test "test/**/*.test.js"` 全量 279 项单测全部通过；
- **新会话专项测试覆盖**：新增 `test/session-discovery-listener.test.js`（5 项），全覆盖新会话发现、状态切换、目录监视与 `/api/status` 接口。

---

## 2026-10-23 租约生命周期与在席判定修复 (Lease Policy & Presence Liveness v0.2.14)

### 改了什么

- **租约生命周期策略化 (`src/daemon/coordinator.js` `LEASE_POLICY`)**：
  - **命名资源锁 TTL 60s → 900s**：实测 19% 的 `tests`/`build`/`dev-server` 授权在命令仍在运行时到期，锁被下一个会话抢走，造成同一份工作区上并行跑测试与构建。PostToolUse 结束时的毫秒级释放保持不变，TTL 只作崩溃兜底；
  - **文件租约 TTL 60s → 300s，并新增续约**：只读工具不触发 Hook，原策略在“读代码 → 思考 → 改写”的纯阅读阶段没有任何续约来源，持有者会在自己的思考过程中丢锁。现在持有者再次写入同一文件即顺延租约（`self-held-lease` / `self-held-resource-lease`），写工具遥测也会滑动续期；
  - **滑动续期硬顶 600s → 1800s**：旧上限短于一次长任务，长任务必然掉锁重抢；上限仍保留，失联会话不会永久占锁。
- **在席判定改用命名管道验证 (`getClaudeSessionRegistry` / `computeAgentLifecycleState` / `reapStaleIntentsAndAgents` / `selfHealDatabase`)**：
  - 会话注册表条目里 `messagingSocketPath` 指向的命名管道是否存在，是宿主进程存活的权威信号，且免疫 Windows PID 复用；
  - 新增 `agents.liveness_verified_at`：管道验证通过即记录时间，2 分钟内免于心急跳门禁；`departed` 会话在管道重新出现时会被复活，而不是永久留一条墓碑；
  - 修复了长回合（>10 分钟无工具调用）和长时间等待用户输入的会话被误判离席的问题。
- **时间线与快照降噪 (`registerAgent` / `recordTelemetry` / `getDashboardSnapshot` / `housekeeping`)**：
  - `agent:registered` 只在新增、改名、重新上线时记录，心跳与每次写工具遥测不再刷屏（实测曾占时间线 41%）；
  - 新增每小时一次、保留 7 天的清理任务，回收 `activity_log` 与已终结 intent；
  - `/api/dashboard` 与 WebSocket 快照默认不再返回 `departed` 会话（实测 194 行里 184 行是历史离席记录），payload 从 ~138KB 降到实际在席规模；需要完整历史时显式传 `includeDeparted: true`。

### 验证

- `node --test "test/**/*.test.js"`：274 项全部通过；
- 新增 `test/lease-policy.test.js`（9 项）与 `test/presence-liveness.test.js`（16 项），直接覆盖上述四类缺陷；
- 并发实测数据来自本机 7 天内的 `activity_log` 与租约流水：0 次跨 Agent 写窗口重叠（文件级互斥本身是有效的），问题集中在租约时长、在席判定与日志噪声。

---

## 2026-10-21 全景会话洞察、PID复用防幽灵与跨工程路由标签 (Multi-Session Global Discovery v0.2.13)

### 改了什么

- **会话发现与跨工程全景呈现 (`src/ui/app.js`, `src/ui/style.css`, `src/daemon/coordinator.js`)**：
  - **默认工程全景回退**：彻底解决用户在多工作区同时开启众多 Claude Code 会话时，控制台因默认贪心锁定单工程导致只显示两三个会话的缺陷；初始化默认回退策略设为跨项目全景 (`id: 'all'`)；
  - **跨项目总数全局指引**：在单工程切片视图下，在席会话栏与路由走廊顶部均展示全局跨项目在线总数，并提供一键切入全景的无损直达链接（`(跨项目共 N 个会话 · 查看全景)`）；
  - **跨工程来源标签 (Project Badges)**：在全景模式下，在席助手卡片与 Lane 1 会话源卡片均自动打上工程简称标签（`.agent-project-badge` 与 `.route-project-badge`），快速区分多目录会话来源。
- **Windows PID 复用防幽灵机制 (Heartbeat-Bounded PID Liveness)**：
  - Windows 系统下长久停留在数据库中的历史离线 Agent，其旧 PID 经常被操作系统重新分配给系统常驻服务（如 `svchost.exe`、`nvcontainer` 等），导致单纯基于 `process.kill(pid, 0)` 误判该 Agent 仍在席；
  - 在 `computeAgentLifecycleState`、`reapStaleIntentsAndAgents` 及数据库启动自愈器 `selfHealDatabase` 中全面引入心跳衰减门禁 (`heartbeatAge <= 600000`)；超过 10 分钟无心跳的 Agent 立即归位为 `departed`，彻底杜绝 PID 复用幽灵在席与僵尸锁占用。
- **状态机与渲染过滤统一**：
  - 前端移除残留的旧版静态 `a.status === 'departed'` 过滤，统一由四级生命周期 `lifecycle_state` (`working` / `waiting` / `idle` / `departed`) 与 `is_online` 驱动，杜绝存活会话被误判隐藏。

### 验证

- **全量测试套件验证**：`node --test "test/**/*.test.js"` 全量 249 项测试通过；
- **全流程语法与静态分析**：无报错，向前向后兼容性完备。

---

## 2026-10-21 修复幽灵工程与WS竞争导致在席会话显示为0的缺陷 (Ghost Project Fix v0.2.12)

### 改了什么

- **修复 WebSocket 请求竞争与幽灵工程回退**：消除项目切换时由于无会话工程被意外覆盖导致的在席会话闪烁为 0 问题；
- **现代化组件样式归一化**：全面清理重复刷新按钮与重叠样式。

---

### 改了什么

- **多模块自适应分割条与折叠管理 (`src/ui/index.html`, `src/ui/app.js`, `src/ui/style.css`)**：
  - **底部决策自由拖拽与一键折叠**：在 View 3 底部裁决面板顶部新增纵向手柄条 `#resizer-routing-decisions`，支持自由拉大或收缩，并配备 `#btn-toggle-decisions` 一键折叠至 38px 紧凑状态栏（双击手柄亦可切换折叠），所有高度偏好自动同步至 `localStorage`；
  - **View 1 / View 2 全模块响应式自适应**：在会话主面板注入横向拖拽条 `#resizer-sessions-split`（调整会话区与流动态占比）与纵向拖拽条 `#resizer-agents-locks`（调整在席助手与独占锁卡片占比）；在动态日志视图注入纵向拖拽条 `#resizer-dialogue-milestones`；
  - **Pointer Events 稳定捕获与重置**：拖拽手柄采用 `setPointerCapture`，杜绝鼠标出界丢帧与文本误选，支持双击一键恢复黄金比例。
- **路由走廊拓宽与阶梯式曲线出站 (Staggered Bezier Rail Geometry)**：
  - **网格间隙拓宽**：将 `.routing-lanes` 列间隙由 14px 拓宽至 36px，并修复响应式媒体查询中的作用域闭合问题；
  - **阶梯出站导轨**：重构 `drawRoutingConnectors` 几何算法，中枢出发端采用线性分步位移 (`y = hubTopY + idx * step`)，彻底消除多文件独占时贝塞尔曲线重合成斑马线的问题；
  - **双向聚焦高亮增强**：鼠标悬停任意会话或目标卡片时，关联路径瞬间明亮发光流动并附加阴影光晕，无关线条自动半透明淡化。
- **会话真名优先呈现与 Hash 脱敏 (Human-Readable Agent Names)**：
  - 建立全局响应式会话注册表 `globalAgentMap` 与 `resolveAgentName` 解析管道；
  - 资源独占卡片（Lane 3）、会话源卡片（Lane 1）、View 1 锁列表以及底部裁决日志中，彻底剥离原始机械 Hash 截断（如 `claude-e044939b`），全面优先呈现人类可读真名或任务语义（如 `由 前端设计对比度与完成度 独占` 或 `由 Worker 助手 独占`），完整技术 ID 仅保留于 hover 浮层中。
- **版本递增与发版归档**：
  - 同步全工程版本至 `v0.2.11`。

### 验证

- **全量测试套件验证**：`node --test "test/**/*.test.js"` 全量 249 项测试通过；
- **真机多视图无头捕获验证**：完成 View 1、View 2、View 3（Light/Dark 主题）全量真机渲染验证。

---

## 2026-10-20 会话路由网关与动态资源走廊图重构 (Session Routing & Conflict Map v0.2.10)

### 改了什么

- **移除知识备忘，升级为多智能体会话路由与防撞拓扑图 (`src/ui/index.html`, `src/ui/app.js`, `src/ui/style.css`)**：
  - **知识备忘彻底精简**：完全剔除原视图 3 冗余的记忆增删查逻辑与 DOM 结构（`#tab-memory`, `#view-memory`, `.memory-*`），收束控制台核心职责于多 Agent 实时并发协调与资源仲裁；
  - **三列流式拓扑泳道架构 (3-Lane Routing Topology)**：
    - **泳道 1 (左侧 - 在席会话源 Sessions)**：实时感知并呈现 Claude Code、Codex、Cursor、CLI 等进场会话，直观展示生命周期状态（`working`/`waiting`/`idle`）、施工意图目标、瞬时动作工具及租约数量；
    - **泳道 2 (中间 - Nexus 仲裁中枢 Arbiter Hub)**：卡片聚合核心仲裁遥测指标，包含 🛡️ 冲突拦截计数、⚡ 毫秒级释放延迟、⏱️ 滑动窗口心跳续约（300s TTL）与 🚦 排队等待队列数；
    - **泳道 3 (右侧 - 施工目标与安全走廊 Target Files & Corridors)**：
      - *独占施工文件 (File Leases)*：实时展示当前处于修改中的确切文件路径、持有者身份与滑动 TTL 倒计时进度条；
      - *排他命令资源锁 (Named Locks)*：展示 `tests`、`dev-server`、`build` 等排他命名锁，标明 PostToolUse 毫秒级释放标签；
      - *安全施工走廊 (Safe Construction Corridors)*：依据当前持有意图与资源锁，动态推导并高亮无并发冲突的可用工程目录与模块（如 `test/`、`desktop/`、`docs/`、`scripts/` 等），为并行 Agent 与开发者提供清晰的免冲突施工通道指引。
  - **动态 SVG 三次贝塞尔曲线与流动动效 (Dynamic SVG Connectors & Flow Dash)**：
    - 采用立方贝塞尔曲线横向平滑连线 (`M x1 y1 C (x1+dx) y1, (x2-dx) y2, x2 y2`)，并在中枢端口按连接数动态分布锚点高度，杜绝多条连线聚拢成单一点；
    - 活跃施工连线配备流水虚线动效 (`stroke-dasharray` + `flowDash`)，阻塞排队连线呈现琥珀色告警脉冲；
    - **双向悬浮联动高亮**：鼠标悬停任意会话卡片即刻高亮其关联的路由流向与目标，反向悬停文件/资源卡片即时高亮上游持有会话，其余无关线条与卡片自适应半透明降级；
    - **ResizeObserver 弹性锚定自适应**：在窗口缩放、分屏贴边或面板折叠时，动态感知容器几何变化并毫秒级重绘曲线。
  - **底部仲裁决策实时流水 (Arbitration Decisions Stream)**：
    - 汇聚展示网关最近的路由与裁决事件，细分 `全部决策`、`独占授权 GRANT`、`冲突拦截 INTERCEPT`、`毫秒释放 RELEASE` 四档筛选胶囊。
- **构建与发版集成**：
  - 更新版本号至 `v0.2.10`，保持全项目单一最新发版归档标准。

### 验证

- **全量测试套件验证**：`node --test "test/**/*.test.js"` 全量 249 项测试通过；
- **前端与拓扑链路验证**：验证 `/api/cockpit` 综合数据聚合与安全施工走廊推导算法，动效与 SVG 连线计算边界严密无畸变。

---

## 2026-10-20 弹窗关闭按钮交互修复与全尺寸自适应响应式重构 (Popover Close Fix & Multi-Tier Responsive Layout v0.2.9)

### 改了什么

- **浮动卡片关闭按钮点击失效根治 (`src/ui/style.css`, `src/ui/app.js`, `src/ui/index.html`)**：
  - **CSS 优先级覆写缺陷修复**：`.lead-popover` 等类声明中的 `display: flex` 原本因 `(0,1,0)` 特异性压制了用户代理的 `[hidden]` 默认行为 `(0,0,0)`；通过追加全局最高优先级重置规则 `[hidden] { display: none !important; }` 与 `.broadcast-popover[hidden], .lead-popover[hidden] { display: none !important; }`，杜绝样式覆盖导致的显隐失控；
  - **双重显隐防御保证**：在 `toggleBroadcastPopover` 与 `toggleLeadPopover` 中结合 `hasAttribute('hidden')` 与 inline `style.display = 'none' / 'flex'` 双重切换，并在关闭按钮点击中绑定 `e.stopPropagation()` 与 `e.preventDefault()` 阻止冒泡穿透；
  - **点击命中穿透优化**：为 `.close-icon-btn svg` 增加 `pointer-events: none`，消除点击落在 SVG 子节点时事件目标捕获漂移问题；
  - **新增 Esc 全局快捷键与无障碍标签**：支持按下键盘 `Escape` 键一键退出所有弹窗，为关闭按钮补齐 `title="关闭"` 与 `aria-label`。
- **全尺寸全屏幕自适应弹性布局重构 (`src/ui/style.css`)**：
  - **Root 弹性伸缩骨架**：`body` 明确采用 `display: flex; flex-direction: column;`，使 `.main-body` 与各视图面板的 `flex: 1; min-height: 0; min-width: 0;` 真正生效；
  - **Grid & Flex 零尺寸收缩守则 (`min-width: 0; min-height: 0;`)**：针对所有面板容器、卡片标题、Agent 身份与锁定文件名全面应用，结合 `text-overflow: ellipsis` 彻底根除窄视口下的文本溢出与宽度撑爆；
  - **多层级阶梯响应式断点 (`@media`)**：
    - **宽屏与超宽屏 (>= 880px / >= 1100px)**：视图 2 (对话记录与演进里程碑) 自动升级为 `1.25fr 1fr` 双栏平铺网格，主屏比例微调；
    - **平板与标准窗口 (<= 768px)**：顶栏状态折叠冗余文案仅保留呼吸脉冲圆点，微调工程选择器宽度与分段导航内边距，状态条紧凑展示；
    - **高密伴侣态与窄窗口 (<= 640px)**：主视图 1 (会话与防撞) 智能折叠为单列上下双卡片，气泡弹窗宽度自适应约束为 `calc(100vw - 16px)`，备忘录新增工具栏自动折行，绝不遮挡；
    - **极限窄视口 (<= 520px)**：导航胶囊仅保留纯图标，状态计数仅显示数字，确保在任意贴边分屏或微型窗口下均严整可用。

### 验证

- **单元与集成测试**：`node --test "test/**/*.test.js"` 全量 249 项测试通过；
- **打包验证**：重新完成 `npm run package:win` 构建并归档至 `Deliverables/Agent-Nexus/`，成功拉起最新桌面程序，弹窗 X 按钮点击即时关闭、Esc 键盘响应瞬时生效，小窗口分屏与宽屏自适应平滑顺畅。

---

## 2026-10-20 原生 PostToolUse 毫秒级资源释放、滑动窗口心跳续约与伴侣控制台重构 (PostToolUse Auto-Release, Sliding-Window TTL & Companion Console v0.2.8)

### 改了什么

- **方案一：原生 PostToolUse 钩子生命周期拦截与瞬态命令锁毫秒级释放 (`src/installer/index.js`, `src/hook/nexus-hook.mjs`, `src/transport/rest.js`)**：
  - **精准分流瞬态命令锁与事务施工走廊**：Claude Code 配置注入 `PostToolUse` 钩子（针对 `Bash` 命令），命令执行完毕后自动触发 `node nexus-hook.mjs --post`；
  - **命令排他锁毫秒级释放**：执行 `npm test`、`pytest`、`npm run dev`、`npm run build` 等排他性资源命令退出时，毫秒级主动调用 `/api/hook/resource-release` 解除资源占用，并立即唤醒等待队列中的排队 Agent；
  - **提交推送完工感知**：执行 `git commit` 或 `git push` 后，自动在后置阶段批量释放所有持有的施工文件租约，实现施工单元终结后的零感交接。
- **方案二：动态滑动窗口心跳续约 (Sliding-Window TTL) (`src/daemon/coordinator.js`, `test/resource-lock.test.js`)**：
  - **基准租约由 180s 降至 60s**：在 `fastCheckAndAutoClaim` 中将资源锁与自锁文件租约初始 TTL 压缩为 60s，异常挂死或失联会话 60s 内快速自然释放；
  - **工具调用遥测自动顺延 (`touchAgentLeases`)**：会话进行读、写、列举等常规工具交互时，上报遥测自动向后顺延 60s 活跃窗口，确保护航施工期间永不掉锁；
  - **600s 最大硬天花板与不倒退原则**：租约生命周期严格受限于 `created_at + 600s` 最大安全上限，避免无限循环死锁，且短心跳绝不反向截断显式声明的长期架构意图。
- **多项目与跨工作树 SQL 联合判冲治理 (`src/daemon/coordinator.js`)**：
  - 在 `findConflict`、`fastCheckAndAutoClaim`、`releaseResourceLock` 和 `releaseAgentLeases` 中统一引入 `(project_id = ? OR project_id = 'default' OR ? = 'default')` 联合判冲，彻底打通独立调试环境 `'default'` 与底层自动解析的真实工程 Worktree Hash 盲区。
- **800x560 极简伴侣控制台 (Companion Console) 3-Tab 高密重构 (`desktop/main.cjs`, `src/ui/app.js`, `src/ui/index.html`, `src/ui/style.css`)**：
  - 窗口尺寸定格为 800x560，适配平铺与分屏协同；
  - 重构为三段式胶囊导航（会话与冲突、时间线与对话、工程记忆与规则），DOM 结构紧凑，全面清除行内事件与冗余依赖，强化 XSS 安全转义与 WebGL/CSS 渲染性能。

### 验证

- `node --test "test/**/*.test.js"`：全部 249 项单元与集成测试 100% 通过（新增 PostToolUse 端到端拦截、滑动窗口顺延与 600s 上限测试）；
- 真实 Claude Code 载荷测试：验证了 `npm test` 命令完成后 tests 锁瞬时解开，排队 Agent 立即放行；`git commit` 成功自动释放施工租约。

---

## 2026-10-19 WebSocket 全量快照渲染中断修复 (WebSocket Snapshot Render Fix)

### 改了什么

- **根除 `init:state` / `sync:response` 推送处理中的未定义函数崩溃 (`src/ui/app.js`)**：
  - 长连接建立或前端发起 `sync:request` 时，服务端会主动推送完整态势快照（`snapshot` 结构为 `{ agents, activeClaims, timeline }`，与 `GET /api/dashboard` 响应同构）；
  - 但前端处理分支调用的是从未定义过的 `renderDashboard(payload.data.snapshot)`，每次推送都抛 `ReferenceError: renderDashboard is not defined`，被 `ws.onmessage` 的 `try/catch` 吞掉，导致该分支后续的驾驶舱渲染与拓扑/看板刷新逻辑被整段跳过；
  - 现将态势渲染抽取为统一入口 `renderDashboardSnapshot(data)`，由 `fetchDashboard()` 与 WebSocket 推送分支共用，保证两条数据通路渲染行为完全一致，并补充快照结构同构的注释说明。

### 验证

- `node --check src/ui/app.js` 通过；`npm test` 245 项全通过；
- 浏览器实测：重载后控制台无任何 `ReferenceError`，`currentDashboardData` 正常持有 13 个会话快照，指标卡、施工泳道、会话巡检表与时间线均随推送即时刷新。

---

## 2026-10-19 动态工程探测架构证明、虚拟全景冲突根除与全界面视觉呼吸间距重构 (Dynamic Workspace Provenance, 'all' Conflict Fix & UI Spacing Overhaul)

### 改了什么

- **工作区数据源动态性证明与管道加固 (`src/domain/project.js`, `src/daemon/coordinator.js`, `src/hook/nexus-hook.mjs`)**：
  - 彻底澄清并加固工作区数据源的动态自适应探测机制，证明 100% 动态发现与实时感知，绝无任何静态硬编码：
    - **本地桌面会话穿透发现**：`getClaudeSessionRegistry()` 动态遍历扫描用户宿主机 `~/.claude/sessions/*.json`，实时提取每个活跃会话的真实 `cwd` 物理路径与窗口元数据；
    - **终端底层 Hook 拦截上报**：各终端触发 `PreToolUse` 时通过 `src/hook/nexus-hook.mjs` 动态向后台上报调用现场的实际 `workspace_dir`；
    - **根目录边界与工程命名解析**：`resolveProject(cwd)` 沿着真实物理路径向上探测多级锚点（`.nexus` > `.git` > `package.json` > `CLAUDE.md`）生成全局唯一哈希 ID；`resolveProjectDisplayName` 则智能识别跨多级目录与工作树结构（如 `solum/server` 等），实现零配置自适应感知。
- **根除虚拟全景标识 `all` 与“全部项目”命名冲突与重复高亮缺陷 (`src/domain/project-registry.js`, `src/daemon/coordinator.js`, `src/ui/app.js`)**：
  - **后端数据库与治理防线**：
    - `ensureProject` 与 `getOrCreateLead` 设置核心门禁，阻断虚拟保留查询标识 `all` 或空字符串作为实体项目插入 `projects` 数据表；
    - `backfillProjectDisplayNames` 在初始化时自动清理历史测试遗留的 `id = 'all'` 脏行；
    - `listProjects` 强制执行 `WHERE id != 'all' AND id != ''` 过滤，确保返回的实体项目字典绝对纯净。
  - **前端下拉选单单点高亮与严格去重**：
    - `src/ui/app.js` 的 `loadProjects` 增加二次安全过滤与 `Set` 唯一去重；
    - 选项拼接时，仅当 `currentProjectId === 'all'` 时高亮顶部首项 `全部项目 (跨工程协同全景)`，实体列表中的项目仅在真实选中且 `currentProjectId !== 'all'` 时标记 `selected`，彻底根除选中全景时折叠框被后面覆盖显示为英文 `all` 的错位缺陷。
- **全界面视觉呼吸感、表格与指标网格间距全面调优 (`src/ui/style.css`)**：
  - **核心指标卡片 Grid 布局规则补齐**：将 `index.html` 中采用的 `.collab-metric-grid` 与 `.collab-metric-box` 纳入网格样式声明，补全 `display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px;` 及移动端/平板自适应媒体查询（`repeat(2, 1fr)` 与 `1fr`），彻底解决之前因缺失 CSS 规则导致的卡片紧贴堆叠与无间距问题；
  - **项目下拉选单尺寸与触控留白重构**：`.proj-select` 采用 `appearance: none;` 清除原生系统样式，配置高对比度自适应 SVG 展开小箭头与 `padding: 7px 32px 7px 14px;`，并设置 `min-width: 180px; max-width: 260px;` 与 `text-overflow: ellipsis;`，彻底根除文字挤压与紧贴右边界的视觉压迫感；
  - **态势巡检表格与卡片间距舒适化**：表格表头与单元格内边距由 `10px 14px` / `12px 14px` 优化升级为 `12px 16px` / `14px 16px`，卡片悬浮过渡增加平滑微位移与阴影，全面提升信息可读性与呼吸韵律。

---

## 2026-10-19 全面去 Emoji 工业化升级与 WCAG AA 双模态对比度重构 (Zero-Emoji Industrial UI & WCAG AA Contrast Overhaul)

### 改了什么

- **界面与通信链路全面剔除 Emoji 字符 (`src/ui/index.html`, `src/ui/app.js`, `src/domain/project-lead.js`, `src/hook/nexus-hook.mjs`)**：
  - 彻底清除桌面界面、项目下拉框、过滤胶囊与卡片标签中的所有 Emoji 字符（如 `🌐`, `🔥`, `🛠️`, `⏳`, `🤖`, `📁`, `🔒`, `⚠️`, `✅`, `💡`, `🚀` 等），统一采用现代简洁的纯中文/英文技术文本配合 SVG 矢量图标，大幅提升工业级沉浸质感与专业度；
  - 架构师唤醒与调度指引中将 `✅ 经核验`、`⚠️ 检测到`、`💡 最佳施工路线`、`⚠️ 你的计划全部处于` 等替换为规范日志标记 `[核准]`、`[冲突警告]`、`[建议]`、`[全部受阻]`；
  - Git 拦截与生命周期 Hook 控制台通知全面移除 Emoji，统一输出 `[Auto-Released]` 与 `[BLOCKED]`。
- **系统级排查并根除对比度过低与颜色融合缺陷 (`src/ui/style.css`, `src/ui/index.html`, `src/ui/app.js`)**：
  - **白底黑字恶性融合根治**：彻底消除亮色模式下白卡内硬编码静态暗色背景（`rgba(15, 23, 42, 0.45)`）导致其内文本“黑底黑字”完全无法辨认的严重视觉融合缺陷，解耦引入 `--action-box-bg: rgba(241, 245, 249, 0.95)` 与 `--action-box-text: #0f172a`（对比度 14.8:1，达 WCAG AAA 级标准）；
  - **白底浅色字泛白隐形根治**：彻底消除白底上硬编码浅绿（`#34d399`，对比度仅 2.04:1）、浅黄（`#fbbf24`，对比度仅 1.62:1）、浅天蓝（`#38bdf8`，对比度仅 2.05:1）导致的模糊泛白，重构双模态状态 Token：亮色模式下改用高对比高饱和深色阶（`--status-running: #047857` 对比度 5.9:1，`--status-waiting: #b45309` 对比度 5.1:1，`--status-blocked: #be123c` 对比度 6.5:1，`--sky-primary: #0369a1` 对比度 6.4:1，`--status-locks: #6d28d9` 对比度 6.8:1），全线达到并超越 WCAG AA 标准；
  - **工具徽标前景色与背景色科学重配**：
    - 针对 Edit / Write 黄色徽标“白字配亮黄”反光刺眼问题，重配为深暖棕文字 `color: #451a03` 配背景 `#f59e0b`（对比度高达 7.8:1）；
    - 针对 Bash 紫色徽标，采用纯白字 `color: #ffffff` 配深紫 `#6d28d9`（对比度 6.8:1）；
    - 针对 Read / Grep / Glob 绿色徽标，采用纯白字 `color: #ffffff` 配深翠绿 `#047857`（对比度 5.9:1）；
  - **巡检表待命行虚焦与过度衰减修复**：废除 `.collab-table tr.collab-row-idle td` 上的全局 `opacity: 0.78` 虚焦滤镜，改为保持 100% 锐度并应用次级文字色阶 `--text-muted`，根除边缘毛刺与辨识障碍；
  - **代码胶囊与空状态图标自适应**：`.target-code-pill` 引入 `--code-pill-bg` 与 `--code-pill-text`（亮色模式下使用浅天蓝胶囊配深天蓝文字，对比度 5.8:1）；拓扑空状态图标颜色绑定至 `var(--sky-primary)`，确保任意主题下清晰辨识。

---

## 2026-10-19 完工待命会话展示权衡、陈旧遥测去噪、施工优先分层与双视口切换胶囊 (Completed Session UX & Telemetry De-noising)

### 改了什么

- **完工待命会话展示深度权衡与双视口切换架构 (`src/ui/index.html`, `src/ui/app.js`, `src/ui/style.css`)**：
  - 针对 Claude Code Desktop 中多会话工作完工转入 `idle` 待命后的展示痛点，实行深度权衡重构：
    - *不全量直接隐藏抹杀*：避免用户对照 Claude 桌面端产生“我的会话怎么突然掉线挂掉了”的虚无感，且待命会话若仍持有临时租约或随后被下达新指令唤醒，必须保持在席被 Nexus 统一纳管；
    - *不平铺混排展示*：平铺展示会造成严重的低信噪比与视线抢占，尤其历史遗留的 `BASH`、修改关键交付文件等标签会制造“后台还在偷跑修改”的虚假恐慌；
  - **双视口快速切换胶囊**：在协同看板顶部 Hero 区域与态势巡检表表头分别新增直观切换按钮——`🌐 全景在席 (含待命)`（默认保持全员在席，分层展示）与 `🔥 仅看活跃施工`（一键过滤全部待命会话，视线极致聚焦在正在改代码改文件和排队阻塞的会话上）。
- **陈旧遥测彻底去噪与活跃/历史工具严格解耦 (`src/daemon/coordinator.js`, `src/ui/app.js`, `src/ui/style.css`)**：
  - 服务端 `getCollaborationGraph` 彻底解耦 `current_tool`/`current_action`/`current_target` 与历史审计字段 `last_tool`/`last_action`/`last_target`：只有当 `lifecycle_state === 'working'` 时才填充活跃工具信息；当会话进入 `idle` 待命时，活跃调用信息一律置为 `null`；
  - 前端态势巡检表与协同卡片全面过滤历史遥测：当会话处于待命状态时，工具列输出弱化灰底的 `<span class="tool-tag idle-standby">待命中 (无调用)</span>`，触达目标输出淡色 `-`，彻底清除误导。
- **施工优先分层排序与在席待命池 (Standby Pool) 收拢 (`src/ui/app.js`, `src/ui/style.css`)**：
  - **协同画布分层重构**：左侧会话列严格拆分为顶部的“活跃施工与排队会话”重点监控区与底部的“在席待命池 (Standby Pool)”；
  - **在席待命池折叠机制**：待命卡片采用 Compact 紧凑规格与对齐 Claude Desktop 原生的空心圆环指示灯（`○`），隐去工具大号徽标，并支持一键折叠/展开；
  - **态势巡检表权重排序**：实行 `working`（施工中 0）-> `waiting`（排队争用 1）-> `idle`（就绪待命 2）绝对优先级排序，确保干活会话与阻塞会话始终置顶，待命会话自动下沉并辅以透明度弱化（`collab-row-idle`）。
- **修复 Claude Code 完工状态实时同步与持久化缺陷 (`src/daemon/coordinator.js`)**：
  - 排查并修复 `syncClaudeSessions` 中由于 SQL 状态保留逻辑导致会话一旦被标记为 `running` 后无法自动回写为 `idle` 的问题，确保与本地 `sess.status === 'busy' ? 'running' : 'idle'` 精准实时双向同步。

---

## 2026-10-19 多分支因果 DAG 拓扑重构、详略分级抽屉、综合全览驾驶舱与 WebSocket 实时长连接 (Multi-Branch DAG, Cockpit & Live WS)

### 改了什么

- **多分支因果演进 DAG 拓扑重构与详略得当分级抽屉 (`src/domain/topology.js`, `src/ui/app.js`, `src/ui/style.css`, `src/ui/index.html`)**：
  - 彻底打破先前拓扑图单一直线的生硬单一链表，建立基于子系统模块（`daemon`、`transport`、`domain`、`ui`、`hook`、`mcp`、`tests`、`docs`、`core`）与因果类型（`causal_file` 代码同文件延续、`module_branch` 子系统分支推进、`milestone_convergence` 里程碑阶段汇聚、`handoff` 任务交接、`unblocked` 冲突解锁唤醒、`sequence` 时序演进）的多分支有向无环图 (DAG)；
  - 拓扑图顶部新增子系统模块交互式 Chip 筛选栏，可单选过滤或一键查看全量子系统分支；
  - 节点设计兼顾宏观条理性与微观细节：画布节点简洁呈现模块标签、类型标识、标题、会话归属与时间；点击任意节点平滑滑出详略得当的侧边抽屉面板（`#topo-node-drawer`），清晰展示因果溯源理由、涉及文件快照、完整摘要以及前驱/后继因果关联链，支持点击直接跳转并高亮前驱/后继节点。
- **综合全览多维驾驶舱功能与前端完整落地 (`src/daemon/coordinator.js`, `src/ui/app.js`, `src/ui/style.css`, `src/ui/index.html`)**：
  - 彻底填补先前“综合全览”Tab 的空白视图，构建企业级高信息密度的四象限全局驾驶舱；
  - 顶部聚合核心关键指标条（在线施工会话数、排队等待数、在席空闲数、排他文件/资源锁数、拓扑演进节点数、跨会话消息数）；
  - 四大象限协同布局：
    - 象限 1：当前活跃在席与施工会话监视舱（实时呈现当前施工工具、操作目标与意图）；
    - 象限 2：演进拓扑简报与最新里程碑视口；
    - 象限 3：资源互斥锁争用态势与等待队列走廊（动态监视锁持有者、剩余 TTL 倒计时、排队阻塞原因）；
    - 象限 4：跨 Session 结构化对话网络与架构师指挥广播实时动态流。
- **WebSocket 全双工长连接与零轮询事件驱动流 (`src/transport/ws.js`, `src/transport/rest.js`, `src/ui/app.js`)**：
  - 根除前端原本每 2.5 秒一次的暴力 HTTP 轮询（`setInterval`），建立纯事件驱动的 WebSocket 全双工长连接通道；
  - 服务端静态交付 HTML 时内置当前活动会话令牌（`window.__NEXUS_TOKEN__`），浏览器直连即刻握手鉴权，长连接首帧服务端自动下发初始化全量状态（`init:state`）；
  - 客户端建立 15 秒心跳保活（`ping/pong`），当服务端主动广播 `agent:telemetry`、`agent:status`、`resource:freed`、`topology:node_created`、`lead:broadcast` 等事件时按需增量局部刷新，DOM 更新增加 500ms 防抖节流保护；
  - 仅在 WebSocket 意外断开且重连中时，才自适应降级为 10 秒低频保底轮询，连上长连接后立即彻底静默 HTTP 轮询；顶栏新增长连接状态指示灯（绿色脉冲灯与状态标签）。
- **四级状态机语义校准与排他锁误释放根除 (`src/daemon/coordinator.js`, `test/topology.test.js`, `test/collaboration-lifecycle.test.js`)**：
  - 深度校准状态机语义：明确“施工中 (`working`)”与“待命中 (`waiting`)”的边界——只要有明确工作执行（包括持有有效代码租约、或执行工具并上报遥测在活跃窗口内），均属于工作施工状态；而“待命/等待 (`waiting`)”严格专指因资源互斥争用、锁排队被阻塞挂起的状态；
  - 彻底修复 Edit 排他锁消失隐患：排查并确保 PreToolUse Hook 的短命子进程不会触发宿主常驻长效租约的提前回收，租约生命周期与常驻 Worker 进程 PID 及 Git Commit 生命周期紧密联动。
- **全量测试与回归验证 (`test/topology.test.js`)**：
  - 新增拓扑模块智能分类、多分支因果前驱推导、综合全览多维聚合数据结构、四级状态机语义校准测试用例；
  - 245 项单元测试 100% 全部通过。

---

## 2026-10-19 根除会话闪烁消失缺陷、全自动语义化会话命名与跨工程协同全景总览 (Session Lifecycle Persistence & Semantic Naming)

### 改了什么

- **彻底根除会话“时有时无、自动消失又出现”的生命周期缺陷 (`src/daemon/coordinator.js`, `src/hook/nexus-hook.mjs`)**：
  - 深度排查并定位先前会话闪烁的根本原因：PreToolUse Hook 每次执行时上报的 PID 是生命周期仅几十毫秒的瞬态子进程 PID，进程退出后协调器静默心跳在 120 秒超时后误判会话离线（`departed`）并在协同图谱中剔除；当下一次调用工具时又因心跳刷新而短暂复现；
  - 打通与 Claude Code Desktop 真实常驻 worker 进程（`~/.claude/sessions/<pid>.json`）长效绑定的探活与常驻注册机制，通过 `getClaudeSessionRegistry` 与 `syncClaudeSessions` 提取真实持久化 `pid`、`sessionId`、工作目录与会话主题；
  - 接入 `process.kill(pid, 0)` 无感探活；只要底层常驻 worker 进程处于运行状态，系统自动维持心跳刷新，解除 120 秒静态超时限制，杜绝反复闪烁、消失与重现。
- **全面淘汰截断哈希与机械编号，采用语义化总结主题命名 (`src/daemon/coordinator.js`, `src/hook/nexus-hook.mjs`, `src/ui/app.js`)**：
  - 彻底清理 `claude-4fcfc1`、`Claude (02da4c9d)`、`Claude 1` 等十六进制哈希与数字编号，建立 `isMechanicalAgentName` 过滤层；
  - 优先读取并回填 Claude Code 原生总结标题（如“AgentHub 移动端 UI”、“Magpie风格runtime设置”、“AgentHub Claude Code 审批权限”）；
  - 无原生标题时优先继承意图摘要 `intent_summary`（如“AI检索优化”）；兜底回退为 `Claude 助手` 等友好语义角色名，严禁拼接十六进制哈希与数字编号；
  - Universal Hook 拦截提示同步透传语义化名称，如 `Lock Holder: [拓扑全览与状态优化]`，提升协作体感。
- **跨工程协同全景总览与 DAG 演进拓扑升级 (`src/domain/topology.js`, `src/domain/memory.js`, `src/domain/messages.js`, `src/ui/app.js`, `src/ui/index.html`)**：
  - 工程下拉菜单中增加 `🌐 全部项目 (跨工程协同全景)`（`value="all"`），配合后端服务在 `projectId === 'all'` 时返回全部活跃会话、跨项目冲突大盘与演进拓扑；
  - 拓扑服务升级多分支有向无环图 (DAG) 智能因果前驱推导算法（优先代码同文件延续因果链 -> 次选同模块主线分支延续 -> 再次关联合并阶段里程碑因果枢纽 -> 兜底最近前驱），坚决打破单一单线链表；
  - 记忆检索与消息会话总览全面支持跨项目汇聚展示。
- **全量测试与工程闭环 (`test/collaboration-lifecycle.test.js`)**：
  - 隔离测试环境与宿主常驻会话注册表，保证单测纯净性；
  - 242 项测试用例 100% 全部通过。

---

## 2026-10-19 离线会话过滤、后端施工态势打通、响应式布局修复与协同图谱默认主视图 (Active-Only Filtering & Responsive Graph)

### 改了什么

- **严格剔除离线会话，只展示施工中与排队中助手 (`src/daemon/coordinator.js`, `src/ui/app.js`)**：
  - 响应用户“不要显示离线的 session，只显示在工作的和等待的”铁律，从协同看板、在席列表和协同图谱中彻底清除历史离线（`departed`）会话卡片；
  - 彻底删除历史离线会话折叠面板，界面仅呈现真实在线施工（`working`）与排队等待（`waiting`）的高信噪比内容；
  - 后端协同图谱自动过滤离线节点与悬空连接边。
- **消除指标矛盾，打通真实后端施工态势 (`src/daemon/coordinator.js`, `src/hook/nexus-hook.mjs`, `src/ui/app.js`)**：
  - 彻底消除顶部架构师视窗与下方指标卡口径不一致的矛盾，统一基于四级状态机 `lifecycle_state` 进行精准统计，真实反映施工与排队会话数；
  - 引入写工具白名单判定机制（`WRITE_TOOLS_SET`），精确识别 `Write`、`Edit`、`MultiEdit`、`NotebookEdit`、`Update`、`apply_patch` 等写操作工具并计入施工态，只读分析工具（`Read`、`Grep`、`Glob`）保持待命，杜绝状态误判；
  - 修复 PreToolUse Hook 中遥测上报与进程退出的异步竞态问题，改用 `await reportTelemetry(...)` 阻塞上报（带 400ms 超时保护），确保进程退出前遥测数据稳定上报中枢。
- **协同图谱升级为系统第一主视图 (`src/ui/index.html`, `src/ui/app.js`)**：
  - 将“多 Session 实时协同防撞车图谱”设定为系统默认主选 Tab 与呈现界面，打开即见直观图形；
  - 以 SVG 动态贝塞尔曲线、流光动画与清晰的二分图谱形式，呈现各会话正在改动的文件、持有的互斥锁与排队因果关系。
- **自适应响应式布局与防组件堆叠修复 (`src/ui/style.css`, `src/ui/index.html`)**：
  - 顶栏全面改为流式自适应高度（`min-height: 68px; height: auto; flex-wrap: wrap;`），并在窄屏视口（<= 1200px）下使 Tabs 弹性折行流式排列，彻底解决“综合全览”Tab 溢出截断 Bug；
  - 底部悬浮全员广播栏优化弹性容器包裹与内边距，小屏下输入框与操作按钮自适应流式排版，外层容器开启 `pointer-events: none` 保护；
  - `body` 底部内边距扩展至 `120px`，主视窗垂直滚动顺畅，彻底消除底部遮挡。
- **全量测试与规范交付 (`test/collaboration-lifecycle.test.js`)**：
  - 验证全部 242 项单元测试 100% 通过；
  - 严格遵守全局工程规范执行打包与交付。

---

## 2026-10-19 数据库乱码彻底清洗、Session 4-Tier 状态机与多会话实时协同防撞车图谱 (Collaboration Graph & Lifecycle Clean)

### 改了什么

- **数据库启动自愈清洗与历史脏数据净化 (`src/storage/database.js`, `src/daemon/coordinator.js`)**：
  - 核心模块引入 `cleanUtf8String`，强力剥离 `�` 替代字符与 ASCII 控制字符（`\x00-\x1F`），彻底过滤无效标点占位；
  - SQLite 启动时自动执行 `selfHealDatabase`：清理超期无心跳孤儿等待队列、熔断超时未释放的僵尸意图、自愈清洗 `intents` 与 `activity_log` 中残存的历史乱码；
  - 根除协同看板上长达 30 小时残留的乱码文件冲突死锁（如 `...whole file is locked by ϵͳ̳פй`）。
- **会话 4-Tier 严格生命周期状态机与 War Room 阶梯排版 (`src/daemon/coordinator.js`, `src/ui/app.js`, `src/ui/style.css`)**：
  - 将所有接入会话严格划分四层状态梯队：
    1. **在线施工中 (`working`)**：持有文件/资源修改租约或处于运行态，正在调用工具改写代码或执行指令；
    2. **排队等待中 (`waiting`)**：正在等待被其他会话占用的冲突文件锁释放，明确展示被谁阻塞；
    3. **在线待命 / 没有工作 (`idle`)**：心跳在线存活，当前持有 0 个锁且未在排队（正在提示符待命或思考分析中）；
    4. **历史离线 (`departed`)**：心跳超时且操作系统进程已死亡，默认折叠收起于 `<details>` 区域，绝不污染活跃协同工作流。
- **下线模型网关，上线多 Session 实时协同防撞车图谱 (`src/ui/index.html`, `src/ui/app.js`, `src/ui/style.css`)**：
  - 彻底移除过剩的“模型网关”视图与导航标签，替换为专为多会话防撞车定制的“协同图谱”(`tab-collab` / `#view-collab`)；
  - 呈现左右双列实时二分拓扑：左侧为会话卡片（显示 Provider、状态、持锁数、当前调用工具 `Edit`/`Write`/`Read`/`Bash`/`Grep`、正在操作的文件路径），右侧为受保护锁资源卡片；
  - 中间通过高帧率平滑贝塞尔曲线（三次贝塞尔）动态连接，以不同发光特效区分租约占用 (`holds_lease`)、排队等待 (`waiting_for`) 与潜在冲突 (`conflict`)，支持鼠标悬浮联动聚焦；底部配备实时协作明细流水表。
- **工具调用态势全量遥测上报 (`src/hook/nexus-hook.mjs`, `src/transport/rest.js`, `src/daemon/coordinator.js`)**：
  - Universal PreToolUse Hook 在拦截判断前，通过非阻塞 HTTP 异步上报会话执行的工具名称、操作目标与动作摘要（支持 `Edit`, `Write`, `Read`, `Bash`, `Grep` 等）；
  - 即使在只读分析或终端执行阶段，中枢也能实时捕捉会话动态并刷新活跃心跳。
- **真实后端状态打通与响应式自适应屏幕**：
  - 前端项目加载逻辑优化，优先自动选中具备真实活跃拓扑节点（180+ 节点）的工程，消除“纯硬编码无后端”假象，并通过 `localStorage` 持久化记忆；
  - 严格遵循 Aozora UI 与 60 FPS 性能铁律，优化多终端（包括宽屏与移动端）流式自适应排版，去除高频全屏重绘。
- **自动化测试拓展与产物发布闭环 (`test/collaboration-lifecycle.test.js`, `scripts/build-exe.cjs`)**：
  - 新增全链路生命周期与协同图谱单元测试，全套 242 项测试 100% 通过；
  - 执行 Windows 平台可执行程序打包，严格遵守产物归档铁律，清理历史构建包，产出唯一的最新发布文件夹与 ZIP 归档于 `Deliverables/Agent-Nexus/`。

---

## 2026-10-18 全面清除硬编码版本号与多端版本对齐 (Version Sync & Hardcode Elimination)

### 改了什么

- **REST 路由动态读取版本 (`src/transport/rest.js`)**：
  - 彻底淘汰 `/health` 端点中硬编码的静态版本字符串，改为动态读取 `package.json` 中的 `version` 字段并回退保底，杜绝后续升级版本遗漏；
  - 访问 `GET /health` 准确返回与当前发布包一致的 `version: "0.2.7"`。
- **前端与构建工具版本同步 (`src/ui/index.html`, `scripts/build-exe.cjs`, `.github/ISSUE_TEMPLATE/bug_report.yml`)**：
  - 修正监控面板底部栏版本号为 `Agent-Nexus 协同调度中枢 v0.2.7`；
  - 同步 Windows 打包工具与 Issue 反馈模板中的版本回退与占位符至 `v0.2.7`。

---

## 2026-10-18 升级 open-setup 规范至“AI 必做全包，人类只做主权点选”二权分立体系 (Open-Setup Binary Standard)

### 改了什么

- **重构发布权责哲学与二权分立体系 (`docs/OPEN_SETUP_GUIDE.md`, `.claude/skills/open-setup/SKILL.md`)**：
  - 彻底淘汰“可以让 AI 做”的模糊中间地带，确立 **“AI 必做全包，人类只做主权点选”** 的绝对执行原则；
  - 凡是 AI 能够自动化、结构化落地的任务（徽章组装、生态上架配置、长尾 SEO 种子、全平台宣发文案、Awesome 列表 PR 等），全部升级为 AI 必须做的强制动作，严禁推诿给工程师；
  - 人类工程师仅需在最后进行受限于账号密码、OAuth 鉴权和社区防刷风控的 5 分钟主权点选与发帖动作。
- **全局与项目级 Skill 同步落地 (`~/.claude/skills/open-setup/SKILL.md`)**：
  - 同步更新本地用户环境全局 Skill 与项目内规范，确保后续所有开源工程可无缝调用 `/open-setup` 实现极速冷启动。

---

## 2026-10-18 根除项目名称哈希与下拉菜单冗余前缀 (Project Display Name Resolution)

### 改了什么

- **前端项目下拉选择框纯净化 (`src/ui/app.js`, `src/ui/index.html`)**：
  - 彻底去除模板字符串中硬编码的 `Project: ` 重复前缀，根除类似 `Project: Project b7e6c7...` 的双重标签；
  - 默认未选状态占位文本规范为标准简洁的 `Default Project`。
- **物理文件系统真实路径与大小写反查 (`src/domain/project.js`)**：
  - 核心模块新增并导出 `resolveProjectDisplayName(rawPath, canonicalPath, explicitId)`；
  - 借助 `fs.realpathSync.native` 穿透大小写不敏感的文件系统映射，精准还原真实物理盘符与目录原始大小写（如 `Agent-Nexus`, `gate`, `agenthub`, `beszel`）；
  - `resolveProject(dir)` 统一挂载真实可读的 `displayName` 属性。
- **单层通用目录名智能语义组合 (`src/domain/project.js`)**：
  - 识别单层通用子工程名（`server`, `client`, `frontend`, `backend`, `web`, `app`, `ui`, `src`），自动与父级目录拼接（如 `solum/server`），消除多模块仓库的同名混淆。
- **存量数据库记录平滑回填与动态兜底 (`src/domain/project-registry.js`, `src/daemon/coordinator.js`)**：
  - `ProjectRegistry` 启动时自动执行 `backfillProjectDisplayNames()`，将现有 SQLite 数据库中的 `Project <hash>` 记录原地升级为真实目录名；
  - `listProjects()` 与 `getProject()` 具备动态实时兜底与映射，并在 Agent 注册落地数据库时按相同规则规范化；
  - 支持 `cliproxyapi` 等非哈希显式 ID 的纯净展示。
- **自动化测试拓展与纪律闭环 (`test/project.test.js`)**：
  - 新增 4 项测试覆盖物理路径解析、通用子目录名组合、自定义项目 ID 规范化以及存量 SQLite 数据库平滑升级；
  - 核心测试套件从 236 项扩充至 240 项，全部 100% 绿色通过。

---

## 2026-10-18 优化桌面端主窗口就绪呈现与加载失败自动重试机制 (Desktop Window Reliability)

### 改了什么

- **桌面端主窗口呈现与重连韧性 (`desktop/main.cjs`)**：
  - **默认直接呈现**：窗口初始化设置 `show: true`，结合 `ready-to-show` 事件，彻底避免因 Electron 渲染或网络探针时延导致的窗口长时间隐藏问题；
  - **网络失败自动重试机制 (`did-fail-load`)**：监听 WebContents 加载失败事件，若后台守护进程冷启动尚未完全就绪，800ms 后自动重新读取最新的免密 Token 并重新加载控制台 URL，实现完全自愈；
  - **项目可读名称解析完善 (`src/domain/project.js`, `src/domain/project-registry.js`, `src/daemon/coordinator.js`)**：增强真实物理路径大小写反查，彻底根除存量哈希显示，提升多工程统览可读性；
  - **打包产物直接验证**：最新生成的独立安装包 `Agent-Nexus.exe` 与后台守护进程双双启动并在用户屏幕上成功渲染。
- **全量测试通过**：236 项核心单元与集成测试保持 100% 绿色通过。

---

## 2026-10-18 v0.2.7 开源生态全景覆盖、AI 深度检索增强与社区物料矩阵 (Ecosystem, Deep GEO & Launch Kit)

### 改了什么

- **工业级 Shields.io 动态徽章墙 (`README.md`, `README_EN.md`)**：
  - 中英双语 README 顶部统一补充 npm 版本号、npm 月下载量、GitHub Release、Node >= 24、236 Tests Passed 及 MIT License 动态徽章，建立开源项目专业成熟度与高信任度形象。
- **全景深度检索规范 `llms-full.txt` 与索引对齐 (`llms-full.txt`, `llms.txt`, `package.json`)**：
  - 遵循 `llmstxt.org` 规范撰写机器全量技术文档 `llms-full.txt`，覆盖系统架构图、三级冲突判定边界算法、13 个 MCP 工具 Schema、REST/WebSocket 全量端点、Git Worktree 对齐原理及 AI 助手答疑 FAQ；
  - 在 `llms.txt` 顶部与底部显式引入 `llms-full.txt` 深度研报锚点，并在 `package.json` 的 `files` 打包白名单中纳入。
- **Smithery.ai MCP 注册表官方适配 (`smithery.yaml`)**：
  - 根目录新增标准 `smithery.yaml` 配置，声明 stdio 启动命令（`npx -y @xiaoran7/agent-nexus mcp`），为上架全球最大 MCP 注册目录打通一键索引。
- **GitHub 开源社区规范与 Issue 体系构建 (`.github/`)**：
  - 新增标准 YAML 格式的 Bug 汇报模板（`bug_report.yml`）与功能建议模板（`feature_request.yml`）；
  - 新增规范的 PR 评审合并模板（`PULL_REQUEST_TEMPLATE.md`），助力 GitHub Community Standards 达到 100% 满分。
- **长尾搜索 SEO 种子问答库 (`docs/DISCUSSIONS_QA_SEEDS.md`)**：
  - 精准提炼 3 篇针对“多 Claude Code 会话冲突”、“Git Worktree 跨目录防撞”与“AI 弹性网关防封”的典型 Q&A 问答文案，供 GitHub Discussions 快速开帖建立 Google / Perplexity 官方解答信源。
- **开源目录收录与 Awesome PR 指南 (`docs/COMMUNITY_SUBMISSIONS.md`)**：
  - 整理针对 `awesome-claude-code`、`awesome-mcp-servers` 的 PR 标题与正文模板，并附带 Smithery 与 Glama 的上架步骤。
- **全平台推广文案物料包 (`docs/LAUNCH_COPYWRITING.md`)**：
  - 编写涵盖 V2EX、知乎、Reddit (r/ClaudeAI)、Hacker News (Show HN) 与 X/Twitter 的完整发帖文案，免去人工撰写烦恼，支持一键复制发布。
- **沉淀通用开源发布规范技能 `open-setup` (`.claude/skills/open-setup/SKILL.md`, `docs/OPEN_SETUP_GUIDE.md`)**：
  - 提炼跨项目、跨机器的标准规范，清晰界定“必须人做”、“AI 必须做”与“可以让 AI 做”的三界职责，全局注册 `/open-setup` 指令供任意开源工程一键启动。
- **全量测试验证**：236 项核心单元与集成测试全部 100% 保持绿色通过。

---

## 2026-10-18 根治乱码、清除硬编码与全端自适应响应式改造 (Encoding, Real Data & Responsive UI)

### 改了什么

- **多字节 UTF-8 乱码彻底根治 (`src/transport/rest.js`, `src/daemon/coordinator.js`, `src/ui/app.js`)**：
  - **网络传输层分片拼装**：在 REST 服务 `readJson` 中采用二进制 Buffer 数组收集流分块，通过 `Buffer.concat(chunks).toString('utf8')` 统一解码，彻底消除多字节 UTF-8 字符在 TCP 数据包边界被截断撕裂导致的乱码；
  - **后端身份防损坏消毒**：完善 `sanitizeAgentName` 与 `formatAgentDefaultName`，规范 Unicode 替换字符（``）、私有区（`-`）及控制字符拦截过滤，同时修复空串判定缺陷，精准保留已注册的真实 Agent 名称；
  - **前端视图标准化渲染**：在控制台新增 `formatAgentDisplayName`，在活跃 Agent 卡片、时间线、记忆库、跨会话对话网络与演进拓扑全链路统一名称显示，提供优雅兜底。
- **全面清除硬编码与伪造 Mock 数据 (`src/ui/index.html`, `src/ui/app.js`, `scripts/seed-nodes.js`)**：
  - **剔除 Mock 模式**：彻底移除前端假候选节点切换器（`gwDemoLoadBtn` / `isDemoMode`）与伪造响应逻辑，真实探测控制台完全直连后端 `/api/gateway/chat`；
  - **动态占位校准**：清除 HTML 静态硬编码（如固定端口 `127.0.0.1:4300` 改为动态 `--`、固定 `1 个会话施工中` 改为动态 `0 个活跃会话`），全部状态与指标均由后端 SSE/REST 真实推送驱动；
  - **删除冗余种子脚本**：删除已废弃的硬编码数据注入脚本 `scripts/seed-nodes.js`。
- **控制台全视口自适应响应式改造 (`src/ui/style.css`, `src/ui/app.js`)**：
  - **流式容器重构**：彻底废除硬编码的固定像素宽（如 `min-width: 1000px`、`width: 440px`），拓扑画布及卡片采用 `width: 100%; max-width: 580px; min-width: 0;` 自适应流式排版；
  - **精细断点分级**：新增 1200px（平板/窄屏）、1024px（单列堆叠布局）、768px（手机/窄平板弹性导航与栅格单列化）、480px（超小屏全宽触控优化）四级响应式断点；
  - **SVG 贝塞尔连线动态重算**：为 `window.resize` 绑定防抖（60ms）的 `redrawTopologyEdges()`，视口缩放时自动基于真实 DOM 坐标实时重算重绘贝塞尔连线，符合 Aozora UI 与 60 FPS 顺滑性能红线。
- **全量测试验证**：236 项核心单元与集成测试全部 100% 保持绿色通过。

---

## 2026-10-18 支持 npm 生态与免安装秒级运行 (@xiaoran7/agent-nexus)

### 改了什么

- **npm 发行配置规范化 (`package.json`)**：
  - 命名空间对齐为 `@xiaoran7/agent-nexus`，配置 `publishConfig.access = "public"`；
  - 增补 `bin` 映射：同时支持 `nexus` 与 `agent-nexus` 双 CLI 命令别名；
  - 增设严谨的 `files` 打包白名单，将非必要的大体积开发资源（如 `desktop/`、`test/`）彻底剔除，解压体积仅 489 KB（压缩 tarball 仅 141 KB），实现秒级轻量下载；
  - 补全 `repository`、`homepage` 与 `bugs` 社区元数据链接。
- **免安装体验指南 (`README.md`, `README_EN.md`, `llms.txt`)**：
  - 首推 `npx @xiaoran7/agent-nexus start` 免克隆即开即用命令；
  - 补充全局安装 `npm install -g @xiaoran7/agent-nexus` 指引。
- **全量测试通过**：236 项核心单元与集成测试全部 100% 绿色通过。

---

## 2026-10-18 修复桌面端独立 EXE 依赖修剪与 WebSocket 运行时完整性 (Desktop Packaging Fix)

### 改了什么

- **打包依赖声明与防剪裁 (`scripts/build-exe.cjs`)**：
  - 在面向 Desktop 的 `package.json` 中完整保留生产依赖 `dependencies`（包含 `ws`），防止 `@electron/packager` 默认行为 prune 导致打包产物缺少 WebSocket 模块；
  - 显式传入 `prune: false`，彻底解决独立打包 EXE 拉起 Daemon 报 `Cannot find package 'ws'` 的问题；
  - 确保独立分发包 `Agent-Nexus.exe` 启动时内置 Daemon 能够秒级就绪并建立长连接。

---

## 2026-10-18 优化开源可发现性与 AI 检索生态支持 (Open-Source Discoverability & LLM-Friendly Indexing)

### 改了什么

- **大模型与外部 AI 搜索导览规范 (`llms.txt`)**：
  - 新增符合标准规范的 `llms.txt`，提供高信息密度的项目定位、使用场景推荐、核心能力清单与主架构文档导览，方便外部 AI 搜索引擎（Perplexity、ChatGPT、Claude Web）快速解析与准确推荐。
- **中英双语国际化与开源门面改造 (`README.md`, `README_EN.md`, `package.json`)**：
  - **痛点与解决方案前置**：在 `README.md` 顶部首屏增加“为什么需要 Agent-Nexus”痛点对照（多 Agent 写覆盖、测试端口争抢、Git 跨工作树冲突）；
  - **同类方案对比矩阵**：引入细粒度的特性对比表（Feature Matrix），强化零侵入 Hook、三级资源锁与弹性网关的独特性，便于大模型结构化抓取；
  - **高质量英文版发布 (`README_EN.md`)**：全面补齐英文版架构说明、特性矩阵与快速启动指引，打破海外语料与全球 AI 检索的语言壁垒；
  - **搜索关键词与元数据扩充 (`package.json`)**：优化项目 Description，新增 `claude-code`, `concurrency-control`, `git-worktree`, `ai-gateway`, `circuit-breaker`, `coding-assistant`, `cursor` 等痛点长尾关键词。
- **Agent 快速入场与模块速查地图 (`AGENTS.md`)**：
  - 增加“核心功能与模块速查地图（Module Map）”，清晰标注冲突判决、Worktree 对齐、网关熔断、共享状态与 Hook 拦截的源码入口及单测对应关系，杜绝新进 Agent 盲目全局扫描。
- **全量测试验证**：236 项核心单元与集成测试全部 100% 通过。

---

## 2026-10-17 实现 Windows 独立图标 EXE 打包与多分辨率 ICO 资产构建 (Windows Standalone Packaging)

### 改了什么

- **Windows 独立 EXE 桌面打包工具链 (`scripts/build-exe.cjs`, `package.json`)**：
  - **打包脚本与流程自动化**：基于 `@electron/packager` 构建纯净的 `win32 x64` 生产级打包管道，支持一键命令 `npm run package:win`；
  - **PE 资源元数据深度注入**：自动注入 `ProductName: Agent-Nexus`、`OriginalFilename: Agent-Nexus.exe`、`CompanyName: TannerLab` 及版权信息；
  - **嵌入式 Daemon 启动修复 (`desktop/daemon-runner.cjs`)**：为托管子进程注入 `ELECTRON_RUN_AS_NODE: '1'`，彻底解决打包后独立主程序调用自身拉起后台守护服务时引发递归启动 GUI 界面的死循环问题；
  - **交付铁律严格归档 (`D:\Claudespace\Deliverables\Agent-Nexus\`)**：打新包自动清理旧包，统一产出并归档解压即用的免安装发布文件夹 `Agent-Nexus-v0.2.6-win32-x64/` 及单文件便携分发包 `Agent-Nexus-v0.2.6-win32-x64.zip`。
- **青空品牌多分辨率 Windows ICO 与托盘微晶图标构建器 (`scripts/generate-icons.cjs`, `desktop/assets/icon.ico`)**：
  - **CDP 离线光栅化**：调用 Headless Edge 浏览器 CDP（Chrome DevTools Protocol）以纯透明底无损渲染 SVG 青空圆角三层等距立方体主标识；
  - **标准 Windows ICO 二进制生成**：原生实现 Windows `ICONDIR` 与 `ICONDIRENTRY` 结构体，聚合 256x256、128x128、64x64、48x48、32x32、16x16 全规格嵌入式 PNG，生成标准 `icon.ico`（58,559 字节）；
  - **多状态系统托盘图标**：输出 32x32 规格的就绪绿（`tray-active.png`）、冲突橙（`tray-busy.png`）与空闲青（`tray-idle.png`）。
- **工程构建配置优化 (`.gitignore`)**：
  - 放行 `scripts/` 构建工具目录入库，将 `.build-temp/` 与 `dist/` 列入忽略清单。
- **全量测试通过**：235 项核心单元与集成测试全部 100% 通过。

---

## 2026-10-17 增加 Agent 宿主 PID 绑定与死亡会话租约提前回收 (Early Lease Reclamation)

### 改了什么

- **Agent 进程级存活感知与自动解阻 (`src/daemon/coordinator.js`, `src/storage/database.js`, `src/hook/nexus-hook.mjs`, `src/ui/app.js`, `src/transport/rest.js`)**：
  - **数据库字段平滑迁移**：在 `agents` 表新增 `pid INTEGER` 列并注入启动热迁移检查；
  - **注册与快速判冲联动**：`registerAgent` 与 `fastCheckAndAutoClaim` 接收并维护会话的宿主 `pid`，并在前端 Agent 卡片中实时呈现 PID 标识；
  - **死亡检测与提前回收 (`reapDeadAgentLeases`)**：利用 `process.kill(pid, 0)` 无破坏性探测持有者系统进程存活状态，一旦捕获目标 Agent 意外退场（ESRCH 死亡），自动标记其状态为 `departed` 并立即提前释放其名下全部排他锁，无缝唤醒后续等待队列，无需被动苦等租约超时；
  - **意图声明即时解阻**：新进 Agent 声明意图时前置触发存活探测与提前回收，杜绝已死进程阻断正常施工；
  - **接口版本对齐**：REST 端点 `/health` 响应版本号对齐至当前发布版本 `0.2.6`；
  - **专项测试套件覆盖 (`test/process-liveness.test.js`)**：覆盖 PID 绑定、死锁检测、存活保护、HTTP Hook 端到端自动认领等 5 项核心验证场景。
- **全量测试通过**：235 项测试用例保持 100% 绿色通过。

---

## 2026-10-17 实现亮色（青空 UI）与暗色双模态主题深度统一及动态热更

### 改了什么

- **双模态设计系统与 CSS 变量级主题引擎 (`src/ui/style.css`, `src/ui/index.html`, `src/ui/app.js`)**：
  - **Aozora UI 亮色体系**：严格对齐青空 UI 规范，蓝白浅灰温润基调，大留白与通透白卡（`rgba(255, 255, 255, 0.94)`），细微冷灰微晶边框（`rgba(203, 213, 225, 0.65)`），消灭所有突兀孤立的硬编码黑框；
  - **通透暗色体系**：深石板青色背景渐变与发光微透卡片，兼顾科技感与护眼对比度；
  - **视觉完全统一**：全面重构 War Room、演进拓扑、模型网关、备忘录抽屉等所有大屏的色彩映射；消灭模板字符串内硬编码 `#fff` 与深色透明背景，表单输入框、下拉框、状态胶囊、SVG 贝塞尔曲线连线全部自适应双模态；
  - **顶栏一键切换与防闪烁 (Anti-FOUC)**：新增带有 Sun/Moon 平滑旋转微动效的外观切换胶囊，自动持久化至 `localStorage.nexusTheme` 并支持 OS `prefers-color-scheme` 探测；在 `<head>` 注入同步内联脚本彻底杜绝加载闪烁。
- **静态前端资源热更与拓扑兼容性防御 (`src/transport/rest.js`, `src/ui/app.js`)**：
  - **静态资源 mtime 热加载**：重构 REST 服务中的静态文件缓存，对比文件磁盘修改时间自动更新缓存，杜绝静态文件更新后必须手动终止进程的问题；
  - **拓扑节点 Claims 容错**：增强拓扑卡片渲染，兼容处理对象形与字符串形文件路径，杜绝空值拆分异常。
- **真实环境自动化验证**：
  - 通过 Headless Edge CDP 自动化截图覆盖 4 种视图在亮色与暗色模式下的 8 张全分辨率渲染实景并完成视觉检查；
  - 全量 230 个单元与集成测试保持 100% 通过。

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