#!/usr/bin/env python3
"""Validate and normalise lens output against the evidence-protocol contract, in code.

Usage: validate_lens_output.py <lens.json> [<lens.json> ...] [--criteria criteria.json] [--write]

Checks each lens JSON and, with --write, rewrites it normalised in place. Prints a JSON report of
every violation, so the dossier can list them. Rules:
  - verdict must be allowed for the lens (blocking lenses: pass/needs_fixes; verifiability: advisory);
    a wrong verdict becomes needs_fixes if the lens has a blocking finding, else pass (or advisory);
  - required keys exist (missing lists become []);
  - ids carry the lens prefix; severity is blocking|note; evidence_class is E1/E2/E3;
  - a blocking finding with E3 evidence becomes an abstention ("suspected, not proven");
  - a blocking finding on a NON-BINDING criterion (criteria.json binding=false) becomes a note,
    plus an abstention for the owner: other people's proposals never block;
  - findings and supporting claims without citations are flagged (check_citations.py decides).
Stdlib only.
"""
import argparse
import json
import sys

PREFIX = {"intent": "INT", "correctness": "COR", "security": "SEC", "compatibility": "CMP",
          "documentation": "DOC", "verifiability": "VER", "followup": "FUP"}
VERDICTS = {"verifiability": {"advisory"}, "followup": {"pass", "needs_fixes", "escalate"}}
DEFAULT_VERDICTS = {"pass", "needs_fixes"}
EVIDENCE = {"E1-executed", "E2-traced", "E3-inferred"}
LISTS = ["checked", "not_checked", "findings", "supporting_claims", "abstentions"]


def crit_ids(ref):
    """'R2', 'R2 (derived: ...)', 'R1, R3' -> ['R2'] / ['R1', 'R3']."""
    import re
    return re.findall(r"\bR\d+\b", str(ref or ""))


def validate(lens, criteria):
    v = []
    name = lens.get("lens", "?")
    for k in LISTS:
        if not isinstance(lens.get(k), list):
            v.append(f"{name}: missing list '{k}' (set to [])")
            lens[k] = []
    pre = PREFIX.get(name)
    for kind in ("findings", "supporting_claims", "abstentions"):
        fixed = []
        for n, it in enumerate(lens[kind], 1):
            if not isinstance(it, dict):
                v.append(f"{name}: {kind}[{n}] is {type(it).__name__}, not an object (wrapped)")
                it = {"id": f"{pre or 'X'}-{kind[:1].upper()}{n}?", "claim": str(it), "question": str(it),
                      "severity": "note", "evidence_class": "E3-inferred", "citations": []}
            fixed.append(it)
        lens[kind] = fixed
        for it in lens[kind]:
            if pre and not str(it.get("id", "")).startswith(pre):
                v.append(f"{name}: id {it.get('id')} lacks prefix {pre}")
            if kind != "abstentions" and not it.get("citations"):
                v.append(f"{name}: {it.get('id')} has no citations")
            ev = it.get("evidence_class")
            if kind != "abstentions" and ev not in EVIDENCE:
                v.append(f"{name}: {it.get('id')} evidence_class {ev!r} invalid (set to E3-inferred)")
                it["evidence_class"] = "E3-inferred"
    keep = []
    for f in lens["findings"]:
        if f.get("severity") not in ("blocking", "note"):
            v.append(f"{name}: {f.get('id')} severity {f.get('severity')!r} invalid (set to note)")
            f["severity"] = "note"
        if f["severity"] == "blocking" and f.get("evidence_class") == "E3-inferred":
            v.append(f"{name}: {f.get('id')} blocking on E3 evidence -> abstention")
            lens["abstentions"].append({"id": f["id"] + "-A", "requirement": f.get("requirement"),
                                        "question": f"Suspected, not proven: {f.get('title')}",
                                        "why_not_decided": "Blocking needs at least E2-traced evidence.",
                                        "evidence_needed": f.get("fix") or "a trace or a test",
                                        "decider": "owner", "citations": f.get("citations", [])})
            continue
        nb = [r for r in crit_ids(f.get("requirement")) if criteria.get(r) is False]
        if f["severity"] == "blocking" and nb and len(nb) == len(crit_ids(f.get("requirement"))):
            v.append(f"{name}: {f.get('id')} blocking on non-binding criterion {nb} -> note + abstention")
            f["severity"] = "note"
            lens["abstentions"].append({"id": f["id"] + "-A", "requirement": ",".join(nb),
                                        "question": f"Adopt non-binding criterion {','.join(nb)} as a merge requirement? ({f.get('title')})",
                                        "why_not_decided": "The criterion comes from a non-maintainer comment, not from the issue body or a maintainer.",
                                        "evidence_needed": "Maintainer confirmation of the criterion.",
                                        "decider": "api-owner", "citations": f.get("citations", [])})
        keep.append(f)
    lens["findings"] = keep
    allowed = VERDICTS.get(name, DEFAULT_VERDICTS)
    has_block = any(f["severity"] == "blocking" for f in lens["findings"])
    want = ("needs_fixes" if has_block else "pass") if allowed == DEFAULT_VERDICTS else lens.get("verdict")
    if lens.get("verdict") not in allowed:
        new = "advisory" if allowed == {"advisory"} else ("needs_fixes" if has_block else "pass")
        v.append(f"{name}: verdict {lens.get('verdict')!r} not allowed -> {new}")
        lens["verdict"] = new
    elif allowed == DEFAULT_VERDICTS and lens["verdict"] != want:
        v.append(f"{name}: verdict {lens['verdict']!r} inconsistent with findings -> {want}")
        lens["verdict"] = want
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--criteria", help="criteria.json from the orchestrator ({'R1': true, ...} or list)")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    criteria = {}
    if a.criteria:
        c = json.load(open(a.criteria, encoding="utf-8"))
        items = c.get("criteria", c) if isinstance(c, dict) else c
        if isinstance(items, dict):
            criteria = {k: (v if isinstance(v, bool) else v.get("binding") is True) for k, v in items.items()}
        else:
            criteria = {x["id"]: x.get("binding") is not False for x in items}
    report = {}
    for path in a.files:
        data = json.load(open(path, encoding="utf-8"))
        lenses = data if isinstance(data, list) else [data]
        report[path] = [msg for lens in lenses for msg in validate(lens, criteria)]
        if a.write:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=1, ensure_ascii=False)
    total = sum(len(x) for x in report.values())
    json.dump({"violations": total, "by_file": report}, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
