/**
 * Claude-Code-style dynamic workflows for Pi.
 *
 * Wraps the runtime of the pi-dynamic-workflows package (located at load time by
 * runtime.ts; its own extension is disabled in settings.json) and adds:
 *   - background runs: `workflow` returns a run id immediately; a notification
 *     message arrives and triggers a turn when the run settles
 *   - footer status "◆ N workflows · M agents running" (via setStatus)
 *   - below-editor widget with each run's phase, progress and live agents
 *   - /workflows (and alt+w) overlay: runs → phases/agents → agent transcript
 *   - stopping runs: `x` in the panel, `/workflows stop [id]`, or the workflow_stop tool
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, type TUI, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentObserver, LiveWorkflowAgent } from "./live-agent.ts";
import { WorkflowsPanel } from "./panel.ts";
import { type AgentRecord, WorkflowRegistry, type WorkflowRun } from "./registry.ts";
import { elapsed, footerStatus, widgetLines } from "./render.ts";
import { loadRuntime, type WorkflowRuntime } from "./runtime.ts";

const KEY = "workflows";
const PAINT_MS = 250;
const LINGER_MS = 10_000;
const MAX_RESULT_CHARS = 20_000;

/**
 * Where the /workflows panel opens:
 *   inline — in place of the editor, by the chat line (Claude Code style, default)
 *   bottom — floating overlay anchored to the bottom of the terminal
 *   center — floating overlay in the middle of the terminal
 */
const PLACEMENTS = ["inline", "bottom", "center"] as const;
type Placement = (typeof PLACEMENTS)[number];
interface WorkflowsConfig {
	panelPlacement: Placement;
}
const CONFIG_FILE = "pi-workflows.json";

function loadConfig(): WorkflowsConfig {
	try {
		const raw = JSON.parse(readFileSync(join(getAgentDir(), CONFIG_FILE), "utf8"));
		if (PLACEMENTS.includes(raw.panelPlacement)) return { panelPlacement: raw.panelPlacement };
	} catch {}
	return { panelPlacement: "inline" };
}

function saveConfig(config: WorkflowsConfig) {
	writeFileSync(join(getAgentDir(), CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

export default async function extension(pi: ExtensionAPI) {
	let runtime: WorkflowRuntime;
	try {
		runtime = await loadRuntime();
	} catch (error) {
		// Don't throw from the factory (print mode hangs); surface the install hint instead.
		const message = `workflows extension disabled: ${error instanceof Error ? error.message : String(error)}`;
		pi.registerTool(
			defineTool({
				name: "workflow",
				label: "Workflow",
				description: "Unavailable: the pi-dynamic-workflows runtime package is not installed.",
				parameters: Type.Object({ script: Type.String() }),
				async execute() {
					throw new Error(message);
				},
			}),
		);
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(message, "error");
		});
		return;
	}
	const { parseWorkflowScript, runWorkflow } = runtime;
	const registry = new WorkflowRegistry();
	const config = loadConfig();
	const base = runtime.createWorkflowTool();
	let ui: ExtensionContext | undefined;
	let widgetTui: { requestRender(): void } | undefined;
	let paintTimer: ReturnType<typeof setTimeout> | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	let lastStatus: string | undefined;
	/** Selected run in the widget while it has keyboard focus (undefined = editor has focus). */
	let focusIndex: number | undefined;

	// ---------------------------------------------------------------- painting

	const visibleRuns = () =>
		registry.list().filter((r) => r.status === "running" || (r.endedAt && Date.now() - r.endedAt < LINGER_MS));

	const paint = () => {
		paintTimer = undefined;
		if (!ui?.hasUI) return;
		const status = footerStatus(registry.list());
		if (status !== lastStatus) ui.ui.setStatus(KEY, status);
		lastStatus = status;
		const visible = visibleRuns();
		if (!visible.length) {
			if (widgetTui) ui.ui.setWidget(KEY, undefined);
			widgetTui = undefined;
		} else if (!widgetTui) {
			ui.ui.setWidget(
				KEY,
				(tui, theme) => {
					widgetTui = tui;
					const removeListener = tui.addInputListener((data) => handleWidgetKey(tui, data));
					return {
						render: (width: number) => {
							const runs = visibleRuns();
							if (focusIndex !== undefined) focusIndex = runs.length ? Math.min(focusIndex, runs.length - 1) : undefined;
							return widgetLines(theme, runs, width, focusIndex);
						},
						invalidate() {},
						dispose() {
							removeListener();
							focusIndex = undefined;
						},
					};
				},
				{ placement: "belowEditor" },
			);
		} else {
			widgetTui.requestRender();
		}
		// 1 Hz tick keeps elapsed times moving and expires lingering finished runs.
		if (visible.length && !tickTimer) tickTimer = setInterval(schedulePaint, 1000);
		if (!visible.length && tickTimer) {
			clearInterval(tickTimer);
			tickTimer = undefined;
		}
	};

	/**
	 * Claude-Code-style footer focus: ↓ in an empty editor selects a workflow in the
	 * widget; ↑/↓ move, Enter opens its agents panel, x stops it, Esc/↑-at-top returns.
	 * Any other key leaves selection and goes to the editor as usual.
	 */
	const handleWidgetKey = (tui: TUI, data: string): { consume: boolean } | undefined => {
		if (tui.hasOverlay()) return undefined;
		const runs = visibleRuns();
		if (focusIndex === undefined) {
			if (!runs.length || !matchesKey(data, "down")) return undefined;
			const focused = tui.getFocusedComponent() as { getText?: () => string } | null;
			if (typeof focused?.getText !== "function" || focused.getText() !== "") return undefined;
			focusIndex = 0;
		} else if (matchesKey(data, "down")) {
			focusIndex = Math.min(runs.length - 1, focusIndex + 1);
		} else if (matchesKey(data, "up")) {
			focusIndex = focusIndex === 0 ? undefined : focusIndex - 1;
		} else if (matchesKey(data, "escape")) {
			focusIndex = undefined;
		} else if (matchesKey(data, "return") || matchesKey(data, "right")) {
			const run = runs[focusIndex];
			focusIndex = undefined;
			if (run && ui) void openPanel(ui, run.id);
		} else if (matchesKey(data, "x")) {
			const run = runs[focusIndex];
			if (run) registry.stop(run.id);
		} else {
			focusIndex = undefined;
			tui.requestRender();
			return undefined;
		}
		tui.requestRender();
		return { consume: true };
	};

	const schedulePaint = () => {
		if (!paintTimer) paintTimer = setTimeout(paint, PAINT_MS);
	};
	registry.onChange(schedulePaint);

	// ------------------------------------------------------------- run plumbing

	const observerFor = (run: WorkflowRun, bound: Set<AgentRecord>) => (label: string | undefined) => {
		// onAgentStart fires synchronously right before agent.run, so the newest unbound record with this label is ours.
		const agent = [...run.agents].reverse().find((a) => a.label === label && !bound.has(a));
		if (!agent) return undefined;
		bound.add(agent);
		const observer: AgentObserver = {
			onToolStart(toolName, args) {
				agent.toolCalls++;
				agent.currentTool = toolName;
				registry.pushTranscript(agent, `⚙ ${toolName} ${summarizeArgs(args)}`);
				registry.changed();
			},
			onToolEnd(toolName, isError) {
				agent.currentTool = undefined;
				if (isError) registry.pushTranscript(agent, `  ✗ ${toolName} failed`);
				registry.changed();
			},
			onTextDelta(delta) {
				agent.lastText = (agent.lastText + delta).slice(-400);
				registry.changed();
			},
			onMessageEnd(usage, text) {
				if (usage) {
					agent.tokensIn += usage.input;
					agent.tokensOut += usage.output;
				}
				if (text.trim()) registry.pushTranscript(agent, text.trim());
				agent.lastText = "";
				registry.changed();
			},
			onFinish(error, result) {
				agent.status = error ? (run.controller.signal.aborted ? "skipped" : "error") : "done";
				agent.endedAt = Date.now();
				agent.currentTool = undefined;
				agent.resultPreview = error ? error : preview(result, 80);
				if (error) registry.pushTranscript(agent, `✗ ${error}`);
				registry.changed();
			},
		};
		return observer;
	};

	const startRun = (script: string, args: unknown, ctx: ExtensionContext) => {
		const parsed = parseWorkflowScript(script);
		const run = registry.create({
			name: parsed.meta.name,
			description: parsed.meta.description,
			phases: (parsed.meta.phases ?? []).map((p) => p.title),
		});
		const bound = new Set<AgentRecord>();
		const agent = new LiveWorkflowAgent(ctx.cwd, { modelRegistry: ctx.modelRegistry, model: ctx.model }, observerFor(run, bound), runtime.createStructuredOutputTool);

		const promise = runWorkflow(script, {
			cwd: ctx.cwd,
			args,
			signal: run.controller.signal,
			agent: agent as any,
			onLog(message) {
				run.logs.push(message);
				registry.changed();
			},
			onPhase(title) {
				run.currentPhase = title;
				if (!run.phases.includes(title)) run.phases.push(title);
				registry.changed();
			},
			onAgentStart(event) {
				if (event.phase && !run.phases.includes(event.phase)) run.phases.push(event.phase);
				run.agents.push({
					id: run.agents.length + 1,
					label: event.label,
					phase: event.phase,
					prompt: event.prompt,
					status: "running",
					startedAt: Date.now(),
					toolCalls: 0,
					tokensIn: 0,
					tokensOut: 0,
					lastText: "",
					transcript: [],
				});
				registry.changed();
			},
		}).then(
			(result) => {
				if (result.agentCount === 0) registry.finish(run, "failed", { error: "workflow scripts must call agent() at least once" });
				else registry.finish(run, "completed", { result: result.result });
			},
			(error) => {
				if (run.controller.signal.aborted) registry.finish(run, "stopped", { error: "stopped by user" });
				else registry.finish(run, "failed", { error: error instanceof Error ? error.message : String(error) });
			},
		);
		return { run, promise };
	};

	const notificationText = (run: WorkflowRun) => {
		const result = run.result === undefined ? "" : truncate(JSON.stringify(run.result, null, 2) ?? "", MAX_RESULT_CHARS);
		return [
			"<workflow-notification>",
			`<run-id>${run.id}</run-id>`,
			`<name>${run.name}</name>`,
			`<status>${run.status}</status>`,
			`<summary>Workflow "${run.name}" ${run.status} in ${elapsed(run.startedAt, run.endedAt)} with ${run.agents.length} agent(s).</summary>`,
			run.error ? `<error>${run.error}</error>` : "",
			result ? `<result>\n${result}\n</result>` : "",
			"</workflow-notification>",
		]
			.filter(Boolean)
			.join("\n");
	};

	const details = (run: WorkflowRun) => ({
		runId: run.id,
		name: run.name,
		status: run.status,
		agentCount: run.agents.length,
		failed: run.agents.filter((a) => a.status === "error").length,
		durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
		error: run.error,
	});

	// ------------------------------------------------------------------- tools

	pi.registerTool(
		defineTool({
			...base,
			promptSnippet: `${base.promptSnippet} Runs in the background: returns a run id at once; a <workflow-notification> message arrives when it finishes.`,
			promptGuidelines: [
				...(base.promptGuidelines ?? []),
				"For workflow, the tool returns immediately with a run id while the workflow runs in the background. Do not poll or wait; continue other work or end your turn. A <workflow-notification> message with the status and result arrives automatically when it finishes.",
				"For workflow, use workflow_stop with the run id to cancel a running workflow when the user asks.",
			],
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const script = (base.prepareArguments ? base.prepareArguments(params) : params).script;
				const { run, promise } = startRun(script, params.args, ctx);

				// Without a UI (print/json mode) nothing would receive a later notification, so run in the foreground.
				if (!ctx.hasUI) {
					await promise;
					return { content: [{ type: "text", text: notificationText(run) }], details: details(run) };
				}

				void promise.then(() =>
					pi.sendMessage(
						{ customType: "workflow-notification", content: notificationText(run), display: true, details: details(run) },
						{ triggerTurn: true, deliverAs: "followUp" },
					),
				);
				return {
					content: [
						{
							type: "text",
							text: `Started workflow ${run.id} (${run.name}) in the background. You will receive a <workflow-notification> when it finishes; do not poll.`,
						},
					],
					details: details(run),
				};
			},
			renderCall(_args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
			},
			renderResult(result, _opts, theme) {
				const d = result.details as ReturnType<typeof details> | undefined;
				if (!d?.runId) return new Text(theme.fg("muted", "workflow"), 0, 0);
				const live = registry.get(d.runId);
				const status = live?.status ?? d.status;
				return new Text(
					`${theme.fg("accent", "◆")} ${theme.bold(d.name)} ${theme.fg("dim", `${d.runId} · ${status === "running" ? "running in background · /workflows to view" : status}`)}`,
					0,
					0,
				);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "workflow_stop",
			label: "Stop workflow",
			description: "Stop a running background workflow by run id (or all running workflows if runId is omitted).",
			parameters: Type.Object({ runId: Type.Optional(Type.String({ description: "Run id such as wf_1" })) }),
			async execute(_id, params) {
				const ids = params.runId ? [params.runId] : registry.running().map((r) => r.id);
				const stopped = ids.filter((id) => registry.stop(id));
				return {
					content: [{ type: "text", text: stopped.length ? `Stopping ${stopped.join(", ")}.` : "No matching running workflow." }],
					details: { stopped },
				};
			},
		}),
	);

	pi.registerMessageRenderer("workflow-notification", (message, { expanded, outputPad }, theme) => {
		const d = message.details as ReturnType<typeof details> | undefined;
		const ok = d?.status === "completed";
		const icon = ok ? theme.fg("success", "✓") : d?.status === "stopped" ? theme.fg("dim", "■") : theme.fg("error", "✗");
		const failed = d?.failed ? theme.fg("error", ` · ${d.failed} failed`) : "";
		let text = `${icon} Workflow ${theme.bold(d?.name ?? "?")} ${d?.status ?? ""} ${theme.fg("dim", `· ${d?.agentCount ?? 0} agents · ${elapsed(0, d?.durationMs ?? 0)}`)}${failed}`;
		if (d?.error) text += `\n${theme.fg("error", `  ${d.error}`)}`;
		if (expanded) text += `\n${theme.fg("dim", String(message.content))}`;
		const box = new Box(outputPad, 0, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// ------------------------------------------------------- command + shortcut

	const openPanel = async (ctx: ExtensionContext, runId?: string) => {
		if (!ctx.hasUI) return;
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => new WorkflowsPanel(registry, theme, () => tui.requestRender(), () => done(undefined), runId),
			config.panelPlacement === "inline"
				? {}
				: {
						overlay: true,
						overlayOptions:
							config.panelPlacement === "bottom" ? { width: "100%", anchor: "bottom-center" } : { width: "85%", anchor: "center" },
					},
		);
	};

	pi.registerCommand("workflows", {
		description: "Show background workflows (/workflows [runId] · stop [runId] · placement inline|bottom|center)",
		handler: async (args, ctx) => {
			const [sub, id] = args.trim().split(/\s+/);
			if (sub === "placement") {
				if (!PLACEMENTS.includes(id as Placement)) {
					ctx.ui.notify(`Panel placement: ${config.panelPlacement} (options: ${PLACEMENTS.join(", ")})`, "info");
					return;
				}
				config.panelPlacement = id as Placement;
				saveConfig(config);
				ctx.ui.notify(`Workflows panel will open ${id}`, "info");
				return;
			}
			if (sub === "stop") {
				const ids = id ? [id] : registry.running().map((r) => r.id);
				const stopped = ids.filter((x) => registry.stop(x));
				ctx.ui.notify(stopped.length ? `Stopping ${stopped.join(", ")}` : "No running workflow", "info");
				return;
			}
			await openPanel(ctx, sub && registry.get(sub) ? sub : undefined);
		},
	});

	pi.registerShortcut("alt+w", {
		description: "Show background workflows",
		handler: async (ctx) => openPanel(ctx),
	});

	// --------------------------------------------------------------- lifecycle

	pi.on("session_start", (_event, ctx) => {
		ui = ctx;
		widgetTui = undefined;
		const active = pi.getActiveTools();
		const missing = ["workflow", "workflow_stop"].filter((t) => !active.includes(t));
		if (missing.length) pi.setActiveTools([...active, ...missing]);
	});

	pi.on("session_shutdown", () => {
		registry.stopAll();
		if (paintTimer) clearTimeout(paintTimer);
		if (tickTimer) clearInterval(tickTimer);
		paintTimer = tickTimer = undefined;
		if (ui?.hasUI) {
			ui.ui.setStatus(KEY, undefined);
			ui.ui.setWidget(KEY, undefined);
		}
		widgetTui = undefined;
		lastStatus = undefined;
		ui = undefined;
	});
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const v = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? Object.values(a)[0];
	return truncate(typeof v === "string" ? v : JSON.stringify(v) ?? "", 100).replace(/\s+/g, " ");
}

function preview(value: unknown, max: number): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return truncate((text ?? "").replace(/\s+/g, " "), max);
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
