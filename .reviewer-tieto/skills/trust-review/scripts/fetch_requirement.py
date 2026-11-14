#!/usr/bin/env python3
"""Fetch a GitHub issue as a requirement, with provenance for every part.

Usage: fetch_requirement.py --issue N [--repo-slug owner/name | --repo PATH] --out-dir DIR

Writes:
  DIR/requirement.md    the text, split into BINDING and NON-BINDING sections
  DIR/requirement.json  {issue, title, url, parts:[{source, author, association, binding, text}],
                         reported_versions:[...], regression: bool}

Provenance rules (mechanical, so two runs cannot read the same issue differently):
  - the issue body is binding (source "issue-body");
  - comments by OWNER / MEMBER / COLLABORATOR are binding (source "maintainer");
  - every other comment is NON-BINDING (source "other"): it may raise questions, never blocking criteria.
Needs `gh` (read only). Stdlib only.
"""
import argparse
import json
import os
import re
import subprocess
import sys

BINDING_ASSOC = {"OWNER", "MEMBER", "COLLABORATOR"}
VERSION_RX = re.compile(r"\bv?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\b")
REGRESSION_RX = re.compile(r"(?i)\b(since (version )?v?\d|regress|no longer works|stopped working|still worked in|used to work|worked in v?\d)")


def gh(*args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"gh failed: {r.stderr.strip()}")
    return r.stdout


def slug_from_repo(repo):
    url = subprocess.run(["git", "-C", repo, "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
    m = re.search(r"github\.com[:/]([^/]+/[^/.]+)", url)
    if not m:
        sys.exit("cannot infer owner/name from origin; pass --repo-slug")
    return m.group(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--issue", required=True)
    ap.add_argument("--repo-slug")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--out-dir", required=True)
    a = ap.parse_args()
    slug = a.repo_slug or slug_from_repo(a.repo)
    num = a.issue.lstrip("#")
    issue = json.loads(gh("api", f"repos/{slug}/issues/{num}"))
    comments = json.loads(gh("api", "--paginate", f"repos/{slug}/issues/{num}/comments"))

    parts = [{"source": "issue-body", "author": issue["user"]["login"],
              "association": issue.get("author_association"), "binding": True,
              "text": issue.get("body") or ""}]
    for c in comments:
        assoc = c.get("author_association", "NONE")
        parts.append({"source": "maintainer" if assoc in BINDING_ASSOC else "other",
                      "author": c["user"]["login"], "association": assoc,
                      "binding": assoc in BINDING_ASSOC, "text": c.get("body") or ""})

    body = (issue.get("title") or "") + "\n" + (issue.get("body") or "")
    versions = sorted(set(VERSION_RX.findall(body)))
    regression = bool(REGRESSION_RX.search(body))
    req = {"issue": f"{slug}#{num}", "title": issue.get("title"), "url": issue.get("html_url"),
           "state": issue.get("state"), "labels": [l["name"] for l in issue.get("labels", [])],
           "reported_versions": versions, "regression": regression, "parts": parts}

    os.makedirs(a.out_dir, exist_ok=True)
    with open(os.path.join(a.out_dir, "requirement.json"), "w", encoding="utf-8") as f:
        json.dump(req, f, indent=2, ensure_ascii=False)
    with open(os.path.join(a.out_dir, "requirement.md"), "w", encoding="utf-8") as f:
        f.write(f"# {req['issue']} · {req['title']}\n\n{req['url']}\n\n")
        if regression or versions:
            f.write(f"**Reported context:** versions mentioned {versions or 'none'}; "
                    f"regression wording {'yes' if regression else 'no'}.\n\n")
        f.write("## BINDING (issue body and maintainer comments)\n\n")
        for p in parts:
            if p["binding"]:
                f.write(f"### {p['source']} · @{p['author']} ({p['association']})\n\n{p['text'].strip()}\n\n")
        f.write("## NON-BINDING (other commenters: questions and proposals, never blocking criteria)\n\n")
        others = [p for p in parts if not p["binding"]]
        if not others:
            f.write("_none_\n")
        for p in others:
            f.write(f"### @{p['author']} ({p['association']})\n\n{p['text'].strip()}\n\n")
    print(json.dumps({"issue": req["issue"], "binding_parts": sum(p["binding"] for p in parts),
                      "non_binding_parts": sum(not p["binding"] for p in parts),
                      "reported_versions": versions, "regression": regression}))


if __name__ == "__main__":
    main()
