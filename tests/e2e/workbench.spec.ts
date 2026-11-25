import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

async function openWorkbench(page: Page, openDocument = true): Promise<void> {
  await page.goto(process.env.SPEC_COLLAB_E2E_ENTRY ?? '/')
  const intro = page.getByRole('dialog', { name: '预览版说明' })
  if (await intro.isVisible()) await intro.getByRole('button', { name: '继续' }).click()
  const entry = page.getByRole('button', { name: '需求讨论', exact: true })
  const openSidebar = page.getByRole('button', { name: '打开侧边栏', exact: true })
  if (!await entry.isVisible() && await openSidebar.isVisible()) await openSidebar.click()
  if (!await entry.isVisible()) await page.locator('button[aria-label="更多"]:visible').first().click()
  await expect(entry).toBeVisible()
  await entry.click()
  await expect(page.getByRole('heading', { name: '需求库' })).toBeVisible()
  if (openDocument) await page.locator('[data-requirement-id]').first().click()
  await expect(page.getByRole('button', { name: '返回聊天' })).toBeVisible()
}

async function openReadyRequirement(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: '需求工作台导航' }).getByRole('button', { name: '需求库' }).click()
  await page.locator('[data-stage="ready"] [data-requirement-id]').first().click()
  await expect(page.getByRole('button', { name: '查看交付内容' })).toBeVisible()
}

async function useProductIdentity(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('dsh-spec-collab.participant', JSON.stringify({
      participantId: 'e2e-product', nickname: '验收人员', role: 'product', kind: 'human',
    }))
  })
}

test('首次创建需求先登记身份，取消登记不会保存输入', async ({ page }) => {
  await openWorkbench(page, false)
  const create = page.getByRole('button', { name: '新建需求' })
  const identity = page.getByRole('dialog', { name: '设置协作身份' })
  await create.click()
  await identity.getByRole('textbox', { name: '花名（必填）' }).fill('验收产品')
  await identity.getByRole('button', { name: '取消' }).click()
  await expect(page.getByRole('button', { name: '登记身份', exact: true })).toBeVisible()
  await create.click()
  await expect(identity.getByRole('textbox', { name: '花名（必填）' })).toHaveValue('')
  await identity.getByRole('textbox', { name: '花名（必填）' }).fill('验收产品')
  await identity.getByRole('button', { name: '保存身份' }).click()
  await expect(page.getByRole('dialog', { name: '新建需求' })).toBeVisible()
})

test('需求库搜索筛选保留宿主项目树，进入详情后仍可回到原搜索', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 })
  await openWorkbench(page, false)
  const shell = page.locator('[data-dsh-spec-collab-view]')
  const hostTree = page.getByRole('tree', { name: '会话' })
  await expect(hostTree).toBeVisible()
  const hostWidth = await hostTree.evaluate(element => element.getBoundingClientRect().width)
  const first = page.locator('[data-requirement-id]').first()
  const id = await first.getAttribute('data-requirement-id')
  expect(id).toBeTruthy()
  const query = page.getByRole('searchbox', { name: '搜索需求' })
  await query.fill(id!)
  await expect(page.locator('[data-requirement-id]')).toHaveCount(1)
  await first.click()
  await expect(page.getByRole('list', { name: '需求进度' })).toBeVisible()
  expect(await hostTree.evaluate(element => element.getBoundingClientRect().width)).toBe(hostWidth)
  expect(await shell.evaluate(element => element.getBoundingClientRect().left)).toBeGreaterThan(0)
  await page.getByRole('navigation', { name: '需求工作台导航' }).getByRole('button', { name: '需求库' }).click()
  await expect(query).toHaveValue(id!)
  await expect(page.locator('[data-requirement-id]')).toHaveCount(1)
})

for (const width of [1440, 1280, 1024, 960, 900, 680, 650, 390]) {
  test(`工作台在 ${width}px 下无不可达的页面级横向溢出`, async ({ page }) => {
    await openWorkbench(page)
    await page.setViewportSize({ width, height: 844 })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    const panelWidth = await page.locator('[data-dsh-spec-collab-view]').evaluate(element => element.getBoundingClientRect().width)
    if (panelWidth <= 940) {
      await expect(page.getByRole('button', { name: '需求正文', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '协作', exact: true })).toBeVisible()
    }
  })
}

test('核心工作台没有严重或致命 axe 违规', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await openWorkbench(page)
  const result = await new AxeBuilder({ page }).include('[data-dsh-spec-collab-view]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(result.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
})

test('移动端从协作进入专注模式后仍显示正文', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 844 })
  await openWorkbench(page)
  await page.getByRole('button', { name: /^协作/ }).click()
  await page.getByRole('button', { name: '聚焦正文', exact: true }).click()
  await expect(page.locator('.toastui-editor-ww-container')).toBeVisible()
  await expect(page.getByRole('button', { name: '需求正文', exact: true })).toBeHidden()
})

test('Portal 对话框继承插件主题且移动端页签热区不小于 44px', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 844 })
  await openWorkbench(page)
  await page.getByRole('button', { name: '登记身份', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置协作身份' })
  await expect(dialog).toBeVisible()
  const surface = dialog.locator('form, > div').first()
  expect(await surface.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  const dialogControlHeights = await dialog.locator('button:visible, input:visible, select:visible').evaluateAll(controls => controls.map(control => control.getBoundingClientRect().height))
  expect(dialogControlHeights.length).toBeGreaterThan(0)
  expect(dialogControlHeights.every(height => height >= 44)).toBe(true)
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
  await page.getByRole('button', { name: '登记身份', exact: true }).click()

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

test('正文批注标记 hover 不显示大块背景且保留点击热区', async ({ page }) => {
  await page.setViewportSize({ width: 1256, height: 844 })
  await openWorkbench(page)
  const marker = page.getByRole('button', { name: '打开问题：公开社区由哪个内容系统承载？' })
  await marker.hover()
  const style = await marker.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { background: getComputedStyle(element).backgroundColor, width: rect.width, height: rect.height }
  })
  expect(style.background).toBe('rgba(0, 0, 0, 0)')
  expect(style.width).toBeGreaterThanOrEqual(44)
  expect(style.height).toBeGreaterThanOrEqual(44)
})

test('新建需求首次打开不预先报错，提交空表单后才显示错误摘要', async ({ page }) => {
  await page.setViewportSize({ width: 1256, height: 844 })
  await useProductIdentity(page)
  await openWorkbench(page, false)
  await page.getByRole('button', { name: '新建需求' }).click()

  const dialog = page.getByRole('dialog', { name: '新建需求' })
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  const submit = dialog.getByRole('button', { name: '创建并开始 AI 检查' })
  await expect(submit).toBeEnabled()
  await submit.click()

  await expect(dialog.getByRole('alert')).toContainText('请填写需求标题')
  await expect(dialog.getByRole('textbox', { name: '需求标题（必填）' })).toBeFocused()
})

test('洞察表单首屏可以看到重要度，不需要为最后一个关键字段滚动', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 844 })
  await openWorkbench(page)
  await page.getByRole('button', { name: '协作', exact: true }).click()
  await page.getByRole('tab', { name: '洞察', exact: true }).click()
  await page.getByRole('button', { name: '记录客户洞察' }).click()

  const dialog = page.getByRole('dialog', { name: '记录客户洞察' })
  await expect(dialog.getByRole('combobox', { name: '重要度' })).toBeInViewport()
})

test('版本卡片在协作栏内完整显示且不产生横向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1256, height: 844 })
  await openWorkbench(page)
  await page.getByRole('tab', { name: '记录', exact: true }).click()
  await page.getByRole('tab', { name: '版本历史', exact: true }).click()

  const panel = page.getByRole('tabpanel', { name: '版本历史' })
  await expect(panel.getByRole('button', { name: '复制链接' }).first()).toBeVisible()
  const layout = await panel.evaluate(element => {
    const panelRect = element.getBoundingClientRect()
    const buttons = [...element.querySelectorAll('button')].filter(button => button.textContent?.includes('复制链接') || button.textContent?.includes('当前版本') || button.textContent?.includes('恢复为新版本'))
    return {
      overflow: element.scrollWidth - element.clientWidth,
      buttonsInside: buttons.every(button => {
        const rect = button.getBoundingClientRect()
        return rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1
      }),
    }
  })
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.buttonsInside).toBe(true)
})

test('Ready 主操作会把交付工具定位到可见区域', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 844 })
  await openWorkbench(page)
  await openReadyRequirement(page)
  await page.getByRole('button', { name: '协作', exact: true }).click()
  await page.getByRole('button', { name: '查看交付内容' }).click()

  await expect(page.getByRole('button', { name: '复制 Markdown' })).toBeInViewport()
  await expect(page.getByRole('button', { name: '下载 .md' })).toBeInViewport()
})

test('我的工作显示具体任务对象，而不是一组无法区分的类型标签', async ({ page }) => {
  await page.setViewportSize({ width: 1256, height: 844 })
  await useProductIdentity(page)
  await openWorkbench(page)
  await page.getByRole('button', { name: /我的工作/ }).click()

  const dialog = page.getByRole('dialog', { name: '我的工作' })
  await expect(dialog).toContainText('公开社区由哪个内容系统承载？')
  await expect(dialog).toContainText('重构社区二期产品方案')
  expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
})

test('单面板布局的常用操作热区不小于 44px', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 844 })
  await useProductIdentity(page)
  await openWorkbench(page)

  const heights = await page.locator('[data-dsh-spec-collab-view]').evaluate(element => {
    const controls = [
      element.querySelector('button[class*="myWorkButton"]'),
      element.querySelector('button[class*="identity"]'),
    ].filter((control): control is HTMLElement => control instanceof HTMLElement)
    return controls.map(control => ({ text: control.textContent?.trim(), height: control.getBoundingClientRect().height }))
  })
  await page.getByRole('button', { name: /^协作/ }).click()
  const workflowHeight = await page.locator('section[class*="workflowFocus"] > button').evaluate(control => control.getBoundingClientRect().height)
  heights.push({ text: '流程主操作', height: workflowHeight })
  expect(heights.length).toBe(3)
  expect(heights.every(control => control.height >= 44)).toBe(true)

  const taskQueue = page.locator('details[class*="taskQueue"]')
  await taskQueue.locator('summary').click()
  const assignmentSelectHeights = await taskQueue.locator('select:visible').evaluateAll(controls => controls.map(control => control.getBoundingClientRect().height))
  const taskTitleLayout = await taskQueue.evaluate(element => ({
    overflow: element.scrollWidth - element.clientWidth,
    clamped: [...element.querySelectorAll('strong')].every(title => title.clientHeight <= Number.parseFloat(getComputedStyle(title).lineHeight) * 2 + 1),
  }))
  expect(assignmentSelectHeights.length).toBeGreaterThan(0)
  expect(assignmentSelectHeights.every(height => height >= 44)).toBe(true)
  expect(taskTitleLayout.overflow).toBeLessThanOrEqual(1)
  expect(taskTitleLayout.clamped).toBe(true)

  await page.getByRole('tab', { name: '洞察', exact: true }).click()
  const reviewSelectHeights = await page.getByRole('complementary', { name: '需求协作' }).locator('select:visible').evaluateAll(controls => controls.map(control => control.getBoundingClientRect().height))
  expect(reviewSelectHeights.length).toBeGreaterThan(0)
  expect(reviewSelectHeights.every(height => height >= 44)).toBe(true)
})

test('窄屏决策表单保持紧凑且输入控件可触达', async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openWorkbench(page)
  await openReadyRequirement(page)
  await page.getByRole('button', { name: '协作', exact: true }).click()
  await page.getByRole('tab', { name: '记录', exact: true }).click()
  await page.getByRole('tab', { name: '关键决策', exact: true }).click()
  await page.getByRole('button', { name: '记录新决策' }).click()

  const dialog = page.getByRole('dialog', { name: '记录新决策' })
  const form = dialog.locator('form')
  const title = dialog.getByRole('heading', { name: '记录新决策' }).last()
  const save = dialog.getByRole('button', { name: '保存决策' })
  await expect(dialog.getByRole('textbox', { name: '待决策问题（必填）' })).toBeFocused()
  await expect(save).toBeInViewport()
  const before = { title: await title.boundingBox(), save: await save.boundingBox() }
  await form.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(save).toBeInViewport()
  const after = { title: await title.boundingBox(), save: await save.boundingBox() }
  expect(Math.abs(after.title!.y - before.title!.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.save!.y - before.save!.y)).toBeLessThanOrEqual(1)
  const inputHeights = await dialog.locator('input').evaluateAll(controls => controls.map(control => control.getBoundingClientRect().height))
  expect(inputHeights.every(height => height >= 44)).toBe(true)
})
