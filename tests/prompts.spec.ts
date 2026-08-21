import { describe, expect, it } from 'vitest'
import { DEFAULT_REVIEW_PROMPTS, resolveReviewPrompts } from '../src/prompts.ts'

describe('review prompt configuration', () => {
  it('keeps the current prompts as defaults and only overrides configured fields', () => {
    const prompts = resolveReviewPrompts({ common: '团队自定义审核约束。' })

    expect(prompts.common).toBe('团队自定义审核约束。')
    expect(prompts.system).toBe(DEFAULT_REVIEW_PROMPTS.system)
    expect(prompts.productSecond).toBe(DEFAULT_REVIEW_PROMPTS.productSecond)
    expect(prompts.comment).toBe(DEFAULT_REVIEW_PROMPTS.comment)
    expect(prompts.followUp).toBe(DEFAULT_REVIEW_PROMPTS.followUp)
  })

  it('requires custom follow-up prompts to preserve the user content placeholder', () => {
    expect(() => resolveReviewPrompts({ followUp: '只保留固定指令' })).toThrow('followUp prompt must contain {{CONTENT}}')
    expect(() => resolveReviewPrompts({ followUp: '{{CONTENT}} / {{CONTENT}}' })).toThrow('followUp prompt must contain {{CONTENT}} exactly once')
  })

  it('rejects unsupported or missing workspace template variables', () => {
    expect(() => resolveReviewPrompts({ workspaceContext: '{{WORKSPACE_SNAPSHOTS}} {{RESOURCE_INSTRUCTIONS}}' })).toThrow('unsupported placeholder {{WORKSPACE_SNAPSHOTS}}')
    expect(() => resolveReviewPrompts({ workspaceContext: '{{WORKSPACE_SNAPSHOT}}' })).toThrow('workspaceContext prompt must contain {{RESOURCE_INSTRUCTIONS}} exactly once')
  })
})
