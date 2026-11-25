import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { action, change, review, until, view, withWorkbench } from './harness.mjs'
import { engineering, markdown, product, raw, title } from './fixture.mjs'

async function setup(t) {
  const app = await withWorkbench()
  t.after(() => app.dispose())
  return app
}

test('MCP handshake, concurrent startup, canonical workspace binding and selective read', async t => {
  const app = await setup(t)
  const invoke = app.mcp()
  const second = app.mcp()
  const handshake = await invoke('initialize', { protocolVersion: '2025-06-18' })
  assert.equal(handshake.protocolVersion, '2025-06-18')
  const { tools } = await invoke('tools/list')
  assert.deepEqual(tools.map(tool => tool.name), ['spec_workbench', 'spec_list', 'spec_read'])
  const call = async (mcp, name, args) => {
    const result = await mcp('tools/call', { name, arguments: args })
    assert.equal(result.isError, undefined, result.content[0].text)
    return JSON.parse(result.content[0].text)
  }
  const [first, registered] = await Promise.all([
    call(invoke, 'spec_workbench', { workspacePath: app.project }),
    call(second, 'spec_workbench', { workspacePath: app.project + '/.' }),
  ])
  assert.deepEqual(first, registered)
  assert.equal(JSON.parse(await readFile(app.data + '/workspaces.json', 'utf8')).length, 1)
  const invalid = await invoke('tools/call', { name: 'spec_workbench', arguments: { workspacePath: '.' } })
  assert.equal(invalid.isError, true)
  const created = await change(first.url, { kind: 'requirement.create', participant: product, title, rawRequirement: raw, sources: [],
    workspaceId: first.workspace.workspaceId })
  const listed = await call(invoke, 'spec_list', {})
  assert.equal(listed.requirements[0].commit, created.currentCommit)
  const read = await call(second, 'spec_read', { requirementId: created.id, include: ['spec', 'ready'] })
  assert.equal(read.commit, created.currentCommit)
  assert.match(read.spec, /本月报表/)
  assert.equal(read.ready, null)
  assert.equal(read.patches, undefined)
  assert.match(read.url, /#spec-collab\//)
  assert.equal((await invoke('tools/call', { name: 'spec_read', arguments: { requirementId: '不存在' } })).isError, true)
  assert.equal((await invoke('tools/call', { name: 'spec_read', arguments: { requirementId: created.id, include: ['unknown'] } })).isError, true)
})

test('loopback workbench rejects foreign Origin and unauthenticated control', async t => {
  const app = await setup(t)
  const { url } = app.register()
  assert.equal((await fetch(url)).status, 200)
  assert.equal((await fetch(url + '/api/spec-collab/state', { headers: { origin: 'https://example.invalid' } })).status, 403)
  assert.equal((await fetch(url + '/api/spec-collab/action', { method: 'POST', body: '{}' })).status, 403)
  assert.equal((await fetch(url + '/_spec-collab/control', { method: 'POST', body: '{"method":"stop"}' })).status, 403)
  assert.equal((await fetch(url + '/workspaces.json')).status, 404)
  assert.equal((await fetch(url + '/workbench.js')).headers.get('content-type'), 'text/javascript; charset=utf-8')
})

test('human clarification, patch acceptance, Ready gate, Markdown and restart persistence', async t => {
  const app = await setup(t)
  const { url, workspace } = app.register()
  const created = await change(url, { kind: 'requirement.create', participant: product, title, rawRequirement: raw, sources: [], workspaceId: workspace.workspaceId })
  const id = created.id
  const act = input => change(url, { participant: product, requirementId: id, ...input })
  const rejected = input => action(url, { participant: product, requirementId: id, ...input })
  const reviewed = await review(url, created, 'product-first')
  assert.equal(reviewed.reviewItems[0].recommendedOptions.length, 3)
  assert.equal(reviewed.reviewItems[0].commit, created.currentCommit)
  assert.match((await rejected({ kind: 'stage.advance' })).error, /blocking/)
  assert.equal((await rejected({ kind: 'confirmation.create', participant: { ...product, kind: 'ai', sessionId: 'test' }, role: 'product', scope: 'version' })).ok, false)
  await act({ kind: 'review.respond', reviewItemId: reviewed.reviewItems[0].id, disposition: 'accept-modified', body: '沿用当前报表筛选，空结果显示提示。' })
  await act({ kind: 'review.request', reviewKind: 'product-second' })
  const proposed = await review(url, created, 'product-second')
  assert.equal(proposed.currentCommit, created.currentCommit)
  assert.equal(proposed.patches[0].status, 'pending')
  assert.equal(proposed.patches[0].baseCommit, created.currentCommit)
  const saved = await act({ kind: 'patch.accept', patchId: proposed.patches[0].id, summary: '应用产品确认范围' })
  assert.notEqual(saved.currentCommit, created.currentCommit)
  assert.equal(saved.version.markdown, markdown)
  assert.equal((await rejected({ kind: 'version.save', baseCommit: created.currentCommit, markdown, summary: '旧版本写入' })).status, 409)
  await review(url, saved, 'change-review')
  await act({ kind: 'review.request', reviewKind: 'product-second' })
  await review(url, saved, 'product-second')
  await act({ kind: 'stage.advance' })
  await act({ kind: 'confirmation.create', role: 'product', scope: 'version' })
  await act({ kind: 'stage.advance' })
  await act({ kind: 'confirmation.create', participant: engineering, role: 'engineering', scope: 'version' })
  assert.match((await rejected({ kind: 'ready.generate' })).error, /engineering precheck/)
  await act({ kind: 'review.request', participant: engineering, reviewKind: 'engineering-precheck' })
  await review(url, saved, 'engineering-precheck')
  const ready = await act({ kind: 'ready.generate' })
  assert.equal(ready.stage, 'ready')
  assert.equal(ready.readyPackage.commit, saved.currentCommit)
  assert.match(ready.readyPackage.markdown, /AC-EXPORT-001/)
  assert.match(ready.readyPackage.markdown, /林舟/)
  assert.match(ready.readyPackage.markdown, /周遥/)
  assert.equal(execFileSync('git', ['-C', app.data + '/repository', 'show', saved.currentCommit + ':requirements/' + id + '/spec.md'], { encoding: 'utf8' }), markdown)
  assert.match(app.stop(), /已停止/)
  await until(async () => {
    try { await fetch(url); return false } catch { return true }
  })
  assert.equal(app.register().url, url)
  assert.equal((await view(url, id)).readyPackage.packageHash, ready.readyPackage.packageHash)
  const changed = await act({ kind: 'version.save', baseCommit: ready.currentCommit, markdown: markdown.replace('UTF-8', 'UTF-8 BOM'), summary: '变更导出编码' })
  assert.equal(changed.stage, 'joint-review')
  assert.equal(changed.readyPackage, undefined)
  assert.equal(changed.confirmations.filter(item => item.status === 'active').length, 0)
})

test('invalid model output fails without mutating Git; stale review cannot populate the replacement commit', async t => {
  const app = await setup(t)
  const { url, workspace } = app.register()
  const create = rawRequirement => change(url, { kind: 'requirement.create', participant: product, title, rawRequirement, sources: [], workspaceId: workspace.workspaceId })
  const invalid = await create(raw + '模拟返回无效结果')
  const failed = await review(url, invalid, 'product-first', 'failed')
  assert.match(failed.aiRuns[0].error, /格式不完整/)
  assert.equal(failed.history.length, 1)
  assert.equal(failed.patches.length, 0)

  const stale = await create(raw + '模拟延迟审核')
  await review(url, stale, 'product-first', 'running')
  const newest = await change(url, { kind: 'version.save', participant: product, requirementId: stale.id,
    baseCommit: stale.currentCommit, markdown, summary: '审核中修改正文' })
  await review(url, newest, 'change-review')
  const final = await review(url, stale, 'product-first', 'failed')
  assert.equal(final.currentCommit, newest.currentCommit)
  assert.deepEqual(final.reviewItems, [])
})

test('comment and follow-up responses persist without changing the Git version', async t => {
  const app = await setup(t)
  const { url, workspace } = app.register()
  const created = await change(url, { kind: 'requirement.create', participant: product, title, rawRequirement: raw, sources: [], workspaceId: workspace.workspaceId })
  await review(url, created, 'product-first')
  await change(url, { kind: 'comment.create', participant: product, requirementId: created.id, commit: created.currentCommit, scope: 'page', body: '没有订单时应如何提示？', mentions: [] })
  const current = await until(async () => {
    const requirement = await view(url, created.id)
    return requirement.comments[0].aiStatus === 'completed' ? requirement : undefined
  })
  const comment = current.comments[0]
  assert.equal(comment.replies[0].author.nickname, 'Codex')
  const endpoint = url + '/api/spec-collab/ai-conversation'
  const query = '?' + new URLSearchParams({ requirementId: created.id, sessionId: comment.aiSessionId })
  const followUp = await fetch(endpoint, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ requirementId: created.id, sessionId: comment.aiSessionId, text: '请再检查导出权限。' }) })
  assert.equal(followUp.status, 202)
  await until(async () => {
    const { messages } = await (await fetch(endpoint + query)).json()
    return messages.length >= 6 && messages.at(-1).role === 'assistant'
  })
  assert.equal((await view(url, created.id)).currentCommit, created.currentCommit)
})

test('a running review interrupted by service shutdown can be retried on the same commit', async t => {
  const app = await setup(t)
  const { url, workspace } = app.register()
  const created = await change(url, { kind: 'requirement.create', participant: product, title, rawRequirement: raw + '模拟延迟审核',
    sources: [], workspaceId: workspace.workspaceId })
  await review(url, created, 'product-first', 'running')
  assert.match(app.stop(), /已停止/)
  await until(async () => {
    try { await fetch(url); return false } catch { return true }
  })
  assert.equal(app.register().url, url)
  const recovered = await view(url, created.id)
  assert.equal(recovered.aiRuns[0].status, 'failed')
  assert.match(recovered.aiRuns[0].error, /重启/)
  assert.equal(recovered.history.length, 1)
  await change(url, { kind: 'review.request', participant: product, requirementId: created.id, reviewKind: 'product-first' })
  const completed = await review(url, created, 'product-first')
  assert.equal(completed.currentCommit, created.currentCommit)
  assert.equal(completed.reviewItems.length, 1)
})
