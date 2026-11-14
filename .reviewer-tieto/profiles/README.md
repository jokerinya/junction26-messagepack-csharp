# Repo profiles

The plugin's core (rules, scripts, lenses) is generic. A **repo profile** adds what a reviewer must know about one codebase: its risky areas, its domain-specific pitfalls, how to run its tests and who decides what.

```
profiles/<id>/
  profile.json        id, match rules, test commands, deciders, provenance
  policy.json         risk areas, content rules, generated file pairs, tiers, trust thresholds (replaces the core policy)
  lenses/<lens>.md    addendum per lens (correctness, security, compatibility, documentation, verifiability, intent)
  run-tests.sh        the ONLY way the verifier executes code: run-tests.sh <worktree> check|setup|test <target> [filter]
                      (one allow-list rule; refuses the main working tree; toolchain quirks live here)
```

**Resolution** (`skills/trust-review/scripts/resolve_profile.py`): the team's own `<repo>/.trust-review/profile/` wins. Otherwise the plugin uses a bundled profile whose `match` hits (remote URL or files). Otherwise there is no profile, and the dossier says the review used generic rules only.

## Rules for writing a profile

1. **Checklists, not answers.** A profile lists things to check, never worked examples taken from the changes it will review. An example that describes a known bug primes the model with the answer.
2. **Provenance on every learned rule.** A rule added after a review or an escape carries `[from review <id>]` or `[from escape <id>]`. The profile then shows how the team's trust was earned.
3. **Holdout discipline.** Changes used to evaluate the reviewer must not have shaped the profile. Freeze the plugin version before a holdout run, and only change the profile after its result is recorded.
4. **The team owns it.** Copy a bundled profile to `<repo>/.trust-review/profile/` and commit it, so it is reviewed like code. The team's standards and requirement sets belong here.

## Bundled

| Profile | For | Notes |
|---|---|---|
| `messagepack-csharp` | MessagePack-CSharp (.NET serializer, Roslyn generator) | Calibrated on review 2283-9df83c38. Holdouts: ju26-issue-2234, ju26-issue-2297 |
