import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import { satisfies } from 'semver'
import * as plugin from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const supportedRuntimes = ['0.2.1-rc.5', '0.2.1', '0.2.2-rc.1', '0.2.2']

describe('DSH compatibility contract', () => {
  it.each(supportedRuntimes)('accepts the supported runtime %s without an exemption', runtimeVersion => {
    expect(evaluatePluginCompatibility(manifest, {}, runtimeVersion)).toBeUndefined()
    const { dsh: _dsh, ...otherEngines } = manifest.engines
    expect(evaluatePluginCompatibility({ ...manifest, engines: otherEngines }, {}, runtimeVersion)).toBeUndefined()
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(satisfies(runtimeVersion, range as string)).toBe(true)
    }
  })

  it.each(['0.1.1-rc.1', '0.2.1-rc.4', '0.2.2-rc.0', '0.2.3-rc.1', '0.2.3', '0.3.0-rc.1'])('rejects runtimes outside the supported SDK window: %s', runtimeVersion => {
    expect(evaluatePluginCompatibility(manifest, {}, runtimeVersion)).toMatchObject({ exempted: false })
  })

  it('reproduces the published 0.4.0 exact-peer rejection after a DSH upgrade', () => {
    expect(evaluatePluginCompatibility({ name: 'dsh-spec-collab', version: '0.4.0', peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.1-rc.5' } }, {}, '0.2.2-rc.1')).toMatchObject({ requirements: { '@deepseek-ai/dsh-tools': '0.2.1-rc.5' }, exempted: false })
  })

  it('activates through the current Cordis loader and releases its routes, tools and prompt', async () => {
    const ctx = new Context()
    const routes = new Set<string>()
    const tools = new Set<string>()
    const sections = new Set<string>()
    ctx.provide('webServer', { register: (route: { path: string }) => { routes.add(route.path); return () => { routes.delete(route.path) } } })
    ctx.provide('tools', { register: (tool: { name: string }) => { tools.add(tool.name); return () => { tools.delete(tool.name) } } })
    ctx.provide('systemPrompt', { section: (section: { name: string }) => { sections.add(section.name); return () => { sections.delete(section.name) } } })
    ctx.provide('sessionController', {})
    ctx.provide('workspaceRegistry', { list: () => [] })
    ctx.provide('agentPresets', { list: async () => [] })
    try {
      const fiber = await ctx.plugin(plugin, { dataRoot: mkdtempSync(join(tmpdir(), 'spec-collab-dsh-compat-')) })
      expect(routes).toContain('/api/spec-collab/review-workspaces')
      expect(routes).toContain('/api/spec-collab/state')
      expect(tools).toEqual(new Set(['spec_list', 'spec_read', 'spec_reply', 'spec_submit_review', 'spec_propose_patch']))
      expect(sections).toContain('plugin:spec-collab')
      await fiber.dispose()
      expect(routes.size).toBe(0)
      expect(tools.size).toBe(0)
      expect(sections.size).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
