---
name: review-lens
description: Run one review lens (intent, correctness, security, compatibility, documentation or verifiability) on the current branch, optionally followed by the verifier, with the same model and effort as the full trust review.
disable-model-invocation: true
argument-hint: "<intent|correctness|security|compatibility|documentation|verifiability> [base-branch] [requirement id and text] [--verify]"
---

# Review one lens

Arguments: $ARGUMENTS

1. The first argument names the lens. If it is missing or unknown, list the six lenses with one line each on what they check, and stop.
2. The next argument, if it names a branch that exists, is the base. `--verify` asks for a verifier pass. The rest is the requirement.
3. Find the change as described in the `evidence-protocol` skill. If there is nothing to review, say so and stop.
4. Start the matching agent from the reviewer-tieto plugin: `<lens>-reviewer` (it may be listed as `reviewer-tieto:<lens>-reviewer`). Give it the repo path, base, merge base and requirement. Do not pass a model or effort level.
5. With `--verify`, pass its JSON to `finding-verifier` and mark each finding with the verifier's status.
6. Print the review. Do not change code, and never call the result an approval.
