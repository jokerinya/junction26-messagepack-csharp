#!/usr/bin/env python3
"""The pull-request side of a trust review: post the card, take the owner's sign-off, keep the ledger.

Used by the GitHub Actions workflows (and usable by hand with a `gh` login):

  pr_flow.py post-card --slug OWNER/REPO --pr N --head SHA --dossier-dir DIR [--run-url URL]
      Posts or updates the single Trust Dossier comment, sets the "Trust sign-off" status on the
      head commit to pending, writes a short summary into the PR description, and appends the
      review to the ledger branch.

  pr_flow.py sign-off --slug OWNER/REPO --pr N --author LOGIN --comment-id ID [--dry-run]
      Handles a "/sign-off ..." comment. The comment text is read from the SIGN_OFF_BODY
      environment variable, never from the command line, because it is untrusted input.

      /sign-off accept [--minutes N] [--overrule "why"] [--risk "what I accept"] [note]
      /sign-off reject [--minutes N] [note]

      Rules, all enforced here:
      - only an assignee of the PR (the named owner) can sign;
      - the card must be for the PR's current head commit;
      - accepting a BLOCK or NOT-FIX recommendation needs --overrule "why".
      On success: the status turns green (accept) or red (reject), the card header shows who
      signed, and the sign-off is appended to the ledger branch.

  pr_flow.py sync-description --slug OWNER/REPO --pr N [--dry-run]
      Rewrites the summary block at the end of the PR description from the card. post-card and
      sign-off do this themselves; this is for repairing a PR by hand.

  pr_flow.py ledger-pull --slug OWNER/REPO --to FILE
      Copies the ledger from the ledger branch to FILE (no file is written when there is none).

The ledger lives as ledger.jsonl on the branch `trust-ledger` of the reviewed repository.
Stdlib only; talks to GitHub through the `gh` CLI.
"""
import argparse
import base64
import datetime as dt
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile

MARKER = "<!-- trust-dossier:v1"
BOT = "github-actions[bot]"
STATUS = "Trust sign-off"
LEDGER_BRANCH = "trust-ledger"
LEDGER_FILE = "ledger.jsonl"
HERE = os.path.dirname(os.path.abspath(__file__))


def gh(method, path, body=None, ok_missing=False):
    cmd = ["gh", "api", "-X", method, path]
    if body is not None:
        cmd += ["--input", "-"]
    r = subprocess.run(cmd, input=json.dumps(body) if body is not None else None,
                       capture_output=True, text=True)
    if r.returncode != 0:
        if ok_missing and "HTTP 404" in (r.stderr + r.stdout):
            return None
        raise RuntimeError("%s %s: %s" % (method, path, (r.stderr or r.stdout).strip()[:400]))
    return json.loads(r.stdout) if r.stdout.strip() else {}


def gh_all(path):
    r = subprocess.run(["gh", "api", "--paginate", path, "--jq", ".[] | @json"], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("GET %s: %s" % (path, r.stderr.strip()[:400]))
    return [json.loads(line) for line in r.stdout.splitlines() if line.strip()]


# ---------- ledger branch ----------

def ledger_read(slug):
    """Returns (text, blob sha) or ("", None) when the branch or the file does not exist."""
    f = gh("GET", "repos/%s/contents/%s?ref=%s" % (slug, LEDGER_FILE, LEDGER_BRANCH), ok_missing=True)
    if not f:
        return "", None
    return base64.b64decode(f["content"]).decode("utf-8"), f["sha"]


def ledger_append(slug, lines, message):
    """Appends the lines that are not in the ledger yet. Retries when another run wrote first."""
    lines = [l for l in lines if l.strip()]
    for _ in range(5):
        text, sha = ledger_read(slug)
        have = set(text.splitlines())
        new = [l for l in lines if l not in have]
        if not new:
            return 0
        content = text + ("" if text.endswith("\n") or not text else "\n") + "\n".join(new) + "\n"
        body = {"message": message, "branch": LEDGER_BRANCH,
                "content": base64.b64encode(content.encode("utf-8")).decode("ascii")}
        try:
            if sha:
                body["sha"] = sha
                gh("PUT", "repos/%s/contents/%s" % (slug, LEDGER_FILE), body)
            elif gh("GET", "repos/%s/git/ref/heads/%s" % (slug, LEDGER_BRANCH), ok_missing=True):
                gh("PUT", "repos/%s/contents/%s" % (slug, LEDGER_FILE), body)
            else:
                # First entry: a branch of its own with no parent, holding only the ledger.
                blob = gh("POST", "repos/%s/git/blobs" % slug, {"content": content, "encoding": "utf-8"})
                tree = gh("POST", "repos/%s/git/trees" % slug, {"tree": [
                    {"path": LEDGER_FILE, "mode": "100644", "type": "blob", "sha": blob["sha"]}]})
                commit = gh("POST", "repos/%s/git/commits" % slug, {"message": message, "tree": tree["sha"], "parents": []})
                gh("POST", "repos/%s/git/refs" % slug, {"ref": "refs/heads/" + LEDGER_BRANCH, "sha": commit["sha"]})
            return len(new)
        except RuntimeError as e:
            if not re.search(r"HTTP (409|422)", str(e)):
                raise
    raise RuntimeError("could not append to the ledger after 5 tries")


# ---------- the card ----------

def find_card(slug, pr):
    """The newest Trust Dossier comment posted by the workflow. Comments by anyone else are ignored,
    so nobody can plant a card with a friendlier outcome."""
    cards = [c for c in gh_all("repos/%s/issues/%s/comments?per_page=100" % (slug, pr))
             if c["user"]["login"] == BOT and c["body"].startswith(MARKER)]
    return cards[-1] if cards else None


def card_fields(body):
    first = body.split("\n", 1)[0]
    return dict(re.findall(r'(\w+)="([^"]*)"', first))


def sign_instructions(outcome):
    if outcome in ("BLOCK", "NOT-FIX"):
        return ("**Sign off:** the named owner comments `/sign-off reject`, or `/sign-off accept --overrule \"why\"` "
                "to overrule this recommendation · The merge stays blocked until then · The AI does not approve. A named human signs.")
    return ("**Sign off:** the named owner comments `/sign-off accept` (or `/sign-off reject`) on this PR · "
            "The merge stays blocked until then · The AI does not approve. A named human signs.")


def set_status(slug, sha, state, description, target_url=None):
    body = {"state": state, "context": STATUS, "description": description[:140]}
    if target_url:
        body["target_url"] = target_url
    gh("POST", "repos/%s/statuses/%s" % (slug, sha), body)


DESC_START = "<!-- trust-review:start -->"
DESC_END = "<!-- trust-review:end -->"


def description_block(card_body, card_url):
    """A short summary of the card for the PR description: verdict, signature, counts, link.
    Everything is read from the card itself, so the two cannot disagree."""
    f = card_fields(card_body)
    lines = card_body.split("\n")
    verdict = next((l for l in lines if l.startswith("**") and "· Owner:" in l), "")
    verdict = verdict.split(" · Owner:")[0].strip()
    signed = next((l for l in lines if l.startswith("**✍️ ")), None)
    cells = []
    for i, l in enumerate(lines):
        if l.startswith("|:-:") and i + 1 < len(lines):
            cells = [c.strip().replace("**", "").replace(" for you", "") for c in lines[i + 1].strip().strip("|").split("|")]
            break
    owner = f.get("owner") or "a named owner"
    out = [DESC_START, "---", "### 🔍 Trust review",
           "%s · review `%s` · commit `%s`" % (verdict or "**%s**" % f.get("outcome", ""), f.get("review", ""), (f.get("head") or "")[:8]),
           "", signed or "⏳ **Unsigned.** Waiting for `%s` to sign. The merge is blocked until then." % owner]
    if len(cells) == 4:
        out += ["", "AI found: %s · AI refused to decide: %s · Owner reads: %s · Residual risk: %s" % tuple(cells)]
    out += ["", "[Full Trust Dossier](%s) · The AI does not approve. A named human signs." % card_url, DESC_END]
    return "\n".join(out)


def update_description(slug, pr, card_body, card_url, dry_run=False):
    """Writes the summary at the end of the PR description, between markers, leaving the author's text alone."""
    body = gh("GET", "repos/%s/pulls/%s" % (slug, pr)).get("body") or ""
    block = description_block(card_body, card_url)
    if DESC_START in body and DESC_END in body:
        new = body[:body.index(DESC_START)] + block + body[body.index(DESC_END) + len(DESC_END):]
    else:
        new = body.rstrip() + "\n\n" + block + "\n"
    if dry_run:
        print("description block:\n" + block)
    elif new != body:
        gh("PATCH", "repos/%s/pulls/%s" % (slug, pr), {"body": new})
        print("description: updated")


def cmd_sync_description(a):
    card = find_card(a.slug, a.pr)
    if not card:
        sys.exit("No Trust Dossier comment on this PR.")
    update_description(a.slug, a.pr, card["body"], card["html_url"], a.dry_run)
    return 0


def cmd_post_card(a):
    with open(os.path.join(a.dossier_dir, "dossier.json"), encoding="utf-8") as f:
        d = json.load(f)
    with open(os.path.join(a.dossier_dir, "pr-comment.md"), encoding="utf-8") as f:
        card = f.read().rstrip("\n")
    outcome = d.get("outcome") or "T1"
    owner = str(d.get("owner") or "").split(" ")[0]
    review_id = d.get("review_id") or ""
    # The sign-off line names the PR comment, not the local slash command.
    card = "\n".join(sign_instructions(outcome) if l.startswith("**Sign off:**") else l for l in card.split("\n"))
    marker = '%s review="%s" head="%s" outcome="%s" owner="%s" -->' % (MARKER, review_id, a.head, outcome, owner)
    body = marker + "\n" + card + "\n"
    if a.run_url:
        body += "\n<sub>Produced by the Earned Trust Review workflow, [this run](%s). Full dossier and evidence: the run's artifacts.</sub>\n" % a.run_url
    if len(body.encode("utf-8")) > 64000:
        sys.exit("The comment is over GitHub's size limit.")

    old = find_card(a.slug, a.pr)
    if old:
        res = gh("PATCH", "repos/%s/issues/comments/%s" % (a.slug, old["id"]), {"body": body})
    else:
        res = gh("POST", "repos/%s/issues/%s/comments" % (a.slug, a.pr), {"body": body})
    print(res.get("html_url"))

    who = owner if owner and owner != "unassigned" else "a named owner (assign the PR)"
    desc = "Waiting for %s to sign" % who
    if outcome in ("BLOCK", "NOT-FIX"):
        desc = "AI recommends %s. Waiting for %s to reject or overrule" % (outcome, who)
    set_status(a.slug, a.head, "pending", desc, res.get("html_url"))
    update_description(a.slug, a.pr, body, res.get("html_url"))

    led = os.path.join(a.dossier_dir, LEDGER_FILE)
    if os.path.isfile(led):
        with open(led, encoding="utf-8") as f:
            n = ledger_append(a.slug, f.read().splitlines(), "Record review %s" % review_id)
        print("ledger: %d new line(s)" % n)


# ---------- sign-off ----------

def parse_command(text):
    """'/sign-off accept --minutes 20 --overrule "why" free note' -> dict, or an error string."""
    text = text.strip()
    if not text.startswith("/sign-off"):
        return "not a sign-off command"
    try:
        words = shlex.split(text[len("/sign-off"):].replace("\r", " ").replace("\n", " "))
    except ValueError:
        return "I could not read the command: check the quotes."
    if not words or words[0] not in ("accept", "reject"):
        return "Say `/sign-off accept` or `/sign-off reject`."
    out = {"decision": words[0], "minutes": None, "overrule": None, "risk": None, "note": []}
    i = 1
    while i < len(words):
        w = words[i]
        if w in ("--minutes", "--overrule", "--risk"):
            if i + 1 >= len(words):
                return "`%s` needs a value." % w
            out[w[2:]] = words[i + 1]
            i += 2
        else:
            out["note"].append(w)
            i += 1
    if out["minutes"] is not None:
        try:
            out["minutes"] = float(out["minutes"])
        except ValueError:
            return "`--minutes` needs a number."
    out["note"] = " ".join(out["note"])[:500] or None
    for k in ("overrule", "risk"):
        if out[k] is not None:
            out[k] = out[k].strip()[:500]
            if not out[k]:
                return "`--%s` needs a reason in quotes." % k
    return out


def cmd_sign_off(a):
    cmd = parse_command(os.environ.get("SIGN_OFF_BODY", ""))

    def say(text):
        print("reply: " + text)
        if not a.dry_run:
            gh("POST", "repos/%s/issues/%s/comments" % (a.slug, a.pr), {"body": text})

    def react(kind):
        print("reaction: " + kind)
        if not a.dry_run and a.comment_id:
            gh("POST", "repos/%s/issues/comments/%s/reactions" % (a.slug, a.comment_id), {"content": kind})

    pr = gh("GET", "repos/%s/pulls/%s" % (a.slug, a.pr))
    owners = [u["login"] for u in pr.get("assignees") or []]
    if a.author not in owners:
        # No reply, so strangers cannot use this to fill the PR with bot comments.
        react("-1")
        print("refused: %s is not an assignee (%s)" % (a.author, ", ".join(owners) or "none"))
        return 0
    if isinstance(cmd, str):
        say("Sign-off not recorded. %s\n\nUsage: `/sign-off accept [--minutes N] [--overrule \"why\"] [--risk \"what I accept\"]` or `/sign-off reject`." % cmd)
        return 0
    card = find_card(a.slug, a.pr)
    if not card:
        say("Sign-off not recorded: this PR has no Trust Dossier yet. Wait for the Earned Trust Review workflow to post one.")
        return 0
    f = card_fields(card["body"])
    head = pr["head"]["sha"]
    if f.get("head") != head:
        say("Sign-off not recorded: the Trust Dossier is for commit `%s`, but the PR is now at `%s`. Wait for the review of the new commit, then sign that one." % ((f.get("head") or "?")[:8], head[:8]))
        return 0
    outcome = f.get("outcome") or "T1"
    overruled = cmd["decision"] == "accept" and outcome in ("BLOCK", "NOT-FIX")
    if overruled and not cmd["overrule"]:
        say("Sign-off not recorded: the review recommends **%s**. You can still accept, but you must say why: `/sign-off accept --overrule \"your reason\"`. Or `/sign-off reject`." % outcome)
        return 0

    review_id = f.get("review") or ""
    conditions = None
    if overruled:
        conditions = "Overrules the AI's %s recommendation: %s" % (outcome, cmd["overrule"])
    elif cmd["note"]:
        conditions = cmd["note"]
    risk = cmd["risk"] or "As listed under 'Residual risk you accept by signing' in the dossier for %s" % head[:8]

    # Record it with the plugin's own ledger code, on a copy of the ledger branch.
    with tempfile.TemporaryDirectory() as tmp:
        os.makedirs(os.path.join(tmp, ".trust-review"))
        path = os.path.join(tmp, ".trust-review", LEDGER_FILE)
        text, _ = ledger_read(a.slug)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        args = [sys.executable, os.path.join(HERE, "trust_ledger.py"), "--repo", tmp, "sign-off", review_id,
                "--owner", a.author, "--decision", cmd["decision"], "--minutes", str(cmd["minutes"] or 0),
                "--residual-risk", risk]
        if conditions:
            args += ["--conditions", conditions]
        r = subprocess.run(args, capture_output=True, text=True)
        if r.returncode != 0:
            say("Sign-off not recorded: the ledger has no review `%s` for this card (%s)." % (review_id, (r.stderr or r.stdout).strip()[:200]))
            return 0
        with open(path, encoding="utf-8") as fh:
            new_lines = fh.read().splitlines()
        if a.dry_run:
            print("ledger line: " + new_lines[-1])
        else:
            ledger_append(a.slug, new_lines, "Sign-off on %s by %s: %s" % (review_id, a.author, cmd["decision"]))

    today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    signed = cmd["decision"] == "accept"
    word = "SIGNED" if signed else "REJECTED"
    line = "**✍️ %s by `%s`** · %s" % ("Signed" if signed else "Rejected", a.author, today)
    if cmd["minutes"]:
        line += " · %g min" % cmd["minutes"]
    if overruled:
        line += " · **Overrules the AI's %s:** %s" % (outcome, cmd["overrule"])
    elif cmd["note"]:
        line += " · %s" % cmd["note"]
    lines = [l for l in card["body"].split("\n") if not l.startswith("**✍️ ")]
    for i, l in enumerate(lines):
        if l.startswith("### ") and "Trust Dossier" in l:
            lines[i] = re.sub(r"· (UNSIGNED|SIGNED by `[^`]*`|REJECTED by `[^`]*`)\s*$", "· %s by `%s`" % (word, a.author), l)
            lines.insert(i + 1, line)
            break
    desc = ("Signed by %s" % a.author) if signed else ("Rejected by %s" % a.author)
    if overruled:
        desc += ", overruling the AI's %s" % outcome
    print("card header: " + line)
    print("status: %s: %s" % ("success" if signed else "failure", desc))
    if not a.dry_run:
        gh("PATCH", "repos/%s/issues/comments/%s" % (a.slug, card["id"]), {"body": "\n".join(lines)})
        update_description(a.slug, a.pr, "\n".join(lines), card.get("html_url"))
        set_status(a.slug, head, "success" if signed else "failure", desc, card.get("html_url"))
    react("+1")
    if cmd["minutes"] is None and not a.dry_run:
        print("note: no --minutes given; recorded as 0")
    return 0


def cmd_ledger_pull(a):
    text, _ = ledger_read(a.slug)
    if not text:
        print("no ledger yet")
        return 0
    os.makedirs(os.path.dirname(os.path.abspath(a.to)), exist_ok=True)
    with open(a.to, "w", encoding="utf-8") as f:
        f.write(text)
    print("ledger: %d line(s)" % len(text.splitlines()))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("post-card")
    s.add_argument("--slug", required=True); s.add_argument("--pr", required=True); s.add_argument("--head", required=True)
    s.add_argument("--dossier-dir", required=True); s.add_argument("--run-url"); s.set_defaults(fn=cmd_post_card)
    s = sub.add_parser("sign-off")
    s.add_argument("--slug", required=True); s.add_argument("--pr", required=True); s.add_argument("--author", required=True)
    s.add_argument("--comment-id"); s.add_argument("--dry-run", action="store_true"); s.set_defaults(fn=cmd_sign_off)
    s = sub.add_parser("sync-description")
    s.add_argument("--slug", required=True); s.add_argument("--pr", required=True)
    s.add_argument("--dry-run", action="store_true"); s.set_defaults(fn=cmd_sync_description)
    s = sub.add_parser("ledger-pull")
    s.add_argument("--slug", required=True); s.add_argument("--to", required=True); s.set_defaults(fn=cmd_ledger_pull)
    a = ap.parse_args()
    return a.fn(a) or 0


if __name__ == "__main__":
    sys.exit(main())
