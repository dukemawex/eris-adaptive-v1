#!/usr/bin/env python3
"""Collect per-scenario results from backtest matrix runs and print markdown tables.

Usage:
  report.py --sim SIM_DIR --group NAME=AGENT:log1,log2,... [--group ...] [--compare A B] [--json out.json]

Each log is a scripts/run-matrix.sh log; the matrix directory is read from it. For every scenario
the agent's P (pnlUsdc, the competition's per-epoch score input), the benchmark's P, alpha vs the
benchmark, the max drawdown of the agent's value minus the benchmark's over the interval
boundaries, mined/reverted transaction counts and the run's wall time are collected.
"""
import argparse
import json
import os
import re
import statistics
import sys


def matrix_dirs(sim, log):
    dirs = []
    if not os.path.exists(log):
        return dirs
    for line in open(log, errors="replace"):
        m = re.search(r"(runs/matrix-[0-9TZ:.\-]+)", line)
        if m and m.group(1) not in dirs:
            dirs.append(m.group(1))
    return [os.path.join(sim, d) for d in dirs]


def max_drawdown(xs):
    peak, dd = -1e18, 0.0
    for x in xs:
        peak = max(peak, x)
        dd = max(dd, peak - x)
    return dd


def collect(sim, agent, logs):
    out = {}
    for log in logs:
        for d in matrix_dirs(sim, log):
            path = os.path.join(d, "matrix.json")
            if not os.path.exists(path):
                continue
            m = json.load(open(path))
            for sc in m.get("scenarios", []):
                key = f"{sc['regime']}#{sc['seed']}"
                agents = {a["id"]: a for a in sc.get("agents") or []}
                if agent not in agents:
                    out[key] = {"error": sc.get("error", "agent missing")}
                    continue
                a = agents[agent]
                base = next((x for x in agents.values() if x.get("baseline")), None)
                rec = {
                    "pnl": a.get("pnlUsdc"),
                    "basePnl": base.get("pnlUsdc") if base else None,
                    "alpha": a.get("alphaUsdc"),
                    "net": a.get("netPnlUsdc"),
                    "flags": a.get("flags") or [],
                }
                run_dir = sc.get("runDir")
                if run_dir and not os.path.isabs(run_dir):
                    run_dir = os.path.join(sim, run_dir)
                summ = os.path.join(run_dir or "", "summary.json")
                if run_dir and os.path.exists(summ):
                    s = json.load(open(summ))
                    sa = next((x for x in s.get("agents", []) if x["id"] == agent), {})
                    rec["included"] = sa.get("includedTxCount")
                    rec["reverts"] = sa.get("revertCount")
                    rec["elapsedS"] = round((s.get("elapsedMs") or 0) / 1000)
                    iv = (s.get("valueSeries") or {}).get("intervalSeries") or {}
                    vals = (iv.get("valuesByAgent") or {})
                    if agent in vals and base and base["id"] in vals:
                        excess = [x - y for x, y in zip(vals[agent], vals[base["id"]])]
                        rec["maxDD"] = max_drawdown([e - excess[0] for e in excess])
                    lg = os.path.join(run_dir, "agents", f"{agent}.jsonl")
                    if os.path.exists(lg):
                        n_err = n_rej = n_sub = 0
                        for line in open(lg, errors="replace"):
                            if '"decide error' in line or '"decide timeout' in line:
                                n_err += 1
                            elif '"event":"rejected"' in line:
                                n_rej += 1
                            elif '"event":"submitted"' in line:
                                n_sub += 1
                        rec.update(decideErrors=n_err, rejected=n_rej, submitted=n_sub)
                out[key] = rec
    return out


REGIME_ORDER = ["calm", "cex-drift", "informed-flow", "whale", "lending-incident", "crash", "depeg",
                "vuln", "spike", "depeg-persist", "cdp-incident", "launch"]


def sort_key(k):
    r, s = k.split("#")
    return (REGIME_ORDER.index(r) if r in REGIME_ORDER else 99, int(s))


def fmt(x, nd=0):
    if x is None:
        return "—"
    return f"{x:,.{nd}f}"


def summarize(name, recs):
    ps = [r["pnl"] for r in recs.values() if r.get("pnl") is not None]
    alphas = [r["alpha"] for r in recs.values() if r.get("alpha") is not None]
    if not ps:
        return f"{name}: no results"
    worst = min(recs.items(), key=lambda kv: kv[1].get("alpha", 1e18) if kv[1].get("alpha") is not None else 1e18)
    best = max(recs.items(), key=lambda kv: kv[1].get("alpha", -1e18) if kv[1].get("alpha") is not None else -1e18)
    return (
        f"**{name}**: {len(ps)} scenarios · ΣP {fmt(sum(ps))} · Σalpha vs noop {fmt(sum(alphas))} · "
        f"mean alpha {fmt(statistics.mean(alphas), 1)} · median alpha {fmt(statistics.median(alphas), 1)} · "
        f"alpha>0 in {sum(1 for a in alphas if a > 0)}/{len(alphas)} · worst {worst[0]} ({fmt(worst[1].get('alpha'))}) · "
        f"best {best[0]} ({fmt(best[1].get('alpha'))}) · reverts {sum(r.get('reverts') or 0 for r in recs.values())} · "
        f"mined {sum(r.get('included') or 0 for r in recs.values())} · decide errors {sum(r.get('decideErrors') or 0 for r in recs.values())}"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", required=True)
    ap.add_argument("--group", action="append", default=[])
    ap.add_argument("--compare", nargs=2)
    ap.add_argument("--json")
    a = ap.parse_args()
    groups = {}
    for g in a.group:
        name, rest = g.split("=", 1)
        agent, logs = rest.split(":", 1)
        groups[name] = collect(a.sim, agent, logs.split(","))
    for name, recs in groups.items():
        print(summarize(name, recs))
        print()
    if a.compare:
        A, B = a.compare
        ra, rb = groups[A], groups[B]
        keys = sorted(set(ra) | set(rb), key=sort_key)
        print(f"| Scenario | noop P | {A} P | {B} P | Δ ({B} − {A}) | {B} alpha | {B} max DD vs noop | {B} mined / reverts | Notes |")
        print("|---|---:|---:|---:|---:|---:|---:|---:|---|")
        da = db = 0.0
        for k in keys:
            x, y = ra.get(k, {}), rb.get(k, {})
            d = (y["pnl"] - x["pnl"]) if x.get("pnl") is not None and y.get("pnl") is not None else None
            notes = []
            for r, n in ((x, A), (y, B)):
                if r.get("error"):
                    notes.append(f"{n}: {r['error']}")
                if r.get("decideErrors"):
                    notes.append(f"{n}: {r['decideErrors']} decide errors")
                if r.get("flags"):
                    notes.append(f"{n} flags: {'; '.join(map(str, r['flags']))[:80]}")
            base = y.get("basePnl", x.get("basePnl"))
            print(
                f"| {k} | {fmt(base)} | {fmt(x.get('pnl'))} | {fmt(y.get('pnl'))} | {fmt(d)} | {fmt(y.get('alpha'))} | "
                f"{fmt(y.get('maxDD'))} | {y.get('included', '—')} / {y.get('reverts', '—')} | {'; '.join(notes)} |"
            )
    if a.json:
        json.dump(groups, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    sys.exit(main())
