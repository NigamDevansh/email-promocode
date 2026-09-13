import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const rootDir = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(rootDir, 'src')

/**
 * Emits dist/manifest.json from the committed template.
 *
 * Substitution happens here, in Node, rather than through Vite's `VITE_`
 * environment mechanism: the manifest is not browser code, and routing it
 * through import.meta.env would expose every matching variable to the bundle.
 */
function manifestPlugin(clientId: string): Plugin {
  return {
    name: 'coupon-assistant:manifest',
    generateBundle() {
      const templatePath = resolve(rootDir, 'manifest.template.json')
      const manifest = readFileSync(templatePath, 'utf8').replaceAll(
        '${GOOGLE_CLIENT_ID}',
        clientId,
      )

      const unresolved = manifest.match(/\$\{[A-Za-z0-9_]+\}/g)
      if (unresolved) {
        throw new Error(
          `manifest.template.json has unresolved placeholders: ${unresolved.join(', ')}`,
        )
      }
      JSON.parse(manifest)

      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: manifest })
    },
  }
}

export default defineConfig(({ mode }) => {
  const development = mode === 'development'
  const clientId = loadEnv(mode, rootDir, '').GOOGLE_CLIENT_ID?.trim()

  if (!clientId) {
    throw new Error(
      'GOOGLE_CLIENT_ID is not set.\n' +
        'Copy .env.example to .env and add the OAuth client ID from your own Google\n' +
        'Cloud project. See the "Google Cloud setup" section of README.md.',
    )
  }

  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    throw new Error(
      'GOOGLE_CLIENT_ID must be a Google OAuth client ID ending in ' +
        '".apps.googleusercontent.com". Chrome Extension clients use no client secret.',
    )
  }

  return {
    root: srcDir,
    envDir: rootDir,
    publicDir: resolve(rootDir, 'public'),
    plugins: [manifestPlugin(clientId)],
    build: {
      outDir: resolve(rootDir, 'dist'),
      emptyOutDir: true,
      target: 'chrome120',
      minify: !development,
      sourcemap: development,
      modulePreload: false,
      rollupOptions: {
        input: {
          background: resolve(srcDir, 'background/index.ts'),
          popup: resolve(srcDir, 'popup/index.html'),
        },
        output: {
          // The manifest holds literal paths, so entry names must be stable.
          // Shared chunks may be hashed: only the entries are referenced by name.
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  }
})
