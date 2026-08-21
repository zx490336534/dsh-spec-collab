import { homedir } from 'node:os'
import { normalize, resolve } from 'node:path'

export interface ReviewContextResources {
  skills?: string[]
  mcpServers?: string[]
  documentPaths?: string[]
  agentPreset?: string
}

export interface ReviewWorkspaceContextConfig extends ReviewContextResources { workspaceId: string }

export interface ReviewContextConfig {
  defaultContext?: ReviewContextResources
  workspaces?: ReviewWorkspaceContextConfig[]
}

interface NormalizedReviewContext {
  skills: string[]
  mcpServers: string[]
  documentPaths: string[]
  agentPreset?: string
}

export interface ResolvedReviewContext extends NormalizedReviewContext { workspaceId: string }

const MCP_SERVER = /^[A-Za-z0-9_-]{1,32}$/

export class ReviewContextCatalog {
  private readonly defaults: NormalizedReviewContext
  private readonly workspaces = new Map<string, ReviewWorkspaceContextConfig>()

  constructor(config: ReviewContextConfig = {}) {
    this.defaults = normalizeResources(config.defaultContext)
    for (const value of config.workspaces ?? []) {
      const workspaceId = value.workspaceId.trim()
      if (workspaceId === '') throw new Error('review workspace id is required')
      if (this.workspaces.has(workspaceId)) throw new Error(`duplicate review workspace id: ${workspaceId}`)
      this.workspaces.set(workspaceId, { ...normalizeResources(value), workspaceId })
    }
  }

  workspaceIds(): string[] { return [...this.workspaces.keys()] }

  resolve(workspaceId?: string): ResolvedReviewContext {
    if (workspaceId === undefined || workspaceId.trim() === '') throw new Error('review workspace is required')
    const workspace = this.workspaces.get(workspaceId)
    const resources = normalizeResources(workspace)
    return {
      workspaceId,
      skills: unique([...this.defaults.skills, ...resources.skills]),
      mcpServers: unique([...this.defaults.mcpServers, ...resources.mcpServers]),
      documentPaths: unique([...this.defaults.documentPaths, ...resources.documentPaths]),
      ...(resources.agentPreset ?? this.defaults.agentPreset ? { agentPreset: resources.agentPreset ?? this.defaults.agentPreset } : {}),
    }
  }
}

export function reviewContextPrompt(context: ResolvedReviewContext): string {
  const rows = [
    '## 本次审核必须使用的上下文',
    `DSH 工作区：\`${context.workspaceId}\`。当前 AI session 必须挂载该工作区，不得创建未分组会话。`,
  ]
  if (context.skills.length > 0) rows.push(`Skills：先调用 skill 工具加载 ${context.skills.map(value => `\`${value}\``).join('、')}，读取完整说明后再分析。`)
  if (context.mcpServers.length > 0) rows.push(`MCP：需要事实查询时优先使用 ${context.mcpServers.map(value => `\`mcp__${value}__*\``).join('、')} namespace 下的工具。`)
  if (context.documentPaths.length > 0) rows.push('本地参考文档：分析前先读取与本需求相关的路径；相对路径基于当前 DSH 工作区根目录，引用时必须带具体文件路径和可识别版本。', ...context.documentPaths.map(value => `- \`${value}\``))
  if (context.skills.length === 0 && context.mcpServers.length === 0 && context.documentPaths.length === 0) rows.push('当前未配置额外 Skill、MCP 或本地参考文档。')
  rows.push('任何已配置资源若在当前 Agent Preset 中不可用、无权限或读取失败，必须在结论中明确指出该资源并使用 TO_VERIFY；不得假装已经查询或把不可访问内容写成 FACT。')
  return rows.join('\n')
}

function normalizeResources(value: ReviewContextResources | undefined): NormalizedReviewContext {
  const skills = cleanList(value?.skills)
  const mcpServers = cleanList(value?.mcpServers)
  for (const server of mcpServers) if (!MCP_SERVER.test(server)) throw new Error(`invalid MCP server name: ${server}`)
  const documentPaths = unique(cleanList(value?.documentPaths).map(resolveDocumentPath))
  const agentPreset = value?.agentPreset?.trim()
  return { skills, mcpServers, documentPaths, ...(agentPreset ? { agentPreset } : {}) }
}

function cleanList(values: string[] | undefined): string[] { return unique((values ?? []).map(value => value.trim()).filter(Boolean)) }
function unique(values: string[]): string[] { return [...new Set(values)] }
function resolveDocumentPath(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return normalize(resolve(homedir(), value.slice(2)))
  return normalize(value)
}
