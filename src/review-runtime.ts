import type { ApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { AiCoordinator } from './engine.ts'
import type { AiReviewRun, CommentThread, RequirementView, ReviewWorkspaceSummary } from './protocol.ts'
import { DEFAULT_REVIEW_PROMPTS, extractPromptValue, renderPrompt, resolveReviewPrompts, type ResolvedReviewPrompts, type ReviewPromptConfig } from './prompts.ts'
import { ReviewContextCatalog, reviewContextPrompt } from './review-context.ts'
import { readWorkspaceSnapshot } from './workspace-context.ts'

function request<T>(payload: T) { return { rpcId: `spec-collab-${crypto.randomUUID()}` as RpcId, payload } }
function failure(error: { code: string; message: string }): Error { return new Error(`${error.code}: ${error.message}`) }
const FOLLOW_UP_METADATA = '\n\n<!-- dsh-spec-collab-follow-up:'

export class DshReviewCoordinator implements AiCoordinator {
  private readonly prompts: ResolvedReviewPrompts
  constructor(private readonly api: ApiProxy, private readonly contexts = new ReviewContextCatalog(), prompts: ReviewPromptConfig = {}) {
    this.prompts = resolveReviewPrompts(prompts)
  }
  async reviewWorkspaces(): Promise<ReviewWorkspaceSummary[]> {
    const listed = await this.api.workspace.list(request({}))
    if (!listed.result.ok) throw failure(listed.result.error)
    return listed.result.value.items.map(item => ({ workspaceId: item.workspaceId, title: item.title, path: item.path }))
  }
  async assertWorkspaceAvailable(workspaceId: string): Promise<void> {
    await this.resolveWorkspace(workspaceId)
  }
  async requestReview(input: { requirement: RequirementView; run: AiReviewRun }): Promise<string> {
    const context = this.contexts.resolve(input.requirement.workspaceId)
    const workspace = await this.resolveWorkspace(context.workspaceId)
    const snapshot = await readWorkspaceSnapshot(workspace.path, context.documentPaths)
    return this.launch(`Spec ${input.run.kind}: ${input.requirement.title}`, reviewPrompt(input.requirement, input.run, context, workspace, snapshot, this.prompts), context.workspaceId, context.agentPreset)
  }
  async requestCommentReply(input: { requirement: RequirementView; comment: CommentThread }): Promise<string> {
    const context = this.contexts.resolve(input.requirement.workspaceId)
    const workspace = await this.resolveWorkspace(context.workspaceId)
    const snapshot = await readWorkspaceSnapshot(workspace.path, context.documentPaths)
    return this.launch(`Spec comment analysis: ${input.requirement.title}`, commentPrompt(input.requirement, input.comment, context, workspace, snapshot, this.prompts), context.workspaceId, context.agentPreset)
  }
  async conversation(sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    const history = await this.api.sessions.history(request({ sessionId: sessionId as never }))
    if (!history.result.ok) throw failure(history.result.error)
    const rows: Array<{ role: 'user' | 'assistant'; text: string }> = []
    let skippedOrchestrationPrompt = false
    for (const entry of history.result.value.events) {
      if (entry.event.type !== 'user/message' && entry.event.type !== 'assistant/message') continue
      if (entry.event.type === 'user/message' && !skippedOrchestrationPrompt) { skippedOrchestrationPrompt = true; continue }
      const value = entry.event.data as unknown
      const message = isObject(value) && 'message' in value ? value.message : value
      const content = isObject(message) && 'content' in message ? message.content : message
      let messageText = collectText(content).join('\n').trim()
      if (entry.event.type === 'user/message') {
        const followUp = storedFollowUp(messageText)
          ?? extractPromptValue(messageText, this.prompts.followUp.trim(), 'CONTENT')
          ?? extractPromptValue(messageText, DEFAULT_REVIEW_PROMPTS.followUp, 'CONTENT')
        if (followUp === undefined) continue
        messageText = followUp.trim()
      }
      if (messageText !== '') rows.push({ role: entry.event.type === 'user/message' ? 'user' : 'assistant', text: messageText })
    }
    return rows
  }
  async followUp(sessionId: string, text: string): Promise<void> {
    const content = text.trim()
    if (content === '') throw new Error('追问内容不能为空')
    const metadata = Buffer.from(content, 'utf8').toString('base64url')
    const promptText = `${renderPrompt(this.prompts.followUp, { CONTENT: content }).trim()}${FOLLOW_UP_METADATA}${metadata} -->`
    const prompted = await this.api.sessions.prompt(request({ sessionId: sessionId as never, mode: 'queue' as const, content: [{ type: 'text' as const, text: promptText }] }))
    if (!prompted.result.ok) throw failure(prompted.result.error)
  }
  private async launch(title: string, promptText: string, workspaceId: string, agentPreset?: string): Promise<string> {
    if (agentPreset !== undefined) {
      const presets = await this.api.agentPresets.list(request({}))
      if (!presets.result.ok) throw failure(presets.result.error)
      const preset = presets.result.value.presets.find(item => item.id === agentPreset)
      if (preset === undefined || preset.broken !== undefined) throw new Error('agent preset is unavailable')
    }
    const created = await this.api.sessions.create(request({ workspaceId: workspaceId as never, ...(agentPreset === undefined ? {} : { agentPreset }) }))
    if (!created.result.ok) throw failure(created.result.error)
    const sessionId = created.result.value.sessionId
    const renamed = await this.api.sessions.rename(request({ sessionId, title }))
    if (!renamed.result.ok) throw failure(renamed.result.error)
    const prompted = await this.api.sessions.prompt(request({ sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: promptText.replaceAll('{{SESSION_ID}}', sessionId) }] }))
    if (!prompted.result.ok) throw failure(prompted.result.error)
    return sessionId
  }
  private async resolveWorkspace(workspaceId: string): Promise<ReviewWorkspaceSummary> {
    const workspace = (await this.reviewWorkspaces()).find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) throw new Error(`workspace not found: ${workspaceId}`)
    return workspace
  }
}

function storedFollowUp(message: string): string | undefined {
  const index = message.lastIndexOf(FOLLOW_UP_METADATA)
  if (index < 0 || !message.endsWith(' -->')) return undefined
  const encoded = message.slice(index + FOLLOW_UP_METADATA.length, -4)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined
  try { return Buffer.from(encoded, 'base64url').toString('utf8') } catch { return undefined }
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function collectText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectText)
  if (!isObject(value)) return []
  if (value.type === 'text' && typeof value.text === 'string') return [value.text]
  return 'content' in value ? collectText(value.content) : []
}

function common(requirement: RequirementView, context: ReturnType<ReviewContextCatalog['resolve']>, workspace: ReviewWorkspaceSummary, workspaceSnapshot: string, prompts: ResolvedReviewPrompts): string {
  return [
    `Requirement ID: ${requirement.id}`,
    `Pinned commit: ${requirement.currentCommit}`,
    '',
    reviewContextPrompt(context, {
      workspace,
      workspaceSnapshot,
      workspaceTemplate: prompts.workspaceContext,
      resourceTemplate: prompts.resourceInstructions,
    }),
    '',
    prompts.common,
  ].join('\n')
}
function reviewPrompt(requirement: RequirementView, run: AiReviewRun, context: ReturnType<ReviewContextCatalog['resolve']>, workspace: ReviewWorkspaceSummary, workspaceSnapshot: string, prompts: ResolvedReviewPrompts): string {
  const tasks: Record<AiReviewRun['kind'], string> = {
    'product-first': prompts.productFirst,
    'product-second': prompts.productSecond,
    'engineering-precheck': prompts.engineeringPrecheck,
    'change-review': prompts.changeReview,
  }
  return [common(requirement, context, workspace, workspaceSnapshot, prompts), `Review run ID: ${run.id}`, `Review kind: ${run.kind}`, `AI session ID: {{SESSION_ID}}`, '', tasks[run.kind]].join('\n')
}
function commentPrompt(requirement: RequirementView, comment: CommentThread, context: ReturnType<ReviewContextCatalog['resolve']>, workspace: ReviewWorkspaceSummary, workspaceSnapshot: string, prompts: ResolvedReviewPrompts): string {
  return [common(requirement, context, workspace, workspaceSnapshot, prompts), `Comment ID: ${comment.id}`, `Anchor quote: ${comment.anchor.quote}`, `Human comment: ${comment.body}`, `AI session ID: {{SESSION_ID}}`, '', prompts.comment].join('\n')
}
