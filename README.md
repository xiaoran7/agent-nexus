# Agent-Nexus

本地多 agent 协调原型，提供资源声明、冲突判定、租约、共享状态与消息。它只协调接入它的调用方，不能阻止任意进程直接写文件。

## 启动与验证

使用支持 `node:sqlite` 的 Node 环境（项目设计基线为 Node 24），从本目录执行：

```powershell
npm.cmd ci
npm.cmd start
npm.cmd test
```

默认面板为 `http://127.0.0.1:4100`，端口可通过 `NEXUS_PORT` 修改；数据库使用 `NEXUS_DB_PATH` 或用户目录下 `.agent-nexus/nexus.db`，`NEXUS_DB_PATH` 的父目录不存在时会自动创建。必须用 `npm ci`（或 `npm install`）安装依赖后再启动：唯一运行时依赖是 `ws`，缺失时 daemon 会在 `src/transport/ws.js` 直接报 `ERR_MODULE_NOT_FOUND`。端口被占用时启动会失败并提示改用 `NEXUS_PORT`，不会带原始堆栈崩溃。

测试用 `node --test` 跑 `test/**/*.test.js`，共 106 个用例：`comprehensive.test.js` 覆盖协调判冲、共享状态与 CAS、消息总线和 MCP 工具分发，`runner.test.js` 覆盖完整协调链路，`transport.test.js` 起真实 HTTP/WS 栈跑端到端、输入校验、跨源策略、Hook 载荷解析、安装器和启动失败处理。测试不证明宿主工具已接入。

daemon 只监听本机，跨源请求默认不放行（浏览器不理会目标地址是否本机，任何网站都能读写你的协调库）。确需跨源时用 `NEXUS_ALLOWED_ORIGINS` 列出来源，逗号分隔；该变量按请求读取，改完无需重启。

## 实现与限制

- `src/daemon/coordinator.js` 实现 file/module/symbol claim、默认 300 秒租约与等待唤醒；输入非法（缺 `agent_id`、claim 目标为空或解析后落在工作目录/盘符根）时抛 `ValidationError`，REST 层映射为 400 且不落任何记录。
- `src/domain/errors.js` 是调用方非法输入的唯一类型；协调、状态、消息三个入口共用它，transport 层统一映射成 400。
- `src/transport/` 提供 REST 和 WebSocket；`src/ui/` 提供面板。
- `src/mcp/server.js` 只有工具定义和处理函数；daemon 未接入标准 MCP 传输端点，不能直接把它当成可连接的 MCP 服务。
- Hook 按真实 PreToolUse 载荷解析写入目标：写入类工具取 `file_path`，Bash 从命令里认重定向/tee/sed -i/cp/mv 的目标（按目的端判定，且必须落在工作目录内）；只读工具不判冲。离线、超时或无法解析响应时放行，daemon 拒绝请求时拦截。它不是操作系统文件锁或强制沙箱。
- `hook:install` 写的是 Claude Code 期望的 matcher 分组结构（已按官方文档核对），并会把历史的字符串写法就地升级；目标配置无法解析时直接报错，不会用空配置覆盖。安装文件存在仍不证明宿主真的会执行。

## 文档

- [API](docs/API.md)：REST、事件和工具处理函数。
- [架构](docs/ARCHITECTURE.md)：组件与租约状态机。
- [Hook](docs/HOOKS.md)：检查流程、安装副作用与接入验收。
