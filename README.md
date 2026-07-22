# MLX Console for VS Code

**Run large language models locally on your Mac, without leaving the editor.**

MLX Console is a front end for [mlx-lm](https://github.com/ml-explore/mlx-lm)'s inference
server. It starts and supervises `mlx_lm.server`, manages the models that server loads, and
tells you honestly what those models cost in memory — before they take your machine down
with them.

If you have used mlx-lm from the terminal, you know the loop: one window running the
server, another for `huggingface-cli`, a browser tab open on the Hub trying to work out
whether a 120B model will actually fit in 128 GB. This collapses that into one panel.

---

## Why this exists

Running a big model on Apple Silicon is mostly a memory problem, and the tooling is quiet
about it. A few things this project learned the hard way, and now surfaces:

- **Your GPU ceiling is not 100% of RAM.** Metal reports a
  `max_recommended_working_set_size` — on a 128 GB M5 Max that is **107.5 GB**, not 128.
  Most "will it fit?" advice online uses a fraction-of-RAM guess instead.
- **KV cache is not free.** At a 131,072-token context, gpt-oss-120b needs ~72 KiB **per
  token** of cache on top of its weights — about 9.7 GB. That is the difference between a
  model that loads and one that swaps.
- **`mlx_lm.server` never unloads.** It keeps exactly one model resident, loads it lazily
  inside the first request, and evicts only when a different model displaces it. There is
  no idle timeout, and no endpoint to ask what is loaded.
- **Its defaults assume a shared server.** `--decode-concurrency` defaults to **32**
  parallel sequences. On a single-user laptop with a large model, that is a lot of KV cache
  for requests that will never arrive.

The extension measures these rather than guessing, and says what it is doing.

---

## What it does

**Run the server** — start, stop and supervise `mlx_lm.server`. Its OpenAI-compatible
endpoint lives at `http://127.0.0.1:8080/v1` for any client that speaks the protocol.

**Manage models** — search Hugging Face filtered to what mlx-lm can genuinely run
(GGUF and `.bin`-only repos are marked unusable rather than silently failing later),
download with progress, convert to MLX at the best quantization that fits your machine,
launch, and delete.

**See the cost** — live CPU, unified memory and GPU utilisation; which model is resident
and how long it took to load; how much headroom is left; and a per-model breakdown of
context window, KV cost per token, weight size and vocabulary, read from the model's own
`config.json`.

**Configure without leaving the panel** — every setting is editable in place, with sizes
in MB/GB rather than raw bytes. Values the model knows about itself — context window,
sampling defaults, max output tokens — are read from its files, and anything you set
explicitly always wins.

**Use it in the editor, if you want** — served models appear in the VS Code model picker
and as the `@mlx` chat participant, forwarding native and MCP tools. That is one client of
the server, not the point of the extension.

---

## Requirements

- **macOS on Apple Silicon (arm64).** The extension checks for `darwin`/`arm64` and will
  not run elsewhere — MLX is Apple-only.
- **Python 3.** The extension creates and manages its own virtual environment and installs
  `mlx-lm` into it. Nothing is installed globally.
- **VS Code 1.125+**, for the language model chat provider API.
- **Disk.** Models are large; a 120B model at 4-bit is around 60 GB.

---

## Install

No marketplace release yet — build it from source:

```bash
git clone <this-repo>
cd mlx_console_vscode
npm install
npm run vsce:package
code --install-extension "$(ls -t mlx-console-vscode-*.vsix | head -1)" --force
```

Reload the VS Code window afterwards, then open the **MLX Console** icon in the activity
bar. First run offers to set up the Python environment for you.

If `code` is not on your `PATH` — common when VS Code was installed by dragging it to
`/Applications` — run **Shell Command: Install 'code' command in PATH** from the command
palette, or use the binary inside the app bundle:

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension mlx-console-vscode-0.0.17.vsix --force
```

---

## Development

```bash
npm install
npm run watch        # or: npm run compile
npm run typecheck
npm test             # 112 unit tests, no VS Code host required
```

Press `F5` to launch an Extension Development Host.

The tests deliberately cover the parts that are easy to get quietly wrong — parsing
`vm_stat` and `ioreg` output, KV-cache arithmetic under grouped-query attention, harmony
channel parsing, and the memory estimators — rather than the UI wiring.

### Building a .vsix

`npm run vsce:package` syncs the version references in this README from `package.json`,
runs a production esbuild, then `vsce package --no-dependencies`.

```bash
npm version patch --no-git-tag-version   # vsce refuses to overwrite an existing .vsix
npm run typecheck && npm test            # vsce does not run these for you
npm run vsce:package
unzip -l mlx-console-vscode-*.vsix       # inspect what actually shipped
```

### Packaging gotchas

Each of these cost real time, so they are written down:

- **Keep model weights out of the package.** The default `modelsDir` can sit inside the
  workspace. `models/**` is in `.vscodeignore` because vsce secret-scans every included
  file and dies on multi-GB weights.
- **No repo-relative Markdown links** unless `package.json` has a `repository` field —
  and vsce's link scanner does not respect code spans, so even an example inside backticks
  trips it.
- **Reload the window** after installing; VS Code keeps the old extension host running.
- **Pin `@types/vscode` to the `engines.vscode` floor.** A caret range once resolved to a
  much newer version, so the compiler happily accepted APIs the manifest did not guarantee.

---

## Status

Under active development. The memory, model-management and configuration surfaces are
working; inline completions (FIM), LoRA adapters and KV-cache quantization are not
implemented — the last of those is blocked upstream, as `mlx_lm.server` exposes no flag
for it.

Expect rough edges. Issues and ideas are welcome.

---

## Author

Built by **[@bengurion](https://github.com/bengurion)**.

Standing on: [mlx](https://github.com/ml-explore/mlx) and
[mlx-lm](https://github.com/ml-explore/mlx-lm) from Apple's machine-learning research
group, and the [Hugging Face Hub](https://huggingface.co) for model distribution. This
project is not affiliated with Apple or Hugging Face.

## License

MIT. The full text is in the `LICENSE` file at the repository root.
