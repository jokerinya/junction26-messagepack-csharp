#!/usr/bin/env python3
"""Append-only trust ledger: reviews, human sign-offs, and outcomes (reverts, incidents, escapes).

The ledger lives at <repo>/.trust-review/ledger.jsonl and is meant to be committed:
it is the team's track record, and the only input for earned per-area trust.

  trust_ledger.py --repo R record-review DOSSIER_JSON
  trust_ledger.py --repo R sign-off REVIEW_ID --owner NAME --decision accept|accept-with-conditions|reject|send-back
        --minutes N [--read-units U1,U2] [--accepted COR-1,..] [--rejected SEC-2,..]
        [--spot-check ID:agree|ID:disagree] [--missed "text" ...] [--residual-risk TEXT]
        [--conditions TEXT] [--cosigner NAME]
  trust_ledger.py --repo R outcome REVIEW_ID --kind revert|incident|escape|bug --area AREA [--note TEXT] [--found-by NAME]
  trust_ledger.py --repo R area-trust [--policy FILE]
  trust_ledger.py --repo R metrics [--json]
  trust_ledger.py --repo R seed-demo     # synthetic history for demos, every event marked synthetic

Stdlib only.
"""
import argparse
import datetime as dt
import json
import os
import random
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_POLICY = os.path.normpath(os.path.join(HERE, "..", "..", "risk-triage", "policy.json"))
ROUTED = {"T1", "T2", "BLOCK"}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def ledger_path(repo):
    return os.path.join(repo, ".trust-review", "ledger.jsonl")


def load(repo):
    p = ledger_path(repo)
    if not os.path.isfile(p):
        return []
    with open(p, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def append(repo, event):
    p = ledger_path(repo)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
    print(json.dumps(event, indent=2, ensure_ascii=False))


def csv(s):
    return [x.strip() for x in (s or "").split(",") if x.strip()]


def parse_ts(s):
    return dt.datetime.fromisoformat(s)


OUTCOMES = ["T0", "T1", "T2", "BLOCK", "NOT-FIX"]


def outcome_of(text):
    """Best-effort outcome from a free-text recommendation (older dossiers have no `outcome`)."""
    t = (text if isinstance(text, str) else json.dumps(text or "")).upper()
    for o in ("NOT-FIX", "BLOCK", "T2", "T1", "T0"):
        if o in t:
            return o
    if "DO NOT MERGE" in t:
        return "BLOCK"
    return None


# ---------- commands ----------

def cmd_record_review(a):
    with open(a.dossier, encoding="utf-8") as f:
        d = json.load(f)
    items = d.get("findings", [])
    append(a.repo, {
        "type": "review", "ts": now(), "review_id": d["review_id"],
        "requirement": d.get("requirement", {}).get("id") if isinstance(d.get("requirement"), dict) else d.get("requirement"),
        "head": d.get("head"), "owner": d.get("owner"), "recommendation": d.get("recommendation"),
        "outcome": d.get("outcome") or outcome_of(d.get("recommendation")),
        "plugin_commit": d.get("plugin_commit") or (d.get("profile") or {}).get("plugin_commit") if isinstance(d.get("profile"), dict) else d.get("plugin_commit"),
        "units": [{"id": u.get("id"), "area": u.get("area"), "tier": u.get("tier"), "lines": u.get("lines")}
                  for u in d.get("units", [])],
        "findings": [{"id": x.get("id"), "lens": x.get("lens") or x.get("id", "").split("-")[0],
                      "severity": x.get("severity"), "status": x.get("verifier_status") or x.get("status")}
                     for x in items],
        "abstentions": [x.get("id") for x in d.get("abstentions", [])],
    })


def cmd_sign_off(a):
    reviews = {e["review_id"]: e for e in load(a.repo) if e["type"] == "review"}
    if a.review_id not in reviews:
        sys.exit(f"Unknown review id {a.review_id}. Run trust-review first.")
    spot = None
    if a.spot_check:
        cid, _, res = a.spot_check.partition(":")
        spot = {"claim_id": cid, "result": res or "agree"}
    append(a.repo, {
        "type": "signoff", "ts": now(), "review_id": a.review_id, "owner": a.owner,
        "decision": a.decision, "minutes": a.minutes, "read_units": csv(a.read_units),
        "findings_accepted": csv(a.accepted), "findings_rejected": csv(a.rejected),
        "spot_check": spot, "missed": a.missed or [], "residual_risk": a.residual_risk,
        "conditions": a.conditions, "cosigner": a.cosigner,
    })


def cmd_outcome(a):
    append(a.repo, {"type": "outcome", "ts": now(), "review_id": a.review_id, "kind": a.kind,
                    "area": a.area, "note": a.note, "found_by": a.found_by})


def area_trust(events, policy):
    cfg = policy.get("area_trust", {})
    min_n = cfg.get("earned_min_signoffs", 10)
    min_agree = cfg.get("earned_min_spotcheck_agreement", 0.9)
    window = dt.timedelta(days=cfg.get("withdraw_after_escape_days", 30))
    reviews = {e["review_id"]: e for e in events if e["type"] == "review"}
    stats = {}
    latest = max((parse_ts(e["ts"]) for e in events), default=dt.datetime.now(dt.timezone.utc))
    for e in events:
        if e["type"] == "signoff" and e["decision"].startswith("accept"):
            for area in {u["area"] for u in reviews.get(e["review_id"], {}).get("units", [])}:
                s = stats.setdefault(area, {"signoffs": 0, "spot_agree": 0, "spot_total": 0, "escapes": [], "missed": 0})
                s["signoffs"] += 1
                s["missed"] += len(e.get("missed") or [])
                if e.get("spot_check"):
                    s["spot_total"] += 1
                    s["spot_agree"] += e["spot_check"]["result"] == "agree"
        if e["type"] == "outcome" and e["kind"] in ("revert", "incident", "escape", "bug"):
            stats.setdefault(e["area"], {"signoffs": 0, "spot_agree": 0, "spot_total": 0, "escapes": [], "missed": 0})
            stats[e["area"]]["escapes"].append(e["ts"])
    out = {}
    for area, s in stats.items():
        agree = s["spot_agree"] / s["spot_total"] if s["spot_total"] else None
        recent = [t for t in s["escapes"] if latest - parse_ts(t) <= window]
        if recent:
            state, why = "withdrawn", f"{len(recent)} escape(s) in the last {window.days} days"
        elif s["signoffs"] >= min_n and agree is not None and agree >= min_agree and not s["escapes"]:
            state, why = "earned", f"{s['signoffs']} accepted sign-offs, {agree:.0%} spot-check agreement, no escapes"
        else:
            need = []
            if s["signoffs"] < min_n:
                need.append(f"{min_n - s['signoffs']} more sign-offs")
            if agree is None or agree < min_agree:
                need.append(f"spot-check agreement ≥ {min_agree:.0%}")
            if s["escapes"]:
                need.append("no escapes on record")
            state, why = "neutral", "needs " + ", ".join(need) if need else "neutral"
        out[area] = {"state": state, "reason": why, "signoffs": s["signoffs"],
                     "spot_check_agreement": agree, "escapes": len(s["escapes"]), "ai_misses": s["missed"]}
    return out


def load_policy(repo, path):
    p = path or (os.path.join(repo, ".trust-review", "policy.json")
                 if os.path.isfile(os.path.join(repo, ".trust-review", "policy.json")) else DEFAULT_POLICY)
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def cmd_area_trust(a):
    json.dump({"generated": now(), "areas": area_trust(load(a.repo), load_policy(a.repo, a.policy))},
              sys.stdout, indent=2)
    print()


def median(xs):
    return statistics.median(xs) if xs else None


def pct(n, d):
    return None if not d else n / d


def metrics(events):
    reviews = {e["review_id"]: e for e in events if e["type"] == "review"}
    signs = [e for e in events if e["type"] == "signoff"]
    outcomes = [e for e in events if e["type"] == "outcome"]
    sign_by = {e["review_id"]: e for e in signs}

    units = [u for r in reviews.values() for u in r.get("units", [])]
    routed = [u for u in units if u.get("tier") in ROUTED]
    lines = sum(u.get("lines") or 0 for u in units)
    routed_lines = sum(u.get("lines") or 0 for u in routed)

    shown = [f for r in reviews.values() for f in r.get("findings", []) if f.get("status") != "refuted"]
    all_f = [f for r in reviews.values() for f in r.get("findings", [])]
    accepted = sum(len(e.get("findings_accepted") or []) for e in signs)
    rejected = sum(len(e.get("findings_rejected") or []) for e in signs)
    per_lens = {}
    for e in signs:
        for fid in e.get("findings_accepted") or []:
            per_lens.setdefault(fid.split("-")[0], [0, 0])[0] += 1
        for fid in e.get("findings_rejected") or []:
            per_lens.setdefault(fid.split("-")[0], [0, 0])[1] += 1

    spots = [e["spot_check"] for e in signs if e.get("spot_check")]
    merged = [e for e in signs if e["decision"].startswith("accept")]
    bad = [o for o in outcomes if o["kind"] in ("revert", "incident", "escape", "bug")]
    by_rec = {}
    for e in signs:
        rec = (reviews.get(e["review_id"], {}).get("recommendation") or "?").split(" ")[0]
        by_rec.setdefault(rec, []).append(e.get("minutes") or 0)
    ttm = [(parse_ts(e["ts"]) - parse_ts(reviews[e["review_id"]]["ts"])).total_seconds() / 3600
           for e in signs if e["review_id"] in reviews]
    # Escapes by the tier the change was routed at: are the light tiers safe?
    esc_by_tier = {}
    for o in bad:
        r = reviews.get(o["review_id"], {})
        tier = next((u["tier"] for u in r.get("units", []) if u.get("area") == o.get("area")), "?")
        esc_by_tier[tier] = esc_by_tier.get(tier, 0) + 1

    # Trend: does review time fall while escapes stay flat? Compare first and second half of merges.
    merged_sorted = sorted(merged, key=lambda e: e["ts"])
    half = len(merged_sorted) // 2
    trend = []
    for label, part in (("earlier half", merged_sorted[:half]), ("later half", merged_sorted[half:])):
        ids = {e["review_id"] for e in part}
        trend.append({"period": label, "merges": len(part),
                      "median_owner_minutes": median([e.get("minutes") or 0 for e in part]),
                      "escapes_per_10_merges": None if not part else
                      round(10 * sum(o["review_id"] in ids for o in bad) / len(part), 2)})
    # Consistency: the same change (requirement + head) reviewed more than once must get the same outcome.
    by_change = {}
    for e in events:
        if e["type"] == "review":
            key = (str(e.get("requirement")), str(e.get("head")))
            by_change.setdefault(key, []).append(e.get("outcome") or outcome_of(e.get("recommendation")))
    repeated = {k: v for k, v in by_change.items() if len(v) > 1}
    consistent = sum(len(set(v)) == 1 for v in repeated.values())
    return {
        "consistency": {"changes_reviewed_more_than_once": len(repeated), "same_outcome": consistent,
                        "rate": pct(consistent, len(repeated)),
                        "details": [{"requirement": k[0], "head": k[1], "outcomes": v} for k, v in repeated.items()]},
        "reviews": len(reviews), "signed": len(signs), "merged": len(merged),
        "unsigned_review_ids": [r for r in reviews if r not in sign_by],
        "share_routed_to_human_units": pct(len(routed), len(units)),
        "share_routed_to_human_lines": pct(routed_lines, lines),
        "ai_findings_total": len(all_f),
        "verifier_rejection_rate": pct(sum(f.get("status") == "refuted" for f in all_f), len(all_f)),
        "ai_finding_acceptance_rate": pct(accepted, accepted + rejected),
        "acceptance_by_lens": {k: pct(v[0], v[0] + v[1]) for k, v in sorted(per_lens.items())},
        "abstentions_per_review": None if not reviews else
        round(sum(len(r.get("abstentions", [])) for r in reviews.values()) / len(reviews), 2),
        "spot_check_agreement": pct(sum(s["result"] == "agree" for s in spots), len(spots)),
        "ai_misses_found_by_humans": sum(len(e.get("missed") or []) for e in signs),
        "median_owner_minutes_by_recommendation": {k: median(v) for k, v in sorted(by_rec.items())},
        "median_hours_review_to_signoff": None if not ttm else round(median(ttm), 2),
        "escapes_total": len(bad), "escapes_per_10_merges": None if not merged else round(10 * len(bad) / len(merged), 2),
        "escapes_by_routed_tier": esc_by_tier,
        "trend": trend,
        "synthetic_events": sum(bool(e.get("synthetic")) for e in events),
    }


def fmt(v, percent=False):
    if v is None:
        return "n/a"
    if percent:
        return f"{v:.0%}"
    return f"{v:g}" if isinstance(v, float) else str(v)


def cmd_metrics(a):
    m = metrics(load(a.repo))
    if a.json:
        json.dump(m, sys.stdout, indent=2); print(); return
    print("# Trust metrics\n")
    if m["synthetic_events"]:
        print(f"> {m['synthetic_events']} events in this ledger are SYNTHETIC demo data.\n")
    rows = [
        ("Reviews / signed / merged", f"{m['reviews']} / {m['signed']} / {m['merged']}"),
        ("Share routed to human reading (units)", fmt(m["share_routed_to_human_units"], True)),
        ("Share routed to human reading (lines)", fmt(m["share_routed_to_human_lines"], True)),
        ("AI findings: accepted by owners", fmt(m["ai_finding_acceptance_rate"], True)),
        ("AI findings: rejected by verifier (lens noise)", fmt(m["verifier_rejection_rate"], True)),
        ("Abstentions per review", fmt(m["abstentions_per_review"])),
        ("Spot-check agreement (human vs AI claim)", fmt(m["spot_check_agreement"], True)),
        ("AI misses found by humans", fmt(m["ai_misses_found_by_humans"])),
        ("Median hours review → sign-off", fmt(m["median_hours_review_to_signoff"])),
        ("Escapes per 10 merges", fmt(m["escapes_per_10_merges"])),
        ("Same change, same outcome (repeat reviews)", f'{m["consistency"]["same_outcome"]}/{m["consistency"]["changes_reviewed_more_than_once"]}'),
    ]
    print("| Metric | Value |\n|---|---|")
    for k, v in rows:
        print(f"| {k} | {v} |")
    print("\n**Owner minutes by recommendation:** " +
          ", ".join(f"{k}: {fmt(v)}" for k, v in m["median_owner_minutes_by_recommendation"].items()))
    print("**Acceptance by lens:** " + (", ".join(f"{k}: {fmt(v, True)}" for k, v in m["acceptance_by_lens"].items()) or "n/a"))
    print("**Escapes by routed tier:** " + (", ".join(f"{k}: {v}" for k, v in m["escapes_by_routed_tier"].items()) or "none"))
    print("\n**Trend (the bar: review time falls, escapes do not rise)**\n")
    print("| Period | Merges | Median owner min | Escapes / 10 merges |\n|---|---|---|---|")
    for t in m["trend"]:
        print(f"| {t['period']} | {t['merges']} | {fmt(t['median_owner_minutes'])} | {fmt(t['escapes_per_10_merges'])} |")
    for c in m["consistency"]["details"]:
        flag = "consistent" if len(set(c["outcomes"])) == 1 else "INCONSISTENT"
        print(f"\nRepeat reviews of {c['requirement']} @ {c['head']}: {' -> '.join(map(str, c['outcomes']))} ({flag})")
    if m["unsigned_review_ids"]:
        print(f"\nUnsigned reviews (nobody owns these yet): {', '.join(m['unsigned_review_ids'])}")


def cmd_seed_demo(a):
    """Synthetic history so the metrics and area-trust views have something to show."""
    rng = random.Random(2026)
    areas = [("tests", "T0", 0.2), ("docs", "T0", 0.1), ("source-generator", "T1", 0.5),
             ("core-runtime", "T2", 0.15), ("build-and-deps", "T1", 0.05)]
    owners = ["Owner A", "Owner B", "Owner C"]
    start = dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc)
    p = ledger_path(a.repo)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        for i in range(40):
            t = start + dt.timedelta(days=i * 1.5)
            rid = f"DEMO-{i:03d}"
            us = [{"id": f"U{j+1}", "area": ar, "tier": tier, "lines": rng.randint(20, 300)}
                  for j, (ar, tier, w) in enumerate(areas) if rng.random() < w + 0.3]
            us = us or [{"id": "U1", "area": "tests", "tier": "T0", "lines": 40}]
            top = max((u["tier"] for u in us), key=["T0", "T1", "T2"].index)
            fs = [{"id": f"{rng.choice(['COR','SEC','CMP','DOC','VER','INT'])}-{k+1}", "severity": rng.choice(["blocking", "note", "note"]),
                   "status": rng.choice(["confirmed", "confirmed", "confirmed", "refuted", "unsettled"])} for k in range(rng.randint(0, 4))]
            rec = {"T0": "T0 Ready for owner evidence check", "T1": "T1 Owner focused read", "T2": "T2 Owner full read"}[top]
            f.write(json.dumps({"type": "review", "ts": t.isoformat(), "review_id": rid, "requirement": f"DEMO-REQ-{i}",
                                "owner": rng.choice(owners), "recommendation": rec, "units": us, "findings": fs,
                                "abstentions": [f"INT-A{k}" for k in range(rng.randint(0, 2))], "synthetic": True}) + "\n")
            shown = [x["id"] for x in fs if x["status"] != "refuted"]
            acc = [x for x in shown if rng.random() < 0.8]
            minutes = {"T0": 6, "T1": 16, "T2": 45}[top] * (1.2 - i / 80)
            f.write(json.dumps({"type": "signoff", "ts": (t + dt.timedelta(hours=rng.uniform(1, 20))).isoformat(),
                                "review_id": rid, "owner": rng.choice(owners), "decision": "accept",
                                "minutes": round(minutes), "findings_accepted": acc,
                                "findings_rejected": [x for x in shown if x not in acc],
                                "spot_check": {"claim_id": "INT-S1", "result": "agree" if rng.random() < 0.93 else "disagree"},
                                "missed": ["edge case found by owner"] if rng.random() < 0.08 else [],
                                "synthetic": True}) + "\n")
            if i in (7, 31):
                f.write(json.dumps({"type": "outcome", "ts": (t + dt.timedelta(days=3)).isoformat(), "review_id": rid,
                                    "kind": "revert", "area": us[-1]["area"], "note": "synthetic escape",
                                    "synthetic": True}) + "\n")
    print(f"Wrote synthetic demo history to {p}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=".")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("record-review"); s.add_argument("dossier"); s.set_defaults(fn=cmd_record_review)
    s = sub.add_parser("sign-off"); s.add_argument("review_id"); s.add_argument("--owner", required=True)
    s.add_argument("--decision", required=True, choices=["accept", "accept-with-conditions", "reject", "send-back"])
    s.add_argument("--minutes", type=float, required=True); s.add_argument("--read-units")
    s.add_argument("--accepted"); s.add_argument("--rejected"); s.add_argument("--spot-check")
    s.add_argument("--missed", action="append"); s.add_argument("--residual-risk")
    s.add_argument("--conditions"); s.add_argument("--cosigner"); s.set_defaults(fn=cmd_sign_off)
    s = sub.add_parser("outcome"); s.add_argument("review_id")
    s.add_argument("--kind", required=True, choices=["revert", "incident", "escape", "bug"])
    s.add_argument("--area", required=True); s.add_argument("--note"); s.add_argument("--found-by")
    s.set_defaults(fn=cmd_outcome)
    s = sub.add_parser("area-trust"); s.add_argument("--policy"); s.set_defaults(fn=cmd_area_trust)
    s = sub.add_parser("metrics"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_metrics)
    s = sub.add_parser("seed-demo"); s.set_defaults(fn=cmd_seed_demo)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
