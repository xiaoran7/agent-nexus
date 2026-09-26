# Agent-Nexus

本地多 agent 协调原型，提供资源声明、冲突判定、租约、共享状态与消息。它只协调接入它的调用方，不能阻止任意进程直接写文件。

## 启动与验证

使用支持 `node:sqlite` 的 Node 环境（项目设计基线为 Node 24），从本目录执行：

```powershell
npm.cmd start
npm.cmd test
```

默认面板为 `http://127.0.0.1:4100`，端口可通过 `NEXUS_PORT` 修改；数据库使用 `NEXUS_DB_PATH` 或用户目录下 `.agent-nexus/nexus.db`。测试使用内存 SQLite，不证明宿主工具已接入。

## 实现与限制

- `src/daemon/coordinator.js` 实现 file/module/symbol claim、默认 300 秒租约与等待唤醒。
- `src/transport/` 提供 REST 和 WebSocket；`src/ui/` 提供面板。
- `src/mcp/server.js` 只有工具定义和处理函数；daemon 未接入标准 MCP 传输端点，不能直接把它当成可连接的 MCP 服务。
- Hook 仅检查解析出的目标文件，`files` 数组只取第一个；离线、超时或无法解析响应时放行。它不是操作系统文件锁或强制沙箱。
- `hook:install` 会改写用户配置；安装文件存在不证明 Claude/Codex/ZCode 实际执行 Hook。当前 CLI 没有实现 `nexus start`，请使用 `npm start`。

## 文档

- [API](docs/API.md)：REST、事件和工具处理函数。
- [架构](docs/ARCHITECTURE.md)：组件与租约状态机。
- [Hook](docs/HOOKS.md)：检查流程、安装副作用与接入验收。
