# Plan for {{objective}}

> Orchestration ledger. Written by herdr_plan, supervised by herdr_dispatch and herdr_watch.
> This file is a contract between the lead (pi) and the DeepSeek workers. Each slice is a bounded
> unit owned by exactly one worker, verified by a fresh reviewer before the orchestrator accepts it.

## Objective

{{objective}}

## Slices

{{slices}}

## Process contract

1. Each slice is dispatched to a single fresh worker with a bounded brief.
2. Workers write progress and evidence to <workspace>/.herdr-runs/<name>.md as they go.
3. A fresh pi reviewer (gpt-5.6-sol, thinking low, read-only) reviews each finished slice.
4. The lead approves, re-plans, or rejects a slice only through the approval gate.
