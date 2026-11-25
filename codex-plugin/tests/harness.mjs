import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const runtime = fileURLToPath(new URL('../runtime/workbench.mjs', import.meta.url))
const fakeCodex = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))

export async function withWorkbench({ live = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'spec-collab-test-'))
  const project = join(root, '订单报表验证项目')
  const data = join(root, 'data')
  const env = { ...process.env, SPEC_COLLAB_DATA_DIR: data, ...(live ? {} : { SPEC_COLLAB_CODEX: fakeCodex }) }
  await mkdir(project)
  await writeFile(join(project, 'README.md'), '# 订单报表验证项目\n\n运营报表当前只能在页面上查看，日期筛选已实现。当前没有 CSV 导出。\n')
  await writeFile(join(project, 'report.js'), "export const capabilities = { dateFilter: true, csvExport: false };\n")
  execFileSync('git', ['init', '-q', project])
  execFileSync('git', ['-C', project, 'add', '.'])
  execFileSync('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Seed report fixture'])
  const clients = new Set()
  const register = (path = project) => JSON.parse(execFileSync(process.execPath, [runtime, 'open', path], { env, encoding: 'utf8' }))
  const stop = () => execFileSync(process.execPath, [runtime, 'stop'], { env, encoding: 'utf8' }).trim()
  return {
    root, project, data, env, register, stop,
    mcp() {
      const child = spawn(process.execPath, [runtime], { env, stdio: ['pipe', 'pipe', 'inherit'] })
      clients.add(child)
      child.on('exit', () => clients.delete(child))
      const queue = new Map()
      let nextId = 1
      createInterface({ input: child.stdout }).on('line', line => {
        const response = JSON.parse(line)
        const pending = queue.get(response.id)
        if (pending) {
          clearTimeout(pending.timer)
          queue.delete(response.id)
          pending.resolve(response.result ?? response.error)
        }
      })
      return (method, params) => new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          queue.delete(id)
          reject(new Error(`No MCP response to ${method}`))
        }, 9_000)
        queue.set(id, { resolve, timer })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    async dispose() {
      for (const child of clients) child.stdin.end()
      stop()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export async function action(url, input, requestId = randomUUID()) {
  const response = await fetch(url + '/api/spec-collab/action', {
    method: 'POST', headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, action: input }),
  })
  return { status: response.status, ...await response.json() }
}

export async function change(url, input) {
  const result = await action(url, input)
  assert.equal(result.ok, true, result.error)
  return result.requirement
}

export async function view(url, id) {
  const response = await fetch(url + '/api/spec-collab/state?' + new URLSearchParams({ requirementId: id }))
  return (await response.json()).requirement
}

export async function until(fn, timeout = 12_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await delay(150)
  }
  throw new Error('等待审核、写入或服务状态超时')
}

export async function review(url, requirement, kind, status = 'completed', timeout) {
  return until(async () => {
    const current = await view(url, requirement.id)
    return current?.aiRuns.some(run => run.commit === requirement.currentCommit && run.kind === kind && run.status === status) ? current : undefined
  }, timeout)
}
