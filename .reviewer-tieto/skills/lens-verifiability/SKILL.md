---
name: lens-verifiability
description: Advisory review of how a change is proven (requirement-to-test map, tests that cannot fail, tests that do not reproduce the real scenario, deletion proof, executable verification plan), extended by the repo profile's verifiability addendum and test commands. Use when the review message says LENS verifiability, or when asked how a change is tested.
---

# Verifiability lens (advisory: never blocks)

Tests are the cheapest evidence a human can trust, but only if they could fail. Agent-written tests often cannot. Always use `verdict=advisory`.

## Instructions

1. Map each test in the diff to a requirement criterion.
2. For each test, ask: **would it fail if the production change were reverted?** Weak tests include: no assertion, "no exception" only, snapshots that accept anything, and assertions against values the code under test computed.
3. Ask: **does the test reproduce the requirement's real scenario?** Same environment, same kind of input, same boundary (process, assembly, network). A test of an easier neighbouring case proves nothing about the reported one.
4. Check new tests are wired in (project or suite files, not excluded).
5. Note behaviour verified only elsewhere (CI matrix, other platforms) or not at all.
6. End with a **verification plan** of 3–6 executable steps using the repo profile's test commands, including a **deletion proof** (revert which production files; which tests must then fail).

## Extra output

```json
"verification_plan": [
  {"step": 1, "requirement": "R1", "command": "<test command>", "expect": "pass"},
  {"step": 2, "requirement": "R1", "deletion_proof": {"revert": ["<production file>"], "command": "<test command>", "expect": "fail"}}
]
```

## Example (neutral, not from any reviewed repo)

> **VER-1 · note · Test cannot fail** (`tests/test_export.py:40`)
> `assert export(report) is not None`: `export` never returns `None`, so this passes without the change. Assert the exported rows instead.
