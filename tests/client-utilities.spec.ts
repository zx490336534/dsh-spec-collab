// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { draftKey, safeHttpUrl, truncateGraphemes } from '../src/client/drafts.ts'
import { mentionedParticipantIds, parseInsightFile, resolveDeepLinkTarget } from '../src/client/SpecWorkbench.tsx'
import type { ParticipantSnapshot, RequirementView } from '../src/protocol.ts'

describe('client safety utilities', () => {
  it('keeps drafts isolated by requirement and participant', () => { expect(draftKey('req-a', 'person-b')).toBe('req-a:person-b') })
  it('truncates by grapheme without breaking emoji or Chinese', () => { expect(truncateGraphemes('匿名浏览与👨‍👩‍👧‍👦组合文本', 6)).toBe('匿名浏览与👨‍👩‍👧‍👦…') })
  it('only permits http and https links', () => { expect(safeHttpUrl('README.md')).toBeUndefined(); expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined(); expect(safeHttpUrl('https://example.com/a')).toBe('https://example.com/a') })
  it('routes decision and version deep links to the correct records subview', () => {
    const requirement = { decisions: [{ id: 'decision-1' }], history: [{ commit: 'a'.repeat(40) }], actionItems: [], reviewItems: [], comments: [], patches: [] } as unknown as RequirementView
    expect(resolveDeepLinkTarget(requirement, 'records', 'decision-1')).toMatchObject({ primaryMode: 'records', recordView: 'decisions', focusObjectId: 'decision-1' })
    expect(resolveDeepLinkTarget(requirement, 'records', 'a'.repeat(40))).toMatchObject({ primaryMode: 'records', recordView: 'versions', focusObjectId: 'a'.repeat(40) })
  })
  it('routes assigned action deep links to their rendered source object', () => {
    const requirement = { decisions: [], history: [], reviewItems: [{ id: 'review-1' }], comments: [], patches: [], actionItems: [{ id: 'task-1', sourceType: 'review-item', sourceId: 'review-1' }] } as unknown as RequirementView
    expect(resolveDeepLinkTarget(requirement, 'tasks', 'task-1')).toMatchObject({ primaryMode: 'tasks', taskView: 'review', focusObjectId: 'review-1', reviewObjectId: 'review-1' })
  })
  it('matches complete mention names without notifying nickname prefixes', () => {
    const people = [{ participantId: 'participant-ann', nickname: 'Ann', role: 'product', kind: 'human' }, { participantId: 'participant-anna', nickname: 'Anna', role: 'product', kind: 'human' }] as ParticipantSnapshot[]
    expect(mentionedParticipantIds('请 @Anna 看一下', people)).toEqual(['participant-anna'])
  })
  it('preserves per-row sources, external refs, and quoted multiline CSV bodies', () => {
    const parsed = parseInsightFile('feedback.csv', 'body,customer,customer_ref,company,company_ref,source,source_url\n"第一行\n第二行",客户甲,C-1,公司甲,CO-1,访谈,https://example.com/interview')
    expect(parsed.errors).toEqual([])
    expect(parsed.rows[0]).toMatchObject({ body: '第一行\n第二行', customerRef: 'C-1', companyRef: 'CO-1', source: '访谈', sourceUrl: 'https://example.com/interview' })
  })
})
