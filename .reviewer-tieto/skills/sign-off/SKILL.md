---
name: sign-off
description: Record a named human owner's decision on a trust-review dossier in the append-only trust ledger. The record covers what they read, which AI findings they accepted or rejected, a spot-check of one AI claim, issues the AI missed and the residual risk they accept. Also records later outcomes (reverts, incidents, escapes) that withdraw per-area trust.
disable-model-invocation: true
argument-hint: "<review-id> | outcome <review-id> <revert|incident|escape|bug> <area> [note]"
---

# Sign-off: a human owns the decision

Arguments: $ARGUMENTS

The dossier is advice. This step is the approval, and it can only come from a person. **You record what the human says. Never fill in a decision, a name or an answer for them.**

## Recording a sign-off

1. Read `<repo>/.trust-review/reviews/<review-id>/dossier.md`. If it is missing, say so and stop.
2. Show the owner the recommendation, the units they were asked to read, the abstentions and the "not checked" list.
3. Pick **one confirmed supporting claim or finding at random** for the spot-check. Show its citation and ask the owner whether it holds.
4. Ask the owner, in one message (use AskUserQuestion where it fits):
   - their **name** (the accountable person; not a team) and any **co-signer** the dossier requires (`security-champion`, `api-owner`);
   - the **decision**: `accept`, `accept-with-conditions`, `reject` or `send-back`;
   - which **units they read** and roughly how many **minutes** it took;
   - which AI findings they **accept** and which they **reject** as wrong or not worth fixing;
   - an answer for **each abstention** (that answer is theirs, and becomes part of the record);
   - anything **the AI missed** that they found;
   - the **residual risk** they accept, in their own words. Offer section 7 of the dossier as a starting point.
5. If a `BLOCK` unit is still open and the decision is `accept`, ask for an explicit overrule reason and put it in `--conditions`.
6. Run:

```bash
python3 <this skill's base directory>/scripts/trust_ledger.py --repo <repo> sign-off <review-id> \
  --owner "<name>" --decision <decision> --minutes <n> --read-units U1,U3 \
  --accepted COR-1,DOC-1 --rejected CMP-2 --spot-check INT-S2:agree \
  --missed "<text>" --residual-risk "<text>" [--conditions "<text>"] [--cosigner "<name>"]
```

7. Append a `## Signed` section to the dossier with the same facts and a UTC timestamp, then change `Status: UNSIGNED` to `Status: SIGNED by <name>`.

## Recording an outcome

For `outcome <review-id> <kind> <area> [note]`, run `trust_ledger.py ... outcome <review-id> --kind <kind> --area <area> --note "<note>"`. Tell the user that this area's trust is now **withdrawn** for the configured window, so its changes will route one tier deeper.
