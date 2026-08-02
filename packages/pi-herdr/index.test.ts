import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import herdrExtension from "./index";

const currentPane = {
	pane_id: "w1:p1",
	workspace_id: "w1",
	tab_id: "w1:t1",
	focused: false,
	cwd: "/repo",
	foreground_cwd: "/repo",
	agent: "pi",
	agent_status: "working",
};

const reviewer = {
	name: "reviewer",
	agent: "codex",
	display_agent: "Codex",
	agent_status: "idle",
	workspace_id: "w1",
	tab_id: "w1:t1",
	pane_id: "w1:p2",
	focused: false,
	cwd: "/repo",
};

function response(result: unknown, stdout?: string) {
	return {
		stdout: stdout ?? JSON.stringify({ id: "test", result }),
		stderr: "",
		code: 0,
		killed: false,
	};
}

function registerTools(handler: (args: string[]) => unknown | string) {
	const tools = new Map<string, any>();
	const pi = {
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		async exec(command: string, args: string[]) {
			expect(command).toBe("herdr");
			const result = handler(args);
			return typeof result === "string" ? response(undefined, result) : response(result);
		},
	};
	herdrExtension(pi as any);
	return tools;
}

function tempProject(ledgerDir = ".herdr-runs") {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-herdr-test-"));
	mkdirSync(path.join(root, ledgerDir), { recursive: true });
	tempRoots.push(root);
	return root;
}

const tempRoots: string[] = [];

function readLedger(root: string, ledgerDir: string, file: string): string {
	return readFileSync(path.join(root, ledgerDir, file), "utf8");
}

beforeEach(() => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = currentPane.pane_id;
});

afterEach(() => {
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_PANE_ID;
});

describe("pi-herdr", () => {
	test("registers only inside Herdr", () => {
		delete process.env.HERDR_ENV;
		const tools = registerTools(() => ({}));
		expect(tools.size).toBe(0);
	});

	test("registers separate layout, pane, and agent primitives plus orchestrators", () => {
		const tools = registerTools(() => ({}));
		expect([...tools.keys()]).toEqual([
			"herdr_layout",
			"herdr_pane",
			"herdr_agent",
			"herdr_plan",
			"herdr_dispatch",
			"herdr_watch",
			"herdr_review",
		]);
		expect(tools.get("herdr_layout").description).toContain("Workspaces contain tabs; tabs contain panes");
		expect(tools.get("herdr_pane").description).toContain("ordinary processes");
		expect(tools.get("herdr_agent").description).toContain("existing Herdr pane");
		expect(tools.get("herdr_plan").description).toContain("orchestration plan");
		expect(tools.get("herdr_dispatch").description).toContain("bounded slice");
		expect(tools.get("herdr_review").description).toContain("fresh pi/gpt-5.6-sol reviewer");
	});

	test("splits the caller pane from geometry while preserving cwd and focus", async () => {
		const calls: string[][] = [];
		const splitPane = { ...currentPane, pane_id: "w1:p2", agent: undefined, agent_status: "unknown" };
		const tools = registerTools((args) => {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "current") return { type: "pane_current", pane: currentPane };
			if (args[0] === "pane" && args[1] === "layout") {
				return {
					type: "pane_layout",
					layout: {
						workspace_id: "w1",
						tab_id: "w1:t1",
						zoomed: false,
						focused_pane_id: "w1:p1",
						area: { x: 0, y: 0, width: 160, height: 40 },
						panes: [{ pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 160, height: 40 } }],
						splits: [],
					},
				};
			}
			if (args[0] === "pane" && args[1] === "split") return { type: "pane_info", pane: splitPane };
			throw new Error(`unexpected command: ${args.join(" ")}`);
		});

		const result = await tools.get("herdr_layout").execute(
			"test",
			{ action: "pane_split" },
			undefined,
			undefined,
			{},
		);

		expect(calls).toContainEqual(["pane", "layout", "--pane", "w1:p1"]);
		expect(calls).toContainEqual([
			"pane",
			"split",
			"w1:p1",
			"--direction",
			"right",
			"--cwd",
			"/repo",
			"--no-focus",
		]);
		expect(result.details.pane.pane_id).toBe("w1:p2");
	});

	test("waits for ordinary output through pane wait-output", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return {
				type: "pane_output_matched",
				pane_id: "w1:p2",
				matched_line: "server ready",
				read: { text: "booting\nserver ready\n" },
			};
		});

		const result = await tools.get("herdr_pane").execute(
			"test",
			{ action: "wait_output", pane: "w1:p2", match: "ready", timeout: 30000 },
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([["pane", "wait-output", "w1:p2", "--match", "ready", "--timeout", "30000"]]);
		expect(result.content[0].text).toContain("server ready");
	});

	test("refuses to close the caller pane", async () => {
		const tools = registerTools((args) => {
			if (args[0] === "pane" && args[1] === "current") return { type: "pane_current", pane: currentPane };
			throw new Error(`unexpected command: ${args.join(" ")}`);
		});

		expect(
			tools.get("herdr_pane").execute(
				"test",
				{ action: "close", pane: "w1:p1" },
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow("Refusing to close");
	});

	test("starts a named agent in an existing pane", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return { type: "agent_started", agent: reviewer, argv: ["codex", "-m", "gpt-5.4"] };
		});

		const result = await tools.get("herdr_agent").execute(
			"test",
			{
				action: "start",
				name: "reviewer",
				kind: "codex",
				pane: "w1:p2",
				agentArgs: ["-m", "gpt-5.4"],
			},
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([
			["agent", "start", "reviewer", "--kind", "codex", "--pane", "w1:p2", "--", "-m", "gpt-5.4"],
		]);
		expect(result.details.agent.name).toBe("reviewer");
	});

	test("prompts through the agent surface and waits by default", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return { type: "agent_prompted", agent: { ...reviewer, agent_status: "done" } };
		});

		const result = await tools.get("herdr_agent").execute(
			"test",
			{
				action: "prompt",
				target: "reviewer",
				prompt: "Review the current diff",
				until: ["idle", "done"],
				timeout: 120000,
			},
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([
			[
				"agent",
				"prompt",
				"reviewer",
				"Review the current diff",
				"--wait",
				"--until",
				"idle",
				"--until",
				"done",
				"--timeout",
				"120000",
			],
		]);
		expect(result.details.agent.agent_status).toBe("done");
	});

	test("reads through the resolved agent surface", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return "review complete\n";
		});

		const result = await tools.get("herdr_agent").execute(
			"test",
			{ action: "read", target: "reviewer", lines: 120 },
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([
			["agent", "read", "reviewer", "--source", "recent-unwrapped", "--lines", "120"],
		]);
		expect(result.content[0].text).toBe("review complete\n");
	});

	test("sends validated keys without expecting agent data in the response", async () => {
		const calls: string[][] = [];
		const tools = registerTools((args) => {
			calls.push(args);
			return { type: "ok" };
		});

		const result = await tools.get("herdr_agent").execute(
			"test",
			{ action: "send_keys", target: "reviewer", keys: ["esc", "ctrl+c"] },
			undefined,
			undefined,
			{},
		);

		expect(calls).toEqual([["agent", "send-keys", "reviewer", "esc", "ctrl+c"]]);
		expect(result.content[0].text).toBe("Sent esc ctrl+c to reviewer");
	});

	describe("pi-herdr orchestrators", () => {
		const worker = { ...reviewer, name: "slicer", agent_status: "done" };
		const splitPane = { ...currentPane, pane_id: "w1:p2", agent: undefined, agent_status: "unknown" };
		const ctx = {
			hasUI: true,
			cwd: "/nonexistent/project",
			ui: { confirm: async () => true },
		};
		const ledgerArg = ".herdr-runs";

		afterEach(() => {
			for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
		});

		function projectCtx() {
			const root = tempProject(ledgerArg);
			return { ...ctx, cwd: root };
		}

		test("herdr_plan writes a draft and requires approval", async () => {
			const root = tempProject(ledgerArg);
			const tools = registerTools(() => ({}));
			const approved = { confirm: async () => true };
			const result = await tools.get("herdr_plan").execute(
				"test",
				{
					objective: "Ship the login flow",
					slices: [
						{
							name: "auth",
							role: "builder",
							scope: "src/auth/",
							acceptance: "login works",
						},
					],
					ledgerDir: ledgerArg,
				},
				undefined,
				undefined,
				{ ...ctx, cwd: root, ui: approved },
			);

			expect(result.details.approved).toBe(true);
			const plan = readLedger(root, ledgerArg, "plan.md");
			expect(plan).toContain("APPROVAL: CONFIRMED");
			expect(plan).toContain("**auth** (builder)");
		});

		test("herdr_plan keeps a declined draft without approval", async () => {
			const root = tempProject(ledgerArg);
			const tools = registerTools(() => ({}));
			const result = await tools.get("herdr_plan").execute(
				"test",
				{ objective: "Ship login", slices: [{ name: "auth", role: "builder", scope: "src/" }], ledgerDir: ledgerArg },
				undefined,
				undefined,
				{ ...ctx, cwd: root, ui: { confirm: async () => false } },
			);
			expect(result.details.approved).toBe(false);
			const plan = readLedger(root, ledgerArg, "plan.md");
			expect(plan).toContain("APPROVAL: DECLINED");
		});

		test("herdr_dispatch splits a pane, starts, and prompts with a bounded brief", async () => {
			const root = tempProject(ledgerArg);
			const calls: string[][] = [];
			const tools = registerTools((args) => {
				calls.push(args);
				if (args[0] === "pane" && args[1] === "split") return { type: "pane_info", pane: splitPane };
				if (args[0] === "agent" && args[1] === "start") return { type: "agent_started", agent: worker };
				if (args[0] === "agent" && args[1] === "prompt") return { type: "agent_prompted", agent: worker };
				throw new Error(`unexpected command: ${args.join(" ")}`);
			});

			const result = await tools.get("herdr_dispatch").execute(
				"test",
				{
					name: "slicer",
					role: "builder",
					scope: "src/auth/",
					nonGoals: "No backend changes",
					acceptance: "login works",
					ledgerDir: ledgerArg,
				},
				undefined,
				undefined,
				{ ...ctx, cwd: root },
			);

			expect(result.details.agent).toBe("slicer");
			expect(result.details.pane).toBe("w1:p2");
			expect(calls).toContainEqual(["pane", "split", "--current", "--direction", "right", "--no-focus"]);
			expect(calls).toContainEqual([
				"agent",
				"start",
				"slicer",
				"--kind",
				"opencode",
				"--pane",
				"w1:p2",
				"--",
				"--model",
				"opencode/deepseek-v4-flash-free",
			]);
			const promptCall = calls.find((call) => call[0] === "agent" && call[1] === "prompt");
			expect(promptCall).toBeDefined();
			const brief = promptCall![3];
			expect(brief).toContain("Scope");
			expect(brief).toContain("login works");
			expect(brief).toContain("DONE:");
			const ledgerFile = readLedger(root, ledgerArg, "slicer.md").length;
			const briefFile = readLedger(root, ledgerArg, "slicer.brief.md");
			expect(briefFile).toContain("login works");
			expect(ledgerFile).toBeGreaterThan(0);
		});

		test("herdr_watch returns done when the ledger has a DONE marker", async () => {
			const root = tempProject(ledgerArg);
			writeFileSync(path.join(root, ledgerArg, "slicer.md"), "# progress\nDONE: login works\n");
			const tools = registerTools(() => {
				throw new Error("no herdr calls expected for ledger-done path");
			});

			const result = await tools.get("herdr_watch").execute(
				"test",
				{ name: "slicer", ledgerDir: ledgerArg, poll: 100 },
				undefined,
				undefined,
				{ ...ctx, cwd: root },
			);

			expect(result.details.status).toBe("done");
			expect(result.details.ledgerText).toContain("DONE: login works");
		});

		test("herdr_watch returns blocked with output when the agent is blocked", async () => {
			const root = tempProject(ledgerArg);
			const blockedAgent = { ...worker, agent_status: "blocked" };
			const tools = registerTools((args) => {
				if (args[0] === "agent" && args[1] === "get") return { type: "agent_info", agent: blockedAgent };
				if (args[0] === "agent" && args[1] === "read") return "need approval for delete";
				throw new Error(`unexpected command: ${args.join(" ")}`);
			});

			const result = await tools.get("herdr_watch").execute(
				"test",
				{ name: "slicer", ledgerDir: ledgerArg, poll: 100 },
				undefined,
				undefined,
				{ ...ctx, cwd: root },
			);

			expect(result.details.status).toBe("blocked");
			expect(result.details.output).toContain("need approval for delete");
		});

		test("herdr_review spawns a fresh reviewer and extracts a verdict", async () => {
			const root = tempProject(ledgerArg);
			const calls: string[][] = [];
			const tools = registerTools((args) => {
				calls.push(args);
				if (args[0] === "pane" && args[1] === "split") return { type: "pane_info", pane: splitPane };
				if (args[0] === "agent" && args[1] === "start") return { type: "agent_started", agent: { ...worker, name: "reviewer" } };
				if (args[0] === "agent" && args[1] === "prompt") return { type: "agent_prompted", agent: { ...worker, name: "reviewer", agent_status: "done" } };
				if (args[0] === "agent" && args[1] === "read") {
					return "VERDICT: APPROVE\nREASON: tests pass\nGAPS: NONE";
				}
				throw new Error(`unexpected command: ${args.join(" ")}`);
			});

			const result = await tools.get("herdr_review").execute(
				"test",
				{
					name: "reviewer",
					slice: "auth",
					acceptance: "login works",
					evidence: "bun test passes",
					ledgerDir: ledgerArg,
				},
				undefined,
				undefined,
				{ ...ctx, cwd: root },
			);

			expect(result.details.verdict).toBe("APPROVE");
			expect(result.details.accepted).toBe(true);
			expect(calls.some((call) => call[0] === "agent" && call[1] === "start" && call.includes("pi"))).toBe(true);
			const review = readLedger(root, ledgerArg, path.join("slices", "auth.review.md"));
			expect(review).toContain("VERDICT: APPROVE");
			expect(review).toContain("USER_ACCEPTED: yes");
		});
	});
});
