import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'

const MAX_FILES = 20
const MAX_FILE_BYTES = 16 * 1024
const MAX_TOTAL_BYTES = 64 * 1024
const MAX_DIRECTORY_DEPTH = 4
const MAX_ROOT_ENTRIES = 80

const PROJECT_CONTEXT_FILES = new Set([
  'agents.md', 'context.md', 'contributing.md', 'package.json', 'pyproject.toml', 'cargo.toml',
  'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'requirements.txt', 'gemfile',
])
const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg',
  '.conf', '.properties', '.gradle', '.kts', '.mod', '.rst', '.adoc',
])
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'lib', 'coverage', '.next', '.cache'])

interface CandidateFile { path: string; displayPath: string }

export async function readWorkspaceSnapshot(workspaceRoot: string, documentPaths: string[]): Promise<string> {
  const root = resolve(workspaceRoot)
  const rows = ['## 插件已读取的工作区快照', `工作区根目录：\`${root}\``]
  const notices: string[] = []
  const candidates: CandidateFile[] = []
  const seen = new Set<string>()

  try {
    const rootEntries = await readdir(root, { withFileTypes: true })
    const visibleEntries = rootEntries
      .filter(entry => !SKIP_DIRECTORIES.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_ROOT_ENTRIES)
      .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
    rows.push(`根目录条目：${visibleEntries.join('、') || '空目录'}`)
    for (const entry of rootEntries) {
      if (!entry.isFile() || !isProjectContextFile(entry.name)) continue
      addCandidate(candidates, seen, resolve(root, entry.name), entry.name)
    }
  } catch (error) {
    rows.push('根目录条目：无法读取')
    notices.push(`- 工作区根目录无法读取：${errorMessage(error)}`)
  }

  for (const configuredPath of documentPaths) {
    const path = isAbsolute(configuredPath) ? resolve(configuredPath) : resolve(root, configuredPath)
    const displayPath = displayWorkspacePath(root, path)
    try {
      const value = await stat(path)
      if (value.isFile()) addCandidate(candidates, seen, path, displayPath)
      else if (value.isDirectory()) await collectDirectory(path, root, candidates, seen, 0)
      else notices.push(`- 无法读取 \`${displayPath}\`：不是普通文件或目录。`)
    } catch (error) {
      notices.push(`- 无法读取 \`${displayPath}\`：${errorMessage(error)}`)
    }
  }

  let totalBytes = 0
  let renderedFiles = 0
  for (const candidate of candidates) {
    if (renderedFiles >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) break
    try {
      const buffer = await readFile(candidate.path)
      if (buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0)) {
        notices.push(`- 跳过二进制文件 \`${candidate.displayPath}\`。`)
        continue
      }
      const availableBytes = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - totalBytes)
      const content = buffer.subarray(0, availableBytes).toString('utf8')
      const truncated = buffer.length > availableBytes
      rows.push('', `### \`${candidate.displayPath}\``, '<workspace-file>', content, truncated ? '\n[内容已截断]' : '', '</workspace-file>')
      totalBytes += Buffer.byteLength(content)
      renderedFiles += 1
    } catch (error) {
      notices.push(`- 无法读取 \`${candidate.displayPath}\`：${errorMessage(error)}`)
    }
  }
  if (candidates.length > renderedFiles) notices.push(`- 工作区快照达到上限，仅注入前 ${renderedFiles} 个可读文本文件。`)
  if (renderedFiles === 0) rows.push('', '未发现可注入的标准项目上下文文件。')
  if (notices.length > 0) rows.push('', '### 读取说明', ...notices)
  return rows.join('\n')
}

async function collectDirectory(directory: string, root: string, candidates: CandidateFile[], seen: Set<string>, depth: number): Promise<void> {
  if (depth > MAX_DIRECTORY_DEPTH || candidates.length >= MAX_FILES) return
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (candidates.length >= MAX_FILES) return
    const path = resolve(directory, entry.name)
    if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) await collectDirectory(path, root, candidates, seen, depth + 1)
    else if (entry.isFile() && isTextFile(entry.name)) addCandidate(candidates, seen, path, displayWorkspacePath(root, path))
  }
}

function addCandidate(candidates: CandidateFile[], seen: Set<string>, path: string, displayPath: string): void {
  if (seen.has(path) || candidates.length >= MAX_FILES) return
  seen.add(path)
  candidates.push({ path, displayPath })
}

function isProjectContextFile(name: string): boolean {
  const lower = name.toLowerCase()
  return PROJECT_CONTEXT_FILES.has(lower) || lower === 'readme' || lower.startsWith('readme.')
}
function isTextFile(name: string): boolean { return isProjectContextFile(name) || TEXT_EXTENSIONS.has(extname(name).toLowerCase()) }
function displayWorkspacePath(root: string, path: string): string {
  const value = relative(root, path)
  return value !== '' && !value.startsWith('..') ? value : path
}
function errorMessage(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return error instanceof Error ? error.message : String(error)
}
