import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { CollaborationEngine, readiness, type AiCoordinator } from '../src/engine.ts'
import { GitRequirementStore } from '../src/git-store.ts'
import type { ParticipantSnapshot, RequirementView } from '../src/protocol.ts'

const product: ParticipantSnapshot = { participantId: 'participant-product', nickname: '产品甲', role: 'product', kind: 'human' }
const engineering: ParticipantSnapshot = { participantId: 'participant-engineer', nickname: '研发乙', role: 'engineering', kind: 'human' }
const ai: ParticipantSnapshot = { participantId: 'ai:session-review', nickname: '产品 AI', role: 'product', kind: 'ai', sessionId: 'session-review' }
const workspaceId = 'workspace-default'
const coordinator: AiCoordinator = { async requestReview() { return 'session-review' }, async requestCommentReply() { return 'session-comment' } }
function setup() { const dir = mkdtempSync(join(tmpdir(), 'spec-engine-')); const engine = new CollaborationEngine(join(dir, 'events.json'), new GitRequirementStore(join(dir, 'repo'))); engine.setCoordinator(coordinator); return engine }
function create(engine: CollaborationEngine): RequirementView { const result = engine.apply('create', { kind: 'requirement.create', participant: product, title: '重试策略', rawRequirement: '支付失败后需要自动重试。', sources: [], workspaceId }); if (!result.ok) throw new Error(result.error); return result.requirement }
function readyMarkdown(view: RequirementView): string { return view.version.markdown.replace('<!-- AI 初审后补充 -->', '为支付用户降低瞬时网络失败率，重试成功或明确失败可观察。').replace('### 范围\n\n### 非范围', '支付提交入口、网络超时状态。\n\n### 非范围\n\n不修改支付渠道选择。').replace('## 业务术语与规则\n', '## 业务术语与规则\n\n瞬时失败指网关超时；最多重试两次。\n').replace('- **AC-1**：待澄清', '- **AC-RETRY-001**：给定网关超时，首次失败后最多重试两次并返回最终状态。').replace('## 测试约束\n', '## 测试约束\n\n使用可控制超时次数的网关 fixture，不连接生产支付渠道。\n') }

describe('CollaborationEngine', () => {
  it('loads collaboration state written before participant bindings existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-engine-'))
    const eventPath = join(dir, 'events.json')
    writeFileSync(eventPath, JSON.stringify({ schemaVersion: 2, revision: 1, requirements: [] }))
    expect(new CollaborationEngine(eventPath, new GitRequirementStore(join(dir, 'repo'))).snapshot().participants).toEqual([])
  })

  it('requires and persists a review workspace for new requirements', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-engine-'))
    const engine = new CollaborationEngine(join(dir, 'events.json'), new GitRequirementStore(join(dir, 'repo')))
    engine.setCoordinator(coordinator)
    const missing = engine.apply('missing-group', { kind: 'requirement.create', participant: product, title: '退款', rawRequirement: '支持部分退款。', sources: [], workspaceId: '' })
    expect(missing).toMatchObject({ ok: false, error: 'review workspace is required' })
    const created = engine.apply('with-group', { kind: 'requirement.create', participant: product, title: '退款', rawRequirement: '支持部分退款。', sources: [], workspaceId: 'workspace-payments' })
    expect(created.ok && created.requirement.workspaceId).toBe('workspace-payments')
  })

  it('allows a legacy requirement to bind one workspace exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-engine-'))
    const eventPath = join(dir, 'events.json')
    const store = new GitRequirementStore(join(dir, 'repo'))
    const original = new CollaborationEngine(eventPath, store)
    const created = original.apply('legacy-source', { kind: 'requirement.create', participant: product, title: '旧需求', rawRequirement: '需要补充上下文。', sources: [], workspaceId: 'workspace-old' })
    if (!created.ok) throw new Error(created.error)
    const state = JSON.parse(readFileSync(eventPath, 'utf8')) as { requirements: Array<{ workspaceId?: string }> }
    delete state.requirements[0]?.workspaceId
    writeFileSync(eventPath, JSON.stringify(state))
    const reloaded = new CollaborationEngine(eventPath, store)
    const bound = reloaded.apply('bind-legacy', { kind: 'requirement.bind-workspace', participant: product, requirementId: created.requirement.id, workspaceId: 'workspace-current' })
    expect(bound.ok && bound.requirement.workspaceId).toBe('workspace-current')
    expect(reloaded.apply('rebind-legacy', { kind: 'requirement.bind-workspace', participant: product, requirementId: created.requirement.id, workspaceId: 'workspace-other' })).toMatchObject({ ok: false, error: 'review workspace is already bound' })
  })

  it('renames, archives, restores, and deletes a requirement', () => {
    const engine = setup(); const view = create(engine)
    const renamed = engine.apply('rename', { kind: 'requirement.rename', participant: product, requirementId: view.id, title: '支付重试规则' })
    expect(renamed.ok && renamed.requirement.title).toBe('支付重试规则')
    expect(renamed.ok && renamed.requirement.version.markdown).toContain('# 支付重试规则')
    expect(renamed.ok && renamed.requirement.currentCommit).not.toBe(view.currentCommit)
    const archived = engine.apply('archive', { kind: 'requirement.archive', participant: product, requirementId: view.id, archived: true })
    expect(archived.ok && archived.requirement.archivedAt).toBeTypeOf('number')
    const restored = engine.apply('restore', { kind: 'requirement.archive', participant: product, requirementId: view.id, archived: false })
    expect(restored.ok && restored.requirement.archivedAt).toBeUndefined()
    const deleted = engine.apply('delete', { kind: 'requirement.delete', participant: product, requirementId: view.id })
    expect(deleted).toMatchObject({ ok: true, deletedRequirementId: view.id })
    expect(engine.list()).toEqual([])
  })

  it('reads a historical requirement version for comparison', () => {
    const engine = setup(); const view = create(engine)
    const saved = engine.apply('save-history', { kind: 'version.save', participant: product, requirementId: view.id, baseCommit: view.currentCommit, markdown: `${view.version.markdown}\n补充内容`, summary: '补充内容' })
    if (!saved.ok) throw new Error(saved.error)
    expect(engine.version(view.id, view.currentCommit).markdown).toBe(view.version.markdown)
    expect(() => engine.version(view.id, '0'.repeat(40))).toThrow('requirement version not found')
  })

  it('keeps anonymous reads but requires a human participant for writes', () => {
    const engine = setup(); const view = create(engine); expect(engine.view(view.id).title).toBe('重试策略')
    const denied = engine.apply('ai-save', { kind: 'version.save', participant: ai, requirementId: view.id, baseCommit: view.currentCommit, markdown: 'bad', summary: 'AI write' })
    expect(denied).toMatchObject({ ok: false, error: 'human participant is required' })
  })

  it('binds participant role on first successful write and rejects later self-switching', () => {
    const engine = setup(); const view = create(engine)
    const switched: ParticipantSnapshot = { ...product, role: 'engineering' }
    const result = engine.apply('switched-role', { kind: 'confirmation.create', participant: switched, requirementId: view.id, role: 'engineering', scope: 'version' })
    expect(result).toMatchObject({ ok: false, error: 'participant role is bound to product' })
    expect(engine.snapshot().participants).toMatchObject([{ participantId: product.participantId, role: 'product' }])
  })

  it('automatically launches AI analysis for every substantive comment', async () => {
    const engine = setup(); const view = create(engine)
    const result = engine.apply('comment', { kind: 'comment.create', participant: engineering, requirementId: view.id, commit: view.currentCommit, anchor: { quote: '自动重试', heading: '原始需求与来源' }, body: '当前实现并没有区分瞬时失败。' })
    expect(result.ok).toBe(true)
    await Promise.resolve()
    const comment = engine.view(view.id).comments[0]!
    expect(comment.aiStatus).toBe('running')
    expect(comment.aiSessionId).toBe('session-comment')
  })

  it('blocks product gate until second review completes and blocking items resolve', async () => {
    const engine = setup(); const view = create(engine)
    engine.apply('review', { kind: 'review.request', participant: product, requirementId: view.id, reviewKind: 'product-second' })
    await Promise.resolve()
    const run = engine.view(view.id).aiRuns.find(item => item.kind === 'product-second')!
    engine.submitReview({ requirementId: view.id, commit: view.currentCommit, runId: run.id, ai, maturitySummary: '目标仍不清楚', items: [{ type: 'goal', severity: 'blocking', statement: '缺少用户结果', evidence: [], epistemicStatus: 'TO_VERIFY', impact: '无法验收', question: '完成后如何观察成功？', affectedSections: ['目标与用户结果'], affectedAcceptanceIds: [], ownerRole: 'product', status: 'open' }] })
    expect(engine.view(view.id).reviewItems[0]?.recommendedOptions).toBeUndefined()
    expect(engine.apply('advance-blocked', { kind: 'stage.advance', participant: product, requirementId: view.id })).toMatchObject({ ok: false, error: 'product blocking review items remain' })
  })

  it('resolves directly accepted findings but keeps modified answers pending a patch', async () => {
    const engine = setup(); const view = create(engine)
    engine.apply('review', { kind: 'review.request', participant: product, requirementId: view.id, reviewKind: 'product-second' }); await Promise.resolve()
    const run = engine.view(view.id).aiRuns.find(item => item.kind === 'product-second')!
    const finding = { type: 'semantics' as const, severity: 'blocking' as const, evidence: [], epistemicStatus: 'TO_VERIFY' as const, impact: '规则不明确', affectedSections: ['业务术语与规则'], affectedAcceptanceIds: [], ownerRole: 'product' as const, status: 'open' as const }
    engine.submitReview({ requirementId: view.id, commit: view.currentCommit, runId: run.id, ai, maturitySummary: '存在两个待确认项', items: [{ ...finding, statement: '可直接确认的规则', question: '是否直接采用？' }, { ...finding, statement: '需要修改的规则', question: '如何修改？' }] })
    const [direct, modified] = engine.view(view.id).reviewItems
    engine.apply('accept-direct', { kind: 'review.respond', participant: product, requirementId: view.id, reviewItemId: direct!.id, disposition: 'accept', body: '直接采用该规则。' })
    engine.apply('accept-modified', { kind: 'review.respond', participant: product, requirementId: view.id, reviewItemId: modified!.id, disposition: 'accept-modified', body: '采用建议并调整文案。' })
    expect(engine.view(view.id).reviewItems.map(item => item.status)).toEqual(['resolved', 'answered'])
  })

  it('passes the six-part gate only for the exact jointly confirmed commit', async () => {
    const engine = setup(); let view = create(engine)
    const saved = engine.apply('save', { kind: 'version.save', participant: product, requirementId: view.id, baseCommit: view.currentCommit, markdown: readyMarkdown(view), summary: 'Complete Ready inputs' }); if (!saved.ok) throw new Error(saved.error); view = saved.requirement
    engine.apply('review', { kind: 'review.request', participant: product, requirementId: view.id, reviewKind: 'product-second' }); await Promise.resolve()
    const run = engine.view(view.id).aiRuns.find(item => item.kind === 'product-second')!
    engine.submitReview({ requirementId: view.id, commit: view.currentCommit, runId: run.id, ai, maturitySummary: '可进入确认', items: [] })
    expect(engine.apply('to-confirm', { kind: 'stage.advance', participant: product, requirementId: view.id }).ok).toBe(true)
    expect(engine.apply('product-confirm', { kind: 'confirmation.create', participant: product, requirementId: view.id, role: 'product', scope: 'version' }).ok).toBe(true)
    expect(engine.apply('to-joint', { kind: 'stage.advance', participant: product, requirementId: view.id }).ok).toBe(true)
    expect(engine.apply('engineering-confirm', { kind: 'confirmation.create', participant: engineering, requirementId: view.id, role: 'engineering', scope: 'version' }).ok).toBe(true)
    const ready = engine.apply('ready', { kind: 'ready.generate', participant: product, requirementId: view.id })
    expect(ready.ok).toBe(true)
    if (ready.ok) expect(ready.requirement).toMatchObject({ stage: 'ready', readyPackage: { commit: view.currentCommit } })
  })

  it('recognizes acceptance criteria with descriptive titles', () => {
    const engine = setup(); const view = create(engine)
    const markdown = readyMarkdown(view).replace('**AC-RETRY-001**', '**AC-RETRY-001 网关超时重试**')
    expect(readiness(markdown, view).find(check => check.key === 'acceptance')).toEqual({ key: 'acceptance', passed: true, reasons: [] })
  })

  it('does not carry blocking findings from an older commit into readiness', async () => {
    const engine = setup(); let view = create(engine)
    engine.apply('old-review', { kind: 'review.request', participant: product, requirementId: view.id, reviewKind: 'product-first' }); await Promise.resolve()
    const run = engine.view(view.id).aiRuns.find(item => item.kind === 'product-first')!
    engine.submitReview({ requirementId: view.id, commit: view.currentCommit, runId: run.id, ai, maturitySummary: '旧版本存在阻塞项', items: [{ type: 'goal', severity: 'blocking', statement: '旧版本目标缺失', evidence: [], epistemicStatus: 'TO_VERIFY', impact: '旧版本不可验收', question: '如何补齐目标？', affectedSections: ['目标与用户结果'], affectedAcceptanceIds: [], ownerRole: 'product', status: 'open' }] })
    const saved = engine.apply('replace-old-version', { kind: 'version.save', participant: product, requirementId: view.id, baseCommit: view.currentCommit, markdown: readyMarkdown(view), summary: '补齐当前版本' })
    if (!saved.ok) throw new Error(saved.error); view = saved.requirement
    expect(view.reviewItems[0]).toMatchObject({ statement: '旧版本目标缺失', status: 'open' })
    expect(view.readiness.find(check => check.key === 'evidence')).toEqual({ key: 'evidence', passed: true, reasons: [] })
    engine.apply('current-review', { kind: 'review.request', participant: product, requirementId: view.id, reviewKind: 'product-second' }); await Promise.resolve()
    const currentRun = engine.view(view.id).aiRuns.find(item => item.kind === 'product-second' && item.commit === view.currentCommit)!
    engine.submitReview({ requirementId: view.id, commit: view.currentCommit, runId: currentRun.id, ai, maturitySummary: '当前版本可进入确认', items: [] })
    expect(engine.apply('advance-current-version', { kind: 'stage.advance', participant: product, requirementId: view.id }).ok).toBe(true)
  })

  it('invalidates only overlapping scoped confirmations after a save', () => {
    const engine = setup(); let view = create(engine)
    const saved = engine.apply('save', { kind: 'version.save', participant: product, requirementId: view.id, baseCommit: view.currentCommit, markdown: readyMarkdown(view), summary: 'Complete draft' }); if (!saved.ok) throw new Error(saved.error); view = saved.requirement
    engine.apply('section-confirm', { kind: 'confirmation.create', participant: product, requirementId: view.id, role: 'product', scope: 'section', scopeId: '业务术语与规则' })
    engine.apply('ac-confirm', { kind: 'confirmation.create', participant: product, requirementId: view.id, role: 'product', scope: 'acceptance-criterion', scopeId: 'AC-RETRY-001' })
    const next = engine.apply('change-ac', { kind: 'version.save', participant: product, requirementId: view.id, baseCommit: view.currentCommit, markdown: view.version.markdown.replace('最多重试两次并返回最终状态', '最多重试一次并返回最终状态'), summary: 'Change retry count' }); if (!next.ok) throw new Error(next.error)
    const confirmations = next.requirement.confirmations
    expect(confirmations.find(item => item.scope === 'section')?.status).toBe('active')
    expect(confirmations.find(item => item.scope === 'acceptance-criterion')?.status).toBe('invalidated')
  })

  it('returns a three-way conflict without losing the stale browser draft', () => {
    const engine = setup(); const view = create(engine)
    const first = engine.apply('first-save', { kind: 'version.save', participant: product, requirementId: view.id, baseCommit: view.currentCommit, markdown: `${view.version.markdown}\n远端修改`, summary: '远端修改' })
    if (!first.ok) throw new Error(first.error)
    const draft = `${view.version.markdown}\n本地草稿`
    const stale = engine.apply('stale-save', { kind: 'version.save', participant: product, requirementId: view.id, baseCommit: view.currentCommit, markdown: draft, summary: '本地修改' })
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.conflict).toMatchObject({ baseCommit: view.currentCommit, currentCommit: first.requirement.currentCommit, baseMarkdown: view.version.markdown, currentMarkdown: first.requirement.version.markdown, draftMarkdown: draft })
    expect(stale.conflict?.baseToCurrentDiff).toContain('+远端修改')
    expect(stale.conflict?.baseToDraftDiff).toContain('+本地草稿')
    expect(engine.view(view.id).currentCommit).toBe(first.requirement.currentCommit)
  })

  it('projects the same collaboration source into role-aware My Items categories', () => {
    const engine = setup(); const view = create(engine)
    const result = engine.apply('comment-for-items', { kind: 'comment.create', participant: engineering, requirementId: view.id, commit: view.currentCommit, anchor: { quote: '自动重试' }, body: '产品需要确认失败后的用户结果。' })
    if (!result.ok) throw new Error(result.error)
    const awaiting = engine.myItems(product, 'awaiting-my-response')
    const initiated = engine.myItems(engineering, 'initiated-by-me')
    expect(awaiting).toHaveLength(1)
    expect(awaiting[0]).toMatchObject({ category: 'awaiting-my-response', target: { tab: 'discussion' } })
    expect(initiated).toHaveLength(1)
    expect(initiated[0]).toMatchObject({ category: 'initiated-by-me', sourceId: awaiting[0]?.sourceId })
  })

  it('rejects English candidate patches and commits an accepted Chinese patch', () => {
    const engine = setup(); const view = create(engine)
    expect(() => engine.submitPatch({ requirementId: view.id, baseCommit: view.currentCommit, reviewKind: 'product-first', ai, proposedMarkdown: '# English only', summary: 'English patch', affectedReviewItemIds: [], affectedSections: [], affectedAcceptanceIds: [] })).toThrow('AI 评审反馈必须使用中文')
    const proposedMarkdown = view.version.markdown.replace('待澄清', '给定支付网关瞬时失败，系统重试后返回明确的成功或失败结果。')
    engine.submitPatch({ requirementId: view.id, baseCommit: view.currentCommit, reviewKind: 'product-first', ai, proposedMarkdown, summary: '补充可判定的中文验收结果', affectedReviewItemIds: [], affectedSections: ['需求与验收标准'], affectedAcceptanceIds: ['AC-1'] })
    const patch = engine.view(view.id).patches[0]!
    const accepted = engine.apply('accept-chinese-patch', { kind: 'patch.accept', participant: product, requirementId: view.id, patchId: patch.id, summary: '接受中文候选 Patch' })
    if (!accepted.ok) throw new Error(accepted.error)
    expect(accepted.requirement.currentCommit).not.toBe(view.currentCommit)
    expect(accepted.requirement.version.markdown).toBe(proposedMarkdown)
    expect(accepted.requirement.patches[0]?.status).toBe('accepted')
  })

  it('reopens only affected scopes when a downstream issue returns after Ready', async () => {
    const engine = setup(); let view = create(engine)
    const saved = engine.apply('ready-inputs', { kind: 'version.save', participant: product, requirementId: view.id, baseCommit: view.currentCommit, markdown: readyMarkdown(view), summary: '补齐 Ready 输入' }); if (!saved.ok) throw new Error(saved.error); view = saved.requirement
    engine.apply('second-review', { kind: 'review.request', participant: product, requirementId: view.id, reviewKind: 'product-second' }); await Promise.resolve()
    const run = engine.view(view.id).aiRuns.find(item => item.kind === 'product-second')!
    engine.submitReview({ requirementId: view.id, commit: view.currentCommit, runId: run.id, ai, maturitySummary: '可以进入产品确认', items: [] })
    engine.apply('advance-product', { kind: 'stage.advance', participant: product, requirementId: view.id })
    engine.apply('confirm-product', { kind: 'confirmation.create', participant: product, requirementId: view.id, role: 'product', scope: 'version' })
    engine.apply('advance-joint', { kind: 'stage.advance', participant: product, requirementId: view.id })
    engine.apply('confirm-engineering', { kind: 'confirmation.create', participant: engineering, requirementId: view.id, role: 'engineering', scope: 'version' })
    engine.apply('confirm-unrelated', { kind: 'confirmation.create', participant: product, requirementId: view.id, role: 'product', scope: 'section', scopeId: '业务术语与规则' })
    engine.apply('confirm-ac', { kind: 'confirmation.create', participant: product, requirementId: view.id, role: 'product', scope: 'acceptance-criterion', scopeId: 'AC-RETRY-001' })
    const ready = engine.apply('mark-ready', { kind: 'ready.generate', participant: product, requirementId: view.id }); if (!ready.ok) throw new Error(ready.error)
    const returned = engine.apply('downstream-return', { kind: 'downstream.return', participant: engineering, requirementId: view.id, summary: '下游验证发现重试次数语义不明确', evidence: [{ statement: '下游消费者无法区分首次请求与重试请求。', source: 'downstream:test-report', version: 'commit-123', accessible: true }], affectedSections: [], affectedAcceptanceIds: ['AC-RETRY-001'] })
    if (!returned.ok) throw new Error(returned.error)
    expect(returned.requirement.stage).toBe('joint-review')
    expect(returned.requirement.readyPackage).toBeUndefined()
    expect(returned.requirement.confirmations.find(item => item.scope === 'acceptance-criterion')?.status).toBe('invalidated')
    expect(returned.requirement.confirmations.find(item => item.scope === 'section')?.status).toBe('active')
    expect(returned.requirement.reviewItems.at(-1)).toMatchObject({ severity: 'blocking', affectedAcceptanceIds: ['AC-RETRY-001'], status: 'open' })
  })
})
