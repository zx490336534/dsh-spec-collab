import { describe, expect, it } from 'vitest'
import { ReviewContextCatalog, reviewContextPrompt } from '../src/review-context.ts'

describe('ReviewContextCatalog', () => {
  it('merges default and selected group resources without duplicates', () => {
    const catalog = new ReviewContextCatalog({
      defaultContext: {
        skills: ['requirements-review', 'shared-domain'],
        mcpServers: ['confluence'],
        documentPaths: ['/docs/company-rules.md'],
        agentPreset: 'spec-default',
      },
      workspaces: [{
        workspaceId: 'workspace-payments',
        skills: ['shared-domain', 'payment-domain'],
        mcpServers: ['confluence', 'payments'],
        documentPaths: ['/docs/company-rules.md', '/docs/payments', 'docs/domain.md'],
        agentPreset: 'spec-payments',
      }],
    })

    expect(catalog.resolve('workspace-payments')).toEqual({
      workspaceId: 'workspace-payments',
      skills: ['requirements-review', 'shared-domain', 'payment-domain'],
      mcpServers: ['confluence', 'payments'],
      documentPaths: ['/docs/company-rules.md', '/docs/payments', 'docs/domain.md'],
      agentPreset: 'spec-payments',
    })
    expect(catalog.workspaceIds()).toEqual(['workspace-payments'])
  })

  it('rejects a missing workspace and applies defaults to an unconfigured workspace', () => {
    const catalog = new ReviewContextCatalog({ workspaces: [{ workspaceId: 'workspace-payments' }] })
    expect(() => catalog.resolve()).toThrow('review workspace is required')
    expect(catalog.resolve('workspace-growth')).toEqual({ workspaceId: 'workspace-growth', skills: [], mcpServers: [], documentPaths: [] })
  })

  it('renders actionable Skill, MCP, and local document instructions', () => {
    const prompt = reviewContextPrompt({
      workspaceId: 'workspace-payments', skills: ['payment-domain'], mcpServers: ['confluence'], documentPaths: ['/docs/payments'],
    })
    expect(prompt).toContain('先调用 skill 工具加载 `payment-domain`')
    expect(prompt).toContain('`mcp__confluence__*`')
    expect(prompt).toContain('`/docs/payments`')
    expect(prompt).toContain('TO_VERIFY')
  })
})
