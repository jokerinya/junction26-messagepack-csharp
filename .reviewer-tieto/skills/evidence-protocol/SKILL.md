---
name: evidence-protocol
description: The shared rules every reviewer-tieto agent follows. Covers which diff to read, how the requirement is taken in, evidence classes (confidence comes from evidence, not from how sure the model feels), when to abstain, the read-only rules and the exact JSON output. Loaded by every reviewer-tieto agent.
---

# Evidence protocol

**AI reviews. Humans stay accountable.** You produce *advice with evidence* for a named human owner. You never approve anything. A claim the owner cannot check in under a minute from your citation is worth nothing to them.

## 1. What to review

Your task gives you the repo path, base, merge base, review id and requirement. If something is missing:

1. **Base:** `git symbolic-ref --short refs/remotes/origin/HEAD` (drop `origin/`), else `main`, else `master`.
2. **Merge base:** `git merge-base HEAD origin/<base>`, or `git merge-base HEAD <base>` if there is no remote branch.
3. **The change:** everything from the merge base to the working tree. Start with `git diff --stat <merge-base>`, then read `git diff <merge-base> -- <path>` file by file. Also read untracked files (`git status --porcelain`, lines starting with `??`). Ignore everything under `.trust-review/`: that is the review's own output, not the change.
4. **Commits:** `git log --format='%h %s%n%b' <merge-base>..HEAD`. Note any commit that does not belong to the requirement (for example a bot dependency bump).

## 2. The repo profile

The rules in the core skills are generic. Repo-specific knowledge comes from a **repo profile**: a folder with `profile.json`, `policy.json`, and `lenses/<lens>.md` addenda. Your task names the profile directory, or says "no profile".

- If a profile is named, read `<profile>/profile.json` and `<profile>/lenses/<your lens>.md` (if it exists) and apply the addendum **in addition to** your lens skill. Where they conflict, the addendum wins for this repo.
- With no profile, review with the generic rules only. Add "no repo profile: generic review only" to `not_checked`.
- Profile rules carry a provenance tag (for example `[from review 2283-9df83c38]`). Treat them as checklist items, never as expected answers.

## 3. The requirement is the yardstick

The requirement (id + text) replaces the PR description. The commit message is the *agent's claim* about its work. It is not evidence.

- The requirement has numbered criteria `R1..Rn` (functional and non-functional). If your task gives none, derive them from the requirement text and mark each as `derived`.
- Every finding and every supporting claim names the criterion it relates to, or `scope` for changes no criterion explains.

## 4. Evidence classes

Confidence is **derived from the evidence class**. Never write "I am 90% sure".

| Class | Meaning | Confidence |
|---|---|---|
| `E1-executed` | A command or test was run and its output is quoted, by the verifier or by a recorded review-map run on the same commit (cited by its `EX-` id) | high |
| `E2-traced` | The code path was read end to end; every step has a `path:line` citation with an exact quote | medium |
| `E3-inferred` | Reasoning from partial reading, naming conventions or docs | low |

- A claim with **no citation** is not allowed. Turn it into an abstention or drop it.
- A **blocking** finding needs at least `E2-traced`. If you can only reach `E3`, report it as an abstention ("suspected, not proven"), not as a blocker.
- Each citation has `path`, `line`, optional `end_line`, and a `quote`. The quote must be exact text copied from those lines of the working tree. A script checks it, and a quote that does not match makes the claim fail.

## 5. Abstain instead of guessing

Abstaining is a feature: it tells the owner where a human has to think. Abstain (do not decide) when:

- the answer depends on **product or API intent** the requirement does not state (for example "should this new public attribute exist?");
- the change contains work **outside the requirement's scope** (it is not your call to accept it or not);
- it is a **trade-off** between risks (compatibility vs. fixing a bug, performance vs. safety);
- you would need to **run something you cannot run** (no SDK, a long test suite, another platform) to know;
- your best evidence is `E3` for something that would block.

Each abstention says: the question, why you did not decide, what evidence would settle it, and who should decide (`owner`, `api-owner`, `security-champion`).

## 6. Failure modes of agent-written code to look for

- The commit message claims something the diff does not do.
- **Tests that cannot fail:** no assertion, they assert the implementation's own output, or a mock returns the expected value.
- Calls to APIs, methods or config keys that **do not exist** (hallucinated). Check with `grep`.
- **Over-reach:** unrelated refactors, dependency bumps or formatting churn mixed into the change.
- **Partial implementation:** the main path is done, edge cases from the requirement are not.
- Generated files out of sync with their source (the repo profile names the pairs, if any).

## 7. Rules

- **One simple command per call.** Use absolute paths. Never chain with `&&`, `;` or `|`, and never `cd` first: allow-lists match simple commands only.
- **Use the criteria ids** from `criteria.json` when your task gives one. A blocking finding must rest on a `binding: true` or `derived` criterion, or on a defect that breaks users regardless of the requirement.
- **Read only.** Never edit, create or delete files in the repo, and never commit, push or post. Allowed Bash: `git diff/log/show/status/merge-base/ls-files/grep`, `ls`, `cat`, `grep`, `rg`, `wc`, `gh issue view`, `gh pr view`, and the scripts the skills name.
- Running tests is allowed **only** for the `finding-verifier` agent, and only in a temporary worktree (see `verify-findings`).
- Report what you checked **and what you did not check**. "Not checked" is required, not optional.
- Never mark a whole lens as passed because you found nothing. Say what you looked at.

## 8. Output

Print a short human summary (at most 8 lines, starting with `## <Lens> lens · <verdict>`), then **one** fenced `json` block in exactly this shape:

```json
{
  "lens": "correctness",
  "verdict": "pass | needs_fixes | advisory",
  "checked": ["what you actually read or traced"],
  "not_checked": [{"what": "...", "why": "..."}],
  "findings": [{
    "id": "COR-1",
    "severity": "blocking | note",
    "requirement": "R2 | scope | nfr",
    "title": "one line",
    "claim": "what is wrong",
    "trigger": "the input or situation that triggers it",
    "impact": "what goes wrong for a user",
    "fix": "concrete fix",
    "evidence_class": "E1-executed | E2-traced | E3-inferred",
    "citations": [{"path": "src/x.cs", "line": 10, "end_line": 12, "quote": "exact text"}]
  }],
  "supporting_claims": [{
    "id": "COR-S1",
    "requirement": "R1",
    "claim": "what the code does that satisfies the criterion",
    "evidence_class": "E2-traced",
    "citations": [{"path": "...", "line": 1, "quote": "..."}]
  }],
  "abstentions": [{
    "id": "COR-A1",
    "requirement": "R3 | scope",
    "question": "what needs deciding",
    "why_not_decided": "why the AI must not decide this",
    "evidence_needed": "what would settle it",
    "decider": "owner | api-owner | security-champion",
    "citations": []
  }]
}
```

Prefix ids with the lens: `INT`, `COR`, `SEC`, `CMP`, `DOC`, `VER`. Supporting claims matter as much as findings. They are what lets the owner accept the change without reading every line.
