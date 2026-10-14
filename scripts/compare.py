#!/usr/bin/env python3
"""Per-scenario and aggregate comparison of experiment arms over the public scenarios.

Usage:
  compare.py --sim SIM_DIR --arm NAME=TAG:AGENT_ID [--arm ...] [--champion NAME] [--json out.json]

An arm's runs are found through logs/<TAG>-*.log (scripts/run-queue.sh) and logs/<TAG>-public-*.log
(scripts/run-matrix.sh over a scenario file); each log names its matrix directory. Per scenario:

  pnl        P (summary pnlUsdc, the competition's per-epoch score input)
  alpha      P minus the do-nothing benchmark's P in the same run
  tx / rev   the agent's mined transactions / reverted ones (blocks.csv status)
  gasUsd     sum of gasUsed x priority fee over its mined transactions (base fee 0), at the final fair
  rtRej      actions the runtime rejected before signing (agents/<id>.jsonl)
  cand       candidates that cleared the scanner, summed over blocks (our agent's epoch-end log)
  sel        opportunities selected for sending (our agent) / actions submitted (starter)
  rejected   rejection reasons and counts (our agent's cumulative counter; the starter's noop reasons)

Also audits the E2 rule "a mined fee above the stated participant cap is not a participant" against
the simulator's own labels in blocks.csv (role), which agents never see.
"""
import argparse
import collections
import csv
import glob
import json
import os
import re
import statistics


def matrix_dirs(sim, log):
    dirs = []
    for line in open(log, errors="replace"):
        m = re.search(r"(runs/matrix-[0-9TZ:.\-]+)", line)
        if m and m.group(1) not in dirs:
            dirs.append(m.group(1))
    return [os.path.join(sim, d) for d in dirs]


def read_jsonl(path):
    if not os.path.exists(path):
        return
    for line in open(path, errors="replace"):
        try:
            yield json.loads(line)
        except ValueError:
            continue


def scenario_record(sim, run_dir, agent):
    run_dir = run_dir if os.path.isabs(run_dir) else os.path.join(sim, run_dir)
    summ = json.load(open(os.path.join(run_dir, "summary.json")))
    agents = {a["id"]: a for a in summ.get("agents", [])}
    if agent not in agents:
        return None
    a = agents[agent]
    vs = summ.get("valueSeries", {})
    meta = vs.get("intervalSeriesMeta", {}) or {}
    eth_usd = summ.get("finalFairPriceUsdcPerWeth") or 3000.0
    addr = a["address"].lower()
    cap = None
    cfg = glob.glob(os.path.join(run_dir, "agent-view", agent, "config.yaml"))
    if cfg:
        m = re.search(r"maxPriorityFeeWei:\s*\"?([0-9]+)", open(cfg[0]).read())
        cap = int(m.group(1)) if m else None
    cap = cap or 5_000_000_000
    tx = rev = 0
    gas_wei = 0
    audit = collections.Counter()
    with open(os.path.join(run_dir, "blocks.csv")) as fh:
        for row in csv.DictReader(fh):
            fee = int(row.get("priorityFeeWei") or 0)
            system = row.get("role") == "system"
            if fee > cap:
                audit["aboveCap_system" if system else "aboveCap_nonSystem"] += 1
            elif system:
                audit["system_atOrBelowCap"] += 1
            if (row.get("from") or "").lower() != addr:
                continue
            tx += 1
            if row.get("status") != "success":
                rev += 1
            gas_wei += int(row.get("gasUsed") or 0) * fee
    rt_rej = 0
    submitted = 0
    reasons = collections.Counter()
    cand = sel = None
    for e in read_jsonl(os.path.join(run_dir, "agents", f"{agent}.jsonl")):
        ev = e.get("event")
        if ev == "rejected":
            rt_rej += 1
            reasons["runtime: " + str(e.get("reason", "?"))[:60]] += 1
        elif ev == "submitted":
            submitted += 1
        st = (e.get("state") or {}).get("stats") if isinstance(e.get("state"), dict) else None
        if st and "candidates" in st:
            cand, sel = st.get("candidates"), st.get("actions")
            agent_rej = st.get("rejected") or {}
        if ev is None and isinstance(e.get("action"), dict) and e["action"].get("type") == "noop" and e.get("reason"):
            reasons["noop: " + re.sub(r"[0-9.]+", "#", str(e["reason"]))[:60]] += 1
    if cand is not None:
        reasons = collections.Counter({k: v for k, v in reasons.items() if k.startswith("runtime: ")})
        reasons.update(agent_rej)
    return {
        "pnl": a.get("pnlUsdc"),
        "alpha": a.get("alphaUsdc"),
        "tx": tx,
        "rev": rev,
        "gasUsd": gas_wei / 1e18 * eth_usd,
        "rtRej": rt_rej,
        "cand": cand,
        "sel": sel if sel is not None else submitted,
        "rejected": dict(reasons),
        "valid": (vs.get("failedReads") or 0) == 0 and (meta.get("failedBoundaries") or 0) == 0,
        "audit": dict(audit),
    }


def collect(sim, here, tag, agent):
    out = {}
    logs = glob.glob(os.path.join(here, "logs", f"{tag}-*.log"))
    for log in sorted(logs, key=os.path.getmtime):
        for d in matrix_dirs(sim, log):
            p = os.path.join(d, "matrix.json")
            if not os.path.exists(p):
                continue
            try:
                m = json.load(open(p))
            except ValueError:
                continue
            for sc in m.get("scenarios", []):
                key = (sc["regime"], int(sc["seed"]))
                if not sc.get("agents") or not sc.get("runDir"):
                    continue
                try:
                    rec = scenario_record(sim, sc["runDir"], agent)
                except (OSError, ValueError, KeyError):
                    rec = None
                if rec and rec["valid"]:
                    out[key] = rec
    return out


def fmt(x, nd=0):
    if x is None:
        return "–"
    return f"{x:,.{nd}f}"


def agg(recs):
    p = [r["pnl"] for r in recs]
    if not p:
        return {}
    return {
        "n": len(p),
        "total": sum(p),
        "median": statistics.median(p),
        "mean": statistics.mean(p),
        "worst": min(p),
        "neg": sum(1 for x in p if x < 0),
        "stdev": statistics.pstdev(p),
        "alphaTotal": sum(r["alpha"] or 0 for r in recs),
        "tx": sum(r["tx"] for r in recs),
        "rev": sum(r["rev"] for r in recs),
        "gasUsd": sum(r["gasUsd"] for r in recs),
        "rtRej": sum(r["rtRej"] for r in recs),
        "cand": sum(r["cand"] or 0 for r in recs) if all(r["cand"] is not None for r in recs) else None,
        "sel": sum(r["sel"] or 0 for r in recs),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", required=True)
    ap.add_argument("--arm", action="append", required=True, help="NAME=TAG:AGENT_ID")
    ap.add_argument("--champion", default=None)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    arms = []
    for spec in args.arm:
        name, rest = spec.split("=", 1)
        tag, agent = rest.split(":", 1)
        arms.append((name, collect(args.sim, here, tag, agent)))
    names = [n for n, _ in arms]
    data = dict(arms)
    common = sorted(set.intersection(*(set(d) for d in data.values()))) if data else []

    print(f"## Per scenario (P, USDC; {len(common)} scenarios completed and valid in every arm)\n")
    print("| scenario | " + " | ".join(names) + " |")
    print("|---|" + "---:|" * len(names))
    for k in common:
        print(f"| {k[0]}#{k[1]} | " + " | ".join(fmt(data[n][k]["pnl"]) for n in names) + " |")

    print("\n## Aggregate over the common scenarios\n")
    cols = ["n", "total", "median", "mean", "worst", "neg", "stdev", "alphaTotal", "tx", "rev", "gasUsd", "rtRej", "cand", "sel"]
    print("| arm | " + " | ".join(cols) + " |")
    print("|---|" + "---:|" * len(cols))
    aggs = {}
    for n in names:
        a = agg([data[n][k] for k in common])
        aggs[n] = a
        print(f"| {n} | " + " | ".join(fmt(a.get(c), 2 if c == "gasUsd" else 0) for c in cols) + " |")

    print("\n## Worst scenario per regime (P, USDC)\n")
    regimes = sorted({k[0] for k in common})
    print("| regime | " + " | ".join(names) + " |")
    print("|---|" + "---:|" * len(names))
    for r in regimes:
        ks = [k for k in common if k[0] == r]
        print(f"| {r} | " + " | ".join(fmt(min(data[n][k]["pnl"] for k in ks)) for n in names) + " |")

    if args.champion and args.champion in data:
        print(f"\n## Paired vs {args.champion} (scenarios where the arm's P is higher / lower)\n")
        for n in names:
            if n == args.champion:
                continue
            d = [data[n][k]["pnl"] - data[args.champion][k]["pnl"] for k in common]
            if d:
                print(f"- {n}: +{sum(1 for x in d if x > 0)} / -{sum(1 for x in d if x < 0)}, "
                      f"median diff {fmt(statistics.median(d))}, worst diff {fmt(min(d))}, total diff {fmt(sum(d))}")

    print("\n## Rejection reasons (summed over the common scenarios)\n")
    for n in names:
        c = collections.Counter()
        for k in common:
            c.update(data[n][k]["rejected"])
        top = ", ".join(f"{r}: {v:,}" for r, v in c.most_common(10)) or "none recorded"
        print(f"- **{n}**: {top}")

    print("\n## E2 rule audit (all mined transactions in these runs, simulator labels)\n")
    audit = collections.Counter()
    for n in names:
        for k in common:
            audit.update(data[n][k]["audit"])
    print(f"- fee above cap: system {audit['aboveCap_system']:,}, non-system {audit['aboveCap_nonSystem']:,}")
    print(f"- system at or below cap (still counted as a rival by the rule): {audit['system_atOrBelowCap']:,}")

    if args.json:
        json.dump({n: {f"{k[0]}#{k[1]}": v for k, v in data[n].items()} for n in names} | {"_agg": aggs},
                  open(args.json, "w"), indent=1, default=str)


if __name__ == "__main__":
    main()
