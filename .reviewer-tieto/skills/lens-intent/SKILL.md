---
name: lens-intent
description: Intent and traceability lens. Reconstructs the change's own story (what, why, what it touches, evidence class per part), builds the requirement trace matrix R1..Rn, and flags work outside the requirement's scope. Use when the review message says LENS intent, or when asked whether a change does what its requirement asks. Used by the reviewer-tieto intent-reviewer agent.
---

# Intent lens (blocking only for unmet requirements)

This lens turns "a 200-line diff" into **a story the owner can check**: does this change do what the requirement asks, all of it, and nothing else?

## Instructions

1. **Requirement.** Read `requirement.md` and use the criteria ids in `criteria.json`; do not renumber them. Respect provenance: only `binding: true` criteria can make this lens fail. Criteria with `binding: false` come from non-maintainer comments: report them as abstentions ("adopt as a requirement?"), never as blocking findings. You may add `derived` criteria and state each assumption.
   - **Reported context:** if `R0` exists (a regression or named versions), check whether the merge base contains the reported version or the change that caused the regression (`git tag --contains`, `git merge-base --is-ancestor`). If it does not, R0 cannot be met on this base: raise it as the first abstention ("wrong target?") with the evidence, and mark R0 `unclear` for the verifier to settle.
2. **Story.** For each review unit, write what it does (behaviour, not code), why (which `R`, or `scope`), what else it touches (callers, consumers, public surface; find them with `grep`), and the evidence class.
3. **Trace matrix.** For every criterion, cite the implementing code and the test that proves it. Status: `met`, `met-untested`, `partial`, `missing` or `unclear`.
4. **Scope.** List every changed file or commit no criterion explains. Each one is an **abstention** for the owner. If your task lists **base-branch commits**, they are not this change's work: mention them once and do not count them as scope creep.
5. **Claims vs. reality.** Compare commit messages and doc claims with the diff. A claim the code does not back is a finding.

## Verdict

`needs_fixes` when a criterion is `missing`, or `partial` in a way that breaks the main case (`E2` needed). Otherwise `pass`.

## Extra output

```json
"story": [{"unit": "U1", "what": "...", "why": "R1", "touches": "...", "evidence_class": "E2-traced", "citations": []}],
"trace": [{"requirement": "R1", "text": "...", "derived": false, "status": "met", "code": [], "tests": []}]
```
