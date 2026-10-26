/**
 * /workflows overlay: list of runs → run detail (phases + agents) → agent transcript.
 * Keys: ↑/↓ select · Enter open · Esc/← back (closes at top) · x stop run.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowRegistry, WorkflowRun } from "./registry.ts";
import { agentRow, elapsed, fmtTokens, phaseHeader, runSummary } from "./render.ts";

type View = { kind: "list" } | { kind: "run"; runId: string } | { kind: "agent"; runId: string; agentId: number };

const MAX_BODY = 22;

export class WorkflowsPanel {
	focused = false;
	private view: View;
	private selected = 0;
	private scroll = 0;
	private unsubscribe: () => void;
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly registry: WorkflowRegistry,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly done: () => void,
		private readonly initialRunId?: string,
	) {
		this.view = initialRunId ? { kind: "run", runId: initialRunId } : { kind: "list" };
		this.unsubscribe = registry.onChange(() => this.requestRender());
		// Elapsed timers tick even when no events arrive.
		this.timer = setInterval(() => this.requestRender(), 1000);
	}

	dispose() {
		this.unsubscribe();
		clearInterval(this.timer);
	}

	invalidate() {}

	private currentRun(): WorkflowRun | undefined {
		return this.view.kind === "list" ? undefined : this.registry.get(this.view.runId);
	}

	/** Agents in display order (grouped by phase), matching render order. */
	private orderedAgents(run: WorkflowRun) {
		const phases = this.phasesOf(run);
		const out = phases.flatMap((p) => run.agents.filter((a) => a.phase === p));
		return [...out, ...run.agents.filter((a) => !a.phase || !phases.includes(a.phase))];
	}

	private phasesOf(run: WorkflowRun): string[] {
		return [...new Set([...run.phases, ...run.agents.map((a) => a.phase).filter((p): p is string => !!p)])];
	}

	private itemCount(): number {
		if (this.view.kind === "list") return this.registry.list().length;
		const run = this.currentRun();
		if (!run) return 0;
		return this.view.kind === "run" ? run.agents.length : 0;
	}

	handleInput(data: string): void {
		const count = this.itemCount();
		if (matchesKey(data, "escape") || matchesKey(data, "left") || matchesKey(data, "q")) {
			if (this.view.kind === "agent") this.view = { kind: "run", runId: this.view.runId };
			// Opened on a specific run (e.g. from the widget): backing out of it closes, like Claude Code.
			else if (this.view.kind === "run" && this.view.runId === this.initialRunId) return this.done();
			else if (this.view.kind === "run") this.view = { kind: "list" };
			else return this.done();
			this.selected = 0;
			this.scroll = 0;
		} else if (matchesKey(data, "up")) {
			if (this.view.kind === "agent") this.scroll++;
			else this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, "down")) {
			if (this.view.kind === "agent") this.scroll = Math.max(0, this.scroll - 1);
			else this.selected = Math.min(Math.max(0, count - 1), this.selected + 1);
		} else if (matchesKey(data, "return") || matchesKey(data, "right")) {
			if (this.view.kind === "list") {
				const run = this.registry.list()[this.selected];
				if (run) this.view = { kind: "run", runId: run.id };
				this.selected = 0;
			} else if (this.view.kind === "run") {
				const run = this.currentRun();
				const agent = run && this.orderedAgents(run)[this.selected];
				if (agent) this.view = { kind: "agent", runId: run.id, agentId: agent.id };
				this.scroll = 0;
			}
		} else if (matchesKey(data, "x")) {
			const run = this.view.kind === "list" ? this.registry.list()[this.selected] : this.currentRun();
			if (run) this.registry.stop(run.id);
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const inner = Math.max(20, width - 2);
		const body = this.view.kind === "list" ? this.renderList(inner) : this.view.kind === "run" ? this.renderRun(inner) : this.renderAgent(inner);
		const title =
			this.view.kind === "list" ? "Workflows" : this.view.kind === "run" ? `Workflow ${this.currentRun()?.name ?? ""}` : "Agent";
		const hint =
			this.view.kind === "agent" ? "↑↓ scroll · esc back" : `↑↓ select · enter open · x stop · esc ${this.view.kind === "list" ? "close" : "back"}`;
		const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
		const row = (s: string) => th.fg("border", "│") + pad(truncateToWidth(s, inner)) + th.fg("border", "│");
		const top = `╭─ ${th.fg("accent", th.bold(title))} `;
		return [
			th.fg("border", top) + th.fg("border", "─".repeat(Math.max(0, width - visibleWidth(top) - 1)) + "╮"),
			...body.map(row),
			row(th.fg("dim", ` ${hint}`)),
			th.fg("border", `╰${"─".repeat(inner)}╯`),
		];
	}

	private renderList(width: number): string[] {
		const th = this.theme;
		const runs = this.registry.list();
		if (!runs.length) return [th.fg("dim", " No workflows yet.")];
		this.selected = Math.min(this.selected, runs.length - 1);
		return runs.map((run, i) => {
			const pointer = i === this.selected ? th.fg("accent", "❯ ") : "  ";
			return truncateToWidth(pointer + runSummary(th, run), width);
		});
	}

	private renderRun(width: number): string[] {
		const th = this.theme;
		const run = this.currentRun();
		if (!run) return [th.fg("dim", " Workflow no longer available.")];
		const lines: string[] = [` ${runSummary(th, run)}`];
		if (run.description) lines.push(th.fg("dim", `   ${run.description}`));
		lines.push("");
		const ordered = this.orderedAgents(run);
		this.selected = Math.min(this.selected, Math.max(0, ordered.length - 1));
		const selectedAgent = ordered[this.selected];
		const phases = this.phasesOf(run);
		for (const phase of phases) {
			lines.push(phaseHeader(th, run, phase));
			for (const agent of run.agents.filter((a) => a.phase === phase)) lines.push(agentRow(th, agent, width, agent === selectedAgent));
		}
		const unphased = run.agents.filter((a) => !a.phase || !phases.includes(a.phase));
		if (unphased.length) {
			lines.push(` ${th.fg("dim", "·")} Agents`);
			for (const agent of unphased) lines.push(agentRow(th, agent, width, agent === selectedAgent));
		}
		if (!run.agents.length && run.status === "running") lines.push(th.fg("dim", "   starting…"));
		if (run.logs.length) {
			lines.push("");
			for (const log of run.logs.slice(-3)) lines.push(th.fg("dim", ` log: ${log}`));
		}
		if (run.error) lines.push(th.fg("error", ` error: ${run.error}`));
		return this.window(lines, ordered.length ? lines.findIndex((l) => l.includes("❯")) : 0);
	}

	private renderAgent(width: number): string[] {
		const th = this.theme;
		const run = this.currentRun();
		const agent = this.view.kind === "agent" ? run?.agents.find((a) => a.id === this.view.agentId) : undefined;
		if (!run || !agent) return [th.fg("dim", " Agent no longer available.")];
		const head = [
			` ${th.bold(agent.label)} ${th.fg("dim", `· ${run.name}${agent.phase ? ` › ${agent.phase}` : ""}`)}`,
			th.fg(
				"dim",
				`   ${agent.status} · ${elapsed(agent.startedAt, agent.endedAt)} · ${agent.toolCalls} tool calls · ↑${fmtTokens(agent.tokensIn)} ↓${fmtTokens(agent.tokensOut)}`,
			),
			"",
		];
		const transcript = [...agent.transcript];
		if (agent.status === "running" && agent.lastText.trim()) transcript.push(`… ${agent.lastText.replace(/\s+/g, " ").slice(-200)}`);
		const wrapped = transcript.flatMap((l) => wrap(l, width - 2)).map((l) => ` ${l}`);
		const room = MAX_BODY - head.length;
		this.scroll = Math.min(this.scroll, Math.max(0, wrapped.length - room));
		const end = wrapped.length - this.scroll;
		return [...head, ...(wrapped.length ? wrapped.slice(Math.max(0, end - room), end) : [th.fg("dim", " (no activity yet)")])];
	}

	/** Keep the selected line visible when the body exceeds MAX_BODY. */
	private window(lines: string[], focus: number): string[] {
		if (lines.length <= MAX_BODY) return lines;
		const start = Math.max(0, Math.min(focus - Math.floor(MAX_BODY / 2), lines.length - MAX_BODY));
		return lines.slice(start, start + MAX_BODY);
	}
}

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		let line = raw;
		while (visibleWidth(line) > width) {
			out.push(line.slice(0, width));
			line = line.slice(width);
		}
		out.push(line);
	}
	return out;
}
