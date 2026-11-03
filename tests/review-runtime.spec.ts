import { describe, expect, it } from 'vitest'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import type { DshReviewHost } from '../src/review-runtime.ts'
import type { AiReviewRun, CommentThread, RequirementView } from '../src/protocol.ts'
import { ReviewContextCatalog } from '../src/review-context.ts'
import { DshReviewCoordinator } from '../src/review-runtime.ts'

describe('DshReviewCoordinator context mounting', () => {
  it('reuses one session within a stage and starts a new session after advancing', async () => {
    const createdWith: Array<Record<string, unknown>> = []
    const prompts: string[] = []
    let sessionNumber = 0
    const requestIds: string[] = []
    const api = {
      agentPresets: { list: async () => [{ id: 'spec-payments' }] },
      workspaceRegistry: { list: () => [{ id: 'workspace-payments', title: '支付工程', path: '/work/payments' }, { id: 'workspace-growth', title: '增长工程', path: '/work/growth' }] },
      sessionController: {
        create: async (request: Record<string, unknown>) => { createdWith.push(request); sessionNumber += 1; return { sessionId: `session-${sessionNumber}`, agentPreset: request.agentPreset } },
        rename: async () => ({ title: 'review', seq: 1 }),
        prompt: async (request: SessionPromptRequest, signal: AbortSignal) => {
          expect(signal.aborted).toBe(false)
          expect(request.mode).toBe('queue')
          expect(request.content[0]?.type).toBe('text')
          requestIds.push(request.requestId)
          prompts.push((request.content[0] as { text: string }).text)
          return { accepted: true }
        },
      },
    } as unknown as DshReviewHost
    const contexts = new ReviewContextCatalog({
      defaultContext: { skills: ['requirements-review'], mcpServers: ['confluence'], documentPaths: ['/docs/shared'] },
      workspaces: [{ workspaceId: 'workspace-payments', skills: ['payment-domain'], mcpServers: ['payments'], documentPaths: ['/docs/payments'], agentPreset: 'spec-payments' }],
    })
    const coordinator = new DshReviewCoordinator(api, contexts)
    const requirement = { id: 'requirement-1', title: '部分退款', stage: 'product-review', stageCycle: 0, currentCommit: 'a'.repeat(40), workspaceId: 'workspace-payments' } as RequirementView
    const run = { id: 'run-1', kind: 'product-first' } as AiReviewRun
    const comment = { id: 'comment-1', anchor: { quote: '部分退款' }, body: '需要确认退款上限。' } as CommentThread

    expect(await coordinator.reviewWorkspaces()).toEqual([{ workspaceId: 'workspace-payments', title: '支付工程', path: '/work/payments' }, { workspaceId: 'workspace-growth', title: '增长工程', path: '/work/growth' }])
    await coordinator.requestReview({ requirement, run })
    await coordinator.requestCommentReply({ requirement, comment })

    expect(createdWith).toEqual([{ workspaceId: 'workspace-payments', agentPreset: 'spec-payments' }])
    expect(prompts).toHaveLength(2)
    expect(requestIds).toHaveLength(2)
    expect(new Set(requestIds).size).toBe(2)
    expect(requestIds.every(id => id.startsWith('spec-collab-'))).toBe(true)
    expect(prompts[0]).toContain('`requirements-review`')
    expect(prompts[0]).toContain('`payment-domain`')
    expect(prompts[0]).toContain('`mcp__confluence__*`')
    expect(prompts[0]).toContain('`mcp__payments__*`')
    expect(prompts[0]).toContain('`/docs/shared`')
    expect(prompts[0]).toContain('`/docs/payments`')
    expect(prompts[0]).toContain('工作区根目录：`/work/payments`')
    expect(prompts[0]).toContain('AGENTS.md')
    expect(prompts[0]).toContain('README')
    expect(prompts[0]).toContain('项目清单')
    expect(prompts[0]).toContain('必须先实际读取工作区上下文')
    expect(prompts[0]).toContain('审核记录与正式文档必须分层')
    expect(prompts[0]).toContain('行动按钮（CTA）')
    expect(prompts[0]).toContain('待补充资料')
    expect(prompts[0]).toContain('不得堆入候选 Spec 正文')
    expect(prompts[0]).toContain('建议不超过 45 个汉字')
    expect(prompts[0]).toContain('统一风格标识（不用 canonical key）')
    expect(prompts[0]).toContain('前提 / 操作 / 预期结果')
    expect(prompts[0]).toContain('合并重复内容')
    expect(prompts[1]).toContain('Comment ID: comment-1')
    expect(prompts[1]).toContain('不要重新扫描整个工作区')
    expect(prompts[1]).not.toContain('工作区根目录')
    expect(prompts[1]).not.toContain('项目清单')

    await coordinator.requestReview({ requirement: { ...requirement, stage: 'product-confirmation', stageCycle: 1 }, run })
    expect(createdWith).toHaveLength(2)
  })

  it('propagates host errors and cancels pending calls when the plugin is disposed', async () => {
    const hostError = new Error('session/model-unavailable')
    let signal: AbortSignal | undefined
    const api = {
      sessionController: {
        prompt: async (_request: SessionPromptRequest, currentSignal: AbortSignal) => {
          signal = currentSignal
          currentSignal.throwIfAborted()
          throw hostError
        },
      },
    } as unknown as DshReviewHost
    const coordinator = new DshReviewCoordinator(api)
    await expect(coordinator.followUp('session-failed', '继续审核')).rejects.toBe(hostError)
    expect(signal?.aborted).toBe(false)
    coordinator.dispose()
    expect(signal?.aborted).toBe(true)
    await expect(coordinator.followUp('session-failed', '继续审核')).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uses configured prompt overrides while preserving defaults for omitted prompts', async () => {
    const prompts: string[] = []
    const api = {
      workspaceRegistry: { list: () => [{ id: 'workspace-custom', title: '定制项目', path: '/work/custom' }] },
      sessionController: {
        create: async () => ({ sessionId: 'session-custom' }),
        rename: async () => ({ title: 'review', seq: 1 }),
        prompt: async (request: { content: Array<{ text: string }> }) => { prompts.push(request.content[0]!.text); return { accepted: true } },
        inspect: async (sessionId: string, signal: AbortSignal) => {
          expect(sessionId).toBe('session-custom')
          expect(signal.aborted).toBe(false)
          return {
            events: [
              { type: 'user/message', data: { content: [{ type: 'text', text: prompts[0] }] } },
              { type: 'user/message', data: { message: { content: [{ type: 'text', text: prompts[1] }] } } },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已经补充。' }] } } },
            ],
          }
        },
      },
    } as unknown as DshReviewHost
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
