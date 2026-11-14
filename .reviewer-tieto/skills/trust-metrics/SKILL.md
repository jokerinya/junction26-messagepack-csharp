---
name: trust-metrics
description: Show whether the AI reviewer is earning trust, from the trust ledger. Covers share of changes routed to humans, AI finding acceptance, verifier rejection rate, spot-check agreement, AI misses, time to sign-off, escapes per tier, per-area earned or withdrawn trust, and the trend of review time vs. escapes. Use when asked how well the AI review works, or for trust metrics.
argument-hint: "[--seed-demo]"
---

# Trust metrics

Arguments: $ARGUMENTS

Trust is measured on **outcomes**, not review activity. The bar: owner review time falls while reverts and escapes do not rise.

1. With `--seed-demo`, first run `trust_ledger.py --repo <repo> seed-demo` (from the `sign-off` skill's `scripts/`). Say clearly that the history is **synthetic**.
2. Run `python3 <sign-off base dir>/scripts/trust_ledger.py --repo <repo> metrics` and `... area-trust`.
3. Print both. Then add at most 5 lines of reading:
   - Is the trend line healthy (minutes down, escapes flat or down)?
   - Which lens is noisy (low acceptance or high verifier rejection)? That lens's rules need work.
   - Any escape at **T0**? That means routing was too light for that area. Propose a policy rule, and do not apply it without the user.
   - Which areas have earned or lost trust, and why.
4. Show "AI misses found by humans" prominently. It is the honest counterweight to every other number.
