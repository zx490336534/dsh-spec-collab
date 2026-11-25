import { AxeBuilder } from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { action, change, review, view, withWorkbench } from './harness.mjs'
import { engineering, product, raw, title } from './fixture.mjs'

const screenshotDir = process.env.SPEC_COLLAB_SCREENSHOTS
async function screenshot(page, name) {
  if (!screenshotDir) return
  await mkdir(screenshotDir, { recursive: true })
  await page.screenshot({ path: resolve(screenshotDir, name + '.png'), animations: 'disabled' })
}

async function register(page, nickname, role) {
  const dialog = page.getByRole('dialog', { name: '设置协作身份' })
  await dialog.getByRole('textbox', { name: '花名（必填）' }).fill(nickname)
  if (role === 'engineering') await dialog.getByRole('combobox').selectOption(role)
  await dialog.getByRole('button', { name: '保存身份' }).click()
  await expect(dialog).toBeHidden()
}

async function workflow(page, label) {
  await page.getByRole('button', { name: label, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '确认流程操作' })
  await dialog.getByRole('button', { name: '确认执行' }).click()
  await expect(dialog).toBeHidden()
}

test('从空需求库完成录入、澄清、差异审核、双确认和 Ready 下载', async ({ page, browser }) => {
  const app = await withWorkbench()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const { url, workspace } = app.register()
    await page.goto(url)
    await expect(page).toHaveTitle('Spec Collab for Codex')
    await expect(page.getByRole('heading', { name: '需求库' })).toBeVisible()
    await page.getByRole('button', { name: '新建需求', exact: true }).click()
    await register(page, product.nickname, product.role)
    const create = page.getByRole('dialog', { name: '新建需求' })
    await create.getByRole('textbox', { name: '需求标题（必填）' }).fill(title)
    await create.getByRole('combobox', { name: '需求所在项目（必填）' }).selectOption(workspace.workspaceId)
    await create.getByRole('textbox', { name: '原始需求（必填）' }).fill(raw)
    await create.getByRole('button', { name: /创建/ }).click()

    const openQuestion = page.getByRole('button', { name: '回答下一题', exact: true })
    await expect(openQuestion).toBeVisible()
    const library = page.getByRole('navigation', { name: '需求工作台导航' })
    await library.getByRole('button', { name: '需求库' }).click()
    await page.getByRole('searchbox', { name: '搜索需求' }).fill('运营报表')
    const row = page.locator('[data-requirement-id]')
    await expect(row).toHaveCount(1)
    const id = await row.getAttribute('data-requirement-id')
    await screenshot(page, '01-library')
    await row.click()

    const original = await view(url, id)
    await openQuestion.click()
    const answer = page.getByRole('dialog', { name: '回答待处理问题' })
    await expect(answer.getByText('导出使用哪些筛选条件？')).toBeVisible()
    await answer.getByRole('button', { name: /沿用当前筛选，下载本月查询结果/ }).click()
    await screenshot(page, '02-clarification')
    await answer.getByRole('button', { name: '保存回答' }).click()
    await page.getByRole('button', { name: '让 AI 回读并生成修改', exact: true }).click()
    await page.getByRole('button', { name: '查看改动', exact: true }).click()
    await page.getByRole('button', { name: '审核全部改动' }).click()
    const diff = page.getByRole('dialog', { name: '审核 AI 建议差异' })
    await expect(diff.getByText(/AC-EXPORT-001/).first()).toBeVisible()
    expect((await view(url, id)).currentCommit).toBe(original.currentCommit)
    await screenshot(page, '03-candidate-diff')
    await diff.getByRole('button', { name: '整包接受并保存' }).click()
    await expect(diff).toBeHidden()

    await page.getByRole('button', { name: '开始需求检查', exact: true }).click()
    await page.getByRole('button', { name: '让 AI 回读并生成修改', exact: true }).click()
    await workflow(page, '进入产品确认')
    await workflow(page, '确认当前版本')
    await workflow(page, '进入产研共审')
    await page.getByRole('button', { name: '开始研发检查', exact: true }).click()
    await expect(page.getByRole('region', { name: '下一步' }).getByRole('status')).toHaveText('等待研发确认')

    const reviewer = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
    try {
      const engineeringPage = await reviewer.newPage()
      await engineeringPage.goto(url + '/#spec-collab/' + encodeURIComponent(id) + '/tasks')
      await engineeringPage.getByRole('button', { name: '登记身份' }).click()
      await register(engineeringPage, engineering.nickname, engineering.role)
      await workflow(engineeringPage, '以研发身份确认')
    } finally { await reviewer.close() }

    await workflow(page, '生成就绪需求')
    await page.getByRole('button', { name: '查看交付内容' }).click()
    const downloadButton = page.getByRole('button', { name: '下载 .md' })
    await expect(downloadButton).toBeVisible()
    await screenshot(page, '05-ready-export')
    const download = page.waitForEvent('download')
    await downloadButton.click()
    const ready = await view(url, id)
    const file = await download
    expect(file.suggestedFilename()).toBe(id + '.md')
    expect(await readFile(await file.path(), 'utf8')).toBe(ready.readyPackage.markdown)
    expect(ready.confirmations.filter(item => item.status === 'active').map(item => [item.role, item.commit])).toEqual([
      ['product', ready.currentCommit], ['engineering', ready.currentCommit],
    ])

    await page.getByRole('tab', { name: '记录' }).click()
    await page.getByRole('tab', { name: '版本历史' }).click()
    await expect(page.getByText('合入 AI 建议：补齐导出范围、权限和验收标准', { exact: true })).toBeVisible()
    await screenshot(page, '04-version-history')
    await page.reload()
    await expect(page.getByRole('heading', { name: '需求库' })).toBeVisible()
    await page.locator('[data-requirement-id]').click()
    await expect(page.getByRole('button', { name: '查看交付内容' })).toBeVisible()
    expect(errors).toEqual([])
  } finally { await app.dispose() }
})

test('窄屏可切换正文和协作，页面无横向溢出', async ({ page }) => {
  const app = await withWorkbench()
  try {
    const { url, workspace } = app.register()
    const created = await change(url, { kind: 'requirement.create', participant: product, title, rawRequirement: raw,
      sources: [], workspaceId: workspace.workspaceId })
    await review(url, created, 'product-first')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(url + '/#spec-collab/' + encodeURIComponent(created.id) + '/tasks')
    await expect(page.getByRole('button', { name: '需求正文', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^协作/ }).click()
    await expect(page.getByText('导出使用哪些筛选条件？')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391)
    await screenshot(page, '06-mobile-review')
  } finally { await app.dispose() }
})

test('工作台无严重 axe 问题，未知工作区和非 JSON 写入失败', async ({ page }) => {
  const app = await withWorkbench()
  try {
    const { url } = app.register()
    await page.goto(url)
    const result = await new AxeBuilder({ page }).include('[data-spec-collab-codex]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(result.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
    const invalid = await action(url, { kind: 'requirement.create', participant: product, title, rawRequirement: raw, sources: [], workspaceId: 'unknown' })
    expect(invalid.ok).toBe(false)
    expect(await page.evaluate(async () => (await fetch('/api/spec-collab/action', { method: 'POST', body: '{}' })).status)).toBe(415)
    expect(await page.locator('[data-requirement-id]').count()).toBe(0)
  } finally { await app.dispose() }
})
