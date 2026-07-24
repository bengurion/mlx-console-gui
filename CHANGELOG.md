# Changelog

## 0.0.21 — Unreleased

The Info page became a document worth reading, and search numbers are now checked against how the Hub actually counts.

- **Info page reorganised as tabs** — one tab per README section instead of a 700-line scroll, full width like every other page, larger text, and the mermaid architecture and launch diagrams render as real theme-aware SVGs instead of code blocks. The README's own cross-links switch tabs.
- **Fixed: tab and anchor clicks silently did nothing.** React 19 diffs `dangerouslySetInnerHTML` by object identity, so every re-render reset the section HTML and erased the heading ids and rendered diagrams added after it. The HTML objects are now stable.
- **Fixed: the dashboard CSP blocked mermaid's styles.** A style nonce makes browsers ignore `'unsafe-inline'`, and mermaid injects `<style>` into its SVGs — styles are now `'unsafe-inline'` while scripts stay nonce-only.
- **Search filters apply immediately** — scope, size, quant and sort re-search on change instead of waiting for Enter, and a late response from an abandoned query can no longer overwrite a newer one.
- **Fixed: AWQ/GPTQ/bitsandbytes sizes were off 4–8×** (a 9 GB phi-4 quant showed "53 GB · 113B"). The Hub counts *logical* parameters for quantization_config formats but *stored elements* for MLX packed repos; sizing now branches on which rule the repo follows, verified against the repos' actual file trees.
- **Quantization detection covers the non-MLX families** — AWQ, GPTQ, NF4, bnb-4bit, GGUF spellings like `Q4_K_M`, mxfp4 (gpt-oss), fp8 and fp32, each with its real bytes-per-parameter. Sub-1B names like "SmolLM2-135M" parse too; "-1M" context suffixes do not count as sizes.
- **Convert plans use the Hub's exact parameter count** — repos whose names say nothing about size no longer show "size unknown" for every bit width; the name-guess remains the offline fallback.
- **bf16 is a conversion choice** — the original precision in MLX format, no quantization, output in a `-bf16` directory. Offered first, never recommended over a quantization that fits.
- **5-bit joins the quantization choices** — mlx supports {2,3,4,5,6,8}; 5-bit was simply never offered. Verified end to end: a 0.5B model converted at 5 bits ("5.502 bits per weight" with group scales), loaded, and generated. It sits in the sweet spot where 4-bit is tight on quality and 6-bit is tight on memory.
- **Pre-quantized repos are refused up front** — `mlx_lm.convert` only reads full-precision weights, so an AWQ/GPTQ/bnb repo now says so immediately instead of failing after the hour-long download.
- **Pre-quantized cards convert their source** — the Hub records what an AWQ/GPTQ/bnb repo was quantized from, so the button reads "Convert the source…" and plans against that repo (as GGUF cards already did) instead of dead-ending. Conversion progress follows the source id back to the card.
- **A partial download can no longer pose as a model** — completeness is derived from the cache itself (hf_hub links a file into the snapshot only when its blob is done, and the safetensors index names every shard), so no state file can drift. An interrupted model shows a *partial* badge with **Resume download** in place of Launch, and becomes launchable the moment the download completes. In-flight downloads also persist to a small JSON beside the cache, so they reappear in Downloads as resumable after a restart instead of vanishing.
- **Interrupted downloads survive anything** — verified by killing a download mid-shard: the restart re-covered 1.1 GB of finished bytes in one second using 24 KB of network, because resume lives in hf_xet's local chunk cache. That cache is now sized at 64 GiB (default 10 GB could not hold one large model), transient network failures retry themselves at 5 s / 15 s / 60 s before surfacing, failed or canceled items grow a **Resume** link in Downloads, and the orphaned `.incomplete` files huggingface_hub ≥ 1.x abandons after a kill are swept before each attempt instead of accumulating by the gigabyte.

## 0.0.17 — Unreleased

Everything model-specific is now read from the model itself, and memory advice is measured rather than guessed.

- **Model profile on load** — context window, vocabulary, weight size, KV cost per token, the model's own `generation_config` sampling, and a draft-model search are computed whenever the resident model changes and pushed to the UI. Guarded so it runs on an actual model change, not every status tick, and re-sent to newly opened panels.
- **Sampling and max-output defaults come from the model** — `generation_config.json` sits beneath your settings: an untouched setting takes the model's recommendation, an explicitly set one is never overridden. Max output derives from the window (`clamp(window/8, 1024, 8192)`) when unset.
- **Draft-model selection by vocabulary** — speculative decoding requires the draft to share the target's exact tokenizer, so candidates are matched on `vocab_size`, then filtered to under 20% of target weights and checked against live headroom. Names and model families are never used to guess.
- **Measured transient memory** — GPU use is sampled across each request and fitted against prompt size to learn prefill working memory, which sizes `prefillStepSize`. Refuses to emit a number from same-size prompts, negative slopes, or fewer than three samples.
- **Real server defaults surfaced** — `--decode-concurrency` is **32**, prompt-concurrency **8**, prefill-step-size **2048**, num-draft-tokens **3**. 32 parallel sequences at ~9.7 GB of KV each is sized for a shared host; the Metrics panel now recommends a value from live headroom.
- **Sizes are human-readable** — byte settings show and accept `8 GB` / `512 MB`; a bare number is read as MB.
- Fixed: numeric settings containing "token" (`maxOutputTokens`, `sampling.maxTokens`, `numDraftTokens`) rendered as masked password fields, because the secret check matched substrings. It now matches whole key segments, and only strings.
- Fixed: available memory ignored other processes. GPU in-use is device-wide; our own resident model *is* reclaimed when a new one loads, but memory held by other apps is not, so it now comes off the budget. Both the pre-flight check and the context clamp use the same rule.
- Fixed: the model picker applied one headroom figure to every model. A model that is not resident is now budgeted against **its own** weights, since the resident model is dropped before it loads.
- Fixed: transient-memory measurement conflated KV cache growth with prefill working memory — both scale per token, so the fitted slope was really `kv + transient`. Known KV cost is subtracted before fitting.
- Fixed: the Environment card repeated the mlx-lm version; it now shows the extension version.
- `tsconfig.json` sets `allowImportingTsExtensions`, so `src` modules can import each other with explicit `.ts` paths and still load under the test runner. Module boundaries no longer bend around test mechanics.

## 0.0.16 — Unreleased

Memory-aware model handling: the extension now sizes context and refuses loads it can prove will not fit.

- **Context window read from the model** — `maxInputTokens` comes from the model's own `config.json` (`max_position_embeddings`) instead of one global number, so mixed model sizes work. An explicit `mlxConsole.contextWindow` still wins; the default rose 32768 → 131072. `sliding_window` is deliberately ignored: gpt-oss reports 128 for interleaved local attention but still accepts the full window.
- **Context clamped to fit memory** — a trained window is a capability claim, not a memory guarantee. KV cost per token is computed from the real attention shape (36 layers × 8 **KV** heads × 64 head_dim × 2 for K+V × 2 bytes ≈ 72 KiB/token for gpt-oss-120b), and the advertised window shrinks when headroom cannot cover it. Using `num_attention_heads` instead of `num_key_value_heads` would overestimate KV by 8× under GQA.
- **Pre-flight memory guard** — before loading a non-resident model, estimated runtime need is checked against the live GPU ceiling. A provable overflow blocks with the numbers and a pointer to `iogpu.wired_limit_mb`; anything short of that warns and proceeds.
- **Unload & clear** — `mlx_lm.server` exposes no unload or cache-flush endpoint (only the completion POSTs, `/v1/models`, `/health`), so the action restarts the process. That is the only way to free either the weights or the KV caches.
- **Launch is disabled for a resident model** — it previously stayed clickable and would drop and re-read weights, costing minutes for no change. The button now reads Launch / Loading… / Running from real residency state.
- **Prompt-cache recommendation lowered** — a quarter of free headroom capped at 8 GB, down from half capped at 32 GB, after comparing with other MLX servers that ship a 2 GB prefix-cache default.
- **Concurrency and speculative decoding exposed** — `server.decodeConcurrency`, `server.promptConcurrency`, `server.prefillStepSize`, `server.draftModel`, `server.numDraftTokens`. Each flag is omitted entirely at 0/empty so the server keeps its own defaults.
- The Environment card shows the extension version instead of repeating the mlx-lm version already in the status line.

## 0.0.15 — Unreleased

Marketplace/Open VSX readiness, and a dependency upgrade.

- **Fixed an `engines.vscode` bug** — the manifest declared `^1.99.0` while compiling against `@types/vscode` 1.125. `registerLanguageModelChatProvider` is absent through 1.120 and present in 1.125 (verified by downloading each published typings version), so anyone on 1.99–1.10x installed the extension and silently lost the native model picker. Now `^1.125.0`, with `@types/vscode` **exactly pinned** to the same version so the two cannot drift again.
- **Extension icon** — `resources/activitybar.svg` uses `currentColor` and renders invisible on a dark listing, so a standalone 128×128 icon was added.
- **Dependencies** — React 18 → 19, TypeScript 5.9 → 7, esbuild 0.24 → 0.28, `@vscode/vsce` 3.2 → 3.9. TypeScript 7 stopped auto-including `@types` packages, so `tsconfig.json` now names `["node", "vscode"]` explicitly — tests and esbuild never run `tsc`, so only the typecheck caught it.
- `@types/node` tracks VS Code's extension host runtime (Node 24), **not** npm's latest, so `npm outdated` will keep flagging it incorrectly.

## 0.0.14 — Unreleased

Optional per-process GPU attribution.

- **`powermetrics` sampling** — an on-demand action attributes GPU **time** to a process. It runs in a visible terminal so the user enters their own password; the extension never receives or stores a credential. No passwordless `sudo` rule is installed: `powermetrics` accepts `-o <file>`, so passwordless access to it is an arbitrary root file write.
- Scope is narrower than it looks: macOS exposes **no per-process GPU memory** accounting at any privilege level, so the memory figures stay device-wide even as root.

## 0.0.13 — Unreleased

Fix: a second VS Code window did not know a model was loaded.

- **Cross-window server state** — every window runs its own extension host, and `/v1/models` reports the Hugging Face *cache*, not what is resident, so a second window could not discover the loaded model by asking. The window that loads a model now records it in the extension's global storage; others adopt it and watch for changes.
- Adoption is guarded on matching port, a live pid (`kill(pid, 0)`, treating `EPERM` as alive), and a 24h staleness bound. A window that owns the process always trusts its own state.

## 0.0.12 — Unreleased

Every setting is editable in the extension UI.

- **Settings section** — all contributed settings, derived host-side from the `package.json` contribution so the panel cannot drift from the manifest. Controls are chosen by declared type, with masked fields for tokens and API keys, grouping, a filter, and per-setting reset.
- Values are coerced against the declared type before writing, so malformed JSON or a non-numeric port is reported inline rather than persisted.
- Previously only 3 of 22 settings were reachable, and those were deep links that opened VS Code's settings editor rather than editing in place.

## 0.0.11 — Unreleased

Model residency and live system metrics.

- **Weight residency is tracked separately from server state** — "server ready" and "weights loaded" are different things. The status bar and Server view now show loading (with elapsed seconds), the resident model and its load time, and explain that `mlx_lm.server` keeps exactly one model with **no idle timeout**: it stays until displaced or the process exits, and loading happens inside the first request.
- **Metrics section** — CPU, memory (`vm_stat`, honouring the 16384-byte page size), and GPU utilization plus GPU memory from `ioreg -c IOAccelerator`, all readable without sudo.
- **Real GPU ceiling surfaced** — `mx.device_info()` reports `max_recommended_working_set_size` (107.5 GiB on a 128 GB M5 Max), the actual Metal allocation limit, which is more accurate than the 75%-of-RAM heuristic used for fit estimates.
- **Editable wired-memory limit** — `iogpu.wired_limit_mb` can be changed from the UI via a terminal, with the value's volatility and risks stated up front.

## 0.0.10 — Unreleased

Chat fixes: attachments no longer 404, and gpt-oss reasoning stays out of the answer.

- **404 when attaching a file** — attachments arrive as `LanguageModelDataPart` (binary `data` + `mimeType`, no `value`). The provider only read `value`, so an attachment-only turn collapsed to an empty `messages` array, which `mlx_lm.server` answers with a bare 404. Textual mime types are now decoded and inlined, binary ones are labelled, and an empty request is refused client-side instead of being sent.
- **Clearer 404s** — `mlx_lm.server` returns 404 for both an unknown `model` (it falls through to a Hugging Face lookup that misses) and an empty `messages` array. The error now says which.
- **Harmony format is parsed** — gpt-oss models emit `<|channel|>analysis<|message|>…` as raw text. A streaming filter routes `final` to the answer, `analysis`/`commentary` to thinking parts, and `commentary to=functions.X` to real tool calls, holding back control tokens split across deltas. Text without harmony tokens passes through untouched.
- **`@mlx` can use tools** — the participant now passes every tool VS Code exposes (extension-contributed and MCP), narrowed to `#tool` mentions when present, and runs a bounded 8-round invoke-and-feed-back loop. Attached files and selections are inlined and cited.
- **Context window is configurable** — `mlxConsole.contextWindow` and `mlxConsole.maxOutputTokens` replace hardcoded 32768/4096. VS Code sizes the tool payload against the advertised window, so a full native + MCP tool set needs this raised to match the model.
- **Tool payloads are logged** — every request logs tool count, names, and approximate token cost, warning when schemas exceed half the window.
- **Conversion proposals explain the fit** — a size over the usable budget but under physical RAM is now called out as loadable on an idle machine (with the `iogpu.wired_limit_mb` caveat) rather than lumped in with "exceeds budget".

## 0.0.9 — Unreleased

Search now surfaces convertible models, not just pre-built MLX ones.

- **Format classification** — every result is `mlx` (download and run), `convertible` (ships safetensors → `mlx_lm.convert`), or `unsupported` (GGUF, or no safetensors — mlx-lm globs `model*.safetensors` and fails without them).
- **The right action per result** — MLX repos get **Download**, safetensors repos get **Convert to MLX…** with a `convert` badge, unsupported repos are disabled with the reason.
- **Counts by capability** — "Showing 50 of 58 — 12 MLX-ready, 38 convertible", so the MLX-only filter no longer looks like it is silently losing models.
- Unsupported now correctly covers legacy `.bin`-only repos, not just GGUF.

## 0.0.8 — Unreleased

Fix: search returned far fewer results than the Hugging Face website.

- **Result counts are explained** — the view now reports "Showing X of Y MLX-runnable models" and states that Hugging Face lists many more in formats mlx-lm cannot run. Searching `gpt-oss-120b` yields 1000+ on the website but **58** MLX-tagged repos, and only **4** under `mlx-community`; the filters were right, the UI just never said so.
- **Over-fetch before client-side filtering** — the quant/GGUF/fit filters run after the fetch, so a limit-sized page could be starved down to a handful. The service now requests 3x the display limit (capped at 1000) and truncates afterwards.
- **Default limit raised 30 → 50, plus a "Load more" button** showing how many remain.
- Empty results now suggest which filter to relax (`mlx-community` narrows to a single author).

## 0.0.7 — Unreleased

Fix: `CacheNotFound` traceback after pointing `modelsDir` at a new directory.

- **`scan` tolerates a missing cache** — `scan_cache_dir()` raises `CacheNotFound` when `<HF_HOME>/hub` does not exist, which is the normal state for a freshly configured models directory. Scanning now reports an empty list instead of crashing; `delete` returns a clear message.
- **The models directory is created up front** — `<modelsDir>/hub` is made before any Python subprocess runs, so the configured location is valid immediately.
- **Readable Python errors** — helper failures surface the final traceback line in the UI instead of the raw multi-line dump; the full stderr goes to the MLX Console log.

## 0.0.6 — Unreleased

Full generation configuration, globally and per model.

- **New sampling settings** — `sampling.topK`, `sampling.minP`, `sampling.repetitionPenalty` join the existing `temperature`, `topP`, `maxTokens`. Disabling values (`topK` 0, `minP` 0, `repetitionPenalty` 1) are **omitted from requests** rather than pinning a sampler the user didn't ask for.
- **Per-model overrides** — `mlxConsole.modelOverrides` maps a model id (or a converted model's local path) to any subset of the generation settings; omitted fields fall back to the globals.
- **KV-cache budget** — `server.promptCacheBytes` (max bytes of KV caches) and `server.promptCacheSize` (max distinct caches) are now first-class settings passed to `mlx_lm.server`.
- Note on context size: `mlx_lm.server` has **no context-length flag** — the context window comes from the model's own `config.json`. The cache settings above bound how much context stays resident.

## 0.0.5 — Unreleased

Convert models to MLX at the best quantization for this machine.

- **`MLX: Convert Model to MLX (fit to machine)`** and a **Convert…** button on search results. Wraps `mlx_lm.convert`, auto-recommending the **highest `--q-bits` that fits** the memory budget (8 → 6 → 4 → 3 → 2), with estimated size per option so you can override.
- Converted models are written to `<modelsDir>/mlx-converted/<name>-<bits>bit` (or `~/mlx-models`), then offered **Set as default / Launch / Reveal** — `mlx_lm.server` accepts local paths as a model id.
- Correction: `mx.load` *can* read `.gguf` tensors. GGUF still isn't usable because mlx-lm has no pipeline mapping gguf metadata/tokenizer to a runnable model, and `mlx_lm.convert` accepts only HF-format inputs — so GGUF is rejected as a conversion source with a clear message.

## 0.0.4 — Unreleased

Hardware-aware model search, and honest GGUF handling.

- **Fit-to-machine search** — detects unified memory and cores, and grades every result against a usable budget (75% of RAM): `✓ fits` / `⚠ tight` / `✗ too large`. New **"Fits my machine"** filter hides models that can't run.
- **Accurate sizes** — exact weight bytes are derived from HF's `safetensors.parameters` (per-dtype element counts x width), fetched with bounded concurrency and cached; a parameter-count heuristic (incl. `8x7B` MoE) fills in until the exact value arrives. Estimated values are marked with `≈`.
- **Fixed `getModelSize`** — it summed `siblings[].size`, but Hugging Face never returns per-file sizes, so it always returned **0**. Now uses the dtype math above.
- **GGUF is flagged, not offered** — mlx-lm can *export* GGUF (`mlx_lm.fuse --export-gguf`) but has no loader for it, so GGUF repos are hidden by default and, when shown, are labelled unsupported with Download disabled.

## 0.0.3 — Unreleased

Fix: deleting models appeared to do nothing.

- **Native confirmation** — Delete is now a single click that opens a VS Code modal confirm, replacing the cramped two-step inline "Delete → Confirm delete" buttons that were easy to miss when three buttons wrapped in a narrow sidebar.
- **Errors are no longer swallowed** — `launch`/`delete`/`set default` previously had no `catch`, so any failed RPC produced an unhandled rejection and total silence in the UI. Failures now show an inline error banner.
- **Success feedback** — a notification reports the freed disk space after a delete.
- Added a **Refresh** link to the Models view.

## 0.0.2 — Unreleased

Configurable storage locations and machine tuning:

- **`mlxConsole.modelsDir`** — where models download/cache. Sets `HF_HOME` on every spawned Python process (server + helper), so downloads, model loading, the Models list, and Delete all agree. Cache lives at `<dir>/hub`.
- **`mlxConsole.venvPath`** — explicit venv location for the mlx-lm install. Resolution order: configured override → workspace `.venv`/`venv` → managed global-storage venv.
- **`mlxConsole.server.extraArgs`** — extra CLI flags passed to `mlx_lm.server` for machine-specific tuning (prompt cache, prefill step size, decode/prompt concurrency, speculative decoding, pipeline).
- Settings changes now re-resolve the environment and refresh the panels live; server-affecting changes prompt to restart.
- **Server & Settings** view gained a **Storage** card showing the models dir and Python env with "Change" links.

## 0.0.1 — Unreleased

Initial scaffold implementing the design plan:

- **Environment** — auto-managed Python virtualenv with guided mlx-lm install (Apple Silicon).
- **Server** — supervised `mlx_lm.server` subprocess with an OpenAI-compatible client (streaming + tool calls).
- **Native chat** — `@mlx` chat participant with `/explain`, `/fix`, `/review`, `/test`, `/doc`, plus a Language Model Chat Provider that puts MLX models in the native picker.
- **Agent / tools** — tool-call round-trip in the provider; `mlx_modelInfo` language model tool.
- **Code review** — `MLX: Review Current File` / `MLX: Review Git Diff` with optional diagnostics.
- **Management UI** — activity-bar views for Search (Hugging Face), Models, Downloads, and Server & Settings.
- **External clients** — copy-paste config for opencode and Copilot BYOK; optional LAN exposure.
- **Tests** — unit tests for the pure helpers (`node --test`).
