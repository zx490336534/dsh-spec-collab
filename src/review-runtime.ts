import type { SessionController, SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { AiCoordinator } from './engine.ts'
import type { AiReviewRun, CommentThread, RequirementView, ReviewWorkspaceSummary } from './protocol.ts'
import { DEFAULT_REVIEW_PROMPTS, extractPromptValue, renderPrompt, resolveReviewPrompts, type ResolvedReviewPrompts, type ReviewPromptConfig } from './prompts.ts'
import { ReviewContextCatalog, reviewContextPrompt } from './review-context.ts'
import { readWorkspaceSnapshot } from './workspace-context.ts'

interface ReviewHistoryEvent { type: string; data: unknown }
interface ReviewHistoryPage {
  cursor: number
  records: readonly { type: 'event'; event: ReviewHistoryEvent & { seq: number } }[]
  hasMore: boolean
}
interface ReviewHistoryReader {
  events?(request: { address: { kind: 'session'; sessionId: SessionPromptRequest['sessionId'] }; maxMessages: number; throughSeq?: number; beforeSeq?: number }, signal: AbortSignal): Promise<ReviewHistoryPage>
  inspect?(sessionId: SessionPromptRequest['sessionId'], signal: AbortSignal): Promise<{ events: readonly ReviewHistoryEvent[] }>
}
export interface DshReviewHost {
  sessionController: Pick<SessionController, 'create' | 'rename' | 'prompt'> & ReviewHistoryReader
  workspaceRegistry: Pick<WorkspaceRegistry, 'list'>
  agentPresets: Pick<AgentPresetRegistry, 'list'>
}
const FOLLOW_UP_METADATA = '\n\n<!-- dsh-spec-collab-follow-up:'

export class DshReviewCoordinator implements AiCoordinator {
  private readonly prompts: ResolvedReviewPrompts
  private readonly stageSessions = new Map<string, Promise<string>>()
  private readonly lifetime = new AbortController()
  constructor(private readonly host: DshReviewHost, private readonly contexts = new ReviewContextCatalog(), prompts: ReviewPromptConfig = {}) {
    this.prompts = resolveReviewPrompts(prompts)
  }
  dispose(): void { this.lifetime.abort(); this.stageSessions.clear() }
  async reviewWorkspaces(): Promise<ReviewWorkspaceSummary[]> {
    return this.host.workspaceRegistry.list().map(item => ({ workspaceId: item.id, title: item.title, path: item.path }))
  }
  async assertWorkspaceAvailable(workspaceId: string): Promise<void> {
    await this.resolveWorkspace(workspaceId)
  }
  async requestReview(input: { requirement: RequirementView; run: AiReviewRun; sessionId?: string }): Promise<string> {
    return this.inStageSession(input.requirement, input.sessionId, reviewContinuationPrompt(input.requirement, input.run, this.prompts), async () => {
      const context = this.contexts.resolve(input.requirement.workspaceId)
      const workspace = await this.resolveWorkspace(context.workspaceId)
      const snapshot = await readWorkspaceSnapshot(workspace.path, context.documentPaths)
      return this.launch(`Spec ${input.run.kind}: ${input.requirement.title}`, reviewPrompt(input.requirement, input.run, context, workspace, snapshot, this.prompts), context.workspaceId, context.agentPreset)
    })
  }
  async requestCommentReply(input: { requirement: RequirementView; comment: CommentThread; sessionId?: string }): Promise<string> {
    return this.inStageSession(input.requirement, input.sessionId, commentContinuationPrompt(input.requirement, input.comment, this.prompts), async () => {
      const context = this.contexts.resolve(input.requirement.workspaceId)
      const workspace = await this.resolveWorkspace(context.workspaceId)
      const snapshot = await readWorkspaceSnapshot(workspace.path, context.documentPaths)
      return this.launch(`Spec ${input.requirement.stage}: ${input.requirement.title}`, commentPrompt(input.requirement, input.comment, context, workspace, snapshot, this.prompts), context.workspaceId, context.agentPreset)
    })
  }
  async conversation(sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    const events = await this.conversationEvents(sessionId as SessionPromptRequest['sessionId'])
    const rows: Array<{ role: 'user' | 'assistant'; text: string }> = []
    let skippedOrchestrationPrompt = false
    for (const entry of events) {
      if (entry.type !== 'user/message' && entry.type !== 'assistant/message') continue
      if (entry.type === 'user/message' && !skippedOrchestrationPrompt) { skippedOrchestrationPrompt = true; continue }
      const value = entry.data as unknown
      const message = isObject(value) && 'message' in value ? value.message : value
      const content = isObject(message) && 'content' in message ? message.content : message
      let messageText = collectText(content).join('\n').trim()
      if (entry.type === 'user/message') {
        const followUp = storedFollowUp(messageText)
          ?? extractPromptValue(messageText, this.prompts.followUp.trim(), 'CONTENT')
          ?? extractPromptValue(messageText, DEFAULT_REVIEW_PROMPTS.followUp, 'CONTENT')
        if (followUp === undefined) continue
        messageText = followUp.trim()
      }
      if (messageText !== '') rows.push({ role: entry.type === 'user/message' ? 'user' : 'assistant', text: messageText })
    }
    return rows
  }
  private async conversationEvents(sessionId: SessionPromptRequest['sessionId']): Promise<readonly ReviewHistoryEvent[]> {
    const controller = this.host.sessionController
    if (controller.events !== undefined) {
      const pages: ReviewHistoryEvent[][] = []
      let throughSeq: number | undefined
      let beforeSeq: number | undefined
      for (;;) {
        this.lifetime.signal.throwIfAborted()
        const page = await controller.events({
          address: { kind: 'session', sessionId }, maxMessages: 100,
          ...(throughSeq === undefined ? {} : { throughSeq }),
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        }, this.lifetime.signal)
        throughSeq ??= page.cursor
        pages.push(page.records.map(record => record.event))
        if (!page.hasMore) return pages.reverse().flat()
        const firstSeq = page.records[0]?.event.seq
        if (firstSeq === undefined || !Number.isSafeInteger(firstSeq) || firstSeq < 0 || (beforeSeq !== undefined && firstSeq >= beforeSeq)) throw new Error('history pagination did not advance')
        beforeSeq = firstSeq
      }
    }
    if (controller.inspect !== undefined) return (await controller.inspect(sessionId, this.lifetime.signal)).events
    throw new Error('DSH Session history API is unavailable')
  }
  async followUp(sessionId: string, text: string): Promise<void> {
    const content = text.trim()
    if (content === '') throw new Error('追问内容不能为空')
    const metadata = Buffer.from(content, 'utf8').toString('base64url')
    const promptText = `${renderPrompt(this.prompts.followUp, { CONTENT: content }).trim()}${FOLLOW_UP_METADATA}${metadata} -->`
    await this.promptExisting(sessionId, promptText)
  }
  private async inStageSession(requirement: RequirementView, existingSessionId: string | undefined, continuation: string, launch: () => Promise<string>): Promise<string> {
    const key = `${requirement.id}:${requirement.stage}:${requirement.stageCycle}`
    if (existingSessionId !== undefined) {
      this.rememberStageSession(key, Promise.resolve(existingSessionId))
      await this.promptExisting(existingSessionId, continuation); return existingSessionId
    }
    const pending = this.stageSessions.get(key)
    if (pending !== undefined) { const sessionId = await pending; await this.promptExisting(sessionId, continuation); return sessionId }
    const created = launch(); this.rememberStageSession(key, created)
    try { return await created } catch (error) { if (this.stageSessions.get(key) === created) this.stageSessions.delete(key); throw error }
  }
  private rememberStageSession(key: string, session: Promise<string>): void { this.stageSessions.delete(key); this.stageSessions.set(key, session); while (this.stageSessions.size > 100) { const oldest = this.stageSessions.keys().next().value as string | undefined; if (oldest === undefined) break; this.stageSessions.delete(oldest) } }
  private async promptExisting(sessionId: string, promptText: string): Promise<void> {
    await this.host.sessionController.prompt({
      requestId: `spec-collab-${crypto.randomUUID()}` as SessionPromptRequest['requestId'],
      sessionId: sessionId as SessionPromptRequest['sessionId'],
      mode: 'queue', content: [{ type: 'text', text: promptText }],
    }, this.lifetime.signal)
  }
  private async launch(title: string, promptText: string, workspaceId: string, agentPreset?: string): Promise<string> {
    if (agentPreset !== undefined) {
      const preset = (await this.host.agentPresets.list()).find(item => item.id === agentPreset)
      if (preset === undefined || preset.broken !== undefined) throw new Error('agent preset is unavailable')
    }
    const { sessionId } = await this.host.sessionController.create({ workspaceId: workspaceId as WorkspaceId, ...(agentPreset === undefined ? {} : { agentPreset }) })
    await this.host.sessionController.rename({ sessionId, title })
    await this.promptExisting(sessionId, promptText.replaceAll('{{SESSION_ID}}', sessionId))
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
  return [common(requirement, context, workspace, workspaceSnapshot, prompts), `Comment ID: ${comment.id}`, `Comment scope: ${comment.scope}`, `Anchor quote: ${comment.anchor?.quote ?? '整篇需求'}`, `Human comment: ${comment.body}`, `AI session ID: {{SESSION_ID}}`, '', prompts.comment].join('\n')
}
function reviewContinuationPrompt(requirement: RequirementView, run: AiReviewRun, prompts: ResolvedReviewPrompts): string {
  const tasks: Record<AiReviewRun['kind'], string> = { 'product-first': prompts.productFirst, 'product-second': prompts.productSecond, 'engineering-precheck': prompts.engineeringPrecheck, 'change-review': prompts.changeReview }
  return ['继续当前需求同一阶段的审核。不要重复读取已知背景，只使用 spec_read 获取当前 commit 的增量变化。', `Requirement ID: ${requirement.id}`, `Current stage: ${requirement.stage}`, `Pinned commit: ${requirement.currentCommit}`, `Review run ID: ${run.id}`, `Review kind: ${run.kind}`, '', tasks[run.kind]].join('\n')
}
function commentContinuationPrompt(requirement: RequirementView, comment: CommentThread, prompts: ResolvedReviewPrompts): string {
  return ['在当前需求同一阶段的既有上下文中分析这条新评论。不要重新扫描整个工作区；仅在评论涉及新的实现事实时做最小增量查询。', `Requirement ID: ${requirement.id}`, `Pinned commit: ${requirement.currentCommit}`, `Comment ID: ${comment.id}`, `Comment scope: ${comment.scope}`, `Anchor quote: ${comment.anchor?.quote ?? '整篇需求'}`, `Human comment: ${comment.body}`, '', prompts.comment].join('\n')
}
