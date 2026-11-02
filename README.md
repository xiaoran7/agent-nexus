# Agent-Nexus

> **多机多会话 Claude Code 零负担并发防撞协调器与跨机工程记忆中枢**
> 
> [English](README_EN.md) | [中文](README.md)

[![npm version](https://img.shields.io/npm/v/@xiaoran7/agent-nexus.svg?style=flat-square&color=0284c7)](https://www.npmjs.com/package/@xiaoran7/agent-nexus)
[![npm downloads](https://img.shields.io/npm/dm/@xiaoran7/agent-nexus.svg?style=flat-square&color=0284c7)](https://www.npmjs.com/package/@xiaoran7/agent-nexus)
[![GitHub Release](https://img.shields.io/github/v/release/xiaoran7/agent-nexus.svg?style=flat-square&color=0284c7)](https://github.com/xiaoran7/agent-nexus/releases)
[![Node Version](https://img.shields.io/badge/node-%3E%3D24-10b981.svg?style=flat-square)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/github/license/xiaoran7/agent-nexus.svg?style=flat-square&color=64748b)](LICENSE)

Agent-Nexus 专为解决多并发 AI 编程会话与跨机开发环境下的**文件互相覆盖、测试端口争抢、Git Worktree 合并冲突与跨机上下文断层**而设计。通过轻量全局 Hook 门禁（`PreToolUse` + `PostToolUse`）、确定性资源锁（File / Module / Symbol / Resource）与无状态边缘探针（Hub + Edge Probe），实现**业务项目 0 改动、0 文件、0 污染**的静默防撞保护与跨机工作接力。

---

### 核心能力与设计边界

| 核心维度 | 裸跑多个会话 | 传统重型锁服务 | **Agent-Nexus** |
|---|---|---|---|
| **业务项目侵入度** | 零防护，频繁发生写覆盖与 Git 冲突 | 需修改业务仓库配置或注入大量样板 | **全局 Hook 一次安装，目标业务项目 0 改动、0 文件、0 污染** |
| **冲突裁决粒度** | 事后手动解决冲突 | 粗粒度整库或单文件排他 | **File（支持 `#anchor` 锚点）/ Module / Symbol / Resource 精确互斥与窄优先唤醒** |
| **跨工作树与跨机支持** | 路径不同即失明，极易合并踩踏 | 不感知 Worktree 与异构 OS 路径 | **基于 Git 共同根（`crewmates`）与 Git Remote 指纹自动对齐异构路径** |
| **异常退出恢复** | 会话崩溃后死锁残留 | 被动等待长 TTL 超时 | **本机命名管道 + PID 探活 / 远端边缘桥心跳，关窗或崩溃即时回收租约** |
| **跨机上下文接力** | 换机器或新开会话后前情丢失 | 无 | **Git 提交自动合成阶段交接工单（Handoff），下游会话通过 Hook `additionalContext` 无感注入** |
| **系统资源消耗** | - | 依赖 Redis / Docker | **纯原生 Node.js 24 + 内置 `node:sqlite` WAL，常驻仅数兆内存** |

---

## 启动与验证

### 1. 免安装启动或源码运行

使用支持 `node:sqlite` 的 Node 24+ 环境：

```bash
# 免安装直接启动中心 Hub 与实时面板
npx @xiaoran7/agent-nexus start
```

```bash
# 或从源码目录安装运行
npm ci
npm start
npm test
```

### 2. 后台常驻探针与桌面托盘客户端（推荐）

探针与桌面端彻底解耦：

- **后台探针（Probe）**：无窗口、无黑框、开机自启的常驻进程，持有中心 Hub、SQLite WAL 数据库与全部协同逻辑；
- **桌面端（Desktop）**：纯客户端外壳（`npm run desktop` 或打包版 `Agent-Nexus.exe`），只连接探针并展示三栏高密度面板（`会话与防撞` / `协同路由` / `接力与记忆`）。

```bash
# 安装本机 Hub 探针并立即后台启动（默认 127.0.0.1:4300）
nexus probe:install
```

```bash
# 探针日常运维与状态检查
nexus probe:status
nexus probe:start
nexus probe:stop
nexus probe:uninstall
```

```bash
# 安装 Claude Code 全局 PreToolUse / PostToolUse 协同钩子
nexus hook:install
```

平台自启落点：

| 平台 | 启动器 | 开机自启 |
|---|---|---|
| Windows | `~/.agent-nexus/probe.cmd` + `probe-bg.vbs` | 启动文件夹下的 `Agent-Nexus Probe.vbs`（`WScript.Shell.Run` 0 号窗口，全程无黑框） |
| Linux | `~/.agent-nexus/probe.sh` | `systemctl --user enable agent-nexus-probe.service`（无 systemd 时退回 XDG autostart） |

### 3. 跨机器多工作区汇聚与接力（Central Hub + Edge Probe）

无需在远端机器（如 Linux 云端编译机 `us-zenix`）额外部署面板或数据库，通过内网/Tailscale 即可将多台机器的会话、文件锁、阶段交接工单与全局工程记忆汇聚到中心 Hub：

```bash
# 1) 在远端工作区绑定中心 Hub（持久化写入 ~/.agent-nexus/remote.json）
nexus connect --hub http://<Hub的Tailscale_IP>:4300 --token <固定管理令牌> --node us-zenix
```

```bash
# 2) 在远端工作区安装全局 Hook 与无端口边缘探针（Edge Probe）
nexus hook:install
nexus probe:install --edge
```

边缘探针（`--edge`）不开端口、不建本地数据库，只监听该机器的 `~/.claude/sessions` 并在本地完成 PID/管道验活后将快照推送给中心 Hub。当任一节点执行 `git commit` 或 `git push` 时，`PostToolUse` 钩子自动释放该会话持有的锁并合成阶段交接工单（Handoff）；另一台机器操作同一 Git 仓库时，`PreToolUse` 钩子自动将上游改动摘要、关键文件与长期工程记忆通过 `hookSpecificOutput.additionalContext` 注入 Claude 上下文。

---

## 外部开源引用与上游溯源 (Open-Source Lineage)

本项目严格遵循开源溯源与模块化协作边界准则：

- **`crewmates` ([asutekku/crewmates](https://github.com/asutekku/crewmates))**：
  - **负责模块**：Git Worktree 主仓库共同根识别（`resolveGitCommonRoot`）、跨工作树相对化路径碰撞检测（`toRepoRelativePath`）与排他性命名资源锁（`tests`, `dev-server`, `build` 等）。
  - **维护边界**：遇相关路径碰撞或工作树识别问题，优先对照上游最新实现。

---

## 文档导航

- [项目规则与模块地图](AGENTS.md)：开发约束与核心源码/单测索引。
- [架构设计与状态机](docs/ARCHITECTURE.md)：核心分层、冲突判定、会话验活与跨机接力原理。
- [API 与 MCP 工具手册](docs/API.md)：REST 端点、WebSocket 事件与 7 项核心 MCP 工具契约。
- [Hook 门禁说明](docs/HOOKS.md)：`PreToolUse` / `PostToolUse` 拦截、释放与上下文注入流程。
- [更新日志](CHANGELOG.md)：版本演进与问题修复记录。
