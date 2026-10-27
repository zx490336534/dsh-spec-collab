import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// An isolated copy of Git content plus the SAME regression test proves the before/after difference.
// No reset, checkout, stash, server replacement, or changes to an existing Spec ledger.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const baseline = value('--baseline')
const output = resolve(value('--output') ?? mkdtempSync(join(tmpdir(), 'ready-admission-evidence-')))
mkdirSync(output, { recursive: true })
const commit = execFileSync('git', ['rev-parse', '--verify', `${baseline ?? 'HEAD'}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
let cwd = root
if (baseline) {
  cwd = mkdtempSync(join(tmpdir(), 'ready-admission-baseline-'))
  const archive = execFileSync('git', ['archive', '--format=tar', commit], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
  execFileSync('tar', ['-xf', '-', '-C', cwd], { input: archive })
  copyFileSync(join(root, 'tests/ready-admission.spec.ts'), join(cwd, 'tests/ready-admission.spec.ts'))
  symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'), 'dir')
}
const command = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/ready-admission.spec.ts', '--maxWorkers=1', '--minWorkers=1', '--reporter=verbose']
const runner = value('--node') ?? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()
const startedAt = new Date().toISOString()
const result = spawnSync(runner, command, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
if (result.error) throw result.error
const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
const hashes = {}
for (const path of ['src/engine.ts', 'src/client/workflow.ts', 'src/ready-admission.ts', 'tests/ready-admission.spec.ts']) {
  try { hashes[path] = createHash('sha256').update(readFileSync(join(cwd, path))).digest('hex') } catch (error) { if (error.code !== 'ENOENT') throw error }
}
const metadata = { mode: baseline ? 'baseline-with-current-regression' : 'working-tree', commit, cwd, startedAt, finishedAt: new Date().toISOString(), node: execFileSync(runner, ['--version'], { encoding: 'utf8' }).trim(), command: [runner, ...command], exitCode: result.status, hashes }
writeFileSync(join(output, 'regression.txt'), log)
writeFileSync(join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n')
console.log(log)
console.log(JSON.stringify({ ...metadata, output }, null, 2))
process.exitCode = result.status ?? 1
