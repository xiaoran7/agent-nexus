# Hook 接入与执行机制

实现为 `src/hook/nexus-hook.mjs`。通过 Claude Code 全局 `PreToolUse` 与 `PostToolUse` 两个生命周期钩子协同运作，对业务项目保持 **0 改动、0 文件、0 污染**。

## 一、PreToolUse 拦截与上下文注入

- **文件写入解析**：写入类工具（Write/Edit/MultiEdit/NotebookEdit/Update/apply_patch）直接取 `tool_input.file_path`；只读工具（Read/Grep/Glob 等）不判冲。
- **Bash 文件写入解析**：Bash 从命令里解析写入目标，需同时满足两个前提：命令确实是写入动作（`>`、`tee`、`sed -i`、`cp`/`mv`/`install`），且目标路径落在工作目录之下。`cp`/`mv` 按**目的端**（最后一个路径参数）判冲，不是源端。
- **命名排他资源自动推导**：Bash 工具自动匹配高排他命令正则（`extractBashResource`）：
  - 测试命令（`npm test`、`cargo test`、`pytest`、`go test` 等）自动映射为 `tests` 资源锁；
  - 启动服务（`vite`、`npm run dev`、`next dev`、`uvicorn` 等）自动映射为 `dev-server` 资源锁；
  - 打包构建（`npm run build`、`cargo build`、`mvn package` 等）自动映射为 `build` 资源锁。
  遇到同机已有其他 Agent 持锁时立即以退出码 2 拦截并提醒等待。
- **跨工作树与跨机路径对齐**：Hook 自动解析工作树共同主仓库（`resolveGitCommonRoot`）与 Git Remote 指纹（`git_remote`），将不同工作树或不同操作系统（如 Windows `D:/...` 与 Linux `/root/...`）下的同源工程文件统一映射为仓库相对路径判冲，防止跨树/跨机并发写冲突。
- **PowerContext 跨机接力上下文注入**：当 `/api/hook/check` 放行且携带 `handoff_context`（同源工程存在待认领的跨机交接工单与关键工程记忆）时，Hook 不仅在 `stderr` 打印可视摘要，还会向 `stdout` 输出 Claude Code 原生 `hookSpecificOutput.additionalContext` JSON，确保大模型在 `exit(0)` 正常放行时直接感知上游改动与接力建议（不输出 `permissionDecision` 以保留用户权限门禁）。
- **高信息密度冲突拦截诊断**：当拦截到写入或命令冲突时，Hook 以退出码 2 阻断，并在 `stderr` 打印冲突文件/资源、当前持锁会话、所在工作区及剩余租约预估等待时间（`ETA: ~Xs`）。

## 二、PostToolUse 毫秒级锁释放与工单合成

- **命令排他锁即时释放**：当 `Bash` 工具执行完 `npm test`、`npm run build` 等排他命令后，`PostToolUse`（`nexus-hook.mjs --post`）立即向 `/api/hook/resource-release` 发起毫秒级释放，无需等待 900s TTL 超时。
- **Git 提交/推送零感释放与跨机工单合成**：当 `Bash` 工具执行完 `git commit` 或 `git push` 后，`PostToolUse` 自动采集当前 `HEAD` 提交标题与 `git diff-tree --root` 改动文件列表，调用 `/api/hook/git-release` 一次性释放该会话持有的全部活跃租约、唤醒排队会话，并自动合成跨机阶段工作交接工单（Handoff）。

## 三、通信边界与容错

- 默认连接本机 `127.0.0.1:4300`（本地请求超时 `400ms` 遥测 / `1000ms` 判冲）。
- **跨机器连接中心 Hub**：在远端工作区执行 `nexus connect --hub http://<hub-host>:4300 --token <token> --node <node-id>` 后，连接地址、令牌与节点名持久化写入 `~/.agent-nexus/remote.json`（权限 `0600`）。Hook 启动时自动读取该配置并捎带边缘本地已验活的 `peer_sessions`。
- 离线、超时、响应无法解析或无目标文件均静默放行；不是操作系统级强制文件锁。
- daemon 明确拒绝请求（HTTP 4xx，如目标文件非法或令牌错误）时**拦截**并退出码 2。

## 四、安装器

从任意目录执行 `nexus hook:install`（或 `node src/cli.js hook:install`）。脚本路径由安装器自身位置推导，与执行目录无关；写出的命令为绝对路径，且安装前会校验 `src/hook/nexus-hook.mjs` 真实存在。

| 目标 | 写入位置 | 说明 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` 的 `hooks.PreToolUse` 与 `hooks.PostToolUse` | 幂等合并：保留用户已有其他 Hook 与配置；历史旧字符串写法自动就地升级；若原配置文件 JSON 损坏则报错并原样保留，绝不覆盖 |
