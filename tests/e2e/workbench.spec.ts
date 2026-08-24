import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

async function openWorkbench(page: Page): Promise<void> {
  await page.goto('/')
  const entry = page.getByText('需求讨论', { exact: true }).last()
  if (await entry.isVisible().catch(() => false)) await entry.click()
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
