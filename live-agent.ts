/**
 * Fork of pi-dynamic-workflows' WorkflowAgent that subscribes to each subagent
 * session so the UI can show live tool calls, tokens and text.
 */

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	createCodingTools,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { WorkflowRuntime } from "./runtime.ts";

export interface AgentObserver {
	onToolStart(toolName: string, args: unknown): void;
	onToolEnd(toolName: string, isError: boolean): void;
	onTextDelta(delta: string): void;
	onMessageEnd(usage: { input: number; output: number } | undefined, text: string): void;
	onFinish(error: string | undefined, result?: unknown): void;
}

export interface LiveRunOptions {
	label?: string;
	schema?: any;
	instructions?: string;
	signal?: AbortSignal;
}

export class LiveWorkflowAgent {
	constructor(
		private readonly cwd: string,
		private readonly sessionOptions: Partial<CreateAgentSessionOptions>,
		/** Returns the observer for the agent with this label (called once per run). */
		private readonly observerFor: (label: string | undefined) => AgentObserver | undefined,
		private readonly createStructuredOutputTool: WorkflowRuntime["createStructuredOutputTool"],
	) {}

	async run(prompt: string, options: LiveRunOptions = {}): Promise<unknown> {
		const observer = this.observerFor(options.label);
		try {
			const result = await this.runInner(prompt, options, observer);
			observer?.onFinish(undefined, result);
			return result;
		} catch (error) {
			observer?.onFinish(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	private async runInner(prompt: string, options: LiveRunOptions, observer: AgentObserver | undefined): Promise<unknown> {
		const capture = { called: false, value: undefined as unknown };
		const customTools: ToolDefinition[] = [...createCodingTools(this.cwd)];
		if (options.schema) {
			customTools.push(this.createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
		}

		const agentDir = getAgentDir();
		const { session } = await createAgentSession({
			cwd: this.cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(this.cwd),
			settingsManager: SettingsManager.create(this.cwd, agentDir),
			customTools,
			...this.sessionOptions,
		});

		const unsubscribe = observer
			? session.subscribe((event: any) => {
					switch (event.type) {
						case "tool_execution_start":
							observer.onToolStart(event.toolName, event.args);
							break;
						case "tool_execution_end":
							observer.onToolEnd(event.toolName, event.isError);
							break;
						case "message_update":
							if (event.assistantMessageEvent?.type === "text_delta") observer.onTextDelta(event.assistantMessageEvent.delta ?? "");
							break;
						case "message_end":
							if (event.message?.role === "assistant") {
								const m = event.message as AssistantMessage;
								observer.onMessageEnd(m.usage ? { input: m.usage.input ?? 0, output: m.usage.output ?? 0 } : undefined, textOf(m));
							}
							break;
					}
				})
			: undefined;

		let removeAbortListener: (() => void) | undefined;
		try {
			if (options.signal?.aborted) throw new Error("Subagent was aborted");
			if (options.signal) {
				const onAbort = () => void session.abort();
				options.signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
			}

			await session.prompt(buildPrompt(prompt, options));
			if (options.signal?.aborted) throw new Error("Subagent was aborted");

			if (options.schema) {
				if (!capture.called) throw new Error("Subagent finished without calling structured_output");
				return capture.value;
			}
			for (let i = session.messages.length - 1; i >= 0; i--) {
				const m = session.messages[i] as Partial<AssistantMessage>;
				if (m?.role === "assistant" && Array.isArray(m.content)) {
					const text = textOf(m as AssistantMessage);
					if (text.trim()) return text;
				}
			}
			return "";
		} finally {
			removeAbortListener?.();
			unsubscribe?.();
			session.dispose();
		}
	}
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function buildPrompt(prompt: string, options: LiveRunOptions): string {
	const parts = [options.instructions, options.label ? `Task label: ${options.label}` : undefined, prompt].filter(Boolean);
	if (options.schema) {
		parts.push(
			[
				"Final output contract:",
				"- Your final action MUST be a structured_output tool call.",
				"- The structured_output arguments are the return value of this subagent.",
				"- Do not emit a prose final answer instead of structured_output.",
				"- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
			].join("\n"),
		);
	}
	return parts.join("\n\n");
}
