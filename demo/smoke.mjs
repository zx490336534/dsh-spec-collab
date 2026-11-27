import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const standalone = new URL('../dist/spec-collab.html', import.meta.url).href
const target = process.argv[2] ?? standalone
const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const width of [320, 375, 600, 768, 1024, 1440, 1920]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } })
    if (target.startsWith('file:')) await context.setOffline(true)
    const page = await context.newPage()
    const unexpectedRequests = []
    const errors = []
    page.on('request', request => {
      if (request.resourceType() !== 'document') unexpectedRequests.push(request.url())
    })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.goto(target, { waitUntil: 'load' })
    const get = id => page.locator('#' + id)
    const message = page.getByRole('status')
    const sign = page.getByRole('button', { name: '确认当前版本', exact: true })
    const download = page.getByRole('button', { name: '下载 Ready Spec', exact: true })
    const precheck = page.getByRole('button', { name: '运行预设研发预审', exact: true })
    async function checkLayout() {
      const [bodyFits, sideBySide] = await page.evaluate(() => {
        const [documentPane, reviewPane] = [...document.querySelectorAll('.sheet')].map(pane => pane.getBoundingClientRect())
        return [document.documentElement.scrollWidth <= innerWidth, reviewPane.left >= documentPane.right]
      })
      assert.equal(bodyFits, true, `No horizontal overflow at ${width}px`)
      assert.equal(sideBySide, width > 768, `Expected layout at ${width}px`)
    }
    await checkLayout()
    assert.equal(await get('version').textContent(), '演示-v1')
    assert.equal(await download.isDisabled(), true)
    await page.getByText('报表过期后，下载应该怎样处理？').click()
    assert.match(await get('diff').innerText(), /移除[\s\S]+新增[\s\S]+24 小时/)
    await checkLayout()
    await page.getByRole('button', { name: '采纳候选修改' }).click()
    assert.equal(await get('version').textContent(), '演示-v2')
    assert.equal(await sign.isDisabled(), true)

    async function confirmBoth() {
      await precheck.click()
      await get('role').selectOption('product')
      await sign.click()
      assert.equal(await download.isDisabled(), true)
      await get('role').selectOption('engineering')
      await sign.click()
      assert.equal(await download.isEnabled(), true)
    }

    async function verifyDownload(version, hours) {
      const [file] = await Promise.all([page.waitForEvent('download'), download.click()])
      assert.equal(file.suggestedFilename(), `DEMO-001-v${version}-ready-spec.md`)
      const body = await readFile(await file.path(), 'utf8')
      assert.match(body, /预设审核结果/)
      assert.ok(body.includes(`文档版本：演示-v${version}`))
      assert.ok(body.includes(`生成完成后保留 ${hours} 小时`))
      assert.match(body, /产品确认：演示产品/)
      assert.match(body, /研发确认：演示研发/)
    }

    await confirmBoth()
    await verifyDownload(2, 24)
    assert.equal(await get('stage').textContent(), 'Ready')
    await get('duration').fill('169')
    assert.equal(await get('save').isDisabled(), true)
    await get('duration').fill('48')
    await get('save').click()
    assert.equal(await get('version').textContent(), '演示-v3')
    assert.equal(await get('stage').textContent(), '产研共审')
    assert.match(await message.innerText(), /旧确认已失效/)
    for (const role of ['product', 'engineering']) {
      assert.equal(await get('status-' + role).textContent(), '旧确认已失效')
    }
    assert.equal(await sign.isDisabled(), true)
    assert.equal(await download.isDisabled(), true)
    await confirmBoth()
    await verifyDownload(3, 48)
    await page.getByRole('button', { name: '重置演示' }).click()
    assert.equal(await get('version').textContent(), '演示-v1')
    assert.equal(await download.isDisabled(), true)
    await checkLayout()
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpectedRequests, [])
    await context.close()
    console.log(`Passed single-file review, version invalidation and export at ${width}px`)
  }
} finally {
  await browser.close()
}
