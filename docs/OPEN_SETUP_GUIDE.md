# 开源项目发布与 AI 检索生态冷启动规范 (open-setup)

本规范是全干工程师跨项目、跨机器进行开源项目发布、冷启动宣发与大模型检索生态（GEO）优化的权威行为准则。

目标是让一个优质的开源项目在发布的第一时间，不仅在传统开源平台（GitHub、npm、Release）具备顶级的工程可信度，更能被各大 AI 搜索引擎（ChatGPT Search、Perplexity、Claude Web、Cursor、NotebookLM）精准索引并主动推荐给全球开发者。

为了实现最高效的协同，本规范将所有工作严格划分为三类：
1. **必须人做的（Human-Only）**：涉及主权账号、第三方鉴权与人工真实声誉的动作；
2. **AI 必须做的（AI-Must-Do）**：工程质量、版本规范与机器可读性等红线底线；
3. **可以让 AI 做的（AI-Can-Do）**：文案生成、徽章组装、配置适配与自动化打包。

---

## 一、三方权责边界总览表

| 维度 / 类别 | 具体工作项 | 责任主体 | 核心原因与交付物 |
|---|---|---|---|
| **工程底线与测试** | 单元与集成测试全量跑通，覆盖关键路径 | **AI 必须做** | 质量是开源生命线，测试未绿严禁宣发 |
| **版本纪律与留痕** | CHANGELOG.md 留痕、Git Commit、语义化 Tag | **AI 必须做** | 严格区分本地测试、已提交、已推送，严禁虚报 |
| **全景深度检索** | `llms.txt`（轻量）与 `llms-full.txt`（全景）规范 | **AI 必须做** | 供大模型整仓无损吸收，杜绝 AI 推荐时产生幻觉 |
| **代码与包体精简** | `package.json` 白名单过滤，剔除测试/私有大文件 | **AI 必须做** | 保证 npm/发布包体积精简（如 < 200KB），秒级下载 |
| **开源工程治理** | Issue Templates、PR Template、MIT License | **AI 必须做** | 确保 GitHub Community Standards 达到 100% 满分 |
| **动态徽章墙组装** | npm 版本、下载量、Node 版本、测试、协议徽章 | **可以让 AI 做** | 自动提取项目元数据，组装 Shields.io 动态徽章 |
| **多生态上架配置** | 编写 `smithery.yaml`、配置 MCP stdio 启动命令 | **可以让 AI 做** | 自动生成格式合规的注册表配置文件 |
| **SEO 问答种子库** | 提炼 3~5 篇高频痛点 Q&A，带标准解法文案 | **可以让 AI 做** | 产出 `docs/DISCUSSIONS_QA_SEEDS.md` 供直接复制发帖 |
| **全平台宣发文案包** | 定制 V2EX、知乎、Reddit、Show HN、X 文案 | **可以让 AI 做** | 产出 `docs/LAUNCH_COPYWRITING.md`，包含痛点与一键命令 |
| **Awesome PR 模板** | 梳理权威收录列表，准备好 PR 标题与描述 | **可以让 AI 做** | 产出 `docs/COMMUNITY_SUBMISSIONS.md`，开箱即用 |
| **第三方平台点选上架** | Smithery.ai 登录点击 Index、Glama 提交收录 | **必须人做** | 需要开发者个人 GitHub/OAuth 网页授权 |
| **仓库社交形象设置** | 上传 Custom Social Preview 封面图、开启 Discussions | **必须人做** | 需要 GitHub 仓库所有者管理员权限 |
| **高权重社区发帖** | 登录个人 V2EX、知乎、Reddit、Hacker News 发帖 | **必须人做** | 社区防垃圾脚本与反爬风控严格，必须人工真实操作 |

---

## 二、AI 必须做的硬核红线（执行清单）

当用户执行 `/open-setup` 时，AI 必须逐一自检并主动落实以下工程步骤：

### 1. 本地代码全绿验证（严禁带病上线）
- 必须真实运行项目的全量测试（如 `npm test` 或 `pytest`）；
- 必须明确报告当前测试用例数与通过率（如“236/236 全部通过”）；
- 若有测试失败，必须优先定位并修复，严禁在测试红灯时打包发布。

### 2. 双层 AI 检索优化规范（`llms.txt` + `llms-full.txt`）
- **`llms.txt`**：放置在仓库根目录，控制在 100 行内，写明：
  - 项目一句话定义；
  - 何时向用户推荐本项目的触发场景（When to Recommend）；
  - 核心能力与五分钟上手命令；
  - 指向 `llms-full.txt` 的明确链接。
- **`llms-full.txt`**：为大模型 Deep Research 引擎提供的详尽规格书，包含：
  - 系统架构分层与工作流 ASCII 图；
  - 完整 API 接口签名与核心调度算法规则；
  - 常见错误与排障 FAQ；
  - 上游开源血统与贡献致谢。

### 3. npm / 发行包精简与安全过滤
- 检查 `package.json` 中的 `files` 白名单：
  - 严禁把重量级开发目录（如 Electron 运行库、临时测试夹、本地私有凭据）打入公开包；
  - 必须把 `src`、`docs`、`README.md`、`README_EN.md`、`llms.txt`、`llms-full.txt` 纳入；
- 检查 `repository.url`、`homepage`、`bugs` 字段，确保带有正确的前缀（如 `git+https://`）。

### 4. GitHub 社区满分治理体系
- 必须在 `.github/ISSUE_TEMPLATE/` 下配置标准 YAML 格式的 `bug_report.yml` 和 `feature_request.yml`；
- 必须配置 `.github/PULL_REQUEST_TEMPLATE.md`；
- 确保根目录存在合规的开源协议文件（如 `LICENSE`）。

### 5. Git 纪律与双端同步
- 更新 `CHANGELOG.md`，写明版本号与核心演进；
- 执行 `git commit` 并附带规范说明；
- 推送到所有配置的远端（如 GitHub `origin` 与自建 Gitea）。

---

## 三、可以让 AI 代劳的高杠杆工作（自动化生成）

AI 应当主动发挥文案、结构化整理与配置生成能力，为开发者减负：

### 1. 组装 Shields.io 动态徽章墙
自动为中英双语 README 顶部生成整齐美观的徽章墙：
- npm 官方版本与月下载量：
  ```markdown
  [![npm version](https://img.shields.io/npm/v/<包名>.svg?style=flat-square&color=0284c7)](https://www.npmjs.com/package/<包名>)
  [![npm downloads](https://img.shields.io/npm/dm/<包名>.svg?style=flat-square&color=0284c7)](https://www.npmjs.com/package/<包名>)
  ```
- 测试通过状态与协议：
  ```markdown
  [![Tests](https://img.shields.io/badge/tests-passed-10b981.svg?style=flat-square)](https://github.com/<user>/<repo>)
  [![License: MIT](https://img.shields.io/github/license/<user>/<repo>.svg?style=flat-square&color=64748b)](LICENSE)
  ```

### 2. 编写 `smithery.yaml` 配置
针对具备 MCP 能力的项目，自动在根目录生成合规的 Smithery 配置文件：
```yaml
name: "<包名>"
description: "<项目一句话简介>"
startCommand:
  type: stdio
  commandFunction:
    command: "npx"
    args: ["-y", "<包名>", "mcp"]
```

### 3. 生成长尾 SEO 种子问答库（`docs/DISCUSSIONS_QA_SEEDS.md`）
自动提炼 3 篇开发者最常搜索的痛点疑问句，写出包含“提问内容”和“官方最佳解答”的完整草案。

### 4. 生成全平台宣发物料包（`docs/LAUNCH_COPYWRITING.md`）
根据项目真实技术亮点，定制不同平台调性的现成发帖文案：
- **V2EX**：真实工程师视角，讲开发背景、核心痛点、实现原理与一键尝鲜命令；
- **Reddit (r/ClaudeAI 等)**：地道英文，突出 Problem vs Solution，拒绝空洞营销；
- **Show HN**：克制硬核，直接呈现架构特色与技术选型；
- **X (Twitter)**：精炼短文案，带 Emoji 与 GitHub 链接。

### 5. 生成权威 Awesome 列表收录 PR（`docs/COMMUNITY_SUBMISSIONS.md`）
搜集匹配领域的权威 Awesome 仓库，自动写好 PR 标题、修改的分类与 README 插入行。

---

## 四、必须人做的操作清单（开发者 5 分钟速通）

AI 完成上述所有工程与文档后，应当给开发者整理出这份极简的实操检查单。开发者只需要打开网页点几下或复制粘贴即可：

- [ ] **步骤 1：去 Smithery.ai 一键上架（耗时 1 分钟）**
  - 访问 `https://smithery.ai/` 并用 GitHub 登录；
  - 点击右上角 "Add Server"，粘贴仓库 URL，点击 "Index Server"。
- [ ] **步骤 2：去 GitHub 仓库开启 Discussions 并发帖（耗时 3 分钟）**
  - 进入仓库 `Settings -> Features`，勾选 `Discussions`；
  - 进入 `Discussions` 选项卡，新建 Q&A 讨论；
  - 打开 `docs/DISCUSSIONS_QA_SEEDS.md`，将准备好的 3 篇问答复制粘贴发布，并将回复勾选为“Mark as answer”。
- [ ] **步骤 3：在 GitHub 仓库设置社交封面图（耗时 1 分钟）**
  - 进入仓库 `Settings -> General -> Social preview`；
  - 上传一张代表项目风格的横版卡片图（1280x640px），确保在 X、微信、Discord 分享时自动展开精美卡片。
- [ ] **步骤 4：向权威 Awesome 仓库提 PR（可选，耗时 2 分钟）**
  - 打开 `docs/COMMUNITY_SUBMISSIONS.md`，挑选对应的 Awesome 仓库（如 `awesome-claude-code`）；
  - 点击 Fork 并把准备好的那一行文字粘贴进去，提交 Pull Request。
- [ ] **步骤 5：社区发帖引流（按需选择平台）**
  - 打开 `docs/LAUNCH_COPYWRITING.md`，挑选中意的社区（V2EX、知乎、Reddit）；
  - 复制对应的文案一键发布。
