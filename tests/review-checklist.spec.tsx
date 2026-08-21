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
        affectedSections: ['业务规则'], affectedAcceptanceIds: ['AC-1'], recommendedOptions: ['采用服务端版本优先，并提示用户刷新后重试。', '采用最后一次提交，以服务端接收时间为准。', '检测到冲突后要求用户选择保留版本。'],
        ownerRole: 'product', status: 'open', createdAt: 1, updatedAt: 2,
      }], aiRuns: [],
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
    const textarea = dialog?.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    expect(document.activeElement).toBe(textarea)

    const recommendation = Array.from(dialog?.querySelectorAll('button') ?? []).find(button => button.textContent?.includes('采用服务端版本优先'))
    await act(async () => { recommendation?.click() })
    expect(textarea.value).toBe('采用服务端版本优先，并提示用户刷新后重试。')
    expect((dialog?.querySelector('select') as HTMLSelectElement).value).toBe('accept-modified')

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
      }], aiRuns: [],
    } as unknown as RequirementView
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const handled = vi.fn()

    await act(async () => {
      root.render(<ReviewPanel requirement={requirement} act={vi.fn(async () => true)} api={{} as SpecApi} openRequest={{ objectId: 'review-1', requestId: 1 }} onOpenRequestHandled={handled}/>)
    })

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('这次是否包含移动端？')
    expect(handled).toHaveBeenCalledWith(1)
  })
})
