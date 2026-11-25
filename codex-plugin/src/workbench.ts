import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { atomicWrite } from '../../src/collaboration-ledger.ts'
import { CollaborationEngine } from '../../src/engine.ts'
import { GitRequirementStore } from '../../src/git-store.ts'
import type { ReviewWorkspaceSummary } from '../../src/protocol.ts'
import { makeRoutes } from '../../src/routes.ts'
import { startMcp, validToolArgs } from './mcp.ts'
import { CodexReviewCoordinator } from './review.ts'

const configuredRoot = resolve(process.env.SPEC_COLLAB_DATA_DIR ||
  join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'spec-collab'))
mkdirSync(configuredRoot, { recursive: true, mode: 0o700 })
const root = realpathSync(configuredRoot)
const host = '127.0.0.1'
const port = 20_000 + createHash('sha256').update(root).digest().readUInt32BE() % 12_000
const origin = `http://${host}:${port}`
const tokenPath = join(root, 'service-token.json')
const registryPath = join(root, 'workspaces.json')
const internalPath = '/_spec-collab/control'
const page = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spec Collab for Codex</title><link rel="stylesheet" href="/shell.css"><script type="module" src="/workbench.js"></script></head><body><header>Spec Collab <span>for Codex</span></header><div id="workbench"></div></body></html>'
const style = 'body{margin:0;height:100vh;height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr);font:14px system-ui,sans-serif}body>header{padding:9px 18px;background:#202434;color:#fff;font-weight:650;letter-spacing:.015em}body>header span{color:#c6cde3;font-weight:400;margin-inline-start:6px}#workbench{min-height:0;min-width:0}'

function listWorkspaces(): ReviewWorkspaceSummary[] {
  return existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) as ReviewWorkspaceSummary[] : []
}

function registerWorkspace(input: string): ReviewWorkspaceSummary {
  if (!isAbsolute(input)) throw new Error('请提供项目的绝对目录路径')
  let path: string
  try {
    path = realpathSync(input)
    if (!statSync(path).isDirectory()) throw new Error()
  } catch {
    throw new Error('项目目录不存在或无法读取')
  }
  const list = listWorkspaces()
  const existing = list.find(workspace => workspace.path === path)
  if (existing) return existing
  const workspaceId = createHash('sha256').update(path).digest('hex').slice(0, 32)
  const workspace = { workspaceId, title: basename(path) || path, path }
  atomicWrite(registryPath, [...list, workspace])
  return workspace
}

function serve(): void {
  const script = readFileSync(new URL('./workbench.js', import.meta.url))
  const token = randomBytes(32).toString('hex')
  const server = createServer()
  server.once('error', error => console.error('Spec Collab 启动失败：', error.message))
  server.listen(port, host, () => {
    // Ownership of this port is required before opening the Git store or recovering the ledger.
    const engine = new CollaborationEngine(join(root, 'collaboration-v3.json'), new GitRequirementStore(join(root, 'repository')))
    const coordinator = new CodexReviewCoordinator(engine, root, listWorkspaces)
    engine.setCoordinator(coordinator, { recoverRunning: true })
    const routes = new Map(makeRoutes(engine, coordinator).flatMap(route => route.kind === 'exact' ? [[route.path, route.handler] as const] : []))
    const assets = new Map([
      ['/', { type: 'text/html; charset=utf-8', body: page }],
      ['/shell.css', { type: 'text/css; charset=utf-8', body: style }],
      ['/workbench.js', { type: 'text/javascript; charset=utf-8', body: script }],
    ])
    const stop = () => {
      coordinator.dispose()
      server.close()
      server.closeAllConnections()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    server.on('request', (req, res) => {
      void handle(req, res).catch(error => {
        if (res.headersSent) return res.destroy()
        const message = error instanceof Error ? error.message : '工作台请求失败'
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, error: message }))
      })
    })
    atomicWrite(tokenPath, token)

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
      if (req.headers.host !== `${host}:${port}` || (req.headers.origin !== undefined && req.headers.origin !== origin)) {
        res.writeHead(403).end()
        return
      }
      const path = new URL(req.url ?? '/', origin).pathname
      if (path === internalPath) {
        if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += (chunk as Buffer).length
          if (size > 32_768) throw new Error('工具请求过大')
          chunks.push(chunk as Buffer)
        }
        const { method, args } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        let result: unknown = { url: origin }
        if (method === 'stop') res.once('finish', stop)
        else if (method !== 'health') {
          validToolArgs(method, args)
          if (method === 'spec_workbench') result = { url: origin, ...(args.workspacePath ? { workspace: registerWorkspace(args.workspacePath) } : {}) }
          else if (method === 'spec_list') {
            result = { url: origin, requirements: engine.summaries().map(item => ({
              id: item.id, title: item.title, stage: item.stage, commit: item.currentCommit, archived: Boolean(item.archivedAt),
              risks: item.metrics.riskCount,
            })) }
          } else {
            const view = engine.view(args.requirementId!)
            const content = {
              spec: view.version.markdown, 'review-items': view.reviewItems, patches: view.patches,
              comments: view.comments, decisions: view.decisions, confirmations: view.confirmations,
              sources: view.sources, readiness: view.readiness, ready: view.readyPackage ?? null,
            }
            result = { id: view.id, title: view.title, stage: view.stage, commit: view.currentCommit,
              url: `${origin}/#spec-collab/${encodeURIComponent(view.id)}/tasks`,
              workspaceId: view.workspaceId, aiRuns: view.aiRuns,
              ...Object.fromEntries(Object.entries(content).filter(([section]) => args.include?.includes(section) ?? true)),
            }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result))
        return
      }
      if (req.method === 'POST' && req.headers.origin !== origin) { res.writeHead(403).end(); return }
      const route = routes.get(path)
      if (route) { await route(req, res); return }
      const asset = assets.get(path)
      if (asset && req.method === 'GET') { res.writeHead(200, { 'content-type': asset.type }).end(asset.body); return }
      res.writeHead(404).end()
    }
  })
}

async function control(method: string, args?: unknown): Promise<Response | undefined> {
  try {
    const token: string = JSON.parse(readFileSync(tokenPath, 'utf8'))
    const response = await fetch(origin + internalPath, {
      method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(2_000),
    })
    return response.status === 403 ? undefined : response
  } catch { return undefined }
}

let startup: Promise<void> | undefined
async function startService(): Promise<void> {
  if ((await control('health'))?.ok) return
  const log = openSync(join(root, 'service.log'), 'a', 0o600)
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
      detached: true, stdio: ['ignore', log, log], windowsHide: true,
    })
    child.on('error', () => {})
    child.unref()
  } finally { closeSync(log) }
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await control('health'))?.ok) return
    await delay(100)
  }
  throw new Error('本机工作台未启动，请查看 Spec Collab 数据目录的 service.log')
}

async function call(method: string, args: unknown): Promise<unknown> {
  validToolArgs(method, args)
  startup ??= startService().finally(() => { startup = undefined })
  await startup
  const response = await control(method, args)
  if (!response) throw new Error('工作台连接已中断，请重试')
  const result = await response.json() as { error?: string }
  if (!response.ok) throw new Error(result.error || '工作台请求失败')
  return result
}

const command = process.argv[2]
if (command === 'serve') serve()
else if (command === 'open') {
  const workspacePath = process.argv[3] ? resolve(process.argv[3]) : process.cwd()
  try { console.log(JSON.stringify(await call('spec_workbench', { workspacePath }), null, 2)) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
} else if (command === 'stop') {
  const response = await control('stop')
  console.log(response?.ok ? 'Spec Collab 已停止' : 'Spec Collab 当前未运行')
} else startMcp(call)
