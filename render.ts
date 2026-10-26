/**
 * Pure text renderers for the footer status, below-editor widget and panel views.
 * `th` is Pi's Theme (fg(color, text)); kept loose so tests can pass a stub.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentRecord, AgentStatus, WorkflowRun } from "./registry.ts";

type Th = { fg(color: string, text: string): string; bold(text: string): string };

export function elapsed(from: number, to = Date.now()): string {
	const s = Math.max(0, Math.round((to - from) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const fmtTokens = (n: number) => (n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`);

const counts = (run: WorkflowRun) => ({
	done: run.agents.filter((a) => a.status === "done").length,
	running: run.agents.filter((a) => a.status === "running").length,
	errors: run.agents.filter((a) => a.status === "error").length,
	total: run.agents.length,
});

export function agentIcon(th: Th, status: AgentStatus): string {
	switch (status) {
		case "running":
			return th.fg("warning", "●");
		case "done":
			return th.fg("success", "✓");
		case "error":
			return th.fg("error", "✗");
		case "skipped":
			return th.fg("dim", "–");
	}
}

function runIcon(th: Th, run: WorkflowRun): string {
	switch (run.status) {
		case "running":
			return th.fg("accent", "◆");
		case "completed":
			return th.fg("success", "✓");
		case "failed":
			return th.fg("error", "✗");
		case "stopped":
			return th.fg("dim", "■");
	}
}

/** Footer segment, e.g. "◆ 2 workflows · 5 agents running". */
export function footerStatus(runs: WorkflowRun[]): string | undefined {
	const active = runs.filter((r) => r.status === "running");
	if (!active.length) return undefined;
	const agents = active.reduce((n, r) => n + counts(r).running, 0);
	return `◆ ${active.length} workflow${active.length === 1 ? "" : "s"} · ${agents} agent${agents === 1 ? "" : "s"} running · /workflows`;
}

export function runSummary(th: Th, run: WorkflowRun): string {
	const c = counts(run);
	const phase = run.status === "running" && run.currentPhase ? ` ${th.fg("dim", "›")} ${run.currentPhase}` : "";
	const errs = c.errors ? th.fg("error", ` · ${c.errors} failed`) : "";
	const time = th.fg("dim", elapsed(run.startedAt, run.endedAt));
	return `${runIcon(th, run)} ${th.bold(run.name)}${phase} ${th.fg("muted", `${c.done}/${c.total} agents`)}${errs} · ${time}`;
}

function activity(agent: AgentRecord): string {
	if (agent.status !== "running") return agent.resultPreview ?? "";
	if (agent.currentTool) return `⚙ ${agent.currentTool}`;
	return agent.lastText.replace(/\s+/g, " ").trim().slice(-80);
}

/** Compact below-editor widget: one line per active run, plus its running agents. */
export function widgetLines(th: Th, runs: WorkflowRun[], width: number, selected?: number): string[] {
	const lines: string[] = [];
	runs.forEach((run, i) => {
		const focus = selected === undefined ? "" : i === selected ? th.fg("accent", "❯ ") : "  ";
		lines.push(focus + runSummary(th, run));
		if (run.status !== "running") return;
		const indent = selected === undefined ? "  " : "    ";
		const live = run.agents.filter((a) => a.status === "running");
		for (const agent of live.slice(0, 4)) {
			lines.push(`${indent}${agentIcon(th, agent.status)} ${agent.label} ${th.fg("dim", activity(agent))}`);
		}
		if (live.length > 4) lines.push(th.fg("dim", `${indent}… ${live.length - 4} more running`));
	});
	if (selected !== undefined) lines.push(th.fg("dim", "  ↑↓ select · enter view agents · x stop · esc back"));
	else if (runs.length) lines.push(th.fg("dim", "  ↓ to manage workflows"));
	return lines.map((l) => truncateToWidth(l, width));
}

export function agentRow(th: Th, agent: AgentRecord, width: number, selected: boolean): string {
	const time = elapsed(agent.startedAt, agent.endedAt);
	const meta = th.fg("dim", `${time} · ${agent.toolCalls} tools · ↓${fmtTokens(agent.tokensOut)}`);
	const pointer = selected ? th.fg("accent", "❯") : " ";
	const label = selected ? th.bold(agent.label) : agent.label;
	return truncateToWidth(`${pointer}   ${agentIcon(th, agent.status)} ${label}  ${meta}  ${th.fg("muted", activity(agent))}`, width);
}

/** Phase markers: ✓ all done, ▶ active, ○ pending. */
export function phaseHeader(th: Th, run: WorkflowRun, phase: string): string {
	const agents = run.agents.filter((a) => a.phase === phase);
	const finished = agents.filter((a) => a.status !== "running").length;
	const started = agents.length > 0;
	const active = run.status === "running" && (run.currentPhase === phase || agents.some((a) => a.status === "running"));
	const marker = active ? th.fg("accent", "▶") : started && finished === agents.length ? th.fg("success", "✓") : th.fg("dim", "○");
	const tally = started ? th.fg("dim", ` ${agents.filter((a) => a.status === "done").length}/${agents.length}`) : "";
	return ` ${marker} ${active ? th.bold(phase) : phase}${tally}`;
}
