import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { GitRequirementStore, VersionConflictError } from './git-store.ts'
import { SCHEMA_VERSION, type ActionItem, type ActionResult, type AiReviewRun, type CandidatePatch, type CollaborationAction, type CollaborationState, type CommentThread, type MyActionItem, type MyItemCategory, type ParticipantSnapshot, type ReadinessCheck, type RequirementRecord, type RequirementVersion, type RequirementView, type ReviewItem, type ReviewKind, type SaveConflict } from './protocol.ts'

export interface AiCoordinator {
  requestReview(input: { requirement: RequirementView; run: AiReviewRun }): Promise<string>
  requestCommentReply(input: { requirement: RequirementView; comment: CommentThread }): Promise<string>
}

const emptyState = (): CollaborationState => ({ schemaVersion: SCHEMA_VERSION, revision: 0, participants: [], requirements: [] })

type EngineResult = ActionResult

export class CollaborationEngine {
  private state: CollaborationState
  private coordinator?: AiCoordinator
  private readonly listeners = new Set<() => void>()
  private readonly seen = new Map<string, EngineResult>()

  constructor(private readonly eventPath: string, private readonly versions: GitRequirementStore) { this.state = this.load() }
  setCoordinator(coordinator: AiCoordinator): void { this.coordinator = coordinator }
  snapshot(): CollaborationState { return structuredClone(this.state) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  list(): RequirementView[] { return this.state.requirements.map(item => this.view(item.id)) }
  version(requirementId: string, commit: string): RequirementVersion {
    const record = this.record(requirementId)
    if (!this.versions.history(record.id).some(version => version.commit === commit)) throw new Error('requirement version not found')
    return this.versions.read(record.id, commit)
  }
  myItems(participant: ParticipantSnapshot, category?: MyItemCategory): MyActionItem[] {
    const rows: MyActionItem[] = []
    for (const record of this.state.requirements) {
      for (const item of record.actionItems.filter(candidate => candidate.status === 'pending')) {
        const categories: MyItemCategory[] = []
        const assigned = item.assigneeParticipantId === participant.participantId || (item.assigneeParticipantId === undefined && item.assigneeRole === participant.role)
        if (assigned) categories.push(item.type === 'confirm' || item.type === 'reconfirm' ? 'awaiting-my-confirmation' : 'awaiting-my-response')
        if (sourceParticipantId(record, item) === participant.participantId) categories.push('initiated-by-me')
        for (const current of categories) if (category === undefined || category === current) rows.push({ ...structuredClone(item), category: current, requirementTitle: record.title, target: actionTarget(item) })
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
    return { ...structuredClone(record), version, history: this.versions.history(id), readiness: readiness(version.markdown, record) }
  }

  apply(requestId: string, action: CollaborationAction): EngineResult {
    const cached = this.seen.get(requestId)
    if (cached !== undefined) return structuredClone(cached)
    let result: EngineResult
    try {
      const registered = action.participant.kind === 'human' ? this.state.participants.find(item => item.participantId === action.participant.participantId) : undefined
      if (registered !== undefined && registered.role !== action.participant.role) throw new Error(`participant role is bound to ${registered.role}`)
      result = this.applyFresh(action)
      if (result.ok && action.participant.kind === 'human' && registered === undefined) {
        this.state.participants.push(structuredClone(action.participant)); this.persist()
        result = result.deletedRequirementId
          ? { ...result, revision: this.state.revision }
          : { ok: true, revision: this.state.revision, requirement: this.view(result.requirement.id) }
      }
    }
    catch (error) {
      const conflict = error instanceof VersionConflictError && action.kind === 'version.save' ? this.saveConflict(action) : undefined
      result = { ok: false, revision: this.state.revision, error: error instanceof Error ? error.message : String(error), ...(conflict === undefined ? {} : { conflict }) }
    }
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
    this.persist()
  }

  submitPatch(input: { requirementId: string; baseCommit: string; reviewKind: ReviewKind; ai: ParticipantSnapshot; proposedMarkdown: string; summary: string; affectedReviewItemIds: string[]; affectedSections: string[]; affectedAcceptanceIds: string[] }): void {
    const record = this.record(input.requirementId)
    if (record.currentCommit !== input.baseCommit) throw new Error('patch base commit is stale')
    assertChineseFeedback(input.summary, input.proposedMarkdown)
    const patch: CandidatePatch = { id: randomUUID(), requirementId: record.id, baseCommit: input.baseCommit, reviewKind: input.reviewKind, proposedMarkdown: input.proposedMarkdown, summary: input.summary, affectedReviewItemIds: input.affectedReviewItemIds, affectedSections: input.affectedSections, affectedAcceptanceIds: input.affectedAcceptanceIds, createdBy: input.ai, status: 'pending', createdAt: Date.now() }
    record.patches.push(patch)
    record.actionItems.push({ id: randomUUID(), requirementId: record.id, sourceType: 'patch', sourceId: patch.id, type: 'confirm', assigneeRole: input.reviewKind === 'engineering-precheck' ? 'engineering' : 'product', blocking: true, status: 'pending', dueStage: record.stage, createdAt: Date.now(), updatedAt: Date.now() })
    this.persist()
  }

  submitAiReply(input: { requirementId: string; commentId: string; ai: ParticipantSnapshot; body: string }): void {
    assertChineseFeedback(input.body)
    const record = this.record(input.requirementId)
    const comment = this.comment(record, input.commentId)
    comment.replies.push({ id: randomUUID(), author: input.ai, body: input.body, createdAt: Date.now() })
    comment.aiStatus = 'completed'; comment.updatedAt = Date.now()
    this.persist()
  }

  markAiFailure(requirementId: string, sourceId: string, error: string): void {
    const record = this.record(requirementId)
    const run = record.aiRuns.find(item => item.id === sourceId)
    if (run !== undefined) { run.status = 'failed'; run.error = error; run.updatedAt = Date.now() }
    const comment = record.comments.find(item => item.id === sourceId)
    if (comment !== undefined) { comment.aiStatus = 'failed'; comment.updatedAt = Date.now() }
    this.persist()
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
      const record: RequirementRecord = { id: created.requirementId, title, stage: 'product-review', currentCommit: created.version.commit, workspaceId, sources: action.sources, reviewItems: [], comments: [], patches: [], decisions: [], confirmations: [], actionItems: [], aiRuns: [], createdAt: now, updatedAt: now }
      this.state.requirements.unshift(record); this.persist()
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
      invalidateAffected(record, [], []); this.persist(); this.enqueueReview(record, action.participant, 'change-review')
    } else if (action.kind === 'requirement.archive') {
      requireHuman(action.participant)
      if (action.archived) record.archivedAt = now
      else delete record.archivedAt
      record.updatedAt = now; this.persist()
    } else if (action.kind === 'requirement.delete') {
      requireHuman(action.participant)
      const deleted = this.view(record.id)
      this.versions.remove(record.id, action.participant)
      this.state.requirements.splice(this.state.requirements.indexOf(record), 1)
      this.persist()
      return { ok: true, revision: this.state.revision, requirement: deleted, deletedRequirementId: record.id }
    } else if (action.kind === 'version.save') {
      requireHuman(action.participant)
      const before = this.versions.read(record.id, record.currentCommit).markdown
      const version = this.versions.save({ requirementId: record.id, baseCommit: action.baseCommit, markdown: action.markdown, participant: action.participant, summary: action.summary })
      const impact = changedScopes(before, action.markdown)
      record.currentCommit = version.commit; record.updatedAt = now; delete record.readyPackage
      invalidateAffected(record, impact.sections, impact.acceptanceIds)
      record.patches.filter(item => item.status === 'pending').forEach(item => { item.status = 'stale' })
      if (record.stage === 'ready') record.stage = 'joint-review'
      this.persist()
      this.enqueueReview(record, action.participant, 'change-review')
    } else if (action.kind === 'review.request') {
      requireHuman(action.participant)
      this.enqueueReview(record, action.participant, action.reviewKind)
    } else if (action.kind === 'review.respond') {
      requireHuman(action.participant)
      const item = record.reviewItems.find(candidate => candidate.id === action.reviewItemId)
      if (item === undefined) throw new Error('review item not found')
      item.response = { participant: action.participant, disposition: action.disposition, body: action.body.trim(), createdAt: now }
      item.status = action.disposition === 'joint-review' ? 'joint-review' : action.disposition === 'to-verify' ? 'non-blocking-verify' : 'answered'
      item.updatedAt = now
      record.actionItems.filter(task => task.sourceId === item.id && task.status === 'pending').forEach(task => { task.status = 'handled'; task.updatedAt = now })
      this.persist()
    } else if (action.kind === 'comment.create') {
      requireHuman(action.participant)
      if (action.commit !== record.currentCommit) throw new VersionConflictError(record.currentCommit)
      const comment: CommentThread = { id: randomUUID(), requirementId: record.id, commit: action.commit, anchor: action.anchor, author: action.participant, body: action.body.trim(), replies: [], aiStatus: 'queued', status: 'open', createdAt: now, updatedAt: now }
      if (comment.body === '' || comment.anchor.quote.trim() === '') throw new Error('comment and anchor are required')
      record.comments.push(comment)
      record.actionItems.push({ id: randomUUID(), requirementId: record.id, sourceType: 'comment', sourceId: comment.id, type: 'reply', assigneeRole: action.participant.role === 'product' ? 'engineering' : 'product', blocking: true, status: 'pending', dueStage: record.stage, createdAt: now, updatedAt: now })
      this.persist()
      const coordinator = this.coordinator
      if (coordinator !== undefined) {
        const view = this.view(record.id)
        void coordinator.requestCommentReply({ requirement: view, comment }).then(sessionId => {
          comment.aiStatus = 'running'; comment.aiSessionId = sessionId; comment.updatedAt = Date.now(); this.persist()
        }, error => this.markAiFailure(record.id, comment.id, error instanceof Error ? error.message : String(error)))
      }
    } else if (action.kind === 'comment.reply') {
      requireHuman(action.participant)
      const comment = this.comment(record, action.commentId)
      comment.replies.push({ id: randomUUID(), author: action.participant, body: action.body.trim(), createdAt: now }); comment.updatedAt = now; this.persist()
    } else if (action.kind === 'comment.resolve') {
      requireHuman(action.participant)
      const comment = this.comment(record, action.commentId)
      comment.status = 'resolved'; comment.resolution = action.resolution; comment.updatedAt = now
      record.actionItems.filter(task => task.sourceId === comment.id && task.status === 'pending').forEach(task => { task.status = 'handled'; task.updatedAt = now }); this.persist()
    } else if (action.kind === 'patch.accept') {
      requireHuman(action.participant)
      const patch = record.patches.find(item => item.id === action.patchId)
      if (patch === undefined || patch.status !== 'pending') throw new Error('pending patch not found')
      const version = this.versions.save({ requirementId: record.id, baseCommit: patch.baseCommit, markdown: patch.proposedMarkdown, participant: action.participant, summary: action.summary })
      record.currentCommit = version.commit; patch.status = 'accepted'; record.updatedAt = now
      for (const id of patch.affectedReviewItemIds) { const item = record.reviewItems.find(candidate => candidate.id === id); if (item !== undefined) { item.status = 'resolved'; item.updatedAt = now } }
      record.actionItems.filter(task => task.sourceId === patch.id && task.status === 'pending').forEach(task => { task.status = 'handled'; task.updatedAt = now }); this.persist()
      this.enqueueReview(record, action.participant, 'change-review')
    } else if (action.kind === 'patch.reject') {
      requireHuman(action.participant)
      const patch = record.patches.find(item => item.id === action.patchId); if (patch === undefined) throw new Error('patch not found'); patch.status = 'rejected'; this.persist()
    } else if (action.kind === 'decision.create') {
      requireHuman(action.participant)
      record.decisions.push({ id: randomUUID(), requirementId: record.id, commit: record.currentCommit, question: action.question, options: action.options, decision: action.decision, rationale: action.rationale, confirmer: action.participant, affectedSections: action.affectedSections, affectedAcceptanceIds: action.affectedAcceptanceIds, createdAt: now, status: 'active' }); this.persist()
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
      const checks = readiness(this.versions.read(record.id, record.currentCommit).markdown, record)
      if (record.stage !== 'joint-review' || checks.some(check => !check.passed)) throw new Error('readiness gate is not satisfied')
      if (!hasVersionConfirmation(record, 'product') || !hasVersionConfirmation(record, 'engineering')) throw new Error('current version needs product and engineering confirmation')
      const markdown = readyMarkdown(this.view(record.id))
      record.readyPackage = { requirementId: record.id, commit: record.currentCommit, packageHash: createHash('sha256').update(markdown).digest('hex'), generatedAt: now, generatedBy: action.participant, markdown }
      record.stage = 'ready'; this.persist()
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
      record.stage = 'joint-review'; record.updatedAt = now; this.persist()
      this.enqueueReview(record, action.participant, 'change-review')
    }
    return { ok: true, revision: this.state.revision, requirement: this.view(record.id) }
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
    this.persist()
    const coordinator = this.coordinator
    if (coordinator === undefined) { this.markAiFailure(record.id, run.id, 'AI coordinator unavailable'); return }
    const view = this.view(record.id)
    void coordinator.requestReview({ requirement: view, run }).then(sessionId => {
      run.status = 'running'; run.sessionId = sessionId; run.updatedAt = Date.now(); this.persist()
    }, error => this.markAiFailure(record.id, run.id, error instanceof Error ? error.message : String(error)))
  }

  private record(id: string): RequirementRecord { const value = this.state.requirements.find(item => item.id === id); if (value === undefined) throw new Error('requirement not found'); return value }
  private comment(record: RequirementRecord, id: string): CommentThread { const value = record.comments.find(item => item.id === id); if (value === undefined) throw new Error('comment not found'); return value }
  private persist(): void { this.state.revision += 1; mkdirSync(dirname(this.eventPath), { recursive: true, mode: 0o700 }); const tmp = `${this.eventPath}.tmp`; writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 }); renameSync(tmp, this.eventPath); for (const listener of this.listeners) listener() }
  private load(): CollaborationState { try { const value = JSON.parse(readFileSync(this.eventPath, 'utf8')) as CollaborationState; if (value.schemaVersion === SCHEMA_VERSION) { value.participants ??= []; return value } } catch {} return emptyState() }
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
function hasVersionConfirmation(record: RequirementRecord, role: 'product' | 'engineering'): boolean { return record.confirmations.some(item => item.role === role && item.scope === 'version' && item.commit === record.currentCommit && item.status === 'active') }
function advance(record: RequirementRecord, participant: ParticipantSnapshot): void {
  if (record.stage === 'product-review') {
    if (record.reviewItems.some(item => item.severity === 'blocking' && !['resolved', 'non-blocking-verify', 'joint-review'].includes(item.status))) throw new Error('product blocking review items remain')
    if (!record.aiRuns.some(run => run.kind === 'product-second' && run.commit === record.currentCommit && run.status === 'completed')) throw new Error('product second review is required')
    record.stage = 'product-confirmation'; return
  }
  if (record.stage === 'product-confirmation') {
    if (participant.role !== 'product' || !hasVersionConfirmation(record, 'product')) throw new Error('product must confirm the current version')
    record.stage = 'joint-review'; return
  }
  throw new Error('stage cannot advance directly')
}
function sections(markdown: string): Map<string, string> { const result = new Map<string, string>(); let heading = ''; for (const line of markdown.split('\n')) { if (/^##\s+/.test(line)) { heading = line.replace(/^##\s+/, '').trim(); result.set(heading, '') } else if (heading) result.set(heading, `${result.get(heading) ?? ''}\n${line}`) } return result }
function acceptance(markdown: string): Map<string, string> { const result = new Map<string, string>(); for (const match of markdown.matchAll(/\*\*(AC-[A-Za-z0-9-]+)\*\*\s*[：:]\s*(.+)/g)) result.set(match[1]!, match[2]!.trim()); return result }
function changedScopes(before: string, after: string): { sections: string[]; acceptanceIds: string[] } { const a = sections(before); const b = sections(after); const sectionNames = new Set([...a.keys(), ...b.keys()]); const acA = acceptance(before); const acB = acceptance(after); const acNames = new Set([...acA.keys(), ...acB.keys()]); return { sections: [...sectionNames].filter(key => a.get(key) !== b.get(key)), acceptanceIds: [...acNames].filter(key => acA.get(key) !== acB.get(key)) } }
function intersects(left: string[], right: string[]): boolean { return left.some(item => right.includes(item)) }
function invalidateAffected(record: RequirementRecord, changedSections: string[], changedAcceptanceIds: string[]): void {
  for (const confirmation of record.confirmations) {
    if (confirmation.status !== 'active') continue
    const affected = confirmation.scope === 'version' || (confirmation.scope === 'section' && confirmation.scopeId !== undefined && changedSections.includes(confirmation.scopeId)) || (confirmation.scope === 'acceptance-criterion' && confirmation.scopeId !== undefined && changedAcceptanceIds.includes(confirmation.scopeId))
    if (affected) { confirmation.status = 'invalidated'; record.actionItems.push({ id: randomUUID(), requirementId: record.id, sourceType: 'confirmation', sourceId: confirmation.id, type: 'reconfirm', assigneeRole: confirmation.role, blocking: true, status: 'pending', dueStage: record.stage, createdAt: Date.now(), updatedAt: Date.now() }) }
  }
  record.reviewItems.filter(item => item.status === 'resolved' && (intersects(item.affectedSections, changedSections) || intersects(item.affectedAcceptanceIds, changedAcceptanceIds))).forEach(item => { item.status = 'invalidated'; item.updatedAt = Date.now() })
  record.decisions.filter(item => item.status === 'active' && (intersects(item.affectedSections, changedSections) || intersects(item.affectedAcceptanceIds, changedAcceptanceIds))).forEach(item => { item.status = 'invalidated' })
}
export function readiness(markdown: string, record: RequirementRecord): ReadinessCheck[] {
  const sectionMap = sections(markdown); const ac = acceptance(markdown)
  const meaningful = (name: string): boolean => { const value = sectionMap.get(name)?.replace(/<!--.*?-->/gs, '').trim() ?? ''; return value.length >= 12 && !/待澄清|待补充|TODO/i.test(value) }
  const blockers = record.reviewItems.filter(item => item.severity === 'blocking' && !['resolved', 'non-blocking-verify'].includes(item.status)).map(item => item.statement)
  return [
    { key: 'goal', passed: meaningful('目标与用户结果'), reasons: meaningful('目标与用户结果') ? [] : ['缺少可观察的目标与用户结果'] },
    { key: 'acceptance', passed: ac.size > 0 && [...ac.values()].every(value => !/待澄清|待补充|TODO/i.test(value)), reasons: ac.size === 0 ? ['缺少稳定 AC ID 与可判定结果'] : [...ac.values()].some(value => /待澄清|待补充|TODO/i.test(value)) ? ['验收标准仍含占位内容'] : [] },
    { key: 'scope', passed: meaningful('范围与非范围'), reasons: meaningful('范围与非范围') ? [] : ['范围与非范围不完整'] },
    { key: 'semantics', passed: meaningful('业务术语与规则'), reasons: meaningful('业务术语与规则') ? [] : ['关键术语和规则不完整'] },
    { key: 'evidence', passed: record.sources.every(source => source.accessStatus !== 'missing') && blockers.length === 0, reasons: [...record.sources.filter(source => source.accessStatus === 'missing').map(source => `来源不可访问：${source.label}`), ...blockers] },
    { key: 'test-constraints', passed: meaningful('测试约束'), reasons: meaningful('测试约束') ? [] : ['测试环境、账号、权限或 fixture 约束不完整'] },
  ]
}
function readyMarkdown(view: RequirementView): string { const open = view.reviewItems.filter(item => item.status === 'non-blocking-verify'); return [`# Ready Spec：${view.title}`, '', `- 需求 ID：${view.id}`, `- Commit：${view.currentCommit}`, `- 产品确认：${view.confirmations.filter(item => item.role === 'product' && item.status === 'active').map(item => item.participant.nickname).join('、')}`, `- 研发确认：${view.confirmations.filter(item => item.role === 'engineering' && item.status === 'active').map(item => item.participant.nickname).join('、')}`, '', view.version.markdown, '', '## Decisions', ...view.decisions.filter(item => item.status === 'active').map(item => `- ${item.question}：${item.decision}（${item.rationale}）`), '', '## 证据来源与版本', ...view.sources.map(source => `- [${source.accessStatus}] ${source.label}${source.stableId ? ` — ${source.stableId}` : ''}${source.version ? ` @ ${source.version}` : ''}`), '', '## 非阻塞 Open Questions', ...open.map(item => `- ${item.question}；负责人：${item.ownerParticipantId ?? item.ownerRole}；影响：${item.impact}`), ''].join('\n') }
