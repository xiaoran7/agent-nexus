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

**启动需要令牌。** daemon 启动时打印一枚 operator 令牌（read + write + mint），只打印一次、不落盘，重启即轮换。除 `/health` 和面板 HTML 外，`/api/*` 与 WebSocket 缺令牌一律 401。换一枚绑定具体 agent 的令牌：

```bash
NEXUS_ADMIN_TOKEN=<启动时打印的令牌> node src/cli.js token <agent-id>
```

agent 令牌只能读自己的收件箱（读别人的 403），也不能签发令牌。身份以令牌为准，不采信请求体里的 `from`——那是调用方可控的字段，自称 `claude` 的陌生进程和真 Claude Code 无法区分。面板打开 `http://127.0.0.1:4100/?token=<你的令牌>`，令牌会存进 sessionStorage；WebSocket 令牌只能走查询参数，浏览器发不了自定义头。

测试用 `node --test` 跑 `test/**/*.test.js`，共 158 个用例：`comprehensive.test.js` 覆盖协调判冲、路径分段边界、等待队列的可用性复核与宽窄重排、共享状态与 CAS、消息总线和 MCP 工具分发，`runner.test.js` 覆盖完整协调链路，`transport.test.js` 起真实 HTTP/WS 栈跑端到端、输入校验、认证与令牌隔离、跨源策略、Hook 载荷解析、安装器和启动失败处理，`project.test.js` 覆盖多层目录的项目边界探测与路径归一化，`project-scope.test.js` 覆盖多项目资源与状态隔离，`project-lead.test.js` 覆盖 Project Lead 进场避障排期与 MCP 联动，`notification.test.js` 覆盖主动释放通知与 SSE 实时事件通道。测试不证明宿主工具已接入。

daemon 只监听本机，跨源请求默认不放行（浏览器不理会目标地址是否本机，任何网站都能读写你的协调库）。确需跨源时用 `NEXUS_ALLOWED_ORIGINS` 列出来源，逗号分隔；该变量按请求读取，改完无需重启。令牌与跨源白名单是两道独立的闸：白名单管"哪个网页"，令牌管"哪个进程"。

## 实现与限制

- `src/daemon/coordinator.js` 实现 file/module/symbol claim、默认 300 秒租约与等待唤醒；输入非法（缺 `agent_id`、claim 目标为空或解析后落在工作目录/盘符根）时抛 `ValidationError`，REST 层映射为 400 且不落任何记录。
- `src/domain/errors.js` 是调用方非法输入的唯一类型；协调、状态、消息三个入口共用它，transport 层统一映射成 400。
- `src/transport/auth.js` 负责令牌签发与校验。令牌只在运行中的 daemon 内存里，不落盘。
- `src/transport/` 提供 REST 和 WebSocket；`src/ui/` 提供面板。
- `src/mcp/server.js` 只有工具定义和处理函数；daemon 未接入标准 MCP 传输端点，不能直接把它当成可连接的 MCP 服务。因此**目前没有任何 agent 会主动发消息**——`POST /api/messages` 通道是通的，但 hook 只调 `/api/hook/check`，MCP 工具层又没接上。
- Hook 按真实 PreToolUse 载荷解析写入目标：写入类工具取 `file_path`，Bash 从命令里认重定向/tee/sed -i/cp/mv 的目标（按目的端判定，且必须落在工作目录内）；只读工具不判冲。离线、超时或无法解析响应时放行，daemon 拒绝请求时拦截。**daemon 拒绝含 401/403 时同样拦截**：拿不到令牌就无法证明协调库知道这个文件，此时放行等于没检查。它不是操作系统文件锁或强制沙箱。
- Hook 从 `NEXUS_TOKEN` 读令牌。装到全局的 hook 不继承用户 shell 环境，这个变量得由宿主注入或写进安装器写下的配置——`hook:install` 目前不写它，这是接入前必须补的一步。
- `hook:install` 写的是 Claude Code 期望的 matcher 分组结构（已按官方文档核对），并会把历史的字符串写法就地升级；目标配置无法解析时直接报错，不会用空配置覆盖。安装文件存在仍不证明宿主真的会执行。
- WebSocket 广播仍是全员可见：令牌挡的是"谁能连上"，连上之后看到的是所有 agent 的时间线与状态变更。按连接区分推送范围没有做。

## 文档

- [API](docs/API.md)：REST、事件和工具处理函数。
- [架构](docs/ARCHITECTURE.md)：组件与租约状态机。
- [Hook](docs/HOOKS.md)：检查流程、安装副作用与接入验收。
