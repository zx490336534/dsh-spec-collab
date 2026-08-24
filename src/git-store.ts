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
  private readonly versionCache = new Map<string, RequirementVersion>()
  private readonly headCache = new Map<string, string>()
  private readonly historyCache = new Map<string, Array<Omit<RequirementVersion, 'markdown'>>>()
  private commitBaseUrl: string | null | undefined

  constructor(readonly root: string) { this.ensureRepository() }

  create(input: CreateRequirementInput): { requirementId: string; version: RequirementVersion } {
    const requirementId = `${slug(input.title)}-${randomUUID().slice(0, 8)}`
    const markdown = initialSpec(input.title, input.rawRequirement, input.sources)
    const path = this.specPath(requirementId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, markdown, 'utf8')
    const commit = this.commit(requirementId, input.participant, 'Create requirement')
    const version = this.rememberCommittedVersion(requirementId, commit, markdown, input.participant, 'Create requirement')
    return { requirementId, version }
  }

  save(input: SaveVersionInput): RequirementVersion {
    const current = this.head(input.requirementId)
    if (current !== input.baseCommit) throw new VersionConflictError(current)
    const onDisk = readFileSync(this.specPath(input.requirementId), 'utf8')
    if (onDisk !== this.read(input.requirementId, current).markdown) throw new Error('spec has external uncommitted changes')
    if (input.summary.trim() === '') throw new Error('change summary is required')
    if (input.markdown.length > 2_000_000) throw new Error('spec exceeds 2 MB')
    if (input.markdown === onDisk) throw new Error('no changes to save')
    writeFileSync(this.specPath(input.requirementId), input.markdown, 'utf8')
    this.git(['add', this.relativeSpecPath(input.requirementId)])
    const commit = this.commitStaged(input.participant, input.summary.trim())
    return this.rememberCommittedVersion(input.requirementId, commit, input.markdown, input.participant, input.summary.trim(), current)
  }

  read(requirementId: string, commit?: string): RequirementVersion {
    assertRequirementId(requirementId)
    const resolved = commit ?? this.head(requirementId)
    const cacheKey = `${requirementId}:${resolved}`
    const cached = this.versionCache.get(cacheKey)
    if (cached !== undefined) return structuredClone(cached)
    const markdown = this.gitText(['show', `${resolved}:${this.relativeSpecPath(requirementId)}`])
    const fields = this.gitText(['show', '-s', '--format=%H%x1f%P%x1f%at%x1f%an%x1f%ae%x1f%B', resolved]).split('\x1f')
    const [sha = resolved, parents = '', seconds = '0', nickname = 'unknown', email = '', ...bodyParts] = fields
    const body = bodyParts.join('\x1f').trim()
    const role = /DSH-Role:\s*(product|engineering)/.exec(body)?.[1] as ParticipantSnapshot['role'] | undefined
    const summary = body.split('\n')[0] ?? 'Saved version'
    const version: RequirementVersion = {
      commit: sha,
      ...(parents.split(' ')[0] ? { parentCommit: parents.split(' ')[0] } : {}),
      markdown,
      author: { participantId: email.replace(/@dsh\.local$/, '') || 'unknown', nickname, role: role ?? 'product', kind: 'human' },
      summary,
      createdAt: Number(seconds) * 1000,
    }
    this.versionCache.set(cacheKey, version)
    return structuredClone(version)
  }

  history(requirementId: string): Array<Omit<RequirementVersion, 'markdown'>> {
    assertRequirementId(requirementId)
    const cached = this.historyCache.get(requirementId)
    if (cached !== undefined) return structuredClone(cached)
    const output = this.gitText(['log', '--format=%H%x1f%P%x1f%at%x1f%an%x1f%ae%x1f%B%x1e', '--', this.relativeSpecPath(requirementId)])
    const history: Array<Omit<RequirementVersion, 'markdown'>> = output.split('\x1e').map(row => row.trim()).filter(Boolean).map(row => {
      const [commit = '', parents = '', seconds = '0', nickname = 'unknown', email = '', ...bodyParts] = row.split('\x1f')
      const body = bodyParts.join('\x1f').trim()
      const role = /DSH-Role:\s*(product|engineering)/.exec(body)?.[1] as ParticipantSnapshot['role'] | undefined
      return {
        commit,
        ...(parents.split(' ')[0] ? { parentCommit: parents.split(' ')[0] } : {}),
        author: { participantId: email.replace(/@dsh\.local$/, '') || 'unknown', nickname, role: role ?? 'product', kind: 'human' as const },
        summary: body.split('\n')[0] ?? 'Saved version',
        createdAt: Number(seconds) * 1000,
      }
    })
    this.historyCache.set(requirementId, history)
    return structuredClone(history)
  }

  diff(requirementId: string, baseCommit: string, headCommit?: string): string {
    assertRequirementId(requirementId)
    return this.gitText(['diff', baseCommit, headCommit ?? this.head(requirementId), '--', this.relativeSpecPath(requirementId)])
  }

  commitUrl(commit: string): string | undefined {
    if (!/^[a-f0-9]{40}$/.test(commit)) return undefined
    if (this.commitBaseUrl !== undefined) return this.commitBaseUrl === null ? undefined : `${this.commitBaseUrl}/commit/${commit}`
    let origin: string
    try { origin = this.gitText(['config', '--get', 'remote.origin.url']).trim() } catch { this.commitBaseUrl = null; return undefined }
    if (origin === '') { this.commitBaseUrl = null; return undefined }
    const scp = /^git@([^:]+):(.+)$/.exec(origin)
    const normalized = scp ? `https://${scp[1]}/${scp[2]}` : origin.replace(/^ssh:\/\/git@/, 'https://')
    if (!/^https?:\/\//.test(normalized)) { this.commitBaseUrl = null; return undefined }
    this.commitBaseUrl = normalized.replace(/\.git$/, '').replace(/\/$/, '')
    return `${this.commitBaseUrl}/commit/${commit}`
  }

  remove(requirementId: string, participant: ParticipantSnapshot): void {
    assertRequirementId(requirementId)
    if (!existsSync(this.specPath(requirementId))) throw new Error('requirement spec not found')
    this.git(['rm', '-r', `requirements/${requirementId}`])
    this.commitStaged(participant, 'Delete requirement')
    this.headCache.delete(requirementId); this.historyCache.delete(requirementId)
    for (const key of this.versionCache.keys()) if (key.startsWith(`${requirementId}:`)) this.versionCache.delete(key)
  }

  head(requirementId: string): string {
    assertRequirementId(requirementId)
    const cached = this.headCache.get(requirementId)
    if (cached !== undefined) return cached
    const resolved = this.gitText(['log', '-1', '--format=%H', '--', this.relativeSpecPath(requirementId)]).trim()
    this.headCache.set(requirementId, resolved)
    return resolved
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
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-m', summary, '-m', `DSH-Role: ${participant.role}`], { cwd: this.root, env, stdio: 'pipe' })
    return this.gitText(['rev-parse', 'HEAD']).trim()
  }

  private rememberCommittedVersion(requirementId: string, commit: string, markdown: string, participant: ParticipantSnapshot, summary: string, parentCommit?: string): RequirementVersion {
    const version: RequirementVersion = { commit, ...(parentCommit ? { parentCommit } : {}), markdown, author: participant, summary, createdAt: Date.now() }
    this.headCache.set(requirementId, commit)
    this.versionCache.set(`${requirementId}:${commit}`, version)
    const metadata = withoutMarkdown(version)
    const history = this.historyCache.get(requirementId)
    this.historyCache.set(requirementId, history === undefined ? [metadata] : [metadata, ...history])
    return structuredClone(version)
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

function withoutMarkdown(version: RequirementVersion): Omit<RequirementVersion, 'markdown'> {
  const { markdown: _markdown, ...metadata } = version
  return metadata
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
