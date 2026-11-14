#!/usr/bin/env python3
"""Import a recorded review-map run as executed evidence for a trust review.

review-map (the `review-map/` folder of this marketplace repo) runs a change on real inputs and on the repo's own tests,
before and after the change, in a job that holds no secrets. This script turns one of its output
directories into `executed-evidence.json` and a short `executed-evidence.md` for the lenses and
the verifier.

It imports only what review-map's scripts measured: test outcomes on both sides, which new tests
fail without the change, which changed lines ran, the per-hunk removal runs, the known-break run,
the reduced-confidence notes, and the findings and not-checked items the scripts computed. The
review-map agent's own summary, claims and decisions are NOT imported: judgment is the lenses' job.
The pipeline diagram is the one exception. It is agent-drawn, is carried only as a picture, and is
labelled as such.

The evidence is accepted only when it was recorded on the commit under review. Otherwise the
status is `stale`, nothing is imported, and the orchestrator lists it under "not checked".

  import_review_map.py --dir RUN_DIR --head SHA [--merge-base SHA] --out DIR

Exit codes: 0 imported, 2 stale or unusable (a JSON with the reason is still written), 1 usage.
Stdlib only.
"""
import argparse
import hashlib
import json
import os
import sys


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def same_commit(a, b):
    """True when one sha is a prefix of the other (short vs. full), with at least 7 characters."""
    if not a or not b:
        return False
    a, b = a.lower(), b.lower()
    n = min(len(a), len(b))
    return n >= 7 and a[:n] == b[:n]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def short(name):
    """Test names are long; keep the method."""
    return name.split(".")[-1]


def mermaid(nodes, edges):
    if not nodes:
        return None

    def esc(s):
        return (s or "").replace('"', "#quot;")

    out = ["flowchart LR"]
    for n in nodes:
        label = "<b>%s</b>" % esc(n.get("label"))
        if n.get("sub"):
            label += "<br/>" + esc(n["sub"])
        out.append('  %s["%s"]:::%s' % (n["id"], label, n.get("status") or "same"))
    for e in edges or []:
        arrow = "-.->" if e.get("changed") else "-->"
        if e.get("label"):
            out.append('  %s %s|"%s"| %s' % (e["from"], arrow, esc(e["label"]), e["to"]))
        else:
            out.append("  %s %s %s" % (e["from"], arrow, e["to"]))
    out += [
        "  classDef changed fill:#FAEEDA,stroke:#BA7517,stroke-width:2px,color:#412402",
        "  classDef affected fill:#E1F5EE,stroke:#0F6E56,color:#04342C",
        "  classDef same fill:#F1EFE8,stroke:#888780,color:#2C2C2A",
    ]
    return "\n".join(out)


def build(run_dir, head, merge_base):
    analysis = load(os.path.join(run_dir, "analysis.json"))
    context = load(os.path.join(run_dir, "context.json")) or {}
    if analysis is None:
        return {"source": "review-map", "status": "unusable",
                "reason": "no readable analysis.json in %s" % run_dir}

    pr = analysis.get("pr") or {}
    recorded_head = context.get("head") or pr.get("head")
    if not same_commit(recorded_head, head):
        return {"source": "review-map", "status": "stale",
                "reason": "the run was recorded on %s, the review is of %s" % (recorded_head, head),
                "recorded_head": recorded_head, "review_head": head}
    recorded_base = context.get("mergeBase") or pr.get("base")
    base_note = None
    if merge_base and recorded_base and not same_commit(recorded_base, merge_base):
        base_note = ("the run compared against %s, the review against %s: before-side results "
                     "describe a different base" % (recorded_base, merge_base))

    t = analysis.get("tests") or {}
    new_tests = t.get("newTests") or []
    proving = [short(x["name"]) for x in new_tests if x.get("before") == "Failed" and x.get("after") == "Passed"]
    not_proving = [short(x["name"]) for x in new_tests if x.get("before") == "Passed" and x.get("after") == "Passed"]
    cov = t.get("coverage") or {}
    abl = t.get("ablation") or {}
    mut = t.get("mutation") or {}
    before, after = t.get("before") or {}, t.get("after") or {}

    claims = []

    def claim(cid, text):
        claims.append({"id": cid, "text": text, "evidence_class": "E1-executed", "by": "review-map script"})

    if after.get("built") and after.get("total") is not None:
        text = "Tests after the change: %s of %s pass (%s)." % (after.get("passed"), after.get("total"), t.get("project"))
        if before.get("built") and before.get("total") is not None:
            text += " Before: %s of %s pass (%s)." % (before.get("passed"), before.get("total"),
                                                     before.get("mode") or "base commit")
        claim("EX-TESTS", text)
    if new_tests:
        text = "%d of %d new tests fail without the change, so they prove it" % (len(proving), len(new_tests))
        if proving:
            text += ": " + ", ".join(proving)
        text += "."
        if not_proving:
            text += " %d pass without it too, so they prove nothing about this change: %s." % (
                len(not_proving), ", ".join(not_proving))
        claim("EX-PROOF", text)
    if cov.get("measured"):
        def span(u):
            # review-map records an unreached stretch as [first, last]; older runs as one number.
            if isinstance(u, (list, tuple)) and u:
                return str(u[0]) if u[0] == u[-1] else "%s-%s" % (u[0], u[-1])
            return str(u)

        unreached = ["%s:%s" % (f["path"], ",".join(span(u) for u in f["unreached"]))
                     for f in cov.get("files") or [] if f.get("unreached")]
        text = "%s of %s executable changed lines ran (%s by chosen inputs, %s by tests)." % (
            cov.get("reached"), cov.get("executable"), cov.get("byProbe"), cov.get("byTests"))
        if unreached:
            text += " Not reached: " + "; ".join(unreached) + "."
        claim("EX-COVERAGE", text)
    if abl.get("ran"):
        claim("EX-PARTS", "The change was rebuilt %s times, each with one part removed (%d parts), and every "
                          "chosen input was run through each build." % (abl.get("runs"), len(abl.get("groups") or [])))
    if mut.get("applied"):
        claim("EX-KNOWN-BREAK", "A known break was planted to test the inputs (%s). The run with it: %s." % (
            mut.get("description"), mut.get("probe")))

    ev_dir = os.path.join(run_dir, (analysis.get("traces") or {}).get("evidence") or "evidence")
    prints = {}
    if os.path.isdir(ev_dir):
        for name in sorted(os.listdir(ev_dir)):
            p = os.path.join(ev_dir, name)
            if os.path.isfile(p) and name.endswith(".json"):
                prints[name] = sha256(p)

    repro = analysis.get("reproduction") or {}
    nodes, edges = analysis.get("nodes") or [], analysis.get("edges") or []
    return {
        "source": "review-map",
        "status": "imported",
        "run_dir": os.path.abspath(run_dir),
        "adapter": context.get("adapter") or (analysis.get("traces") or {}).get("adapter"),
        "generated_by": pr.get("generatedBy"),
        "recorded_head": recorded_head,
        "recorded_merge_base": recorded_base,
        "base_note": base_note,
        "environment": {"sdk": t.get("sdk"), "pinned_sdk": t.get("pinnedSdk"),
                        "pin_overridden": t.get("rollForwardSdk"), "runner": t.get("runner")},
        "reduced_confidence": analysis.get("confidence") or [],
        "claims": claims,
        "tests": {"project": t.get("project"), "before": before, "after": after,
                  "changed": t.get("changes") or [],
                  "new_tests_proving": proving, "new_tests_not_proving": not_proving},
        "coverage": cov or {"measured": False},
        "parts": {"ran": bool(abl.get("ran")), "runs": abl.get("runs"),
                  "hunks": [{k: h.get(k) for k in ("id", "file", "label", "newStart", "newCount")}
                            for h in abl.get("hunks") or []],
                  "groups": abl.get("groups") or []},
        "known_break": mut or {"applied": False},
        "reproduction": {"status": repro.get("status")} if repro else None,
        "inputs": [{"id": c.get("id"), "title": c.get("title")}
                   for c in (analysis.get("traces") or {}).get("cases") or []],
        "computed_findings": [{"severity": f.get("severity"), "statement": f.get("statement")}
                              for f in analysis.get("found") or [] if f.get("computed")],
        "computed_not_checked": [{k: n.get(k) for k in ("item", "reason", "riskIfWrong", "howToCheck")}
                                 for n in analysis.get("notChecked") or [] if n.get("computed")],
        "pipeline": {"authored_by": "review-map agent (a picture, not evidence)",
                     "nodes": nodes, "edges": edges, "mermaid": mermaid(nodes, edges)} if nodes else None,
        "fingerprints_sha256": prints,
    }


def digest(ev):
    if ev["status"] != "imported":
        return "# Executed evidence (review-map)\n\nNot imported: %s.\n" % ev["reason"]
    lines = ["# Executed evidence (review-map)", "",
             "Recorded by review-map's scripts on commit `%s`, adapter `%s`. These are measured facts, "
             "class E1-executed. Cite them by id. Do not re-run what they already show." % (
                 (ev["recorded_head"] or "")[:8], ev["adapter"]), ""]
    for note in ev["reduced_confidence"]:
        lines.append("> Reduced confidence: %s" % note)
    if ev["base_note"]:
        lines.append("> Base mismatch: %s" % ev["base_note"])
    if ev["reduced_confidence"] or ev["base_note"]:
        lines.append("")
    lines += ["## Measured"] + ["- **%s** %s" % (c["id"], c["text"]) for c in ev["claims"]]
    if ev["tests"]["changed"]:
        lines += ["", "## Tests whose outcome changed"] + [
            "- %s: %s → %s" % (short(c["name"]), c["before"], c["after"]) for c in ev["tests"]["changed"]]
    if ev["computed_findings"]:
        lines += ["", "## Findings the scripts computed"] + [
            "- %s: %s" % (f["severity"], f["statement"]) for f in ev["computed_findings"]]
    if ev["computed_not_checked"]:
        lines += ["", "## Not shown by any run"] + [
            "- %s: %s" % (n["item"], n["reason"]) for n in ev["computed_not_checked"]]
    if ev["reproduction"]:
        lines += ["", "## Issue reproduction", "- status: %s" % ev["reproduction"]["status"]]
    if ev["inputs"]:
        lines += ["", "## Inputs that were run (chosen by review-map's agent, results recorded by script)"] + [
            "- `%s` %s" % (i["id"], i["title"] or "") for i in ev["inputs"]]
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", required=True, help="a review-map output directory (holds analysis.json)")
    ap.add_argument("--head", required=True, help="the commit under review")
    ap.add_argument("--merge-base", help="the review's merge base, to flag a different before side")
    ap.add_argument("--out", required=True, help="the review's output directory")
    a = ap.parse_args()

    ev = build(a.dir, a.head, a.merge_base)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "executed-evidence.json"), "w", encoding="utf-8") as f:
        json.dump(ev, f, indent=2, ensure_ascii=False)
        f.write("\n")
    with open(os.path.join(a.out, "executed-evidence.md"), "w", encoding="utf-8") as f:
        f.write(digest(ev))
    if ev["status"] != "imported":
        print("review-map evidence %s: %s" % (ev["status"], ev["reason"]))
        return 2
    print("review-map evidence imported: %d measured claims, %d computed findings, %d not-checked items, "
          "%d evidence files fingerprinted" % (len(ev["claims"]), len(ev["computed_findings"]),
                                               len(ev["computed_not_checked"]), len(ev["fingerprints_sha256"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
