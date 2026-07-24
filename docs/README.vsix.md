# MLX Console

**Run local LLMs on Apple Silicon from VS Code — models, memory and chat, without leaving the editor.**

MLX Console drives [mlx-lm](https://github.com/ml-explore/mlx-lm)'s inference server: download
and convert models, load them, watch what they actually cost in unified memory, and use them
in VS Code chat.

## What you get

- **Chat integration** — every downloaded model appears in the chat model picker (one-time
  enable: model dropdown → **Manage Models…** → **MLX (local)**), plus the `@mlx` participant.
  Picking a model starts the server and loads it inside your first message. Native and MCP
  tools are forwarded.
- **Panels** — Dashboard (live memory/GPU charts and an honest verdict on what fits), Models,
  Hugging Face search filtered to what mlx-lm can genuinely run, Downloads with real
  progress, Settings, and client snippets for any OpenAI-compatible tool.
- **An OpenAI-compatible endpoint** at `http://127.0.0.1:8080/v1` for everything else.

## Two ways to run

- **With the MLX Console desktop app** (recommended): the app owns the runtime — Python
  environment, models, server — and this extension connects to it automatically. Nothing to
  set up in the editor.
- **Without the app**: the extension manages everything itself. First run offers a one-time
  setup (Python venv + mlx-lm). Requires macOS on Apple Silicon.

`mlxConsole.mode` forces either behaviour; `mlxConsole.daemonUrl` points at a daemon that
discovery would not find on its own.

## Notes

- The server holds **one model resident** and never unloads on its own — loading happens
  inside the first request that names a model, which for large models takes minutes. The
  Dashboard says what is resident and what it costs.
- Memory verdicts are measured, not guessed: the Metal working-set ceiling, KV-cache cost per
  token from each model's own config, and live pressure.

Full documentation, the desktop app and the CLI live in the
[MLX Console repository](https://github.com/bengurion/mlx-console).

Licensed under the [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license).
