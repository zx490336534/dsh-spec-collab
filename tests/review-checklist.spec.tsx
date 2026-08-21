// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RequirementView } from '../src/protocol.ts'
import type { SpecApi } from '../src/client/api.ts'
import { ReviewPanel } from '../src/client/SpecWorkbench.tsx'

const roots: Array<ReturnType<typeof createRoot>> = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); document.body.innerHTML = '' })

describe('review checklist', () => {
  it('opens a spacious decision dialog and lets a recommendation populate the response', async () => {
    const longQuestion = '当同一个账号在多个设备同时修改退款上限时，应采用最后一次提交、服务端版本优先，还是提示用户解决冲突？'
    const requirement = {
      id: 'requirement-1', currentCommit: 'a'.repeat(40), reviewItems: [{
        id: 'review-1', requirementId: 'requirement-1', commit: 'a'.repeat(40), reviewKind: 'product-first', type: 'semantics', severity: 'blocking',
        statement: '多端并发修改时的最终生效规则尚未确定，可能导致不同设备展示不一致。', question: longQuestion, impact: '这会影响数据覆盖规则、冲突提示和验收方式。',
        evidence: [{ statement: '现有接口只返回更新时间。', source: 'src/refund/api.ts', version: 'abc123', accessible: true }], epistemicStatus: 'FACT',
        affectedSections: ['业务规则'], affectedAcceptanceIds: ['AC-1'], sourceAnchors: [{ heading: '业务规则', quote: '退款上限由服务端版本决定。' }], recommendedOptions: ['采用服务端版本优先，并提示用户刷新后重试。', '采用最后一次提交，以服务端接收时间为准。', '检测到冲突后要求用户选择保留版本。'],
        ownerRole: 'product', status: 'open', createdAt: 1, updatedAt: 2,
      }], aiRuns: [], version: { markdown: '# 退款规则\n\n## 业务规则\n\n退款上限由服务端版本决定。' },
    } as unknown as RequirementView
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => { root.render(<ReviewPanel requirement={requirement} act={vi.fn(async () => true)} api={{} as SpecApi}/>) })

    const row = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes(longQuestion))
    expect(row).toBeDefined()
    expect(row?.getAttribute('title')).toBe(longQuestion)
    await act(async () => { (row as HTMLButtonElement).focus(); row?.click() })

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('多端并发修改时的最终生效规则尚未确定')
    expect(dialog?.textContent).toContain(longQuestion)
    expect(dialog?.textContent).toContain('src/refund/api.ts@abc123')
    expect(dialog?.textContent).toContain('关联正文')
    expect(dialog?.textContent).toContain('退款上限由服务端版本决定')
    const textarea = dialog?.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    expect(document.activeElement).toBe(textarea)

    const recommendation = Array.from(dialog?.querySelectorAll('button') ?? []).find(button => button.textContent?.includes('采用服务端版本优先'))
    await act(async () => { recommendation?.click() })
    expect(textarea.value).toBe('采用服务端版本优先，并提示用户刷新后重试。')
    expect((dialog?.querySelector('select') as HTMLSelectElement).value).toBe('accept-modified')
    expect(dialog?.textContent).toContain('下一步由 AI 回读并生成正文修改建议')

    const close = dialog?.querySelector('[aria-label="关闭问题窗口"]') as HTMLButtonElement
    await act(async () => { close.click() })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(row)
  })

  it('opens a requested checklist item directly from the workflow action', async () => {
    const requirement = {
      id: 'requirement-1', currentCommit: 'a'.repeat(40), reviewItems: [{
        id: 'review-1', requirementId: 'requirement-1', commit: 'a'.repeat(40), reviewKind: 'product-first', type: 'scope', severity: 'blocking',
        statement: '移动端范围尚未确定', question: '这次是否包含移动端？', impact: '影响研发范围。', evidence: [], epistemicStatus: 'TO_VERIFY',
        affectedSections: ['范围与非范围'], affectedAcceptanceIds: [], ownerRole: 'product', status: 'open', createdAt: 1, updatedAt: 2,
      }], aiRuns: [], version: { markdown: '# 登录范围\n\n## 范围与非范围\n\n这次仅包含桌面端。' },
    } as unknown as RequirementView
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const handled = vi.fn()
    const locate = vi.fn()

    await act(async () => {
      root.render(<ReviewPanel requirement={requirement} act={vi.fn(async () => true)} api={{} as SpecApi} openRequest={{ objectId: 'review-1', requestId: 1 }} onLocateSource={locate} onOpenRequestHandled={handled}/>)
    })

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('这次是否包含移动端？')
    expect(handled).toHaveBeenCalledWith(1)
    const locateButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent === '在正文中查看')
    await act(async () => { locateButton?.click() })
    expect(locate).toHaveBeenCalledWith('review-1')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('saves an answer and opens the next unanswered item without returning to the small panel', async () => {
    const base = {
      requirementId: 'requirement-1', commit: 'a'.repeat(40), reviewKind: 'product-first' as const, type: 'scope' as const, severity: 'blocking' as const,
      evidence: [], epistemicStatus: 'TO_VERIFY' as const, affectedSections: ['范围与非范围'], affectedAcceptanceIds: [], ownerRole: 'product' as const, status: 'open' as const, createdAt: 1,
    }
    const requirement = {
      id: 'requirement-1', currentCommit: 'a'.repeat(40), reviewItems: [
        { ...base, id: 'review-1', statement: '移动端范围尚未确定', question: '是否包含移动端？', impact: '影响客户端范围。', recommendedOptions: ['包含移动端。', '仅包含桌面端。', '本期均不包含。'], updatedAt: 3 },
        { ...base, id: 'review-2', statement: '灰度范围尚未确定', question: '是否需要灰度发布？', impact: '影响发布计划。', recommendedOptions: ['需要按租户灰度。', '需要按账号灰度。', '不需要灰度。'], updatedAt: 2 },
      ], aiRuns: [], version: { markdown: '# 登录范围\n\n## 范围与非范围' },
    } as unknown as RequirementView
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const respond = vi.fn(async () => true)

    await act(async () => { root.render(<ReviewPanel requirement={requirement} act={respond} api={{} as SpecApi} openRequest={{ objectId: 'review-1', requestId: 1 }}/>) })
    const firstRecommendation = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.startsWith('包含移动端。'))
    await act(async () => { firstRecommendation?.click() })
    const continueButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存并回答下一题')
    await act(async () => { continueButton?.click() })

    expect(respond).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('是否需要灰度发布？')
  })
})
