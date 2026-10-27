import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const cliManifest = require.resolve('@deepseek-ai/dsh/package.json')
const cliRoot = dirname(cliManifest)
const cliRequire = createRequire(cliManifest)
const bootLib = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
const cmdline = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-cmdline')).href)
const launch = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-launch-environment')).href)
const environment = bootLib.loadLayeredEnv('dsh')
const profile = bootLib.loadProfile('dsh', 'web', cliManifest)
const patches = [...profile.layers.flatMap(layer => layer.patches), ...profile.patches,
  { id: 'agent-presets', config: { default: 'standard', roots: [{ path: join(cliRoot, 'config/agent-presets'), trust: 'system' }] } },
  { id: 'session-telemetry-otel', disabled: true },
]
const ctx = await bootLib.boot('dsh-ready-acceptance', join(profile.dir, 'cordis.yml'), patches, hostCtx => {
  hostCtx.provide(launch.DSH_LAUNCH_ENVIRONMENT_KEY, environment)
  cmdline.provideCmdline(hostCtx, { args: ['--host', '127.0.0.1', '--port', process.env.READY_ACCEPTANCE_PORT ?? '0', '--no-open'], exit: code => { process.exitCode = code } })
})
console.log(JSON.stringify({ acceptanceBoot: 'official boot and profile composition; CLI user-config watcher omitted', dshVersion: JSON.parse(readFileSync(cliManifest, 'utf8')).version, apiProxyAvailable: ctx.get('apiProxy') !== undefined }))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await ctx.fiber.dispose(); process.exit(0) })
