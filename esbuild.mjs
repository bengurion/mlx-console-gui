import * as esbuild from 'esbuild'
import { existsSync } from 'node:fs'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/**
 * One id shared by every bundle in this build.
 *
 * The dashboard serves its page from disk on each request, but the host that
 * answers its calls was loaded into memory when the process started. Rebuild
 * without restarting and the browser gets a new UI talking to an old host —
 * which does not fail, it silently ignores anything the old host has never
 * heard of. Stamping both sides lets the mismatch be detected and said out
 * loud.
 */
const BUILD_ID = JSON.stringify(new Date().toISOString())
const define = { __BUILD_ID__: BUILD_ID }

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
  define,
  logLevel: 'info',
}

/**
 * The headless CLI: the same dashboard and server control with no VSCode.
 * Bundled separately because it must not link the `vscode` module at all.
 */
/** @type {import('esbuild').BuildOptions} */
const cliConfig = {
  entryPoints: ['src/headless/cli.ts'],
  bundle: true,
  outfile: 'dist/cli.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  banner: { js: '#!/usr/bin/env node' },
  define,
  logLevel: 'info',
}

/**
 * The desktop shell. Two small bundles: the main process (which imports the
 * same daemon assembly the CLI uses) and the preload. Electron ≥ 30 ships
 * Node ≥ 20; the node18 target elsewhere is a floor for the extension host,
 * not a ceiling here.
 */
/** @type {import('esbuild').BuildOptions} */
const electronMainConfig = {
  entryPoints: ['src/electron/main.ts'],
  bundle: true,
  outfile: 'dist/electron/main.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: !production,
  minify: production,
  define,
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions} */
const electronPreloadConfig = {
  entryPoints: ['src/electron/preload.ts'],
  bundle: true,
  outfile: 'dist/electron/preload.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: !production,
  minify: production,
  define,
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
  define: { ...define, 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  logLevel: 'info',
}

// The webview app is added in a later milestone; only build it once its entry exists.
const configs = [extensionConfig, cliConfig, electronMainConfig, electronPreloadConfig]
if (existsSync(webviewEntry)) configs.push(webviewConfig)

if (watch) {
  const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)))
  await Promise.all(ctxs.map((c) => c.watch()))
  console.log('[esbuild] watching for changes…')
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)))
  console.log('[esbuild] build complete')
}
