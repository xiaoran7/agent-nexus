# 项目规则

## 工作约定

- 只在本项目内维护规则、记忆和产物；跨仓操作须有任务依据。先检查 Git 状态，保留其他会话改动；提交、推送、部署分别按用户授权执行。
- 按当前代码、清单和配置核对文档；测试、设备验收和生产状态分别报告，历史记录不能证明当前可用。
- 不提交凭据、私钥、Cookie、真实个人资料或运行数据库。删改前核对路径、归属和用途，不动他人改动、源素材、签名材料及私人日志。
- 发版或部署必须递增实际产品版本并同步相关清单；Android/Harmony 同步 versionCode/versionName。纯文档整理不虚构发版。
- README 放启动与导航；本文件放约束；docs 放契约和经验；CHANGELOG 放历史；MEMORY 放偏好。同一事实只维护一处，删改同步修复引用；Markdown 用 UTF-8 无 BOM。
- 开源引用与上游溯源（铁律 2.6）：引入或吸收外部开源项目（如 crewmates、Magpie 等）时，必须在 README 和 docs 中明确标注职责边界与仓库；排查故障时必须先拉取上游最新 Release/Commit/Issue，后考虑本地修复。
- 临时产物放本项目 `_scratch/`，交付物用项目既定路径或 `Deliverables/`；验证新版后清理本项目过期产物，保留必要回滚及指定基线。收尾只停止本次启动的进程。

## 项目边界

- 协调为协作约定，不能宣称 Hook 是强制文件锁；配置写入与宿主执行必须分开验收。

## 核心功能与模块速查地图 (Module Map)

| 核心诉求 / 业务模块 | 关键源码入口 | 权威单测验证 |
|---|---|---|
| **资源冲突判决与等待唤醒** | `src/daemon/coordinator.js` | `test/comprehensive.test.js` |
| **Git Worktree 共同根与相对化对齐 (`crewmates`)** | `src/domain/project.js` | `test/project.test.js` |
| **弹性 AI 网关与熔断冷却 (`Magpie`)** | `src/domain/gateway-router.js` | `test/gateway-router.test.js` |
| **命名空间共享状态与原子 CAS (`agent-comm`)** | `src/domain/state.js` | `test/comprehensive.test.js` |
| **点对点通信与广播协调消息流** | `src/domain/messages.js` | `test/inter-session-dialogue.test.js` |
| **SQLite WAL 存储与原子事务** | `src/storage/database.js` | `test/helpers.js` |
| **PreToolUse 拦截门禁与命令推导** | `src/hook/nexus-hook.mjs` | `test/transport.test.js` |
| **标准 Stdio MCP 传输端点** | `src/mcp/stdio.js`, `src/mcp/server.js` | `test/mcp-stdio.test.js` |

长期偏好见 [MEMORY.md](MEMORY.md)。

<!-- NEXUS-COORDINATION-START -->
## Agent-Nexus 多 Agent 并发协同与工程记忆纪律

本工程已接入 **Agent-Nexus** 协同中枢与常驻 AI 架构师（Tech Lead）。所有在本工作区并发作业的 AI Agent 必须遵守以下协同三原则：

1. **进场声明意图（Onboarding）**：
   - 开工前调用 MCP 工具 `nexus_onboard` 申报任务意图与预期修改文件列表；
   - 若遇到资源占用，系统将自动划分出“安全施工走廊（safeToStart）”与“避障等待队列（mustWait）”，请优先开发空闲模块，避免盲目重试。

2. **排他资源锁与跨工作树防撞（Resource Locks & Worktree）**：
   - 运行独占性命令前申报排他资源锁（例如 `tests`、`dev-server`、`build`）；
   - 在 Git Worktree 中修改文件时，Nexus 会自动基于主仓库共同根做跨工作树相对化对齐，若出现 `CROSS-WORKTREE CONFLICT` 警示，必须立即规避以杜绝 Git 合并冲突。

3. **完工释放与经验沉淀（Release & Long-Term Memory）**：
   - 阶段任务完工后立即调用 `nexus_release_lease` 释放锁定，唤醒后排等待会话；
   - 重大架构决策、避坑经验与代码规约，调用 `nexus_save_memory` 沉淀到项目的长期记忆库中，供后续会话持续复用；
   - 达成里程碑时调用 `nexus_report_milestone` 广播战果。
<!-- NEXUS-COORDINATION-END -->

