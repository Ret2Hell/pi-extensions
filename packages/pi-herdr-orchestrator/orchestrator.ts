import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import {
	type PaneInfo,
	guessProjectRoot,
	hasBlockedMarker,
	hasDoneMarker,
	ledgerDirFrom,
	loadConfig,
	planPath,
	reviewPath,
	tailLines,
	workerLedgerPath,
	briefPath,
	writeText,
} from "./core";
import { fillTemplate, loadTemplate } from "./templates";

type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

interface AgentInfo {
	name?: string;
	agent?: string;
	display_agent?: string;
	agent_status: AgentStatus;
	workspace_id: string;
	tab_id: string;
	pane_id: string;
	focused: boolean;
	cwd?: string;
}

interface HerdrJsonEnvelope {
	result?: unknown;
	error?: {
		code?: string;
		message?: string;
	};
}

type ToolCtx = {
	ui: {
		confirm(title: string, message: string): Promise<boolean>;
	};
	hasUI: boolean;
	cwd: string;
};

const RoleEnum = StringEnum(["explorer", "builder", "verifier"] as const, {
	description: "Worker role; explorer and verifier are read-only, builder may edit scoped files",
});

const AgentKindEnum = StringEnum(
	[
		"pi",
		"claude",
		"codex",
		"gemini",
		"cursor",
		"devin",
		"agy",
		"cline",
		"omp",
		"mastracode",
		"opencode",
		"copilot",
		"kimi",
		"kiro",
		"droid",
		"amp",
		"grok",
		"hermes",
		"kilo",
		"qodercli",
		"maki",
	] as const,
	{ description: "Supported coding agent kind and canonical executable" },
);

function parseHerdrError(output: string): string | null {
	const trimmed = output.trim();
	if (!trimmed) return null;
	try {
		const value = JSON.parse(trimmed) as HerdrJsonEnvelope;
		return value.error?.message || value.error?.code || trimmed;
	} catch {
		return trimmed;
	}
}

function formatOutput(output: string): string {
	const truncation = truncateTail(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return truncation.content;
	return `[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines]\n${truncation.content}`;
}

function agentDisplayName(agent: AgentInfo): string {
	return agent.name || agent.display_agent || agent.agent || agent.pane_id;
}

function summarizeAgent(agent: AgentInfo): string {
	const cwd = agent.cwd ? ` ${agent.cwd}` : "";
	return `${agentDisplayName(agent)}: [${agent.pane_id}] (${agent.agent_status}${agent.focused ? ", focused" : ""})${cwd}`;
}

function renderCallText(tool: string, args: Record<string, any>, theme: any, context: any) {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	let text = theme.fg("toolTitle", theme.bold(`${tool} `));
	text += theme.fg("accent", args.name || args.objective || args.agent || "?");
	if (args.role) text += theme.fg("dim", ` › ${args.role}`);
	if (args.slice) text += theme.fg("muted", ` ${args.slice}`);
	component.setText(text);
	return component;
}

function statusDot(theme: any, status: AgentStatus): string {
	switch (status) {
		case "blocked":
			return theme.fg("warning", "●");
		case "working":
			return theme.fg("accent", "●");
		case "done":
			return theme.fg("success", "●");
		case "idle":
			return theme.fg("muted", "○");
		default:
			return theme.fg("dim", "·");
	}
}

export default function registerOrchestrators(pi: ExtensionAPI) {
	async function execHerdr(args: string[], signal?: AbortSignal) {
		const result = await pi.exec("herdr", args, { signal });
		if (signal?.aborted || result.killed) throw new Error("Aborted");
		if (result.code !== 0) {
			const message =
				parseHerdrError(result.stderr) ||
				parseHerdrError(result.stdout) ||
				`herdr ${args.join(" ")} failed with exit code ${result.code}`;
			throw new Error(message);
		}
		return result;
	}

	async function execHerdrJson<T>(args: string[], signal?: AbortSignal): Promise<T> {
		const result = await execHerdr(args, signal);
		const stdout = result.stdout.trim();
		if (!stdout) throw new Error(`Expected JSON output from herdr ${args.join(" ")}`);
		let value: HerdrJsonEnvelope;
		try {
			value = JSON.parse(stdout) as HerdrJsonEnvelope;
		} catch {
			throw new Error(`Failed to parse JSON from herdr ${args.join(" ")}`);
		}
		if (value.error) throw new Error(value.error.message || value.error.code || `herdr ${args.join(" ")} failed`);
		return value as T;
	}

	async function execHerdrText(args: string[], signal?: AbortSignal): Promise<string> {
		return (await execHerdr(args, signal)).stdout;
	}

	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	async function resolveLedger(ctx: ToolCtx, ledgerParam: string | undefined): Promise<string> {
		const config = await loadConfig();
		const root = (await guessProjectRoot(ctx.cwd)) ?? ctx.cwd;
		return ledgerDirFrom(root, ledgerParam || config.ledgerDir);
	}

	async function splitWorkerPane(signal?: AbortSignal): Promise<PaneInfo> {
		const response = await execHerdrJson<{ result: { pane: PaneInfo } }>(
			["pane", "split", "--current", "--direction", "right", "--no-focus"],
			signal,
		);
		return response.result.pane;
	}

	async function startWorker(name: string, kind: string, paneId: string, agentArgs: string[], signal?: AbortSignal): Promise<AgentInfo> {
		const args = ["agent", "start", name, "--kind", kind, "--pane", paneId];
		if (agentArgs.length) args.push("--", ...agentArgs);
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(args, signal);
				return response.result.agent;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (message.includes("agent_pane_busy") && attempt < 3) {
					await sleep(2000 * attempt);
					continue;
				}
				throw err;
			}
		}
		throw new Error(`agent start failed after retries: ${name}`);
	}

	async function promptWorker(name: string, prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentInfo> {
		const args = ["agent", "prompt", name, prompt, "--wait", "--timeout", String(timeoutMs)];
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(args, signal);
				return response.result.agent;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (message.includes("agent_prompt_stalled") && attempt < 2) {
					await sleep(2000);
					continue;
				}
				throw err;
			}
		}
		throw new Error(`agent prompt failed after retries: ${name}`);
	}

	async function readAgent(name: string, lines: number, signal?: AbortSignal): Promise<string> {
		return execHerdrText(["agent", "read", name, "--source", "recent-unwrapped", "--lines", String(lines)], signal);
	}

	async function agentStatus(name: string, signal?: AbortSignal): Promise<AgentStatus | undefined> {
		try {
			const response = await execHerdrJson<{ result: { agent: AgentInfo } }>(["agent", "get", name], signal);
			return response.result.agent.agent_status;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes("agent_not_found") || message.includes("Agent not found")) return undefined;
			throw err;
		}
	}

	pi.registerTool({
		name: "herdr_plan",
		label: "Herdr Plan",
		description:
			"Write the orchestration plan for the current session: objective and slice breakdown (name, role, scope, non-goals, authority, acceptance, evidence). The plan is written to <workspace>/.herdr-runs/plan.md (configurable via ledger_dir) and requires explicit user approval through a confirmation dialog before it takes effect; without a dialog-capable UI, the draft is still written and approval is reported as pending.",
		promptSnippet: "Write and approve the orchestration plan",
		promptGuidelines: [
			"Use herdr_plan once at the start of an orchestration session to fix the objective and the slice breakdown.",
			"The plan must be approved by the user before herdr_dispatch starts any worker.",
			"Read opaque ledger paths from results instead of constructing them; the ledger is per-workspace under .herdr-runs.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Overall objective of the orchestrated task" }),
			slices: Type.Array(
				Type.Object({
					name: Type.String({ description: "Slice name; becomes the worker agent name ([a-z][a-z0-9_-]{0,31})" }),
					role: RoleEnum,
					scope: Type.String({ description: "Files, systems, and actions in scope" }),
					nonGoals: Type.Optional(Type.String({ description: "Explicitly excluded work" })),
					authority: Type.Optional(Type.String({ description: "Allowed changes and confirmation requirements" })),
					acceptance: Type.Optional(Type.String({ description: "Observable success conditions" })),
					evidence: Type.Optional(Type.String({ description: "Required tests, paths, commands, or output" })),
				}),
			),
			ledgerDir: Type.Optional(Type.String({ description: "Ledger directory relative to the project root; defaults to .herdr-runs" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx: ToolCtx) {
			const ledger = await resolveLedger(ctx, params.ledgerDir);
			const template = await loadTemplate("plan");
			const sliceRows = params.slices
				.map((slice) => {
					const parts = [`1. **${slice.name}** (${slice.role}): ${slice.scope}`];
					if (slice.acceptance) parts.push(`   Acceptance: ${slice.acceptance}`);
					return parts.join("\n");
				})
				.join("\n");
			const planText = fillTemplate(template, { objective: params.objective, slices: sliceRows });

			if (!ctx.hasUI) {
				await writeText(planPath(ledger), planText + "\n\nAPPROVAL: PENDING (no dialog-capable UI)\n");
				return {
					content: [
						{
							type: "text",
							text: `Plan draft written to ${planPath(ledger)}. Approval pending: run in a dialog-capable session to confirm.`,
						},
					],
					details: { action: "plan", ledger, approved: false, pending: true },
				};
			}

			const approved = await ctx.ui.confirm(
				"Approve orchestration plan",
				`${params.objective}\n${params.slices.length} slice(s): ${params.slices.map((s) => s.name).join(", ")}\n\nApprove plan?`,
			);
			await writeText(planPath(ledger), planText + (approved ? "\n\nAPPROVAL: CONFIRMED\n" : "\n\nAPPROVAL: DECLINED\n"));
			return {
				content: [
					{
						type: "text",
						text: approved
							? `Plan approved and written to ${planPath(ledger)} (${params.slices.length} slices).`
							: `Plan declined; draft kept at ${planPath(ledger)}. No workers started.`,
					},
				],
				details: { action: "plan", ledger, approved, slices: params.slices.length },
			};
		},
		renderCall(args, theme, context) {
			return renderCallText("herdr_plan", args, theme, context);
		},
		renderResult(result: any, options: { isPartial: boolean }, theme: any) {
			if (options.isPartial) return new Text(theme.fg("warning", "◌ drafting plan"), 0, 0);
			return new Text(theme.fg(result.details?.approved ? "success" : "muted", result.details?.approved ? "✓ plan approved" : "✗ plan pending/declined"), 0, 0);
		},
	});

	pi.registerTool({
		name: "herdr_dispatch",
		label: "Herdr Dispatch",
		description:
			"Dispatch a single bounded slice to a fresh worker: splits the current pane right (no focus), starts the worker agent (default opencode with deepseek-v4-flash-free; falls back to cline), waits for shell readiness retrying agent_pane_busy, and submits the role's bounded brief (scope, non-goals, authority, acceptance, evidence, done-condition) with wait and timeout, retrying agent_prompt_stalled once. The brief and the worker ledger path are written under .herdr-runs. Returns the agent name, pane ID, and ledger path so herdr_watch can supervise.",
		promptSnippet: "Dispatch one slice to a fresh DeepSeek worker",
		promptGuidelines: [
			"Dispatch exactly one slice per call. The plan must already be approved via herdr_plan.",
			"Worker names must match [a-z][a-z0-9_-]{0,31} and be unique among live agents.",
			"Pass concise fields; the tool renders the full bounded brief from the role template. Do not pre-render template text.",
			"Use herdr_watch afterward to supervise the worker to its DONE marker; re-prompt only on gaps.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Worker agent name ([a-z][a-z0-9_-]{0,31}), unique among live agents" }),
			role: RoleEnum,
			scope: Type.String({ description: "Files, systems, and actions in scope" }),
			nonGoals: Type.Optional(Type.String({ description: "Explicitly excluded work" })),
			authority: Type.Optional(Type.String({ description: "Allowed changes and confirmation requirements" })),
			acceptance: Type.String({ description: "Observable success conditions" }),
			evidence: Type.Optional(Type.String({ description: "Required tests, paths, commands, or output" })),
			kind: Type.Optional(AgentKindEnum),
			agentArgs: Type.Optional(Type.Array(Type.String(), { description: "Native agent arguments passed unchanged after -- for start" })),
			timeout: Type.Optional(Type.Integer({ minimum: 1, description: "Prompt wait timeout in milliseconds; defaults to the config promptTimeoutMs" })),
			ledgerDir: Type.Optional(Type.String({ description: "Ledger directory relative to the project root; defaults to .herdr-runs" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx: ToolCtx) {
			const config = await loadConfig();
			const ledger = await resolveLedger(ctx, params.ledgerDir);
			const roleDefaults = config.roles[params.role];
			const kind = params.kind || roleDefaults.kind;
			const agentArgs = params.agentArgs || roleDefaults.args;
			const timeoutMs = params.timeout || config.promptTimeoutMs;
			const ledgerFile = workerLedgerPath(ledger, params.name);

			const template = await loadTemplate(params.role);
			const brief = fillTemplate(template, {
				name: params.name,
				scope: params.scope,
				non_goals: params.nonGoals || "(none)",
				authority: params.authority || "No destructive or irreversible actions. Read-only for explorer/verifier roles.",
				acceptance: params.acceptance,
				evidence: params.evidence || "Write progress and evidence to the ledger file as you go.",
				ledger: ledgerFile,
				ledger_dir: ledger,
			});
			await writeText(briefPath(ledger, params.name), brief);
			await writeText(
				ledgerFile,
				`# Worker ledger: ${params.name} (${params.role})\n\nDispatched ${new Date().toISOString()}\nBrief: ${briefPath(ledger, params.name)}\n\n`,
			);

			onUpdate?.({
				content: [{ type: "text", text: `Splitting pane for ${params.name}...` }],
				details: { action: "dispatch", name: params.name, waiting: true },
			});
			const pane = await splitWorkerPane(signal);
			await sleep(2000); // let the fresh pane reach its shell prompt

			onUpdate?.({
				content: [{ type: "text", text: `Starting ${kind} as ${params.name} in ${pane.pane_id}...` }],
				details: { action: "dispatch", name: params.name, waiting: true },
			});
			await startWorker(params.name, kind, pane.pane_id, agentArgs, signal);

			onUpdate?.({
				content: [{ type: "text", text: `Prompting ${params.name}...` }],
				details: { action: "dispatch", name: params.name, waiting: true },
			});
			const settled = await promptWorker(params.name, brief, timeoutMs, signal);

			return {
				content: [
					{
						type: "text",
						text: `Dispatched ${params.name} (${params.role}, ${kind}): ${summarizeAgent(settled)}\nBrief: ${briefPath(ledger, params.name)}\nLedger: ${ledgerFile}\nPane: ${pane.pane_id}`,
					},
				],
				details: {
					action: "dispatch",
					name: params.name,
					role: params.role,
					agent: settled.name || params.name,
					pane: pane.pane_id,
					ledger,
					ledgerFile,
					brief: briefPath(ledger, params.name),
					status: settled.agent_status,
				},
			};
		},
		renderCall(args, theme, context) {
			return renderCallText("herdr_dispatch", args, theme, context);
		},
		renderResult(result: any, options: { isPartial: boolean }, theme: any) {
			if (options.isPartial) return new Text(theme.fg("warning", "◌ dispatching"), 0, 0);
			return new Text(`${statusDot(theme, result.details?.status || "unknown")} ${theme.fg("accent", result.details?.name || "?")}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "herdr_watch",
		label: "Herdr Watch",
		description:
			"Supervise a dispatched worker until settlement: polls the worker's ledger file for a DONE: or BLOCKED: marker, checks agent lifecycle state, and reads the agent's recent output when the ledger lags or the agent is blocked. Returns done with the ledger tail, blocked with the agent output, timeout, or lost when the agent is gone. Poll interval and overall timeout are configurable.",
		promptSnippet: "Supervise a dispatched worker to its DONE marker",
		promptGuidelines: [
			"Run herdr_watch after herdr_dispatch to supervise the worker; the ledger file is the source of truth, agent reads fill gaps.",
			"On blocked, read the returned output and either respond via herdr_agent send_keys or ask the user; never send input on unknown state.",
			"On timeout or lost, re-prompt the worker (once) or restart it in a fresh pane; never take over the task.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Worker agent name to supervise" }),
			timeout: Type.Optional(Type.Integer({ minimum: 1, description: "Overall watch timeout in milliseconds; defaults to 600000 (10 minutes)" })),
			poll: Type.Optional(Type.Integer({ minimum: 100, description: "Poll interval in milliseconds; defaults to 1000" })),
			ledgerDir: Type.Optional(Type.String({ description: "Ledger directory relative to the project root; defaults to .herdr-runs" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx: ToolCtx) {
			const config = await loadConfig();
			const ledger = await resolveLedger(ctx, params.ledgerDir);
			const ledgerFile = workerLedgerPath(ledger, params.name);
			const pollMs = params.poll || 1000;
			const timeoutMs = params.timeout || 600_000;
			const startedAt = Date.now();

			async function outcome(status: string, extra: Record<string, any> = {}) {
				const elapsedMs = Date.now() - startedAt;
				const ledgerText = tailLines(await readFile(ledgerFile, "utf8").catch(() => ""), 120);
				return { status, elapsedMs, ledgerText, ...extra };
			}

			while (true) {
				if (signal?.aborted) throw new Error("Aborted");
				let ledgerText = "";
				try {
					ledgerText = await readFile(ledgerFile, "utf8");
				} catch {
					// ledger not written yet; keep polling
				}
				if (hasDoneMarker(ledgerText)) {
					return {
						content: [{ type: "text", text: `Worker ${params.name} done.\n\n${tailLines(ledgerText, 60)}` }],
						details: { action: "watch", name: params.name, ...(await outcome("done")) },
					};
				}
				if (hasBlockedMarker(ledgerText)) {
					const output = await readAgent(params.name, config.readLines, signal).catch(() => "");
					return {
						content: [{ type: "text", text: `Worker ${params.name} reported BLOCKED.\n\nAgent output:\n${formatOutput(output)}` }],
						details: { action: "watch", name: params.name, ...(await outcome("blocked")), output: formatOutput(output) },
					};
				}
				const status = await agentStatus(params.name, signal);
				if (status === undefined) {
					return {
						content: [{ type: "text", text: `Agent ${params.name} is gone (agent_not_found). Restart in a fresh pane and re-submit the brief.` }],
						details: { action: "watch", name: params.name, ...(await outcome("lost")) },
					};
				}
				if (status === "blocked") {
					const output = await readAgent(params.name, config.readLines, signal).catch(() => "");
					return {
						content: [{ type: "text", text: `Worker ${params.name} blocked.\n\nAgent output:\n${formatOutput(output)}` }],
						details: { action: "watch", name: params.name, ...(await outcome("blocked")), output: formatOutput(output) },
					};
				}
				if (Date.now() - startedAt >= timeoutMs) {
					const output = await readAgent(params.name, config.readLines, signal).catch(() => "");
					return {
						content: [{ type: "text", text: `Watch timed out after ${timeoutMs}ms for ${params.name}.\n\nAgent output:\n${formatOutput(output)}` }],
						details: { action: "watch", name: params.name, ...(await outcome("timeout")), output: formatOutput(output) },
					};
				}
				onUpdate?.({
					content: [{ type: "text", text: `Watching ${params.name} (${status})...` }],
					details: { action: "watch", name: params.name, waiting: true, status },
				});
				await sleep(pollMs);
			}
		},
		renderCall(args, theme, context) {
			return renderCallText("herdr_watch", args, theme, context);
		},
		renderResult(result: any, options: { isPartial: boolean }, theme: any) {
			if (options.isPartial) return new Text(theme.fg("warning", "◌ watching"), 0, 0);
			const status = result.details?.status || "unknown";
			const dot = status === "done" ? "✓" : status === "blocked" ? "●" : status === "lost" ? "✗" : "…";
			return new Text(theme.fg("accent", `${dot} ${status}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "herdr_review",
		label: "Herdr Review",
		description:
			"Independently review a finished slice with a fresh pi/gpt-5.6-sol reviewer at thinking medium: splits a pane, starts the reviewer agent (configurable kind/model), submits the reviewer brief with the slice's acceptance criteria and evidence, waits for settle, reads the reviewer output, extracts the verdict (APPROVE, REJECT, or RE_PLAN) with reasons and gaps, writes the review to the ledger, and requires the user's approval gate before the verdict is accepted. Returns the verdict and review file path.",
		promptSnippet: "Review a finished slice with a fresh gpt-5.6-sol reviewer",
		promptGuidelines: [
			"Review only finished slices that passed herdr_watch; the reviewer is a fresh pi instance that never saw the slice work.",
			"The verdict counts only after the user approval gate; REJECT and RE_PLAN lead to re-briefing, never to the lead taking over.",
			"Read the review file from the returned path instead of the pane screen; the reviewer may render in an alternate screen.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Reviewer agent name ([a-z][a-z0-9_-]{0,31}), unique among live agents" }),
			slice: Type.String({ description: "Slice name being reviewed" }),
			acceptance: Type.String({ description: "Slice acceptance criteria to verify" }),
			evidence: Type.Optional(Type.String({ description: "Evidence text or path to the slice ledger file to review" })),
			kind: Type.Optional(AgentKindEnum),
			agentArgs: Type.Optional(Type.Array(Type.String(), { description: "Native reviewer arguments passed unchanged after -- for start" })),
			timeout: Type.Optional(Type.Integer({ minimum: 1, description: "Prompt wait timeout in milliseconds; defaults to the config promptTimeoutMs" })),
			ledgerDir: Type.Optional(Type.String({ description: "Ledger directory relative to the project root; defaults to .herdr-runs" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx: ToolCtx) {
			const config = await loadConfig();
			const ledger = await resolveLedger(ctx, params.ledgerDir);
			const reviewerKind = params.kind || config.reviewer.kind;
			const reviewerArgs = params.agentArgs || config.reviewer.args;
			const timeoutMs = params.timeout || config.promptTimeoutMs;
			const reviewFile = reviewPath(ledger, params.slice);

			const template = await loadTemplate("reviewer");
			const task = `Review slice \`${params.slice}\` against its acceptance criteria and the supplied evidence. Return a verdict line VERDICT: APPROVE | REJECT | RE_PLAN, a REASON line, and a GAPS list.`;
			const inputs = `ACCEPTANCE:\n${params.acceptance}\n\nEVIDENCE:\n${params.evidence || ""}`;
			const prompt = fillTemplate(template, { task, inputs });

			onUpdate?.({
				content: [{ type: "text", text: `Splitting pane for reviewer ${params.name}...` }],
				details: { action: "review", name: params.name, waiting: true },
			});
			const pane = await splitWorkerPane(signal);
			await sleep(2000);

			onUpdate?.({
				content: [{ type: "text", text: `Starting reviewer ${params.name} (${reviewerKind})...` }],
				details: { action: "review", name: params.name, waiting: true },
			});
			await startWorker(params.name, reviewerKind, pane.pane_id, reviewerArgs, signal);

			onUpdate?.({
				content: [{ type: "text", text: `Prompting reviewer ${params.name}...` }],
				details: { action: "review", name: params.name, waiting: true },
			});
			const settled = await promptWorker(params.name, prompt, timeoutMs, signal);
			const output = await readAgent(params.name, config.readLines, signal).catch(() => "");
			const verdictMatch = /VERDICT\s*[:：]\s*(APPROVE|REJECT|RE_PLAN)/i.exec(output);
			const reasonMatch = /REASON\s*[:：]\s*(.*)/i.exec(output);
			const gapsMatch = /GAPS\s*[:：]\s*([\s\S]*)/i.exec(output);
			const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : "UNKNOWN";
			const reason = reasonMatch ? reasonMatch[1].trim() : "";
			const gaps = gapsMatch ? gapsMatch[1].trim() : "";

			const reviewText = `# Review of ${params.slice}\n\nVERDICT: ${verdict}\nREASON: ${reason}\nGAPS:\n${gaps || "NONE"}\n\nReviewer: ${params.name} (${settled.agent_status})\n\nRaw output:\n${output}`;
			await writeText(reviewFile, reviewText);

			const accepted =
				ctx.hasUI && (await ctx.ui.confirm("Accept review verdict", `Slice ${params.slice}: ${verdict}\n${reason}\n\nAccept this verdict?`));
			await writeText(reviewFile, reviewText + `\n\nUSER_ACCEPTED: ${accepted ? "yes" : "no"}\n`);

			return {
				content: [
					{
						type: "text",
						text: `Review of ${params.slice}: ${verdict} (${accepted ? "accepted" : "pending/declined"}).\n${reason}\n${gaps ? `Gaps:\n${gaps}` : ""}\nReview file: ${reviewFile}`,
					},
				],
				details: {
					action: "review",
					name: params.name,
					slice: params.slice,
					verdict,
					accepted,
					reason,
					gaps,
					reviewFile,
					pane: pane.pane_id,
				},
			};
		},
		renderCall(args, theme, context) {
			return renderCallText("herdr_review", args, theme, context);
		},
		renderResult(result: any, options: { isPartial: boolean }, theme: any) {
			if (options.isPartial) return new Text(theme.fg("warning", "◌ reviewing"), 0, 0);
			const verdict = result.details?.verdict || "UNKNOWN";
			const dot = verdict === "APPROVE" ? "✓" : verdict === "REJECT" ? "✗" : "↻";
			return new Text(`${dot} ${theme.fg("accent", verdict)} ${theme.fg("dim", result.details?.slice || "")}`, 0, 0);
		},
	});
}