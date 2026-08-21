import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const id = 'dsh-spec-collab'
const cssPrefix = '\0spec-collab-css:'
const cssSuffix = '.mjs'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' }, outDir: 'lib', format: ['esm'], platform: 'node',
    target: 'es2022', dts: false, sourcemap: false, clean: false, fixedExtension: false,
    deps: { neverBundle: /^@deepseek-ai\// },
  },
  {
    entry: { client: 'src/client/index.ts' }, outDir: 'lib', format: ['cjs'], platform: 'browser',
    target: 'es2022', dts: false, sourcemap: false, clean: false, fixedExtension: false,
    deps: {
      neverBundle: (specifier: string) => ['react', 'react/jsx-runtime', 'react-dom/client'].includes(specifier),
      alwaysBundle: (specifier: string) => !['react', 'react/jsx-runtime', 'react-dom/client'].includes(specifier),
    },
    plugins: [{
      name: 'spec-collab-css-modules',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        return cssPrefix + resolve(importer === undefined ? process.cwd() : dirname(importer), source) + cssSuffix
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(cssPrefix)) return null
        const file = virtualId.slice(cssPrefix.length, -cssSuffix.length)
        this.addWatchFile(file)
        const result = transform({ filename: file, code: await readFile(file), cssModules: { pattern: '[hash]_[local]' }, minify: true })
        const classes: Record<string, string> = {}
        for (const [local, value] of Object.entries(result.exports ?? {})) classes[local] = value.name
        const vendorFile = resolve('node_modules/@toast-ui/editor/dist/toastui-editor.css')
        this.addWatchFile(vendorFile)
        const vendor = transform({ filename: vendorFile, code: await readFile(vendorFile), minify: true }).code.toString()
        const css = vendor + result.code.toString()
        return [
          `const css=${JSON.stringify(css)};`,
          `const tagId=${JSON.stringify(`${id}/workbench`)};`,
          'if(typeof document!=="undefined"&&!document.querySelector(`style[data-plugin-css="${tagId}"]`)){const tag=document.createElement("style");tag.dataset.plugin="dsh-spec-collab";tag.dataset.pluginCss=tagId;tag.textContent=css;document.head.appendChild(tag)}',
          `export default ${JSON.stringify(classes)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
