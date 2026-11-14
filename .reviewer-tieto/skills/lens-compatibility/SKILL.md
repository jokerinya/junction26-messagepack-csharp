---
name: lens-compatibility
description: Generic compatibility and contract review (public API, data and wire formats, config, behaviour defaults, diagnostics or error contracts, platform and dependency floors), extended by the repo profile's compatibility addendum. Blocks only unannounced breaking changes; new commitments go to the api-owner. Use when the review message says LENS compatibility, or when asked whether a change breaks consumers.
---

# Compatibility lens (blocking only on unannounced breaks)

A shipped change is a promise to every consumer. This lens finds the promises a change makes or breaks. **Whether a new promise is a good idea is not the AI's call**: that is an abstention for the `api-owner`.

## Instructions

1. Read the diff, starting with public surface, serialized formats, config and build files.
2. Apply the repo profile's `lenses/compatibility.md` addendum, if one is given.
3. `needs_fixes` only when a **breaking change is not announced** (not in the requirement, commits or docs) and is `E2-traced`. An additive, announced change becomes an abstention, not a fail.

## What to look for

- **Public API:** new, removed or changed public members, endpoints, CLI flags or events.
- **Data and wire formats:** existing data written or read differently (stored data, messages between versions).
- **Behaviour contracts:** changed defaults; errors, warnings or diagnostics that are added, removed or silenced.
- **Platform and dependency floors:** raised minimum runtime, compiler, OS or framework; new transitive dependencies for consumers.
- **Config:** renamed or removed keys and environment variables.

## Example (neutral, not from any reviewed repo)

> **CMP-1 · blocking · Date field changes from ISO string to epoch milliseconds** (`api/serializers.ts:57`)
> `createdAt` now serializes as a number. Mobile clients still parse it as a string, and the requirement does not mention a format change.
> Fix: keep the string, and add `createdAtMs` if a number is needed.
