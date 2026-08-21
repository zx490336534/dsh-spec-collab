import { describe, expect, it } from 'vitest'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { AiReviewRun, CommentThread, RequirementView } from '../src/protocol.ts'
import { ReviewContextCatalog } from '../src/review-context.ts'
import { DshReviewCoordinator } from '../src/review-runtime.ts'

describe('DshReviewCoordinator context mounting', () => {
  it('creates review and comment sessions with the selected workspace, preset, and merged context prompt', async () => {
    const createdWith: Array<Record<string, unknown>> = []
    const prompts: string[] = []
    let sessionNumber = 0
    const success = (value: unknown) => ({ result: { ok: true, value } })
    const api = {
      agentPresets: { list: async () => success({ presets: [{ id: 'spec-payments' }], authorable: false, hasDocument: false }) },
      workspace: { list: async () => success({ items: [{ workspaceId: 'workspace-payments', title: '支付工程', path: '/work/payments', sessionIds: [], createdAt: '', updatedAt: '' }, { workspaceId: 'workspace-growth', title: '增长工程', path: '/work/growth', sessionIds: [], createdAt: '', updatedAt: '' }], archivedSessionIds: [] }) },
      sessions: {
        create: async (request: { payload: Record<string, unknown> }) => { createdWith.push(request.payload); sessionNumber += 1; return success({ sessionId: `session-${sessionNumber}`, agentPreset: request.payload.agentPreset }) },
        rename: async () => success({ title: 'review', seq: 1 }),
        prompt: async (request: { payload: { content: Array<{ text: string }> } }) => { prompts.push(request.payload.content[0]!.text); return success({}) },
      },
    } as unknown as ApiProxy
    const contexts = new ReviewContextCatalog({
      defaultContext: { skills: ['requirements-review'], mcpServers: ['confluence'], documentPaths: ['/docs/shared'] },
      workspaces: [{ workspaceId: 'workspace-payments', skills: ['payment-domain'], mcpServers: ['payments'], documentPaths: ['/docs/payments'], agentPreset: 'spec-payments' }],
    })
    const coordinator = new DshReviewCoordinator(api, contexts)
    const requirement = { id: 'requirement-1', title: '部分退款', currentCommit: 'a'.repeat(40), workspaceId: 'workspace-payments' } as RequirementView
    const run = { id: 'run-1', kind: 'product-first' } as AiReviewRun
    const comment = { id: 'comment-1', anchor: { quote: '部分退款' }, body: '需要确认退款上限。' } as CommentThread

    expect(await coordinator.reviewWorkspaces()).toEqual([{ workspaceId: 'workspace-payments', title: '支付工程', path: '/work/payments' }, { workspaceId: 'workspace-growth', title: '增长工程', path: '/work/growth' }])
    await coordinator.requestReview({ requirement, run })
    await coordinator.requestCommentReply({ requirement, comment })

    expect(createdWith).toEqual([{ workspaceId: 'workspace-payments', agentPreset: 'spec-payments' }, { workspaceId: 'workspace-payments', agentPreset: 'spec-payments' }])
    for (const prompt of prompts) {
      expect(prompt).toContain('`requirements-review`')
      expect(prompt).toContain('`payment-domain`')
      expect(prompt).toContain('`mcp__confluence__*`')
      expect(prompt).toContain('`mcp__payments__*`')
      expect(prompt).toContain('`/docs/shared`')
      expect(prompt).toContain('`/docs/payments`')
      expect(prompt).toContain('工作区根目录：`/work/payments`')
      expect(prompt).toContain('AGENTS.md')
      expect(prompt).toContain('README')
      expect(prompt).toContain('项目清单')
      expect(prompt).toContain('必须先实际读取工作区上下文')
      expect(prompt).toContain('审核记录与正式文档必须分层')
      expect(prompt).toContain('行动按钮（CTA）')
      expect(prompt).toContain('待补充资料')
      expect(prompt).toContain('不得堆入候选 Spec 正文')
      expect(prompt).toContain('建议不超过 45 个汉字')
      expect(prompt).toContain('统一风格标识（不用 canonical key）')
      expect(prompt).toContain('前提 / 操作 / 预期结果')
      expect(prompt).toContain('合并重复内容')
    }
  })

  it('uses configured prompt overrides while preserving defaults for omitted prompts', async () => {
    const prompts: string[] = []
    const success = (value: unknown) => ({ result: { ok: true, value } })
    const api = {
      workspace: { list: async () => success({ items: [{ workspaceId: 'workspace-custom', title: '定制项目', path: '/work/custom', sessionIds: [], createdAt: '', updatedAt: '' }], archivedSessionIds: [] }) },
      sessions: {
        create: async () => success({ sessionId: 'session-custom' }),
        rename: async () => success({ title: 'review', seq: 1 }),
        prompt: async (request: { payload: { content: Array<{ text: string }> } }) => { prompts.push(request.payload.content[0]!.text); return success({}) },
        history: async () => success({
          events: [
            { event: { type: 'user/message', data: { content: [{ type: 'text', text: prompts[0] }] } } },
            { event: { type: 'user/message', data: { content: [{ type: 'text', text: prompts[1] }] } } },
            { event: { type: 'assistant/message', data: { content: [{ type: 'text', text: '已经补充。' }] } } },
          ],
          hasMore: false,
        }),
      },
    } as unknown as ApiProxy
    const coordinator = new DshReviewCoordinator(api, new ReviewContextCatalog(), {
      workspaceContext: '先读取 {{WORKSPACE_TITLE}}（{{WORKSPACE_PATH}}）\n{{WORKSPACE_SNAPSHOT}}\n{{RESOURCE_INSTRUCTIONS}}',
      resourceInstructions: '团队资源：{{SKILLS}} / {{MCP_SERVERS}} / {{DOCUMENT_PATHS}}',
      common: '使用团队定制的审核原则。',
      productFirst: '执行团队定制的产品初审。',
      followUp: '团队追问：\n{{CONTENT}}\n继续遵守团队规范。',
    })
    const requirement = { id: 'requirement-custom', title: '定制需求', currentCommit: 'b'.repeat(40), workspaceId: 'workspace-custom' } as RequirementView

    await coordinator.requestReview({ requirement, run: { id: 'run-custom', kind: 'product-first' } as AiReviewRun })
    await coordinator.followUp('session-custom', '请补充边界条件。')

    expect(prompts[0]).toContain('先读取 定制项目（/work/custom）')
    expect(prompts[0]).toContain('团队资源：未配置 / 未配置 / 未配置')
    expect(prompts[0]).toContain('使用团队定制的审核原则。')
    expect(prompts[0]).toContain('执行团队定制的产品初审。')
    expect(prompts[0]).not.toContain('Perform the initial product review')
    expect(prompts[1]).toContain('团队追问：\n请补充边界条件。\n继续遵守团队规范。')
    const reconfigured = new DshReviewCoordinator(api, new ReviewContextCatalog(), { followUp: '新的追问模板：{{CONTENT}}' })
    expect(await reconfigured.conversation('session-custom')).toEqual([
      { role: 'user', text: '请补充边界条件。' },
      { role: 'assistant', text: '已经补充。' },
    ])
  })
})
