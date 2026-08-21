import type { ApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { AiCoordinator } from './engine.ts'
import type { AiReviewRun, CommentThread, RequirementView, ReviewWorkspaceSummary } from './protocol.ts'
import { ReviewContextCatalog, reviewContextPrompt } from './review-context.ts'

function request<T>(payload: T) { return { rpcId: `spec-collab-${crypto.randomUUID()}` as RpcId, payload } }
function failure(error: { code: string; message: string }): Error { return new Error(`${error.code}: ${error.message}`) }

export class DshReviewCoordinator implements AiCoordinator {
  constructor(private readonly api: ApiProxy, private readonly contexts = new ReviewContextCatalog()) {}
  async reviewWorkspaces(): Promise<ReviewWorkspaceSummary[]> {
    const listed = await this.api.workspace.list(request({}))
    if (!listed.result.ok) throw failure(listed.result.error)
    return listed.result.value.items.map(item => ({ workspaceId: item.workspaceId, title: item.title, path: item.path }))
  }
  async assertWorkspaceAvailable(workspaceId: string): Promise<void> {
    if (!(await this.reviewWorkspaces()).some(item => item.workspaceId === workspaceId)) throw new Error(`workspace not found: ${workspaceId}`)
  }
  requestReview(input: { requirement: RequirementView; run: AiReviewRun }): Promise<string> {
    const context = this.contexts.resolve(input.requirement.workspaceId)
    return this.launch(`Spec ${input.run.kind}: ${input.requirement.title}`, reviewPrompt(input.requirement, input.run, context), context.workspaceId, context.agentPreset)
  }
  requestCommentReply(input: { requirement: RequirementView; comment: CommentThread }): Promise<string> {
    const context = this.contexts.resolve(input.requirement.workspaceId)
    return this.launch(`Spec comment analysis: ${input.requirement.title}`, commentPrompt(input.requirement, input.comment, context), context.workspaceId, context.agentPreset)
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
        const marker = '请使用简体中文回答以下追问，并继续遵守当前 Spec 审核任务的证据、权限和结构化回写约束。'
        if (!messageText.startsWith(marker)) continue
        messageText = messageText.slice(marker.length).trim()
      }
      if (messageText !== '') rows.push({ role: entry.event.type === 'user/message' ? 'user' : 'assistant', text: messageText })
    }
    return rows
  }
  async followUp(sessionId: string, text: string): Promise<void> {
    const content = text.trim()
    if (content === '') throw new Error('追问内容不能为空')
    const prompted = await this.api.sessions.prompt(request({ sessionId: sessionId as never, mode: 'queue' as const, content: [{ type: 'text' as const, text: `请使用简体中文回答以下追问，并继续遵守当前 Spec 审核任务的证据、权限和结构化回写约束。\n\n${content}` }] }))
    if (!prompted.result.ok) throw failure(prompted.result.error)
  }
  private async launch(title: string, promptText: string, workspaceId: string, agentPreset?: string): Promise<string> {
    await this.assertWorkspaceAvailable(workspaceId)
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
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function collectText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectText)
  if (!isObject(value)) return []
  if (value.type === 'text' && typeof value.text === 'string') return [value.text]
  return 'content' in value ? collectText(value.content) : []
}

function common(requirement: RequirementView, context: ReturnType<ReviewContextCatalog['resolve']>): string {
  return [
    `Requirement ID: ${requirement.id}`,
    `Pinned commit: ${requirement.currentCommit}`,
    '',
    reviewContextPrompt(context),
    '',
    '所有面向用户的输出必须使用简体中文，包括 Review Item 的陈述、影响、问题、成熟度总结、候选 patch 摘要以及评论分析回复。仅保留代码标识、路径、commit SHA、AC ID、FACT / INFERENCE / ASSUMPTION / TO_VERIFY 等固定枚举为原文。',
    'You are a review worker for a requirements clarification product. You must not implement code, generate downstream test delivery, create worktrees, deploy, or mark the requirement Ready. AI output is proposal data only and requires human confirmation.',
    'A FACT must cite an accessible, version-pinned source. If evidence is unavailable, use TO_VERIFY; never invent historical or implementation conflicts.',
    'Use spec_read to retrieve the exact current data. Do not modify files directly.',
    '每个 Review Item 必须给出至少三个具体、互斥或有明确取舍差异的 recommendedOptions，供用户快速选择；不得只重复“接受、拒绝、待验证”这类通用状态。',
  ].join('\n')
}
function reviewPrompt(requirement: RequirementView, run: AiReviewRun, context: ReturnType<ReviewContextCatalog['resolve']>): string {
  const tasks: Record<AiReviewRun['kind'], string> = {
    'product-first': 'Perform the initial product review across goal, evidence, history-conflict, current-implementation, scope, semantics, completeness, acceptance, and risk. Submit structured findings with spec_submit_review. If the draft needs changes, also submit a candidate patch with spec_propose_patch.',
    'product-second': 'Review product responses against their original Review Items. Do not close vague answers. Submit remaining/new findings with spec_submit_review and a reviewable candidate patch with spec_propose_patch.',
    'engineering-precheck': 'Read the product-confirmed Spec and inspect relevant current code/history available in the workspace. Find implementation fact conflicts, affected entries/roles/states, technical ambiguity, compatibility/permission/data boundaries, and unverifiable acceptance criteria. Submit with spec_submit_review and propose a patch only when needed.',
    'change-review': 'Review only the latest saved commit against its parent. Identify materiality, affected sections/ACs, confirmations or decisions that need reconfirmation, and new conflicts. Submit with spec_submit_review; propose a patch only when needed.',
  }
  return [common(requirement, context), `Review run ID: ${run.id}`, `Review kind: ${run.kind}`, `AI session ID: {{SESSION_ID}}`, '', tasks[run.kind]].join('\n')
}
function commentPrompt(requirement: RequirementView, comment: CommentThread, context: ReturnType<ReviewContextCatalog['resolve']>): string {
  return [common(requirement, context), `Comment ID: ${comment.id}`, `Anchor quote: ${comment.anchor.quote}`, `Human comment: ${comment.body}`, `AI session ID: {{SESSION_ID}}`, '', 'Analyze this substantive comment. First query any code/document facts you can obtain. Then use spec_reply exactly once with your understanding, versioned evidence or TO_VERIFY status, affected sections/ACs, and recommended disposition. Do not silently modify the Spec or choose between conflicting product and engineering positions.'].join('\n')
}
