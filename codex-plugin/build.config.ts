import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { defineConfig } from 'tsdown'
import { workbenchCss } from '../tsdown.config.ts'

export default defineConfig([
  {
    entry: { workbench: 'src/workbench.ts' },
    outDir: 'runtime', format: ['esm'], platform: 'node',
    target: 'node20', dts: false, clean: false, sourcemap: false,
    outputOptions: { entryFileNames: '[name].mjs' },
  },
  {
    entry: { workbench: 'src/browser.tsx' },
    outDir: 'runtime', format: ['esm'], platform: 'browser',
    target: 'es2022', dts: false, clean: false, minify: true, sourcemap: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    deps: { alwaysBundle: () => true },
    outputOptions: { entryFileNames: '[name].js', comments: { legal: true } },
    plugins: [
      workbenchCss,
      {
        name: 'spec-collab-third-party-notices',
        generateBundle(_options, bundle) {
          const packages = new Map<string, string>()
          for (const chunk of Object.values(bundle)) {
            if (chunk.type !== 'chunk') continue
            for (const id of Object.keys(chunk.modules)) {
              if (!id.includes('/node_modules/')) continue
              let dir = dirname(id)
              while (dir !== parse(dir).root && !existsSync(join(dir, 'package.json'))) dir = dirname(dir)
              const { name, version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
              if (!name || !version) continue
              const key = `${name}@${version}`
              if (packages.has(key)) continue
              const notices = readdirSync(dir).filter(file => /^(licen[sc]e|notice|copying)([.-]|$)/i.test(file)).sort()
              if (notices.length === 0 && key === '@toast-ui/editor@3.2.2') {
                packages.set(key, readFileSync('codex-plugin/licenses/toast-ui-editor-3.2.2.txt', 'utf8').trim())
                continue
              }
              if (notices.length === 0) throw new Error(`Missing distribution license for ${key}`)
              packages.set(key, notices.map(file => readFileSync(join(dir, file), 'utf8').trim()).join('\n\n'))
            }
          }
          const source = ['Third-party licenses for workbench.js', ...[...packages].sort(([a], [b]) => a.localeCompare(b))
            .map(([key, notice]) => `${key}\n${'='.repeat(key.length)}\n${notice}`)].join('\n\n') + '\n'
          this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source })
          this.emitFile({ type: 'asset', fileName: 'LICENSE', source: readFileSync('LICENSE') })
        },
      },
    ],
  },
])
