# Hook 接入

实现为 `src/hook/nexus-hook.mjs`。从 stdin 工具载荷、命令参数或环境变量解析一个文件目标，再调用 `/api/hook/check`。冲突时退出码 2，允许时退出码 0。

## 边界

- 默认连接 `127.0.0.1:4100`，由 `NEXUS_HOST` / `NEXUS_PORT` 覆盖，请求超时 1000ms。
- 离线、超时、响应无法解析或无目标文件均放行；不是强制文件访问控制。
- 多文件载荷只检查第一个文件；shell 写入、绕过 Hook 的工具及宿主未接入的调用不受它约束。
- 身份优先取 `NEXUS_AGENT_PROVIDER` / `NEXUS_SESSION_ID`，再尝试载荷和各工具会话变量，最后使用 PID。

## 安装器

从本项目根目录运行 `node src/cli.js hook:install --claude|--codex|--zcode`，不传目标会尝试全部安装。安装器会写用户配置，使用前检查 `src/installer/index.js` 并备份已有配置；它不会验证宿主支持该格式。

| 目标 | 写入位置 | 验收要求 |
|---|---|---|
| Claude | `~/.claude/settings.json` 的 PreToolUse | 核对宿主支持的格式，并实际触发允许/冲突调用 |
| Codex | `~/.agenthub/coordinator.json` | 需要宿主读取并执行此配置；写文件不能证明 Codex 原生支持 |
| ZCode | `~/.zcode/nexus-guard.json` | 需要对应 runtime 适配及端到端验收 |

安装器读取错误时可能使用空配置重写；Codex/ZCode 分支直接覆盖目标配置。此处记录实际行为，不代表已在各宿主验证。
