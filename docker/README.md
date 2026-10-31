# Mirage Cloud Panel sandbox templates

[Docker Sandbox](https://docs.docker.com/ai/sandboxes/) templates that add Mirage Cloud Panel — a web panel for
Claude Code — on top of the Claude Code and Codex sandbox images, so the agent inside the sandbox is reachable
from any browser.

Mirage Cloud Panel is a modified version of CloudCLI UI (https://github.com/siteboon/claudecodeui); these
templates are derived from the upstream project's sandbox templates.

## Build the images

The panel is built from this repository, so build from the repository root:

```bash
docker build -f docker/claude-code/Dockerfile -t mirage-cloud-panel/sandbox:claude-code .
docker build -f docker/codex/Dockerfile -t mirage-cloud-panel/sandbox:codex .
```

No images are published yet. To use them on another machine, push them to your own registry and use that
reference as the template below.

## Run

1. Install the `sbx` CLI: [docs.docker.com/ai/sandboxes/get-started](https://docs.docker.com/ai/sandboxes/get-started/).
2. Store your API key once — it never enters the sandbox:

   ```bash
   sbx login
   sbx secret set -g anthropic   # Claude Code
   sbx secret set -g openai      # Codex
   ```

3. Start a sandbox with the panel:

   ```bash
   mirage sandbox ~/my-project --template mirage-cloud-panel/sandbox:claude-code
   mirage sandbox ~/my-project --agent codex --template mirage-cloud-panel/sandbox:codex
   ```

   Open **http://localhost:3001** and set a password on the first visit.

Without `--template`, `mirage sandbox` falls back to the upstream CloudCLI UI images
(`docker.io/cloudcliai/sandbox:*`), which run the upstream web UI rather than Mirage Cloud Panel.

## Managing sandboxes

```bash
mirage sandbox ls
mirage sandbox stop my-project       # Stop (preserves state)
mirage sandbox start my-project      # Restart and re-launch the web UI
mirage sandbox logs my-project       # Web UI logs (/tmp/mirage-ui.log)
mirage sandbox rm my-project         # Remove everything
```

Or use `sbx` directly (`sbx ls`, `sbx exec my-project bash`, …). Inside a sandbox the panel auto-starts from
`~/.bashrc`; restart it by hand with:

```bash
sbx exec my-project bash -c 'pkill -f "server/index.js"'
sbx exec -d my-project mirage start --port 3001
```

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `3001` | Web UI port |
| `HOST` | `0.0.0.0` | Bind address (must be `0.0.0.0` for `sbx ports`) |
| `DATABASE_PATH` | see the main README | SQLite database location |

Full options: [Docker Sandboxes usage guide](https://docs.docker.com/ai/sandboxes/usage/).

## License

AGPL-3.0-or-later, with the additional terms in `LICENSE`.
