import { randomUUID } from 'node:crypto'
import type { ActionItem, CollaborationAction, ParticipantSnapshot, ReadinessCheck, RequirementRecord } from './protocol.ts'
import { currentVersionConfirmations, hasCompletedCurrentReview, hasVersionConfirmation } from './ready-admission.ts'

type DecisionSourceAnchor = NonNullable<Extract<CollaborationAction, { kind: 'decision.create' }>['sourceAnchors']>[number]

export function enterStage(record: RequirementRecord, stage: RequirementRecord['stage']): void {
  if (record.stage === stage) return
  record.stage = stage
  record.stageCycle += 1
}
export function advance(record: RequirementRecord, participant: ParticipantSnapshot): void {
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
export function normalizeAnchorText(value: string): string { return value.replace(/[`*_>#\[\]()~-]/g, '').replace(/\s+/g, '').toLocaleLowerCase() }
function headingForLine(lines: string[], index: number): string | undefined {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const match = /^#{1,4}\s+(.+)$/.exec(lines[cursor] ?? '')
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}
export function decisionScopeAnchors(markdown: string, affectedSections: string[], affectedAcceptanceIds: string[]): DecisionSourceAnchor[] {
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
export function invalidateAffected(record: RequirementRecord, changedSections: string[], changedAcceptanceIds: string[], currentMarkdown?: string): void {
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
export function versionChanged(record: RequirementRecord, previousMarkdown: string, version: { commit: string; markdown: string }, now: number): void {
  const impact = changedScopes(previousMarkdown, version.markdown)
  record.currentCommit = version.commit
  record.updatedAt = now
  delete record.readyPackage
  if (record.stage === 'ready') enterStage(record, 'joint-review')
  for (const patch of record.patches) {
    if (patch.status !== 'pending') continue
    patch.status = 'stale'
    retireActionItems(record, 'patch', patch.id, 'invalidated', now)
  }
  invalidateAffected(record, impact.sections, impact.acceptanceIds, version.markdown)
}

export function retireActionItems(record: RequirementRecord, sourceType: ActionItem['sourceType'], sourceId: string, status: 'handled' | 'invalidated', now: number): void {
  for (const task of record.actionItems) {
    if (task.sourceType === sourceType && task.sourceId === sourceId && task.status === 'pending') {
      task.status = status
      task.updatedAt = now
    }
  }
}

export function readyMarkdown(record: RequirementRecord, markdown: string): string {
  const signers = (role: ParticipantSnapshot['role']) => [...new Set(currentVersionConfirmations(record, role).map(item => item.participant.nickname))].join('、')
  const open = record.reviewItems.filter(item => item.status === 'non-blocking-verify')
  const sourceStatus = { available: '可查阅', unverified: '待核对', missing: '待补充' } as const
  return [
    `# 就绪需求：${record.title}`, '', '## 版本信息', '',
    `- 需求编号：${record.id}`, `- 文档版本：${record.currentCommit}`,
    `- 产品确认：${signers('product')}`, `- 研发确认：${signers('engineering')}`,
    '', markdown, '', '## 已确认决策',
    ...record.decisions.filter(item => item.status === 'active').map(item => `- ${item.question}：${item.decision}（原因：${item.rationale}）`),
    '', '## 参考资料',
    ...record.sources.map(source => `- [${sourceStatus[source.accessStatus]}] ${source.label}${source.stableId ? `：${source.stableId}` : ''}${source.version ? `（版本：${source.version}）` : ''}`),
    '', '## 待确认问题',
    ...open.map(item => `- ${item.question}；负责人：${item.ownerParticipantId ?? (item.ownerRole === 'product' ? '产品' : '研发')}；影响：${item.impact}`),
    '',
  ].join('\n')
}
