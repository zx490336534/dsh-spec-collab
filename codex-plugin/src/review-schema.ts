import type { CandidatePatch, ReviewEvidence, ReviewItem, ReviewSourceAnchor } from '../../src/protocol.ts'

type Schema = { type: 'string' | 'boolean' | 'null' } | { type: 'string'; enum: string[] } |
  { type: 'array'; items: Schema } | { anyOf: Schema[] } |
  { type: 'object'; properties: Record<string, Schema>; required: string[]; additionalProperties: false }

const string = { type: 'string' } as const
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] })
const array = (items: Schema): Schema => ({ type: 'array', items })
const oneOf = (...values: string[]): Schema => ({ type: 'string', enum: values })
const object = (properties: Record<string, Schema>): Schema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
})
const strings = array(string)

export const reviewSchema = object({
  maturitySummary: string,
  items: array(object({
    type: oneOf('goal', 'evidence', 'history-conflict', 'current-implementation', 'scope', 'semantics', 'completeness', 'acceptance', 'risk'),
    severity: oneOf('blocking', 'major', 'minor'),
    statement: string,
    epistemicStatus: oneOf('FACT', 'INFERENCE', 'ASSUMPTION', 'TO_VERIFY'),
    impact: string,
    question: string,
    recommendedOptions: strings,
    sourceAnchors: array(object({ quote: string, heading: nullable(string) })),
    affectedSections: strings,
    affectedAcceptanceIds: strings,
    ownerRole: oneOf('product', 'engineering'),
    status: oneOf('open', 'joint-review', 'non-blocking-verify'),
    evidence: array(object({ statement: string, source: string, version: nullable(string), accessible: { type: 'boolean' } })),
  })),
  patch: nullable(object({
    proposedMarkdown: string,
    summary: string,
    affectedReviewItemIds: strings,
    affectedSections: strings,
    affectedAcceptanceIds: strings,
  })),
})

export const replySchema = object({ body: string })

type Finding = Omit<Parameters<import('../../src/engine.ts').CollaborationEngine['submitReview']>[0]['items'][number], 'evidence' | 'sourceAnchors' | 'recommendedOptions'> & {
  recommendedOptions: string[]
  evidence: Array<Omit<ReviewEvidence, 'version'> & { version: string | null }>
  sourceAnchors: Array<Omit<ReviewSourceAnchor, 'heading'> & { heading: string | null }>
}
type Patch = Pick<CandidatePatch, 'proposedMarkdown' | 'summary' | 'affectedReviewItemIds' | 'affectedSections' | 'affectedAcceptanceIds'>
export interface ReviewResult { maturitySummary: string; items: Finding[]; patch: Patch | null }
export interface ReplyResult { body: string }

export function matchesSchema(schema: Schema, value: unknown): boolean {
  if ('anyOf' in schema) return schema.anyOf.some(option => matchesSchema(option, value))
  if (schema.type === 'null') return value === null
  if (schema.type === 'array') return Array.isArray(value) && value.every(item => matchesSchema(schema.items, item))
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const fields = value as Record<string, unknown>
    return Object.keys(fields).length === schema.required.length &&
      schema.required.every(key => Object.hasOwn(fields, key) && matchesSchema(schema.properties[key]!, fields[key]))
  }
  if ('enum' in schema) return typeof value === 'string' && schema.enum.includes(value)
  return typeof value === schema.type
}

export function reviewItems(result: ReviewResult, markdown: string) {
  return result.items.map(item => {
    const recommendedOptions = item.recommendedOptions.map(option => option.trim())
    if (recommendedOptions.length < 3 || recommendedOptions.length > 4 ||
      new Set(recommendedOptions).size !== recommendedOptions.length ||
      recommendedOptions.some(option => !option || [...option].length > 60)) throw new Error('每个审核问题需要 3–4 个简洁且不同的选项')
    if (!item.question.trim() || [...item.question.trim()].length > 80) throw new Error('审核问题需要控制在 80 字以内')
    const sourceAnchors = item.sourceAnchors.map(({ quote, heading }) => ({
      quote: quote.trim(), ...(heading?.trim() ? { heading: heading.trim() } : {}),
    }))
    if (sourceAnchors.length > 3 || sourceAnchors.some(anchor => !anchor.quote || !markdown.includes(anchor.quote))) {
      throw new Error('审核定位需要引用当前版本的原文')
    }
    const evidence = item.evidence.map(({ version, ...reference }) => ({
      ...reference, ...(version?.trim() ? { version: version.trim() } : {}),
    }))
    return { ...item, recommendedOptions, sourceAnchors, evidence }
  })
}

export function candidatePatch(patch: Patch | null, markdown: string, findings: ReviewItem[]): Patch | undefined {
  if (!patch || patch.proposedMarkdown.trim() === markdown.trim()) return
  if (!/^# \S/.test(patch.proposedMarkdown.trim()) ||
    /\b(?:FACT|INFERENCE|ASSUMPTION|TO_VERIFY|Given|When|Then)\b/.test(patch.proposedMarkdown) ||
    Buffer.byteLength(patch.proposedMarkdown) > 2 * 1024 * 1024) {
    throw new Error('候选修改需要提交完整的中文 Markdown 正文')
  }
  const ids = new Set(findings.map(item => item.id))
  return { ...patch, affectedReviewItemIds: patch.affectedReviewItemIds.filter(id => ids.has(id)) }
}
