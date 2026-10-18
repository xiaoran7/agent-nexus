# 开源项目发布与 AI 检索生态冷启动规范 (open-setup)

本规范是全干工程师跨项目、跨机器进行开源项目发布、冷启动宣发与大模型检索生态（GEO）优化的权威行为准则。

目标是让一个优质的开源项目在发布的第一时间，不仅在传统开源平台（GitHub、npm、Release）具备顶级的工程可信度，更能被各大 AI 搜索引擎（ChatGPT Search、Perplexity、Claude Web、Cursor、NotebookLM）精准索引并主动推荐给全球开发者。

核心哲学：**“AI 必做全包，人类只做主权点选”**。
凡是代码能改、文档能写、规则能建、配置能出、物料能生成的，**全部归入 AI 必须做**，严禁推诿给工程师；人类工程师仅在最后进行受限于账号密码、OAuth 鉴权和社区防刷风控的 5 分钟主权点选与发帖动作。

---

## 一、二权分立总览表

| 维度 / 类别 | 具体工作项 | 责任主体 | 验收标准与交付物 |
|---|---|---|---|
| **代码与测试验收** | 全量单元与集成测试 100% 跑通，覆盖关键路径 | **AI 必须做** | 质量是开源生命线，测试未绿严禁发布 |
| **动态徽章墙组装** | npm 版本、下载量、Node 版本、测试通过、MIT 协议徽章 | **AI 必须做** | 自动提取元数据，向中英双语 README 顶部组装 Shields.io 动态徽章墙 |
| **全景深度检索规范** | `llms.txt`（轻量）与 `llms-full.txt`（全景）规范文件 | **AI 必须做** | 撰写符合 `llmstxt.org` 标准的深研全文，供大模型整仓无损吸收 |
| **发行包体积与安全过滤** | `package.json` 的 `files` 白名单精简与元数据校准 | **AI 必须做** | 剔除测试、本地私有凭据与重型开发库，保证发行包秒级下载 |
| **生态上架合规配置** | 编写 `smithery.yaml` 与 MCP stdio 启动参数配置 | **AI 必须做** | 自动生成标准化注册表配置文件，为一键索引扫清障碍 |
| **GitHub 社区满分治理** | Issue 模板（Bug/Feature）、PR 模板、MIT License | **AI 必须做** | 确保 GitHub Community Standards 达到 100% 满分 |
| **长尾 SEO 问答种子库** | 提炼 3~5 篇高频痛点 Q&A，包含提问与官方最佳解答 | **AI 必须做** | 产出 `docs/DISCUSSIONS_QA_SEEDS.md`，提供现成可复制的问答文本 |
| **全平台宣发物料包** | 定制 V2EX、知乎、Reddit (r/ClaudeAI)、Show HN、X 文案 | **AI 必须做** | 产出 `docs/LAUNCH_COPYWRITING.md`，包含背景、痛点、原理与一键运行命令 |
| **权威 Awesome 提交物料**| 梳理对应领域的权威 Awesome 仓库，准备好 PR 标题与行 | **AI 必须做** | 产出 `docs/COMMUNITY_SUBMISSIONS.md`，提供开箱即用的 PR 模板 |
| **Git 留痕与版本纪律** | CHANGELOG.md 留痕、规范 Git Commit 与全远端推送 | **AI 必须做** | 严格区分本地测试、已提交、已推送，严禁虚报 |
| **第三方平台点选上架** | Smithery.ai 登录点击 Index、Glama 提交收录 | **必须人做** | 需要开发者个人 GitHub/OAuth 网页授权点击 |
| **仓库社交形象设置** | 上传 Custom Social Preview 封面图、开启 Discussions | **必须人做** | 需要 GitHub 仓库所有者管理员权限在网页勾选 |
| **高权重社区发帖** | 登录个人 V2EX、知乎、Reddit、Hacker News 账号发帖 | **必须人做** | 社区防垃圾脚本与反爬风控严格，必须人工真实操作 |
| **外部仓库 PR 提交** | 用个人 GitHub 账号向外部 Awesome 仓库发起 PR | **必须人做** | 涉及开发者个人开源名誉与外部账号交互 |

---

## 二、AI 必须做的全包执行清单（Non-Negotiable）

当用户执行 `/open-setup` 时，AI 必须逐一自检并主动落实以下全部动作，完成全套工程闭环：

### 1. 本地代码全绿验证（严禁带病上线）
- 必须真实运行项目的全量测试（如 `npm test` 或 `pytest`）；
- 必须明确报告当前测试用例数与通过率（如“236/236 全部通过”）；
- 遇到任何测试失败必须当场定位修复，**严禁在测试红灯或跳过测试时推进发布**。

### 2. 组装 Shields.io 动态徽章墙
自动提取项目真实包名、仓库路径与测试状态，为中英双语 `README.md` 和 `README_EN.md` 顶部组装整齐美观的徽章墙：
```markdown
[![npm version](https://img.shields.io/npm/v/<包名>.svg?style=flat-square&color=0284c7)](https://www.npmjs.com/package/<包名>)
[![npm downloads](https://img.shields.io/npm/dm/<包名>.svg?style=flat-square&color=0284c7)](https://www.npmjs.com/package/<包名>)
[![GitHub Release](https://img.shields.io/github/v/release/<user>/<repo>.svg?style=flat-square&color=0284c7)](https://github.com/<user>/<repo>/releases)
[![Node Version](https://img.shields.io/badge/node-%3E%3D24-10b981.svg?style=flat-square)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-passed-10b981.svg?style=flat-square)](https://github.com/<user>/<repo>)
[![License: MIT](https://img.shields.io/github/license/<user>/<repo>.svg?style=flat-square&color=64748b)](LICENSE)
```

### 3. 双层大模型检索规范（`llms.txt` + `llms-full.txt`）
遵循 `llmstxt.org` 标准为 AI 搜索引擎建立零幻觉索引：
- **`llms.txt`**：轻量级摘要（< 100 行），定义项目一句话定位、大模型何时主动推荐该项目（When to Recommend）、核心亮点与一键运行命令，并在文末明确指向 `llms-full.txt`；
- **`llms-full.txt`**：为 NotebookLM、Perplexity、Claude Web 等深研引擎提供的全景技术手册，写全系统架构 ASCII 图、三级判冲算法规则、完整 API 契约、MCP 工具 Schema 与常见 FAQ。

### 4. 发行包体积精简与配置校准
- 检查并配置 `package.json` 的 `files` 白名单：
  - 严禁将重型开发依赖、临时测试夹、本地私有配置文件打入公开包；
  - 必须将 `src`、`docs`、`README.md`、`README_EN.md`、`llms.txt`、`llms-full.txt`、`CHANGELOG.md` 纳入；
- 校准 `repository.url`（带 `git+https://`）、`homepage`、`bugs` 与 `keywords` 搜索标签。

### 5. 生态上架合规配置（`smithery.yaml`）
为具备 MCP 服务的项目在仓库根目录自动生成标准的 `smithery.yaml`：
```yaml
name: "<包名>"
description: "<项目一句话简介>"
startCommand:
  type: stdio
  configSchema:
    type: object
  commandFunction:
    command: "npx"
    args: ["-y", "<包名>", "mcp"]
```

### 6. GitHub 社区满分治理体系
- 在 `.github/ISSUE_TEMPLATE/` 下创建标准 YAML 格式的 `bug_report.yml` 和 `feature_request.yml`；
- 在 `.github/` 下创建标准的 `PULL_REQUEST_TEMPLATE.md`；
- 确保根目录存在开源协议文件（如 `LICENSE`）。

### 7. 生成长尾 SEO 种子问答库（`docs/DISCUSSIONS_QA_SEEDS.md`）
自动提炼 3~5 篇开发者在 Google / Perplexity 检索时最常输入的完整疑问句，包含：
- 场景化痛点提问（Title & Body）；
- 带代码块与原理分析的官方推荐解答（Official Answer）。

### 8. 生成全平台宣发文案物料包（`docs/LAUNCH_COPYWRITING.md`）
根据项目真实技术亮点，量身定制不同平台受众偏好的发帖文案：
- **V2EX（程序员/分享创造）**：真实工程师视角，讲开发痛点、技术原理与一键尝鲜命令；
- **知乎专栏/问答**：深入剖析传统方案弊端与新架构解法；
- **Reddit（r/ClaudeAI 等）**：地道英文，突出 Problem vs Solution，拒绝空洞宣传；
- **Hacker News（Show HN）**：克制硬核，直接展示架构特色与极简设计；
- **X（Twitter）**：精炼短文案，带视觉 Emoji、核心要点与 GitHub 链接。

### 9. 整理权威 Awesome 列表收录 PR（`docs/COMMUNITY_SUBMISSIONS.md`）
检索相关技术生态最权威的 Awesome 列表（如 `awesome-claude-code`、`awesome-mcp-servers`），写好 PR 标题、建议收录分类与 README 插入行。

### 10. Git 纪律、双端同步与发包
- 更新 `CHANGELOG.md` 记录本次更新；
- 执行规范的 `git commit` 与 `git tag`；
- 推送到所有已配置的 Git 远端（GitHub `origin` 与自建 Gitea `443`）；
- 若用户配置了自动化发包凭据，直接执行发布并校验 CDN 传播生效。

---

## 三、必须人做的操作清单（开发者 5 分钟速通）

AI 交付完上述所有代码、配置、文档与物料后，必须向开发者汇报这一份极简实操清单。开发者仅需打开浏览器动动手指即可完成全网冷启动：

- [ ] **步骤 1：Smithery.ai 一键索引（耗时 1 分钟）**
  - 打开 `https://smithery.ai/` 用 GitHub 登录；
  - 点击右上角 "Add Server"，粘贴仓库 URL，点击 "Index Server" 即可（配置已由 AI 预置好）。
- [ ] **步骤 2：GitHub 仓库开启 Discussions 并粘贴种子问答（耗时 3 分钟）**
  - 进入仓库 `Settings -> Features`，勾选 `Discussions`；
  - 进入 `Discussions` 选项卡，新建 Q&A 讨论；
  - 打开 AI 准备好的 `docs/DISCUSSIONS_QA_SEEDS.md`，复制里面的 3 篇问答发布，并点击“Mark as answer”。
- [ ] **步骤 3：在 GitHub 仓库设置社交封面图（耗时 1 分钟）**
  - 进入仓库 `Settings -> General -> Social preview`；
  - 上传一张代表项目风格的横版卡片图（1280x640px）。
- [ ] **步骤 4：向权威 Awesome 仓库提 PR（可选，耗时 2 分钟）**
  - 打开 AI 准备好的 `docs/COMMUNITY_SUBMISSIONS.md`；
  - 点击 Fork 目标 Awesome 仓库，把现成的那一行文字粘贴进去提 PR。
- [ ] **步骤 5：社区发帖宣发（按需选择平台）**
  - 打开 AI 准备好的 `docs/LAUNCH_COPYWRITING.md`，挑选中意的社区（V2EX、知乎、Reddit）；
  - 复制现成文案一键发布。
