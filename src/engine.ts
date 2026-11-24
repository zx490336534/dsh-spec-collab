import { createHash, randomUUID } from 'node:crypto'
import { CollaborationLedger } from './collaboration-ledger.ts'
import { GitRequirementStore, VersionConflictError, type PreparedSpecCommit } from './git-store.ts'
import { applyInsightAction, insightMetrics, isInsightAction, queryInsights, type InsightPage, type InsightQuery } from './insights.ts'
import { type ActionItem, type ActionResult, type AiReviewRun, type CandidatePatch, type CollaborationAction, type CollaborationEvent, type CollaborationState, type CommentThread, type MyActionItem, type MyItemCategory, type Notification, type ParticipantSnapshot, type RequirementMetrics, type RequirementRecord, type RequirementSummary, type RequirementVersion, type RequirementView, type ReviewItem, type ReviewKind, type SaveConflict, type StructuredDiff } from './protocol.ts'
import { buildStructuredDiff } from './structured-diff.ts'
import { readyAdmission } from './ready-admission.ts'
import { advance, decisionScopeAnchors, enterStage, invalidateAffected, normalizeAnchorText, readiness, readyMarkdown, retireActionItems, versionChanged } from './spec-lifecycle.ts'

export { readiness } from './spec-lifecycle.ts'

export interface AiCoordinator {
  requestReview(input: { requirement: RequirementView; run: AiReviewRun; sessionId?: string }): Promise<string>
  requestCommentReply(input: { requirement: RequirementView; comment: CommentThread; sessionId?: string }): Promise<string>
}

type EventDraft = Omit<CollaborationEvent, 'revision'>
type AiTask = { kind: 'review' | 'comment'; id: string }
type ActionChange = { requirementId: string; spec?: PreparedSpecCommit; task?: AiTask; deleted?: RequirementView; unchanged?: true }
type VersionAction = Extract<CollaborationAction, { kind: 'requirement.rename' | 'version.save' | 'version.restore' | 'patch.accept' }>

export class CollaborationEngine {
  private state: CollaborationState
  private readonly ledger: CollaborationLedger
  private coordinator?: AiCoordinator
  private readonly listeners = new Set<(event: CollaborationEvent) => void>()
  private readonly seen = new Map<string, ActionResult>()

  constructor(eventPath: string, private readonly versions: GitRequirementStore, options: { legacyPath?: string } = {}) {
    this.ledger = new CollaborationLedger(eventPath, change => versions.publish(change), options.legacyPath)
    this.state = this.ledger.load()
  }
  setCoordinator(coordinator: AiCoordinator): void {
    if (this.coordinator === undefined) {
      // A queued task loaded from disk has no durable acknowledgement from DSH.
      // Allow an explicit retry without dispatching a possibly admitted prompt twice.
      this.changeAi(() => {
        let interrupted = false
        const now = Date.now()
        for (const record of this.state.requirements) {
          for (const run of record.aiRuns) {
            if (run.status !== 'queued') continue
            run.status = 'failed'
            run.error = 'AI launch was interrupted before acknowledgement'
            run.updatedAt = now
            interrupted = true
          }
          for (const comment of record.comments) {
            if (comment.aiStatus !== 'queued') continue
            comment.aiStatus = 'failed'
            comment.updatedAt = now
            interrupted = true
          }
        }
        if (interrupted) return { types: ['ai.status', 'comment.changed', 'metrics.changed'] }
      })
    }
    this.coordinator = coordinator
  }
  get revision(): number { return this.state.revision }
  snapshot(): CollaborationState { return structuredClone(this.state) }
  overview() {
    return { revision: this.revision, participants: structuredClone(this.state.participants), requirements: this.summaries() }
  }
  directory(): ParticipantSnapshot[] { return structuredClone(this.state.participants).sort((left, right) => left.nickname.localeCompare(right.nickname, 'zh-CN')) }
  notifications(participantId: string, page = 1, pageSize = 50): { items: Notification[]; total: number; unread: number } {
    const rows = this.state.notifications.filter(item => item.recipientParticipantId === participantId).sort((left, right) => right.createdAt - left.createdAt)
    const safePage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1
    const safePageSize = Number.isFinite(pageSize) ? Math.min(100, Math.max(1, Math.trunc(pageSize))) : 50
    const start = (safePage - 1) * safePageSize
    return { items: structuredClone(rows.slice(start, start + safePageSize)), total: rows.length, unread: rows.filter(item => item.readAt === undefined).length }
  }
  insights(query?: InsightQuery): InsightPage { return queryInsights(this.state, query) }
  subscribe(listener: (event: CollaborationEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  list(): RequirementView[] { return this.state.requirements.map(item => this.view(item.id)) }
  summaries(): RequirementSummary[] {
    return this.state.requirements.map(record => ({
      id: record.id,
      title: record.title,
      stage: record.stage,
      currentCommit: record.currentCommit,
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
      updatedAt: record.updatedAt,
      metrics: requirementMetrics(record, this.state),
      participantIds: requirementParticipantIds(record, this.versions.history(record.id, record.currentCommit)),
    }))
  }
  version(requirementId: string, commit: string): RequirementVersion {
    const record = this.record(requirementId)
    if (!this.versions.history(record.id, record.currentCommit).some(version => version.commit === commit)) throw new Error('requirement version not found')
    return this.versions.read(record.id, commit)
  }
  diff(requirementId: string, baseCommit: string, headCommit?: string): StructuredDiff {
    const record = this.record(requirementId); const head = headCommit ?? record.currentCommit
    const before = this.version(requirementId, baseCommit); const after = this.version(requirementId, head)
    return buildStructuredDiff(before.markdown, after.markdown, baseCommit.slice(0, 10), head.slice(0, 10))
  }
  myItems(participant: ParticipantSnapshot, category?: MyItemCategory): MyActionItem[] {
    const rows: MyActionItem[] = []
    for (const record of this.state.requirements) {
      for (const item of record.actionItems.filter(candidate => candidate.status === 'pending')) {
        const categories: MyItemCategory[] = []
        const assigned = item.assigneeParticipantId === participant.participantId || (item.assigneeParticipantId === undefined && item.assigneeRole === participant.role)
        if (assigned) categories.push(item.type === 'confirm' || item.type === 'reconfirm' ? 'awaiting-my-confirmation' : 'awaiting-my-response')
        if (sourceParticipantId(record, item) === participant.participantId) categories.push('initiated-by-me')
        for (const current of categories) if (category === undefined || category === current) rows.push({ ...structuredClone(item), category: current, requirementTitle: record.title, objectTitle: actionObjectTitle(record, item), target: actionTarget(item) })
      }
    }
    return rows.sort((left, right) => Number(right.blocking) - Number(left.blocking) || right.updatedAt - left.updatedAt)
  }
  hasAiSession(requirementId: string, sessionId: string): boolean {
    const record = this.record(requirementId)
    return record.aiRuns.some(run => run.sessionId === sessionId) || record.comments.some(comment => comment.aiSessionId === sessionId)
  }
  view(id: string): RequirementView {
    const record = this.record(id)
    const history = this.versions.history(id, record.currentCommit)
    const version = this.versions.read(id, record.currentCommit)
    const commitUrl = this.versions.commitUrl(record.currentCommit)
    return { ...structuredClone(record), version, history, readiness: readiness(version.markdown, record), metrics: requirementMetrics(record, this.state), ...(commitUrl ? { commitUrl } : {}) }
  }

  apply(requestId: string, action: CollaborationAction): ActionResult {
    const cached = this.seen.get(requestId)
    if (cached !== undefined) return structuredClone(cached)
    let result: ActionResult
    let committed: { value: { requirement: RequirementView; change: ActionChange }; event?: CollaborationEvent } | undefined
    try {
      committed = this.transact(() => {
        const participant = action.participant
        requireHuman(participant)
        const registered = this.state.participants.find(item => item.participantId === participant.participantId)
        if (registered !== undefined && registered.role !== participant.role) throw new Error(`participant role is bound to ${registered.role}`)
        const change = this.applyFresh(action)
        if (registered === undefined) this.state.participants.push(structuredClone(participant))
        const event = change.unchanged && registered !== undefined ? undefined : eventForAction(action, change)
        return { value: { requirement: change.deleted ?? this.view(change.requirementId), change }, event, spec: change.spec }
      })
      const { requirement, change } = committed.value
      result = { ok: true, revision: committed.event?.revision ?? this.state.revision, requirement, ...(change.deleted ? { deletedRequirementId: change.requirementId } : {}) }
    } catch (error) {
      const conflict = error instanceof VersionConflictError && action.kind === 'version.save' ? this.saveConflict(action, error.currentCommit) : undefined
      result = { ok: false, revision: this.state.revision, error: errorMessage(error), ...(conflict ? { conflict } : {}) }
    }
    this.seen.set(requestId, result)
    if (committed !== undefined) {
      this.emit(committed.event)
      const { requirement, change } = committed.value
      if (change.task) this.launchAiTask(requirement, change.task)
    }
    return structuredClone(result)
  }

  submitReview(input: { requirementId: string; commit: string; runId: string; ai: ParticipantSnapshot; items: Omit<ReviewItem, 'id' | 'requirementId' | 'commit' | 'reviewKind' | 'createdAt' | 'updatedAt'>[]; maturitySummary: string }): void {
    this.changeAi(() => {
      const record = this.record(input.requirementId)
      const run = record.aiRuns.find(item => item.id === input.runId)
      if (run === undefined || run.commit !== input.commit || record.currentCommit !== input.commit) throw new Error('review run is stale')
      if (run.status === 'completed') return
      assertChineseFeedback(input.maturitySummary)
      const now = Date.now()
      for (const item of input.items) {
        assertChineseFeedback(item.statement, item.impact, item.question)
        if (item.epistemicStatus === 'FACT' && !item.evidence.some(evidence => evidence.accessible && evidence.version?.trim())) throw new Error('FACT requires accessible versioned evidence')
        const recommendedOptions = item.recommendedOptions?.map(option => option.trim()).filter(Boolean)
        const created: ReviewItem = { ...item, ...(recommendedOptions ? { recommendedOptions } : {}), id: randomUUID(), requirementId: record.id, commit: input.commit, reviewKind: run.kind, createdAt: now, updatedAt: now }
        record.reviewItems.push(created)
        record.actionItems.push(actionForReview(created))
      }
      run.status = 'completed'
      run.maturitySummary = input.maturitySummary
      run.updatedAt = now
      delete run.error
      return aiEvent(record.id, run.id)
    })
  }

  submitPatch(input: { requirementId: string; baseCommit: string; reviewKind: ReviewKind; ai: ParticipantSnapshot; proposedMarkdown: string; summary: string; affectedReviewItemIds: string[]; affectedSections: string[]; affectedAcceptanceIds: string[] }): void {
    this.changeAi(() => {
      const record = this.record(input.requirementId)
      if (record.currentCommit !== input.baseCommit) throw new Error('patch base commit is stale')
      assertChineseFeedback(input.summary, input.proposedMarkdown)
      const now = Date.now()
      const patch: CandidatePatch = { id: randomUUID(), requirementId: record.id, baseCommit: input.baseCommit, reviewKind: input.reviewKind, proposedMarkdown: input.proposedMarkdown, summary: input.summary, affectedReviewItemIds: input.affectedReviewItemIds, affectedSections: input.affectedSections, affectedAcceptanceIds: input.affectedAcceptanceIds, createdBy: input.ai, status: 'pending', createdAt: now }
      record.patches.push(patch)
      record.actionItems.push({ id: randomUUID(), requirementId: record.id, sourceType: 'patch', sourceId: patch.id, type: 'confirm', assigneeRole: input.reviewKind === 'engineering-precheck' ? 'engineering' : 'product', blocking: true, status: 'pending', dueStage: record.stage, createdAt: now, updatedAt: now })
      return aiEvent(record.id, patch.id)
    })
  }

  submitAiReply(input: { requirementId: string; commentId: string; ai: ParticipantSnapshot; body: string }): void {
    this.changeAi(() => {
      assertChineseFeedback(input.body)
      const record = this.record(input.requirementId)
      const comment = this.comment(record, input.commentId)
      const now = Date.now()
      comment.replies.push({ id: randomUUID(), author: input.ai, body: input.body, mentions: [], createdAt: now })
      comment.aiStatus = 'completed'
      comment.updatedAt = now
      return aiEvent(record.id, comment.id, true)
    })
  }

  markAiFailure(requirementId: string, sourceId: string, error: string): void {
    this.changeAi(() => {
      const record = this.state.requirements.find(item => item.id === requirementId)
      if (record === undefined) return
      const run = record.aiRuns.find(item => item.id === sourceId)
      const comment = record.comments.find(item => item.id === sourceId)
      if (run !== undefined && (run.status === 'queued' || run.status === 'running')) {
        run.status = 'failed'
        run.error = error
        run.updatedAt = Date.now()
        return aiEvent(record.id, run.id)
      }
      if (comment !== undefined && (comment.aiStatus === 'queued' || comment.aiStatus === 'running')) {
        comment.aiStatus = 'failed'
        comment.updatedAt = Date.now()
        return aiEvent(record.id, comment.id, true)
      }
    })
  }

  private applyFresh(action: CollaborationAction): ActionChange {
    const now = Date.now()
    if (action.kind === 'requirement.create') {
      const title = action.title.trim()
      if (title === '' || action.rawRequirement.trim() === '') throw new Error('title and original requirement are required')
      const workspaceId = action.workspaceId?.trim()
      if (workspaceId === undefined || workspaceId === '') throw new Error('review workspace is required')
      const spec = this.versions.prepareCreate({ title, rawRequirement: action.rawRequirement, sources: action.sources, participant: action.participant })
      const record: RequirementRecord = { id: spec.requirementId, title, stage: 'product-review', stageCycle: 0, currentCommit: spec.commit, workspaceId, sources: action.sources, reviewItems: [], comments: [], patches: [], decisions: [], confirmations: [], actionItems: [], aiRuns: [], aiConversations: [], createdAt: now, updatedAt: now }
      this.state.requirements.unshift(record)
      return { requirementId: record.id, spec, task: this.queueReview(record, action.participant, 'product-first', now) }
    }
    const record = this.record(action.requirementId)
    if (action.kind === 'requirement.bind-workspace') {
      const workspaceId = action.workspaceId.trim()
      if (workspaceId === '') throw new Error('review workspace is required')
      if (record.workspaceId !== undefined) throw new Error('review workspace is already bound')
      record.workspaceId = workspaceId
      record.updatedAt = now
    } else if (action.kind === 'requirement.archive' || action.kind === 'requirement.unarchive') {
      if (action.kind === 'requirement.archive' && action.archived) record.archivedAt = now
      else delete record.archivedAt
      record.updatedAt = now
    } else if (action.kind === 'requirement.delete') {
      const deleted = this.view(record.id)
      const spec = this.versions.prepareRemove(record.id, record.currentCommit, action.participant)
      this.state.requirements.splice(this.state.requirements.indexOf(record), 1)
      this.state.insightLinks = this.state.insightLinks.filter(item => item.requirementId !== record.id)
      return { requirementId: record.id, spec, deleted }
    } else if (action.kind === 'requirement.rename' || action.kind === 'version.save' || action.kind === 'version.restore' || action.kind === 'patch.accept') {
      return this.changeVersion(record, action, now)
    } else if (action.kind === 'review.request') {
      return { requirementId: record.id, task: this.queueReview(record, action.participant, action.reviewKind, now) }
    } else if (action.kind === 'review.respond') {
      const item = record.reviewItems.find(candidate => candidate.id === action.reviewItemId)
      if (item === undefined) throw new Error('review item not found')
      item.response = { participant: action.participant, disposition: action.disposition, body: action.body.trim(), createdAt: now }
      item.status = action.disposition === 'joint-review' ? 'joint-review' : action.disposition === 'to-verify' ? 'non-blocking-verify' : action.disposition === 'accept' ? 'resolved' : 'answered'
      item.updatedAt = now
      record.actionItems.filter(task => task.sourceId === item.id && task.status === 'pending').forEach(task => { task.status = 'handled'; task.updatedAt = now })
    } else if (action.kind === 'comment.create') {
      if (action.commit !== record.currentCommit) throw new VersionConflictError(record.currentCommit)
      const scope = action.scope ?? 'inline'; const mentions = validMentions(action.mentions, this.state.participants)
      const comment: CommentThread = { id: randomUUID(), requirementId: record.id, commit: action.commit, scope, ...(action.anchor === undefined ? {} : { anchor: action.anchor }), author: action.participant, body: action.body.trim(), mentions, replies: [], aiStatus: this.coordinator ? 'queued' : 'failed', status: 'open', createdAt: now, updatedAt: now }
      if (comment.body === '' || (scope === 'inline' && action.anchor?.quote.trim() === '')) throw new Error(scope === 'inline' ? 'comment and anchor are required' : 'comment is required')
      if (scope === 'inline' && action.anchor === undefined) throw new Error('comment and anchor are required')
      record.comments.push(comment)
      record.actionItems.push({ id: randomUUID(), requirementId: record.id, sourceType: 'comment', sourceId: comment.id, type: 'reply', assigneeRole: action.participant.role === 'product' ? 'engineering' : 'product', blocking: true, status: 'pending', dueStage: record.stage, createdAt: now, updatedAt: now })
      for (const participantId of mentions) this.notify(participantId, 'mention', record, 'comment', comment.id, `${action.participant.nickname} 在评论中提到了你`)
      return { requirementId: record.id, task: { kind: 'comment', id: comment.id } }
    } else if (action.kind === 'comment.reply') {
      const comment = this.comment(record, action.commentId)
      const body = action.body.trim(); if (body === '') throw new Error('reply is required')
      const mentions = validMentions(action.mentions, this.state.participants)
      comment.replies.push({ id: randomUUID(), author: action.participant, body, mentions, createdAt: now }); comment.updatedAt = now
      if (comment.author.participantId !== action.participant.participantId) this.notify(comment.author.participantId, 'reply', record, 'comment', comment.id, `${action.participant.nickname} 回复了你的评论`)
      for (const participantId of mentions) this.notify(participantId, 'mention', record, 'comment', comment.id, `${action.participant.nickname} 在回复中提到了你`)
    } else if (action.kind === 'comment.resolve') {
      const comment = this.comment(record, action.commentId)
      comment.status = 'resolved'; comment.resolution = action.resolution; comment.updatedAt = now
      if (comment.author.participantId !== action.participant.participantId) this.notify(comment.author.participantId, 'status-change', record, 'comment', comment.id, `${action.participant.nickname} 已解决你的评论`)
      record.actionItems.filter(task => task.sourceId === comment.id && task.status === 'pending').forEach(task => { task.status = 'handled'; task.updatedAt = now })
    } else if (action.kind === 'comment.reopen') {
      const comment = this.comment(record, action.commentId)
      if (comment.status !== 'resolved') throw new Error('resolved comment not found')
      comment.status = 'open'; delete comment.resolution; comment.updatedAt = now
      record.actionItems.push({ id: randomUUID(), requirementId: record.id, sourceType: 'comment', sourceId: comment.id, type: 'reply', assigneeRole: comment.author.role === 'product' ? 'engineering' : 'product', blocking: false, status: 'pending', dueStage: record.stage, createdAt: now, updatedAt: now })
      if (comment.author.participantId !== action.participant.participantId) this.notify(comment.author.participantId, 'status-change', record, 'comment', comment.id, `${action.participant.nickname} 重新打开了你的评论`)
    } else if (action.kind === 'patch.reject') {
      const patch = record.patches.find(item => item.id === action.patchId && item.status === 'pending')
      if (patch === undefined) throw new Error('pending patch not found')
      patch.status = 'rejected'
      retireActionItems(record, 'patch', patch.id, 'handled', now)
    } else if (action.kind === 'decision.create') {
      const sourceAnchors = [...(action.sourceAnchors ?? []), ...decisionScopeAnchors(this.versions.read(record.id, record.currentCommit).markdown, action.affectedSections, action.affectedAcceptanceIds)]
        .filter((anchor, index, anchors) => anchor.quote.trim() !== '' && anchors.findIndex(candidate => normalizeAnchorText(candidate.quote) === normalizeAnchorText(anchor.quote) && normalizeAnchorText(candidate.heading ?? '') === normalizeAnchorText(anchor.heading ?? '')) === index)
      record.decisions.push({ id: randomUUID(), requirementId: record.id, commit: record.currentCommit, question: action.question, options: action.options, decision: action.decision, rationale: action.rationale, confirmer: action.participant, affectedSections: action.affectedSections, affectedAcceptanceIds: action.affectedAcceptanceIds, ...(sourceAnchors.length > 0 ? { sourceAnchors } : {}), createdAt: now, status: 'active' })
    } else if (action.kind === 'confirmation.create') {
      if (action.participant.role !== action.role) throw new Error(`${action.role} role is required`)
      record.confirmations.push({ id: randomUUID(), requirementId: record.id, commit: record.currentCommit, role: action.role, participant: action.participant, scope: action.scope, ...(action.scopeId === undefined ? {} : { scopeId: action.scopeId }), status: 'active', createdAt: now })
      if (action.role === 'product' && action.scope === 'version') record.productConfirmedCommit = record.currentCommit
      if (action.role === 'engineering' && action.scope === 'version') record.jointConfirmedCommit = record.currentCommit
    } else if (action.kind === 'stage.advance') {
      advance(record, action.participant)
    } else if (action.kind === 'ready.generate') {
      const body = this.versions.read(record.id, record.currentCommit).markdown
      const admission = readyAdmission(record, readiness(body, record))
      if (admission.error) throw new Error(admission.error)
      const markdown = readyMarkdown(record, body)
      record.readyPackage = { requirementId: record.id, commit: record.currentCommit, packageHash: createHash('sha256').update(markdown).digest('hex'), generatedAt: now, generatedBy: action.participant, markdown }
      enterStage(record, 'ready')
    } else if (action.kind === 'participant.register') {
      const participant = this.state.participants.find(item => item.participantId === action.participant.participantId)
      if (participant !== undefined) { participant.nickname = action.participant.nickname; participant.role = action.participant.role }
    } else if (action.kind === 'action.assign') {
      const task = record.actionItems.find(item => item.id === action.actionItemId)
      if (task === undefined) throw new Error('action item not found')
      if (action.assigneeParticipantId !== undefined && !this.state.participants.some(item => item.participantId === action.assigneeParticipantId && item.role === action.assigneeRole)) throw new Error('assignee is not a registered participant with the selected role')
      task.assigneeRole = action.assigneeRole
      if (action.dueStage !== undefined) task.dueStage = action.dueStage
      if (action.assigneeParticipantId === undefined) delete task.assigneeParticipantId
      else { task.assigneeParticipantId = action.assigneeParticipantId; this.notify(action.assigneeParticipantId, 'assignment', record, 'action', task.id, `${action.participant.nickname} 向你指派了一个待办`) }
      task.updatedAt = now
    } else if (action.kind === 'notification.mark-read') {
      const ids = new Set(action.notificationIds)
      this.state.notifications.filter(item => item.recipientParticipantId === action.participant.participantId && item.requirementId === record.id && ids.has(item.id)).forEach(item => { item.readAt ??= now })
    } else if (isInsightAction(action)) {
      applyInsightAction(this.state, action, now)
    } else if (action.kind === 'downstream.return') {
      if (action.summary.trim() === '') throw new Error('downstream issue summary is required')
      if (action.affectedSections.length === 0 && action.affectedAcceptanceIds.length === 0) throw new Error('downstream return requires an affected section or AC')
      const item: ReviewItem = {
        id: randomUUID(), requirementId: record.id, commit: record.currentCommit, reviewKind: 'change-review', type: 'semantics', severity: 'blocking',
        statement: action.summary.trim(), evidence: action.evidence, epistemicStatus: action.evidence.some(evidence => evidence.accessible && evidence.version !== undefined) ? 'FACT' : 'TO_VERIFY',
        impact: `下游发现影响 ${[...action.affectedSections, ...action.affectedAcceptanceIds].join('、')}，需要重新澄清并确认。`, question: '应如何修订受影响的需求语义或验收标准？',
        affectedSections: [...new Set(action.affectedSections)], affectedAcceptanceIds: [...new Set(action.affectedAcceptanceIds)], ownerRole: 'product', status: 'open', createdAt: now, updatedAt: now,
      }
      record.reviewItems.push(item)
      record.actionItems.push(actionForReview(item))
      invalidateAffected(record, item.affectedSections, item.affectedAcceptanceIds)
      delete record.readyPackage
      enterStage(record, 'joint-review')
      record.updatedAt = now
      return { requirementId: record.id, task: this.queueReview(record, action.participant, 'change-review', now) }
    }
    return { requirementId: record.id }
  }

  private changeVersion(record: RequirementRecord, action: VersionAction, now: number): ActionChange {
    const before = this.versions.read(record.id, record.currentCommit).markdown
    let baseCommit = record.currentCommit
    let markdown: string
    let summary: string
    let acceptedPatch: CandidatePatch | undefined
    if (action.kind === 'requirement.rename') {
      const title = action.title.trim()
      if (title === '' || title.length > 120 || /[\r\n]/.test(title)) throw new Error('valid requirement title is required')
      if (title === record.title) return { requirementId: record.id, unchanged: true }
      markdown = /^# .+$/m.test(before) ? before.replace(/^# .+$/m, () => `# ${title}`) : `# ${title}\n\n${before}`
      summary = `Rename requirement: ${title}`
      record.title = title
    } else if (action.kind === 'version.restore') {
      const historical = this.version(record.id, action.commit)
      if (historical.commit === record.currentCommit) throw new Error('selected version is already current')
      markdown = historical.markdown
      summary = action.summary.trim() || `恢复版本 ${historical.commit.slice(0, 8)}`
    } else if (action.kind === 'patch.accept') {
      acceptedPatch = record.patches.find(item => item.id === action.patchId && item.status === 'pending')
      if (acceptedPatch === undefined) throw new Error('pending patch not found')
      baseCommit = acceptedPatch.baseCommit
      markdown = acceptedPatch.proposedMarkdown
      summary = action.summary
    } else {
      baseCommit = action.baseCommit
      markdown = action.markdown
      summary = action.summary
    }
    const spec = this.versions.prepareSave({ requirementId: record.id, baseCommit, markdown, participant: action.participant, summary })
    if (acceptedPatch) {
      acceptedPatch.status = 'accepted'
      retireActionItems(record, 'patch', acceptedPatch.id, 'handled', now)
      for (const item of record.reviewItems.filter(item => acceptedPatch.affectedReviewItemIds.includes(item.id))) {
        item.status = 'resolved'
        item.updatedAt = now
        retireActionItems(record, 'review-item', item.id, 'handled', now)
      }
    }
    versionChanged(record, before, { commit: spec.commit, markdown }, now)
    return { requirementId: record.id, spec, task: this.queueReview(record, action.participant, 'change-review', now) }
  }

  private rememberStageConversation(record: RequirementRecord, sessionId: string, stage = record.stage, stageCycle = record.stageCycle): void {
    const now = Date.now(); const existing = record.aiConversations.find(item => item.stage === stage && item.stageCycle === stageCycle)
    if (existing) { existing.sessionId = sessionId; existing.updatedAt = now } else record.aiConversations.push({ stage, stageCycle, sessionId, createdAt: now, updatedAt: now })
  }

  private notify(recipientParticipantId: string, kind: Notification['kind'], record: RequirementRecord, objectType: Notification['objectType'], objectId: string, message: string): void {
    if (!this.state.participants.some(item => item.participantId === recipientParticipantId)) return
    const deepLink = `#spec-collab/${encodeURIComponent(record.id)}/${objectType === 'comment' ? 'discussion' : 'tasks'}/${encodeURIComponent(objectId)}?commit=${encodeURIComponent(record.currentCommit)}`
    this.state.notifications.push({ id: randomUUID(), recipientParticipantId, kind, requirementId: record.id, objectType, objectId, message, deepLink, createdAt: Date.now() })
  }

  private saveConflict(action: Extract<CollaborationAction, { kind: 'version.save' }>, currentCommit: string): SaveConflict | undefined {
    try {
      const baseMarkdown = this.versions.read(action.requirementId, action.baseCommit).markdown
      const currentMarkdown = this.versions.read(action.requirementId, currentCommit).markdown
      return { requirementId: action.requirementId, baseCommit: action.baseCommit, currentCommit, baseMarkdown, currentMarkdown, draftMarkdown: action.markdown, baseToCurrentDiff: textDiff(baseMarkdown, currentMarkdown), baseToDraftDiff: textDiff(baseMarkdown, action.markdown) }
    } catch {
      return undefined
    }
  }

  private queueReview(record: RequirementRecord, participant: ParticipantSnapshot, kind: ReviewKind, now: number): AiTask {
    const run: AiReviewRun = { id: randomUUID(), requirementId: record.id, commit: record.currentCommit, kind, status: 'queued', requestedBy: participant, createdAt: now, updatedAt: now }
    if (!this.coordinator) {
      run.status = 'failed'
      run.error = 'AI coordinator unavailable'
    }
    record.aiRuns.push(run)
    return { kind: 'review', id: run.id }
  }

  private launchAiTask(view: RequirementView, task: AiTask): void {
    const coordinator = this.coordinator
    if (coordinator === undefined) return
    const session = view.aiConversations.find(item => item.stage === view.stage && item.stageCycle === view.stageCycle)
    const context = { requirement: view, ...(session ? { sessionId: session.sessionId } : {}) }
    let pending: Promise<string>
    try {
      pending = task.kind === 'review'
        ? coordinator.requestReview({ ...context, run: view.aiRuns.find(item => item.id === task.id)! })
        : coordinator.requestCommentReply({ ...context, comment: view.comments.find(item => item.id === task.id)! })
    } catch (error) {
      pending = Promise.reject(error)
    }
    void pending.then(
      sessionId => this.recordAiSession(view, task, sessionId),
      error => this.markAiFailure(view.id, task.id, errorMessage(error)),
    ).catch(error => console.error('spec-collab: could not persist AI task update', error))
  }

  private recordAiSession(view: Pick<RequirementView, 'id' | 'stage' | 'stageCycle'>, task: AiTask, sessionId: string): void {
    this.changeAi(() => {
      const record = this.state.requirements.find(item => item.id === view.id)
      if (record === undefined) return
      const now = Date.now()
      if (task.kind === 'review') {
        const run = record.aiRuns.find(item => item.id === task.id)
        if (run === undefined) return
        if (run.status === 'queued') run.status = 'running'
        run.sessionId = sessionId
        run.updatedAt = now
      } else {
        const comment = record.comments.find(item => item.id === task.id)
        if (comment === undefined) return
        if (comment.aiStatus === 'queued') comment.aiStatus = 'running'
        comment.aiSessionId = sessionId
        comment.updatedAt = now
      }
      this.rememberStageConversation(record, sessionId, view.stage, view.stageCycle)
      return aiEvent(record.id, task.id, task.kind === 'comment')
    })
  }

  private changeAi(update: () => EventDraft | undefined): void {
    const committed = this.transact(() => ({ value: undefined, event: update() }))
    this.emit(committed.event)
  }

  private transact<T>(update: () => { value: T; event?: EventDraft | undefined; spec?: PreparedSpecCommit | undefined }): { value: T; event?: CollaborationEvent } {
    const before = this.state
    this.state = structuredClone(before)
    try {
      const { value, event, spec } = update()
      if (event === undefined) {
        this.state = before
        return { value }
      }
      const revision = before.revision + 1
      this.state.revision = revision
      this.ledger.save(this.state, spec)
      return { value, event: { ...event, revision } }
    } catch (error) {
      this.state = before
      throw error
    }
  }

  private emit(event: CollaborationEvent | undefined): void {
    if (event === undefined) return
    for (const listener of this.listeners) {
      try { listener(event) }
      catch { this.listeners.delete(listener) }
    }
  }

  private record(id: string): RequirementRecord { const value = this.state.requirements.find(item => item.id === id); if (value === undefined) throw new Error('requirement not found'); return value }
  private comment(record: RequirementRecord, id: string): CommentThread { const value = record.comments.find(item => item.id === id); if (value === undefined) throw new Error('comment not found'); return value }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function aiEvent(requirementId: string, objectId: string, comment = false): EventDraft {
  return { requirementId, objectId, types: comment ? ['ai.status', 'comment.changed', 'metrics.changed'] : ['ai.status', 'metrics.changed'] }
}

function eventForAction(action: CollaborationAction, change: ActionChange): EventDraft {
  const types = new Set<CollaborationEvent['types'][number]>(['metrics.changed'])
  if (action.kind.startsWith('comment.')) types.add('comment.changed')
  if (action.kind === 'comment.create' || action.kind === 'comment.reply') {
    if ((action.mentions?.length ?? 0) > 0) types.add('mention.created')
    types.add('notification.changed')
  }
  if (action.kind === 'comment.resolve' || action.kind === 'comment.reopen') types.add('notification.changed')
  if (action.kind === 'action.assign') { types.add('assignment.changed'); types.add('notification.changed') }
  if (action.kind === 'notification.mark-read') types.add('notification.changed')
  if (change.task) types.add('ai.status')
  return { types: [...types], requirementId: change.requirementId, ...(change.task ? { objectId: change.task.id } : {}) }
}

function validMentions(values: string[] | undefined, participants: ParticipantSnapshot[]): string[] {
  const registered = new Set(participants.map(item => item.participantId))
  return [...new Set(values ?? [])].filter(value => registered.has(value))
}

function requirementMetrics(record: RequirementRecord, state: CollaborationState): RequirementMetrics {
  return {
    openReviewCount: record.reviewItems.filter(item => item.commit === record.currentCommit && !['resolved', 'invalidated'].includes(item.status)).length,
    openCommentCount: record.comments.filter(item => item.commit === record.currentCommit && item.status === 'open').length,
    pendingActionCount: record.actionItems.filter(item => item.status === 'pending').length,
    activeDecisionCount: record.decisions.filter(item => item.status === 'active').length,
    riskCount: record.reviewItems.filter(item => item.commit === record.currentCommit && ['blocking', 'major'].includes(item.severity) && !['resolved', 'invalidated'].includes(item.status)).length,
    ...insightMetrics(state, record.id),
  }
}

function requirementParticipantIds(record: RequirementRecord, history: Array<Omit<RequirementVersion, 'markdown'>>): string[] {
  return [...new Set([
    ...history.map(item => item.author.participantId),
    ...record.reviewItems.flatMap(item => item.response ? [item.response.participant.participantId] : []),
    ...record.comments.flatMap(item => [item.author.participantId, ...item.replies.map(reply => reply.author.participantId)]),
    ...record.decisions.map(item => item.confirmer.participantId),
    ...record.confirmations.map(item => item.participant.participantId),
    ...record.actionItems.flatMap(item => item.assigneeParticipantId ? [item.assigneeParticipantId] : []),
  ])]
}

function sourceParticipantId(record: RequirementRecord, item: ActionItem): string | undefined {
  if (item.sourceType === 'comment') return record.comments.find(value => value.id === item.sourceId)?.author.participantId
  if (item.sourceType === 'patch') return record.patches.find(value => value.id === item.sourceId)?.createdBy.participantId
  if (item.sourceType === 'decision') return record.decisions.find(value => value.id === item.sourceId)?.confirmer.participantId
  if (item.sourceType === 'confirmation') return record.confirmations.find(value => value.id === item.sourceId)?.participant.participantId
  return record.reviewItems.find(value => value.id === item.sourceId)?.response?.participant.participantId
}
function actionTarget(item: ActionItem): MyActionItem['target'] {
  const tabs = { 'review-item': 'review', comment: 'discussion', patch: 'patches', decision: 'decisions', confirmation: 'ready' } as const
  return { tab: tabs[item.sourceType], objectId: item.sourceId }
}
function actionObjectTitle(record: RequirementRecord, item: ActionItem): string {
  if (item.sourceType === 'review-item') {
    const review = record.reviewItems.find(value => value.id === item.sourceId)
    return review?.question.trim() || review?.statement.trim() || '待处理问题'
  }
  if (item.sourceType === 'comment') {
    const comment = record.comments.find(value => value.id === item.sourceId)
    return comment?.anchor?.quote.trim() || comment?.body.trim() || '待回复评论'
  }
  if (item.sourceType === 'patch') return record.patches.find(value => value.id === item.sourceId)?.summary.trim() || '待审核正文改动'
  if (item.sourceType === 'decision') return record.decisions.find(value => value.id === item.sourceId)?.question.trim() || '待确认决策'
  const confirmation = record.confirmations.find(value => value.id === item.sourceId)
  return confirmation ? `${confirmation.role === 'product' ? '产品' : '研发'}需要重新确认当前版本` : '待确认当前版本'
}
function textDiff(before: string, after: string): string {
  if (before === after) return ''
  const left = before.split('\n'); const right = after.split('\n')
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1
  let leftEnd = left.length - 1; let rightEnd = right.length - 1
  while (leftEnd >= start && rightEnd >= start && left[leftEnd] === right[rightEnd]) { leftEnd -= 1; rightEnd -= 1 }
  const contextStart = Math.max(0, start - 2); const contextLeftEnd = Math.min(left.length - 1, leftEnd + 2); const contextRightEnd = Math.min(right.length - 1, rightEnd + 2)
  return [`@@ -${contextStart + 1},${contextLeftEnd - contextStart + 1} +${contextStart + 1},${contextRightEnd - contextStart + 1} @@`, ...left.slice(contextStart, start).map(line => ` ${line}`), ...left.slice(start, leftEnd + 1).map(line => `-${line}`), ...right.slice(start, rightEnd + 1).map(line => `+${line}`), ...right.slice(rightEnd + 1, contextRightEnd + 1).map(line => ` ${line}`)].join('\n')
}
function assertChineseFeedback(...values: string[]): void {
  if (values.some(value => !/[\u3400-\u9fff]/.test(value))) throw new Error('AI 评审反馈必须使用中文')
}
function requireHuman(participant: ParticipantSnapshot): void { if (participant.kind !== 'human') throw new Error('human participant is required') }
function actionForReview(item: ReviewItem): ActionItem { const now = Date.now(); return { id: randomUUID(), requirementId: item.requirementId, sourceType: 'review-item', sourceId: item.id, type: 'reply', assigneeRole: item.ownerRole, blocking: item.severity === 'blocking', status: 'pending', dueStage: item.reviewKind.startsWith('product') ? 'product-review' : 'joint-review', createdAt: now, updatedAt: now } }
