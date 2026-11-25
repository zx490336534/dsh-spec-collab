import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { withWorkbench } from './harness.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const pluginId = 'spec-collab@dsh-spec-collab'

test('Codex installs the package, loads the cached skill, and calls all three MCP tools', { timeout: 45_000 }, async t => {
  const app = await withWorkbench()
  t.after(() => app.dispose())
  const home = join(app.root, 'codex-home')
  await mkdir(home)
  const env = { ...app.env, CODEX_HOME: home }
  const codex = args => JSON.parse(execFileSync('codex', [...args, '--json'], { env, encoding: 'utf8', timeout: 15_000 }))
  assert.equal(codex(['plugin', 'marketplace', 'add', repo]).marketplaceName, 'dsh-spec-collab')
  const installed = codex(['plugin', 'add', pluginId])
  assert.equal(installed.pluginId, pluginId)
  await access(join(installed.installedPath, 'runtime', 'workbench.js'))

  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd: app.project, env, stdio: ['pipe', 'pipe', 'ignore'] })
  t.after(() => child.kill())
  let id = 0
  const pending = new Map()
  createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line)
    pending.get(response.id)?.(response)
  })
  const call = (method, params) => new Promise((resolve, reject) => {
    const sequence = ++id
    const timer = setTimeout(() => {
      pending.delete(sequence)
      reject(new Error(method + ' timed out'))
    }, 10_000)
    pending.set(sequence, response => {
      pending.delete(sequence)
      clearTimeout(timer)
      if (response.error) reject(new Error(method + ' ' + JSON.stringify(response.error)))
      else resolve(response.result)
    })
    child.stdin.write(JSON.stringify({ id: sequence, method, params }) + '\n')
  })
  await call('initialize', { clientInfo: { name: 'spec-collab-test', version: '1.0.0' }, capabilities: { experimentalApi: true } })
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
  const listing = await call('plugin/list', { cwds: [app.project] })
  const plugin = listing.marketplaces.find(entry => entry.name === installed.marketplaceName)?.plugins.find(item => item.name === 'spec-collab')
  assert.ok(plugin?.enabled && plugin.installed)
  const skills = await call('skills/list', { cwds: [app.project], forceReload: true })
  assert.ok(skills.data.some(workspace => workspace.skills.some(skill =>
    skill.name === 'spec-collab:spec-collab' && skill.path.startsWith(installed.installedPath))))

  const { thread } = await call('thread/start', { cwd: app.project, ephemeral: true })
  const status = await call('mcpServerStatus/list', { serverName: 'spec-collab', threadId: thread.id })
  assert.deepEqual(Object.keys(status.data[0].tools).sort(), ['spec_list', 'spec_read', 'spec_workbench'])
  const tool = (name, args) => call('mcpServer/tool/call', { threadId: thread.id, server: 'spec-collab', tool: name, arguments: args })
  const open = await tool('spec_workbench', { workspacePath: app.project })
  assert.ok(!open.isError, JSON.stringify(open.content))
  const { url, workspace } = JSON.parse(open.content[0].text)
  assert.equal((await fetch(url)).status, 200)
  await access(join(app.data, 'workspaces.json'))
  assert.ok(workspace.path.endsWith('/订单报表验证项目'))
  const list = await tool('spec_list', {})
  assert.deepEqual(JSON.parse(list.content[0].text).requirements, [])
  assert.equal((await tool('spec_read', { requirementId: '未知需求' })).isError, true)
  child.stdin.end()
})
