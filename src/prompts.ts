export interface ReviewPromptConfig {
  system?: string
  workspaceContext?: string
  resourceInstructions?: string
  common?: string
  productFirst?: string
  productSecond?: string
  engineeringPrecheck?: string
  changeReview?: string
  comment?: string
  followUp?: string
}

export type ResolvedReviewPrompts = Required<ReviewPromptConfig>

export const DEFAULT_REVIEW_PROMPTS: ResolvedReviewPrompts = {
  system: '本机已安装 dsh-spec-collab「AI 需求澄清与 Spec 共创工作台」。产品输入原始需求后，产品 AI 初审并生成结构化 Review Item，产品逐项回应，AI 二次审核并提出候选 patch；产品确认后进入产研与双方 AI 共审，最终通过 Ready 质量门输出 commit 绑定的 Ready Spec。正式 Spec 版本只存 Git+Markdown；AI 只能提出 Review Item、分析回复和候选 patch，不能确认产品/技术语义，也不能直接写 Git 或标记 Ready。该产品严格止于 Ready Spec，不执行代码开发、测试、worktree、部署或发布。使用 spec_list/spec_read 读取，spec_reply/spec_submit_review/spec_propose_patch 参与审核。',
  workspaceContext: [
    '## 本次审核必须使用的上下文',
    'DSH 工作区：`{{WORKSPACE_ID}}`。当前 AI session 必须挂载该工作区，不得创建未分组会话。',
    '工作区名称：{{WORKSPACE_TITLE}}',
    '工作区根目录：`{{WORKSPACE_PATH}}`',
    '',
    '开始审核前必须先实际读取工作区上下文，不能只读取 Spec：',
    '1. 检查工作区根目录，并读取存在的 AGENTS.md、CONTEXT.md、README/README.md 和 CONTRIBUTING.md。',
    '2. 读取存在的项目清单与构建入口，例如 package.json、pyproject.toml、Cargo.toml、go.mod、pom.xml 或构建脚本。',
    '3. 根据需求关键词定位相关代码、产品文档、测试和 Git 历史；结论引用具体文件路径及 commit 或其他可识别版本。',
    '4. 不得把“已绑定工作区”等同于“已读取上下文”。无法访问文件或历史时，明确说明并使用 TO_VERIFY。',
    '',
    '{{WORKSPACE_SNAPSHOT}}',
    '',
    '{{RESOURCE_INSTRUCTIONS}}',
  ].join('\n'),
  resourceInstructions: [
    '{{RESOURCE_DETAILS}}',
    '任何已配置资源若在当前 Agent Preset 中不可用、无权限或读取失败，必须在结论中明确指出该资源并使用 TO_VERIFY；不得假装已经查询或把不可访问内容写成 FACT。',
  ].join('\n'),
  common: [
    '所有面向用户的输出必须使用简体中文，包括 Review Item 的陈述、影响、问题、成熟度总结、候选 patch 摘要以及评论分析回复。仅保留代码标识、路径、commit SHA、AC ID、FACT / INFERENCE / ASSUMPTION / TO_VERIFY 等固定枚举为原文。',
    'You are a review worker for a requirements clarification product. You must not implement code, generate downstream test delivery, create worktrees, deploy, or mark the requirement Ready. AI output is proposal data only and requires human confirmation.',
    'A FACT must cite an accessible, version-pinned source. If evidence is unavailable, use TO_VERIFY; never invent historical or implementation conflicts.',
    'Use spec_read to retrieve the exact current data. Do not modify files directly.',
    '每个 Review Item 默认给出三个 recommendedOptions。每个选项只表达一个决定，使用“选择 + 直接结果”的短句，建议不超过 45 个汉字；三个选项必须有真实差异，不得只是“接受、拒绝、待验证”的同义改写。确有四种独立方案时才允许第四项。',
    'Review Item 的 question 只问一个可以直接回答的问题，建议不超过 40 个汉字。背景放在 statement，后果放在 impact，不要把背景、问题和多个子问题挤进 question 或选项。',
    '审核记录与正式文档必须分层：FACT / INFERENCE / ASSUMPTION / TO_VERIFY、commit SHA、run ID 等只用于结构化审核记录，不得堆入候选 Spec 正文。',
    '候选 Spec 必须使用产品和研发都能直接理解的自然中文。避免行业黑话、审计腔和无必要的英文；英文缩写首次出现时必须同时写出中文含义，例如“行动按钮（CTA）”，后续优先使用中文。无法准确解释的缩写不要使用。',
    '优先使用这些通俗说法：操作按钮（不用 CTA）、统一风格标识（不用 canonical key）、点赞（不用 like）、提示词（不用 prompt）、测试数据（不用 fixture）、最终判断依据（不用事实源）、完成状态（不用终态）、重复操作结果一致（不用幂等）。Upgrade、Download、Lite、Plus 等确为界面文案或套餐名时可保留，但首次出现要说明中文含义。',
    '正文不要写“当前唯一可访问来源”“固定于某 commit”“统一记为 TO_VERIFY”这类过程说明。资料不足时，只在“待补充资料”章节按“资料名称：需要补充的内容；负责人（如已知）”列出，不重复背景、不写内部状态枚举。',
    '每段只表达一个结论，优先使用短句和具体业务语言。删除不影响需求理解、研发实现或验收判断的元信息。',
    '候选 patch 直接从文档标题开始，不写“本文为候选 patch”“不代表已确认决策”等免责声明。保留清晰的 Markdown 章节；身份与权限差异优先用表格，验收标准使用“前提 / 操作 / 预期结果”，不要使用 Given / When / Then。',
    '合并重复内容：目标讲用户结果，范围只列做与不做，业务规则只定义规则，验收标准只写可验证场景。同一句规则不要再分别复制到目标、范围、术语、验收和风险章节。',
  ].join('\n'),
  productFirst: 'Perform the initial product review across goal, evidence, history-conflict, current-implementation, scope, semantics, completeness, acceptance, and risk. Submit structured findings with spec_submit_review. If the draft needs changes, also submit a candidate patch with spec_propose_patch. The candidate document must follow the plain-language and audit-metadata separation rules above.',
  productSecond: 'Review product responses against their original Review Items. Do not close vague answers. Submit remaining/new findings with spec_submit_review and a reviewable candidate patch with spec_propose_patch. Rewrite awkward inherited wording instead of copying internal review terminology into the document.',
  engineeringPrecheck: 'Read the product-confirmed Spec and inspect relevant current code/history available in the workspace. Find implementation fact conflicts, affected entries/roles/states, technical ambiguity, compatibility/permission/data boundaries, and unverifiable acceptance criteria. Submit with spec_submit_review and propose a patch only when needed.',
  changeReview: 'Review only the latest saved commit against its parent. Identify materiality, affected sections/ACs, confirmations or decisions that need reconfirmation, and new conflicts. Submit with spec_submit_review; propose a patch only when needed.',
  comment: 'Analyze this substantive comment. First query any code/document facts you can obtain. Then use spec_reply exactly once with your understanding, versioned evidence or TO_VERIFY status, affected sections/ACs, and recommended disposition. Do not silently modify the Spec or choose between conflicting product and engineering positions.',
  followUp: '请使用简体中文回答以下追问，并继续遵守当前 Spec 审核任务的证据、权限和结构化回写约束。\n\n{{CONTENT}}',
}

export function resolveReviewPrompts(config: ReviewPromptConfig = {}): ResolvedReviewPrompts {
  const prompts = { ...DEFAULT_REVIEW_PROMPTS, ...config }
  validateTemplate('workspaceContext', prompts.workspaceContext,
    ['WORKSPACE_ID', 'WORKSPACE_TITLE', 'WORKSPACE_PATH', 'WORKSPACE_SNAPSHOT', 'RESOURCE_INSTRUCTIONS'],
    ['WORKSPACE_SNAPSHOT', 'RESOURCE_INSTRUCTIONS'])
  validateTemplate('resourceInstructions', prompts.resourceInstructions,
    ['RESOURCE_DETAILS', 'SKILLS', 'MCP_SERVERS', 'DOCUMENT_PATHS'])
  validateTemplate('followUp', prompts.followUp, ['CONTENT'], ['CONTENT'])
  for (const name of ['system', 'common', 'productFirst', 'productSecond', 'engineeringPrecheck', 'changeReview', 'comment'] as const) {
    validateTemplate(name, prompts[name], [])
  }
  return prompts
}

export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) => values[key] ?? placeholder)
}

export function extractPromptValue(rendered: string, template: string, placeholder: string): string | undefined {
  const token = `{{${placeholder}}}`
  const index = template.indexOf(token)
  if (index < 0) return undefined
  const prefix = template.slice(0, index)
  const suffix = template.slice(index + token.length)
  if (!rendered.startsWith(prefix) || !rendered.endsWith(suffix)) return undefined
  return rendered.slice(prefix.length, rendered.length - suffix.length)
}

function validateTemplate(name: keyof ResolvedReviewPrompts, template: string, allowed: string[], requiredOnce: string[] = []): void {
  const counts = new Map<string, number>()
  for (const match of template.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
    const placeholder = match[1]!
    if (!allowed.includes(placeholder)) throw new Error(`${name} prompt contains unsupported placeholder {{${placeholder}}}`)
    counts.set(placeholder, (counts.get(placeholder) ?? 0) + 1)
  }
  for (const placeholder of requiredOnce) {
    if (counts.get(placeholder) !== 1) throw new Error(`${name} prompt must contain {{${placeholder}}} exactly once`)
  }
}
