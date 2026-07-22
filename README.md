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

On a PC with a discrete GPU there are two memory pools: the model sits in VRAM, the OS in
system RAM, and they do not compete. Apple Silicon has **one pool**. That is why a Mac can
run models no consumer GPU could hold — but it also means the model and macOS draw from the
same budget, and GPU memory is *wired*, so the system cannot page it out to make room.

A model that is slightly too big therefore does not fail to load. It loads, takes memory
the system needed, and everything else starts swapping.

Most tooling is quiet about the things that decide whether that happens:

- **Your usable ceiling is not your RAM size.** Metal publishes a
  `max_recommended_working_set_size` — typically well under total memory. It is reported per
  machine, so it can be read rather than approximated with a 70%-of-RAM rule of thumb.
- **The OS has already spent some of it.** Whatever your desktop, browser and editor are
  holding is unavailable, and it is rarely a small number.
- **KV cache scales with context and is not in the model's file size.** Cost per token
  follows from the attention shape — layers, KV heads, head dimension — so a long context
  can add many gigabytes on top of the weights. Grouped-query models cache far less than
  their attention-head count suggests, which is easy to get wrong in the expensive
  direction.
- **`mlx_lm.server` never unloads.** One model, loaded lazily inside the first request that
  names it, no idle timeout, no unload endpoint, and `/v1/models` reports your download
  cache rather than what is actually resident.
- **Its defaults target a shared inference host,** not a laptop also running your desktop:
  many parallel decode sequences, each with its own KV cache, and an unbounded prompt cache.

None of these are fixed numbers, which is the point — they depend on your hardware, your
model and what else is running. The extension reads them live rather than assuming, and is
explicit about the one thing it cannot know: macOS exposes no per-process GPU memory
accounting at any privilege level, so "held by other apps" is inferred, not measured.

> **Reference machine.** Everything here was developed and measured on a **128 GB M5 Max**
> running **gpt-oss-120b** — where the usable ceiling turns out to be 107.5 GB of the 128,
> the desktop already holds ~22 GB before any model loads, and the model's KV cache costs
> ~72 KiB per token (9.7 GB at its full 131k context). Your figures will differ; that is
> exactly why the extension measures rather than hardcodes. Reports from other hardware are
> very welcome — see [Contributing](#contributing).

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

## Configuration

Every setting is editable in the **Server & Settings** panel — you should not need to open
VS Code's settings editor. Sizes accept `8 GB` / `512 MB`; a bare number means MB.

### Which ones actually matter

Most defaults are fine. These are the ones worth understanding:

**`contextWindow`** — leave it unset. The extension reads each model's real window from its
own `config.json` and shrinks it if the KV cache would not fit in the memory you have left.
Setting it yourself overrides both of those, which is occasionally what you want (forcing a
short context to save memory) and usually not.

**`server.promptCacheBytes`** — `mlx_lm.server` leaves this **unbounded**, trimming only
after 10 cached conversations, so it can quietly grow into whatever the model left free.
The Metrics panel computes a recommendation from live headroom; a few GB is plenty.

**`server.decodeConcurrency`** — the server default is 32 parallel sequences, each with its
own KV cache. For a single editor, **1–4** is realistic; the Metrics panel will tell you
what your headroom actually supports.

**`modelsDir`** — where weights land. Point it somewhere with room, and preferably outside
your project folder; a 120B model at 4-bit is around 60 GB.

**`sampling.*`** — only set these if you disagree with the model. Anything you leave alone
falls back to the model's own `generation_config.json`, which is usually tuned better than
a global default. Disabling values (`topK` 0, `minP` 0, `repetitionPenalty` 1) are omitted
from requests entirely rather than pinning a sampler you did not ask for.

**`server.draftModel`** — speculative decoding. The draft must share the target's exact
tokenizer, so the Metrics panel matches candidates on `vocab_size` rather than by name, and
its weights load *in addition* to the main model.

### Full reference

Generated from the manifest, so it always matches the build.

<!-- settings:start -->

#### General

| Setting | Type | Default | Notes |
| --- | --- | --- | --- |
| `pythonPath` | string | _(empty)_ | Path to a Python 3 interpreter used to create the managed virtual environment. Leave empty to auto-detect. |
| `venvPath` | string | _(empty)_ | Directory for the managed Python virtual environment where mlx-lm is installed. venv (if it has mlx-lm) or the extension's global storage. |
| `modelsDir` | string | _(empty)_ | Directory where models are downloaded and cached (sets HF_HOME; models live under <dir>/hub). server and the Hugging Face CLI. cache/huggingface). |
| `defaultModel` | string | _(empty)_ | Default MLX model repo id used for chat when none is selected. |
| `contextWindow` | number | `131072` | Context window advertised to VS Code for MLX models (`maxInputTokens`). |
| `maxOutputTokens` | number | `4096` | Maximum tokens an MLX model may generate in one response. |
| `modelOverrides` | object | `{}` | Per-model generation overrides, keyed by model id (or a converted model's local path). *` defaults. |

#### Server

| Setting | Type | Default | Notes |
| --- | --- | --- | --- |
| `server.host` | string | `127.0.0.1` | server binds to (ignored when Expose to LAN is on). |
| `server.port` | number | `8080` | server. |
| `server.autoStart` | boolean | `true` | Start the server automatically when it is first needed. |
| `server.exposeToLan` | boolean | `false` | 0 so other machines/tools can reach it. Security risk on untrusted networks. |
| `server.apiKey` | string | _(empty)_ | Optional bearer token required for served requests (also shown in external-client snippets). |
| `server.extraArgs` | array | `[]` | g. context/KV-cache limits, chat template). server --help` to see available flags. |
| `server.promptCacheSize` | number | `0` | server --prompt-cache-size). 0 uses the server default. |
| `server.promptCacheBytes` | number | `0` | server --prompt-cache-bytes`). Accepts a size such as `8 GB` or `512 MB`; a bare number is read as MB. |
| `server.decodeConcurrency` | number | `0` | server --decode-concurrency`). 7 GB. The server default is 32, sized for a shared inference host — a single-user editor rarely needs more than 1–4. |
| `server.promptConcurrency` | number | `0` | server --prompt-concurrency`). Server default 8. Raises prefill throughput for concurrent requests at the cost of transient memory. |
| `server.prefillStepSize` | number | `0` | server --prefill-step-size`). Server default 2048. |
| `server.draftModel` | string | _(empty)_ | server --draft-model`). Loaded in addition to the main model, so its weights count against the same GPU ceiling — check headroom in Metrics first. |
| `server.numDraftTokens` | number | `0` | server --num-draft-tokens`). Server default 3. Only used when a draft model is set. 0 leaves the server default. |

#### Sampling

| Setting | Type | Default | Notes |
| --- | --- | --- | --- |
| `sampling.temperature` | number | `0.7` | Sampling temperature. Lower is more deterministic (good for code). |
| `sampling.topP` | number | `1` | Nucleus sampling top-p. 0 disables it. |
| `sampling.topK` | number | `0` | Top-k sampling. 0 disables it. |
| `sampling.minP` | number | `0` | Min-p sampling. 0 disables it. |
| `sampling.repetitionPenalty` | number | `1` | Repetition penalty. 0 disables it. |
| `sampling.maxTokens` | number | `2048` | Maximum tokens generated per response. |

#### Hugging Face

| Setting | Type | Default | Notes |
| --- | --- | --- | --- |
| `huggingFace.token` | string | _(empty)_ | Optional Hugging Face token for higher rate limits and gated models. |

<!-- settings:end -->

## Requirements

- **macOS on Apple Silicon (arm64).** The extension checks for `darwin`/`arm64` and will
  not run elsewhere — MLX is Apple-only.
- **Python 3.** The extension creates and manages its own virtual environment and installs
  `mlx-lm` into it. Nothing is installed globally.
- **VS Code 1.125+**, for the language model chat provider API.
- **Disk.** Models are large; a 120B model at 4-bit is around 60 GB.

---

## Install

No marketplace release yet, Comming Soon !!!!  — build it from source:

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

Expect rough edges.

---

## Contributing

**Please do.** This started as a personal itch, and it is far more useful with other people
poking at it — especially anyone running different Apple Silicon hardware, since almost all
of the memory logic was tuned against a single M5 Max.

**Fork it.** Genuinely: fork it, break it, run it against your own models, and tell me what
happened. A bug report from an M1 Pro with 16 GB is worth more to this project than another
feature written on my machine.

**Ways to help, roughly by how much they are needed:**

- **Try it on other hardware and report what you see.** M1/M2/M3/M4, any memory size. The
  GPU ceiling, KV arithmetic and pre-flight checks all make assumptions that deserve
  testing beyond one machine.
- **Try it with other models.** Anything that is not gpt-oss — different tokenizers,
  different attention shapes, models that ship real sampling defaults in
  `generation_config.json`. Mis-parsed metadata is the most likely bug class here.
- **Open an issue** for anything surprising, including bad wording. If a number in the
  Metrics panel looks wrong, it may well be wrong.
- **Send a pull request.** Small and focused is easier to review than large and complete.

**Before opening a PR:**

```bash
npm run typecheck && npm test
```

There is no CI yet, so those two commands are the whole gate. If you change parsing or
memory logic, please add a test — the existing suite exists because those are exactly the
places where a wrong answer looks plausible.

**House style**, so review is about substance rather than formatting: comments explain
*why*, not what; when something is a guess or a limitation, say so in the code rather than
letting the reader assume it is measured. Several comments in this codebase are warnings
left for the next person, and they have earned their place.

Questions and half-formed ideas are welcome in issues too — you do not need a patch to
start a conversation.

---

## Author

Built by **[@bengurion](https://github.com/bengurion)**.

Standing on: [mlx](https://github.com/ml-explore/mlx) and
[mlx-lm](https://github.com/ml-explore/mlx-lm) from Apple's machine-learning research
group, and the [Hugging Face Hub](https://huggingface.co) for model distribution. This
project is not affiliated with Apple or Hugging Face.

## License

MIT. The full text is in the `LICENSE` file at the repository root.
