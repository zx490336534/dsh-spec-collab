import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { DshReviewCoordinator } from '../src/review-runtime.ts'
import { makeRoutes } from '../src/routes.ts'
import { describe, expect, it } from 'vitest'
import { CollaborationEngine } from '../src/engine.ts'
import { GitRequirementStore } from '../src/git-store.ts'
import { workflowState } from '../src/client/workflow.ts'
import type { CollaborationAction, ParticipantSnapshot, ReviewKind } from '../src/protocol.ts'

const product: ParticipantSnapshot = { participantId: 'ready-product', nickname: '验收产品', role: 'product', kind: 'human' }
const engineering: ParticipantSnapshot = { participantId: 'ready-engineering', nickname: '验收研发', role: 'engineering', kind: 'human' }
const ai: ParticipantSnapshot = { participantId: 'ai:ready-review', nickname: '验收 AI', role: 'engineering', kind: 'ai', sessionId: 'ready-session' }
const markdown = `# 隔离验收需求

## 目标与用户结果

用户提交失败后能获得明确结果，避免不确定状态下重复操作。

## 范围与非范围

包含提交入口的超时提示；不包含支付渠道或订单结算行为的修改。

## 业务术语与规则

瞬时失败指请求超时，首次请求失败后最多重试两次。

## 需求与验收标准

- **AC-RETRY-001**：给定网关超时，首次失败后最多重试两次并返回最终状态。

## 测试约束

使用可控制超时次数的本地网关 fixture，不连接生产支付渠道。
`

function apply(engine: CollaborationEngine, action: CollaborationAction) {
  const result = engine.apply(randomUUID(), action)
  if (!result.ok) throw new Error(result.error)
  return result.requirement
}

async function completeReview(engine: CollaborationEngine, requirementId: string, kind: ReviewKind) {
  apply(engine, { kind: 'review.request', participant: product, requirementId, reviewKind: kind })
  await Promise.resolve()
  const view = engine.view(requirementId)
  const run = view.aiRuns.filter(item => item.commit === view.currentCommit && item.kind === kind).at(-1)!
  engine.submitReview({ requirementId, commit: view.currentCommit, runId: run.id, ai, items: [], maturitySummary: '本次结构化审核已完成。' })
}

async function jointReview() {
  const dir = mkdtempSync(join(tmpdir(), 'ready-admission-'))
  const engine = new CollaborationEngine(join(dir, 'events.json'), new GitRequirementStore(join(dir, 'repository')))
  engine.setCoordinator({ requestReview: async () => 'ready-session', requestCommentReply: async () => 'ready-session' })
  const created = apply(engine, { kind: 'requirement.create', participant: product, title: '隔离验收需求', rawRequirement: '提交失败后自动重试并返回明确结果。', sources: [], workspaceId: 'ready-workspace' })
  await Promise.resolve()
  const first = engine.view(created.id).aiRuns[0]!
  engine.submitReview({ requirementId: created.id, commit: created.currentCommit, runId: first.id, ai, items: [], maturitySummary: '初次审核完成。' })
  const saved = apply(engine, { kind: 'version.save', participant: product, requirementId: created.id, baseCommit: created.currentCommit, markdown, summary: '补齐验收正文' })
  await Promise.resolve()
  const change = engine.view(created.id).aiRuns.find(item => item.commit === saved.currentCommit && item.kind === 'change-review')!
  engine.submitReview({ requirementId: created.id, commit: saved.currentCommit, runId: change.id, ai, items: [], maturitySummary: '变更审核完成。' })
  await completeReview(engine, created.id, 'product-first')
  await completeReview(engine, created.id, 'product-second')
  apply(engine, { kind: 'stage.advance', participant: product, requirementId: created.id })
  apply(engine, { kind: 'confirmation.create', participant: product, requirementId: created.id, role: 'product', scope: 'version' })
  apply(engine, { kind: 'stage.advance', participant: product, requirementId: created.id })
  apply(engine, { kind: 'confirmation.create', participant: engineering, requirementId: created.id, role: 'engineering', scope: 'version' })
  return { engine, requirementId: created.id }
}

describe('Ready admission through the public engine actions', () => {
  it('rejects generation without engineering precheck even when both roles confirmed and all six checks pass', async () => {
    const { engine, requirementId } = await jointReview()
    const view = engine.view(requirementId)
    expect(view.readiness.every(check => check.passed)).toBe(true)
    expect(workflowState(view, 'product').command).toEqual({ kind: 'request-review', reviewKind: 'engineering-precheck' })
    const before = engine.snapshot()
    const result = engine.apply('ready-without-precheck', { kind: 'ready.generate', participant: product, requirementId })
    expect(result).toMatchObject({ ok: false, error: 'engineering precheck is required for the current version' })
    expect(engine.snapshot()).toEqual(before)
  })

  it.each(['queued', 'running', 'failed'] as const)('rejects an engineering precheck that is %s', async status => {
    const { engine, requirementId } = await jointReview()
    apply(engine, { kind: 'review.request', participant: engineering, requirementId, reviewKind: 'engineering-precheck' })
    if (status !== 'queued') await Promise.resolve()
    if (status === 'failed') engine.markAiFailure(requirementId, engine.view(requirementId).aiRuns.at(-1)!.id, '隔离测试失败')
    expect(engine.view(requirementId).aiRuns.at(-1)?.status).toBe(status)
    expect(engine.apply(randomUUID(), { kind: 'ready.generate', participant: product, requirementId })).toMatchObject({ ok: false })
    expect(engine.view(requirementId).readyPackage).toBeUndefined()
  })

  it('rejects an old engineering precheck after the body changes, even if both roles reconfirm', async () => {
    const { engine, requirementId } = await jointReview()
    await completeReview(engine, requirementId, 'engineering-precheck')
    const before = engine.view(requirementId)
    apply(engine, { kind: 'version.save', participant: product, requirementId, baseCommit: before.currentCommit, markdown: before.version.markdown.replace('两次', '一次'), summary: '改变重试次数' })
    await completeReview(engine, requirementId, 'change-review')
    // Complete the automatically queued change review too; isolate the stale-precheck condition.
    for (const run of engine.view(requirementId).aiRuns.filter(item => item.commit === engine.view(requirementId).currentCommit && item.status === 'running')) {
      engine.submitReview({ requirementId, commit: run.commit, runId: run.id, ai, items: [], maturitySummary: '变更复核完成。' })
    }
    for (const participant of [product, engineering]) apply(engine, { kind: 'confirmation.create', participant, requirementId, role: participant.role, scope: 'version' })
    expect(engine.apply(randomUUID(), { kind: 'ready.generate', participant: product, requirementId })).toMatchObject({ ok: false, error: 'engineering precheck is required for the current version' })
  })

  it('allows a completed current precheck and binds the package to that commit', async () => {
    const { engine, requirementId } = await jointReview()
    await completeReview(engine, requirementId, 'engineering-precheck')
    const view = engine.view(requirementId)
    expect(workflowState(view, 'engineering').command).toEqual({ kind: 'generate-ready' })
    const ready = apply(engine, { kind: 'ready.generate', participant: product, requirementId })
    expect(ready).toMatchObject({ stage: 'ready', readyPackage: { commit: view.currentCommit } })
    expect(ready.readyPackage?.markdown).toContain(view.currentCommit)
  })

  it('requires both roles to reconfirm after a body change and a new precheck', async () => {
    const { engine, requirementId } = await jointReview()
    await completeReview(engine, requirementId, 'engineering-precheck')
    const before = engine.view(requirementId)
    apply(engine, { kind: 'version.save', participant: product, requirementId, baseCommit: before.currentCommit, markdown: before.version.markdown.replace(/两次/g, '一次'), summary: '改变重试次数' })
    await Promise.resolve()
    for (const run of engine.view(requirementId).aiRuns.filter(item => item.commit === engine.view(requirementId).currentCommit && item.status === 'running')) engine.submitReview({ requirementId, commit: run.commit, runId: run.id, ai, items: [], maturitySummary: '变更复核完成。' })
    await completeReview(engine, requirementId, 'engineering-precheck')
    expect(engine.view(requirementId).confirmations.every(item => item.status === 'invalidated')).toBe(true)
    expect(engine.apply(randomUUID(), { kind: 'ready.generate', participant: product, requirementId })).toMatchObject({ ok: false, error: 'current version needs product and engineering confirmation' })
    apply(engine, { kind: 'confirmation.create', participant: product, requirementId, role: 'product', scope: 'version' })
    expect(engine.apply(randomUUID(), { kind: 'ready.generate', participant: product, requirementId }).ok).toBe(false)
    apply(engine, { kind: 'confirmation.create', participant: engineering, requirementId, role: 'engineering', scope: 'version' })
    expect(engine.apply(randomUUID(), { kind: 'ready.generate', participant: product, requirementId }).ok).toBe(true)
  })

  it('rejects late submissions for an old commit rather than completing a current precheck', async () => {
    const { engine, requirementId } = await jointReview()
    const before = engine.view(requirementId)
    apply(engine, { kind: 'review.request', participant: engineering, requirementId, reviewKind: 'engineering-precheck' })
    await Promise.resolve()
    const oldRun = engine.view(requirementId).aiRuns.at(-1)!
    apply(engine, { kind: 'version.save', participant: product, requirementId, baseCommit: before.currentCommit, markdown: before.version.markdown.replace(/两次/g, '一次'), summary: '改变重试次数' })
    expect(() => engine.submitReview({ requirementId, commit: before.currentCommit, runId: oldRun.id, ai, items: [], maturitySummary: '旧版本审核。' })).toThrow('review run is stale')
  })

  it('does not generate while a new review is running after an earlier successful precheck', async () => {
    const { engine, requirementId } = await jointReview()
    await completeReview(engine, requirementId, 'engineering-precheck')
    apply(engine, { kind: 'review.request', participant: engineering, requirementId, reviewKind: 'engineering-precheck' })
    await Promise.resolve()
    expect(workflowState(engine.view(requirementId), 'product').disabled).toBe(true)
    expect(engine.apply(randomUUID(), { kind: 'ready.generate', participant: product, requirementId }).ok).toBe(false)
  })

  it('requires a pending candidate patch to be accepted or rejected before generation', async () => {
    const { engine, requirementId } = await jointReview()
    await completeReview(engine, requirementId, 'engineering-precheck')
    const view = engine.view(requirementId)
    engine.submitPatch({ requirementId, baseCommit: view.currentCommit, reviewKind: 'engineering-precheck', ai, proposedMarkdown: view.version.markdown.replace(/两次/g, '一次'), summary: '调整重试次数。', affectedReviewItemIds: [], affectedSections: ['业务术语与规则'], affectedAcceptanceIds: ['AC-RETRY-001'] })
    expect(workflowState(engine.view(requirementId), 'product').command).toEqual({ kind: 'open', view: 'patches' })
    expect(engine.apply(randomUUID(), { kind: 'ready.generate', participant: product, requirementId }).ok).toBe(false)
  })

  it('preserves a delayed review launch after a rejected Ready action', async () => {
    const { engine, requirementId } = await jointReview()
    await completeReview(engine, requirementId, 'engineering-precheck')
    let release: ((sessionId: string) => void) | undefined
    engine.setCoordinator({ requestReview: () => new Promise(resolve => { release = resolve }), requestCommentReply: async () => 'unused' })
    apply(engine, { kind: 'review.request', participant: engineering, requirementId, reviewKind: 'engineering-precheck' })
    const runId = engine.view(requirementId).aiRuns.at(-1)!.id
    expect(engine.apply(randomUUID(), { kind: 'ready.generate', participant: product, requirementId }).ok).toBe(false)
    release!('delayed-real-session')
    await Promise.resolve()
    expect(engine.view(requirementId).aiRuns.find(run => run.id === runId)).toMatchObject({ status: 'running', sessionId: 'delayed-real-session' })
    expect(engine.hasAiSession(requirementId, 'delayed-real-session')).toBe(true)
  })

  it('enforces the same rule through the HTTP action route and succeeds after precheck completion', async () => {
    const { engine, requirementId } = await jointReview()
    // This action does not use the coordinator; constructing the real adapter avoids a second admission implementation.
    const route = makeRoutes(engine, new DshReviewCoordinator({} as ApiProxy)).find(item => item.path === '/api/spec-collab/action')!
    const server = createServer((req, res) => { void route.handler(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/spec-collab/action`
    const generate = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), action: { kind: 'ready.generate', participant: product, requirementId } }) })
    try {
      const denied = await generate()
      expect(denied.status).toBe(400)
      expect(await denied.json()).toMatchObject({ ok: false, error: 'engineering precheck is required for the current version' })
      await completeReview(engine, requirementId, 'engineering-precheck')
      const accepted = await generate()
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toMatchObject({ ok: true, requirement: { stage: 'ready', readyPackage: { commit: engine.view(requirementId).currentCommit } } })
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
