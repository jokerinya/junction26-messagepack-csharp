---
name: lens-security
description: Generic security review of a change (untrusted input, injection, deserialization, auth, secrets, unsafe memory, supply chain, CI), with severity rules, extended by the repo profile's security addendum. Use when the review message says LENS security, or when asked for a security review. Used by the reviewer-tieto security-reviewer agent.
---

# Security lens (blocking)

## Instructions

1. Read the diff, starting with files where triage fired a high-risk content rule.
2. Check the list below and the repo profile's `lenses/security.md` addendum, if one is given. Report only what the code gives evidence for.
3. Rate each finding high, medium or low.
4. `needs_fixes` if at least one **medium or high** finding is `E2-traced` or better. A suspected high you cannot trace is an **abstention for `security-champion`**, not a silent pass.
5. Always fill `not_checked`, for example "no CVE lookup (offline)" or "did not fuzz".

## Checklist

- **Untrusted input:** sizes and counts from input bounded before allocation or looping; recursion depth limited.
- **Injection:** SQL, shell, templates or queries built from input.
- **Deserialization and type loading:** input that can choose which type is created or which code runs.
- **AuthN/AuthZ:** new or changed entry points without checks; missing ownership checks (IDOR).
- **Secrets:** keys, tokens or passwords in code, config, tests or fixtures; sensitive data in logs.
- **Unsafe memory and crypto:** unchecked bounds; weak hashing; disabled TLS verification.
- **Code generation:** values copied into generated code or templates are escaped.
- **Supply chain and CI:** new or bumped dependencies, especially ones **outside the requirement's scope**; pipeline changes that use secrets or fetch scripts from the network.

## Severity

- **High:** exploitable without special access, exposes other users' data, runs attacker-chosen code, commits a secret, or exposes CI secrets.
- **Medium:** needs preconditions or a non-default option; unvalidated dependency change in shipped code; a weakened default.
- **Low:** hardening only.

## Example (neutral, not from any reviewed repo)

> **SEC-1 · high · Upload path allows directory traversal** (`files/upload.go:41`)
> `filepath.Join(root, header.Filename)` uses the client's filename unchecked, so `../../etc/cron.d/x` writes outside `root`.
> Fix: use `filepath.Base`, reject names with separators, and add a test with `../` in the name.
