import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type AgentKind =
	| "pi"
	| "claude"
	| "codex"
	| "gemini"
	| "cursor"
	| "devin"
	| "agy"
	| "cline"
	| "omp"
	| "mastracode"
	| "opencode"
	| "copilot"
	| "kimi"
	| "kiro"
	| "droid"
	| "amp"
	| "grok"
	| "hermes"
	| "kilo"
	| "qodercli"
	| "maki";

export type WorkerRole = "explorer" | "builder" | "verifier";

export interface PaneInfo {
	pane_id: string;
	workspace_id: string;
	tab_id: string;
	focused: boolean;
	cwd?: string;
	foreground_cwd?: string;
	label?: string;
	agent?: string;
	agent_status: AgentStatus;
}

export interface RoleDefaults {
	kind: AgentKind;
	model: string;
	/** Extra native agent arguments passed unchanged after `--`. */
	args: string[];
}

export interface OrchestratorConfig {
	roles: {
		explorer: RoleDefaults & { readOnly: true };
		builder: RoleDefaults;
		verifier: RoleDefaults & { readOnly: true };
	};
	reviewer: {
		kind: AgentKind;
		model: string;
		args: string[];
	};
	ledgerDir: string;
	startDelayMs: number;
	promptTimeoutMs: number;
	readLines: number;
}

export const DEFAULT_WORKER: RoleDefaults = {
	kind: "opencode",
	model: "opencode/deepseek-v4-flash-free",
	args: ["--model", "opencode/deepseek-v4-flash-free"],
};

export const DEFAULT_REVIEWER = {
	kind: "pi",
	model: "gpt-5.6-sol",
	args: ["--model", "gpt-5.6-sol", "--thinking", "low"],
} as const;

export function reviewerDefaults(): OrchestratorConfig["reviewer"] {
	return { ...DEFAULT_REVIEWER, args: [...DEFAULT_REVIEWER.args] };
}

export function defaultConfig(): OrchestratorConfig {
	return {
		roles: {
			explorer: { ...DEFAULT_WORKER, readOnly: true },
			builder: { ...DEFAULT_WORKER },
			verifier: { ...DEFAULT_WORKER, readOnly: true },
		},
		reviewer: reviewerDefaults(),
		ledgerDir: ".herdr-runs",
		startDelayMs: 2000,
		promptTimeoutMs: 120_000,
		readLines: 120,
	};
}

export interface SlicePlan {
	name: string;
	role: WorkerRole;
	scope: string;
	nonGoals?: string;
	authority?: string;
	acceptance?: string;
	evidence?: string;
}

export function workerLedgerPath(ledger: string, name: string): string {
	return path.join(ledger, `${name}.md`);
}

export function briefPath(ledger: string, name: string): string {
	return path.join(ledger, `${name}.brief.md`);
}

export async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

export async function ensureDir(p: string): Promise<void> {
	await fs.mkdir(p, { recursive: true });
}

export async function readText(p: string): Promise<string> {
	return fs.readFile(p.toString(), "utf8").catch(() => "");
}

export async function writeText(p: string, content: string): Promise<void> {
	await ensureDir(path.dirname(p));
	await fs.writeFile(p.toString(), content, "utf8");
}

export async function guessProjectRoot(start: string): Promise<string | undefined> {
	let current = path.resolve(start);
	for (let i = 0; i < 10; i++) {
		if (await fileExists(path.join(current, ".git"))) return current;
		if (await fileExists(path.join(current, "package.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

export function configRoot(): string {
	return path.join(os.homedir(), ".pi", "agent", "pi-herdr-orchestrator");
}

export function configFile(): string {
	return path.join(configRoot(), "config.json");
}

export async function loadConfig(): Promise<OrchestratorConfig> {
	const configured = await readText(configFile()).then((text) => {
		if (!text.trim()) return {};
		return JSON.parse(text);
	});
	return mergeConfig(configured);
}

function mergeConfig(partial: any): OrchestratorConfig {
	const base = defaultConfig();
	if (!partial || typeof partial !== "object") return base;
	const out = base;
	if (partial.roles?.explorer) out.roles.explorer = { ...out.roles.explorer, ...partial.roles.explorer };
	if (partial.roles?.builder) out.roles.builder = { ...out.roles.builder, ...partial.roles.builder };
	if (partial.roles?.verifier) out.roles.verifier = { ...out.roles.verifier, ...partial.roles.verifier };
	if (partial.reviewer) out.reviewer = { ...out.reviewer, ...partial.reviewer };
	if (typeof partial.ledgerDir === "string") out.ledgerDir = partial.ledgerDir;
	if (typeof partial.startDelayMs === "number") out.startDelayMs = partial.startDelayMs;
	if (typeof partial.promptTimeoutMs === "number") out.promptTimeoutMs = partial.promptTimeoutMs;
	if (typeof partial.readLines === "number") out.readLines = partial.readLines;
	return out;
}

export function ledgerDirFrom(cwd: string, ledgerDir: string): string {
	if (path.isAbsolute(ledgerDir)) return ledgerDir;
	return path.join(cwd, ledgerDir);
}

export function planPath(ledger: string): string {
	return path.join(ledger, "plan.md");
}

export function reviewPath(ledger: string, sliceName: string): string {
	return path.join(ledger, "slices", `${sliceName}.review.md`);
}

export const DONE_MARKER = "DONE:";
export const BLOCKED_MARKER = "BLOCKED:";

export function hasDoneMarker(text: string): boolean {
	return text.includes(DONE_MARKER);
}

export function hasBlockedMarker(text: string): boolean {
	return text.includes(BLOCKED_MARKER);
}

export function tailLines(text: string, keep = 120): string {
	const lines = text.split("\n");
	if (lines.length <= keep) return text;
	return `[...] ${lines.slice(-keep).join("\n")}`;
}