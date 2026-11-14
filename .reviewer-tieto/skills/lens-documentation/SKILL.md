---
name: lens-documentation
description: Generic documentation review (change description and requirement link, docs vs. code, public API docs, contracts and ops steps, comments the change made wrong), extended by the repo profile's documentation addendum. Use when the review message says LENS documentation, or when asked to review the documentation of a change. Used by the reviewer-tieto documentation-reviewer agent.
---

# Documentation lens (blocking)

## Instructions

1. Read the requirement, commit messages, the diff and the changed docs.
2. Check the list below and the repo profile's `lenses/documentation.md` addendum, if one is given.
3. `needs_fixes` only when a reviewer, consumer or maintainer would be **blocked or misled**, for example docs that describe behaviour the code does not have. Everything else is a note.

## What to look for

- **Change description:** it names the requirement id and says why, what changed, how it was tested, and what is *not* done. Locally, list what the PR description must say.
- **Docs vs. code:** agent-written docs often describe the intended behaviour, not the implemented one. **Check every new doc claim against the code** and cite both.
- **Public API docs** for new public members.
- **Contracts and ops:** new config keys, env vars, migrations or manual steps are written down.
- **Comments** the change made wrong; non-obvious logic with no *why*.

## Do not flag

Self-explanatory code without comments; wording preferences.

## Example (neutral, not from any reviewed repo)

> **DOC-1 · blocking · README says retries are configurable; they are hard-coded** (`README.md:212`, `client/retry.py:9`)
> The README documents `RETRY_COUNT`, but `MAX_RETRIES = 3` is a constant and no env var is read.
