import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ParticipantSnapshot, RequirementVersion, SourceReference } from './protocol.ts'

export class VersionConflictError extends Error {
  constructor(readonly currentCommit: string) { super('base-commit-conflict'); this.name = 'VersionConflictError' }
}

export interface CreateRequirementInput { title: string; rawRequirement: string; sources: SourceReference[]; participant: ParticipantSnapshot }
export interface SaveVersionInput { requirementId: string; baseCommit: string; markdown: string; participant: ParticipantSnapshot; summary: string }

export class GitRequirementStore {
  constructor(readonly root: string) { this.ensureRepository() }

  create(input: CreateRequirementInput): { requirementId: string; version: RequirementVersion } {
    const requirementId = `${slug(input.title)}-${randomUUID().slice(0, 8)}`
    const markdown = initialSpec(input.title, input.rawRequirement, input.sources)
    const path = this.specPath(requirementId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, markdown, 'utf8')
    const commit = this.commit(requirementId, input.participant, 'Create requirement')
    return { requirementId, version: this.read(requirementId, commit) }
  }

  save(input: SaveVersionInput): RequirementVersion {
    const current = this.head(input.requirementId)
    if (current !== input.baseCommit) throw new VersionConflictError(current)
    const onDisk = readFileSync(this.specPath(input.requirementId), 'utf8')
    if (onDisk !== this.read(input.requirementId, current).markdown) throw new Error('spec has external uncommitted changes')
    if (input.summary.trim() === '') throw new Error('change summary is required')
    if (input.markdown.length > 2_000_000) throw new Error('spec exceeds 2 MB')
    writeFileSync(this.specPath(input.requirementId), input.markdown, 'utf8')
    this.git(['add', this.relativeSpecPath(input.requirementId)])
    const staged = this.git(['diff', '--cached', '--quiet'], true)
    if (staged.status === 0) throw new Error('no changes to save')
    const commit = this.commitStaged(input.participant, input.summary.trim())
    return this.read(input.requirementId, commit)
  }

  read(requirementId: string, commit?: string): RequirementVersion {
    assertRequirementId(requirementId)
    const resolved = commit ?? this.head(requirementId)
    const markdown = this.gitText(['show', `${resolved}:${this.relativeSpecPath(requirementId)}`])
    const fields = this.gitText(['show', '-s', '--format=%H%x1f%P%x1f%at%x1f%an%x1f%ae%x1f%B', resolved]).split('\x1f')
    const [sha = resolved, parents = '', seconds = '0', nickname = 'unknown', email = '', ...bodyParts] = fields
    const body = bodyParts.join('\x1f').trim()
    const role = /DSH-Role:\s*(product|engineering)/.exec(body)?.[1] as ParticipantSnapshot['role'] | undefined
    const summary = body.split('\n')[0] ?? 'Saved version'
    return {
      commit: sha,
      ...(parents.split(' ')[0] ? { parentCommit: parents.split(' ')[0] } : {}),
      markdown,
      author: { participantId: email.replace(/@dsh\.local$/, '') || 'unknown', nickname, role: role ?? 'product', kind: 'human' },
      summary,
      createdAt: Number(seconds) * 1000,
    }
  }

  history(requirementId: string): Array<Omit<RequirementVersion, 'markdown'>> {
    assertRequirementId(requirementId)
    const output = this.gitText(['log', '--format=%H%x1f%P%x1f%at%x1f%an%x1f%ae%x1f%B%x1e', '--', this.relativeSpecPath(requirementId)])
    return output.split('\x1e').map(row => row.trim()).filter(Boolean).map(row => {
      const [commit = '', parents = '', seconds = '0', nickname = 'unknown', email = '', ...bodyParts] = row.split('\x1f')
      const body = bodyParts.join('\x1f').trim()
      const role = /DSH-Role:\s*(product|engineering)/.exec(body)?.[1] as ParticipantSnapshot['role'] | undefined
      return {
        commit,
        ...(parents.split(' ')[0] ? { parentCommit: parents.split(' ')[0] } : {}),
        author: { participantId: email.replace(/@dsh\.local$/, '') || 'unknown', nickname, role: role ?? 'product', kind: 'human' },
        summary: body.split('\n')[0] ?? 'Saved version',
        createdAt: Number(seconds) * 1000,
      }
    })
  }

  diff(requirementId: string, baseCommit: string, headCommit?: string): string {
    assertRequirementId(requirementId)
    return this.gitText(['diff', baseCommit, headCommit ?? this.head(requirementId), '--', this.relativeSpecPath(requirementId)])
  }

  remove(requirementId: string, participant: ParticipantSnapshot): void {
    assertRequirementId(requirementId)
    if (!existsSync(this.specPath(requirementId))) throw new Error('requirement spec not found')
    this.git(['rm', '-r', `requirements/${requirementId}`])
    this.commitStaged(participant, 'Delete requirement')
  }

  head(requirementId: string): string {
    assertRequirementId(requirementId)
    return this.gitText(['log', '-1', '--format=%H', '--', this.relativeSpecPath(requirementId)]).trim()
  }

  private commit(requirementId: string, participant: ParticipantSnapshot, summary: string): string {
    this.git(['add', this.relativeSpecPath(requirementId)])
    return this.commitStaged(participant, summary)
  }

  private commitStaged(participant: ParticipantSnapshot, summary: string): string {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: participant.nickname,
      GIT_AUTHOR_EMAIL: `${participant.participantId}@dsh.local`,
      GIT_COMMITTER_NAME: participant.nickname,
      GIT_COMMITTER_EMAIL: `${participant.participantId}@dsh.local`,
    }
    execFileSync('git', ['commit', '-m', summary, '-m', `DSH-Role: ${participant.role}`], { cwd: this.root, env, stdio: 'pipe' })
    return this.gitText(['rev-parse', 'HEAD']).trim()
  }

  private ensureRepository(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    if (!existsSync(join(this.root, '.git'))) execFileSync('git', ['init'], { cwd: this.root, stdio: 'pipe' })
  }
  private relativeSpecPath(id: string): string { assertRequirementId(id); return `requirements/${id}/spec.md` }
  private specPath(id: string): string { return join(this.root, this.relativeSpecPath(id)) }
  private gitText(args: string[]): string { return execFileSync('git', args, { cwd: this.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  private git(args: string[], allowFailure = false): { status: number } {
    try { execFileSync('git', args, { cwd: this.root, stdio: 'pipe' }); return { status: 0 } }
    catch (error) { if (allowFailure) return { status: (error as { status?: number }).status ?? 1 }; throw error }
  }
}

function slug(title: string): string {
  const value = title.toLowerCase().trim().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  return value || 'requirement'
}
function assertRequirementId(value: string): void { if (!/^[a-z0-9\u4e00-\u9fff][a-z0-9\u4e00-\u9fff-]{1,80}$/.test(value)) throw new Error('invalid requirement id') }
function initialSpec(title: string, raw: string, sources: SourceReference[]): string {
  const sourceLines = sources.length === 0 ? ['- 原始需求：当前文档（创建版本）'] : sources.map(item => `- [${item.accessStatus}] ${item.label}${item.stableId ? ` — ${item.stableId}` : ''}`)
  return [`# ${title}`, '', '## 原始需求与来源', '', raw.trim(), '', ...sourceLines, '', '## 目标与用户结果', '', '<!-- AI 初审后补充 -->', '', '## 范围与非范围', '', '### 范围', '', '### 非范围', '', '## 业务术语与规则', '', '## 需求与验收标准', '', '- **AC-1**：待澄清', '', '## 异常、权限与兼容', '', '## 测试约束', '', '## 待补充资料', ''].join('\n')
}
