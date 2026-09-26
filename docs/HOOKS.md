# Hook 接入

实现为 `src/hook/nexus-hook.mjs`。从 stdin 工具载荷、命令参数或环境变量解析一个文件目标，再调用 `/api/hook/check`。冲突时退出码 2，允许时退出码 0。

## 边界

- 默认连接 `127.0.0.1:4100`，由 `NEXUS_HOST` / `NEXUS_PORT` 覆盖，请求超时 1000ms。
- 离线、超时、响应无法解析或无目标文件均放行；不是强制文件访问控制。
- daemon 明确拒绝请求（HTTP 4xx，如目标文件缺失）时**拦截**并退出码 2。协调库说"评估不了"不等于"没有冲突"，直接放行会把这类请求静默通过。
- 多文件载荷只检查第一个文件；shell 写入、绕过 Hook 的工具及宿主未接入的调用不受它约束。
- 身份优先取 `NEXUS_AGENT_PROVIDER` / `NEXUS_SESSION_ID`，再尝试载荷和各工具会话变量，最后使用 PID。

## 安装器

从任意目录执行 `node src/cli.js hook:install --claude|--codex|--zcode`（不传目标会尝试全部安装）。hook 脚本路径由脚本自身位置推导，**与执行目录无关**；写出的命令是绝对路径，且安装前会确认该文件真实存在。

安装器会写用户配置。目标文件是合法 JSON 时按字段合并，保留其他 runtime 和你已有的设置；**目标文件无法解析或形状异常时直接报错并原样保留**，不会拿空配置覆盖。Codex/ZCode 同样走合并而非整份覆盖。

它不会验证宿主是否支持该格式，也不会验证写入的 hook 会被执行。

| 目标 | 写入位置 | 验收要求 |
|---|---|---|
| Claude | `~/.claude/settings.json` 的 `hooks.PreToolUse` | 核对宿主支持的格式，并实际触发允许/冲突调用 |
| Codex | `~/.agenthub/coordinator.json` | 需要宿主读取并执行此配置；写文件不能证明 Codex 原生支持 |
| ZCode | `~/.zcode/nexus-guard.json` | 需要对应 runtime 适配及端到端验收 |

daemon 地址写入时读 `NEXUS_URL`，默认 `http://127.0.0.1:4100`；与 daemon 实际监听端口（`NEXUS_PORT`）需保持一致。
