import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { GitRequirementStore, VersionConflictError } from '../src/git-store.ts'
import type { ParticipantSnapshot } from '../src/protocol.ts'

const product: ParticipantSnapshot = { participantId: 'participant-product', nickname: '产品甲', role: 'product', kind: 'human' }

describe('GitRequirementStore', () => {
  it('creates one formal spec commit and preserves source input', () => {
    const root = mkdtempSync(join(tmpdir(), 'spec-git-'))
    const store = new GitRequirementStore(root)
    const created = store.create({ title: '重试策略', rawRequirement: '支付失败后需要自动重试。', sources: [], participant: product })
    expect(created.version.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(created.version.markdown).toContain('支付失败后需要自动重试')
    expect(created.version.markdown).toContain('\n- 原始需求：当前文档（创建版本）\n')
    expect(created.version.markdown).not.toContain('\n-\n\n原\n')
    expect(store.history(created.requirementId)).toHaveLength(1)
  })

  it('rejects a stale base without changing HEAD', () => {
    const store = new GitRequirementStore(mkdtempSync(join(tmpdir(), 'spec-git-')))
    const created = store.create({ title: '重试策略', rawRequirement: '需求', sources: [], participant: product })
    const first = store.save({ requirementId: created.requirementId, baseCommit: created.version.commit, markdown: created.version.markdown.replace('待澄清', '成功结果'), participant: product, summary: 'Clarify outcome' })
    expect(() => store.save({ requirementId: created.requirementId, baseCommit: created.version.commit, markdown: 'stale', participant: product, summary: 'Stale overwrite' })).toThrow(VersionConflictError)
    expect(store.head(created.requirementId)).toBe(first.commit)
  })

  it('stages only the requirement spec and leaves unrelated dirty files untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'spec-git-'))
    const store = new GitRequirementStore(root)
    const created = store.create({ title: '重试策略', rawRequirement: '需求', sources: [], participant: product })
    writeFileSync(join(root, 'unrelated.txt'), 'user change')
    store.save({ requirementId: created.requirementId, baseCommit: created.version.commit, markdown: created.version.markdown + '\n补充。', participant: product, summary: 'Add detail' })
    expect(store.history(created.requirementId)).toHaveLength(2)
    expect(() => writeFileSync(join(root, 'unrelated.txt'), 'still here')).not.toThrow()
  })

  it('deletes through Git so the previous commit remains recoverable', () => {
    const store = new GitRequirementStore(mkdtempSync(join(tmpdir(), 'spec-git-')))
    const created = store.create({ title: '重试策略', rawRequirement: '需求', sources: [], participant: product })
    store.remove(created.requirementId, product)
    expect(store.read(created.requirementId, created.version.commit).markdown).toContain('# 重试策略')
  })
})
