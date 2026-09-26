# Hook 接入

实现为 `src/hook/nexus-hook.mjs`。从 stdin 的 PreToolUse 载荷解析一个写入目标，再调用 `/api/hook/check`。冲突时退出码 2，允许时退出码 0。

## 目标解析

- 写入类工具（Write/Edit/MultiEdit/NotebookEdit/Update/apply_patch）直接取 `tool_input.file_path`；只读工具（Read/Grep/Glob…）不判冲。
- Bash 没有 `file_path`，从命令里解析，但有两个前提，缺一不可：命令确实是写入动作（`>`、`tee`、`sed -i`、`cp`/`mv`/`install`），且目标路径落在工作目录之下。前者避免把 `cat a.js` 误判成写入，后者避免全局 hook 拿别处的路径来判冲。
- `cp`/`mv` 按**目的端**（最后一个路径参数）判冲，不是源端。
- 一次 Bash 调用只检查一个文件；shell 写入、绕过 Hook 的工具及宿主未接入的调用不受它约束。
- 工作目录取载荷里的 `cwd`（宿主告诉我们的调用位置），退回 `CLAUDE_PROJECT_DIR`。

## 边界

- 默认连接 `127.0.0.1:4100`，由 `NEXUS_HOST` / `NEXUS_PORT` 覆盖，请求超时 1000ms。
- 离线、超时、响应无法解析或无目标文件均放行；不是强制文件访问控制。
- daemon 明确拒绝请求（HTTP 4xx，如目标文件缺失）时**拦截**并退出码 2。协调库说"评估不了"不等于"没有冲突"，直接放行会把这类请求静默通过。
- 身份优先取 `NEXUS_AGENT_PROVIDER` / `NEXUS_SESSION_ID`，再尝试载荷和各工具会话变量，最后使用 PID。

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

daemon 地址写入时读 `NEXUS_URL`，默认 `http://127.0.0.1:4100`；与 daemon 实际监听端口（`NEXUS_PORT`）需保持一致。
