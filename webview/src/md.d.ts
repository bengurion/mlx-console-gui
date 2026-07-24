// esbuild loads .md imports as text (see esbuild.mjs webviewConfig.loader).
declare module '*.md' {
  const text: string
  export default text
}
