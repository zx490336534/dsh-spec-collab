import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

async function openWorkbench(page: Page): Promise<void> {
  await page.goto('/')
  const entry = page.getByRole('button', { name: '需求讨论', exact: true })
  await expect(entry).toBeVisible()
  await entry.click()
  await expect(page.getByRole('button', { name: '返回聊天' })).toBeVisible()
}

for (const width of [1440, 1280, 1024, 960, 900, 680, 650]) {
  test(`工作台在 ${width}px 下无不可达的页面级横向溢出`, async ({ page }) => {
    await openWorkbench(page)
    await page.setViewportSize({ width, height: 844 })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    if (width < 960) {
      await expect(page.getByRole('button', { name: '需求列表', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '需求正文', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '协作', exact: true })).toBeVisible()
    }
  })
}

test('核心工作台没有严重或致命 axe 违规', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await openWorkbench(page)
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(result.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
})

test('移动端从协作进入专注模式后仍显示正文', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 844 })
  await openWorkbench(page)
  await page.getByRole('button', { name: '协作', exact: true }).click()
  await page.getByRole('button', { name: /聚焦正文/ }).click()
  await expect(page.locator('.toastui-editor-ww-container')).toBeVisible()
  await expect(page.getByRole('button', { name: '需求正文', exact: true })).toBeHidden()
})

test('Portal 对话框继承插件主题且移动端页签热区不小于 44px', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 844 })
  await openWorkbench(page)
  await page.locator('[data-dsh-spec-collab-view] header button').last().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const surface = dialog.locator('form, > div').first()
  expect(await surface.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '协作', exact: true }).click()
  const tabHeights = await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getBoundingClientRect().height))
  expect(tabHeights.every(height => height >= 44)).toBe(true)
})

test('长批注弹窗只滚动正文并始终保留标题与提交操作', async ({ page }) => {
  await page.setViewportSize({ width: 1256, height: 600 })
  await openWorkbench(page)
  await page.getByRole('complementary', { name: '需求协作' }).getByRole('button', { name: /本提交新增口径是否已获产品确认/ }).click()

  const dialog = page.getByRole('dialog', { name: '回答待处理问题' })
  const body = dialog.locator('[data-dialog-scroll-region]')
  const header = dialog.locator('header')
  const submit = dialog.getByRole('button', { name: /保存回答|保存并下一题/ })
  const source = dialog.getByRole('button', { name: /目标与用户结果/ })
  const firstOption = dialog.getByRole('button', { name: /确认全部新增口径/ })
  await expect(dialog).toBeVisible()
  await expect(body).toBeVisible()
  await expect(submit).toBeVisible()
  await expect(source).toBeVisible()
  await expect(firstOption).toBeVisible()

  const dialogBox = await dialog.boundingBox()
  const sourceBox = await source.boundingBox()
  const optionBox = await firstOption.boundingBox()
  expect(dialogBox).not.toBeNull()
  expect(sourceBox).not.toBeNull()
  expect(optionBox).not.toBeNull()
  expect(dialogBox!.width).toBeGreaterThanOrEqual(680)
  expect(dialogBox!.height).toBeGreaterThanOrEqual(560)
  expect(dialogBox!.x).toBeGreaterThanOrEqual(12)
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(1256 - 12)
  expect(sourceBox!.y + sourceBox!.height).toBeLessThanOrEqual(optionBox!.y)
  const canScroll = await body.evaluate(element => element.scrollHeight > element.clientHeight)
  expect(canScroll).toBe(true)
  const before = { header: await header.boundingBox(), submit: await submit.boundingBox() }
  await body.evaluate(element => { element.scrollTop = element.scrollHeight })
  const after = { header: await header.boundingBox(), submit: await submit.boundingBox() }

  expect(before.header).not.toBeNull()
  expect(before.submit).not.toBeNull()
  expect(after.header).not.toBeNull()
  expect(after.submit).not.toBeNull()
  expect(Math.abs(after.header!.y - before.header!.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.submit!.y - before.submit!.y)).toBeLessThanOrEqual(1)
})

test('小视口表单对话框滚动时保留标题与底部操作', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 360 })
  await openWorkbench(page)
  await page.locator('[data-dsh-spec-collab-view] header button').last().click()

  const dialog = page.getByRole('dialog', { name: '设置协作身份' })
  const form = dialog.locator('form')
  const heading = dialog.getByRole('heading', { name: '设置花名和角色' })
  const submit = dialog.getByRole('button', { name: '保存身份' })
  await expect(dialog).toBeVisible()
  await expect(submit).toBeVisible()
  expect(await form.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)

  const before = { heading: await heading.boundingBox(), submit: await submit.boundingBox() }
  await form.evaluate(element => { element.scrollTop = element.scrollHeight })
  const after = { heading: await heading.boundingBox(), submit: await submit.boundingBox() }

  expect(before.heading).not.toBeNull()
  expect(before.submit).not.toBeNull()
  expect(after.heading).not.toBeNull()
  expect(after.submit).not.toBeNull()
  expect(Math.abs(after.heading!.y - before.heading!.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.submit!.y - before.submit!.y)).toBeLessThanOrEqual(1)
})
