# 配置与部署

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
# 桌面应用使用 desktop；独立 dsh web 改为 web。
dsh plugin --profile desktop add "link:$(pwd)"
```

首次安装或 Host 代码变更后，重启承载插件的桌面应用或 `dsh web` 进程。使用 DSH 源码开发 Client 时，可在同一个 DSH checkout 运行 `pnpm run dev:web`，并在插件仓库运行 `pnpm run bundle --watch`，让已连接的 Client 接收更新。

## 数据与迁移

```text
~/.dsh/spec-collab/
  collaboration-v2.json       # 保留的 v0.2.x 原始数据，供回滚读取
  collaboration-v2.backup-<timestamp>.json
  collaboration-v3.json       # 协作、通知、洞察、统一指标和 AI 阶段会话
  repository/.git/            # 正式版本历史
  repository/requirements/
    <requirement-id>/spec.md
```

Git 是正式 Spec 版本的唯一事实源；协作账本不保存第二套 Markdown 历史。未正式保存的草稿只保存在当前浏览器 IndexedDB。

单个插件宿主管理一套 Git 仓库和协作账本。正文变更先记录待完成的事务，再更新 Git 和账本。宿主中断后会在下次启动时续写。如果恢复前有人编辑了同一个 Spec 路径，插件保留外部编辑和恢复记录，并报告冲突。

[阅读 v3 迁移、回滚与隐私说明](migration-v3.md) · [查看核心重构与消融结果](core-refactor-ablation.md)

## 安全与限制

- 默认仅允许 loopback + same-origin 浏览器请求。通过域名开放给团队前，需要在 DSH 前配置真实认证和可信反向代理策略。
- 花名用于协作归因，不是强身份认证；当前版本不提供 OAuth、组织、细粒度 ACL。
- 客户记录只保存显示名、公司名和外部编号，不保存邮箱、电话、凭证；重要度分不阻断 Ready。
- Markdown 禁用原始 HTML；正文最大 2 MB。
- AI review session 使用 DSH 既有 preset/sandbox 权限，不发送权限升级命令。
- 当前版本不实现 CRDT/OT、实时光标、附件上传和三方合并编辑器；并发保存使用 commit 冲突阻断。
