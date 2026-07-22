# MLX Console for VsCode

A VS Code front end for [mlx-lm](https://github.com/ml-explore/mlx-lm)'s local server on
Apple Silicon. It runs and supervises `mlx_lm.server`, manages the models it serves, and
shows what that costs in memory.

- **Run the server** — start, stop and supervise `mlx_lm.server`, with its OpenAI-compatible
  endpoint at `http://127.0.0.1:8080/v1` for any client that speaks it.
- **Manage models** — search Hugging Face (filtered to what mlx-lm can actually run),
  download, convert to MLX at a quantization that fits the machine, launch, and delete.
- **See the cost** — live CPU, unified-memory and GPU figures, which model is resident,
  how long it took to load, and how much room is left before it swaps.
- **Configure without leaving the panel** — every setting is editable in place, with values
  such as the context window read from the model's own `config.json`.
- **Use it in the editor, if you want** — served models also appear in the VS Code model
  picker and as the `@mlx` chat participant. That is one client among several, not the
  point of the extension.

## Download

**[Download mlx-console-vscode-0.0.17.vsix](https://github.com/bengurion/mlx_console_vscode/releases/latest/download/mlx-console-vscode-0.0.17.vsix)** — latest release

Then install it:

```bash
code --install-extension ~/Downloads/mlx-console-vscode-0.0.17.vsix
```

Or from the Extensions view: **⋯ → Install from VSIX…**

Reload the window afterwards. Every release is also listed on the
[releases page](https://github.com/bengurion/mlx_console_vscode/releases).

## Requirements

- macOS on Apple Silicon (arm64) — the extension checks for `darwin`/`arm64` and will not
  run elsewhere
- Python 3 (the extension creates its own virtual environment and installs `mlx-lm`)

## Development

```bash
npm install
npm run compile      # or: npm run watch
npm run typecheck
npm test
```

Press `F5` in VS Code to launch an Extension Development Host.

## Building a .vsix from the CLI

`npm run vsce:package` syncs the version references in this README from `package.json`,
runs a production esbuild, then `vsce package --no-dependencies`, writing
`mlx-console-vscode-<version>.vsix` in the repo root. The README download link therefore
always names the version you just built — never edit those by hand.

```bash
# 1. bump the version — vsce refuses to overwrite an existing .vsix
npm version patch --no-git-tag-version     # or edit "version" in package.json

# 2. verify before packaging (vsce does not run these)
npm run typecheck && npm test

# 3. build + package
npm run vsce:package

# 4. inspect what actually shipped
unzip -l mlx-console-vscode-*.vsix
```

Install the result:

```bash
code --install-extension "$(ls -t mlx-console-vscode-*.vsix | head -1)" --force
code --list-extensions --show-versions | grep mlx-console-vscode   # confirm which build is live
```

If `code` is not on your `PATH` (common when VS Code was installed by dragging to
/Applications), use the binary inside the app bundle, or run
**Shell Command: Install 'code' command in PATH** from the command palette:

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension mlx-console-vscode-0.0.17.vsix --force
```

### Packaging gotchas

- **Keep model weights out of the package.** The default `modelsDir` can sit inside
  the workspace; `models/**` is in `.vscodeignore` because vsce secret-scans every
  included file and fails on multi-GB weights.
- **No relative links in Markdown.** Without a `repository` field, vsce rejects any
  Markdown link whose target is a repo-relative path rather than a URL — and its
  scanner does not respect code spans, so even an example inside backticks trips
  it. Use plain text for such references, or add `repository` to `package.json`.
- **Reload the window** after installing — VS Code keeps the old extension host
  running otherwise.

### Publishing

Not published to any marketplace yet. When that changes:

```bash
npx vsce publish            # Visual Studio Marketplace (needs a publisher PAT)
npx ovsx publish *.vsix -p <token>   # Open VSX, used by VSCodium/Cursor/Gitpod
```

Open VSX additionally requires the `mlx-console-vscode` namespace to be created and the
Eclipse Publisher Agreement signed.

## Status

Under active development — see the [milestones](https://github.com/bengurion/mlx_console_vscode/milestones).


## Install

```bash
# build + package, then install (bump the version in package.json for each rebuild)
npm run vsce:package
code --install-extension "$(ls -t mlx-console-vscode-*.vsix | head -1)" --force

# verify which build is live
code --list-extensions --show-versions | grep mlx-console-vscode
```
