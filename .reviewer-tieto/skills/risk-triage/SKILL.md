---
name: risk-triage
description: Explainable, rule-based risk classifier that decides how deeply a human must read each part of a change (T0 evidence check, T1 focused read, T2 full read). It uses policy areas, content rules on added lines and per-area earned trust. Use when routing human review attention, or when asked how risky a change is or which parts need a human.
---

# Risk triage

Human review depth follows risk. The tier must be explainable: every tier lists the rules that set it. A score with no reasons is not allowed.

## Run it

```bash
python3 <this skill's base directory>/scripts/risk_triage.py --repo <repo> --base <merge-base> \
  [--profile <profile dir>] [--area-trust <repo>/.trust-review/area-trust.json]
```

- The policy is the repo profile's `policy.json` (see `trust-review/scripts/resolve_profile.py`). Without a profile it is this skill's generic `policy.json`, which treats unknown code as medium risk.
- `--area-trust` comes from `sign-off/scripts/trust_ledger.py area-trust`. It moves an area's tier down one step (**earned**, from a track record) or up one step (**withdrawn**, after an escape). High-risk areas never drop below T1.

## What comes out

JSON with `overall_tier`, `areas`, `review_units` (the change split into human-sized chunks of at most 400 lines or 15 files), `files` (each with `reasons` and `hunks`) and `notes` (for example a generated pair from the profile's `generated_pairs` changed on one side only).

## How the orchestrator uses it

1. Pass `review_units` and the high-risk files to the lens agents, so they spend their reading there first.
2. After the lenses run, **raise** a unit to at least T1 when it has an abstention or a finding the verifier could not settle. **Raise** it to BLOCK when it has a confirmed blocking finding.
3. The tier is never lowered by the model, only by the policy and by earned trust. The AI cannot talk itself into less human review.

## Tiers

| Tier | The named owner… |
|---|---|
| T0 | reads the dossier and spot-checks one verified claim at random |
| T1 | reads only the listed hunks, plus the dossier |
| T2 | reads every line of that unit. For security rules, a security champion co-signs |
| BLOCK | does not merge until the confirmed blocking finding is fixed or explicitly overruled with a reason |
