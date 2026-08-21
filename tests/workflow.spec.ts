import { describe, expect, it } from 'vitest'
import type { ParticipantSnapshot, RequirementView, ReviewKind } from '../src/protocol.ts'
import { friendlyActionError, workflowState } from '../src/client/workflow.ts'

const product: ParticipantSnapshot = { participantId: 'product-1', nickname: '产品同学', role: 'product', kind: 'human' }

function requirement(overrides: Partial<RequirementView> = {}): RequirementView {
  const base: RequirementView = {
    id: 'requirement-1', title: '登录体验优化', stage: 'product-review', currentCommit: 'commit-1', workspaceId: 'workspace-1',
    sources: [], reviewItems: [], comments: [], patches: [], decisions: [], confirmations: [], actionItems: [], aiRuns: [],
    createdAt: 1, updatedAt: 1,
    version: { commit: 'commit-1', markdown: '# 登录体验优化', author: product, summary: '创建需求', createdAt: 1 },
    history: [],
    readiness: [
      { key: 'goal', passed: true, reasons: [] }, { key: 'acceptance', passed: true, reasons: [] },
      { key: 'scope', passed: true, reasons: [] }, { key: 'semantics', passed: true, reasons: [] },
      { key: 'evidence', passed: true, reasons: [] }, { key: 'test-constraints', passed: true, reasons: [] },
    ],
  }
  return { ...base, ...overrides }
}

function run(kind: ReviewKind, status: RequirementView['aiRuns'][number]['status'] = 'completed'): RequirementView['aiRuns'][number] {
  return { id: `run-${kind}`, requirementId: 'requirement-1', commit: 'commit-1', kind, status, requestedBy: product, createdAt: 1, updatedAt: 2 }
}

function blockingReview(status: RequirementView['reviewItems'][number]['status'] = 'open'): RequirementView['reviewItems'][number] {
  return {
    id: 'review-1', requirementId: 'requirement-1', commit: 'commit-1', reviewKind: 'product-first', type: 'scope', severity: 'blocking',
    statement: '范围不明确', evidence: [], epistemicStatus: 'TO_VERIFY', impact: '会影响研发范围', question: '是否包含移动端？',
    affectedSections: ['范围与非范围'], affectedAcceptanceIds: [], ownerRole: 'product', status, createdAt: 1, updatedAt: 1,
  }
}

describe('workflow state', () => {
  it('keeps a single disabled action while AI is working', () => {
    const state = workflowState(requirement({ aiRuns: [run('product-first', 'running')] }), 'product')
    expect(state).toMatchObject({ title: '正在整理需求中的问题', actionLabel: '分析中', command: { kind: 'none' }, disabled: true })
  })

  it('directs the product to unanswered blocking questions', () => {
    const state = workflowState(requirement({ aiRuns: [run('product-first')], reviewItems: [blockingReview()] }), 'product')
    expect(state).toMatchObject({ title: '回答 1 个关键问题', command: { kind: 'open', view: 'review' } })
  })

  it('advances only after product second review has completed', () => {
    const state = workflowState(requirement({ aiRuns: [run('product-first'), run('product-second')], reviewItems: [blockingReview('resolved')] }), 'product')
    expect(state).toMatchObject({ title: '进入产品确认', command: { kind: 'advance' } })
  })

  it('allows an explicitly delegated question to move into joint review', () => {
    const state = workflowState(requirement({ aiRuns: [run('product-first'), run('product-second')], reviewItems: [blockingReview('joint-review')] }), 'product')
    expect(state).toMatchObject({ title: '进入产品确认', command: { kind: 'advance' } })
  })

  it('explains when the current role cannot perform product confirmation', () => {
    const state = workflowState(requirement({ stage: 'product-confirmation' }), 'engineering')
    expect(state).toMatchObject({ actionLabel: '等待产品确认', command: { kind: 'none' }, disabled: true })
    expect(state.disabledReason).toContain('当前身份是研发')
  })

  it('points to missing delivery content before asking for confirmations', () => {
    const state = workflowState(requirement({
      stage: 'joint-review', aiRuns: [run('engineering-precheck')],
      readiness: [{ key: 'acceptance', passed: false, reasons: ['缺少验收标准'] }],
    }), 'product')
    expect(state).toMatchObject({ title: '补齐 1 项需求内容', command: { kind: 'open', view: 'ready' } })
  })

  it('asks each role to confirm the same ready version before generation', () => {
    const productConfirmation = { id: 'confirmation-product', requirementId: 'requirement-1', commit: 'commit-1', role: 'product' as const, participant: product, scope: 'version' as const, status: 'active' as const, createdAt: 2 }
    const awaitingEngineering = workflowState(requirement({ stage: 'joint-review', aiRuns: [run('engineering-precheck')], confirmations: [productConfirmation] }), 'engineering')
    expect(awaitingEngineering.command).toEqual({ kind: 'confirm', role: 'engineering' })

    const engineering = { ...product, participantId: 'engineering-1', nickname: '研发同学', role: 'engineering' as const }
    const engineeringConfirmation = { ...productConfirmation, id: 'confirmation-engineering', role: 'engineering' as const, participant: engineering }
    const ready = workflowState(requirement({ stage: 'joint-review', aiRuns: [run('engineering-precheck')], confirmations: [productConfirmation, engineeringConfirmation] }), 'engineering')
    expect(ready).toMatchObject({ title: '生成就绪需求', command: { kind: 'generate-ready' } })
  })
})

describe('friendly action errors', () => {
  it('turns engine constraints into actionable Chinese feedback', () => {
    expect(friendlyActionError('readiness gate is not satisfied')).toBe('需求内容还没有满足全部交付条件，请查看缺少内容。')
    expect(friendlyActionError('unknown failure')).toBe('unknown failure')
  })
})
