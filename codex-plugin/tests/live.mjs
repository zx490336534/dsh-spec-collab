import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { change, until, view, withWorkbench } from './harness.mjs'
import { product, raw, title } from './fixture.mjs'

const app = await withWorkbench({ live: true })
try {
  const { url, workspace } = app.register()
  const projectCommit = execFileSync('git', ['-C', app.project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const created = await change(url, {
    kind: 'requirement.create', participant: product, title,
    rawRequirement: raw + ' 请先核对 report.js 中的现有筛选和导出能力，再由产品决定导出范围、空结果和权限。',
    sources: [{ id: 'fixture-report-code', sourceType: 'code-scope', label: '当前报表功能', stableId: 'report.js', version: projectCommit, accessStatus: 'available' }],
    workspaceId: workspace.workspaceId,
  })
  const current = await until(async () => {
    const record = await view(url, created.id)
    return ['completed', 'failed'].includes(record.aiRuns[0].status) ? record : undefined
  }, 250_000)
  const run = current.aiRuns[0]
  assert.equal(run.status, 'completed', run.error)
  assert.equal(run.commit, created.currentCommit)
  assert.equal(current.currentCommit, created.currentCommit)
  const evidence = current.reviewItems.flatMap(item => item.evidence)
    .find(item => item.accessible && item.source.includes('report.js') && item.version?.length >= 7 && projectCommit.startsWith(item.version))
  assert.ok(evidence, '初审需要展示 report.js 的版本化证据')
  const screenshots = process.env.SPEC_COLLAB_SCREENSHOTS
  if (screenshots) {
    const browser = await chromium.launch({ channel: 'chrome' })
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
      await page.goto(url + '/#spec-collab/' + encodeURIComponent(created.id) + '/tasks')
      await page.getByText(/AI 运行中心/).click()
      await page.getByText('检查结果已写入问题清单').waitFor()
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: join(screenshots, '07-live-codex-review.png'), animations: 'disabled' })
    } finally { await browser.close() }
  }
  console.log(JSON.stringify({ completed: true, specCommit: run.commit, projectCommit, items: current.reviewItems.length,
    evidence: { source: evidence.source, version: evidence.version, statement: evidence.statement } }, null, 2))
} finally { await app.dispose() }
