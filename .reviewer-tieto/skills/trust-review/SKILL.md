---
name: trust-review
description: Run the full earned-trust review on the current branch and produce a Trust Dossier for a named human owner. It runs risk triage, six lenses in parallel (intent, correctness, security, compatibility, documentation, verifiability), an adversarial verifier, then shows what the AI found, what it refused to decide, what it did not check, and how deeply the owner must read. Never approves.
disable-model-invocation: true
argument-hint: "<requirement-id> [base-branch] [--owner \"Name\"] [requirement text or path to a requirement file]"
---

# Trust review

Arguments: $ARGUMENTS

**The AI's output is advice with evidence. The approval is a named human's signature.** Never print "approved", "LGTM" or "safe to merge".

**Run every shell command as one simple command with absolute paths.** Never chain with `&&`, `;` or `|` and never `cd` first: permission allow-lists (headless or in CI) match only simple commands.

## 0. Parse the arguments

- **Requirement id** (required): for example `#1234`, `REQ-12` or `TIETO-FR-3`. If it is missing, ask for it and stop: a change with no requirement cannot be traced.
- **Base:** the next argument, if it names a branch that exists. Otherwise use the default from the `evidence-protocol` skill (`origin/HEAD`). Show the base you chose, because it changes the diff. **If the requested base and `origin/HEAD` give different merge bases**, list the commits that differ (`git log --oneline <mb-default>..<mb-requested>` and the reverse), pass them to every lens as "base-branch commits, not this change's own work", and add a base-branch question for the owner as the first abstention. (Lesson log: a bot commit already on the default branch was once mistaken for part of the change and flagged as blocking.)
- **Owner:** `--owner "Name"`. If it is missing, use `git config user.name` and mark it "(assumed: confirm at sign-off)".
- **Requirement text:** the rest. If it is a file path, read it. If it is a GitHub issue, fetch it in step 1 with `fetch_requirement.py` (never by reading the issue freehand).
- **Executed evidence:** `--evidence <dir>` names a recorded review-map run for this change (a folder with `analysis.json`). If it is missing, look for `<repo>/.review-map/out/` and `<repo>/review-map-out/`. With none, the review runs as before and the verifier does its own execution.

## 1. Find the change, the repo profile, and triage

0. **Repo profile:** run `python3 <this skill's base directory>/scripts/resolve_profile.py --repo <repo>`. It returns the profile directory (the team's own `.trust-review/profile/`, or a bundled one from the plugin's `profiles/`), or none. Show which one applies. Without a profile the review runs on generic rules only, and the dossier says so in "What was not checked".

1. Work out the merge base (see `evidence-protocol`). Run `git diff --stat <merge-base>` and `git status --porcelain`. If there is nothing to review, say so and stop.
2. Set `REVIEW_ID=<req-id without #>-<short HEAD sha>` and `OUT=<repo>/.trust-review/reviews/$REVIEW_ID`. Create `OUT`. Check `.trust-review/` is git-ignored or meant to be committed, and ask the user once if unclear. The ledger is meant to be committed: the team's track record.
2b. **Requirement with provenance.** For a GitHub issue run `python3 <this skill's base directory>/scripts/fetch_requirement.py --issue <n> --repo <repo> --out-dir $OUT` (add `--repo-slug owner/name` when the issue lives upstream). It writes `requirement.md` with **BINDING** parts (issue body, comments by OWNER/MEMBER/COLLABORATOR) and **NON-BINDING** parts (everyone else), plus `requirement.json`. For pasted text or a file, copy it to `$OUT/requirement.md` as one binding part.
2c. **Criteria, once, for every lens.** Write `$OUT/criteria.json` as `{"criteria": [{"id": "R1", "text": "...", "source": "issue-body|maintainer|other|derived", "binding": true|false|"derived"}]}`:
   - criteria from BINDING parts get `binding: true`;
   - proposals from NON-BINDING parts may be listed, always with `binding: false` (they can raise questions, never block);
   - implicit criteria such as "existing behaviour outside the change stays the same" get `binding: "derived"`;
   - **if `requirement.json` has `regression: true` or reported versions**, add `R0`: "The reported scenario reproduces on the reported version (<versions>) before the change and is fixed there after it", `binding: true`. If the merge base does not contain the reported version, R0 is checked on that version (the verifier runs it there when the profile allows execution).
   Every lens and the verifier use these ids. A lens may add derived criteria (`binding: "derived"`), never binding ones.
3. Area trust: if `<repo>/.trust-review/ledger.jsonl` exists, run `python3 <sign-off base dir>/scripts/trust_ledger.py --repo <repo> area-trust [--policy <profile dir>/policy.json] > <repo>/.trust-review/area-trust.json`.
4. Run `risk-triage` (`risk_triage.py --repo <repo> --base <merge-base> [--profile <profile dir>] [--area-trust ...]`) and save its output to `$OUT/triage.json`.
5. **Executed evidence from review-map (when a run exists).** Run `python3 <this skill's base directory>/scripts/import_review_map.py --dir <run dir> --head <HEAD sha> --merge-base <merge-base> --out $OUT`. It writes `$OUT/executed-evidence.json` and `$OUT/executed-evidence.md`:
   - **exit 0, imported:** review-map's scripts ran this exact commit. Their measurements (ids `EX-TESTS`, `EX-PROOF`, `EX-COVERAGE`, `EX-PARTS`, `EX-KNOWN-BREAK`) are `E1-executed` facts for every lens and for the verifier. Only script-measured facts are imported. The review-map agent's own summary, claims and decisions are not: judgment stays with the lenses.
   - **exit 2, stale or unusable:** the run was recorded on another commit, or cannot be read. Import nothing. Add "review-map evidence not used: <reason>" to "What was not checked", and let the verifier execute as usual.
   - `reduced_confidence` and `base_note` lines go on the dossier, next to the evidence they weaken.

## 2. Run six lenses in parallel (one message)

Start these agents from the reviewer-tieto plugin (they may be listed as `reviewer-tieto:<name>`):
`intent-reviewer`, `correctness-reviewer`, `security-reviewer`, `compatibility-reviewer`, `documentation-reviewer`, `verifiability-reviewer`.

Give each the same prompt: repo path, base, merge base, review id, **the paths of `$OUT/requirement.md` and `$OUT/criteria.json`**, **the profile directory (or "no profile")**, any **base-branch commits** from step 0, a compact triage digest (overall tier, review units, high-risk files with rule ids, notes), and **the path of `$OUT/executed-evidence.md` when step 1.5 imported one** (a lens may cite its `EX-` ids as evidence, with class `E1-executed`). Do not pass a model or effort level: the agent definitions set them.

If the change has more than 3 review units, tell the lenses to cover units in tier order, T2 first, and to list any unit they did not get to under `not_checked`.

## 3. Validate, then verify

1. Write each lens's JSON block **verbatim** to `$OUT/lenses/<lens>.json`. Never summarise or reformat lens output: the validator and the citation check need it as returned.
2. Run `python3 <evidence-protocol base dir>/scripts/validate_lens_output.py $OUT/lenses/<each>.json --criteria $OUT/criteria.json --write` and save its report as `$OUT/validation.json`. It fixes wrong verdicts, turns blocking-on-E3 into abstentions and **blocking-on-non-binding criteria into notes plus api-owner questions**. Every violation goes into the dossier appendix.
3. Run `python3 <evidence-protocol base dir>/scripts/check_citations.py` on the merged list and save `$OUT/citation-check.json`.
4. Start `finding-verifier` with the validated lens files, `citation-check.json`, `criteria.json`, the repo, the merge base, the review id, the profile directory and, when imported, `$OUT/executed-evidence.json`. Wait for it, and save its JSON verbatim to `$OUT/lenses/verifier.json`.

A lens that fails, or returns no JSON, counts as **not run**. Its topic goes into "What was not checked". For a blocking lens, the recommendation is at least T2 for every unit.

## 4. Decide the routing (rules, not judgment)

Start from the triage tiers per review unit, then:

- a **binding** criterion (`binding: true`, including R0) whose final status is `missing` or `not met`, confirmed by the verifier → overall outcome `NOT-FIX`: the change does not do what the requirement asks (also when the evidence is an executed abstention such as "the patch does not fix the reported version");
- a **confirmed blocking** finding in a unit → that unit is `BLOCK` (after validation, blocking findings only rest on binding or derived criteria, or on defects);
- an `unsettled` finding, any abstention citing the unit, or a `weakened`/`refuted` supporting claim → at least `T1`;
- a refuted deletion proof for a criterion → at least `T1` for the units implementing it;
- a security abstention → `T2`, with `security-champion` co-sign.

The overall recommendation is the highest unit tier:
`NOT-FIX` → "Does not meet <req-id>: send back or retarget" · `BLOCK` → "Do not merge yet" · `T2` → "Owner full read of listed units" · `T1` → "Owner focused read of listed hunks" · `T0` → "Ready for owner evidence check".

Findings `refuted` by the verifier are dropped from the main sections and listed in an appendix ("AI findings rejected by the verifier"), because they measure lens noise.

## 5. Write the dossier

Write `$OUT/dossier.md` in exactly this order, with short sections and `path:line` everywhere:

```
# Trust Dossier · <REQ-ID> · <branch> @ <short sha>
Owner: <Name> · Status: UNSIGNED · Recommendation: <one line> · Est. owner time: <min>

## 1. The change in its own words
<the intent lens's story, one row per unit: what · why (R#) · touches · evidence class>

## 2. Requirement trace
| R# | Criterion | Code | Test | Status | Evidence | Verifier |

## 3. What the AI found
<confirmed findings first (blocking, then notes), each: id, lens, title, path:line, trigger → impact, fix, evidence class>

## 4. What the AI refused to decide, and why
| Id | Question | Why the AI did not decide | Evidence that would settle it | Decider |

## 5. What was not checked, and why
<union of all not_checked, plus lenses that did not run, plus "not executed" reasons>

## 6. Where the owner should look
| Unit | Area | Files | Lines | Tier | Why (rule ids) | Read these hunks |

## 7. Residual risk the owner would accept by signing
<plain sentences built from sections 4–5 and the T1/T2 units the owner chooses not to read fully>

## 8. Sign-off
Run: /reviewer-tieto:sign-off <REVIEW_ID> ...

## Appendix: verifier rejections and executed commands
```

Also write `$OUT/dossier.json` with `review_id`, `requirement`, **`outcome`** (one of `T0`, `T1`, `T2`, `BLOCK`, `NOT-FIX`), `profile` (id and plugin version or commit), `base`, `merge_base`, `head`, `owner`, `recommendation`, `units` (with tiers), and the merged findings, supporting claims and abstentions (each with verifier status and evidence class). Save the raw lens and verifier JSON in `$OUT/lenses.json`.

The appendix lists every validator violation from `$OUT/validation.json` (count per lens): contract drift is measured, not hidden.

When executed evidence was imported, `dossier.json` also gets `executed_evidence`: `{source, adapter, recorded_head, claims, reduced_confidence, fingerprints_sha256}` copied from `executed-evidence.json`. The dossier's "What was not checked" takes every `computed_not_checked` item, and its findings take every `computed_findings` item (lens `review-map`, class `E1-executed`, severity note unless a lens raises it with its own evidence).

Record the review in the ledger:
`python3 <sign-off base dir>/scripts/trust_ledger.py --repo <repo> record-review $OUT/dossier.json`

## 5b. Write the PR comment

`dossier.md` is the full record. Reviewers read the PR, so also write `$OUT/pr-comment.md`: GitHub-flavoured markdown that a named owner can act on from the **first screen**, with everything else folded. Build it only from `dossier.json`, `citation-check.json`, `lenses/verifier.json`, `area-trust.json` and `trust_ledger.py metrics --json`: no new claims.

Rules:
- **The 10-second test.** Someone opening the PR must get the main points without scrolling or clicking. Above the fold there are only four things: the header with tier, time and owner; **one** alert box of one or two plain sentences; the one-row glance table; the sign-off line. Everything else goes in `<details>` toggles.
- **The glance table has exactly four cells, counts only:** 🔎 AI found (blocking · notes) · 🤚 AI refused to decide (n questions for you) · 👀 You read (lines of total, plus tests) · ⚠️ You accept (n known risks). No prose in the cells.
- **Toggle order**, each `<summary>` with its icon and a count: 🤚 What the AI refused to decide, and why · 👀 Read these hunks · 🗺 The change as a pipeline (only with review-map evidence) · ⚠️ Residual risk you accept by signing · 🔎 What the AI found · ✅ What was checked, and by whom or what · 🚫 What was not checked, and why · 📋 Requirement trace · 🧩 The change in its own words · 🧪 Verifier log.
- **"What was checked" is a bullet list, not a table:** `**Check:** result · by whom or what · evidence class`. One line each.
- **Alert:** `> [!CAUTION]` for `NOT-FIX`, `BLOCK`, or an abstention backed by E1 evidence against a binding criterion; `> [!WARNING]` for T2; `> [!NOTE]` for T0/T1 with nothing decisive. Write it for someone who has not read the issue: say what not to do and why, with no ids or jargon.
- **No score, gauge or percentage confidence.** Confidence is shown only as an evidence class (`E1 executed`, `E2 traced`, `E3 inferred`) and as counts anyone can check.
- **Hunks are links** when the repo slug and head sha are known: `[TypeCollector.cs:1008](https://github.com/<slug>/blob/<sha>/<path>#L1008)`.
- **Area trust comes from the ledger only** and goes in the footer. With no signed history, write `neutral (no signed history)`. Never invent a track record; mark seeded history `synthetic`.
- **With imported review-map evidence:** "What was checked" lists each `EX-` claim first, as `**<what>:** <result> · review-map script · E1`. Add the toggle 🗺 **The change as a pipeline** right after "Read these hunks": the `pipeline.mermaid` text in a ```mermaid fence, the legend line, and under it "Drawn by the review-map agent. A picture, not evidence." Reduced-confidence notes go inside "What was checked", not on the first screen, unless they affect the alert's evidence. The footer adds `executed evidence: review-map, <n> files fingerprinted (SHA-256 in dossier.json)`.
- Leave out the parts written for evaluators (holdout scorecards, lessons logs): they belong in `docs/`.
- Stay under 60,000 characters (GitHub's comment limit is 65,536). If longer, cut the folded sections and link to `dossier.md`.

Template:

```
### 🔍 Trust Dossier · <REQ-ID> · `<short sha>` · <STATUS>
**<tier> <read depth> · ~<n> min** · Owner: <name>

> [!CAUTION]
> **<what not to do, in plain words>.** <one sentence of evidence> (`<evidence class>`).

| 🔎 AI found | 🤚 AI refused to decide | 👀 You read | ⚠️ You accept |
|:-:|:-:|:-:|:-:|
| <b> blocking · <n> notes | **<n> questions for you** | <n> of <total> lines + <n> tests | <n> known risks |

**Sign off:** `/reviewer-tieto:sign-off <REVIEW_ID>` · The AI does not approve. A named human signs.

<details><summary>🤚 <b>What the AI refused to decide, and why</b> (<n> questions)</summary> table: # · Question · Why the AI did not decide · Evidence that would settle it · Decider </details>
<details><summary>👀 <b>Read these hunks</b> (<tier>)</summary> one bullet per unit: **U#** area · why (rule ids) · linked hunks </details>
<details><summary>🗺 <b>The change as a pipeline</b></summary> only with review-map evidence: mermaid diagram, legend, "a picture, not evidence" </details>
<details><summary>⚠️ <b>Residual risk you accept by signing</b> (<n>)</summary> plain sentences </details>
<details><summary>🔎 <b>What the AI found</b> (<n> findings · <c> confirmed · <w> weakened · <b> blocking)</summary> table: Id · Lens · Severity · Finding · Where · Evidence · Verifier </details>
<details><summary>✅ <b>What was checked, and by whom or what</b></summary> bullets </details>
<details><summary>🚫 <b>What was not checked, and why</b></summary> bullets </details>
<details><summary>📋 <b>Requirement trace</b> (R0–R#)</summary> table </details>
<details><summary>🧩 <b>The change in its own words</b> (<n> units)</summary> table </details>
<details><summary>🧪 <b>Verifier log</b></summary> citations, verdict counts, executed commands, rejected AI findings, contract violations </details>

<sub>Area trust (ledger): <area: state, …> · reviewer-tieto <version> · profile <id> · review <REVIEW_ID> · full record: `.trust-review/reviews/<REVIEW_ID>/dossier.md`</sub>
```

To post it on the PR (only when the user asks): `gh pr comment <pr> --body-file $OUT/pr-comment.md`.

## 6. Print to the user

Print sections 1 (header), 3, 4 and 6 of the dossier, plus the path to the full file. Then give the exact sign-off command. Do not change code. If there are confirmed blocking findings, offer to fix them. A fix is a new change and gets a new review.
