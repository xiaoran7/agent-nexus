# 项目规则

## 工作约定

- 只在本项目内维护规则、记忆和产物；跨仓操作须有任务依据。先检查 Git 状态，保留其他会话改动；提交、推送、部署分别按用户授权执行。
- 按当前代码、清单和配置核对文档；测试、设备验收和生产状态分别报告，历史记录不能证明当前可用。
- 不提交凭据、私钥、Cookie、真实个人资料或运行数据库。删改前核对路径、归属和用途，不动他人改动、源素材、签名材料及私人日志。
- 发版或部署必须递增实际产品版本并同步相关清单；Android/Harmony 同步 versionCode/versionName。纯文档整理不虚构发版。
- README 放启动与导航；本文件放约束；docs 放契约和经验；CHANGELOG 放历史；MEMORY 放偏好。同一事实只维护一处，删改同步修复引用；Markdown 用 UTF-8 无 BOM。
- 开源引用与上游溯源（铁律 2.6）：引入或吸收外部开源项目（如 `crewmates` 等）时，必须在 README 和 docs 中明确标注职责边界与仓库；排查故障时必须先拉取上游最新 Release/Commit/Issue，后考虑本地修复。
- 临时产物放本项目 `_scratch/`，交付物用项目既定路径或 `Deliverables/`；验证新版后清理本项目过期产物，保留必要回滚及指定基线。收尾只停止本次启动的进程。

## 项目边界

- 协调为协作约定，不能宣称 Hook 是强制文件锁；配置写入与宿主执行必须分开验收。
- 遵循对目标业务项目“0 改动、0 文件、0 污染”原则：通过本机或远端节点 `~/.claude/settings.json` 全局 Hook 静默生效，不在业务项目中创建 `.mcp.json` 或写入样板规则。

## 核心功能与模块速查地图 (Module Map)

| 核心诉求 / 业务模块 | 关键源码入口 | 权威单测验证 |
|---|---|---|
| **资源冲突协调与等待唤醒** | `src/daemon/coordinator.js` | `test/comprehensive.test.js` |
| **Git Worktree 共同根与相对化对齐 (`crewmates`)** | `src/domain/project.js` | `test/project.test.js` |
| **常驻算力节点拓扑与边缘心跳** | `src/domain/cluster-nodes.js`, `src/probe/index.js` | `test/probe.test.js`, `test/cluster-handoff.test.js` |
| **跨机阶段工作交接工单 (`Handoff`)** | `src/domain/handoff.js` | `test/cluster-handoff.test.js` |
| **全局长期工程记忆 (`ProjectMemory`)** | `src/domain/memory.js` | `test/memory.test.js` |
| **SQLite WAL 存储与原子事务** | `src/storage/database.js` | `test/helpers.js` |
| **PreToolUse / PostToolUse 全局门禁与上下文注入** | `src/hook/nexus-hook.mjs` | `test/transport.test.js`, `test/cluster-handoff.test.js` |
| **跨节点单 Hub 汇聚与无状态边缘桥 (`connect` / `bridge`)** | `src/daemon/bridge.js`, `src/transport/auth.js` | `test/remote-workspace-hub.test.js` |
| **标准 Stdio MCP 传输端点 (7 项核心工具)** | `src/mcp/stdio.js`, `src/mcp/server.js` | `test/mcp-stdio.test.js` |
| **桌面端纯客户端托盘外壳** | `desktop/main.cjs`, `desktop/panel-state.cjs` | `test/desktop-runner.test.js` |

长期偏好见 [MEMORY.md](MEMORY.md)。
