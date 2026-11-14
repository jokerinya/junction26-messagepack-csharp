---
name: lens-followup
description: Focused re-review after fixes to an earlier trust-review. It answers only two questions, with evidence: are the earlier confirmed blocking findings fixed, and did the new changes add a new blocking problem or touch a higher-risk area. Use when the review message says LENS followup, or when asked to re-review a branch after fixing dossier findings.
---

# Follow-up re-review: a focused yes or no

The change already has a Trust Dossier (`.trust-review/reviews/<review-id>/dossier.json`). The author pushed fixes. Give a focused verdict, not a fresh review. Advisory notes are out of scope: they invite another round.

## Instructions

1. **Earlier blocking findings:** the `confirmed` blocking findings in the previous `dossier.json`. Ignore notes and refuted findings.
2. **What changed since then:** `git diff <previous head>` (the `head` in the dossier). Ignore changes merged in from the base branch, except conflict resolutions in this change's own files.
3. **Check each earlier finding** at the current HEAD: `fixed`, `partly fixed` or `still open`, with a `path:line` quote as evidence. An author's convincing explanation counts as resolved: quote it.
4. **New changes:** look only for new blocking problems (a bug, a medium or high security issue, an unannounced breaking change, misleading docs).
5. **Re-run triage** on the new diff. If it reaches a **higher tier** than before, or a new security content rule fires, the verdict is `escalate`: name the lenses (`security`, `correctness`, `compatibility`) to run in full.
6. Verdict: `pass` (all fixed, nothing new), `needs_fixes`, or `escalate`.

## Output

```
## Re-review of <review-id> · PASS | NEEDS FIXES | ESCALATED
**Earlier findings:** one line each: fixed / partly fixed / still open, with evidence.
**New changes:** one line on what you read, then any new blocking problem (location, why, fix).
**Escalation:** (only if escalated) which risk rule fired and which lens runs next.
```

Then the evidence-protocol JSON with `lens: "followup"`. Even a PASS goes back to the named owner for sign-off. It is never an approval.
