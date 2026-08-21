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
import { DEFAULT_REVIEW_PROMPTS, resolveReviewPrompts, type ReviewPromptConfig } from './prompts.ts'
import { DshReviewCoordinator } from './review-runtime.ts'
import { ReviewContextCatalog, type ReviewContextConfig } from './review-context.ts'
import { makeRoutes } from './routes.ts'
import { allSpecTools } from './tools.ts'

export { DEFAULT_REVIEW_PROMPTS, resolveReviewPrompts }
export type { ReviewPromptConfig }

export const name = 'spec-collab'
export const inject = ['webServer', 'apiProxy', 'tools', 'systemPrompt']
export interface Config extends ReviewContextConfig { dataRoot?: string; repositoryPath?: string; prompts?: ReviewPromptConfig }

const stringList = () => Schema.array(Schema.string()).default([])
const contextFields = () => ({
  skills: stringList().description('当前上下文必须先加载的 Skill 名称。'),
  mcpServers: stringList().description('当前上下文可使用的 MCP serverName；工具 namespace 为 mcp__<serverName>__*。'),
  documentPaths: stringList().description('AI 分析前可读取的本地文件或目录路径；相对路径按需求工作区根目录解析。'),
  agentPreset: Schema.string().description('实际挂载这些 Skill/MCP 工具的 DSH Agent Preset ID。'),
})
const promptText = (value: string, description: string) => Schema.string().role('textarea').default(value).description(description)
export const Config: Schema<Config> = Schema.object({
  dataRoot: Schema.string().description('协作账本数据目录。'),
  repositoryPath: Schema.string().description('正式 Spec Git 仓库目录。'),
  defaultContext: Schema.object(contextFields()).description('所有需求工作区都会合并的默认 AI 上下文。'),
  workspaces: Schema.array(Schema.object({
    workspaceId: Schema.string().required().description('需要追加项目专属 AI 上下文的 DSH workspaceId。'),
    ...contextFields(),
  })).default([]).description('按 DSH 工作区追加的 AI 上下文；未列出的工作区仍继承 defaultContext。'),
  prompts: Schema.object({
    system: promptText(DEFAULT_REVIEW_PROMPTS.system, '注入普通 DSH 会话的插件系统说明。'),
    workspaceContext: promptText(DEFAULT_REVIEW_PROMPTS.workspaceContext, '工作区上下文模板。必须保留 {{WORKSPACE_SNAPSHOT}} 和 {{RESOURCE_INSTRUCTIONS}}；还可使用 {{WORKSPACE_ID}}、{{WORKSPACE_TITLE}}、{{WORKSPACE_PATH}}。'),
    resourceInstructions: promptText(DEFAULT_REVIEW_PROMPTS.resourceInstructions, 'Skill、MCP 和文档资源说明模板。可用变量：{{RESOURCE_DETAILS}}、{{SKILLS}}、{{MCP_SERVERS}}、{{DOCUMENT_PATHS}}。'),
    common: promptText(DEFAULT_REVIEW_PROMPTS.common, '所有审核和评论分析共享的约束。'),
    productFirst: promptText(DEFAULT_REVIEW_PROMPTS.productFirst, '产品 AI 初审任务提示词。'),
    productSecond: promptText(DEFAULT_REVIEW_PROMPTS.productSecond, '产品回复后的二次审核任务提示词。'),
    engineeringPrecheck: promptText(DEFAULT_REVIEW_PROMPTS.engineeringPrecheck, '研发智能预审任务提示词。'),
    changeReview: promptText(DEFAULT_REVIEW_PROMPTS.changeReview, '保存新版本后的变更审核任务提示词。'),
    comment: promptText(DEFAULT_REVIEW_PROMPTS.comment, '正文评论的 AI 分析任务提示词。'),
    followUp: promptText(DEFAULT_REVIEW_PROMPTS.followUp, 'AI 会话追问模板，必须保留 {{CONTENT}}。'),
  }).description('AI 提示词配置；未填写的字段使用插件内置默认值。'),
}) as Schema<Config>

export function apply(ctx: Context, config: Config = {}): void {
  const dataRoot = config.dataRoot ?? join(homedir(), '.dsh', 'spec-collab')
  const contexts = new ReviewContextCatalog(config)
  const prompts = resolveReviewPrompts(config.prompts)
  const engine = new CollaborationEngine(join(dataRoot, 'collaboration-v2.json'), new GitRequirementStore(config.repositoryPath ?? join(dataRoot, 'repository')))
  const coordinator = new DshReviewCoordinator(ctx.apiProxy, contexts, prompts)
  engine.setCoordinator(coordinator)
  ctx.effect(() => { const disposers = makeRoutes(engine, coordinator).map(route => ctx.webServer.register(route)); return () => { for (const dispose of disposers) dispose() } }, 'spec-collab: routes')
  ctx.effect(() => { const disposers = allSpecTools(engine).map(tool => ctx.tools.register(tool)); return () => { for (const dispose of disposers) dispose() } }, 'spec-collab: tools')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:spec-collab', order: 190,
    text: prompts.system,
  }), 'spec-collab: prompt')
}
