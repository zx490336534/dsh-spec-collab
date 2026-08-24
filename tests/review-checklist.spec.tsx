// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RequirementView } from '../src/protocol.ts'
import type { SpecApi } from '../src/client/api.ts'
import { DiscussionPanel, InlineCommentComposer, InlineReviewComposer, ReviewPanel, annotationScrollTargets, type EditorSelection } from '../src/client/SpecWorkbench.tsx'
import { AccessibleDialog } from '../src/client/AccessibleDialog.tsx'

const roots: Array<ReturnType<typeof createRoot>> = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); document.body.innerHTML = '' })

describe('review checklist', () => {
  it('traps dialog focus, closes with Escape, and restores the current trigger', async () => {
    function Harness() { const [open, setOpen] = useState(false); return <><button aria-label="登记身份" onClick={() => setOpen(true)}>登记身份</button>{open && <AccessibleDialog title="身份设置" close={() => setOpen(false)}><label>花名<input autoFocus/></label><button onClick={() => setOpen(false)}>取消</button></AccessibleDialog>}</> }
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root)
    await act(async () => { root.render(<Harness/>) })
    const trigger = host.querySelector('button') as HTMLButtonElement
    trigger.focus(); await act(async () => { trigger.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(document.activeElement?.tagName).toBe('INPUT')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('tracks annotation markers against the real ProseMirror scroll container', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div class="toastui-editor-main"><div class="toastui-editor-ww-container"><div class="toastui-editor-contents">hidden preview</div><div class="ProseMirror toastui-editor-contents">visible editor</div></div></div>'

    const targets = annotationScrollTargets(root)

    expect(targets[0]?.className).toContain('ProseMirror')
    expect(targets.some(target => target.classList.contains('toastui-editor-ww-container'))).toBe(true)
  })

  it('opens a compact inline question bubble and lets a recommendation populate the response', async () => {
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
    const respond = vi.fn(async () => true)
    const close = vi.fn()
    const locate = vi.fn()
    const complete = vi.fn()

    await act(async () => {
      root.render(<InlineReviewComposer item={requirement.reviewItems[0]!} sourceMarkdown={requirement.version.markdown} requirementId={requirement.id} position={{ rect: { top: 24, left: 32 }, placement: 'below', maxHeight: 280 }} busy={false} act={respond} close={close} locateSource={locate} complete={complete}/>)
    })

    const dialog = host.querySelector('[role="dialog"]')
    expect((dialog as HTMLElement).style.maxHeight).toBe('280px')
    expect(dialog?.textContent).toContain('多端并发修改时的最终生效规则尚未确定')
    expect(dialog?.textContent).toContain(longQuestion)
    expect(dialog?.textContent).toContain('已有依据')
    expect(dialog?.textContent).toContain('退款上限由服务端版本决定')
    const textarea = dialog?.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(document.activeElement).toBe(textarea)

    const recommendation = Array.from(dialog?.querySelectorAll('button') ?? []).find(button => button.textContent?.includes('采用服务端版本优先'))
    await act(async () => { recommendation?.click() })
    expect(textarea.value).toBe('采用服务端版本优先，并提示用户刷新后重试。')
    expect((dialog?.querySelector('select') as HTMLSelectElement).value).toBe('accept-modified')
    expect(dialog?.textContent).toContain('下一步由 AI 回读并生成正文修改建议')

    const submit = Array.from(dialog?.querySelectorAll('button') ?? []).find(button => button.textContent === '保存回答') as HTMLButtonElement
    await act(async () => { submit.click() })
    expect(respond).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith(false)

    const closeButton = dialog?.querySelector('[aria-label="关闭问题窗口"]') as HTMLButtonElement
    await act(async () => { closeButton.click() })
    expect(close).toHaveBeenCalledOnce()
  })

  it('routes a requested checklist item to the document inline anchor', async () => {
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

    expect(handled).toHaveBeenCalledWith(1)
    expect(locate).toHaveBeenCalledWith('review-1', undefined)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('saves an inline answer and asks to continue to the next unanswered item', async () => {
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
    const complete = vi.fn()

    await act(async () => {
      root.render(<InlineReviewComposer item={requirement.reviewItems[0]!} sourceMarkdown={requirement.version.markdown} requirementId={requirement.id} position={{ rect: { top: 24, left: 32 }, placement: 'below' }} nextItemId="review-2" busy={false} act={respond} close={vi.fn()} locateSource={vi.fn()} complete={complete}/>)
    })
    const firstRecommendation = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.startsWith('包含移动端。'))
    await act(async () => { firstRecommendation?.click() })
    const continueButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存并下一题')
    await act(async () => { continueButton?.click() })

    expect(respond).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith(true)
  })

  it('uses the same source-location action from discussion comments', async () => {
    const participant = { participantId: 'participant-1', nickname: '听白', role: 'product' as const, kind: 'human' as const }
    const requirement = {
      id: 'requirement-1', currentCommit: 'a'.repeat(40), reviewItems: [], aiRuns: [], version: { markdown: '# 登录范围\n\n## 范围与非范围\n\n这次仅包含桌面端。' },
      comments: [{ id: 'comment-1', requirementId: 'requirement-1', commit: 'a'.repeat(40), anchor: { heading: '范围与非范围', quote: '这次仅包含桌面端。' }, author: participant, body: '是否包含移动端？', replies: [], aiStatus: 'completed', status: 'open', createdAt: 1, updatedAt: 2 }],
    } as unknown as RequirementView
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const locate = vi.fn()
    const select = vi.fn()

    await act(async () => {
      root.render(<DiscussionPanel requirement={requirement} focusedCommentId="comment-1" onSelectComment={select} onLocateComment={locate} act={vi.fn(async () => true)} api={{} as SpecApi}/>)
    })

    expect(host.querySelector('#spec-object-comment-1')?.getAttribute('aria-current')).toBe('true')
    const locateButton = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '定位正文')
    await act(async () => { locateButton?.click() })
    expect(select).toHaveBeenCalledWith('comment-1')
    expect(locate).toHaveBeenCalledWith('comment-1')
  })

  it('starts a discussion from an inline comment bubble', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const selection: EditorSelection = { quote: '支持登录用户收藏、取消收藏和查看“我的收藏”。', prefix: '', suffix: '', heading: '范围', rect: { top: 24, left: 32 }, placement: 'below' }
    const submit = vi.fn(async () => {})
    const cancel = vi.fn()
    let text = ''
    const render = () => root.render(<InlineCommentComposer selection={selection} text={text} setText={value => { text = value; render() }} busy={false} cancel={cancel} submit={submit}/>)

    await act(async () => { render() })

    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('范围')
    expect(dialog?.textContent).toContain('支持登录用户收藏')
    let submitButton = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '提交') as HTMLButtonElement
    expect(submitButton.disabled).toBe(true)

    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('')
    await act(async () => { text = '这里是否需要区分图片和视频的收藏规则？'; render() })
    submitButton = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '提交') as HTMLButtonElement
    expect(submitButton.disabled).toBe(false)

    await act(async () => { submitButton.click() })
    expect(submit).toHaveBeenCalledOnce()

    const closeButton = host.querySelector('[aria-label="取消文字选择"]') as HTMLButtonElement
    await act(async () => { closeButton.click() })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
