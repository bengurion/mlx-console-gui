import * as esbuild from 'esbuild'
import { existsSync } from 'node:fs'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
}

const webviewEntry = 'webview/src/index.tsx'
/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: [webviewEntry],
  bundle: true,
  outfile: 'dist/webview/main.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: !production,
  minify: production,
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  logLevel: 'info',
}

// The webview app is added in a later milestone; only build it once its entry exists.
const configs = [extensionConfig]
if (existsSync(webviewEntry)) configs.push(webviewConfig)

if (watch) {
  const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)))
  await Promise.all(ctxs.map((c) => c.watch()))
  console.log('[esbuild] watching for changes…')
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)))
  console.log('[esbuild] build complete')
}
