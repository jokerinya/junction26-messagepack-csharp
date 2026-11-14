#!/usr/bin/env python3
"""Explainable risk triage for a change: every tier comes with the rules that set it.

Usage:
  risk_triage.py --repo PATH --base MERGE_BASE [--profile DIR | --policy FILE] [--area-trust FILE]

Policy: --policy, else <profile>/policy.json, else the generic core policy next to this script.

Reads `git diff <merge-base>` (working tree, including untracked files), maps each
file to a policy area, applies content rules to added lines, adjusts by per-area
trust (from trust_ledger.py area-trust), and prints JSON. Stdlib only, read only.
"""
import argparse
import json
import os
import re
import subprocess
import sys

RISK_ORDER = ["low", "medium", "high"]
TIER_ORDER = ["T0", "T1", "T2"]
HERE = os.path.dirname(os.path.abspath(__file__))


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True,
                          check=True).stdout


def glob_re(glob):
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out += "(?:.*/)?"; i += 3
        elif glob.startswith("**", i):
            out += ".*"; i += 2
        elif glob[i] == "*":
            out += "[^/]*"; i += 1
        elif glob[i] == "?":
            out += "[^/]"; i += 1
        else:
            out += re.escape(glob[i]); i += 1
    return re.compile("^" + out + "$")


def matches(path, globs):
    return any(glob_re(g).match(path) for g in globs)


def max_of(order, a, b):
    return a if order.index(a) >= order.index(b) else b


def parse_diff(text):
    """Return {path: {"added": [(lineno, text)], "hunks": [(start, len)], "deleted": bool}}."""
    files, cur, new_line = {}, None, 0
    old_path = None
    for line in text.splitlines():
        if line.startswith("--- "):
            old_path = line[6:] if line.startswith("--- a/") else None
        elif line.startswith("+++ "):
            if line.startswith("+++ b/"):
                cur = line[6:]
                files.setdefault(cur, {"added": [], "hunks": [], "deleted": False})
            else:  # deleted file
                cur = old_path
                if cur:
                    files.setdefault(cur, {"added": [], "hunks": [], "deleted": True})
        elif line.startswith("@@") and cur:
            m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", line)
            if m:
                new_line = int(m.group(1))
                files[cur]["hunks"].append((new_line, int(m.group(2) or 1)))
        elif cur and line.startswith("+") and not line.startswith("+++"):
            files[cur]["added"].append((new_line, line[1:]))
            new_line += 1
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--base", required=True, help="merge-base commit")
    ap.add_argument("--policy")
    ap.add_argument("--profile", help="repo profile directory (from resolve_profile.py)")
    ap.add_argument("--area-trust", help="JSON from trust_ledger.py area-trust")
    a = ap.parse_args()

    policy_path = a.policy or (os.path.join(a.profile, "policy.json")
                               if a.profile and os.path.isfile(os.path.join(a.profile, "policy.json"))
                               else os.path.join(HERE, "..", "policy.json"))
    with open(policy_path, encoding="utf-8") as f:
        policy = json.load(f)
    trust = {}
    if a.area_trust and os.path.isfile(a.area_trust):
        with open(a.area_trust, encoding="utf-8") as f:
            trust = json.load(f).get("areas", {})

    numstat = {}
    for row in git(a.repo, "diff", "--numstat", a.base).splitlines():
        add, dele, path = row.split("\t", 2)
        if " => " in path:  # rename: keep the new path
            path = re.sub(r"\{([^}]*) => ([^}]*)\}", r"\2", path).split(" => ")[-1]
        numstat[path] = (0 if add == "-" else int(add), 0 if dele == "-" else int(dele))
    diff = parse_diff(git(a.repo, "diff", "-U0", "--no-color", "--no-ext-diff", a.base))

    for path in git(a.repo, "ls-files", "--others", "--exclude-standard").splitlines():
        full = os.path.join(a.repo, path)
        try:
            with open(full, encoding="utf-8", errors="replace") as f:
                lines = f.read().splitlines()
        except OSError:
            continue
        diff[path] = {"added": list(enumerate(lines, 1)), "hunks": [(1, len(lines))],
                      "deleted": False, "untracked": True}
        numstat[path] = (len(lines), 0)

    # The review's own output is never part of the change under review.
    for d in (numstat, diff):
        for k in [k for k in d if k.startswith(".trust-review/")]:
            del d[k]
    changed = set(numstat) | set(diff)
    files, notes = [], []
    for path in sorted(changed):
        d = diff.get(path, {"added": [], "hunks": [], "deleted": False})
        adds, dels = numstat.get(path, (len(d["added"]), 0))
        area = next(ar for ar in policy["areas"] if matches(path, ar["globs"]))
        risk, reasons = area["base_risk"], [{"rule": f"area:{area['id']}", "risk": area["base_risk"],
                                              "why": area["why"]}]
        for rule in policy.get("content_rules", []):
            if rule.get("only_in") and not matches(path, rule["only_in"]):
                continue
            rx = re.compile(rule["pattern"])
            hits = [n for n, text in d["added"] if rx.search(text)]
            if hits:
                risk = max_of(RISK_ORDER, risk, rule["raise_to"])
                reasons.append({"rule": rule["id"], "risk": rule["raise_to"], "why": rule["why"],
                                "lines": hits[:10]})
        tier = policy["tiers"][risk]
        t = trust.get(area["id"], {})
        state = t.get("state", "neutral")
        if state == "withdrawn":
            tier = TIER_ORDER[min(TIER_ORDER.index(tier) + 1, 2)]
            reasons.append({"rule": "trust:withdrawn", "why": t.get("reason", "recent escape in this area")})
        elif state == "earned":
            floor = policy.get("area_trust", {}).get("earned_never_below", {}).get(risk, "T0")
            lowered = TIER_ORDER[max(TIER_ORDER.index(tier) - 1, 0)]
            tier = max_of(TIER_ORDER, lowered, floor)
            reasons.append({"rule": "trust:earned", "why": t.get("reason", "track record in this area")})
        files.append({"path": path, "area": area["id"], "adds": adds, "dels": dels,
                      "deleted": d.get("deleted", False), "untracked": d.get("untracked", False),
                      "risk": risk, "tier": tier, "trust_state": state, "reasons": reasons,
                      "hunks": [f"{path}:{s}-{s + max(n, 1) - 1}" for s, n in d["hunks"] if n]})

    # Generated-file pairs from the policy (e.g. a template and its generated output) must change together.
    for pair in policy.get("generated_pairs", []):
        exts = {pair["source_ext"]: pair["generated_ext"], pair["generated_ext"]: pair["source_ext"]}
        for f in files:
            stem, ext = os.path.splitext(f["path"])
            if ext not in exts:
                continue
            twin = stem + exts[ext]
            if os.path.isfile(os.path.join(a.repo, twin)) and twin not in changed:
                notes.append(f"{f['path']} changed but its pair {twin} did not: {pair.get('why', 'generated pair out of sync')}")

    # Review units: group by area, split by size.
    lim = policy.get("size_limits", {})
    max_lines, max_files = lim.get("max_lines_per_unit", 400), lim.get("max_files_per_unit", 15)
    units = []
    for area_id in dict.fromkeys(f["area"] for f in files):
        cur = None
        for f in [x for x in files if x["area"] == area_id]:
            size = f["adds"] + f["dels"]
            if not cur or len(cur["files"]) >= max_files or (cur["lines"] + size > max_lines and cur["files"]):
                cur = {"id": f"U{len(units) + 1}", "area": area_id, "files": [], "lines": 0, "tier": "T0"}
                units.append(cur)
            cur["files"].append(f["path"]); cur["lines"] += size
            cur["tier"] = max_of(TIER_ORDER, cur["tier"], f["tier"])

    total = sum(f["adds"] + f["dels"] for f in files)
    overall = "T0"
    for f in files:
        overall = max_of(TIER_ORDER, overall, f["tier"])
    areas = {}
    for f in files:
        s = areas.setdefault(f["area"], {"files": 0, "lines": 0, "tier": "T0", "trust_state": f["trust_state"]})
        s["files"] += 1; s["lines"] += f["adds"] + f["dels"]
        s["tier"] = max_of(TIER_ORDER, s["tier"], f["tier"])

    json.dump({"policy": os.path.relpath(policy_path), "base": a.base,
               "head": git(a.repo, "rev-parse", "HEAD").strip(),
               "totals": {"files": len(files), "lines": total},
               "overall_tier": overall, "tier_meaning": policy.get("tier_meaning", {}),
               "areas": areas, "review_units": units, "files": files, "notes": notes},
              sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
