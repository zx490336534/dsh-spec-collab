import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const value = name => {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`required argument: ${name}`)
  return args[index + 1]
}
const url = new URL(value('--url'))
assert.equal(url.hostname, '127.0.0.1')
const root = resolve(value('--root'))
assert.ok(basename(root).startsWith('dsh-ready-live-'))
const output = resolve(value('--output'))
const phase = value('--phase')
const seed = JSON.parse(readFileSync(join(root, 'seed.json'), 'utf8'))
mkdirSync(output, { recursive: true })
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const log = (operation, data) => appendFileSync(join(output, 'operations.jsonl'), JSON.stringify({ at: new Date().toISOString(), operation, ...data }) + '\n')
async function state(label) {
  const response = await fetch(new URL(`/api/spec-collab/state?requirementId=${encodeURIComponent(seed.requirementId)}`, url))
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.requirement?.workspaceId, seed.workspaceId)
  assert.equal(data.requirements.length, 1)
  writeFileSync(join(output, `${label}.json`), JSON.stringify(data, null, 2) + '\n')
  return data.requirement
}
async function action(body) {
  const requestId = randomUUID()
  const response = await fetch(new URL('/api/spec-collab/action', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, action: { requirementId: seed.requirementId, ...body } }) })
  const data = await response.json()
  log(body.kind, { requestId, action: body, httpStatus: response.status, result: data })
  return { response, data }
}
if (phase === 'request') {
  const initial = await state('initial')
  assert.equal(initial.stage, 'joint-review')
  assert.ok(initial.readiness.every(check => check.passed))
  assert.ok(!initial.aiRuns.some(run => run.commit === initial.currentCommit && run.kind === 'engineering-precheck'))
  const denied = await action({ kind: 'ready.generate', participant: seed.product })
  assert.equal(denied.response.status, 400)
  assert.equal(denied.data.error, 'engineering precheck is required for the current version')
  const requested = await action({ kind: 'review.request', participant: seed.engineering, reviewKind: 'engineering-precheck' })
  assert.equal(requested.response.status, 200)
  const hashes = Object.fromEntries(['lib/index.js', 'lib/client.js', 'src/engine.ts', 'src/ready-admission.ts'].map(path => [path, createHash('sha256').update(readFileSync(join(repo, path))).digest('hex')]))
  writeFileSync(join(output, 'metadata.json'), JSON.stringify({ url: url.origin, startedAt: new Date().toISOString(), ...seed, hashes, setupEvidence: 'synthetic product reviews and confirmations; engineering precheck requested through real DSH HTTP route' }, null, 2) + '\n')
  writeFileSync(join(output, 'fixture-source.ts'), readFileSync(join(root, 'project/src/submission.ts')))
  writeFileSync(join(output, 'fixture-README.md'), readFileSync(join(root, 'project/README.md')))
  console.log({ phase, missingPrecheck: denied.data, request: requested.data.ok })
} else if (phase === 'observe') {
  const view = await state('observed')
  console.log(JSON.stringify({ stage: view.stage, commit: view.currentCommit, runs: view.aiRuns.filter(run => run.commit === view.currentCommit), items: view.reviewItems, patches: view.patches.map(patch => ({ id: patch.id, status: patch.status, summary: patch.summary })) }, null, 2))
} else if (phase === 'running') {
  const view = await state('review-running')
  if (!view.aiRuns.some(run => run.commit === view.currentCommit && ['queued', 'running'].includes(run.status))) {
    console.log({ phase, observed: false, reason: 'review already settled' })
  } else {
    const denied = await action({ kind: 'ready.generate', participant: seed.product })
    assert.equal(denied.response.status, 400)
    assert.equal(denied.data.error, 'current version review is still running')
    console.log({ phase, observed: true, error: denied.data.error })
  }
} else if (phase === 'retry') {
  const view = await state('real-precheck-failed')
  assert.ok(view.aiRuns.some(run => run.commit === view.currentCommit && run.kind === 'engineering-precheck' && run.status === 'failed'))
  const denied = await action({ kind: 'ready.generate', participant: seed.product })
  assert.equal(denied.response.status, 400)
  assert.equal(denied.data.error, 'engineering precheck is required for the current version')
  const retried = await action({ kind: 'review.request', participant: seed.engineering, reviewKind: 'engineering-precheck' })
  assert.equal(retried.response.status, 200)
  console.log({ phase, failedPrecheckDenied: denied.data.error, retryAccepted: retried.data.ok })
} else if (phase === 'refine') {
  const view = await state('first-real-review')
  assert.ok(view.reviewItems.some(item => item.commit === view.currentCommit && item.severity === 'blocking'))
  const denied = await action({ kind: 'ready.generate', participant: seed.product })
  assert.equal(denied.response.status, 400)
  assert.equal(denied.data.error, 'readiness gate is not satisfied')
  for (const item of view.reviewItems.filter(item => item.commit === view.currentCommit)) {
    const responded = await action({ kind: 'review.respond', participant: item.ownerRole === 'engineering' ? seed.engineering : seed.product, reviewItemId: item.id, disposition: 'accept-modified', body: '隔离验收选择：同一 submissionId 的服务端幂等结果；连续超时固定两次额外重试，每次 1000ms、整体 3000ms；网络无法确认结果时保留原标识并显示待确认，手动查询权威结果。具体规则和 AC 将写入新版本，等待重新审核及双方确认。此选择仅用于可丢弃验收数据。' })
    assert.equal(responded.response.status, 200)
  }
  const saved = await action({ kind: 'version.save', participant: seed.product, baseCommit: view.currentCommit, markdown: readFileSync(join(output, 'refined-spec.md'), 'utf8'), summary: '隔离验收：补齐真实预审发现的幂等、等待边界与结果语义' })
  assert.equal(saved.response.status, 200)
  assert.ok(saved.data.requirement.confirmations.every(item => item.status === 'invalidated'))
  const decision = await action({ kind: 'decision.create', participant: seed.product, question: '隔离需求如何处理超时重复操作与等待边界？', options: ['同标识幂等与固定次数重试', '先查询后重试', '暂缓自动重试'], decision: '选择同 submissionId 幂等；持续超时固定额外两次，每次 1000ms、整体 3000ms；无法确认时保留原标识待手动查询。', rationale: '验收数据需要可判定的重复记录、次数、时限和迟到响应规则，不能把网络超时当作业务失败。此决策仅用于隔离验收。', affectedSections: ['业务术语与规则', '需求与验收标准'], affectedAcceptanceIds: ['AC-RETRY-001', 'AC-RETRY-002', 'AC-RETRY-003', 'AC-RETRY-004', 'AC-RETRY-005', 'AC-RETRY-006'] })
  assert.equal(decision.response.status, 200)
  const requested = await action({ kind: 'review.request', participant: seed.engineering, reviewKind: 'engineering-precheck' })
  assert.equal(requested.response.status, 200)
  await state('refinement-requested')
  console.log({ phase, blockerDenied: true, newCommit: saved.data.requirement.currentCommit, confirmationsInvalidated: true, reviewRequested: true })
} else if (phase === 'generate') {
  const view = await state('review-completed')
  assert.ok(view.aiRuns.some(run => run.commit === view.currentCommit && run.kind === 'engineering-precheck' && run.status === 'completed'))
  assert.ok(view.readiness.every(check => check.passed), 'real review blockers must be resolved before confirmation')
  for (const participant of [seed.product, seed.engineering]) {
    if (!view.confirmations.some(item => item.commit === view.currentCommit && item.role === participant.role && item.scope === 'version' && item.status === 'active')) {
      const confirmed = await action({ kind: 'confirmation.create', participant, role: participant.role, scope: 'version' })
      assert.equal(confirmed.response.status, 200)
    }
  }
  const generated = await action({ kind: 'ready.generate', participant: seed.product })
  assert.equal(generated.response.status, 200, JSON.stringify(generated.data))
  assert.equal(generated.data.requirement.readyPackage.commit, view.currentCommit)
  writeFileSync(join(output, 'Ready.md'), generated.data.requirement.readyPackage.markdown)
  await state('ready')
  console.log({ phase, httpStatus: generated.response.status, commit: view.currentCommit, packageHash: generated.data.requirement.readyPackage.packageHash })
} else if (phase === 'change') {
  const view = await state('before-change')
  assert.equal(view.stage, 'ready')
  const changed = await action({ kind: 'version.save', participant: seed.product, baseCommit: view.currentCommit, markdown: `${view.version.markdown}\n## 验收备注\n\n本版本增加交付备注，用于核验旧 commit 的审核与确认不会证明新版本已就绪。\n`, summary: '隔离验收：修改正文以检查证据过期' })
  assert.equal(changed.response.status, 200)
  assert.equal(changed.data.requirement.stage, 'joint-review')
  assert.equal(changed.data.requirement.readyPackage, undefined)
  assert.ok(changed.data.requirement.confirmations.filter(item => item.scope === 'version').every(item => item.status === 'invalidated'))
  const denied = await action({ kind: 'ready.generate', participant: seed.product })
  assert.equal(denied.response.status, 400)
  await state('changed')
  console.log({ phase, oldCommit: view.currentCommit, currentCommit: changed.data.requirement.currentCommit, error: denied.data.error })
} else if (phase === 'stale-precheck') {
  const view = await state('change-reviewed')
  assert.ok(!view.aiRuns.some(run => run.commit === view.currentCommit && ['queued', 'running'].includes(run.status)))
  for (const participant of [seed.product, seed.engineering]) {
    const confirmed = await action({ kind: 'confirmation.create', participant, role: participant.role, scope: 'version' })
    assert.equal(confirmed.response.status, 200)
  }
  const denied = await action({ kind: 'ready.generate', participant: seed.product })
  assert.equal(denied.response.status, 400)
  assert.equal(denied.data.error, 'engineering precheck is required for the current version')
  await state('old-precheck-denied')
  console.log({ phase, error: denied.data.error })
} else throw new Error('phase must be request, observe, running, retry, refine, generate, change, or stale-precheck')
