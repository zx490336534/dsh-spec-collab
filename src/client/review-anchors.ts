import MarkdownIt from 'markdown-it'
import type { ReviewItem } from '../protocol.ts'

const parser = new MarkdownIt({ html: false })
export const reviewBlockSelector = 'h1, h2, h3, h4, p, li, td, th, blockquote'

export interface ReviewSourceSnippet {
  key: string
  label: string
  markdown: string
  line?: number
}

export interface ReviewAnchorTerm {
  kind: 'quote' | 'acceptance' | 'section'
  label: string
  value: string
}

export function normalizeReviewText(value: string): string {
  return value.replace(/[`*_>#\[\]()~-]/g, '').replace(/\s+/g, '').toLocaleLowerCase()
}

export function reviewAnchorTerms(item: ReviewItem): ReviewAnchorTerm[] {
  const terms: ReviewAnchorTerm[] = []
  for (const anchor of item.sourceAnchors ?? []) {
    if (anchor.quote.trim()) terms.push({ kind: 'quote', label: anchor.heading?.trim() || '正文引用', value: anchor.quote.trim() })
  }
  for (const id of item.affectedAcceptanceIds) if (id.trim()) terms.push({ kind: 'acceptance', label: id.trim(), value: id.trim() })
  for (const section of item.affectedSections) if (section.trim()) terms.push({ kind: 'section', label: section.trim(), value: section.trim() })
  return terms
}

export function reviewTargetElements(root: HTMLElement, item: ReviewItem): HTMLElement[] {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(reviewBlockSelector))
  const targets: HTMLElement[] = []
  for (const term of reviewAnchorTerms(item)) {
    const candidates = (term.kind === 'section' ? blocks.filter(block => /^H[1-4]$/.test(block.tagName)) : blocks)
      .filter(block => normalizeReviewText(block.textContent ?? '').includes(normalizeReviewText(term.value)))
      .sort((left, right) => (left.textContent?.length ?? 0) - (right.textContent?.length ?? 0))
    const target = candidates[0]
    if (target && !targets.includes(target)) targets.push(target)
  }
  return targets
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

  for (const [index, anchor] of (item.sourceAnchors ?? []).entries()) {
    const quote = anchor.quote.trim()
    if (!quote || !normalizeReviewText(markdown).includes(normalizeReviewText(quote))) continue
    const exactLine = lines.findIndex(line => normalizeReviewText(line).includes(normalizeReviewText(quote)))
    add({ key: `quote-${index}`, label: anchor.heading?.trim() || '正文引用', markdown: quote, ...(exactLine < 0 ? {} : { line: exactLine + 1 }) })
  }

  for (const acceptanceId of item.affectedAcceptanceIds) {
    const token = tokens.find(candidate => candidate.type === 'inline' && candidate.map && normalizeReviewText(candidate.content).includes(normalizeReviewText(acceptanceId)))
    if (!token?.map) continue
    const [start, end] = token.map
    add({ key: `acceptance-${acceptanceId}`, label: acceptanceId, markdown: lines.slice(start, end).join('\n').trim(), line: start + 1 })
  }

  if (snippets.length === 0) {
    for (const section of item.affectedSections) {
      const headingIndex = tokens.findIndex((token, index) => token.type === 'heading_open' && tokens[index + 1]?.type === 'inline' && normalizeReviewText(tokens[index + 1]!.content).includes(normalizeReviewText(section)))
      const heading = tokens[headingIndex]
      if (headingIndex < 0 || !heading?.map) continue
      const level = Number(heading.tag.slice(1))
      const nextHeading = tokens.slice(headingIndex + 1).find(token => token.type === 'heading_open' && Number(token.tag.slice(1)) <= level && token.map)
      const start = heading.map[0]
      const end = Math.min(nextHeading?.map?.[0] ?? lines.length, start + 9)
      add({ key: `section-${section}`, label: section, markdown: lines.slice(start, end).join('\n').trim(), line: start + 1 })
    }
  }

  return snippets
}
