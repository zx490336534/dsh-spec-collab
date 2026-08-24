export const API_PREFIX = '/api/spec-collab'
export const SCHEMA_VERSION = 3 as const

export type ParticipantRole = 'product' | 'engineering'
export type ParticipantKind = 'human' | 'ai'
export type RequirementStage = 'product-review' | 'product-confirmation' | 'joint-review' | 'ready'
export type ReviewKind = 'product-first' | 'product-second' | 'engineering-precheck' | 'change-review'
export type ReviewItemType = 'goal' | 'evidence' | 'history-conflict' | 'current-implementation' | 'scope' | 'semantics' | 'completeness' | 'acceptance' | 'risk'
export type Severity = 'blocking' | 'major' | 'minor'
export type EpistemicStatus = 'FACT' | 'INFERENCE' | 'ASSUMPTION' | 'TO_VERIFY'
export type ReviewItemStatus = 'open' | 'answered' | 'resolved' | 'joint-review' | 'non-blocking-verify' | 'invalidated'
export type CommentResolution = 'written-back' | 'decision' | 'rejected' | 'open-question'
export type ConfirmationScope = 'version' | 'section' | 'acceptance-criterion' | 'decision'
export type ActionItemStatus = 'pending' | 'handled' | 'invalidated' | 'cancelled'
export type AiTaskStatus = 'queued' | 'running' | 'completed' | 'failed'
export type InsightImportance = 'unknown' | 'want' | 'important' | 'critical'
export type InsightTargetType = 'requirement' | 'section' | 'acceptance-criterion'
export type CollaborationEventType = 'state.synced' | 'comment.changed' | 'assignment.changed' | 'mention.created' | 'notification.changed' | 'ai.status' | 'metrics.changed'

export interface ParticipantSnapshot { participantId: string; nickname: string; role: ParticipantRole; kind: ParticipantKind; sessionId?: string }
export interface SourceReference { id: string; sourceType: 'text' | 'markdown' | 'prototype' | 'meeting' | 'data' | 'link' | 'feedback' | 'code-scope'; label: string; stableId?: string; version?: string; accessStatus: 'available' | 'unverified' | 'missing' }
export interface RequirementVersion { commit: string; parentCommit?: string; markdown: string; author: ParticipantSnapshot; summary: string; createdAt: number }
export interface ReviewEvidence { statement: string; source: string; version?: string; accessible: boolean }
export interface ReviewSourceAnchor { quote: string; heading?: string }
export interface ReviewItem {
  id: string; requirementId: string; commit: string; reviewKind: ReviewKind; type: ReviewItemType; severity: Severity; statement: string
  evidence: ReviewEvidence[]; epistemicStatus: EpistemicStatus; impact: string; question: string; affectedSections: string[]; affectedAcceptanceIds: string[]
  sourceAnchors?: ReviewSourceAnchor[]
  recommendedOptions?: string[]
  ownerRole: ParticipantRole; ownerParticipantId?: string; status: ReviewItemStatus
  response?: { participant: ParticipantSnapshot; disposition: 'context' | 'evidence' | 'accept' | 'accept-modified' | 'reject' | 'to-verify' | 'joint-review'; body: string; createdAt: number }
  createdAt: number; updatedAt: number
}
export interface CommentReply { id: string; author: ParticipantSnapshot; body: string; mentions: string[]; createdAt: number }
export interface TextAnchor { heading?: string; quote: string; prefix?: string; suffix?: string }
export interface CommentThread {
  id: string; requirementId: string; commit: string; scope: 'page' | 'inline'; anchor?: TextAnchor
  author: ParticipantSnapshot; body: string; mentions: string[]; replies: CommentReply[]; aiStatus: AiTaskStatus; aiSessionId?: string
  status: 'open' | 'resolved' | 'orphaned' | 'invalidated'; resolution?: CommentResolution; createdAt: number; updatedAt: number
}
export interface CandidatePatch {
  id: string; requirementId: string; baseCommit: string; reviewKind: ReviewKind; proposedMarkdown: string; summary: string
  affectedReviewItemIds: string[]; affectedSections: string[]; affectedAcceptanceIds: string[]; createdBy: ParticipantSnapshot
  status: 'pending' | 'accepted' | 'rejected' | 'stale'; createdAt: number
}
export interface Decision {
  id: string; requirementId: string; commit: string; question: string; options: string[]; decision: string; rationale: string
  confirmer: ParticipantSnapshot; affectedSections: string[]; affectedAcceptanceIds: string[]; sourceAnchors?: TextAnchor[]; createdAt: number; status: 'active' | 'invalidated'
}
export interface Confirmation { id: string; requirementId: string; commit: string; role: ParticipantRole; participant: ParticipantSnapshot; scope: ConfirmationScope; scopeId?: string; status: 'active' | 'invalidated'; createdAt: number }
export interface ActionItem {
  id: string; requirementId: string; sourceType: 'review-item' | 'comment' | 'patch' | 'decision' | 'confirmation'; sourceId: string
  type: 'reply' | 'confirm' | 'review' | 'reconfirm'; assigneeRole: ParticipantRole; assigneeParticipantId?: string; blocking: boolean
  status: ActionItemStatus; dueStage: RequirementStage; createdAt: number; updatedAt: number
}
export interface AiReviewRun { id: string; requirementId: string; commit: string; kind: ReviewKind; status: AiTaskStatus; requestedBy: ParticipantSnapshot; sessionId?: string; error?: string; maturitySummary?: string; createdAt: number; updatedAt: number }
export interface AiStageConversation { stage: RequirementStage; stageCycle: number; sessionId: string; createdAt: number; updatedAt: number }
export interface ReadinessCheck { key: 'goal' | 'acceptance' | 'scope' | 'semantics' | 'evidence' | 'test-constraints'; passed: boolean; reasons: string[] }
export interface ReadyPackage { requirementId: string; commit: string; packageHash: string; generatedAt: number; generatedBy: ParticipantSnapshot; markdown: string }
export interface ReviewWorkspaceSummary { workspaceId: string; title: string; path: string }
export interface Company { id: string; name: string; externalRef?: string; createdAt: number; updatedAt: number }
export interface Customer { id: string; displayName: string; companyId?: string; externalRef?: string; createdAt: number; updatedAt: number }
export interface FeedbackSource {
  id: string; kind: 'text' | 'url' | 'csv' | 'markdown'; label: string; url?: string; externalRef?: string
  accessStatus: 'available' | 'unverified' | 'missing'; createdAt: number; updatedAt: number
}
export interface Insight {
  id: string; sourceId: string; customerId?: string; companyId?: string; title: string; body: string
  importance: InsightImportance; capturedAt: number; dedupeHash: string; createdBy: ParticipantSnapshot; createdAt: number; updatedAt: number
}
export interface InsightLink { id: string; insightId: string; requirementId: string; targetType: InsightTargetType; targetId?: string; createdBy: ParticipantSnapshot; createdAt: number }
export interface Notification {
  id: string; recipientParticipantId: string; kind: 'mention' | 'reply' | 'assignment' | 'status-change'; requirementId: string
  objectType: 'comment' | 'action' | 'requirement'; objectId: string; message: string; deepLink: string; createdAt: number; readAt?: number
}
export interface RequirementMetrics {
  openReviewCount: number; openCommentCount: number; pendingActionCount: number; activeDecisionCount: number; riskCount: number
  insightCount: number; customerImportanceScore: number; customerCount: number; companyCount: number; anonymousInsightCount: number
}
export interface RequirementSummary {
  id: string; title: string; stage: RequirementStage; currentCommit: string; workspaceId?: string; archivedAt?: number; updatedAt: number
  metrics: RequirementMetrics; participantIds: string[]
}
export interface StructuredDiffLine { type: 'context' | 'added' | 'removed'; oldLine?: number; newLine?: number; text: string }
export interface StructuredDiffHunk { id: string; oldStart: number; newStart: number; lines: StructuredDiffLine[]; collapsedBefore: number; collapsedAfter: number; collapsedBeforeLines: StructuredDiffLine[]; collapsedAfterLines: StructuredDiffLine[] }
export interface StructuredDiff { baseLabel: string; headLabel: string; added: number; removed: number; hunks: StructuredDiffHunk[] }
export interface DraftRecord { requirementId: string; participantId: string; baseCommit: string; markdown: string; summary: string; updatedAt: number }
export interface CollaborationEvent { types: CollaborationEventType[]; revision: number; requirementId?: string; objectId?: string }
export interface RequirementRecord {
  id: string; title: string; stage: RequirementStage; stageCycle: number; currentCommit: string; productConfirmedCommit?: string; jointConfirmedCommit?: string
  workspaceId?: string
  archivedAt?: number
  sources: SourceReference[]; reviewItems: ReviewItem[]; comments: CommentThread[]; patches: CandidatePatch[]; decisions: Decision[]
  confirmations: Confirmation[]; actionItems: ActionItem[]; aiRuns: AiReviewRun[]; aiConversations: AiStageConversation[]; readyPackage?: ReadyPackage; createdAt: number; updatedAt: number
}
export interface CollaborationState {
  schemaVersion: typeof SCHEMA_VERSION; revision: number; participants: ParticipantSnapshot[]; requirements: RequirementRecord[]
  companies: Company[]; customers: Customer[]; feedbackSources: FeedbackSource[]; insights: Insight[]; insightLinks: InsightLink[]; notifications: Notification[]
}
export interface RequirementView extends RequirementRecord { version: RequirementVersion; history: Array<Omit<RequirementVersion, 'markdown'>>; readiness: ReadinessCheck[]; metrics: RequirementMetrics; commitUrl?: string }
export interface SaveConflict {
  requirementId: string; baseCommit: string; currentCommit: string; baseMarkdown: string; currentMarkdown: string; draftMarkdown: string
  baseToCurrentDiff: string; baseToDraftDiff: string
}
export type MyItemCategory = 'awaiting-my-response' | 'awaiting-my-confirmation' | 'initiated-by-me' | 'possibly-mine-by-ip'
export interface MyActionItem extends ActionItem { category: MyItemCategory; requirementTitle: string; objectTitle: string; target: { tab: 'review' | 'discussion' | 'patches' | 'decisions' | 'ready'; objectId: string } }

export type CollaborationAction =
  | { kind: 'requirement.create'; participant: ParticipantSnapshot; title: string; rawRequirement: string; sources: SourceReference[]; workspaceId: string }
  | { kind: 'requirement.bind-workspace'; participant: ParticipantSnapshot; requirementId: string; workspaceId: string }
  | { kind: 'requirement.rename'; participant: ParticipantSnapshot; requirementId: string; title: string }
  | { kind: 'requirement.archive'; participant: ParticipantSnapshot; requirementId: string; archived: boolean }
  | { kind: 'requirement.unarchive'; participant: ParticipantSnapshot; requirementId: string }
  | { kind: 'requirement.delete'; participant: ParticipantSnapshot; requirementId: string }
  | { kind: 'version.save'; participant: ParticipantSnapshot; requirementId: string; baseCommit: string; markdown: string; summary: string }
  | { kind: 'version.restore'; participant: ParticipantSnapshot; requirementId: string; commit: string; summary: string }
  | { kind: 'review.request'; participant: ParticipantSnapshot; requirementId: string; reviewKind: ReviewKind }
  | { kind: 'review.respond'; participant: ParticipantSnapshot; requirementId: string; reviewItemId: string; disposition: NonNullable<ReviewItem['response']>['disposition']; body: string }
  | { kind: 'comment.create'; participant: ParticipantSnapshot; requirementId: string; commit: string; scope?: 'page' | 'inline'; anchor?: TextAnchor; body: string; mentions?: string[] }
  | { kind: 'comment.reply'; participant: ParticipantSnapshot; requirementId: string; commentId: string; body: string; mentions?: string[] }
  | { kind: 'comment.resolve'; participant: ParticipantSnapshot; requirementId: string; commentId: string; resolution: CommentResolution }
  | { kind: 'comment.reopen'; participant: ParticipantSnapshot; requirementId: string; commentId: string }
  | { kind: 'patch.accept'; participant: ParticipantSnapshot; requirementId: string; patchId: string; summary: string }
  | { kind: 'patch.reject'; participant: ParticipantSnapshot; requirementId: string; patchId: string }
  | { kind: 'decision.create'; participant: ParticipantSnapshot; requirementId: string; question: string; options: string[]; decision: string; rationale: string; affectedSections: string[]; affectedAcceptanceIds: string[]; sourceAnchors?: TextAnchor[] }
  | { kind: 'confirmation.create'; participant: ParticipantSnapshot; requirementId: string; role: ParticipantRole; scope: ConfirmationScope; scopeId?: string }
  | { kind: 'stage.advance'; participant: ParticipantSnapshot; requirementId: string }
  | { kind: 'ready.generate'; participant: ParticipantSnapshot; requirementId: string }
  | { kind: 'downstream.return'; participant: ParticipantSnapshot; requirementId: string; summary: string; evidence: ReviewEvidence[]; affectedSections: string[]; affectedAcceptanceIds: string[] }
  | { kind: 'participant.register'; participant: ParticipantSnapshot; requirementId: string }
  | { kind: 'action.assign'; participant: ParticipantSnapshot; requirementId: string; actionItemId: string; assigneeRole: ParticipantRole; assigneeParticipantId?: string; dueStage?: RequirementStage }
  | { kind: 'notification.mark-read'; participant: ParticipantSnapshot; requirementId: string; notificationIds: string[] }
  | { kind: 'source.upsert'; participant: ParticipantSnapshot; requirementId: string; source: Omit<FeedbackSource, 'createdAt' | 'updatedAt'> }
  | { kind: 'company.upsert'; participant: ParticipantSnapshot; requirementId: string; company: Omit<Company, 'createdAt' | 'updatedAt'> }
  | { kind: 'customer.upsert'; participant: ParticipantSnapshot; requirementId: string; customer: Omit<Customer, 'createdAt' | 'updatedAt'> }
  | { kind: 'insight.create'; participant: ParticipantSnapshot; requirementId: string; insight: Omit<Insight, 'dedupeHash' | 'createdBy' | 'createdAt' | 'updatedAt'>; links?: Array<Pick<InsightLink, 'requirementId' | 'targetType' | 'targetId'>> }
  | { kind: 'insight.update'; participant: ParticipantSnapshot; requirementId: string; insightId: string; changes: Partial<Pick<Insight, 'sourceId' | 'customerId' | 'companyId' | 'title' | 'body' | 'importance' | 'capturedAt'>> }
  | { kind: 'insight.delete'; participant: ParticipantSnapshot; requirementId: string; insightId: string }
  | { kind: 'insight.link'; participant: ParticipantSnapshot; requirementId: string; insightId: string; link: Pick<InsightLink, 'requirementId' | 'targetType' | 'targetId'> }
  | { kind: 'insight.unlink'; participant: ParticipantSnapshot; requirementId: string; linkId: string }
  | { kind: 'insight.import'; participant: ParticipantSnapshot; requirementId: string; source?: Omit<FeedbackSource, 'createdAt' | 'updatedAt'>; sources?: Array<Omit<FeedbackSource, 'createdAt' | 'updatedAt'>>; companies?: Array<Omit<Company, 'createdAt' | 'updatedAt'>>; customers?: Array<Omit<Customer, 'createdAt' | 'updatedAt'>>; rows: Array<Omit<Insight, 'dedupeHash' | 'createdBy' | 'createdAt' | 'updatedAt'>>; links?: Array<{ insightId: string } & Pick<InsightLink, 'requirementId' | 'targetType' | 'targetId'>> }

export interface ActionEnvelope { requestId: string; action: CollaborationAction }
export type ActionResult = { ok: true; revision: number; requirement: RequirementView; deletedRequirementId?: string } | { ok: false; revision: number; error: string; conflict?: SaveConflict }

export function isParticipant(value: unknown): value is ParticipantSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.participantId === 'string' && row.participantId.length >= 8
    && typeof row.nickname === 'string' && row.nickname.trim().length >= 2 && row.nickname.length <= 40
    && ['product', 'engineering'].includes(String(row.role)) && ['human', 'ai'].includes(String(row.kind))
    && (row.kind !== 'ai' || typeof row.sessionId === 'string')
}
export function parseEnvelope(value: unknown): ActionEnvelope | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (typeof row.requestId !== 'string' || row.requestId.trim() === '' || typeof row.action !== 'object' || row.action === null) return undefined
  const action = row.action as Record<string, unknown>
  if (typeof action.kind !== 'string' || !isParticipant(action.participant)) return undefined
  return { requestId: row.requestId, action: action as unknown as CollaborationAction }
}
