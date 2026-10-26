/**
 * Locates the installed pi-dynamic-workflows package and loads its runtime modules,
 * so this extension works wherever the repo is cloned and however the package is installed.
 *
 * Lookup order:
 *   1. PI_DYNAMIC_WORKFLOWS_DIR (explicit override)
 *   2. Packages declared in project then user settings, via Pi's own package manager
 *      (covers npm:, git: and local-path sources, with or without --local)
 *   3. The default npm source in project then user scope (installed but not declared)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "pi-dynamic-workflows";

export interface WorkflowRuntime {
	dir: string;
	parseWorkflowScript(script: string): { meta: { name: string; description: string; phases?: { title: string }[] } };
	runWorkflow(script: string, options: Record<string, unknown>): Promise<{ result: unknown; agentCount: number }>;
	createWorkflowTool(): any;
	createStructuredOutputTool(options: { schema: unknown; capture: { called: boolean; value: unknown } }): unknown;
}

type Scope = "project" | "user";

function sourceOf(entry: unknown): string | undefined {
	const source = typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source;
	return typeof source === "string" ? source : undefined;
}

function isPackageRoot(dir: string | undefined): dir is string {
	return !!dir && existsSync(join(dir, "src", "workflow.ts"));
}

export function findPackageDir(cwd = process.cwd()): string {
	const override = process.env.PI_DYNAMIC_WORKFLOWS_DIR;
	if (override) {
		if (isPackageRoot(override)) return override;
		throw new Error(`PI_DYNAMIC_WORKFLOWS_DIR=${override} does not contain src/workflow.ts`);
	}

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const declared: Record<Scope, unknown[]> = {
		project: settingsManager.getProjectSettings().packages ?? [],
		user: settingsManager.getGlobalSettings().packages ?? [],
	};

	const candidates: [string, Scope][] = [];
	for (const scope of ["project", "user"] as const) {
		for (const entry of declared[scope]) {
			const source = sourceOf(entry);
			if (source?.includes(PACKAGE_NAME)) candidates.push([source, scope]);
		}
	}
	candidates.push([`npm:${PACKAGE_NAME}`, "project"], [`npm:${PACKAGE_NAME}`, "user"]);

	for (const [source, scope] of candidates) {
		const dir = packages.getInstalledPath(source, scope);
		if (isPackageRoot(dir)) return dir;
	}
	throw new Error(
		`${PACKAGE_NAME} is not installed. Run \`pi install npm:${PACKAGE_NAME}\` or set PI_DYNAMIC_WORKFLOWS_DIR to its directory.`,
	);
}

export async function loadRuntime(): Promise<WorkflowRuntime> {
	const dir = findPackageDir();
	const load = (file: string) => import(pathToFileURL(join(dir, "src", file)).href);
	const [workflow, tool, structured] = await Promise.all([
		load("workflow.ts"),
		load("workflow-tool.ts"),
		load("structured-output.ts"),
	]);
	return {
		dir,
		parseWorkflowScript: workflow.parseWorkflowScript,
		runWorkflow: workflow.runWorkflow,
		createWorkflowTool: tool.createWorkflowTool,
		createStructuredOutputTool: structured.createStructuredOutputTool,
	};
}
