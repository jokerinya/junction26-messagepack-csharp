# review-map

An AI reviewer for AI-written pull requests, built so a human can trust what it says.

It runs the change instead of only reading it. A reviewing agent (Claude) reads the diff and the issue and picks real inputs; those inputs and the repository's own tests run on the code before and after the change; the agent then explains the evidence. The result is one pull request comment.

## The top of the comment: found, refused to decide, not checked

The comment opens with three typed lists, kept apart on purpose:

| List | Fields | Rules the script applies |
|---|---|---|
| **What it found** | statement, severity, evidence pointers | Only a run or a test can make a finding a WARNING or CAUTION; code reading alone becomes a NOTE. Findings computed from the runs (new tests that pass on the old code) are added by the script. |
| **What it refused to decide** | question, reason, why, what would settle it, options, owner | The reason comes from a fixed list: `intent`, `trade-off`, `unreproduced`, `out-of-reach`. The script itself opens the "does this fix the issue?" decision when the issue's reproduction does not show the expected symptom on the code before the PR. |
| **What it did not check** | item, reason, risk if wrong, how to check | The script adds changed lines no scenario or test ran, requirements no scenario covers, scenarios that could not run, and test projects that were not run. |

**Requirements and the expected symptom are a prediction.** In the plan step, before anything runs, the agent breaks the issue into requirements (one marked primary: "the reported bug is gone"), maps each scenario to the requirements it covers, marks the issue's reproduction, and states how the bug will show in the recording (a hand-off and strings such as an exception type). After the runs, the requirement table shows each requirement, the scenarios that cover it with the hand-offs that differ, and a verdict. A requirement nothing covers is "not shown". The primary requirement cannot be "met" unless the predicted symptom was seen on the before side.

**Owners.** A decision goes to a named engineer, never to the PR's author (an agent's operator). Set the repository variable `REVIEW_MAP_OWNERS` to `alice,bob` or per reason (`intent=alice,trade-off=bob,default=carol`). Without it, the PR's requested reviewers and assignees are used. Only these people get an `@`-mention; otherwise the decision shows as unassigned.

## The rule: the agent points, the script quotes

The agent never writes evidence values. Every summary sentence, "Start here" item, unit example and claim carries pointers (`refs`) to the evidence:

| Pointer | Resolved against | Quoted by the script |
|---|---|---|
| `run`: scenario, hand-off, side, expects | `probe-before.json`, `probe-after.json` | the hand-off's value before and after, linked to its trace row |
| `test`: name, expects | per-test outcomes of both sides | outcome before → after |
| `code`: path, lines | the reviewed commit | a link and the first line |

`lib/verify.mjs` resolves every pointer. When a pointer doesn't exist, or resolves to something other than its `expects` (for example, cited as a difference when the hand-off is identical), the item moves to **Not backed by the evidence**, together with what the runs actually show. A claim backed only by code reading is shown as "holds in the code, not run".

The script also computes these, with no agent involved (`lib/checks.mjs`, `lib/evidence.mjs`):

- **New tests that don't discriminate:** the PR's new tests run against the old code; any that pass there too are flagged.
- **Changed lines that ran:** code coverage on the after side, intersected with the diff ("18 of 18 changed lines reached; not reached: …").
- **Which part causes what:** the PR is rebuilt with each source hunk removed (up to 12 hunks and 12 builds), and every input runs through each build. A hunk other changed lines depend on is grouped with them, using the compiler's errors. For each part, the comment shows where removing it brings the old value back. A part whose removal changes nothing becomes a not-checked item.
- **Can the probe see a break?** A fixed, known-bad mutation from the adapter is applied to the after code. The method section reports which scenarios and hand-offs light up.
- **Reduced confidence:** an SDK that doesn't satisfy the `global.json` pin, a before side that had to revert the tests too, a side that didn't run, or a missing check. Shown at the top.
- **Fingerprints:** SHA-256 of each evidence file and a link to the workflow artifact, in the footer.

## Steps

| Step | Does | Holds |
|---|---|---|
| `plan` | Agent reads diff and issue, writes scenarios | API key; PR code not run |
| `evidence` | Runs scenarios and tests before and after, with coverage and the known-break run | Nothing secret; this is the only step that runs PR code |
| `analyze` | Agent explains the evidence with pointers; the gate resolves them; script builds the comment | API key; PR code not run |
| `post` | Creates or updates one comment | GitHub token |
| `replay` | Re-runs one scenario before and after and compares it with the recording | Nothing secret |

In GitHub Actions the first four are three jobs (`workflows/review-map.yml`). The reviewer is checked out from the base branch, so a pull request cannot change its own reviewer.

## Re-check a finding yourself

Every trace and finding in the comment prints a command like:

```bash
node .review-map/review.mjs replay --run <workflow run id> --scenario <id> --repo <checkout of the reviewed commit>
```

It downloads the run's recorded inputs and evidence (`gh run download`), prints their SHA-256 so you can compare them with the comment footer, re-runs that one input on the reviewed commit and on its source reverted, and says, for each hand-off, whether it matches the recording. Run `npm ci --prefix .review-map` once first.

## Use with reviewer-tieto

The [`reviewer-tieto`](../plugins/reviewer-tieto/) plugin imports a recorded run as executed evidence for its Trust Dossier, so one PR gets one comment:

```
/reviewer-tieto:trust-review "#2234" --evidence <this tool's output dir>
```

It takes only what the scripts here measured (tests on both sides, new tests that don't discriminate, changed lines that ran, the per-part builds, the known-break run, reduced confidence, computed findings and not-checked items) and the pipeline diagram as a picture. A run recorded on another commit is rejected. `out/local-2234/` is kept in the repo as a sample run: the gate test and the plugin's importer both read it. Other run output, `node_modules/` and logs are not committed.

## Adapters

Everything specific to one codebase lives in `adapters/<name>/`:

- a plain description of the pipeline for the agent;
- the probe that records each hand-off;
- how each hand-off is shown;
- the known-break mutation.

`adapters/messagepack` covers the MessagePack-CSharp source generator.

## Local run

```bash
npm ci
ANTHROPIC_API_KEY=... node review.mjs all --repo <checkout at PR head> --pr <n> --slug owner/repo --out out/pr-<n>
```

Add `--rollforward-sdk` when the pinned .NET SDK isn't installed locally. The comment will then show reduced confidence.

`analyze --agent-output <file>` reuses a recorded agent response instead of calling the API. `npm test` runs the gate against a fixture with planted mistakes; it needs `out/local-2234` from a local evidence run of PR 2.

A hand-written analysis (`analyses/2283.source.json`) goes through the same gate and checks:

```bash
node scripts/finish.mjs analyses/2283.source.json --repo <checkout>
node render.mjs analyses/2283.json
```
