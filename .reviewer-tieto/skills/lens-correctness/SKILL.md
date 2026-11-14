---
name: lens-correctness
description: Generic correctness review of a change (logic, edge cases, error handling, concurrency, regressions), extended by the repo profile's correctness addendum. Use when the review message says LENS correctness, or when asked for a correctness review. Used by the reviewer-tieto correctness-reviewer agent.
---

# Correctness lens (blocking)

Does this code work? Intent and scope, security, compatibility, documentation and tests have their own lenses, so leave those topics alone.

## Instructions

1. Read the requirement criteria and the diff. Start with the high-risk files from triage.
2. Read enough of the surrounding code to know how the changed code is called and what it calls.
3. **Trace by hand** the main path and at least one failure or edge path for each changed behaviour. Cite each step (`E2-traced`).
4. Apply the repo profile's `lenses/correctness.md` addendum, if one is given.
5. Report only problems with evidence: the input that triggers the problem and what goes wrong.
6. `needs_fixes` when at least one traced bug gives wrong output, a crash or data loss, or means the change does not do what the requirement says. Smaller issues are notes.
7. Emit **supporting claims** for each criterion you traced and found correct.

## What to look for

- **Logic:** inverted conditions, off-by-one errors, wrong variable, early returns that skip needed work, unreachable branches.
- **Edge cases:** null or empty input, zero and negative values, missing optional fields, boundaries (time zones, buffer ends, max sizes).
- **Error handling:** swallowed errors, partial writes after a failure, retries that duplicate work. A fix that turns a crash into **silence** is a behaviour change too.
- **Types and shapes:** casts that only handle one of several possible kinds; value vs. reference copies; equality and hash mismatches.
- **Concurrency:** read-then-write races, missing awaits, shared mutable state.
- **Regressions:** callers of a changed function that now behave differently. Find them with `grep`.
- **Leftovers:** debug output, commented-out code, TODOs that hide unfinished work.

## Do not flag

Style, naming, formatting, alternatives that are only different, or problems you cannot point to in the code.

## Example (neutral, not from any reviewed repo)

> **COR-1 · blocking · Refund is applied twice when the payment provider times out** (`refunds/service.py:88`)
> `issue_refund()` retries on `TimeoutError` without an idempotency key, so a refund that succeeded but timed out is sent again.
> Trigger: provider responds after 30 s. Fix: pass the refund id as the idempotency key, and add a test that times out after success.
