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
