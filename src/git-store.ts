import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ParticipantSnapshot, RequirementVersion, SourceReference } from './protocol.ts'

export class VersionConflictError extends Error {
  constructor(readonly currentCommit: string) { super('base-commit-conflict'); this.name = 'VersionConflictError' }
}

export interface CreateRequirementInput { title: string; rawRequirement: string; sources: SourceReference[]; participant: ParticipantSnapshot }
export interface SaveVersionInput { requirementId: string; baseCommit: string; markdown: string; participant: ParticipantSnapshot; summary: string }

export interface PreparedSpecCommit {
  requirementId: string
  operation: 'create' | 'update' | 'delete'
  baseHead?: string
  commit: string
}

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const REQUIREMENT_ID = /^[a-z0-9\u4e00-\u9fff][a-z0-9\u4e00-\u9fff-]{1,80}$/
const GIT_BUFFER_LIMIT = 16 * 1024 * 1024

type VersionMetadata = Omit<RequirementVersion, 'markdown'>

export class GitRequirementStore {
  private readonly historyCache = new Map<string, { head: string; history: VersionMetadata[] }>()
  // Git blobs addressed by a full commit SHA are immutable. Bound the cache because bodies can reach 2 MB.
  private readonly versionCache = new Map<string, RequirementVersion>()
  private commitBaseUrl: string | null | undefined

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (!existsSync(join(root, '.git'))) this.git(['init'])
  }

  create(input: CreateRequirementInput): { requirementId: string; version: RequirementVersion } {
    const change = this.prepareCreate(input)
    this.publish(change)
    return { requirementId: change.requirementId, version: this.read(change.requirementId, change.commit) }
  }

  save(input: SaveVersionInput): RequirementVersion {
    const change = this.prepareSave(input)
    this.publish(change)
    return this.read(change.requirementId, change.commit)
  }

  remove(requirementId: string, participant: ParticipantSnapshot): void {
    this.publish(this.prepareRemove(requirementId, this.head(requirementId), participant))
  }

  prepareCreate(input: CreateRequirementInput): PreparedSpecCommit {
    const requirementId = `${slug(input.title)}-${randomUUID().slice(0, 8)}`
    const markdown = initialSpec(input.title, input.rawRequirement, input.sources)
    validateSize(markdown)
    const baseHead = this.repositoryHead()
    return this.prepareCommit({ requirementId, operation: 'create', ...(baseHead ? { baseHead } : {}) }, input.participant, 'Create requirement', markdown)
  }

  prepareSave(input: SaveVersionInput): PreparedSpecCommit {
    const baseHead = this.assertCurrent(input.requirementId, input.baseCommit)
    const summary = input.summary.trim()
    if (!summary) throw new Error('change summary is required')
    validateSize(input.markdown)
    if (input.markdown === this.read(input.requirementId, input.baseCommit).markdown) throw new Error('no changes to save')
    return this.prepareCommit({ requirementId: input.requirementId, operation: 'update', baseHead }, input.participant, summary, input.markdown)
  }

  prepareRemove(requirementId: string, baseCommit: string, participant: ParticipantSnapshot): PreparedSpecCommit {
    const baseHead = this.assertCurrent(requirementId, baseCommit)
    return this.prepareCommit({ requirementId, operation: 'delete', baseHead }, participant, 'Delete requirement')
  }

  /** Publish a prepared commit and synchronize its one owned path. Safe to repeat after interruption. */
  publish(change: PreparedSpecCommit): void {
    const path = this.relativeSpecPath(change.requirementId)
    const head = this.repositoryHead()
    if (head !== change.commit) {
      if (head !== change.baseHead) throw new Error('spec repository HEAD changed during the collaboration transaction')
      this.assertClean(path)
      this.git(['update-ref', 'HEAD', change.commit, change.baseHead ?? '0'.repeat(change.commit.length)])
    } else {
      this.assertRecoverableCheckout(change, path)
    }
    if (change.operation !== 'delete' || existsSync(join(this.root, path)) || this.git(['ls-files', '--', path]).trim() !== '') {
      this.git(['restore', '--source', change.commit, '--staged', '--worktree', '--', path])
    }
    if (change.operation === 'delete') this.historyCache.delete(change.requirementId)
  }

  read(requirementId: string, commit = this.head(requirementId)): RequirementVersion {
    const key = `${requirementId}:${commit}`
    const cached = this.versionCache.get(key)
    if (cached !== undefined) return structuredClone(cached)
    const markdown = this.body(requirementId, commit)
    const metadata = this.historyCache.get(requirementId)?.history.find(item => item.commit === commit)
      ?? parseMetadata(this.git(['show', '-s', `--format=${VERSION_FORMAT}`, commit]))
    const version = { ...metadata, markdown }
    if (this.versionCache.size >= 16) this.versionCache.delete(this.versionCache.keys().next().value!)
    this.versionCache.set(key, version)
    return structuredClone(version)
  }

  history(requirementId: string, head = this.repositoryHead()): VersionMetadata[] {
    const path = this.relativeSpecPath(requirementId)
    if (head === undefined) return []
    assertCommit(head)
    const cached = this.historyCache.get(requirementId)
    if (cached?.head === head) return structuredClone(cached.history)
    const output = this.git(['log', `--format=${VERSION_FORMAT}%x1e`, head, '--', path])
    const history = output.split('\x1e').map(row => row.trim()).filter(Boolean).map(parseMetadata)
    this.historyCache.set(requirementId, { head, history })
    return structuredClone(history)
  }

  diff(requirementId: string, baseCommit: string, headCommit = this.head(requirementId)): string {
    assertCommit(baseCommit)
    assertCommit(headCommit)
    return this.git(['diff', baseCommit, headCommit, '--', this.relativeSpecPath(requirementId)])
  }

  commitUrl(commit: string): string | undefined {
    if (!SHA.test(commit)) return undefined
    if (this.commitBaseUrl === undefined) {
      try {
        const origin = this.git(['config', '--get', 'remote.origin.url']).trim()
        const scp = /^git@([^:]+):(.+)$/.exec(origin)
        const url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : origin.replace(/^ssh:\/\/git@/, 'https://'))
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported remote URL')
        url.username = ''; url.password = ''
        this.commitBaseUrl = url.toString().replace(/\.git$/, '').replace(/\/$/, '')
      } catch {
        this.commitBaseUrl = null
      }
    }
    return this.commitBaseUrl === null ? undefined : `${this.commitBaseUrl}/commit/${commit}`
  }

  head(requirementId: string): string {
    return this.requirementHead(requirementId, this.repositoryHead())
  }

  private requirementHead(requirementId: string, repositoryHead: string | undefined): string {
    const path = this.relativeSpecPath(requirementId)
    return repositoryHead === undefined ? '' : this.git(['log', '-1', '--format=%H', repositoryHead, '--', path]).trim()
  }

  private assertCurrent(requirementId: string, baseCommit: string): string {
    const head = this.repositoryHead()
    const current = this.requirementHead(requirementId, head)
    if (current !== baseCommit) throw new VersionConflictError(current)
    if (head === undefined || current === '') throw new Error('requirement spec not found')
    return head
  }

  private prepareCommit(change: Omit<PreparedSpecCommit, 'commit'>, participant: ParticipantSnapshot, summary: string, markdown?: string): PreparedSpecCommit {
    const path = this.relativeSpecPath(change.requirementId)
    this.assertClean(path)
    if (change.operation === 'create' && existsSync(join(this.root, path))) throw new Error('requirement spec already exists')
    const temporary = mkdtempSync(join(tmpdir(), 'spec-git-index-'))
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') }
      this.git(['read-tree', change.baseHead ?? '--empty'], { env })
      if (markdown === undefined) {
        this.git(['update-index', '--force-remove', '--', path], { env })
      } else {
        const blob = this.git(['hash-object', '-w', '--stdin'], { input: markdown }).trim()
        this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env })
      }
      const tree = this.git(['write-tree'], { env }).trim()
      const parent = change.baseHead ? ['-p', change.baseHead] : []
      const email = `${participant.participantId}@dsh.local`
      const commit = this.git(['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...parent, '-m', summary, '-m', `DSH-Role: ${participant.role}`], {
        env: { ...env, GIT_AUTHOR_NAME: participant.nickname, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: participant.nickname, GIT_COMMITTER_EMAIL: email },
      }).trim()
      return { ...change, commit }
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }

  private assertClean(path: string): void {
    const fullPath = join(this.root, path)
    const stat = lstatSync(fullPath, { throwIfNoEntry: false })
    if ((stat && !stat.isFile()) || this.git(['status', '--porcelain', '--untracked-files=all', '--', path]).trim() !== '') {
      throw new Error('spec has external uncommitted changes')
    }
  }

  private assertRecoverableCheckout(change: PreparedSpecCommit, path: string): void {
    // After the ref moves, either side of the transaction is a valid checkout of this path.
    const previous = change.operation === 'create' ? undefined : this.body(change.requirementId, change.baseHead!)
    const next = change.operation === 'delete' ? undefined : this.body(change.requirementId, change.commit)
    const fullPath = join(this.root, path)
    const stat = lstatSync(fullPath, { throwIfNoEntry: false })
    if (stat && !stat.isFile()) throw new Error('spec has external uncommitted changes')
    const actual = stat ? readFileSync(fullPath, 'utf8') : undefined
    if (actual !== previous && actual !== next) throw new Error('spec has external uncommitted changes')

    const entry = this.git(['ls-files', '--stage', '-z', '--', path])
    const matchesIndex = (body: string | undefined): boolean => {
      if (body === undefined) return entry === ''
      const hash = this.git(['hash-object', '--stdin'], { input: body }).trim()
      return entry === `100644 ${hash} 0\t${path}\0`
    }
    if (!matchesIndex(previous) && !matchesIndex(next)) throw new Error('spec has external staged changes')
  }

  private repositoryHead(): string | undefined {
    try { return this.git(['rev-parse', '--verify', '--quiet', 'HEAD']).trim() }
    catch (error) { if ((error as { status?: number }).status === 1) return undefined; throw error }
  }

  private body(requirementId: string, commit: string): string {
    assertCommit(commit)
    return this.git(['show', `${commit}:${this.relativeSpecPath(requirementId)}`])
  }

  private relativeSpecPath(id: string): string {
    if (!REQUIREMENT_ID.test(id)) throw new Error('invalid requirement id')
    return `requirements/${id}/spec.md`
  }

  private git(args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
    return execFileSync('git', args, { ...options, cwd: this.root, encoding: 'utf8', stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: GIT_BUFFER_LIMIT })
  }
}

export function isPreparedSpecCommit(value: unknown): value is PreparedSpecCommit {
  if (typeof value !== 'object' || value === null) return false
  const { requirementId, operation, baseHead, commit } = value as Partial<PreparedSpecCommit>
  return typeof requirementId === 'string' && REQUIREMENT_ID.test(requirementId)
    && (operation === 'create' || operation === 'update' || operation === 'delete')
    && typeof commit === 'string' && SHA.test(commit)
    && (baseHead === undefined ? operation === 'create' : typeof baseHead === 'string' && SHA.test(baseHead))
}

const VERSION_FORMAT = '%H%x1f%P%x1f%at%x1f%an%x1f%ae%x1f%B'

function parseMetadata(row: string): VersionMetadata {
  const [commit = '', parents = '', seconds = '0', nickname = 'unknown', email = '', ...bodyParts] = row.split('\x1f')
  const body = bodyParts.join('\x1f').trim()
  const role = /DSH-Role:\s*(product|engineering)/.exec(body)?.[1] as ParticipantSnapshot['role'] | undefined
  const parentCommit = parents.split(' ')[0]
  return {
    commit,
    ...(parentCommit ? { parentCommit } : {}),
    author: { participantId: email.replace(/@dsh\.local$/, '') || 'unknown', nickname, role: role ?? 'product', kind: 'human' },
    summary: body.split('\n')[0] ?? 'Saved version',
    createdAt: Number(seconds) * 1000,
  }
}

function validateSize(markdown: string): void {
  if (markdown.length > 2_000_000) throw new Error('spec exceeds 2 MB')
}

function assertCommit(commit: string): void {
  if (!SHA.test(commit)) throw new Error('invalid commit')
}

function slug(title: string): string {
  const value = title.toLowerCase().trim().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  return value || 'requirement'
}

function initialSpec(title: string, raw: string, sources: SourceReference[]): string {
  const sourceLines = sources.length === 0 ? ['- 原始需求：当前文档（创建版本）'] : sources.map(item => `- [${item.accessStatus}] ${item.label}${item.stableId ? ` — ${item.stableId}` : ''}`)
  return [`# ${title}`, '', '## 原始需求与来源', '', raw.trim(), '', ...sourceLines, '', '## 目标与用户结果', '', '<!-- AI 初审后补充 -->', '', '## 范围与非范围', '', '### 范围', '', '### 非范围', '', '## 业务术语与规则', '', '## 需求与验收标准', '', '- **AC-1**：待澄清', '', '## 异常、权限与兼容', '', '## 测试约束', '', '## 待补充资料', ''].join('\n')
}
