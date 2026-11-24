import { createHash, randomUUID } from 'node:crypto'
import type { CollaborationAction, CollaborationState, FeedbackSource, Insight, InsightImportance, InsightLink, ParticipantSnapshot, RequirementMetrics } from './protocol.ts'

export function safeHttpUrl(value: string | undefined): boolean {
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

export function insightHash(sourceId: string, body: string): string { return createHash('sha256').update(`${sourceId}\n${body.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`).digest('hex') }
function validateInsight(insight: Insight, state: CollaborationState): void {
  if (!insight.id.trim() || !insight.sourceId.trim() || !insight.body.trim()) throw new Error('insight id, source and body are required')
  if (!state.feedbackSources.some(item => item.id === insight.sourceId)) throw new Error('feedback source not found')
  if (insight.customerId !== undefined && !state.customers.some(item => item.id === insight.customerId)) throw new Error('customer not found')
  if (insight.companyId !== undefined && !state.companies.some(item => item.id === insight.companyId)) throw new Error('company not found')
  if (!['unknown', 'want', 'important', 'critical'].includes(insight.importance)) throw new Error('invalid insight importance')
}

export interface InsightQuery {
  requirementId?: string
  customerId?: string
  companyId?: string
  sourceId?: string
  importance?: InsightImportance
  page?: number
  pageSize?: number
}

export interface InsightPage {
  items: Insight[]
  total: number
  links: InsightLink[]
  customers: CollaborationState['customers']
  companies: CollaborationState['companies']
  sources: FeedbackSource[]
}

export function queryInsights(state: CollaborationState, query: InsightQuery = {}): InsightPage {
  const linkedIds = query.requirementId === undefined ? undefined : new Set(state.insightLinks.filter(link => link.requirementId === query.requirementId).map(link => link.insightId))
  const rows = state.insights.filter(item => { const companyId = item.companyId ?? (item.customerId ? state.customers.find(customer => customer.id === item.customerId)?.companyId : undefined); return (linkedIds === undefined || linkedIds.has(item.id)) && (query.customerId === undefined || item.customerId === query.customerId) && (query.companyId === undefined || companyId === query.companyId) && (query.sourceId === undefined || item.sourceId === query.sourceId) && (query.importance === undefined || item.importance === query.importance) }).sort((left, right) => right.capturedAt - left.capturedAt)
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 50)); const start = Math.max(0, (query.page ?? 1) - 1) * pageSize
  const page = rows.slice(start, start + pageSize); const ids = new Set(page.map(item => item.id)); const customerIds = new Set(page.flatMap(item => item.customerId ? [item.customerId] : [])); const companyIds = new Set(page.flatMap(item => item.companyId ? [item.companyId] : [])); for (const customer of state.customers.filter(item => customerIds.has(item.id))) if (customer.companyId) companyIds.add(customer.companyId)
  return { items: structuredClone(page), total: rows.length, links: structuredClone(state.insightLinks.filter(item => ids.has(item.insightId))), customers: structuredClone(state.customers.filter(item => customerIds.has(item.id))), companies: structuredClone(state.companies.filter(item => companyIds.has(item.id))), sources: structuredClone(state.feedbackSources.filter(item => page.some(insight => insight.sourceId === item.id))) }
}

export function insightMetrics(state: CollaborationState, requirementId: string): Pick<RequirementMetrics, 'insightCount' | 'customerImportanceScore' | 'customerCount' | 'companyCount' | 'anonymousInsightCount'> {
  const insightIds = new Set(state.insightLinks.filter(link => link.requirementId === requirementId).map(link => link.insightId))
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
    insightCount: insights.length, customerImportanceScore: [...entityScores.values()].reduce((sum, value) => sum + value, 0), customerCount: customers.size, companyCount: companies.size, anonymousInsightCount,
  }
}


type InsightAction = Extract<CollaborationAction, { kind: 'source.upsert' | 'company.upsert' | 'customer.upsert' | `insight.${string}` }>

export function isInsightAction(action: CollaborationAction): action is InsightAction {
  return action.kind === 'source.upsert' || action.kind === 'company.upsert' || action.kind === 'customer.upsert' || action.kind.startsWith('insight.')
}

export function applyInsightAction(state: CollaborationState, action: InsightAction, now: number): void {
  const { requirementId, participant } = action
  switch (action.kind) {
    case 'source.upsert':
      upsertSource(state, action.source, now)
      break
    case 'company.upsert':
      upsertCompany(state, action.company, now)
      break
    case 'customer.upsert':
      upsertCustomer(state, action.customer, now)
      break
    case 'insight.create': {
      const insight = createInsight(state, requirementId, action.insight, participant, now)
      for (const link of action.links ?? []) addInsightLink(state, insight.id, link, participant, now)
      break
    }
    case 'insight.update': {
      const insight = state.insights.find(item => item.id === action.insightId)
      if (insight === undefined) throw new Error('insight not found')
      Object.assign(insight, action.changes)
      validateInsight(insight, state)
      insight.dedupeHash = insightHash(insight.sourceId, insight.body)
      insight.updatedAt = now
      break
    }
    case 'insight.delete': {
      const index = state.insights.findIndex(item => item.id === action.insightId)
      if (index < 0) throw new Error('insight not found')
      state.insights.splice(index, 1)
      state.insightLinks = state.insightLinks.filter(item => item.insightId !== action.insightId)
      break
    }
    case 'insight.link':
      addInsightLink(state, action.insightId, action.link, participant, now)
      break
    case 'insight.unlink':
      if (!state.insightLinks.some(item => item.id === action.linkId)) throw new Error('insight link not found')
      state.insightLinks = state.insightLinks.filter(item => item.id !== action.linkId)
      break
    case 'insight.import': {
      if (action.rows.length > 2_000 || Buffer.byteLength(JSON.stringify(action.rows), 'utf8') > 5 * 1024 * 1024) throw new Error('insight import exceeds 2,000 rows or 5 MB')
      if (action.source) upsertSource(state, action.source, now)
      for (const source of action.sources ?? []) upsertSource(state, source, now)
      for (const company of action.companies ?? []) upsertCompany(state, company, now)
      for (const customer of action.customers ?? []) upsertCustomer(state, customer, now)
      const actualIds = new Map<string, string>()
      for (const row of action.rows) actualIds.set(row.id, createInsight(state, requirementId, row, participant, now).id)
      for (const link of action.links ?? []) addInsightLink(state, actualIds.get(link.insightId) ?? link.insightId, link, participant, now)
      break
    }
  }
}

function upsertSource(state: CollaborationState, input: Parameters<typeof cleanSource>[0], now: number): void {
  const source = cleanSource(input)
  validateSource(source)
  upsert(state.feedbackSources, source, now)
}

function upsertCompany(state: CollaborationState, input: Parameters<typeof cleanCompany>[0], now: number): void {
  const company = cleanCompany(input)
  validateCompany(company)
  upsert(state.companies, company, now)
}

function upsertCustomer(state: CollaborationState, input: Parameters<typeof cleanCustomer>[0], now: number): void {
  const customer = cleanCustomer(input)
  validateCustomer(customer, state)
  upsert(state.customers, customer, now)
}

function upsert<T extends { id: string }>(rows: Array<T & { createdAt: number; updatedAt: number }>, value: T, now: number): void {
  const existing = rows.find(row => row.id === value.id)
  if (existing === undefined) rows.push({ ...value, createdAt: now, updatedAt: now })
  else Object.assign(existing, value, { updatedAt: now })
}

function createInsight(state: CollaborationState, requirementId: string, input: Omit<Insight, 'dedupeHash' | 'createdBy' | 'createdAt' | 'updatedAt'>, participant: ParticipantSnapshot, now: number): Insight {
  const draft: Insight = { ...input, title: input.title.trim(), body: input.body.trim(), dedupeHash: insightHash(input.sourceId, input.body), createdBy: participant, createdAt: now, updatedAt: now }
  validateInsight(draft, state)
  const existing = state.insights.find(item => item.dedupeHash === draft.dedupeHash)
  const insight = existing ?? draft
  if (existing === undefined) state.insights.push(insight)
  if (!state.insightLinks.some(item => item.insightId === insight.id && item.requirementId === requirementId && item.targetType === 'requirement')) state.insightLinks.push({ id: randomUUID(), insightId: insight.id, requirementId, targetType: 'requirement', createdBy: participant, createdAt: now })
  return insight
}

function addInsightLink(state: CollaborationState, insightId: string, link: Pick<InsightLink, 'requirementId' | 'targetType' | 'targetId'>, participant: ParticipantSnapshot, now: number): void {
  if (!state.insights.some(item => item.id === insightId)) throw new Error('insight not found')
  if (!state.requirements.some(item => item.id === link.requirementId)) throw new Error('requirement not found')
  if (!['requirement', 'section', 'acceptance-criterion'].includes(link.targetType)) throw new Error('invalid insight link target type')
  if (link.targetType !== 'requirement' && !link.targetId?.trim()) throw new Error('linked section or acceptance criterion id is required')
  const duplicate = state.insightLinks.some(item => item.insightId === insightId && item.requirementId === link.requirementId && item.targetType === link.targetType && item.targetId === link.targetId)
  if (!duplicate) state.insightLinks.push({ id: randomUUID(), insightId, ...link, createdBy: participant, createdAt: now })
}
