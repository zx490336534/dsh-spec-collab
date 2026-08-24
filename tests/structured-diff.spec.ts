import { describe, expect, it } from 'vitest'
import { buildStructuredDiff } from '../src/structured-diff.ts'

describe('structured diff', () => {
  it('reports every added and removed line with stable line numbers', () => {
    const result = buildStructuredDiff('一\n二\n三', '一\n新的二\n三\n四', '旧版本', '新版本')
    expect(result).toMatchObject({ baseLabel: '旧版本', headLabel: '新版本', added: 2, removed: 1 })
    expect(result.hunks.flatMap(hunk => hunk.lines).filter(line => line.type !== 'context')).toEqual([
      { type: 'removed', oldLine: 2, text: '二' },
      { type: 'added', newLine: 2, text: '新的二' },
      { type: 'added', newLine: 4, text: '四' },
    ])
  })

  it('collapses large unchanged regions around independent changes', () => {
    const before = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行`).join('\n')
    const after = before.replace('第 3 行', '第三行已修改').replace('第 27 行', '第二十七行已修改')
    const result = buildStructuredDiff(before, after, 'a', 'b')
    expect(result.hunks).toHaveLength(2)
    expect(result.hunks[0]?.collapsedAfter).toBeGreaterThan(0)
    expect(result.hunks[0]!.collapsedAfterLines).toHaveLength(result.hunks[0]!.collapsedAfter)
    expect(result.hunks[1]!.collapsedAfterLines).toHaveLength(result.hunks[1]!.collapsedAfter)
  })
})
