# Hook 接入

实现为 `src/hook/nexus-hook.mjs`。从 stdin 的 PreToolUse 载荷解析一个写入目标，再调用 `/api/hook/check`。冲突时退出码 2，允许时退出码 0。

## 目标解析

- 写入类工具（Write/Edit/MultiEdit/NotebookEdit/Update/apply_patch）直接取 `tool_input.file_path`；只读工具（Read/Grep/Glob…）不判冲。
- **Git 生命周期零感释放 (Git Commit / Push Auto-Release)**：Bash 工具优先探测 `git commit` 或 `git push`（`GIT_LIFECYCLE_COMMAND_RE`）。当 Agent 阶段性完成代码提交或推送时，Hook 自动向 `/api/hook/git-release` 派发异步释放通知，瞬间解开该 Agent 持有的所有文件与资源租约，并立即唤醒后排等待者，彻底消除 TTL 倒计时卡壳。
- **命名排他资源自动推导**：Bash 工具优先匹配高排他命令正则（`extractBashResource`）：
  - 测试命令（`npm test`、`cargo test`、`pytest`、`go test` 等）自动映射为 `tests` 资源锁；
  - 启动服务（`vite`、`npm run dev`、`next dev`、`uvicorn` 等）自动映射为 `dev-server` 资源锁；
  - 打包构建（`npm run build`、`cargo build`、`mvn package` 等）自动映射为 `build` 资源锁。
  遇到已有其他 Agent 持锁时立即以退出码 2 优雅拦截并提醒等待。
- **高信息密度冲突拦截诊断**：当拦截到写入或命令冲突时，Hook 在 stderr 打印结构化避障卡片：
  - 明确标注冲突文件/资源与当前持锁 Agent（含其所在工作区目录）；
  - 打印剩余租约预估等待时间（`ETA: ~Xs`）；
  - 提供可操作避障指引（建议先阅读其他代码、切换非冲突模块，或等待对方 `git commit` 自动释放）。
- **文件写入解析**：Bash 从命令里解析写入目标，有两个前提，缺一不可：命令确实是写入动作（`>`、`tee`、`sed -i`、`cp`/`mv`/`install`），且目标路径落在工作目录之下。前者避免把 `cat a.js` 误判成写入，后者避免全局 hook 拿别处的路径来判冲。
- `cp`/`mv` 按**目的端**（最后一个路径参数）判冲，不是源端。
- **跨工作树对齐（Git Worktree）**：Hook 自动解析工作树共同主仓库，将跨工作树的绝对路径统一映射到 `projectRoot` 相对路径。若检测到其他工作树正锁住该文件，发出 `CROSS-WORKTREE CONFLICT` 拦截，防止合并冲突。
- 一次 Bash 调用只检查一个文件或一个资源；shell 写入、绕过 Hook 的工具及宿主未接入的调用不受它约束。
- 工作目录取载荷里的 `cwd`（宿主告诉我们的调用位置），退回 `CLAUDE_PROJECT_DIR`。

## 边界

- 默认连接本机 `127.0.0.1:4300`（本地请求超时 `400ms` 遥测 / `1000ms` 判冲）。
- **跨机器连接中心 Hub**：在远端工作区执行 `nexus connect http://<hub-host>:4300 --token <token> [--node-id us-zenix]` 后，连接地址、鉴权令牌与节点标识持久化写入 `~/.agent-nexus/remote.json`（权限 `0600`）。宿主无环境变量启动 Hook 或 `nexus mcp` 时均会自动读取该文件，跨网超时放宽至 `1500ms`（遥测）/ `2500ms`（判冲与释放），并顺带捎带边缘本地已验活的 `peer_sessions`。执行 `nexus disconnect` 可清除远端绑定还原为本机模式；也可运行零端口、零数据库的 `nexus bridge` 实时推送远端空闲会话与退场事件。
- 离线、超时、响应无法解析或无目标文件均放行；不是强制文件访问控制。
- daemon 明确拒绝请求（HTTP 4xx，如目标文件缺失或令牌错误）时**拦截**并退出码 2。协调库说"评估不了"不等于"没有冲突"，直接放行会把这类请求静默通过。
- 身份优先取 `NEXUS_AGENT_PROVIDER` / `NEXUS_SESSION_ID`，再尝试载荷和各工具会话变量，最后使用 PID（远端模式下自动拼入 `nodeId` 防跨机 PID 撞车）。

## 安装器

从任意目录执行 `node src/cli.js hook:install --claude|--codex|--zcode`（不传目标会尝试全部安装）。hook 脚本路径由脚本自身位置推导，**与执行目录无关**；写出的命令是绝对路径，且安装前会确认该文件真实存在。

安装器会写用户配置。目标文件是合法 JSON 时按字段合并，保留其他 runtime 和你已有的设置；**目标文件无法解析或形状异常时直接报错并原样保留**，不会拿空配置覆盖。Codex/ZCode 同样走合并而非整份覆盖。

它不会验证宿主是否支持该格式，也不会验证写入的 hook 会被执行。

| 目标 | 写入位置 | 验收要求 |
|---|---|---|
| Claude | `~/.claude/settings.json` 的 `hooks.PreToolUse` | 结构已按官方文档核对：`[{ matcher, hooks: [{ type: "command", command, timeout }] }]`。仍需实际触发一次允许/冲突调用确认宿主真的会执行 |
| Codex | `~/.agenthub/coordinator.json` | 需要宿主读取并执行此配置；写文件不能证明 Codex 原生支持 |
| ZCode | `~/.zcode/nexus-guard.json` | 需要对应 runtime 适配及端到端验收 |

matcher 只列 `Bash|Write|Edit|MultiEdit|NotebookEdit`，不是 `*`：每条命令都会起一次 node 进程，而 hook 单次预算只有 1000ms。

daemon 地址写入时读 `NEXUS_URL`，默认 `http://127.0.0.1:4300`；与 daemon 实际监听端口（`NEXUS_PORT`）需保持一致。
