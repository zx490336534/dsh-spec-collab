import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const evidence = mkdtempSync(join(tmpdir(), 'spec-collab-ablation-'))
const baseline = process.argv[2] ?? 'e14eb41'
const revisions = execFileSync('git', ['rev-parse', '--verify', `${baseline}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
const consistency = 'tests/consistency.spec.ts'
const ready = 'tests/ready-admission.spec.ts'
const cases = {
  versions: 'reopens a Ready requirement and retires old patches on rename',
  signers: 'exports only current whole-version human signers',
  events: 'publishes one complete collaboration revision even if a subscriber throws',
  batch: 'keeps the ledger untouched when a later item invalidates an AI review batch',
  callbacks: 'writes a delayed comment launch after a rejected action',
  terminal: 'keeps an AI comment reply completed when prompt admission resolves later',
  index: 'commits only the spec and leaves another staged path intact',
  journal: 'does not move Git or launch review when the recovery record cannot be written',
  recovery: 'recovers a save interrupted after-ref',
  gate: 'rejects generation without engineering precheck even when both roles confirmed and all six checks pass',
}

const experiments = [
  {
    name: 'without-version-invalidation', test: cases.versions, file: 'src/spec-lifecycle.ts',
    before: "  delete record.readyPackage\n  if (record.stage === 'ready') enterStage(record, 'joint-review')",
    after: '',
  },
  {
    name: 'without-whole-version-signer-scope', test: cases.signers, file: 'src/ready-admission.ts',
    before: " && item.scope === 'version'", after: '',
  },
  {
    name: 'without-subscriber-isolation', test: cases.events, file: 'src/engine.ts',
    before: "      try { listener(event) }\n      catch { this.listeners.delete(listener) }", after: '      listener(event)',
  },
  {
    name: 'without-isolated-draft', test: cases.batch, file: 'src/engine.ts',
    before: '    this.state = structuredClone(before)', after: '',
  },
  {
    name: 'without-current-task-lookup', test: cases.callbacks, file: 'src/engine.ts',
    before: `    void pending.then(
      sessionId => this.recordAiSession(view, task, sessionId),`,
    after: `    const recordAtLaunch = this.state.requirements.find(item => item.id === view.id)!
    void pending.then(
      sessionId => this.recordAiSession(recordAtLaunch, task, sessionId),`,
    extra: {
      before: `  private recordAiSession(view: Pick<RequirementView, 'id' | 'stage' | 'stageCycle'>, task: AiTask, sessionId: string): void {
    this.changeAi(() => {
      const record = this.state.requirements.find(item => item.id === view.id)`,
      after: `  private recordAiSession(view: RequirementRecord, task: AiTask, sessionId: string): void {
    this.changeAi(() => {
      const record = view`,
    },
  },
  {
    name: 'without-terminal-status-guard', test: cases.terminal, file: 'src/engine.ts',
    before: "        if (comment.aiStatus === 'queued') comment.aiStatus = 'running'", after: "        comment.aiStatus = 'running'",
  },
  {
    name: 'without-isolated-index', test: cases.index, file: 'src/git-store.ts',
    before: "      this.git(['read-tree', change.baseHead ?? '--empty'], { env })",
    after: `      const realIndex = join(this.root, '.git', 'index')
      if (existsSync(realIndex)) copyFileSync(realIndex, env.GIT_INDEX_FILE)
      else this.git(['read-tree', change.baseHead ?? '--empty'], { env })`,
    extra: { before: 'import { existsSync,', after: 'import { copyFileSync, existsSync,' },
  },
  {
    name: 'without-write-ahead-order', test: cases.journal, file: 'src/collaboration-ledger.ts',
    before: '    atomicWrite(this.pendingPath, { state, spec })\n    try {\n      this.finish(state, spec)',
    after: '    this.publishSpec(spec)\n    atomicWrite(this.pendingPath, { state, spec })\n    try {\n      this.finish(state)',
  },
  {
    name: 'without-git-ref-recovery', test: cases.recovery, file: 'src/git-store.ts',
    before: '      this.assertRecoverableCheckout(change, path)', after: "      throw new Error('cannot resume after the Git ref moved')",
  },
  {
    name: 'without-engineering-precheck', test: cases.gate, file: 'src/ready-admission.ts',
    before: "    : !engineeringReviewed ? 'engineering precheck is required for the current version'\n", after: '',
  },
]

function fixture(name, fromBaseline = false) {
  const cwd = mkdtempSync(join(evidence, `${name}-`))
  if (fromBaseline) {
    const archive = execFileSync('git', ['archive', '--format=tar', revisions, 'src', 'tests', 'package.json', 'tsconfig.json'], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
    execFileSync('tar', ['-xf', '-', '-C', cwd], { input: archive })
    copyFileSync(join(root, consistency), join(cwd, consistency))
  } else {
    for (const entry of ['src', 'tests', 'package.json', 'tsconfig.json']) cpSync(join(root, entry), join(cwd, entry), { recursive: true })
  }
  symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'), 'junction')
  return cwd
}

function replace(source, change) {
  if (source.split(change.before).length !== 2) throw new Error(`Expected one match in ${change.file ?? 'the second edit'}`)
  return source.replace(change.before, change.after)
}

const results = []
function run(name, cwd, selected, expectedFailures) {
  const json = join(evidence, `${name}.json`)
  const pattern = selected.map(test => test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', consistency, ready, '--maxWorkers=1', '--minWorkers=1', '--reporter=json', '--outputFile', json, '-t', pattern]
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  writeFileSync(join(evidence, `${name}.log`), `${result.stdout}${result.stderr}`)
  const report = JSON.parse(readFileSync(json, 'utf8'))
  const assertions = report.testResults.flatMap(file => file.assertionResults).filter(assertion => ['failed', 'passed'].includes(assertion.status))
  const byName = new Map(assertions.map(assertion => [assertion.title, assertion.status]))
  const expected = new Set(expectedFailures)
  const valid = assertions.length === selected.length && selected.every(test => byName.get(test) === (expected.has(test) ? 'failed' : 'passed'))
    && result.status === (expected.size ? 1 : 0)
  results.push({ name, valid, exitCode: result.status, passed: assertions.filter(test => test.status === 'passed').map(test => test.title), failed: assertions.filter(test => test.status === 'failed').map(test => test.title) })
  console.log(`${valid ? 'OK' : 'UNEXPECTED'} ${name} (${assertions.length - report.numFailedTests} passed, ${report.numFailedTests} failed)`)
}

const originalCases = Object.values(cases).slice(0, 7)
const control = 'rejects outside modification of the target spec and preserves that edit'
run('original', fixture('original', true), originalCases, originalCases)
run('complete', fixture('complete'), [...Object.values(cases), control], [])
for (const experiment of experiments) {
  const cwd = fixture(experiment.name)
  const file = join(cwd, experiment.file)
  let source = replace(readFileSync(file, 'utf8'), experiment)
  if (experiment.extra) source = replace(source, experiment.extra)
  writeFileSync(file, source)
  run(experiment.name, cwd, [experiment.test, control], [experiment.test])
}
writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ baseline: revisions, node: process.version, results }, null, 2) + '\n')
console.log(`Evidence: ${evidence}`)
if (results.some(result => !result.valid)) process.exitCode = 1
