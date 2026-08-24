import MarkdownIt from 'markdown-it'
import type { CommentThread, ReviewItem } from '../protocol.ts'

const parser = new MarkdownIt({ html: false })
export const reviewBlockSelector = 'h1, h2, h3, h4, p, li, td, th, blockquote'

export interface ReviewSourceSnippet {
  key: string
  targetKey: string
  label: string
  markdown: string
  line?: number
}

export interface ReviewAnchorTerm {
  key: string
  kind: 'quote' | 'acceptance' | 'section'
  label: string
  value: string
}

export function normalizeReviewText(value: string): string {
  return value.replace(/[`*_>#\[\]()~-]/g, '').replace(/\s+/g, '').toLocaleLowerCase()
}

export function reviewAnchorTerms(item: ReviewItem): ReviewAnchorTerm[] {
  const terms: ReviewAnchorTerm[] = []
  for (const [index, anchor] of (item.sourceAnchors ?? []).entries()) {
    const quote = anchor.quote.trim()
    if (quote) terms.push({ key: `quote-${index}`, kind: 'quote', label: anchor.heading?.trim() || '正文引用', value: quote })
  }
  for (const [index, id] of item.affectedAcceptanceIds.entries()) {
    const value = id.trim()
    if (value) terms.push({ key: `acceptance-${index}-${value}`, kind: 'acceptance', label: value, value })
  }
  for (const [index, section] of item.affectedSections.entries()) {
    const value = section.trim()
    if (value) terms.push({ key: `section-${index}-${value}`, kind: 'section', label: value, value })
  }
  return terms
}

export function reviewTargetElements(root: HTMLElement, item: ReviewItem, targetKey?: string): HTMLElement[] {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(reviewBlockSelector))
  const terms = reviewAnchorTerms(item)
  const targets: HTMLElement[] = []
  const addTermTarget = (term: ReviewAnchorTerm): void => {
    const candidates = (term.kind === 'section' ? blocks.filter(block => /^H[1-4]$/.test(block.tagName)) : blocks)
      .filter(block => normalizeReviewText(block.textContent ?? '').includes(normalizeReviewText(term.value)))
      .sort((left, right) => (left.textContent?.length ?? 0) - (right.textContent?.length ?? 0))
    const target = candidates[0]
    if (target && !targets.includes(target)) targets.push(target)
  }
  if (targetKey) {
    terms.filter(term => term.key === targetKey).forEach(addTermTarget)
    if (targets.length > 0) return targets
  }
  terms.forEach(addTermTarget)
  return targets
}

function previousHeadingText(root: HTMLElement, block: HTMLElement): string {
  const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4'))
  return headings.filter(heading => Boolean(heading.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1)?.textContent?.trim() ?? ''
}

export function commentTargetElements(root: HTMLElement, anchor: CommentThread['anchor']): HTMLElement[] {
  if (anchor === undefined) return []
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(reviewBlockSelector))
  const quote = anchor.quote.trim()
  const normalizedQuote = normalizeReviewText(quote)
  const heading = normalizeReviewText(anchor.heading ?? '')
  const prefix = normalizeReviewText(anchor.prefix ?? '')
  const suffix = normalizeReviewText(anchor.suffix ?? '')
  const context = normalizeReviewText(`${anchor.prefix ?? ''}${quote}${anchor.suffix ?? ''}`)
  const candidates = normalizedQuote
    ? blocks.filter(block => normalizeReviewText(block.textContent ?? '').includes(normalizedQuote))
    : []

  const score = (block: HTMLElement): number => {
    const text = normalizeReviewText(block.textContent ?? '')
    let value = block.textContent?.length ?? 0
    if (heading) value += normalizeReviewText(previousHeadingText(root, block)).includes(heading) ? -10000 : 2500
    if (context && text.includes(context)) value -= 3000
    if (prefix && text.includes(prefix.slice(Math.max(0, prefix.length - 32)))) value -= 900
    if (suffix && text.includes(suffix.slice(0, 32))) value -= 900
    return value
  }

  const targets = candidates.sort((left, right) => score(left) - score(right))
  if (targets.length > 0) return targets
  if (!heading) return []
  return blocks.filter(block => /^H[1-4]$/.test(block.tagName) && normalizeReviewText(block.textContent ?? '').includes(heading))
}

export function reviewSourceSnippets(markdown: string, item: ReviewItem): ReviewSourceSnippet[] {
  const lines = markdown.split('\n')
  const tokens = parser.parse(markdown, {})
  const snippets: ReviewSourceSnippet[] = []
  const seen = new Set<string>()
  const add = (snippet: ReviewSourceSnippet): void => {
    const key = normalizeReviewText(snippet.markdown)
    if (!key || seen.has(key) || snippets.length >= 4) return
    seen.add(key)
    snippets.push(snippet)
  }

  for (const term of reviewAnchorTerms(item).filter(term => term.kind === 'quote')) {
    if (!normalizeReviewText(markdown).includes(normalizeReviewText(term.value))) continue
    const exactLine = lines.findIndex(line => normalizeReviewText(line).includes(normalizeReviewText(term.value)))
    add({ key: term.key, targetKey: term.key, label: term.label, markdown: term.value, ...(exactLine < 0 ? {} : { line: exactLine + 1 }) })
  }

  for (const term of reviewAnchorTerms(item).filter(term => term.kind === 'acceptance')) {
    const token = tokens.find(candidate => candidate.type === 'inline' && candidate.map && normalizeReviewText(candidate.content).includes(normalizeReviewText(term.value)))
    if (!token?.map) continue
    const [start, end] = token.map
    add({ key: term.key, targetKey: term.key, label: term.label, markdown: lines.slice(start, end).join('\n').trim(), line: start + 1 })
  }

  if (snippets.length === 0) {
    for (const term of reviewAnchorTerms(item).filter(term => term.kind === 'section')) {
      const headingIndex = tokens.findIndex((token, index) => token.type === 'heading_open' && tokens[index + 1]?.type === 'inline' && normalizeReviewText(tokens[index + 1]!.content).includes(normalizeReviewText(term.value)))
      const heading = tokens[headingIndex]
      if (headingIndex < 0 || !heading?.map) continue
      const level = Number(heading.tag.slice(1))
      const nextHeading = tokens.slice(headingIndex + 1).find(token => token.type === 'heading_open' && Number(token.tag.slice(1)) <= level && token.map)
      const start = heading.map[0]
      const end = Math.min(nextHeading?.map?.[0] ?? lines.length, start + 9)
      add({ key: term.key, targetKey: term.key, label: term.label, markdown: lines.slice(start, end).join('\n').trim(), line: start + 1 })
    }
  }

  return snippets
}
