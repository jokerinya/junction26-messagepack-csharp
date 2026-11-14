#!/usr/bin/env python3
"""Find the repo profile for a repository. Prints JSON: {"profile_dir": path or null, "id": ..., "source": ...}.

Order: <repo>/.trust-review/profile/ (the team's own) > a bundled profile whose `match` hits > none.
A bundled profile matches when any `remote_contains` string is in a git remote URL, or all `files_exist` exist.
Usage: resolve_profile.py --repo PATH
"""
import argparse, glob, json, os, subprocess, sys

PROFILES = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "profiles"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    a = ap.parse_args()
    own = os.path.join(a.repo, ".trust-review", "profile")
    if os.path.isfile(os.path.join(own, "profile.json")):
        p = json.load(open(os.path.join(own, "profile.json")))
        return print(json.dumps({"profile_dir": os.path.abspath(own), "id": p.get("id"), "source": "repo"}))
    remotes = subprocess.run(["git", "-C", a.repo, "remote", "-v"], capture_output=True, text=True).stdout.lower()
    for pj in sorted(glob.glob(os.path.join(PROFILES, "*", "profile.json"))):
        p = json.load(open(pj))
        m = p.get("match", {})
        by_remote = any(s.lower() in remotes for s in m.get("remote_contains", []))
        files = m.get("files_exist", [])
        by_files = bool(files) and all(os.path.exists(os.path.join(a.repo, f)) for f in files)
        if by_remote or by_files:
            how = "remote" if by_remote else "files"
            return print(json.dumps({"profile_dir": os.path.dirname(pj), "id": p.get("id"), "source": f"bundled ({how} match)"}))
    print(json.dumps({"profile_dir": None, "id": None, "source": "none: generic core policy and lenses only"}))


if __name__ == "__main__":
    main()
