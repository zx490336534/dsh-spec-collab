import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkspaceSnapshot } from '../src/workspace-context.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('workspace context snapshot', () => {
  it('reads standard project context and configured relative documents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spec-collab-workspace-'))
    roots.push(root)
    await writeFile(join(root, 'AGENTS.md'), '# 项目规则\n所有接口必须兼容旧客户端。')
    await writeFile(join(root, 'package.json'), '{"name":"payment-app"}')
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs/domain.md'), '# 支付领域\n退款必须记录原交易号。')

    const snapshot = await readWorkspaceSnapshot(root, ['docs/domain.md'])

    expect(snapshot).toContain('AGENTS.md')
    expect(snapshot).toContain('所有接口必须兼容旧客户端')
    expect(snapshot).toContain('package.json')
    expect(snapshot).toContain('payment-app')
    expect(snapshot).toContain('docs/domain.md')
    expect(snapshot).toContain('退款必须记录原交易号')
  })

  it('bounds large files and records inaccessible configured paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spec-collab-workspace-'))
    roots.push(root)
    await writeFile(join(root, 'README.md'), 'a'.repeat(40_000))

    const snapshot = await readWorkspaceSnapshot(root, ['docs/missing.md'])

    expect(snapshot).toContain('内容已截断')
    expect(snapshot).toContain('docs/missing.md')
    expect(snapshot).toContain('无法读取')
    expect(Buffer.byteLength(snapshot)).toBeLessThan(70_000)
  })
})
