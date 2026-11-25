import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { isPreparedSpecCommit, type PreparedSpecCommit } from './git-store.ts'
import { insightHash, safeHttpUrl } from './insights.ts'
import { SCHEMA_VERSION, type CollaborationState, type ParticipantSnapshot, type RequirementRecord } from './protocol.ts'

export class CollaborationLedger {
  private readonly pendingPath: string

  constructor(private readonly path: string, private readonly publishSpec: (change: PreparedSpecCommit) => void, private readonly legacyPath?: string) {
    this.pendingPath = `${path}.pending`
  }

  save(state: CollaborationState, spec?: PreparedSpecCommit): void {
    if (existsSync(this.pendingPath)) throw new Error('collaboration transaction requires recovery before further writes')
    if (spec === undefined) {
      atomicWrite(this.path, state)
      return
    }
    // Persist the intended ledger before the Git ref or worktree can move.
    atomicWrite(this.pendingPath, { state, spec })
    try {
      this.finish(state, spec)
    } catch (error) {
      throw new Error(`collaboration transaction requires recovery: ${errorMessage(error)}`, { cause: error })
    }
  }

  load(): CollaborationState {
    if (existsSync(this.pendingPath)) return this.recover()
    const source = existsSync(this.path) ? this.path : this.legacyPath
    if (source === undefined || !existsSync(source)) return emptyState()
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(source, 'utf8')) }
    catch (error) { throw new Error(`collaboration ledger is corrupted: ${errorMessage(error)}`, { cause: error }) }
    if (!isRecord(parsed) || typeof parsed.schemaVersion !== 'number') throw new Error('collaboration ledger has no schema version')
    if (parsed.schemaVersion === SCHEMA_VERSION) {
      validateV3Ledger(parsed)
      return normalizeV3(parsed)
    }
    if (parsed.schemaVersion !== 2) throw new Error(`unsupported collaboration schema: ${parsed.schemaVersion}`)
    validateV2Ledger(parsed)
    const migrated = migrateV2(parsed)
    const extension = extname(source)
    const stem = basename(source, extension).replace(/-v2$/, '')
    copyFileSync(source, join(dirname(source), `${stem}-v2.backup-${Date.now()}${extension || '.json'}`))
    atomicWrite(this.path, migrated)
    return migrated
  }

  private recover(): CollaborationState {
    let state: unknown
    let spec: PreparedSpecCommit | undefined
    try {
      const pending: unknown = JSON.parse(readFileSync(this.pendingPath, 'utf8'))
      if (isRecord(pending) && 'spec' in pending) {
        if (!isPreparedSpecCommit(pending.spec)) throw new Error('invalid prepared Git commit')
        spec = pending.spec
        state = pending.state
      } else {
        // Previous v3 releases wrote a bare ledger after the Git commit.
        state = pending
      }
      validateV3Ledger(state)
    } catch (error) {
      throw new Error(`pending collaboration transaction is corrupted: ${errorMessage(error)}`, { cause: error })
    }
    this.finish(state, spec)
    return normalizeV3(state)
  }

  private finish(state: CollaborationState, spec?: PreparedSpecCommit): void {
    if (spec !== undefined) this.publishSpec(spec)
    atomicWrite(this.path, state)
    unlinkSync(this.pendingPath)
  }
}

function emptyState(): CollaborationState {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, participants: [], requirements: [], companies: [], customers: [], feedbackSources: [], insights: [], insightLinks: [], notifications: [] }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function validateV2Ledger(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.requirements) || (value.participants !== undefined && !Array.isArray(value.participants))) throw new Error('invalid collaboration v2 ledger: requirements and participants must be arrays')
}
function validateV3Ledger(value: unknown): asserts value is CollaborationState {
  if (!isRecord(value)) throw new Error('invalid collaboration v3 ledger: object required')
  const arrays = ['participants', 'requirements', 'companies', 'customers', 'feedbackSources', 'insights', 'insightLinks', 'notifications'] as const
  if (value.schemaVersion !== SCHEMA_VERSION || !Number.isFinite(value.revision) || arrays.some(key => !Array.isArray(value[key]))) throw new Error('invalid collaboration v3 ledger: required collections are missing or invalid')
  for (const candidate of value.requirements as unknown[]) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.title !== 'string' || typeof candidate.currentCommit !== 'string' || !['product-review', 'product-confirmation', 'joint-review', 'ready'].includes(String(candidate.stage))) throw new Error('invalid collaboration v3 ledger: malformed requirement')
    const recordArrays = ['sources', 'reviewItems', 'comments', 'patches', 'decisions', 'confirmations', 'actionItems', 'aiRuns'] as const
    if (recordArrays.some(key => !Array.isArray(candidate[key])) || (candidate.aiConversations !== undefined && !Array.isArray(candidate.aiConversations))) throw new Error('invalid collaboration v3 ledger: malformed requirement collections')
  }
}

export function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  const descriptor = openSync(tmp, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
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
    if (record.stage === 'ready' && record.readyPackage?.commit !== record.currentCommit) {
      delete record.readyPackage
      record.stage = 'joint-review'
      record.stageCycle += 1
    } else if (record.aiConversations.length === 0 && (record.stage === 'product-review' || record.stage === 'joint-review')) {
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
