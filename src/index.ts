import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { CollaborationEngine } from './engine.ts'
import { GitRequirementStore } from './git-store.ts'
import { DshReviewCoordinator } from './review-runtime.ts'
import { ReviewContextCatalog, type ReviewContextConfig } from './review-context.ts'
import { makeRoutes } from './routes.ts'
import { allSpecTools } from './tools.ts'

export const name = 'spec-collab'
export const inject = ['webServer', 'apiProxy', 'tools', 'systemPrompt']
export interface Config extends ReviewContextConfig { dataRoot?: string; repositoryPath?: string }

const stringList = () => Schema.array(Schema.string()).default([])
const contextFields = () => ({
  skills: stringList().description('当前上下文必须先加载的 Skill 名称。'),
  mcpServers: stringList().description('当前上下文可使用的 MCP serverName；工具 namespace 为 mcp__<serverName>__*。'),
  documentPaths: stringList().description('AI 分析前可读取的本地文件或目录路径；相对路径按需求工作区根目录解析。'),
  agentPreset: Schema.string().description('实际挂载这些 Skill/MCP 工具的 DSH Agent Preset ID。'),
})
export const Config: Schema<Config> = Schema.object({
  dataRoot: Schema.string().description('协作账本数据目录。'),
  repositoryPath: Schema.string().description('正式 Spec Git 仓库目录。'),
  defaultContext: Schema.object(contextFields()).description('所有需求工作区都会合并的默认 AI 上下文。'),
  workspaces: Schema.array(Schema.object({
    workspaceId: Schema.string().required().description('需要追加项目专属 AI 上下文的 DSH workspaceId。'),
    ...contextFields(),
  })).default([]).description('按 DSH 工作区追加的 AI 上下文；未列出的工作区仍继承 defaultContext。'),
}) as Schema<Config>

export function apply(ctx: Context, config: Config = {}): void {
  const dataRoot = config.dataRoot ?? join(homedir(), '.dsh', 'spec-collab')
  const contexts = new ReviewContextCatalog(config)
  const engine = new CollaborationEngine(join(dataRoot, 'collaboration-v2.json'), new GitRequirementStore(config.repositoryPath ?? join(dataRoot, 'repository')))
  const coordinator = new DshReviewCoordinator(ctx.apiProxy, contexts)
  engine.setCoordinator(coordinator)
  ctx.effect(() => { const disposers = makeRoutes(engine, coordinator).map(route => ctx.webServer.register(route)); return () => { for (const dispose of disposers) dispose() } }, 'spec-collab: routes')
  ctx.effect(() => { const disposers = allSpecTools(engine).map(tool => ctx.tools.register(tool)); return () => { for (const dispose of disposers) dispose() } }, 'spec-collab: tools')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:spec-collab', order: 190,
    text: '本机已安装 dsh-spec-collab「AI 需求澄清与 Spec 共创工作台」。产品输入原始需求后，产品 AI 初审并生成结构化 Review Item，产品逐项回应，AI 二次审核并提出候选 patch；产品确认后进入产研与双方 AI 共审，最终通过 Ready 质量门输出 commit 绑定的 Ready Spec。正式 Spec 版本只存 Git+Markdown；AI 只能提出 Review Item、分析回复和候选 patch，不能确认产品/技术语义，也不能直接写 Git 或标记 Ready。该产品严格止于 Ready Spec，不执行代码开发、测试、worktree、部署或发布。使用 spec_list/spec_read 读取，spec_reply/spec_submit_review/spec_propose_patch 参与审核。',
  }), 'spec-collab: prompt')
}
