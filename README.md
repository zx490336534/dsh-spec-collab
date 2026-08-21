# dsh-spec-collab

[![npm version](https://img.shields.io/npm/v/dsh-spec-collab?style=flat-square)](https://www.npmjs.com/package/dsh-spec-collab)
[![license](https://img.shields.io/npm/l/dsh-spec-collab?style=flat-square)](LICENSE)

DeepSeek Harness 的独立双面插件，用于把产品的原始需求澄清为研发和开发 AI 可直接理解的 Ready Spec。产品、研发、产品 AI 与研发 AI 在同一份 Git 版本化 Markdown 上完成初审、逐项回复、二次审核、候选 patch、产研共审、Decision、分角色确认与 Ready 质量门。

产品边界严格止于 Ready Spec，不包含代码实现、测试用例生成、worktree、MR、部署、发布或交付状态管理。

兼容 DeepSeek Harness `v0.1.1-rc.1`。插件可在局域网 HTTP 地址下运行，不依赖浏览器提供 `crypto.randomUUID`；DSH 精简侧栏仅显示“设置”时，也会正常挂载“需求讨论”入口。

## 一键安装

已有 Node.js 环境时，无需先全局安装 DSH CLI：

```sh
npx -y @deepseek-ai/dsh plugin --profile web add dsh-spec-collab@latest
```

如果 `dsh` 已在 `PATH` 中，也可以使用简写：

```sh
dsh plugin --profile web add dsh-spec-collab@latest
```

安装后重启现有的 `dsh web` 进程。后续更新使用：

```sh
dsh plugin --profile web update dsh-spec-collab@latest
```

插件已经内置非安全 HTTP 环境所需的 UUID fallback，不需要通过代理向 HTML 注入 `crypto` polyfill。团队部署仍建议使用 HTTPS，并在 DSH 前配置认证。

## 核心流程

```text
输入原始需求
  -> 产品 AI 自动初审（九个维度）
  -> 产品逐项回应
  -> 产品 AI 二次审核 + 候选 patch
  -> 产品确认当前 commit
  -> 产研 + 双方 AI 共审
  -> 产品/研发分别确认当前 commit
  -> 六项 Ready 门
  -> 输出 Ready Spec
```

## 完整演示

点击下方截图观看从选择工作区到生成 Ready Spec 的完整 MP4 录屏：

[![Ready 质量门与最终 Ready Spec](docs/assets/demo-05-ready.png)](docs/assets/spec-collab-walkthrough.mp4)

**[播放 MP4 录屏](docs/assets/spec-collab-walkthrough.mp4)** · **[阅读完整图文教程](docs/usage-walkthrough.md)**

<details>
<summary>查看完整流程截图</summary>

### 1. 新建需求并选择工作区

![新建需求并选择工作区](docs/assets/demo-01-workspace.png)

### 2. AI 审核问题和人工回复

![AI 审核问题和人工回复](docs/assets/demo-02-ai-review.png)

### 3. 审核并接受候选 Patch

![审核并接受候选 Patch](docs/assets/demo-03-patches.png)

### 4. 记录人工 Decision

![人工确认的产品 Decision](docs/assets/demo-04-decisions.png)

</details>

## 能力

- 匿名只读；首次评论、修改、回复、确认前登记 `participant_id + 花名 + 责任角色`。
- 原始需求、Markdown PRD、相关链接与代码范围分别记录为来源，不静默混成事实。
- 正式正文只存在 `requirements/<id>/spec.md`，每次显式保存生成一个 Git commit。
- 保存携带 `baseCommit`；过期或存在外部未提交修改时拒绝覆盖。
- `FACT / INFERENCE / ASSUMPTION / TO_VERIFY` 结构化 Review Item；`FACT` 强制可访问且带版本的证据。
- 产品 AI 初审、产品 AI 二审、研发 AI 预审、变更审核四类独立 DSH review session。
- 每条实质评论提交后自动启动 AI 分析，回复必须包含理解、证据或 `TO_VERIFY`、影响章节/AC 和建议处置。
- AI 只能提交 Review Item、评论分析和候选 patch；不能写 Git、代替人确认或标记 Ready。
- 保存和 patch 接受后自动触发 change review；候选 patch 基于精确 commit，过期自动失效。
- Decision、Comment、Confirmation 分离；确认绑定 commit，可按 section/AC 局部失效。
- Ready 门检查目标与用户结果、稳定 AC、范围与非范围、业务语义、证据来源、测试约束。
- Ready 输出包含 commit SHA、稳定 AC、Decision、来源、非阻塞 Open Questions 和产品/研发确认人。
- Agent 工具：`spec_list`、`spec_read`、`spec_reply`、`spec_submit_review`、`spec_propose_patch`。
- Host 权威协作账本 + SSE，多浏览器刷新后仍可继续。
- 新建需求必须选择一个 DSH 工作区；所有 AI 审核和评论分析 session 固定挂载该工作区，不会落入未分组 session。
- 支持默认 AI 上下文与工作区专属上下文合并，统一声明 Skill、MCP server、本地参考文档和 Agent Preset。

## AI 上下文配置

插件通过 DSH profile 的 `cordis.patch.yml` 接收配置。`defaultContext` 会应用到全部工作区；`workspaces` 只为指定 `workspaceId` 追加资源，并可覆盖默认 `agentPreset`。未列入 `workspaces` 的已登记工作区仍可创建需求并继承默认上下文。

```yaml
- id: spec-collab
  config:
    defaultContext:
      skills:
        - requirements-review
      mcpServers:
        - confluence
      documentPaths:
        - ~/company-docs/product-rules.md
      agentPreset: spec-review
    workspaces:
      - workspaceId: 00000000-0000-4000-8000-000000000001
        skills:
          - payment-domain
        mcpServers:
          - payments
        documentPaths:
          - docs/payment-rules.md
        agentPreset: spec-review-payments
```

新建需求窗口会读取 DSH 当前登记的全部工作区并要求选择。工作区专属 `documentPaths` 可写相对路径，AI 会基于所选工作区根目录读取；共享文档建议使用绝对路径或 `~`。页面接口 `GET /api/spec-collab/review-workspaces` 返回可选工作区的 `workspaceId`、标题和路径，可用于填写覆盖配置。

升级前创建、尚未保存 `workspaceId` 的需求会显示“未绑定工作区”，其 AI 审核按钮保持禁用；通过“绑定工作区”补齐一次后即可继续。已绑定需求不允许切换工作区，避免同一需求的审核上下文中途变化。

Skill 和 MCP 必须已经由对应 Agent Preset 挂载：Skill 名称会要求 AI 先通过 `skill` 工具加载，MCP serverName 会映射为 `mcp__<serverName>__*` 工具 namespace。本插件不会在单次审核中安装外部代码或启动未授权 MCP；资源不可用时，AI 必须明确标记 `TO_VERIFY`，不能伪造 `FACT`。

绑定工作区会把 AI session 的当前目录设为该工作区的真实路径，但“挂载成功”不代表模型已经读取项目文件。默认工作区提示词会强制每次审核先检查根目录，读取存在的 `AGENTS.md`、`CONTEXT.md`、`README.md`、`CONTRIBUTING.md` 和项目清单，再按需求定位相关代码、文档、测试及 Git 历史。业务专属资料仍建议通过 `documentPaths` 明确指定。

## AI 提示词配置

`prompts` 中每个字段都可以单独覆盖，未填写的字段继续使用插件当前内置提示词。动态的需求 ID、commit、审核类型和 session ID 由插件注入，不需要写进自定义提示词。

```yaml
- id: spec-collab
  config:
    prompts:
      common: |-
        所有输出使用简体中文，并遵守团队的需求审核规范。
      productFirst: |-
        先检查用户目标、范围、业务规则和验收标准，再提交结构化审核结果。
      workspaceContext: |-
        ## 项目上下文
        项目：{{WORKSPACE_TITLE}}
        根目录：{{WORKSPACE_PATH}}
        审核前先读取项目规则、说明文档和相关实现。
        {{WORKSPACE_SNAPSHOT}}
        {{RESOURCE_INSTRUCTIONS}}
      resourceInstructions: |-
        可用 Skill：{{SKILLS}}
        可用 MCP：{{MCP_SERVERS}}
        指定文档：{{DOCUMENT_PATHS}}
      followUp: |-
        请基于当前审核上下文回答下面的追问：

        {{CONTENT}}
```

可配置字段：`system`、`workspaceContext`、`resourceInstructions`、`common`、`productFirst`、`productSecond`、`engineeringPrecheck`、`changeReview`、`comment`、`followUp`。

`workspaceContext` 必须各保留一次 `{{WORKSPACE_SNAPSHOT}}` 和 `{{RESOURCE_INSTRUCTIONS}}`，还支持 `{{WORKSPACE_ID}}`、`{{WORKSPACE_TITLE}}`、`{{WORKSPACE_PATH}}`。`resourceInstructions` 支持 `{{RESOURCE_DETAILS}}`、`{{SKILLS}}`、`{{MCP_SERVERS}}`、`{{DOCUMENT_PATHS}}`。`followUp` 必须保留且只能保留一个 `{{CONTENT}}`。未知变量和缺失的必需变量会在插件启动时直接报错，避免错误模板进入 AI 会话。完整默认值由包入口导出的 `DEFAULT_REVIEW_PROMPTS` 提供。

## 从源码安装（开发）

需要 Node.js 20+、pnpm 9+ 和可用的 DeepSeek Harness。

```sh
git clone https://github.com/zx490336534/dsh-spec-collab.git
cd dsh-spec-collab
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
dsh plugin --profile web add "link:$(pwd)"
```

首次安装或 Host 代码变更后重启现有 `dsh web`。Client 开发时需在 DeepSeek Harness checkout 运行 `pnpm run dev:web`，插件侧运行 `pnpm run bundle --watch`，现有 GUI 的 client-plugin HMR 才会接收 bundle 更新。

## 数据

```text
~/.dsh/spec-collab/
  collaboration-v2.json       # Review/Comment/Decision/Confirmation/ActionItem/AI run
  repository/.git/            # 正式版本历史
  repository/requirements/
    <requirement-id>/spec.md
```

Git 是正式 Spec 版本的唯一事实源；协作账本不保存第二套 Markdown 历史。

## 安全与限制

- 默认仅允许 loopback + same-origin 浏览器请求。通过域名开放给团队前，需要在 DSH 前配置真实认证和可信反向代理策略。
- 花名用于协作归因，不是强身份认证；当前版本不提供 OAuth、组织、细粒度 ACL。
- Markdown 禁用原始 HTML；正文最大 2 MB。
- AI review session 使用 DSH 既有 preset/sandbox 权限，不发送权限升级命令。
- 当前版本不实现 CRDT/OT、实时光标、附件上传和三方合并编辑器；并发保存使用 commit 冲突阻断。
