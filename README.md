# Pi dynamic workflows — Claude-Code-style UI

A local Pi extension that wraps the runtime of [`pi-dynamic-workflows`](https://github.com/Michaelliv/pi-dynamic-workflows) and makes workflows behave like Claude Code's:

- **Background runs** — `workflow` returns a run id immediately; a `<workflow-notification>` message arrives and triggers a turn when the run finishes.
- **Footer status** — `◆ N workflows · M agents running` (via `ctx.ui.setStatus`).
- **Widget** above the footer — each run's phase, progress, elapsed time and live agents.
- **Keyboard focus** — `↓` in an empty editor selects a workflow; `↑/↓` move, `Enter` opens its agents panel, `x` stops it, `Esc` returns to the editor.
- **`/workflows` panel** (also `alt+w`) — runs → phases/agents (status, time, tool calls, tokens, current activity) → agent transcript. Opens in place of the editor by the chat line, like Claude Code (configurable, see below).
- **Stopping** — `x` in the widget/panel, `/workflows stop [id]`, or the `workflow_stop` tool.

## Install

Paths below use `<agent-dir>`, Pi's config directory:

| Platform | Default `<agent-dir>` |
|---|---|
| macOS / Linux | `~/.pi/agent` |
| Windows | `%USERPROFILE%\.pi\agent` |

If you set `PI_CODING_AGENT_DIR`, use that directory instead.

1. Install the runtime package (personal or `--local` both work):

   ```sh
   pi install npm:pi-dynamic-workflows@1.0.1
   ```

2. Clone this repo into an extensions directory, for example `<agent-dir>/extensions/workflows`:

   ```sh
   # macOS / Linux
   git clone https://github.com/mike-r129/pi-cli-dynamic-workflows.git "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/workflows"
   ```

   ```powershell
   # Windows (PowerShell)
   $agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { "$HOME\.pi\agent" }
   git clone https://github.com/mike-r129/pi-cli-dynamic-workflows.git "$agentDir\extensions\workflows"
   ```

3. In `<agent-dir>/settings.json`, turn off the package's own extension so there is only one `workflow` tool:

   ```json
   "packages": [{ "source": "npm:pi-dynamic-workflows@1.0.1", "extensions": [] }]
   ```

4. Run `/reload` or restart Pi.

The extension finds the installed package at startup through Pi's package manager. It checks project settings first, then user settings, so npm, git and local-path sources all work. To point it somewhere else, set `PI_DYNAMIC_WORKFLOWS_DIR` to the package directory. If the package can't be found, Pi shows an error at startup and the `workflow` tool returns an install hint.

## Configuration

Choose where the `/workflows` panel opens:

| Command | Placement |
|---|---|
| `/workflows placement inline` | In place of the editor, by the chat line (default, like Claude Code) |
| `/workflows placement bottom` | Floating overlay along the bottom of the terminal |
| `/workflows placement center` | Floating overlay in the middle of the terminal |

Run `/workflows placement` with no option to see the current setting. The choice is saved to `<agent-dir>/pi-workflows.json`:

```json
{ "panelPlacement": "inline" }
```

## Files

| File | Role |
|---|---|
| `index.ts` | Tools, `/workflows` command, shortcut, widget/status painting, key focus, notifications |
| `registry.ts` | In-memory run/agent state |
| `live-agent.ts` | Subagent runner that streams tool calls, tokens and text to the UI |
| `render.ts` | Footer, widget and row renderers |
| `runtime.ts` | Locates and loads the `pi-dynamic-workflows` runtime |
| `panel.ts` | `/workflows` overlay |

In non-interactive mode (`pi -p`) workflows run in the foreground and return their result directly.

## License

MIT, see [LICENSE](LICENSE). `live-agent.ts` is derived from [`pi-dynamic-workflows`](https://github.com/Michaelliv/pi-dynamic-workflows) (MIT).
