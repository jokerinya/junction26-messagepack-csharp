#!/usr/bin/env python3
"""Mechanical hallucination guard: check that every citation in lens output exists.

Usage: check_citations.py <lens-output.json> [--repo PATH]

The input is one lens JSON object, or a list of them. For each citation in
findings, supporting_claims and abstentions, it checks that:
  - the file exists in the working tree,
  - the line range is inside the file,
  - the quote (whitespace-normalised) appears within the cited lines +/- 3.
It prints JSON: one result per cited item, plus a summary. Stdlib only, read only.
"""
import argparse
import json
import os
import re
import sys

SLACK = 3


def norm(s):
    return re.sub(r"\s+", " ", s or "").strip()


def check_citation(repo, c, cache):
    path = c.get("path", "")
    full = os.path.join(repo, path)
    if not path or not os.path.isfile(full):
        return False, f"file not found: {path}"
    if full not in cache:
        with open(full, encoding="utf-8", errors="replace") as f:
            cache[full] = f.read().splitlines()
    lines = cache[full]
    try:
        start = int(c.get("line", 0))
        end = int(c.get("end_line") or start)
    except (TypeError, ValueError):
        return False, "line is not a number"
    if start < 1 or start > len(lines) or end < start:
        return False, f"line {start}-{end} outside file ({len(lines)} lines)"
    quote = norm(c.get("quote"))
    if not quote:
        return False, "no quote given"
    window = norm(" ".join(lines[max(0, start - 1 - SLACK): min(len(lines), end + SLACK)]))
    if quote in window:
        return True, "ok"
    # Quote exists elsewhere in the file: the line number is wrong, the content is real.
    if quote in norm(" ".join(lines)):
        return False, "quote found in file but not at the cited lines"
    return False, "quote not found in file"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--repo", default=".")
    a = ap.parse_args()
    with open(a.input, encoding="utf-8") as f:
        data = json.load(f)
    lenses = data if isinstance(data, list) else [data]
    cache, results = {}, []
    for lens in lenses:
        for kind in ("findings", "supporting_claims", "abstentions"):
            for item in lens.get(kind, []) or []:
                cits = item.get("citations") or []
                checks = [dict(path=c.get("path"), line=c.get("line"),
                               ok=ok, reason=why)
                          for c in cits for ok, why in [check_citation(a.repo, c, cache)]]
                needs = kind != "abstentions"
                ok = all(x["ok"] for x in checks) and (bool(checks) or not needs)
                results.append(dict(lens=lens.get("lens"), kind=kind, id=item.get("id"),
                                    ok=ok, citations=checks,
                                    reason="no citations" if needs and not checks else None))
    bad = [r for r in results if not r["ok"]]
    out = dict(summary=dict(items=len(results), ok=len(results) - len(bad), failed=len(bad),
                            failed_ids=[r["id"] for r in bad]),
               results=results)
    json.dump(out, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
