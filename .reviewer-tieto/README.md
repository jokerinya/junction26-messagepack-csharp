# reviewer-tieto · Earned Trust AI Review

**AI reviews. Humans stay accountable.** This plugin reviews an agent-written change against its requirement. It produces a **Trust Dossier**: the change's own story, evidence per requirement, what the AI found, what it **refused to decide** and why, what it did **not** check, and exactly which hunks a named human must read. That human signs. The ledger records what happens afterwards, so trust is earned per area and withdrawn after escapes.

Built for the Junction 2026 Tieto challenge "Earned Trust in AI Code". The **core is generic**. Repo knowledge lives in a **repo profile** (`profiles/`). One profile ships with the plugin: `messagepack-csharp`, for the challenge's sample repo. A repo without a profile is reviewed with generic rules, and the dossier says so.

## Flow

```
requirement id ──► risk triage (rules, explainable) ──► 6 lenses in parallel ──► verifier (refutes, runs tests) ──► Trust Dossier ──► named owner signs ──► ledger ──► metrics + per-area trust
                         ▲                                                                                                                                        │
                         └──────────────────────── earned / withdrawn area trust moves future routing one tier ◄──────────────────────────────────────────────────┘
```

## Commands

| Command | What it does |
|---|---|
| `/reviewer-tieto:trust-review <req-id> [base] [--owner "Name"] [requirement]` | Full review. Writes `.trust-review/reviews/<id>/dossier.md` and `.json` and records the review in the ledger |
| `/reviewer-tieto:review-lens <lens> [base] [requirement] [--verify]` | One lens, optionally verified |
| `/reviewer-tieto:sign-off <review-id>` | The named human records a decision, a spot-check, AI misses and the residual risk they accept |
| `/reviewer-tieto:sign-off outcome <review-id> revert <area>` | Records an escape. That area's trust is withdrawn |
| `/reviewer-tieto:trust-metrics [--seed-demo]` | Outcome metrics and per-area trust (`--seed-demo` adds clearly marked synthetic history) |

Example on the sample repo:

```
git checkout ju26-issue-2283
/reviewer-tieto:trust-review "#2283" master --owner "Jane Doe"
```

## Principles built into the plugin

1. **Advice, never approval.** No output says "approved". Only `sign-off` with a person's name closes a review.
2. **Evidence before confidence.** Confidence is the evidence class (E1 executed, E2 traced with checked citations, E3 inferred), not a feeling. A blocking finding needs E2 or better.
3. **Abstaining is a feature.** Scope questions, API decisions, risk trade-offs and anything the AI cannot prove go to a named decider.
4. **The AI checks the AI.** A verifier tries to refute every finding and every "this is fine" claim, checks citations mechanically (`check_citations.py`), and runs tests plus a deletion proof in a throwaway worktree.
5. **Depth follows risk, by rules.** `risk_triage.py` assigns T0/T1/T2 per review unit with named rules. The model can raise a tier but never lower it.
6. **Trust is earned per area and withdrawn after escapes,** from the ledger, not from opinion.
7. **Measure outcomes.** Escapes per merge (and per routed tier), finding acceptance, verifier rejection rate, spot-check agreement, AI misses, owner minutes and time to sign-off.

## Lenses and agents

| Agent | Lens | Blocks? | Model, effort |
|---|---|---|---|
| `intent-reviewer` | Story, requirement trace, scope | When a criterion is missing | Opus, low |
| `correctness-reviewer` | C#, MessagePack runtime, generator and analyzers | Yes | Opus, low |
| `security-reviewer` | Untrusted deserialization, DoS, unsafe, type loading, supply chain | Medium or high | Opus, low |
| `compatibility-reviewer` | Public API, wire format, diagnostic ids, dependencies | Unannounced breaks only | Sonnet, low |
| `documentation-reviewer` | Docs vs. code, XML docs, analyzer docs | When readers are misled | Sonnet, low |
| `verifiability-reviewer` | Test map, tests that cannot fail, deletion proof plan | Never | Sonnet, low |
| `finding-verifier` | Refutes, checks citations, executes | Filters only | Opus, medium |

## Files

| Path | Purpose |
|---|---|
| `profiles/<id>/` | Repo profile: `profile.json` (match, test commands, deciders), `policy.json` (risk areas and rules), `lenses/*.md` (addenda). See `profiles/README.md` |
| `skills/evidence-protocol/` | Shared rules and the JSON contract; `scripts/check_citations.py` |
| `skills/risk-triage/` | Generic core `policy.json` (fallback) and `scripts/risk_triage.py` |
| `skills/lens-*/` | One rule set per lens (`lens-followup` handles re-reviews after fixes) |
| `skills/verify-findings/` | The verifier's procedure |
| `skills/trust-review/` | The orchestrator, the dossier format and `scripts/resolve_profile.py` |
| `skills/sign-off/` | Human sign-off and outcomes; `scripts/trust_ledger.py` (ledger, area trust, metrics, demo seed) |
| `skills/trust-metrics/` | Metrics view |
| `agents/` | One subagent per lens plus the verifier, each with a fixed model and effort |

The scripts use only the Python 3 standard library. A team's own profile goes in `<repo>/.trust-review/profile/` and wins over bundled ones. Commit `<repo>/.trust-review/ledger.jsonl`: it is the team's track record.

## Sign-off on the pull request

In the GitHub Actions pipeline the named owner signs with a comment on the PR, and the merge is blocked until they do.

```
/sign-off accept [--minutes N] [--overrule "why"] [--risk "what I accept"] [note]
/sign-off reject [--minutes N] [note]
```

| Rule | Why |
|---|---|
| Only an assignee of the PR can sign. A comment from anyone else gets a 👎 and nothing more | The owner is a named engineer, not whoever is passing by |
| The dossier must be for the PR's current commit. A new push needs a new review and a new sign-off | A signature covers what was reviewed, nothing later |
| Accepting a `BLOCK` or `NOT-FIX` recommendation needs `--overrule "why"` | The human can overrule the AI, but has to say why, and the reason is recorded and shown on the card |
| The card is found only among the workflow's own comments | Nobody can plant a card with a friendlier outcome |

A valid sign-off turns the **Trust sign-off** status green (red for reject), changes the card header to "SIGNED by `<name>`", and appends the sign-off to `ledger.jsonl` on the `trust-ledger` branch. The pipeline reads that branch at the start of every review, so area trust is earned from real history. To block merges, make **Trust sign-off** a required status check on the target branch. Repository admins can still bypass it unless the rule says otherwise.

Script: `skills/sign-off/scripts/pr_flow.py` (`post-card`, `sign-off`, `ledger-pull`). Workflow: `review-map/workflows/trust-sign-off.yml`. The local command `/reviewer-tieto:sign-off` still works and records more detail (units read, spot-check, AI misses).

## Executed evidence from review-map

[`review-map`](../../review-map/) runs a change on real inputs and on the repo's tests, before and after, in a CI job that holds no secrets. When a recorded run exists for the commit under review, `trust-review` imports what its scripts measured and the verifier does not repeat it:

```
/reviewer-tieto:trust-review "#2234" --evidence <review-map output dir>
```

| Imported (measured by scripts, `E1-executed`) | Not imported |
|---|---|
| Test outcomes before and after · which new tests fail without the change · which changed lines ran · runs with each part of the change removed · the known-break run · reduced-confidence notes · computed findings and not-checked items | The review-map agent's summary, claims and decisions. Judgment stays with the lenses. Its pipeline diagram is shown as a picture, labelled "not evidence" |

A run recorded on a different commit is rejected as stale and listed under "What was not checked". Without a run, or in a repo with no review-map adapter, the review works as before. Script: `skills/trust-review/scripts/import_review_map.py`.

## Limits (by design)

- It is a reference implementation of a concept, not a product. Only one repo profile exists so far.
- Profile rules learned from a review carry provenance tags. Changes used for evaluation (holdouts) must not shape the profile. See `../../docs/decision-log.md`.
- review-map needs a hand-written adapter per codebase. Only `messagepack` exists, so other repos get no imported evidence.
- Without a .NET SDK the verifier cannot execute tests, so evidence tops out at E2 and the dossier says so.
- Area trust needs history. A new team starts **neutral**, which means routing is conservative.
- `lens-followup` re-reviews against the previous dossier. The original GitHub Managed Agents pipeline wiring is not part of this fork.
