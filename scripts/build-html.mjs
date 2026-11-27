import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundleDir = await mkdtemp(join(tmpdir(), 'spec-collab-html-'))
try {
  await build({
    cwd: root,
    config: false,
    entry: ['demo/main.ts'],
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    minify: true,
    outDir: bundleDir,
  })

  const files = await readdir(bundleDir)
  const bundle = files.find(name => name.endsWith('.js'))
  if (!bundle || files.length !== 1) throw new Error('Expected one self-contained JavaScript bundle')

  const [template, script] = await Promise.all([
    readFile(join(root, 'demo/index.html'), 'utf8'),
    readFile(join(bundleDir, bundle), 'utf8'),
  ])
  const marker = '<!-- SPEC_COLLAB_BUNDLE -->'
  if (template.split(marker).length !== 2) throw new Error('Expected one bundle marker')
  const html = template.replace(marker, () => `<script>${script.replace(/<\/(script)/gi, '<\\/$1')}</script>`)

  const outputDir = join(root, 'dist')
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, 'spec-collab.html'), html)
  process.stdout.write('Built dist/spec-collab.html\n')
} finally {
  await rm(bundleDir, { recursive: true, force: true })
}
