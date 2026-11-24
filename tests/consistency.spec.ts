import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollaborationEngine, type AiCoordinator } from '../src/engine.ts'
import { GitRequirementStore } from '../src/git-store.ts'
import type { CollaborationAction, ParticipantSnapshot, ReviewItem } from '../src/protocol.ts'

const product: ParticipantSnapshot = { participantId: 'consistency-product', nickname: '产品甲', role: 'product', kind: 'human' }
const engineering: ParticipantSnapshot = { participantId: 'consistency-engineering', nickname: '研发乙', role: 'engineering', kind: 'human' }
const ai: ParticipantSnapshot = { participantId: 'ai:review', nickname: '评审助手', role: 'product', kind: 'ai', sessionId: 'review-session' }
const coordinator: AiCoordinator = { requestReview: async () => 'review-session', requestCommentReply: async () => 'review-session' }
const completeBody = `# 支付重试

## 目标与用户结果

支付超时时用户能看到最终结果，避免重复提交。

## 范围与非范围

覆盖支付网关超时场景。支付渠道选择维持现状。

## 业务术语与规则

瞬时失败指网关超时，最多允许重试两次。

## 需求与验收标准

- **AC-1**：网关超时后最多重试两次并返回结果。

## 测试约束

使用可按次数模拟超时的本地支付网关。
`

const testDirectories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of testDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spec-consistency-'))
  testDirectories.push(dir)
  const repository = join(dir, 'repository')
  const ledger = join(dir, 'collaboration-v3.json')
  const store = new GitRequirementStore(repository)
  const engine = new CollaborationEngine(ledger, store)
  engine.setCoordinator(coordinator)
  let request = 0
  function apply(action: CollaborationAction) {
    const result = engine.apply(`consistency-${++request}`, action)
    if (!result.ok) throw new Error(result.error)
    return result.requirement
  }
  const created = apply({ kind: 'requirement.create', title: '支付重试', rawRequirement: '支付网关超时后重试。', workspaceId: 'payments', sources: [], participant: product })
  return { engine, apply, created, ledger, repository, store }
}

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: repository, encoding: 'utf8' }).trim()
}

async function readyFixture() {
  const fixture = setup()
  const { engine, apply, created } = fixture
  const requirementId = created.id
  const saved = apply({ kind: 'version.save', requirementId, baseCommit: created.currentCommit, markdown: completeBody, summary: '补齐正文', participant: product })
  apply({ kind: 'review.request', requirementId, reviewKind: 'product-second', participant: product })
  await Promise.resolve()
  for (const run of engine.view(requirementId).aiRuns.filter(run => run.commit === saved.currentCommit)) {
    engine.submitReview({ requirementId, commit: run.commit, runId: run.id, ai, items: [], maturitySummary: '审核完成。' })
  }
  apply({ kind: 'stage.advance', requirementId, participant: product })
  apply({ kind: 'confirmation.create', requirementId, scope: 'version', role: 'product', participant: product })
  apply({ kind: 'stage.advance', requirementId, participant: product })
  apply({ kind: 'confirmation.create', requirementId, scope: 'version', role: 'engineering', participant: engineering })
  apply({ kind: 'review.request', requirementId, reviewKind: 'engineering-precheck', participant: engineering })
  await Promise.resolve()
  const run = engine.view(requirementId).aiRuns.at(-1)!
  engine.submitReview({ requirementId, commit: run.commit, runId: run.id, ai, items: [], maturitySummary: '研发预审完成。' })
  return fixture
}

describe('collaboration consistency through public commands', () => {
  it('reopens a Ready requirement and retires old patches on rename', async () => {
    const { engine, apply, created } = await readyFixture()
    const requirementId = created.id
    const ready = apply({ kind: 'ready.generate', requirementId, participant: product })
    engine.submitPatch({ requirementId, baseCommit: ready.currentCommit, reviewKind: 'change-review', ai, proposedMarkdown: `${completeBody}\n补充规则。`, summary: '补充规则', affectedReviewItemIds: [], affectedSections: [], affectedAcceptanceIds: [] })
    const renamed = apply({ kind: 'requirement.rename', requirementId, title: '支付超时规则', participant: product })
    expect(renamed.stage).toBe('joint-review')
    expect(renamed.readyPackage).toBeUndefined()
    expect(renamed.confirmations.every(item => item.status === 'invalidated')).toBe(true)
    expect(renamed.patches[0]?.status).toBe('stale')
    expect(renamed.actionItems.find(item => item.sourceId === renamed.patches[0]?.id)?.status).toBe('invalidated')
    expect(renamed.aiRuns.at(-1)).toMatchObject({ kind: 'change-review', commit: renamed.currentCommit })
  })

  it('reopens a legacy Ready record whose package belongs to an older commit', async () => {
    const { engine, created, ledger, repository } = setup()
    await Promise.resolve()
    const state = engine.snapshot()
    const record = state.requirements[0]!
    record.stage = 'ready'
    record.readyPackage = { requirementId: created.id, commit: '0'.repeat(40), packageHash: 'historical', generatedAt: 1, generatedBy: product, markdown: '旧交付包' }
    writeFileSync(ledger, JSON.stringify(state))
    const recovered = new CollaborationEngine(ledger, new GitRequirementStore(repository)).view(created.id)
    expect(recovered).toMatchObject({ stage: 'joint-review', stageCycle: record.stageCycle + 1, currentCommit: created.currentCommit })
    expect(recovered.readyPackage).toBeUndefined()
    expect(recovered.version.markdown).toBe(created.version.markdown)
  })

  it('exports only current whole-version human signers', async () => {
    const { apply, created } = await readyFixture()
    const requirementId = created.id
    apply({ kind: 'confirmation.create', requirementId, scope: 'section', scopeId: '测试约束', role: 'engineering', participant: { ...engineering, participantId: 'section-only-signer', nickname: '章节签署者' } })
    const ready = apply({ kind: 'ready.generate', requirementId, participant: product })
    expect(ready.readyPackage?.markdown).toContain('研发确认：研发乙\n')
    expect(ready.readyPackage?.markdown).not.toContain('章节签署者')
  })

  it('publishes one complete collaboration revision even if a subscriber throws', async () => {
    const { engine, apply, created, ledger, store } = setup()
    await Promise.resolve()
    const initialRevision = engine.snapshot().revision
    const observed: Array<{ revision: number; participants: string[] }> = []
    engine.subscribe(() => { throw new Error('closed subscriber') })
    engine.subscribe(event => observed.push({ revision: event.revision, participants: engine.directory().map(item => item.participantId) }))
    apply({ kind: 'comment.create', requirementId: created.id, participant: engineering, commit: created.currentCommit, scope: 'page', body: '请核对超时规则。' })
    const reloaded = new CollaborationEngine(ledger, store)
    expect(observed).toEqual([{ revision: initialRevision + 1, participants: expect.arrayContaining([product.participantId, engineering.participantId]) }])
    expect(reloaded.snapshot()).toEqual(engine.snapshot())
  })

  it('keeps the ledger untouched when a later item invalidates an AI review batch', () => {
    const { engine, created, ledger } = setup()
    const run = created.aiRuns[0]!
    const item: Omit<ReviewItem, 'id' | 'requirementId' | 'commit' | 'reviewKind' | 'createdAt' | 'updatedAt'> = { type: 'risk', severity: 'major', statement: '存在重试风险', evidence: [], epistemicStatus: 'TO_VERIFY', impact: '可能重复提交', question: '如何避免重复提交？', affectedSections: [], affectedAcceptanceIds: [], ownerRole: 'product', status: 'open' }
    const before = engine.snapshot()
    const persisted = readFileSync(ledger, 'utf8')
    expect(() => engine.submitReview({ requirementId: created.id, commit: run.commit, runId: run.id, ai, items: [item, { ...item, epistemicStatus: 'FACT' }], maturitySummary: '部分结论仍需核对。' })).toThrow('FACT requires accessible versioned evidence')
    expect(engine.snapshot()).toEqual(before)
    expect(readFileSync(ledger, 'utf8')).toBe(persisted)
  })

  it('writes a delayed comment launch after a rejected action', async () => {
    const { engine, apply, created } = setup()
    let release!: (sessionId: string) => void
    engine.setCoordinator({ ...coordinator, requestCommentReply: () => new Promise(resolve => { release = resolve }) })
    const commented = apply({ kind: 'comment.create', requirementId: created.id, participant: product, commit: created.currentCommit, scope: 'page', body: '请核对超时规则。' })
    expect(engine.apply('reject-while-launching', { kind: 'requirement.rename', requirementId: created.id, participant: product, title: '' })).toMatchObject({ ok: false })
    release('delayed-comment-session')
    await Promise.resolve()
    expect(engine.view(created.id).comments[0]).toMatchObject({ id: commented.comments[0]!.id, aiStatus: 'running', aiSessionId: 'delayed-comment-session' })
  })

  it('keeps an AI comment reply completed when prompt admission resolves later', async () => {
    const { engine, apply, created } = setup()
    let release!: (sessionId: string) => void
    engine.setCoordinator({ ...coordinator, requestCommentReply: () => new Promise(resolve => { release = resolve }) })
    const commented = apply({ kind: 'comment.create', requirementId: created.id, participant: product, commit: created.currentCommit, scope: 'page', body: '请核对超时规则。' })
    const commentId = commented.comments[0]!.id
    engine.submitAiReply({ requirementId: created.id, commentId, ai, body: '已核对超时规则。' })
    release('early-reply-session')
    await Promise.resolve()
    expect(engine.view(created.id).comments[0]).toMatchObject({ aiStatus: 'completed', aiSessionId: 'early-reply-session' })
  })

  it('commits only the spec and leaves another staged path intact', () => {
    const { apply, created, repository } = setup()
    writeFileSync(join(repository, 'staged.txt'), '保留用户的暂存内容\n')
    git(repository, 'add', 'staged.txt')
    const saved = apply({ kind: 'version.save', requirementId: created.id, baseCommit: created.currentCommit, markdown: `${created.version.markdown}\n补齐正文。`, summary: '补齐正文', participant: product })
    expect(git(repository, 'diff-tree', '--no-commit-id', '--name-only', '-r', saved.currentCommit)).toBe(`requirements/${created.id}/spec.md`)
    expect(git(repository, 'diff', '--cached', '--name-only')).toBe('staged.txt')
  })

  it('does not move Git or launch review when the recovery record cannot be written', async () => {
    const { engine, created, ledger, repository } = setup()
    await Promise.resolve()
    const before = engine.snapshot()
    const launch = vi.fn(coordinator.requestReview)
    engine.setCoordinator({ ...coordinator, requestReview: launch })
    mkdirSync(`${ledger}.pending.tmp`)
    const result = engine.apply('disk-full-before-journal', { kind: 'version.save', requirementId: created.id, baseCommit: created.currentCommit, markdown: `${created.version.markdown}\n补齐正文。`, summary: '补齐正文', participant: product })
    expect(result.ok).toBe(false)
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(created.currentCommit)
    expect(engine.snapshot()).toEqual(before)
    expect(launch).not.toHaveBeenCalled()
  })

  it.each(['before-ref', 'after-ref', 'after-checkout'] as const)('recovers a save interrupted %s', async point => {
    const { engine, created, ledger, repository, store } = setup()
    await Promise.resolve()
    const launch = vi.fn(coordinator.requestReview)
    engine.setCoordinator({ ...coordinator, requestReview: launch })
    const publish = store.publish.bind(store)
    vi.spyOn(store, 'publish').mockImplementationOnce(change => {
      if (point === 'after-ref') git(repository, 'update-ref', 'HEAD', change.commit, change.baseHead!)
      if (point === 'after-checkout') publish(change)
      throw new Error('simulated process interruption')
    })
    const body = `${created.version.markdown}\n写入后可恢复。`
    const result = engine.apply('interrupted-save', { kind: 'version.save', requirementId: created.id, baseCommit: created.currentCommit, markdown: body, summary: '补齐正文', participant: product })
    const specPath = join(repository, 'requirements', created.id, 'spec.md')
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('requires recovery') })
    expect(engine.view(created.id).currentCommit).toBe(created.currentCommit)
    expect(existsSync(`${ledger}.pending`)).toBe(true)
    expect(readFileSync(specPath, 'utf8')).toBe(point === 'after-checkout' ? body : created.version.markdown)
    expect(launch).not.toHaveBeenCalled()

    const recovered = new CollaborationEngine(ledger, new GitRequirementStore(repository))
    const view = recovered.view(created.id)
    expect(view.version.markdown).toBe(body)
    expect(readFileSync(specPath, 'utf8')).toBe(body)
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(view.currentCommit)
    expect(git(repository, 'status', '--porcelain')).toBe('')
    expect(existsSync(`${ledger}.pending`)).toBe(false)
    expect(view.aiRuns.at(-1)).toMatchObject({ status: 'queued', commit: view.currentCommit, kind: 'change-review' })
    recovered.setCoordinator({ ...coordinator, requestReview: launch })
    expect(recovered.view(created.id).aiRuns.at(-1)).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') })
    expect(launch).not.toHaveBeenCalled()
  })

  it('does not overwrite an external edit made after an interrupted ref update', async () => {
    const { engine, created, ledger, repository, store } = setup()
    await Promise.resolve()
    vi.spyOn(store, 'publish').mockImplementationOnce(change => {
      git(repository, 'update-ref', 'HEAD', change.commit, change.baseHead!)
      throw new Error('simulated process interruption')
    })
    const result = engine.apply('interrupted-before-external-edit', { kind: 'version.save', requirementId: created.id, baseCommit: created.currentCommit, markdown: '新正文。', summary: '更新正文', participant: product })
    expect(result.ok).toBe(false)
    const specPath = join(repository, 'requirements', created.id, 'spec.md')
    writeFileSync(specPath, '恢复前的外部编辑。')
    expect(() => new CollaborationEngine(ledger, new GitRequirementStore(repository))).toThrow('external uncommitted changes')
    expect(readFileSync(specPath, 'utf8')).toBe('恢复前的外部编辑。')
    expect(existsSync(`${ledger}.pending`)).toBe(true)
  })

  it('recovers a completed checkout for a deletion without losing Git history', async () => {
    const { engine, created, ledger, repository, store } = setup()
    await Promise.resolve()
    const publish = store.publish.bind(store)
    vi.spyOn(store, 'publish').mockImplementationOnce(change => {
      publish(change)
      throw new Error('simulated interruption before ledger publication')
    })
    expect(engine.apply('interrupted-delete', { kind: 'requirement.delete', requirementId: created.id, participant: product }).ok).toBe(false)
    const reopenedStore = new GitRequirementStore(repository)
    const recovered = new CollaborationEngine(ledger, reopenedStore)
    expect(recovered.list()).toEqual([])
    expect(reopenedStore.read(created.id, created.currentCommit).markdown).toBe(created.version.markdown)
    expect(git(repository, 'status', '--porcelain')).toBe('')
    expect(existsSync(`${ledger}.pending`)).toBe(false)
  })

  it('rejects outside modification of the target spec and preserves that edit', async () => {
    const { engine, created, ledger, repository } = setup()
    await Promise.resolve()
    const before = readFileSync(ledger, 'utf8')
    const specPath = join(repository, 'requirements', created.id, 'spec.md')
    writeFileSync(specPath, '外部尚未提交的改动。')
    const result = engine.apply('guard-dirty-spec', { kind: 'version.save', requirementId: created.id, baseCommit: created.currentCommit, markdown: '另一份正文。', summary: '补齐正文', participant: product })
    expect(result).toMatchObject({ ok: false, error: 'spec has external uncommitted changes' })
    expect(readFileSync(specPath, 'utf8')).toBe('外部尚未提交的改动。')
    expect(readFileSync(ledger, 'utf8')).toBe(before)
    expect(existsSync(`${ledger}.pending`)).toBe(false)
  })
})
