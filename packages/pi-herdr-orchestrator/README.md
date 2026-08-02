# pi-herdr-orchestrator

Pi-native orchestrator over [Herdr](https://github.com/ogulcancelik/herdr): plan an objective, dispatch bounded slices to fresh worker agents, supervise them through a run ledger, and review the evidence with an independent reviewer — every step gated on your approval. Worker and reviewer kinds and models are configurable.

This is a fork of `@ogulcancelik/pi-herdr` that keeps the three Herdr primitives (`herdr_layout`, `herdr_pane`, `herdr_agent`) and adds the orchestration layer.

## Requirements

- Pi 0.80 or newer
- Herdr 0.7.5 or newer
- Pi running inside a Herdr pane (`HERDR_ENV=1` and `HERDR_PANE_ID` set)

`opencode` and `cline` are optional — with the default config you only need whichever agent your routing points at. Both the worker roles and the reviewer are fully configurable: kind, model, and args are set in `config.json`, so you can use any supported agent (opencode, cline, codex, claude, gemini, ...) with any model you have access to.

## Install

```bash
pi install npm:@ret2hell/pi-herdr-orchestrator
```

Or add the package to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@ret2hell/pi-herdr-orchestrator"]
}
```

The extension activates only when Pi runs inside a Herdr-managed pane with `HERDR_ENV=1` and `HERDR_PANE_ID` set.

This package provides structured Pi tools only. It does not bundle Herdr's standalone agent skill. Install that skill separately when you want direct access to the complete installed CLI.

## Orchestration model

The orchestrator is a lead-plus-workers loop. The lead is your pi session; workers are fresh agent instances, each in its own pane, executing one bounded slice each; the reviewer is a fresh, independent agent instance that never saw the slice work. The defaults for every role are shown in [Configuration](#configuration) and can all be overridden — any supported agent kind with any model you have access to.

A session looks like:

1. `herdr_plan` writes the objective and slice breakdown to `<workspace>/.herdr-runs/plan.md` and asks for your approval.
2. `herdr_dispatch` splits a pane, starts a worker, and submits the role's bounded brief (scope, non-goals, authority, acceptance, evidence, done-condition) with wait.
3. `herdr_watch` polls the worker's ledger file for the `DONE:` marker, reads agent output when the ledger lags or the agent blocks, and reports done/blocked/timeout/lost.
4. `herdr_review` spawns the fresh reviewer, feeds it the acceptance criteria and evidence, extracts `APPROVE`/`REJECT`/`RE_PLAN` with reasons and gaps, and requires your confirmation before the verdict counts.

### `herdr_plan`

| Parameter | Description |
|---|---|
| `objective` | One-sentence overall objective |
| `slices` | Slice breakdown: name, role (explorer/builder/verifier), scope, non-goals, authority, acceptance, evidence |
| `ledgerDir` | Ledger directory relative to the project root; defaults to `.herdr-runs` |

Writes the draft plan to `plan.md`, then requires `ctx.ui.confirm` approval before marking it approved. Without a dialog-capable UI, the draft is written and reported as pending.

### `herdr_dispatch`

| Parameter | Description |
|---|---|
| `name` | Worker agent name (`[a-z][a-z0-9_-]{0,31}`, unique among live agents) |
| `role` | `explorer` (read-only recon), `builder` (edits scoped files), or `verifier` (read-only verification) |
| `scope`, `nonGoals`, `authority`, `acceptance`, `evidence` | Bounded brief fields rendered from the role template |
| `kind`, `agentArgs` | Worker kind and native agent args; defaults from config |
| `timeout` | Prompt wait timeout in ms; defaults to `promptTimeoutMs` (120000) |

Splits the current pane right (no focus), waits 2s for the shell prompt, starts the worker retrying `agent_pane_busy`, then prompts with `--wait --timeout`, retrying `agent_prompt_stalled` once. Writes the rendered brief and the worker ledger file under the ledger directory. Returns the agent name, pane ID, and ledger paths for `herdr_watch`.

### `herdr_watch`

| Parameter | Description |
|---|---|
| `name` | Worker agent name |
| `timeout` | Overall watch timeout in ms; defaults to 600000 |
| `poll` | Poll interval in ms; defaults to 1000 |
| `ledgerDir` | Ledger directory; defaults to `.herdr-runs` |

Polls the worker ledger for `DONE:` (success) or `BLOCKED:` (blocked with agent output), checks lifecycle state via `agent get`, and reads the agent's recent output when the ledger lags or the agent is blocked. Returns `done`, `blocked`, `timeout`, or `lost`.

### `herdr_review`

| Parameter | Description |
|---|---|
| `name` | Reviewer agent name (unique among live agents) |
| `slice` | Slice being reviewed |
| `acceptance` | Slice acceptance criteria |
| `evidence` | Evidence text or ledger content to review |
| `kind`, `agentArgs` | Reviewer kind and args; defaults to a fresh pi agent at medium thinking |
| `timeout` | Prompt wait timeout in ms |

Splits a pane, starts the fresh reviewer, submits the reviewer brief, waits, reads the output, extracts `VERDICT: APPROVE | REJECT | RE_PLAN`, `REASON`, and `GAPS`, writes the review to `<ledger>/slices/<slice>.review.md`, and requires `ctx.ui.confirm` before the verdict is accepted.

## Configuration

Configuration lives in `~/.pi/agent/pi-herdr-orchestrator/` (like `pi-codex-subagents`). Every role's agent kind, model, and args are configurable — point any role at any supported agent (opencode, cline, codex, claude, gemini, ...) with any model you have access to. Copy `config.example.json` to `config.json` to override worker/reviewer routing, ledger directory, or timeouts — the example below shows the defaults:

```json
{
  "roles": {
    "explorer": { "kind": "opencode", "model": "opencode/deepseek-v4-flash-free", "args": ["--model", "opencode/deepseek-v4-flash-free"] },
    "builder": { "kind": "opencode", "model": "opencode/deepseek-v4-flash-free", "args": ["--model", "opencode/deepseek-v4-flash-free"] },
    "verifier": { "kind": "opencode", "model": "opencode/deepseek-v4-flash-free", "args": ["--model", "opencode/deepseek-v4-flash-free"] }
  },
  "reviewer": { "kind": "pi", "model": "gpt-5.6-sol", "args": ["--model", "gpt-5.6-sol", "--thinking", "medium"] },
  "ledgerDir": ".herdr-runs",
  "startDelayMs": 2000,
  "promptTimeoutMs": 120000,
  "readLines": 120
}
```

Brief templates are read from `<config root>/templates/<role>.md` when present, otherwise from the package's bundled `templates/`, otherwise from built-in defaults. Each template uses `{{variable}}` placeholders (name, scope, non_goals, authority, acceptance, evidence, ledger, ledger_dir).

## Execution model

Herdr exposes three distinct primitives:

- Layout organizes terminal locations. Workspaces contain tabs, and tabs contain panes.
- Pane controls a raw terminal containing a shell, test, server, build, log, or other ordinary process.
- Agent controls a recognized coding agent currently occupying a pane.

A pane exists independently of an agent. Starting an agent requires an existing pane at an available interactive shell prompt and never creates or changes layout.

The extension registers one tool for each primitive, plus the four orchestrators above.

### `herdr_layout`

Use `herdr_layout` to inspect and create workspaces, tabs, and pane topology.

| Action | Description |
|---|---|
| `current` | Inspect the pane running the current Pi process |
| `workspace_list` | List workspaces |
| `workspace_create` | Create a workspace, first tab, and root pane |
| `workspace_focus` | Focus a workspace |
| `tab_list` | List tabs |
| `tab_create` | Create a tab and root pane |
| `tab_focus` | Focus a tab |
| `pane_list` | List panes in a workspace |
| `pane_layout` | Inspect pane geometry |
| `pane_split` | Split an existing pane |

Creation defaults to the caller pane's foreground working directory and preserves UI focus. When `pane_split` omits a direction, the tool chooses right for a sufficiently wide pane and down for a narrow or tall pane.

Workspace, tab, and pane IDs are opaque. Always use IDs returned by Herdr instead of constructing them.

### `herdr_pane`

Use `herdr_pane` for ordinary commands and intentional raw terminal control.

| Action | Description |
|---|---|
| `get` | Inspect a pane |
| `run` | Submit a shell command atomically with Enter |
| `read` | Read terminal output |
| `wait_output` | Wait for literal or regular-expression output |
| `send_text` | Send literal text without Enter |
| `send_keys` | Send logical terminal keys |
| `close` | Close a pane other than the pane running Pi |

`wait_output` searches existing output immediately before waiting for future output. Use `recent-unwrapped` for logs and transcripts.

Pane actions do not validate coding-agent identity or interpret agent lifecycle. Use `herdr_agent` when a pane contains a recognized coding agent.

### `herdr_agent`

Use `herdr_agent` to control a recognized coding agent by unique live name or by its hosting pane ID.

| Action | Description |
|---|---|
| `list` | List recognized agents |
| `get` | Inspect an agent |
| `start` | Start a supported agent in an existing available shell pane |
| `prompt` | Submit a prompt and optionally wait for settlement |
| `wait` | Wait for lifecycle state |
| `read` | Read the resolved agent terminal stream |
| `send_keys` | Send validated logical keys to the agent UI |
| `focus` | Focus the agent's pane |
| `rename` | Set or clear a live agent name |

Agent targets accept a unique live agent name or the pane ID currently hosting that agent. They do not accept terminal IDs or bare agent-kind labels.

Lifecycle states are:

- `working`: actively processing
- `blocked`: waiting for approval or an answer
- `done`: ready after unseen background work completed
- `idle`: ready and considered seen
- `unknown`: present, but lifecycle cannot be classified confidently

`prompt` waits by default and settles on the first `idle`, `done`, or `blocked` state unless `until` narrows the accepted states. A prompt submitted from a non-working state must produce an observed lifecycle change within five seconds or Herdr returns `agent_prompt_stalled`.

## Typical workflows

Start a coding agent in a sibling pane:

```json
{ "action": "pane_split" }
```

Use the returned pane ID:

```json
{
  "action": "start",
  "name": "reviewer",
  "kind": "codex",
  "pane": "w1:p2"
}
```

Prompt it and wait for settlement:

```json
{
  "action": "prompt",
  "target": "reviewer",
  "prompt": "Review the current diff and report only actionable findings.",
  "timeout": 120000
}
```

Read the result:

```json
{
  "action": "read",
  "target": "reviewer",
  "source": "recent-unwrapped",
  "lines": 120
}
```

For an ordinary command, split a pane with `herdr_layout`, submit the command with `herdr_pane run`, then use `herdr_pane wait_output` or `herdr_pane read`.

## Invocation policy

The tools are opt-in. Pi uses them only when the user explicitly mentions Herdr or asks to inspect or control Herdr. Installing this package does not turn general background work or delegation into a Herdr workflow.

The default topology is a sibling pane in the caller's current tab and working directory. Focus remains with the user. Another tab, workspace, worktree, or working directory is used only when requested.

## Output limits

Read output is truncated to the last 2,000 lines or 50KB, whichever is reached first.

Full-screen agents may render through the terminal's alternate screen. Rows that leave that screen do not enter Herdr's host scrollback. If increasing `lines` does not reveal the complete response, ask the agent to write its response to a temporary Markdown file and read that file directly.

## License

MIT
