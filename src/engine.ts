import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { GitRequirementStore, VersionConflictError } from './git-store.ts'
import { SCHEMA_VERSION, type ActionItem, type ActionResult, type AiReviewRun, type CandidatePatch, type CollaborationAction, type CollaborationEvent, type CollaborationState, type CommentThread, type FeedbackSource, type Insight, type InsightImportance, type InsightLink, type MyActionItem, type MyItemCategory, type Notification, type ParticipantSnapshot, type ReadinessCheck, type RequirementMetrics, type RequirementRecord, type RequirementSummary, type RequirementVersion, type RequirementView, type ReviewItem, type ReviewKind, type SaveConflict, type StructuredDiff } from './protocol.ts'
import { buildStructuredDiff } from './structured-diff.ts'
import { hasCompletedCurrentReview, hasVersionConfirmation, readyAdmission } from './ready-admission.ts'

export interface AiCoordinator {
  requestReview(input: { requirement: RequirementView; run: AiReviewRun; sessionId?: string }): Promise<string>
  requestCommentReply(input: { requirement: RequirementView; comment: CommentThread; sessionId?: string }): Promise<string>
}

const emptyState = (): CollaborationState => ({ schemaVersion: SCHEMA_VERSION, revision: 0, participants: [], requirements: [], companies: [], customers: [], feedbackSources: [], insights: [], insightLinks: [], notifications: [] })

type EngineResult = ActionResult
type DecisionSourceAnchor = NonNullable<Extract<CollaborationAction, { kind: 'decision.create' }>['sourceAnchors']>[number]

export class CollaborationEngine {
  private state: CollaborationState
  private coordinator?: AiCoordinator
  private readonly listeners = new Set<(event: CollaborationEvent) => void>()
  private readonly seen = new Map<string, EngineResult>()
  private eventContext: Omit<CollaborationEvent, 'revision'> | undefined

  constructor(private readonly eventPath: string, private readonly versions: GitRequirementStore, private readonly options: { legacyPath?: string } = {}) { this.state = this.load() }
  setCoordinator(coordinator: AiCoordinator): void { this.coordinator = coordinator }
  snapshot(): CollaborationState { return structuredClone(this.state) }
  directory(): ParticipantSnapshot[] { return structuredClone(this.state.participants).sort((left, right) => left.nickname.localeCompare(right.nickname, 'zh-CN')) }
  notifications(participantId: string, page = 1, pageSize = 50): { items: Notification[]; total: number; unread: number } {
    const rows = this.state.notifications.filter(item => item.recipientParticipantId === participantId).sort((left, right) => right.createdAt - left.createdAt)
    const safePage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1
    const safePageSize = Number.isFinite(pageSize) ? Math.min(100, Math.max(1, Math.trunc(pageSize))) : 50
    const start = (safePage - 1) * safePageSize
    return { items: structuredClone(rows.slice(start, start + safePageSize)), total: rows.length, unread: rows.filter(item => item.readAt === undefined).length }
  }
  insights(query: { requirementId?: string; customerId?: string; companyId?: string; sourceId?: string; importance?: InsightImportance; page?: number; pageSize?: number } = {}): { items: Insight[]; total: number; links: CollaborationState['insightLinks']; customers: CollaborationState['customers']; companies: CollaborationState['companies']; sources: CollaborationState['feedbackSources'] } {
    const linkedIds = query.requirementId === undefined ? undefined : new Set(this.state.insightLinks.filter(link => link.requirementId === query.requirementId).map(link => link.insightId))
    const rows = this.state.insights.filter(item => { const companyId = item.companyId ?? (item.customerId ? this.state.customers.find(customer => customer.id === item.customerId)?.companyId : undefined); return (linkedIds === undefined || linkedIds.has(item.id)) && (query.customerId === undefined || item.customerId === query.customerId) && (query.companyId === undefined || companyId === query.companyId) && (query.sourceId === undefined || item.sourceId === query.sourceId) && (query.importance === undefined || item.importance === query.importance) }).sort((left, right) => right.capturedAt - left.capturedAt)
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 50)); const start = Math.max(0, (query.page ?? 1) - 1) * pageSize
    const page = rows.slice(start, start + pageSize); const ids = new Set(page.map(item => item.id)); const customerIds = new Set(page.flatMap(item => item.customerId ? [item.customerId] : [])); const companyIds = new Set(page.flatMap(item => item.companyId ? [item.companyId] : [])); for (const customer of this.state.customers.filter(item => customerIds.has(item.id))) if (customer.companyId) companyIds.add(customer.companyId)
    return { items: structuredClone(page), total: rows.length, links: structuredClone(this.state.insightLinks.filter(item => ids.has(item.insightId))), customers: structuredClone(this.state.customers.filter(item => customerIds.has(item.id))), companies: structuredClone(this.state.companies.filter(item => companyIds.has(item.id))), sources: structuredClone(this.state.feedbackSources.filter(item => page.some(insight => insight.sourceId === item.id))) }
  }
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
      participantIds: requirementParticipantIds(record, this.versions.history(record.id)),
    }))
  }
  version(requirementId: string, commit: string): RequirementVersion {
    const record = this.record(requirementId)
    if (!this.versions.history(record.id).some(version => version.commit === commit)) throw new Error('requirement version not found')
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
    const version = this.versions.read(id, record.currentCommit)
    const commitUrl = this.versions.commitUrl(record.currentCommit)
    return { ...structuredClone(record), version, history: this.versions.history(id), readiness: readiness(version.markdown, record), metrics: requirementMetrics(record, this.state), ...(commitUrl ? { commitUrl } : {}) }
  }

  apply(requestId: string, action: CollaborationAction): EngineResult {
    const cached = this.seen.get(requestId)
    if (cached !== undefined) return structuredClone(cached)
    let result: EngineResult
    const beforeState = structuredClone(this.state)
    const previousEventContext = this.eventContext
    this.eventContext = eventForAction(action)
    try {
      const registered = action.participant.kind === 'human' ? this.state.participants.find(item => item.participantId === action.participant.participantId) : undefined
      if (registered !== undefined && registered.role !== action.participant.role) throw new Error(`participant role is bound to ${registered.role}`)
      result = this.applyFresh(action)
      if (result.ok && action.participant.kind === 'human' && registered === undefined) {
        this.state.participants.push(structuredClone(action.participant)); this.persist()
        result = result.deletedRequirementId
          ? { ...result, revision: this.state.revision }
          : { ok: true, revision: this.state.revision, requirement: result.requirement }
      }
    }
    catch (error) {
      this.state = beforeState
      const conflict = error instanceof VersionConflictError && action.kind === 'version.save' ? this.saveConflict(action) : undefined
      result = { ok: false, revision: this.state.revision, error: error instanceof Error ? error.message : String(error), ...(conflict === undefined ? {} : { conflict }) }
    }
    this.eventContext = previousEventContext
    this.seen.set(requestId, result)
    return structuredClone(result)
  }

  submitReview(input: { requirementId: string; commit: string; runId: string; ai: ParticipantSnapshot; items: Omit<ReviewItem, 'id' | 'requirementId' | 'commit' | 'reviewKind' | 'createdAt' | 'updatedAt'>[]; maturitySummary: string }): void {
    const record = this.record(input.requirementId)
    const run = record.aiRuns.find(item => item.id === input.runId)
    if (run === undefined || run.commit !== input.commit || record.currentCommit !== input.commit) throw new Error('review run is stale')
    assertChineseFeedback(input.maturitySummary)
    const now = Date.now()
    for (const item of input.items) {
      assertChineseFeedback(item.statement, item.impact, item.question)
      if (item.epistemicStatus === 'FACT' && !item.evidence.some(evidence => evidence.accessible && evidence.version !== undefined && evidence.version !== '')) throw new Error('FACT requires accessible versioned evidence')
      const recommendedOptions = item.recommendedOptions?.map(option => option.trim()).filter(Boolean)
      const created: ReviewItem = { ...item, ...(recommendedOptions ? { recommendedOptions } : {}), id: randomUUID(), requirementId: record.id, commit: input.commit, reviewKind: run.kind, createdAt: now, updatedAt: now }
      record.reviewItems.push(created)
      record.actionItems.push(actionForReview(created))
    }
    run.status = 'completed'; run.maturitySummary = input.maturitySummary; run.updatedAt = now
    this.persist({ types: ['ai.status', 'metrics.changed'], requirementId: record.id, objectId: run.id })
  }

  submitPatch(input: { requirementId: string; baseCommit: string; reviewKind: ReviewKind; ai: ParticipantSnapshot; proposedMarkdown: string; summary: string; affectedReviewItemIds: string[]; affectedSections: string[]; affectedAcceptanceIds: string[] }): void {
    const record = this.record(input.requirementId)
    if (record.currentCommit !== input.baseCommit) throw new Error('patch base commit is stale')
    assertChineseFeedback(input.summary, input.proposedMarkdown)
    const patch: CandidatePatch = { id: randomUUID(), requirementId: record.id, baseCommit: input.baseCommit, reviewKind: input.reviewKind, proposedMarkdown: input.proposedMarkdown, summary: input.summary, affectedReviewItemIds: input.affectedReviewItemIds, affectedSections: input.affectedSections, affectedAcceptanceIds: input.affectedAcceptanceIds, createdBy: input.ai, status: 'pending', createdAt: Date.now() }
    record.patches.push(patch)
    record.actionItems.push({ id: randomUUID(), requirementId: record.id, sourceType: 'patch', sourceId: patch.id, type: 'confirm', assigneeRole: input.reviewKind === 'engineering-precheck' ? 'engineering' : 'product', blocking: true, status: 'pending', dueStage: record.stage, createdAt: Date.now(), updatedAt: Date.now() })
    this.persist({ types: ['ai.status', 'metrics.changed'], requirementId: record.id, objectId: patch.id })
  }

  submitAiReply(input: { requirementId: string; commentId: string; ai: ParticipantSnapshot; body: string }): void {
    assertChineseFeedback(input.body)
    const record = this.record(input.requirementId)
    const comment = this.comment(record, input.commentId)
    comment.replies.push({ id: randomUUID(), author: input.ai, body: input.body, mentions: [], createdAt: Date.now() })
    comment.aiStatus = 'completed'; comment.updatedAt = Date.now()
    this.persist({ types: ['ai.status', 'comment.changed', 'metrics.changed'], requirementId: record.id, objectId: comment.id })
  }

  markAiFailure(requirementId: string, sourceId: string, error: string): void {
    const record = this.record(requirementId)
    const run = record.aiRuns.find(item => item.id === sourceId)
    if (run !== undefined) { run.status = 'failed'; run.error = error; run.updatedAt = Date.now() }
    const comment = record.comments.find(item => item.id === sourceId)
    if (comment !== undefined) { comment.aiStatus = 'failed'; comment.updatedAt = Date.now() }
    this.persist({ types: ['ai.status', 'metrics.changed'], requirementId, objectId: sourceId })
  }

  private applyFresh(action: CollaborationAction): EngineResult {
    const now = Date.now()
    if (action.kind === 'requirement.create') {
      requireHuman(action.participant)
      const title = action.title.trim()
      if (title === '' || action.rawRequirement.trim() === '') throw new Error('title and original requirement are required')
      const workspaceId = action.workspaceId?.trim()
      if (workspaceId === undefined || workspaceId === '') throw new Error('review workspace is required')
      const created = this.versions.create({ title, rawRequirement: action.rawRequirement, sources: action.sources, participant: action.participant })
      const record: RequirementRecord = { id: created.requirementId, title, stage: 'product-review', stageCycle: 0, currentCommit: created.version.commit, workspaceId, sources: action.sources, reviewItems: [], comments: [], patches: [], decisions: [], confirmations: [], actionItems: [], aiRuns: [], aiConversations: [], createdAt: now, updatedAt: now }
      this.state.requirements.unshift(record); this.persist(undefined, true)
      this.enqueueReview(record, action.participant, 'product-first')
      return { ok: true, revision: this.state.revision, requirement: this.view(record.id) }
    }
    const record = this.record(action.requirementId)
    if (action.kind === 'requirement.bind-workspace') {
      requireHuman(action.participant)
      const workspaceId = action.workspaceId.trim()
      if (workspaceId === '') throw new Error('review workspace is required')
      if (record.workspaceId !== undefined) throw new Error('review workspace is already bound')
      record.workspaceId = workspaceId; record.updatedAt = now; this.persist()
    } else if (action.kind === 'requirement.rename') {
      requireHuman(action.participant)
      const title = action.title.trim()
      if (title === '' || title.length > 120 || /[\r\n]/.test(title)) throw new Error('valid requirement title is required')
      if (title === record.title) return { ok: true, revision: this.state.revision, requirement: this.view(record.id) }
      const before = this.versions.read(record.id, record.currentCommit).markdown
      const markdown = /^# .+$/m.test(before) ? before.replace(/^# .+$/m, `# ${title}`) : `# ${title}\n\n${before}`
      const version = this.versions.save({ requirementId: record.id, baseCommit: record.currentCommit, markdown, participant: action.participant, summary: `Rename requirement: ${title}` })
      record.title = title; record.currentCommit = version.commit; record.updatedAt = now
      invalidateAffected(record, [], []); this.persist(undefined, true); this.enqueueReview(record, action.participant, 'change-review')
    } else if (action.kind === 'requirement.archive' || action.kind === 'requirement.unarchive') {
      requireHuman(action.participant)
      if (action.kind === 'requirement.archive' && action.archived) record.archivedAt = now
      else delete record.archivedAt
      record.updatedAt = now; this.persist()
    } else if (action.kind === 'requirement.delete') {
      requireHuman(action.participant)
      const deleted = this.view(record.id)
      this.versions.remove(record.id, action.participant)
      this.state.requirements.splice(this.state.requirements.indexOf(record), 1)
      this.state.insightLinks = this.state.insightLinks.filter(item => item.requirementId !== record.id)
      this.persist(undefined, true)
      return { ok: true, revision: this.state.revision, requirement: deleted, deletedRequirementId: record.id }
    } else if (action.kind === 'version.save') {
      requireHuman(action.participant)
      const before = this.versions.read(record.id, record.currentCommit).markdown
      const version = this.versions.save({ requirementId: record.id, baseCommit: action.baseCommit, markdown: action.markdown, participant: action.participant, summary: action.summary })
      const impact = changedScopes(before, action.markdown)
      record.currentCommit = version.commit; record.updatedAt = now; delete record.readyPackage
      invalidateAffected(record, impact.sections, impact.acceptanceIds, action.markdown)
      record.patches.filter(item => item.status === 'pending').forEach(item => { item.status = 'stale' })
      if (record.stage === 'ready') enterStage(record, 'joint-review')
      this.persist(undefined, true)
      this.enqueueReview(record, action.participant, 'change-review')
    } else if (action.kind === 'version.restore') {
      requireHuman(action.participant)
      const historical = this.version(record.id, action.commit)
      if (historical.commit === record.currentCommit) throw new Error('selected version is already current')
      const before = this.versions.read(record.id, record.currentCommit).markdown
      const version = this.versions.save({ requirementId: record.id, baseCommit: record.currentCommit, markdown: historical.markdown, participant: action.participant, summary: action.summary.trim() || `恢复版本 ${historical.commit.slice(0, 8)}` })
      const impact = changedScopes(before, historical.markdown)
      record.currentCommit = version.commit; record.updatedAt = now; delete record.readyPackage
      invalidateAffected(record, impact.sections, impact.acceptanceIds, historical.markdown)
      record.patches.filter(item => item.status === 'pending').forEach(item => { item.status = 'stale' })
      if (record.stage === 'ready') enterStage(record, 'joint-review')
      this.persist(undefined, true); this.enqueueReview(record, action.participant, 'change-review')
    } else if (action.kind === 'review.request') {
      requireHuman(action.participant)
      this.enqueueReview(record, action.participant, action.reviewKind)
    } else if (action.kind === 'review.respond') {
      requireHuman(action.participant)
      const item = record.reviewItems.find(candidate => candidate.id === action.reviewItemId)
      if (item === undefined) throw new Error('review item not found')
      item.response = { participant: action.participant, disposition: action.disposition, body: action.body.trim(), createdAt: now }
      item.status = action.disposition === 'joint-review' ? 'joint-review' : action.disposition === 'to-verify' ? 'non-blocking-verify' : action.disposition === 'accept' ? 'resolved' : 'answered'
      item.updatedAt = now
      record.actionItems.filter(task => task.sourceId === item.id && task.status === 'pending').forEach(task => { task.status = 'handled'; task.updatedAt = now })
      this.persist()
    } else if (action.kind === 'comment.create') {
      requireHuman(action.participant)
      if (action.commit !== record.currentCommit) throw new VersionConflictError(record.currentCommit)
      const scope = action.scope ?? 'inline'; const mentions = validMentions(action.mentions, this.state.participants)
      const comment: CommentThread = { id: randomUUID(), requirementId: record.id, commit: action.commit, scope, ...(action.anchor === undefined ? {} : { anchor: action.anchor }), author: action.participant, body: action.body.trim(), mentions, replies: [], aiStatus: 'queued', status: 'open', createdAt: now, updatedAt: now }
      if (comment.body === '' || (scope === 'inline' && action.anchor?.quote.trim() === '')) throw new Error(scope === 'inline' ? 'comment and anchor are required' : 'comment is required')
      if (scope === 'inline' && action.anchor === undefined) throw new Error('comment and anchor are required')
      record.comments.push(comment)
      record.actionItems.push({ id: randomUUID(), requirementId: record.id, sourceType: 'comment', sourceId: comment.id, type: 'reply', assigneeRole: action.participant.role === 'product' ? 'engineering' : 'product', blocking: true, status: 'pending', dueStage: record.stage, createdAt: now, updatedAt: now })
      for (const participantId of mentions) this.notify(participantId, 'mention', record, 'comment', comment.id, `${action.participant.nickname} 在评论中提到了你`)
      this.persist()
      const coordinator = this.coordinator
      if (coordinator !== undefined) {
        const view = this.view(record.id)
        const requestedStage = record.stage; const requestedStageCycle = record.stageCycle
        const existingSession = record.aiConversations.find(item => item.stage === requestedStage && item.stageCycle === requestedStageCycle)?.sessionId
        void coordinator.requestCommentReply({ requirement: view, comment, ...(existingSession ? { sessionId: existingSession } : {}) }).then(sessionId => {
          comment.aiStatus = 'running'; comment.aiSessionId = sessionId; comment.updatedAt = Date.now(); this.rememberStageConversation(record, sessionId, requestedStage, requestedStageCycle); this.persist({ types: ['ai.status', 'comment.changed', 'metrics.changed'], requirementId: record.id, objectId: comment.id })
        }, error => this.markAiFailure(record.id, comment.id, error instanceof Error ? error.message : String(error)))
      }
    } else if (action.kind === 'comment.reply') {
      requireHuman(action.participant)
      const comment = this.comment(record, action.commentId)
      const body = action.body.trim(); if (body === '') throw new Error('reply is required')
      const mentions = validMentions(action.mentions, this.state.participants)
      comment.replies.push({ id: randomUUID(), author: action.participant, body, mentions, createdAt: now }); comment.updatedAt = now
      if (comment.author.participantId !== action.participant.participantId) this.notify(comment.author.participantId, 'reply', record, 'comment', comment.id, `${action.participant.nickname} 回复了你的评论`)
      for (const participantId of mentions) this.notify(participantId, 'mention', record, 'comment', comment.id, `${action.participant.nickname} 在回复中提到了你`)
      this.persist()
    } else if (action.kind === 'comment.resolve') {
      requireHuman(action.participant)
      const comment = this.comment(record, action.commentId)
      comment.status = 'resolved'; comment.resolution = action.resolution; comment.updatedAt = now
      if (comment.author.participantId !== action.participant.participantId) this.notify(comment.author.participantId, 'status-change', record, 'comment', comment.id, `${action.participant.nickname} 已解决你的评论`)
      record.actionItems.filter(task => task.sourceId === comment.id && task.status === 'pending').forEach(task => { task.status = 'handled'; task.updatedAt = now }); this.persist()
    } else if (action.kind === 'comment.reopen') {
      requireHuman(action.participant)
      const comment = this.comment(record, action.commentId)
      if (comment.status !== 'resolved') throw new Error('resolved comment not found')
      comment.status = 'open'; delete comment.resolution; comment.updatedAt = now
      record.actionItems.push({ id: randomUUID(), requirementId: record.id, sourceType: 'comment', sourceId: comment.id, type: 'reply', assigneeRole: comment.author.role === 'product' ? 'engineering' : 'product', blocking: false, status: 'pending', dueStage: record.stage, createdAt: now, updatedAt: now })
      if (comment.author.participantId !== action.participant.participantId) this.notify(comment.author.participantId, 'status-change', record, 'comment', comment.id, `${action.participant.nickname} 重新打开了你的评论`)
      this.persist()
    } else if (action.kind === 'patch.accept') {
      requireHuman(action.participant)
      const patch = record.patches.find(item => item.id === action.patchId)
      if (patch === undefined || patch.status !== 'pending') throw new Error('pending patch not found')
      const version = this.versions.save({ requirementId: record.id, baseCommit: patch.baseCommit, markdown: patch.proposedMarkdown, participant: action.participant, summary: action.summary })
      const before = this.versions.read(record.id, record.currentCommit).markdown
      const impact = changedScopes(before, patch.proposedMarkdown)
      record.currentCommit = version.commit; patch.status = 'accepted'; record.updatedAt = now; delete record.readyPackage
      record.patches.filter(item => item.id !== patch.id && item.status === 'pending').forEach(item => { item.status = 'stale' })
      if (record.stage === 'ready') enterStage(record, 'joint-review')
      for (const id of patch.affectedReviewItemIds) { const item = record.reviewItems.find(candidate => candidate.id === id); if (item !== undefined) { item.status = 'resolved'; item.updatedAt = now } }
      invalidateAffected(record, impact.sections, impact.acceptanceIds, patch.proposedMarkdown)
      record.actionItems.filter(task => task.sourceId === patch.id && task.status === 'pending').forEach(task => { task.status = 'handled'; task.updatedAt = now }); this.persist(undefined, true)
      this.enqueueReview(record, action.participant, 'change-review')
    } else if (action.kind === 'patch.reject') {
      requireHuman(action.participant)
      const patch = record.patches.find(item => item.id === action.patchId); if (patch === undefined) throw new Error('patch not found'); patch.status = 'rejected'; this.persist()
    } else if (action.kind === 'decision.create') {
      requireHuman(action.participant)
      const sourceAnchors = [...(action.sourceAnchors ?? []), ...decisionScopeAnchors(this.versions.read(record.id, record.currentCommit).markdown, action.affectedSections, action.affectedAcceptanceIds)]
        .filter((anchor, index, anchors) => anchor.quote.trim() !== '' && anchors.findIndex(candidate => normalizeAnchorText(candidate.quote) === normalizeAnchorText(anchor.quote) && normalizeAnchorText(candidate.heading ?? '') === normalizeAnchorText(anchor.heading ?? '')) === index)
      record.decisions.push({ id: randomUUID(), requirementId: record.id, commit: record.currentCommit, question: action.question, options: action.options, decision: action.decision, rationale: action.rationale, confirmer: action.participant, affectedSections: action.affectedSections, affectedAcceptanceIds: action.affectedAcceptanceIds, ...(sourceAnchors.length > 0 ? { sourceAnchors } : {}), createdAt: now, status: 'active' }); this.persist()
    } else if (action.kind === 'confirmation.create') {
      requireHuman(action.participant)
      if (action.participant.role !== action.role) throw new Error(`${action.role} role is required`)
      record.confirmations.push({ id: randomUUID(), requirementId: record.id, commit: record.currentCommit, role: action.role, participant: action.participant, scope: action.scope, ...(action.scopeId === undefined ? {} : { scopeId: action.scopeId }), status: 'active', createdAt: now })
      if (action.role === 'product' && action.scope === 'version') record.productConfirmedCommit = record.currentCommit
      if (action.role === 'engineering' && action.scope === 'version') record.jointConfirmedCommit = record.currentCommit
      this.persist()
    } else if (action.kind === 'stage.advance') {
      requireHuman(action.participant)
      advance(record, action.participant); this.persist()
    } else if (action.kind === 'ready.generate') {
      requireHuman(action.participant)
      const admission = readyAdmission(record, readiness(this.versions.read(record.id, record.currentCommit).markdown, record))
      if (admission.error) throw new Error(admission.error)
      const markdown = readyMarkdown(this.view(record.id))
      record.readyPackage = { requirementId: record.id, commit: record.currentCommit, packageHash: createHash('sha256').update(markdown).digest('hex'), generatedAt: now, generatedBy: action.participant, markdown }
      enterStage(record, 'ready'); this.persist()
    } else if (action.kind === 'participant.register') {
      requireHuman(action.participant)
      const participant = this.state.participants.find(item => item.participantId === action.participant.participantId)
      if (participant !== undefined) { participant.nickname = action.participant.nickname; participant.role = action.participant.role; this.persist() }
    } else if (action.kind === 'action.assign') {
      requireHuman(action.participant)
      const task = record.actionItems.find(item => item.id === action.actionItemId)
      if (task === undefined) throw new Error('action item not found')
      if (action.assigneeParticipantId !== undefined && !this.state.participants.some(item => item.participantId === action.assigneeParticipantId && item.role === action.assigneeRole)) throw new Error('assignee is not a registered participant with the selected role')
      task.assigneeRole = action.assigneeRole
      if (action.dueStage !== undefined) task.dueStage = action.dueStage
      if (action.assigneeParticipantId === undefined) delete task.assigneeParticipantId
      else { task.assigneeParticipantId = action.assigneeParticipantId; this.notify(action.assigneeParticipantId, 'assignment', record, 'action', task.id, `${action.participant.nickname} 向你指派了一个待办`) }
      task.updatedAt = now; this.persist()
    } else if (action.kind === 'notification.mark-read') {
      requireHuman(action.participant)
      const ids = new Set(action.notificationIds)
      this.state.notifications.filter(item => item.recipientParticipantId === action.participant.participantId && item.requirementId === record.id && ids.has(item.id)).forEach(item => { item.readAt ??= now })
      this.persist()
    } else if (action.kind === 'source.upsert') {
      requireHuman(action.participant)
      const input = cleanSource(action.source); const existing = this.state.feedbackSources.find(item => item.id === input.id)
      const source: FeedbackSource = { ...input, createdAt: existing?.createdAt ?? now, updatedAt: now }
      validateSource(source)
      if (existing === undefined) this.state.feedbackSources.push(source); else Object.assign(existing, source)
      this.persist()
    } else if (action.kind === 'company.upsert') {
      requireHuman(action.participant)
      const input = cleanCompany(action.company); validateCompany(input)
      const existing = this.state.companies.find(item => item.id === input.id); const company = { ...input, createdAt: existing?.createdAt ?? now, updatedAt: now }
      if (existing === undefined) this.state.companies.push(company); else Object.assign(existing, company)
      this.persist()
    } else if (action.kind === 'customer.upsert') {
      requireHuman(action.participant)
      const input = cleanCustomer(action.customer); validateCustomer(input, this.state)
      const existing = this.state.customers.find(item => item.id === input.id); const customer = { ...input, createdAt: existing?.createdAt ?? now, updatedAt: now }
      if (existing === undefined) this.state.customers.push(customer); else Object.assign(existing, customer)
      this.persist()
    } else if (action.kind === 'insight.create') {
      requireHuman(action.participant); const insight = this.createInsight(record.id, action.insight, action.participant, now)
      for (const link of action.links ?? []) this.addInsightLink(insight.id, link, action.participant, now)
      this.persist()
    } else if (action.kind === 'insight.update') {
      requireHuman(action.participant)
      const insight = this.state.insights.find(item => item.id === action.insightId); if (insight === undefined) throw new Error('insight not found')
      Object.assign(insight, action.changes); validateInsight(insight, this.state); insight.dedupeHash = insightHash(insight.sourceId, insight.body); insight.updatedAt = now; this.persist()
    } else if (action.kind === 'insight.delete') {
      requireHuman(action.participant)
      const index = this.state.insights.findIndex(item => item.id === action.insightId); if (index < 0) throw new Error('insight not found')
      this.state.insights.splice(index, 1); this.state.insightLinks = this.state.insightLinks.filter(item => item.insightId !== action.insightId); this.persist()
    } else if (action.kind === 'insight.link') {
      requireHuman(action.participant)
      this.addInsightLink(action.insightId, action.link, action.participant, now)
      this.persist()
    } else if (action.kind === 'insight.unlink') {
      requireHuman(action.participant)
      const link = this.state.insightLinks.find(item => item.id === action.linkId); if (link === undefined) throw new Error('insight link not found')
      this.state.insightLinks = this.state.insightLinks.filter(item => item.id !== action.linkId); this.persist()
    } else if (action.kind === 'insight.import') {
      requireHuman(action.participant)
      if (action.rows.length > 2_000 || Buffer.byteLength(JSON.stringify(action.rows), 'utf8') > 5 * 1024 * 1024) throw new Error('insight import exceeds 2,000 rows or 5 MB')
      const before = structuredClone(this.state)
      try {
        for (const row of [...(action.source ? [action.source] : []), ...(action.sources ?? [])]) { const source = { ...cleanSource(row), createdAt: now, updatedAt: now }; validateSource(source); const existing = this.state.feedbackSources.find(item => item.id === source.id); if (existing) Object.assign(existing, source, { createdAt: existing.createdAt }); else this.state.feedbackSources.push(source) }
        for (const row of action.companies ?? []) { const company = cleanCompany(row); validateCompany(company); const existing = this.state.companies.find(item => item.id === company.id); if (existing) Object.assign(existing, company, { createdAt: existing.createdAt, updatedAt: now }); else this.state.companies.push({ ...company, createdAt: now, updatedAt: now }) }
        for (const row of action.customers ?? []) { const customer = cleanCustomer(row); validateCustomer(customer, this.state); const existing = this.state.customers.find(item => item.id === customer.id); if (existing) Object.assign(existing, customer, { createdAt: existing.createdAt, updatedAt: now }); else this.state.customers.push({ ...customer, createdAt: now, updatedAt: now }) }
        const actualIds = new Map<string, string>()
        for (const row of action.rows) actualIds.set(row.id, this.createInsight(record.id, row, action.participant, now).id)
        for (const link of action.links ?? []) this.addInsightLink(actualIds.get(link.insightId) ?? link.insightId, link, action.participant, now)
      }
      catch (error) { this.state = before; throw error }
      this.persist()
    } else if (action.kind === 'downstream.return') {
      requireHuman(action.participant)
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
      enterStage(record, 'joint-review'); record.updatedAt = now; this.persist()
      this.enqueueReview(record, action.participant, 'change-review')
    }
    return { ok: true, revision: this.state.revision, requirement: this.view(record.id) }
  }

  private createInsight(requirementId: string, input: Omit<Insight, 'dedupeHash' | 'createdBy' | 'createdAt' | 'updatedAt'>, participant: ParticipantSnapshot, now: number): Insight {
    const draft: Insight = { ...input, title: input.title.trim(), body: input.body.trim(), dedupeHash: insightHash(input.sourceId, input.body), createdBy: participant, createdAt: now, updatedAt: now }
    validateInsight(draft, this.state)
    const existing = this.state.insights.find(item => item.dedupeHash === draft.dedupeHash)
    const insight = existing ?? draft
    if (existing === undefined) this.state.insights.push(insight)
    if (!this.state.insightLinks.some(item => item.insightId === insight.id && item.requirementId === requirementId && item.targetType === 'requirement')) this.state.insightLinks.push({ id: randomUUID(), insightId: insight.id, requirementId, targetType: 'requirement', createdBy: participant, createdAt: now })
    return insight
  }

  private addInsightLink(insightId: string, link: Pick<InsightLink, 'requirementId' | 'targetType' | 'targetId'>, participant: ParticipantSnapshot, now: number): void {
    if (!this.state.insights.some(item => item.id === insightId)) throw new Error('insight not found')
    this.record(link.requirementId)
    if (!['requirement', 'section', 'acceptance-criterion'].includes(link.targetType)) throw new Error('invalid insight link target type')
    if (link.targetType !== 'requirement' && !link.targetId?.trim()) throw new Error('linked section or acceptance criterion id is required')
    const duplicate = this.state.insightLinks.some(item => item.insightId === insightId && item.requirementId === link.requirementId && item.targetType === link.targetType && item.targetId === link.targetId)
    if (!duplicate) this.state.insightLinks.push({ id: randomUUID(), insightId, ...link, createdBy: participant, createdAt: now })
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

  private saveConflict(action: Extract<CollaborationAction, { kind: 'version.save' }>): SaveConflict {
    const record = this.record(action.requirementId)
    const baseMarkdown = this.versions.read(record.id, action.baseCommit).markdown
    const currentMarkdown = this.versions.read(record.id, record.currentCommit).markdown
    return { requirementId: record.id, baseCommit: action.baseCommit, currentCommit: record.currentCommit, baseMarkdown, currentMarkdown, draftMarkdown: action.markdown, baseToCurrentDiff: textDiff(baseMarkdown, currentMarkdown), baseToDraftDiff: textDiff(baseMarkdown, action.markdown) }
  }

  private enqueueReview(record: RequirementRecord, participant: ParticipantSnapshot, kind: ReviewKind): void {
    const now = Date.now()
    const run: AiReviewRun = { id: randomUUID(), requirementId: record.id, commit: record.currentCommit, kind, status: 'queued', requestedBy: participant, createdAt: now, updatedAt: now }
    record.aiRuns.push(run)
    this.persist({ types: ['ai.status', 'metrics.changed'], requirementId: record.id, objectId: run.id })
    const coordinator = this.coordinator
    if (coordinator === undefined) { this.markAiFailure(record.id, run.id, 'AI coordinator unavailable'); return }
    const view = this.view(record.id)
    const requestedStage = record.stage; const requestedStageCycle = record.stageCycle
    const existingSession = record.aiConversations.find(item => item.stage === requestedStage && item.stageCycle === requestedStageCycle)?.sessionId
    void coordinator.requestReview({ requirement: view, run, ...(existingSession ? { sessionId: existingSession } : {}) }).then(sessionId => {
      // Rejected actions restore a cloned state while this launch can still be pending.
      const currentRecord = this.state.requirements.find(item => item.id === record.id)
      const currentRun = currentRecord?.aiRuns.find(item => item.id === run.id)
      if (currentRecord === undefined || currentRun === undefined) return
      if (currentRun.status === 'queued') currentRun.status = 'running'
      currentRun.sessionId = sessionId; currentRun.updatedAt = Date.now(); this.rememberStageConversation(currentRecord, sessionId, requestedStage, requestedStageCycle); this.persist({ types: ['ai.status', 'metrics.changed'], requirementId: currentRecord.id, objectId: currentRun.id })
    }, error => this.markAiFailure(record.id, run.id, error instanceof Error ? error.message : String(error)))
  }

  private record(id: string): RequirementRecord { const value = this.state.requirements.find(item => item.id === id); if (value === undefined) throw new Error('requirement not found'); return value }
  private comment(record: RequirementRecord, id: string): CommentThread { const value = record.comments.find(item => item.id === id); if (value === undefined) throw new Error('comment not found'); return value }
  private persist(event = this.eventContext ?? { types: ['metrics.changed'] as const }, recoverable = false): void {
    this.state.revision += 1
    const pendingPath = `${this.eventPath}.pending`
    if (recoverable) atomicWrite(pendingPath, this.state, true)
    atomicWrite(this.eventPath, this.state, recoverable)
    if (recoverable && existsSync(pendingPath)) unlinkSync(pendingPath)
    const payload: CollaborationEvent = { ...event, types: [...event.types], revision: this.state.revision }
    for (const listener of this.listeners) listener(payload)
  }
  private load(): CollaborationState {
    const pendingPath = `${this.eventPath}.pending`
    if (existsSync(pendingPath)) {
      let pending: unknown
      try { pending = JSON.parse(readFileSync(pendingPath, 'utf8')); validateV3Ledger(pending); atomicWrite(this.eventPath, pending, true); unlinkSync(pendingPath); return normalizeV3(pending) }
      catch (error) { throw new Error(`pending collaboration transaction is corrupted: ${error instanceof Error ? error.message : String(error)}`) }
    }
    const sourcePath = existsSync(this.eventPath) ? this.eventPath : this.options.legacyPath !== undefined && existsSync(this.options.legacyPath) ? this.options.legacyPath : undefined
    if (sourcePath === undefined) return emptyState()
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) }
    catch (error) { throw new Error(`collaboration ledger is corrupted: ${error instanceof Error ? error.message : String(error)}`) }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { schemaVersion?: unknown }).schemaVersion !== 'number') throw new Error('collaboration ledger has no schema version')
    const version = (parsed as { schemaVersion: number }).schemaVersion
    if (version === SCHEMA_VERSION) { validateV3Ledger(parsed); return normalizeV3(parsed as CollaborationState) }
    if (version !== 2) throw new Error(`unsupported collaboration schema: ${version}`)
    validateV2Ledger(parsed)
    const migrated = migrateV2(parsed as Record<string, unknown>)
    const extension = extname(sourcePath); const stem = basename(sourcePath, extension).replace(/-v2$/, '')
    const backupPath = join(dirname(sourcePath), `${stem}-v2.backup-${Date.now()}${extension || '.json'}`)
    copyFileSync(sourcePath, backupPath)
    atomicWrite(this.eventPath, migrated, true)
    return migrated
  }
}

function eventForAction(action: CollaborationAction): Omit<CollaborationEvent, 'revision'> {
  const types = new Set<CollaborationEvent['types'][number]>(['metrics.changed'])
  if (action.kind.startsWith('comment.')) types.add('comment.changed')
  if (action.kind === 'comment.create' || action.kind === 'comment.reply') {
    if ((action.mentions?.length ?? 0) > 0) types.add('mention.created')
    types.add('notification.changed')
  }
  if (action.kind === 'comment.resolve' || action.kind === 'comment.reopen') types.add('notification.changed')
  if (action.kind === 'action.assign') { types.add('assignment.changed'); types.add('notification.changed') }
  if (action.kind === 'notification.mark-read') types.add('notification.changed')
  if (action.kind === 'review.request') types.add('ai.status')
  const requirementId = 'requirementId' in action ? action.requirementId : undefined
  return { types: [...types], ...(requirementId ? { requirementId } : {}) }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function validateV2Ledger(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.requirements) || (value.participants !== undefined && !Array.isArray(value.participants))) throw new Error('invalid collaboration v2 ledger: requirements and participants must be arrays')
}
function validateV3Ledger(value: unknown): asserts value is CollaborationState {
  if (!isRecord(value)) throw new Error('invalid collaboration v3 ledger: object required')
  const arrays = ['participants', 'requirements', 'companies', 'customers', 'feedbackSources', 'insights', 'insightLinks', 'notifications'] as const
  if (!Number.isFinite(value.revision) || arrays.some(key => !Array.isArray(value[key]))) throw new Error('invalid collaboration v3 ledger: required collections are missing or invalid')
  for (const candidate of value.requirements as unknown[]) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.title !== 'string' || typeof candidate.currentCommit !== 'string' || !['product-review', 'product-confirmation', 'joint-review', 'ready'].includes(String(candidate.stage))) throw new Error('invalid collaboration v3 ledger: malformed requirement')
    const recordArrays = ['sources', 'reviewItems', 'comments', 'patches', 'decisions', 'confirmations', 'actionItems', 'aiRuns'] as const
    if (recordArrays.some(key => !Array.isArray(candidate[key])) || (candidate.aiConversations !== undefined && !Array.isArray(candidate.aiConversations))) throw new Error('invalid collaboration v3 ledger: malformed requirement collections')
  }
}

function atomicWrite(path: string, value: unknown, durable = false): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  if (durable) {
    const descriptor = openSync(tmp, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  }
  renameSync(tmp, path)
}

function normalizeV3(value: CollaborationState): CollaborationState {
  value.participants ??= []
  value.requirements ??= []
  value.companies ??= []
  value.customers ??= []
  value.feedbackSources ??= []
  value.insights ??= []
  value.insightLinks ??= []
  value.notifications ??= []
  for (const record of value.requirements) {
    record.sources ??= []; record.reviewItems ??= []; record.comments ??= []; record.patches ??= []; record.decisions ??= []; record.confirmations ??= []; record.actionItems ??= []; record.aiRuns ??= []; record.aiConversations ??= []; record.stageCycle ??= 0
    for (const conversation of record.aiConversations) conversation.stageCycle ??= record.stageCycle
    if (record.aiConversations.length === 0 && (record.stage === 'product-review' || record.stage === 'joint-review')) {
      const recent = [
        ...record.aiRuns.filter(item => item.sessionId && (item.kind === 'change-review' || (record.stage === 'product-review' ? item.kind === 'product-first' || item.kind === 'product-second' : item.kind === 'engineering-precheck'))).map(item => ({ sessionId: item.sessionId!, createdAt: item.createdAt, updatedAt: item.updatedAt })),
        ...record.comments.filter(item => item.aiSessionId).map(item => ({ sessionId: item.aiSessionId!, createdAt: item.createdAt, updatedAt: item.updatedAt })),
      ].sort((left, right) => right.updatedAt - left.updatedAt)[0]
      if (recent) record.aiConversations.push({ stage: record.stage, stageCycle: record.stageCycle, ...recent })
    }
    for (const comment of record.comments) {
      comment.scope ??= comment.anchor === undefined ? 'page' : 'inline'
      comment.mentions ??= []
      comment.replies ??= []
      for (const reply of comment.replies) reply.mentions ??= []
    }
  }
  return value
}

function migrateV2(value: Record<string, unknown>): CollaborationState {
  const legacyRequirements = Array.isArray(value.requirements) ? value.requirements as RequirementRecord[] : []
  const requirements = structuredClone(legacyRequirements)
  const feedbackSources: CollaborationState['feedbackSources'] = []
  const insights: CollaborationState['insights'] = []
  const insightLinks: CollaborationState['insightLinks'] = []
  const migrationActor: ParticipantSnapshot = { participantId: 'migration-v2', nickname: '数据迁移', role: 'product', kind: 'ai', sessionId: 'migration-v2' }
  for (const record of requirements) {
    record.sources ??= []; record.reviewItems ??= []; record.comments ??= []; record.patches ??= []; record.decisions ??= []; record.confirmations ??= []; record.actionItems ??= []; record.aiRuns ??= []; record.aiConversations ??= []; record.stageCycle ??= 0
    for (const conversation of record.aiConversations) conversation.stageCycle ??= record.stageCycle
    for (const comment of record.comments) {
      comment.scope = comment.anchor === undefined ? 'page' : 'inline'; comment.mentions = []; comment.replies ??= []
      for (const reply of comment.replies) reply.mentions = []
    }
    for (const source of record.sources) {
      const sourceId = `legacy-${createHash('sha256').update(`${record.id}:${source.id}`).digest('hex').slice(0, 16)}`
      const insightId = `legacy-${createHash('sha256').update(`${record.id}:${source.id}:insight`).digest('hex').slice(0, 16)}`
      feedbackSources.push({ id: sourceId, kind: source.sourceType === 'link' ? 'url' : source.sourceType === 'markdown' ? 'markdown' : 'text', label: source.label, ...(source.sourceType === 'link' && safeHttpUrl(source.stableId) ? { url: source.stableId } : {}), ...(source.stableId ? { externalRef: source.stableId } : {}), accessStatus: source.accessStatus, createdAt: record.createdAt, updatedAt: record.updatedAt })
      insights.push({ id: insightId, sourceId, title: source.label, body: `历史来源：${source.label}`, importance: 'unknown', capturedAt: record.createdAt, dedupeHash: insightHash(sourceId, source.label), createdBy: migrationActor, createdAt: record.createdAt, updatedAt: record.updatedAt })
      insightLinks.push({ id: randomUUID(), insightId, requirementId: record.id, targetType: 'requirement', createdBy: migrationActor, createdAt: record.createdAt })
    }
  }
  return normalizeV3({ schemaVersion: SCHEMA_VERSION, revision: typeof value.revision === 'number' ? value.revision : 0, participants: Array.isArray(value.participants) ? value.participants as ParticipantSnapshot[] : [], requirements, companies: [], customers: [], feedbackSources, insights, insightLinks, notifications: [] })
}

function safeHttpUrl(value: string | undefined): boolean {
  if (!value) return false
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' } catch { return false }
}

function cleanSource(input: Omit<FeedbackSource, 'createdAt' | 'updatedAt'>): Omit<FeedbackSource, 'createdAt' | 'updatedAt'> {
  return { id: input.id, kind: input.kind, label: input.label, ...(input.url === undefined ? {} : { url: input.url }), ...(input.externalRef === undefined ? {} : { externalRef: input.externalRef }), accessStatus: input.accessStatus }
}
function cleanCompany(input: { id: string; name: string; externalRef?: string }): { id: string; name: string; externalRef?: string } {
  return { id: input.id, name: input.name, ...(input.externalRef === undefined ? {} : { externalRef: input.externalRef }) }
}
function cleanCustomer(input: { id: string; displayName: string; companyId?: string; externalRef?: string }): { id: string; displayName: string; companyId?: string; externalRef?: string } {
  return { id: input.id, displayName: input.displayName, ...(input.companyId === undefined ? {} : { companyId: input.companyId }), ...(input.externalRef === undefined ? {} : { externalRef: input.externalRef }) }
}
function validateSource(source: Pick<FeedbackSource, 'id' | 'kind' | 'label' | 'url' | 'accessStatus'>): void {
  if (!source.id.trim() || !source.label.trim() || !['text', 'url', 'csv', 'markdown'].includes(source.kind) || !['available', 'unverified', 'missing'].includes(source.accessStatus) || (source.kind === 'url' && !safeHttpUrl(source.url))) throw new Error('valid source id, label and http(s) URL are required')
}
function validateCompany(company: Pick<CollaborationState['companies'][number], 'id' | 'name'>): void {
  if (!company.id.trim() || !company.name.trim()) throw new Error('company id and name are required')
}
function validateCustomer(customer: Pick<CollaborationState['customers'][number], 'id' | 'displayName' | 'companyId'>, state: CollaborationState): void {
  if (!customer.id.trim() || !customer.displayName.trim()) throw new Error('customer id and display name are required')
  if (customer.companyId !== undefined && !state.companies.some(item => item.id === customer.companyId)) throw new Error('company not found')
}

function validMentions(values: string[] | undefined, participants: ParticipantSnapshot[]): string[] {
  const registered = new Set(participants.map(item => item.participantId))
  return [...new Set(values ?? [])].filter(value => registered.has(value))
}

function insightHash(sourceId: string, body: string): string { return createHash('sha256').update(`${sourceId}\n${body.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`).digest('hex') }
function validateInsight(insight: Insight, state: CollaborationState): void {
  if (!insight.id.trim() || !insight.sourceId.trim() || !insight.body.trim()) throw new Error('insight id, source and body are required')
  if (!state.feedbackSources.some(item => item.id === insight.sourceId)) throw new Error('feedback source not found')
  if (insight.customerId !== undefined && !state.customers.some(item => item.id === insight.customerId)) throw new Error('customer not found')
  if (insight.companyId !== undefined && !state.companies.some(item => item.id === insight.companyId)) throw new Error('company not found')
  if (!['unknown', 'want', 'important', 'critical'].includes(insight.importance)) throw new Error('invalid insight importance')
}

function requirementMetrics(record: RequirementRecord, state: CollaborationState): RequirementMetrics {
  const insightIds = new Set(state.insightLinks.filter(link => link.requirementId === record.id).map(link => link.insightId))
  const insights = state.insights.filter(insight => insightIds.has(insight.id))
  const customers = new Set<string>(); const companies = new Set<string>(); const entityScores = new Map<string, number>(); let anonymousInsightCount = 0
  const weights: Record<InsightImportance, number> = { unknown: 1, want: 1, important: 2, critical: 3 }
  for (const insight of insights) {
    const customer = insight.customerId === undefined ? undefined : state.customers.find(item => item.id === insight.customerId)
    const companyId = insight.companyId ?? customer?.companyId
    if (insight.customerId !== undefined) customers.add(insight.customerId)
    if (companyId !== undefined) companies.add(companyId)
    const entity = insight.customerId !== undefined ? `customer:${insight.customerId}` : companyId !== undefined ? `company:${companyId}` : undefined
    if (entity === undefined) anonymousInsightCount += 1
    else entityScores.set(entity, Math.max(entityScores.get(entity) ?? 0, weights[insight.importance]))
  }
  return {
    openReviewCount: record.reviewItems.filter(item => item.commit === record.currentCommit && !['resolved', 'invalidated'].includes(item.status)).length,
    openCommentCount: record.comments.filter(item => item.commit === record.currentCommit && item.status === 'open').length,
    pendingActionCount: record.actionItems.filter(item => item.status === 'pending').length,
    activeDecisionCount: record.decisions.filter(item => item.status === 'active').length,
    riskCount: record.reviewItems.filter(item => item.commit === record.currentCommit && ['blocking', 'major'].includes(item.severity) && !['resolved', 'invalidated'].includes(item.status)).length,
    insightCount: insights.length, customerImportanceScore: [...entityScores.values()].reduce((sum, value) => sum + value, 0), customerCount: customers.size, companyCount: companies.size, anonymousInsightCount,
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
function enterStage(record: RequirementRecord, stage: RequirementRecord['stage']): void {
  if (record.stage === stage) return
  record.stage = stage
  record.stageCycle += 1
}
function advance(record: RequirementRecord, participant: ParticipantSnapshot): void {
  if (record.stage === 'product-review') {
    if (record.reviewItems.some(item => item.commit === record.currentCommit && item.severity === 'blocking' && !['resolved', 'non-blocking-verify', 'joint-review'].includes(item.status))) throw new Error('product blocking review items remain')
    if (!hasCompletedCurrentReview(record, 'product-second')) throw new Error('product second review is required')
    enterStage(record, 'product-confirmation'); return
  }
  if (record.stage === 'product-confirmation') {
    if (participant.role !== 'product' || !hasVersionConfirmation(record, 'product')) throw new Error('product must confirm the current version')
    enterStage(record, 'joint-review'); return
  }
  throw new Error('stage cannot advance directly')
}
function sections(markdown: string): Map<string, string> { const result = new Map<string, string>(); let heading = ''; for (const line of markdown.split('\n')) { if (/^##\s+/.test(line)) { heading = line.replace(/^##\s+/, '').trim(); result.set(heading, '') } else if (heading) result.set(heading, `${result.get(heading) ?? ''}\n${line}`) } return result }
function acceptance(markdown: string): Map<string, string> { const result = new Map<string, string>(); for (const match of markdown.matchAll(/\*\*(AC-[A-Za-z0-9-]+)(?:\s+[^*]+)?\*\*\s*[：:]\s*(.+)/g)) result.set(match[1]!, match[2]!.trim()); return result }
function changedScopes(before: string, after: string): { sections: string[]; acceptanceIds: string[] } { const a = sections(before); const b = sections(after); const sectionNames = new Set([...a.keys(), ...b.keys()]); const acA = acceptance(before); const acB = acceptance(after); const acNames = new Set([...acA.keys(), ...acB.keys()]); return { sections: [...sectionNames].filter(key => a.get(key) !== b.get(key)), acceptanceIds: [...acNames].filter(key => acA.get(key) !== acB.get(key)) } }
function intersects(left: string[], right: string[]): boolean { return left.some(item => right.includes(item)) }
function normalizeAnchorText(value: string): string { return value.replace(/[`*_>#\[\]()~-]/g, '').replace(/\s+/g, '').toLocaleLowerCase() }
function headingForLine(lines: string[], index: number): string | undefined {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const match = /^#{1,4}\s+(.+)$/.exec(lines[cursor] ?? '')
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}
function decisionScopeAnchors(markdown: string, affectedSections: string[], affectedAcceptanceIds: string[]): DecisionSourceAnchor[] {
  const anchors: DecisionSourceAnchor[] = []
  const sectionMap = sections(markdown)
  for (const section of affectedSections.map(value => value.trim()).filter(Boolean)) {
    const quote = sectionMap.get(section)?.split('\n').map(line => line.trim()).find(line => line && !/^#+\s+/.test(line))
    if (quote) anchors.push({ heading: section, quote })
  }
  const lines = markdown.split('\n')
  for (const acceptanceId of affectedAcceptanceIds.map(value => value.trim()).filter(Boolean)) {
    const index = lines.findIndex(line => normalizeAnchorText(line).includes(normalizeAnchorText(acceptanceId)))
    if (index >= 0) {
      const heading = headingForLine(lines, index)
      anchors.push({ ...(heading ? { heading } : {}), quote: lines[index]!.trim() })
    }
  }
  return anchors
}
function decisionAnchorStillExists(markdown: string, anchor: DecisionSourceAnchor): boolean {
  const quote = normalizeAnchorText(anchor.quote)
  if (!quote) return false
  const sectionMap = sections(markdown)
  const candidates = anchor.heading?.trim() ? [sectionMap.get(anchor.heading.trim()) ?? ''] : [markdown]
  const context = normalizeAnchorText(`${anchor.prefix ?? ''}${anchor.quote}${anchor.suffix ?? ''}`)
  return candidates.some(candidate => {
    const normalized = normalizeAnchorText(candidate)
    return normalized.includes(context) || normalized.includes(quote)
  })
}
function invalidateAffected(record: RequirementRecord, changedSections: string[], changedAcceptanceIds: string[], currentMarkdown?: string): void {
  for (const confirmation of record.confirmations) {
    if (confirmation.status !== 'active') continue
    const affected = confirmation.scope === 'version' || (confirmation.scope === 'section' && confirmation.scopeId !== undefined && changedSections.includes(confirmation.scopeId)) || (confirmation.scope === 'acceptance-criterion' && confirmation.scopeId !== undefined && changedAcceptanceIds.includes(confirmation.scopeId))
    if (affected) { confirmation.status = 'invalidated'; record.actionItems.push({ id: randomUUID(), requirementId: record.id, sourceType: 'confirmation', sourceId: confirmation.id, type: 'reconfirm', assigneeRole: confirmation.role, blocking: true, status: 'pending', dueStage: record.stage, createdAt: Date.now(), updatedAt: Date.now() }) }
  }
  record.reviewItems.filter(item => item.status === 'resolved' && (intersects(item.affectedSections, changedSections) || intersects(item.affectedAcceptanceIds, changedAcceptanceIds))).forEach(item => { item.status = 'invalidated'; item.updatedAt = Date.now() })
  record.decisions.filter(item => item.status === 'active' && (intersects(item.affectedSections, changedSections) || intersects(item.affectedAcceptanceIds, changedAcceptanceIds))).forEach(item => { item.status = 'invalidated' })
  if (currentMarkdown !== undefined) record.decisions.filter(item => item.status === 'active' && item.sourceAnchors?.some(anchor => !decisionAnchorStillExists(currentMarkdown, anchor))).forEach(item => { item.status = 'invalidated' })
}
export function readiness(markdown: string, record: RequirementRecord): ReadinessCheck[] {
  const sectionMap = sections(markdown); const ac = acceptance(markdown)
  const meaningful = (name: string): boolean => { const value = sectionMap.get(name)?.replace(/<!--.*?-->/gs, '').trim() ?? ''; return value.length >= 12 && !/待澄清|待补充|TODO/i.test(value) }
  const blockers = record.reviewItems.filter(item => item.commit === record.currentCommit && item.severity === 'blocking' && !['resolved', 'non-blocking-verify'].includes(item.status)).map(item => item.statement)
  return [
    { key: 'goal', passed: meaningful('目标与用户结果'), reasons: meaningful('目标与用户结果') ? [] : ['缺少可观察的目标与用户结果'] },
    { key: 'acceptance', passed: ac.size > 0 && [...ac.values()].every(value => !/待澄清|待补充|TODO/i.test(value)), reasons: ac.size === 0 ? ['缺少稳定 AC ID 与可判定结果'] : [...ac.values()].some(value => /待澄清|待补充|TODO/i.test(value)) ? ['验收标准仍含占位内容'] : [] },
    { key: 'scope', passed: meaningful('范围与非范围'), reasons: meaningful('范围与非范围') ? [] : ['范围与非范围不完整'] },
    { key: 'semantics', passed: meaningful('业务术语与规则'), reasons: meaningful('业务术语与规则') ? [] : ['关键术语和规则不完整'] },
    { key: 'evidence', passed: record.sources.every(source => source.accessStatus !== 'missing') && blockers.length === 0, reasons: [...record.sources.filter(source => source.accessStatus === 'missing').map(source => `来源不可访问：${source.label}`), ...blockers] },
    { key: 'test-constraints', passed: meaningful('测试约束'), reasons: meaningful('测试约束') ? [] : ['测试环境、账号、权限或 fixture 约束不完整'] },
  ]
}
function readyMarkdown(view: RequirementView): string { const open = view.reviewItems.filter(item => item.status === 'non-blocking-verify'); const sourceStatus = { available: '可查阅', unverified: '待核对', missing: '待补充' } as const; return [`# 就绪需求：${view.title}`, '', '## 版本信息', '', `- 需求编号：${view.id}`, `- 文档版本：${view.currentCommit}`, `- 产品确认：${view.confirmations.filter(item => item.role === 'product' && item.status === 'active').map(item => item.participant.nickname).join('、')}`, `- 研发确认：${view.confirmations.filter(item => item.role === 'engineering' && item.status === 'active').map(item => item.participant.nickname).join('、')}`, '', view.version.markdown, '', '## 已确认决策', ...view.decisions.filter(item => item.status === 'active').map(item => `- ${item.question}：${item.decision}（原因：${item.rationale}）`), '', '## 参考资料', ...view.sources.map(source => `- [${sourceStatus[source.accessStatus]}] ${source.label}${source.stableId ? `：${source.stableId}` : ''}${source.version ? `（版本：${source.version}）` : ''}`), '', '## 待确认问题', ...open.map(item => `- ${item.question}；负责人：${item.ownerParticipantId ?? (item.ownerRole === 'product' ? '产品' : '研发')}；影响：${item.impact}`), ''].join('\n') }
