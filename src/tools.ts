import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { CollaborationEngine } from './engine.ts'
import type { EpistemicStatus, ParticipantRole, ParticipantSnapshot, ReviewItemStatus, ReviewItemType, ReviewKind, Severity } from './protocol.ts'

function text(value: string): ContentBlock[] { return [{ type: 'text', text: value }] }
function ai(nickname: string, role: ParticipantRole, sessionId: string): ParticipantSnapshot { return { participantId: `ai:${sessionId}`, nickname, role, kind: 'ai', sessionId } }
function contentOutput(description: string) { return { schema: { type: 'object' as const, additionalProperties: false as const, properties: { content: { type: 'string' as const, required: true as const, description } } }, render: (_args: unknown, value: { content: string }) => text(value.content) } as const }

export function specListTool(engine: CollaborationEngine) {
  return defineTool({
    name: 'spec_list', description: 'List shared collaborative requirements and their product-review, joint-review, or Ready stage. This product stops at Ready Spec.', parameters: {},
    output: contentOutput('Requirement list.'),
    async execute() { return { content: engine.list().map(item => `${item.id} | ${item.stage} | ${item.currentCommit.slice(0, 10)} | ${item.reviewItems.filter(review => review.severity === 'blocking' && review.status !== 'resolved').length} blockers | ${item.title}`).join('\n') || 'no requirements' } },
  })
}

export function specReadTool(engine: CollaborationEngine) {
  return defineTool({
    name: 'spec_read', description: 'Read one requirement at its exact current Git commit, with selected collaboration context. Use this before any review submission.',
    parameters: { requirementId: { type: 'string', required: true }, include: { type: 'array', items: { type: 'string', enum: ['spec', 'review-items', 'comments', 'decisions', 'confirmations', 'sources', 'readiness'] }, description: 'Sections to include; default includes all current context.' } },
    output: contentOutput('Pinned requirement context.'),
    async execute(args) {
      const view = engine.view(args.requirementId)
      const include = new Set(args.include ?? ['spec', 'review-items', 'comments', 'decisions', 'confirmations', 'sources', 'readiness'])
      const rows = [`# ${view.title}`, `stage: ${view.stage}`, `commit: ${view.currentCommit}`]
      if (include.has('spec')) rows.push('', '## Spec', view.version.markdown)
      if (include.has('review-items')) rows.push('', '## Review Items', ...view.reviewItems.map(item => `- ${item.id} [${item.severity}/${item.status}/${item.epistemicStatus}] ${item.statement}\n  Question: ${item.question}\n  Recommended options: ${(item.recommendedOptions ?? []).join(' / ') || 'none'}\n  Evidence: ${item.evidence.map(evidence => `${evidence.source}${evidence.version ? `@${evidence.version}` : ''}`).join(', ') || 'none'}`))
      if (include.has('comments')) rows.push('', '## Comments', ...view.comments.map(item => `- ${item.id} [${item.status}] “${item.anchor.quote}” ${item.author.nickname}: ${item.body}\n  Replies: ${item.replies.map(reply => `${reply.author.nickname}: ${reply.body}`).join(' / ') || 'none'}`))
      if (include.has('decisions')) rows.push('', '## Decisions', ...view.decisions.map(item => `- ${item.id} [${item.status}] ${item.question}: ${item.decision}`))
      if (include.has('confirmations')) rows.push('', '## Confirmations', ...view.confirmations.map(item => `- ${item.role}/${item.scope}/${item.scopeId ?? 'document'} [${item.status}] ${item.participant.nickname} @ ${item.commit}`))
      if (include.has('sources')) rows.push('', '## Sources', ...view.sources.map(item => `- ${item.id} [${item.accessStatus}] ${item.label}${item.version ? ` @ ${item.version}` : ''}`))
      if (include.has('readiness')) rows.push('', '## Readiness', ...view.readiness.map(item => `- ${item.passed ? 'PASS' : 'FAIL'} ${item.key}: ${item.reasons.join('; ')}`))
      return { content: rows.join('\n') }
    },
  })
}

export function specReplyTool(engine: CollaborationEngine) {
  return defineTool({
    name: 'spec_reply', description: 'Post the required AI analysis to one substantive Spec comment. Include understanding, evidence or TO_VERIFY, affected sections/AC IDs, and proposed disposition.',
    parameters: { requirementId: { type: 'string', required: true }, commentId: { type: 'string', required: true }, body: { type: 'string', required: true }, nickname: { type: 'string', required: true }, role: { type: 'string', required: true, enum: ['product', 'engineering'] }, sessionId: { type: 'string', required: true } },
    output: contentOutput('Reply result.'),
    async execute(args) { engine.submitAiReply({ requirementId: args.requirementId, commentId: args.commentId, ai: ai(args.nickname, args.role as ParticipantRole, args.sessionId), body: args.body }); return { content: 'AI analysis posted' } },
  })
}

export function specSubmitReviewTool(engine: CollaborationEngine) {
  return defineTool({
    name: 'spec_submit_review', description: 'Submit structured, commit-pinned AI Review Items. AI may propose findings but cannot confirm or mark Ready. FACT requires accessible versioned evidence.',
    parameters: {
      requirementId: { type: 'string', required: true }, commit: { type: 'string', required: true }, runId: { type: 'string', required: true }, reviewKind: { type: 'string', required: true, enum: ['product-first', 'product-second', 'engineering-precheck', 'change-review'] },
      nickname: { type: 'string', required: true }, role: { type: 'string', required: true, enum: ['product', 'engineering'] }, sessionId: { type: 'string', required: true }, maturitySummary: { type: 'string', required: true },
      items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        type: { type: 'string', required: true, enum: ['goal', 'evidence', 'history-conflict', 'current-implementation', 'scope', 'semantics', 'completeness', 'acceptance', 'risk'] }, severity: { type: 'string', required: true, enum: ['blocking', 'major', 'minor'] }, statement: { type: 'string', required: true }, epistemicStatus: { type: 'string', required: true, enum: ['FACT', 'INFERENCE', 'ASSUMPTION', 'TO_VERIFY'] }, impact: { type: 'string', required: true }, question: { type: 'string', required: true }, recommendedOptions: { type: 'array', required: true, items: { type: 'string' }, description: '至少三个可直接供用户选择的具体中文建议，不得只是同义改写。' }, affectedSections: { type: 'array', required: true, items: { type: 'string' } }, affectedAcceptanceIds: { type: 'array', required: true, items: { type: 'string' } }, ownerRole: { type: 'string', required: true, enum: ['product', 'engineering'] }, status: { type: 'string', required: true, enum: ['open', 'joint-review', 'non-blocking-verify'] }, evidence: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { statement: { type: 'string', required: true }, source: { type: 'string', required: true }, version: { type: 'string' }, accessible: { type: 'boolean', required: true } } } },
      } } },
    },
    output: contentOutput('Review submission result.'),
    async execute(args) {
      for (const item of args.items) {
        const options = item.recommendedOptions.map(option => option.trim()).filter(Boolean)
        if (options.length < 3 || new Set(options).size < 3) throw new Error('each review item requires at least three distinct recommended options')
        if (item.epistemicStatus === 'FACT' && !item.evidence.some(evidence => evidence.accessible && typeof evidence.version === 'string' && evidence.version !== '')) throw new Error('FACT requires accessible versioned evidence')
      }
      engine.submitReview({ requirementId: args.requirementId, commit: args.commit, runId: args.runId, ai: ai(args.nickname, args.role as ParticipantRole, args.sessionId), maturitySummary: args.maturitySummary, items: args.items.map(item => ({ type: item.type as ReviewItemType, severity: item.severity as Severity, statement: item.statement, evidence: item.evidence, epistemicStatus: item.epistemicStatus as EpistemicStatus, impact: item.impact, question: item.question, recommendedOptions: item.recommendedOptions, affectedSections: item.affectedSections, affectedAcceptanceIds: item.affectedAcceptanceIds, ownerRole: item.ownerRole as ParticipantRole, status: item.status as ReviewItemStatus })) })
      return { content: `submitted ${args.items.length} review items for ${args.commit}` }
    },
  })
}

export function specProposePatchTool(engine: CollaborationEngine) {
  return defineTool({
    name: 'spec_propose_patch', description: 'Propose a complete revised Markdown Spec against an exact base commit. This creates a reviewable candidate only; it never writes Git.',
    parameters: { requirementId: { type: 'string', required: true }, baseCommit: { type: 'string', required: true }, reviewKind: { type: 'string', required: true, enum: ['product-first', 'product-second', 'engineering-precheck', 'change-review'] }, proposedMarkdown: { type: 'string', required: true }, summary: { type: 'string', required: true }, affectedReviewItemIds: { type: 'array', required: true, items: { type: 'string' } }, affectedSections: { type: 'array', required: true, items: { type: 'string' } }, affectedAcceptanceIds: { type: 'array', required: true, items: { type: 'string' } }, nickname: { type: 'string', required: true }, role: { type: 'string', required: true, enum: ['product', 'engineering'] }, sessionId: { type: 'string', required: true } },
    output: contentOutput('Patch proposal result.'),
    async execute(args) { engine.submitPatch({ requirementId: args.requirementId, baseCommit: args.baseCommit, reviewKind: args.reviewKind as ReviewKind, ai: ai(args.nickname, args.role as ParticipantRole, args.sessionId), proposedMarkdown: args.proposedMarkdown, summary: args.summary, affectedReviewItemIds: args.affectedReviewItemIds, affectedSections: args.affectedSections, affectedAcceptanceIds: args.affectedAcceptanceIds }); return { content: `candidate patch proposed for ${args.baseCommit}` } },
  })
}

export function allSpecTools(engine: CollaborationEngine) { return [specListTool(engine), specReadTool(engine), specReplyTool(engine), specSubmitReviewTool(engine), specProposePatchTool(engine)] }
