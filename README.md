# Pi dynamic workflows — Claude-Code-style UI

A local Pi extension that wraps the runtime of [`pi-dynamic-workflows`](https://github.com/Michaelliv/pi-dynamic-workflows) and makes workflows behave like Claude Code's:

- **Background runs** — `workflow` returns a run id immediately; a `<workflow-notification>` message arrives and triggers a turn when the run finishes.
- **Footer status** — `◆ N workflows · M agents running` (via `ctx.ui.setStatus`).
- **Widget** above the footer — each run's phase, progress, elapsed time and live agents.
- **Keyboard focus** — `↓` in an empty editor selects a workflow; `↑/↓` move, `Enter` opens its agents panel, `x` stops it, `Esc` returns to the editor.
- **`/workflows` panel** (also `alt+w`) — runs → phases/agents (status, time, tool calls, tokens, current activity) → agent transcript.
- **Stopping** — `x` in the widget/panel, `/workflows stop [id]`, or the `workflow_stop` tool.

## Install

Paths below use `<agent-dir>`, Pi's config directory:

| Platform | Default `<agent-dir>` |
|---|---|
| macOS / Linux | `~/.pi/agent` |
| Windows | `%USERPROFILE%\.pi\agent` |

If you set `PI_CODING_AGENT_DIR`, use that directory instead.

1. Install the runtime package as a personal (not `--local`) package:

   ```sh
   pi install npm:pi-dynamic-workflows@1.0.1
   ```

2. Clone this repo into `<agent-dir>/extensions/workflows`:

   ```sh
   # macOS / Linux
   git clone https://github.com/mike-r129/py-cli-dynamic-workflows.git "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/workflows"
   ```

   ```powershell
   # Windows (PowerShell)
   $agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { "$HOME\.pi\agent" }
   git clone https://github.com/mike-r129/py-cli-dynamic-workflows.git "$agentDir\extensions\workflows"
   ```

3. In `<agent-dir>/settings.json`, turn off the package's own extension so there is only one `workflow` tool:

   ```json
   "packages": [{ "source": "npm:pi-dynamic-workflows@1.0.1", "extensions": [] }]
   ```

4. Run `/reload` or restart Pi.

The extension imports the package source by relative path (`../../npm/node_modules/pi-dynamic-workflows/src/`), because the published package ships without `dist/`. Keep both locations as described: the repo at `<agent-dir>/extensions/workflows` and the package installed personally, which puts it under `<agent-dir>/npm/node_modules`.

## Files

| File | Role |
|---|---|
| `index.ts` | Tools, `/workflows` command, shortcut, widget/status painting, key focus, notifications |
| `registry.ts` | In-memory run/agent state |
| `live-agent.ts` | Subagent runner that streams tool calls, tokens and text to the UI |
| `render.ts` | Footer, widget and row renderers |
| `panel.ts` | `/workflows` overlay |

In non-interactive mode (`pi -p`) workflows run in the foreground and return their result directly.
