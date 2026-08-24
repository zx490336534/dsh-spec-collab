import type { StructuredDiff, StructuredDiffLine } from './protocol.ts'

type Operation = { type: StructuredDiffLine['type']; text: string }

export function buildStructuredDiff(before: string, after: string, baseLabel = '原版本', headLabel = '新版本'): StructuredDiff {
  const operations = myers(before.split('\n'), after.split('\n'))
  let oldLine = 0; let newLine = 0
  const lines = operations.map<StructuredDiffLine>(operation => {
    if (operation.type !== 'added') oldLine += 1
    if (operation.type !== 'removed') newLine += 1
    return { type: operation.type, ...(operation.type === 'added' ? {} : { oldLine }), ...(operation.type === 'removed' ? {} : { newLine }), text: operation.text }
  })
  const changed = lines.flatMap((line, index) => line.type === 'context' ? [] : [index])
  if (changed.length === 0) return { baseLabel, headLabel, added: 0, removed: 0, hunks: [] }
  const ranges: Array<{ start: number; end: number }> = []
  for (const index of changed) {
    const start = Math.max(0, index - 3); const end = Math.min(lines.length - 1, index + 3); const previous = ranges.at(-1)
    if (previous !== undefined && start <= previous.end + 1) previous.end = Math.max(previous.end, end)
    else ranges.push({ start, end })
  }
  return {
    baseLabel, headLabel,
    added: lines.filter(line => line.type === 'added').length,
    removed: lines.filter(line => line.type === 'removed').length,
    hunks: ranges.map((range, index) => {
      const visible = lines.slice(range.start, range.end + 1)
      const collapsedBeforeLines = index === 0 ? lines.slice(0, range.start) : []
      const collapsedAfterLines = lines.slice(range.end + 1, ranges[index + 1]?.start ?? lines.length)
      return {
        id: `hunk-${index + 1}`,
        oldStart: visible.find(line => line.oldLine !== undefined)?.oldLine ?? 0,
        newStart: visible.find(line => line.newLine !== undefined)?.newLine ?? 0,
        lines: visible,
        collapsedBefore: collapsedBeforeLines.length,
        collapsedAfter: collapsedAfterLines.length,
        collapsedBeforeLines,
        collapsedAfterLines,
      }
    }),
  }
}

function myers(left: string[], right: string[]): Operation[] {
  const trace: Array<Map<number, number>> = []
  let frontier = new Map<number, number>([[1, 0]])
  for (let distance = 0; distance <= left.length + right.length; distance += 1) {
    trace.push(new Map(frontier))
    const next = new Map<number, number>()
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = diagonal === -distance || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
      let x = down ? frontier.get(diagonal + 1) ?? 0 : (frontier.get(diagonal - 1) ?? 0) + 1
      let y = x - diagonal
      while (x < left.length && y < right.length && left[x] === right[y]) { x += 1; y += 1 }
      next.set(diagonal, x)
      if (x >= left.length && y >= right.length) return backtrack(trace, left, right)
    }
    frontier = next
  }
  return []
}

function backtrack(trace: Array<Map<number, number>>, left: string[], right: string[]): Operation[] {
  let x = left.length; let y = right.length; const result: Operation[] = []
  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const frontier = trace[distance]!; const diagonal = x - y
    const down = diagonal === -distance || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1
    const previousX = frontier.get(previousDiagonal) ?? 0; const previousY = previousX - previousDiagonal
    while (x > previousX && y > previousY) { result.push({ type: 'context', text: left[x - 1]! }); x -= 1; y -= 1 }
    if (distance === 0) break
    if (x === previousX) { result.push({ type: 'added', text: right[y - 1]! }); y -= 1 }
    else { result.push({ type: 'removed', text: left[x - 1]! }); x -= 1 }
  }
  return result.reverse()
}
