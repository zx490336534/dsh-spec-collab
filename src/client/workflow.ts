import type { ParticipantRole, RequirementView, ReviewKind } from '../protocol.ts'

export type TaskView = 'review' | 'patches' | 'ready'
export type WorkflowCommand =
  | { kind: 'open'; view: TaskView; objectId?: string }
  | { kind: 'bind-workspace' }
  | { kind: 'request-review'; reviewKind: ReviewKind }
  | { kind: 'advance' }
  | { kind: 'confirm'; role: ParticipantRole }
  | { kind: 'generate-ready' }
  | { kind: 'none' }

export interface WorkflowState {
  eyebrow: string
  title: string
  detail: string
  actionLabel: string
  command: WorkflowCommand
  disabled?: boolean
  disabledReason?: string
}

const reviewIsOpen = (status: RequirementView['reviewItems'][number]['status']): boolean => !['resolved', 'invalidated', 'non-blocking-verify'].includes(status)

export function workflowState(requirement: RequirementView, participantRole: ParticipantRole): WorkflowState {
  const currentReviews = requirement.reviewItems.filter(item => item.commit === requirement.currentCommit)
  const blockers = currentReviews.filter(item => item.severity === 'blocking' && reviewIsOpen(item.status))
  const productBlockers = blockers.filter(item => item.status !== 'joint-review')
  const unanswered = blockers.filter(item => item.status === 'open')
  const currentPatches = requirement.patches.filter(item => item.baseCommit === requirement.currentCommit && item.status === 'pending')
  const currentRuns = requirement.aiRuns.filter(run => run.commit === requirement.currentCommit)
  const activeRun = currentRuns.slice().reverse().find(run => ['queued', 'running'].includes(run.status))
  const completed = (kind: ReviewKind): boolean => currentRuns.some(run => run.kind === kind && run.status === 'completed')
  const productConfirmed = requirement.confirmations.some(item => item.commit === requirement.currentCommit && item.role === 'product' && item.scope === 'version' && item.status === 'active')
  const engineeringConfirmed = requirement.confirmations.some(item => item.commit === requirement.currentCommit && item.role === 'engineering' && item.scope === 'version' && item.status === 'active')
  const failedChecks = requirement.readiness.filter(check => !check.passed)

  if (!requirement.workspaceId) return {
    eyebrow: '开始前', title: '关联需求所在的项目', detail: 'AI 会从这个项目读取代码、规范和团队知识，关联后不能中途切换。',
    actionLabel: '选择项目', command: { kind: 'bind-workspace' },
  }

  if (activeRun) return {
    eyebrow: 'AI 正在工作', title: activeRun.kind === 'engineering-precheck' ? '正在从研发视角检查需求' : '正在整理需求中的问题',
    detail: '结果会自动出现在这里，可以先继续编辑正文。', actionLabel: '分析中', command: { kind: 'none' }, disabled: true,
  }

  if (requirement.stage === 'product-review') {
    if (!completed('product-first')) return {
      eyebrow: '需求澄清', title: '先让 AI 找出需求缺口', detail: 'AI 会检查目标、范围、验收标准、证据和潜在风险。',
      actionLabel: '开始需求检查', command: { kind: 'request-review', reviewKind: 'product-first' },
    }
    if (unanswered.length > 0) return {
      eyebrow: '需要你的判断', title: `回答 ${unanswered.length} 个关键问题`, detail: '可以连续回答；完成最后一项后，再让 AI 回读全部结论并整理正文。',
      actionLabel: '回答下一题', command: { kind: 'open', view: 'review', objectId: unanswered[0]!.id },
    }
    if (currentPatches.length > 0) return {
      eyebrow: 'AI 已整理改动', title: `审核 ${currentPatches.length} 份正文修改`, detail: '确认改动符合你的判断后，再写入正式需求版本。',
      actionLabel: '查看改动', command: { kind: 'open', view: 'patches' },
    }
    if (productBlockers.length > 0 || !completed('product-second')) return {
      eyebrow: '人工回答已完成', title: '下一步：让 AI 回读全部回答', detail: '点击下方按钮后，AI 会重新检查正文与回答，并生成可逐项审核的正文修改。此步骤不会自动开始。',
      actionLabel: '让 AI 回读并生成修改', command: { kind: 'request-review', reviewKind: 'product-second' },
    }
    return {
      eyebrow: '产品澄清完成', title: '进入产品确认', detail: '当前版本没有产品侧阻塞问题，下一步由产品负责人确认内容。',
      actionLabel: '进入产品确认', command: { kind: 'advance' },
    }
  }

  if (requirement.stage === 'product-confirmation') {
    if (!productConfirmed) return {
      eyebrow: '产品确认', title: '确认当前需求版本', detail: participantRole === 'product' ? '确认目标、范围、业务规则和验收标准准确反映了产品决策。' : '需要一位产品角色确认当前版本后才能继续。',
      actionLabel: participantRole === 'product' ? '确认当前版本' : '等待产品确认', command: participantRole === 'product' ? { kind: 'confirm', role: 'product' } : { kind: 'none' },
      ...(participantRole === 'product' ? {} : { disabled: true, disabledReason: '当前身份是研发，需由产品角色完成确认。' }),
    }
    return {
      eyebrow: '产品已确认', title: '邀请研发共同检查', detail: '产品结论已经锁定到当前版本，可以进入研发可行性和测试约束检查。',
      actionLabel: '进入产研共审', command: { kind: 'advance' },
    }
  }

  if (requirement.stage === 'joint-review') {
    if (!completed('engineering-precheck')) return {
      eyebrow: '产研共审', title: '从研发视角检查可实施性', detail: '重点检查现有实现、影响范围、兼容性和测试落点。',
      actionLabel: '开始研发检查', command: { kind: 'request-review', reviewKind: 'engineering-precheck' },
    }
    if (unanswered.length > 0) return {
      eyebrow: '研发发现待确认项', title: `处理 ${unanswered.length} 个阻塞问题`, detail: '这些问题会影响实现或验收，需要在交付研发前明确。',
      actionLabel: '处理下一题', command: { kind: 'open', view: 'review', objectId: unanswered[0]!.id },
    }
    if (currentPatches.length > 0) return {
      eyebrow: '研发建议了改动', title: `审核 ${currentPatches.length} 份正文修改`, detail: '确认实现约束和测试条件已准确写回需求。',
      actionLabel: '查看改动', command: { kind: 'open', view: 'patches' },
    }
    if (blockers.length > 0) return {
      eyebrow: '仍有待收敛内容', title: '复核已回复的问题', detail: '已有回复尚未消除阻塞，请重新检查或让 AI 根据结论更新正文。',
      actionLabel: '查看问题', command: { kind: 'open', view: 'review', objectId: blockers[0]!.id },
    }
    if (failedChecks.length > 0) return {
      eyebrow: '交付条件未齐', title: `补齐 ${failedChecks.length} 项需求内容`, detail: '完成条件会指出正文缺少的目标、范围、验收标准或测试约束。',
      actionLabel: '查看缺少内容', command: { kind: 'open', view: 'ready' },
    }
    if (!productConfirmed) return {
      eyebrow: '等待角色确认', title: '请产品确认当前版本', detail: participantRole === 'product' ? '正文已通过检查，确认它准确反映最终产品结论。' : '需要产品角色确认同一个当前版本。',
      actionLabel: participantRole === 'product' ? '以产品身份确认' : '等待产品确认', command: participantRole === 'product' ? { kind: 'confirm', role: 'product' } : { kind: 'none' },
      ...(participantRole === 'product' ? {} : { disabled: true, disabledReason: '当前身份是研发，需由产品角色完成确认。' }),
    }
    if (!engineeringConfirmed) return {
      eyebrow: '最后一步确认', title: '请研发确认当前版本', detail: participantRole === 'engineering' ? '确认实现边界、风险和测试约束已经足够明确。' : '需要研发角色确认同一个当前版本。',
      actionLabel: participantRole === 'engineering' ? '以研发身份确认' : '等待研发确认', command: participantRole === 'engineering' ? { kind: 'confirm', role: 'engineering' } : { kind: 'none' },
      ...(participantRole === 'engineering' ? {} : { disabled: true, disabledReason: '当前身份是产品，需由研发角色完成确认。' }),
    }
    return {
      eyebrow: '可以交付研发', title: '生成就绪需求', detail: '产品和研发已确认同一个版本，所有完成条件均已通过。',
      actionLabel: '生成就绪需求', command: { kind: 'generate-ready' },
    }
  }

  return {
    eyebrow: '需求已就绪', title: '这份需求可以进入研发', detail: '正文、确认人、关键决策和待验证项已固定在同一个版本中。',
    actionLabel: '查看交付内容', command: { kind: 'open', view: 'ready' },
  }
}

export function friendlyActionError(error: string): string {
  const messages: Array<[string, string]> = [
    ['product blocking review items remain', '还有阻塞问题未处理，请先完成待澄清事项。'],
    ['product second review is required', '需要先让 AI 根据回复整理并复核正文。'],
    ['product must confirm the current version', '需要产品角色确认当前版本后才能进入产研共审。'],
    ['readiness gate is not satisfied', '需求内容还没有满足全部交付条件，请查看缺少内容。'],
    ['current version needs product and engineering confirmation', '产品和研发需要分别确认同一个当前版本。'],
    ['review workspace is required', '请选择需求所在的项目。'],
    ['human participant is required', '这项操作需要由真实参与者完成。'],
    ['role is required', '当前身份角色不能执行这项确认。'],
  ]
  return messages.find(([source]) => error.includes(source))?.[1] ?? error
}
