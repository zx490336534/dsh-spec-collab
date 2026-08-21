// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { ReviewItem } from '../src/protocol.ts'
import { reviewAnchorTerms, reviewSourceSnippets, reviewTargetElements } from '../src/client/review-anchors.ts'

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
})
