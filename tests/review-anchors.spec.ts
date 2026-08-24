// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { ReviewItem } from '../src/protocol.ts'
import { commentTargetElements, reviewAnchorTerms, reviewSourceSnippets, reviewTargetElements } from '../src/client/review-anchors.ts'

const markdown = [
  '# 退款规则',
  '',
  '## 业务规则',
  '',
  '同一订单最多可以发起三次部分退款。',
  '',
  '## 验收标准',
  '',
  '- **AC-1** 超过三次时提示用户联系人工客服。',
].join('\n')

function review(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'review-1', requirementId: 'requirement-1', commit: 'commit-1', reviewKind: 'product-first', type: 'semantics', severity: 'blocking',
    statement: '退款次数规则需要确认', evidence: [], epistemicStatus: 'TO_VERIFY', impact: '影响退款流程', question: '退款次数是否按订单累计？',
    affectedSections: ['业务规则'], affectedAcceptanceIds: ['AC-1'], sourceAnchors: [{ heading: '业务规则', quote: '同一订单最多可以发起三次部分退款。' }],
    ownerRole: 'product', status: 'open', createdAt: 1, updatedAt: 1, ...overrides,
  }
}

describe('review source anchors', () => {
  it('keeps exact AI quotes ahead of section and acceptance fallbacks', () => {
    const snippets = reviewSourceSnippets(markdown, review())
    expect(snippets[0]).toMatchObject({ label: '业务规则', markdown: '同一订单最多可以发起三次部分退款。' })
    expect(reviewAnchorTerms(review()).map(term => term.kind)).toEqual(['quote', 'acceptance', 'section'])
  })

  it('locates legacy review items by their affected section', () => {
    const legacy = review({ affectedAcceptanceIds: [] })
    delete legacy.sourceAnchors
    const snippets = reviewSourceSnippets(markdown, legacy)
    expect(snippets[0]?.label).toBe('业务规则')
    expect(snippets[0]?.markdown).toContain('同一订单最多可以发起三次部分退款')
  })

  it('maps a selected question to exact rendered text before its legacy fallbacks', () => {
    const root = document.createElement('article')
    root.innerHTML = '<h2>业务规则</h2><p>同一订单最多可以发起三次部分退款。</p><h2>验收标准</h2><p><strong>AC-1</strong> 超过三次时提示用户联系人工客服。</p>'

    const targets = reviewTargetElements(root, review())

    expect(targets.map(target => target.textContent)).toEqual([
      '同一订单最多可以发起三次部分退款。',
      'AC-1 超过三次时提示用户联系人工客服。',
      '业务规则',
    ])
  })

  it('can target one related acceptance criterion when a review item references multiple ACs', () => {
    const root = document.createElement('article')
    root.innerHTML = '<h2>验收标准</h2><p><strong>AC-1</strong> 账号登录时打开公开作品。</p><p><strong>AC-12</strong> 将内部账户作品加入社区。</p>'
    const item = review({ sourceAnchors: [], affectedSections: [], affectedAcceptanceIds: ['AC-1', 'AC-12'] })
    const snippets = reviewSourceSnippets([
      '# 社区作品',
      '',
      '## 验收标准',
      '',
      '- **AC-1** 账号登录时打开公开作品。',
      '- **AC-12** 将内部账户作品加入社区。',
    ].join('\n'), item)
    const ac12 = snippets.find(snippet => snippet.label === 'AC-12')

    expect(ac12?.targetKey).toBe('acceptance-1-AC-12')
    expect(reviewTargetElements(root, item, ac12?.targetKey)[0]?.textContent).toBe('AC-12 将内部账户作品加入社区。')
  })

  it('locates comment anchors with heading and surrounding context when the quote repeats', () => {
    const root = document.createElement('article')
    root.innerHTML = '<h2>公开作品</h2><p>AC-12 将内部账户作品加入社区。</p><h2>内部作品</h2><p>对于历史导入，AC-12 将内部账户作品加入社区。完成后展示提示。</p>'

    const targets = commentTargetElements(root, { heading: '内部作品', quote: 'AC-12 将内部账户作品加入社区。', prefix: '对于历史导入，', suffix: '完成后展示提示。' })

    expect(targets[0]?.textContent).toBe('对于历史导入，AC-12 将内部账户作品加入社区。完成后展示提示。')
  })
})
