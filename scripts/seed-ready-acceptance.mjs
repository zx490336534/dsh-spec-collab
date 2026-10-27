import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { CollaborationEngine } from '../src/engine.ts'
import { GitRequirementStore } from '../src/git-store.ts'

// Run with Node 24: node --experimental-transform-types scripts/seed-ready-acceptance.mjs <temporary-root>
// Product reviews below are SYNTHETIC setup. Only subsequently captured DSH calls prove real AI work.
const root = realpathSync(resolve(process.argv[2] ?? '.'))
if (!basename(root).startsWith('dsh-ready-live-') || !existsSync(join(root, 'dsh-home'))) throw new Error('explicit isolated dsh-ready-live-* root required')
if (existsSync(join(root, 'data/collaboration-v3.json'))) throw new Error('refusing to overwrite an existing acceptance ledger')
const project = join(root, 'project')
if (existsSync(join(project, '.git')) || existsSync(join(project, 'README.md')) || existsSync(join(project, 'src/submission.ts'))) throw new Error('refusing to overwrite an existing project fixture')
mkdirSync(join(project, 'src'), { recursive: true })
writeFileSync(join(project, 'README.md'), '# Ready 准入隔离验收项目\n\n这是可丢弃的验收 fixture，产品边界止于 Ready Spec。\n现有提交实现的自动重试预算为 0；本次需求拟改为最多重试 2 次。审核时应区分现有事实与未来需求。\n源码位于 src/submission.ts，不需要访问其他工作区。\n')
writeFileSync(join(project, 'src/submission.ts'), 'export const existingRetryBudget = 0\nexport const timeoutCode = "GATEWAY_TIMEOUT"\n')
for (const command of [['init'], ['add', 'README.md', 'src/submission.ts'], ['-c', 'user.name=Ready Acceptance', '-c', 'user.email=ready-acceptance@local.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Seed isolated review evidence']]) execFileSync('git', command, { cwd: project, stdio: 'pipe' })
const evidenceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim()
const workspaceId = randomUUID()
const home = join(root, 'dsh-home')
mkdirSync(join(home, 'storages'), { recursive: true })
const now = new Date().toISOString()
writeFileSync(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [] }, tables: { workspaces: { [workspaceId]: { path: project, title: 'Ready 准入隔离验收', sessionIds: [], createdAt: now, updatedAt: now } } } }, null, 2))
const product = { participantId: 'live-ready-product', nickname: '验收产品', role: 'product', kind: 'human' }
const engineering = { participantId: 'live-ready-engineering', nickname: '验收研发', role: 'engineering', kind: 'human' }
const syntheticAi = { participantId: 'ai:synthetic-setup', nickname: '合成前置审核', role: 'product', kind: 'ai', sessionId: 'synthetic-setup' }
const engine = new CollaborationEngine(join(root, 'data/collaboration-v3.json'), new GitRequirementStore(join(root, 'data/repository')))
engine.setCoordinator({ requestReview: async () => 'synthetic-setup', requestCommentReply: async () => 'synthetic-setup' })
const apply = action => { const result = engine.apply(randomUUID(), action); if (!result.ok) throw new Error(result.error); return result.requirement }
const created = apply({ kind: 'requirement.create', participant: product, title: '隔离验收：超时重试需求', rawRequirement: '用户提交遇到网关超时后最多自动重试两次，并得到明确最终状态。', sources: [{ id: 'fixture-code', sourceType: 'code-scope', label: '隔离项目现有重试预算', stableId: 'src/submission.ts', version: evidenceCommit, accessStatus: 'available' }], workspaceId })
await Promise.resolve()
const markdown = `# 隔离验收：超时重试需求

## 原始需求与来源

用户提交遇到网关超时后最多自动重试两次，并得到明确最终状态。原始需求为本次隔离验收准备。

## 目标与用户结果

提交遇到短暂网关超时时自动尝试恢复，并向用户返回明确成功或失败结果。

## 范围与非范围

范围为提交接口收到 GATEWAY_TIMEOUT 的重试行为；非范围为结算、鉴权、支付渠道及其他错误类型。

## 业务术语与规则

首次提交不计入重试次数，最多额外重试两次，仅适用于 GATEWAY_TIMEOUT。最终结果返回成功或明确失败，避免重复提交。
现有实现的自动重试预算为 0；最多额外重试两次属于本次拟新增的需求，尚未实现。

## 需求与验收标准

- **AC-RETRY-001**：前提：网关连续超时；操作：提交一次；预期结果：首次请求后最多额外重试两次，然后显示明确失败。
- **AC-RETRY-002**：前提：首次超时后下一次提交成功；操作：提交一次；预期结果：重试成功后停止请求并显示成功。

## 测试约束

使用隔离的本地网关 fixture 控制超时和成功次数；仅用验收账号，不连接生产支付渠道，不把实现和测试执行状态写成已完成。
`
const saved = apply({ kind: 'version.save', participant: product, requirementId: created.id, baseCommit: created.currentCommit, markdown, summary: '合成前置：补齐结构化 Ready 正文' })
apply({ kind: 'review.request', participant: product, requirementId: created.id, reviewKind: 'product-first' })
apply({ kind: 'review.request', participant: product, requirementId: created.id, reviewKind: 'product-second' })
await Promise.resolve()
for (const run of engine.view(created.id).aiRuns.filter(run => run.commit === saved.currentCommit)) engine.submitReview({ requirementId: created.id, commit: run.commit, runId: run.id, ai: syntheticAi, items: [], maturitySummary: '合成测试前置审核，不代表真实模型已执行。' })
apply({ kind: 'stage.advance', participant: product, requirementId: created.id })
apply({ kind: 'confirmation.create', participant: product, requirementId: created.id, role: 'product', scope: 'version' })
apply({ kind: 'stage.advance', participant: product, requirementId: created.id })
apply({ kind: 'confirmation.create', participant: engineering, requirementId: created.id, role: 'engineering', scope: 'version' })
const result = { root, workspaceId, requirementId: created.id, commit: saved.currentCommit, evidenceCommit, product, engineering, syntheticSetup: true, syntheticReviews: ['product-first', 'product-second', 'change-review'], realEngineeringPrecheck: 'not-yet-requested' }
writeFileSync(join(root, 'seed.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
