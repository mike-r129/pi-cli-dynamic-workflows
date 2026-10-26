/**
 * In-memory registry of workflow runs (running + recently finished), shared by
 * the tool, the footer/widget painter and the /workflows panel.
 */

export type AgentStatus = "running" | "done" | "error" | "skipped";
export type RunStatus = "running" | "completed" | "failed" | "stopped";

export interface AgentRecord {
	id: number;
	label: string;
	phase?: string;
	prompt: string;
	status: AgentStatus;
	startedAt: number;
	endedAt?: number;
	toolCalls: number;
	tokensIn: number;
	tokensOut: number;
	/** Current tool while one is executing, else undefined. */
	currentTool?: string;
	/** Tail of the latest assistant text. */
	lastText: string;
	/** Recent transcript lines for drill-in (ring buffer). */
	transcript: string[];
	resultPreview?: string;
}

export interface WorkflowRun {
	id: string;
	name: string;
	description?: string;
	/** Upfront outline from meta.phases, extended by phase() calls. */
	phases: string[];
	currentPhase?: string;
	agents: AgentRecord[];
	logs: string[];
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	result?: unknown;
	error?: string;
	controller: AbortController;
}

const MAX_FINISHED = 10;
const MAX_TRANSCRIPT = 200;

export class WorkflowRegistry {
	private runs = new Map<string, WorkflowRun>();
	private listeners = new Set<() => void>();
	private seq = 0;

	create(init: { name: string; description?: string; phases: string[] }): WorkflowRun {
		this.seq++;
		const run: WorkflowRun = {
			id: `wf_${this.seq}`,
			name: init.name,
			description: init.description,
			phases: [...init.phases],
			agents: [],
			logs: [],
			status: "running",
			startedAt: Date.now(),
			controller: new AbortController(),
		};
		this.runs.set(run.id, run);
		this.prune();
		this.changed();
		return run;
	}

	get(id: string): WorkflowRun | undefined {
		return this.runs.get(id);
	}

	/** Newest first. */
	list(): WorkflowRun[] {
		return [...this.runs.values()].reverse();
	}

	running(): WorkflowRun[] {
		return this.list().filter((run) => run.status === "running");
	}

	finish(run: WorkflowRun, status: Exclude<RunStatus, "running">, patch: { result?: unknown; error?: string } = {}) {
		run.status = status;
		run.endedAt = Date.now();
		Object.assign(run, patch);
		for (const agent of run.agents) {
			if (agent.status === "running") {
				agent.status = "skipped";
				agent.endedAt = run.endedAt;
				agent.currentTool = undefined;
			}
		}
		this.changed();
	}

	stop(id: string): boolean {
		const run = this.runs.get(id);
		if (!run || run.status !== "running") return false;
		run.controller.abort();
		return true;
	}

	stopAll() {
		for (const run of this.running()) run.controller.abort();
	}

	pushTranscript(agent: AgentRecord, line: string) {
		agent.transcript.push(line);
		if (agent.transcript.length > MAX_TRANSCRIPT) agent.transcript.splice(0, agent.transcript.length - MAX_TRANSCRIPT);
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	changed() {
		for (const listener of this.listeners) listener();
	}

	private prune() {
		const finished = [...this.runs.values()].filter((run) => run.status !== "running");
		for (const run of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) this.runs.delete(run.id);
	}
}
