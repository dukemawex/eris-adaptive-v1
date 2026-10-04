/**
 * Online regime detector. Deterministic, uses only the features (which use only the observation),
 * and never the scenario name, seed or event schedule — the hidden set is the same families under
 * other seeds, so the classifier has to recognise conditions, not runs.
 *
 * Priority when several conditions hold: LIQUIDATION > SHOCK > DEPEG > DISLOCATION > CALM.
 * UNKNOWN is reported until enough history exists to judge volatility.
 */
import type { Params, Regime } from "./config.js";
import type { Features } from "./features.js";
import type { AgentState } from "./state.js";

export type RegimeReading = {
  regime: Regime;
  reasons: string[];
  /** Largest |fair move| over the shock window across bases (bps). */
  shockMoveBps: number;
  /** Largest short/long vol ratio across bases. */
  volRatio: number;
  /** Largest venue gap beyond its fee (bps). */
  maxNetGapBps: number;
  /** Largest stable deviation from $1 (bps, absolute). */
  maxDepegBps: number;
};

export function classify(
  f: Features,
  st: AgentState,
  params: Params,
  liquidatable: boolean,
): RegimeReading {
  const p = params.regime;
  const reasons: string[] = [];
  let shockMoveBps = 0;
  let volRatio = 0;
  for (const b of Object.values(f.bases)) {
    shockMoveBps = Math.max(shockMoveBps, Math.abs(b.retWindowBps), Math.abs(b.ret1Bps));
    const longVol = Math.max(p.volFloorBps, b.volLongBps);
    volRatio = Math.max(volRatio, b.volShortBps / longVol);
  }
  const maxNetGapBps = f.venues.reduce((m, v) => Math.max(m, v.netGapBps), -Infinity);
  const maxDepegBps = f.stables.reduce((m, s) => Math.max(m, Math.abs(s.devBps)), 0);

  const reading = (regime: Regime): RegimeReading => ({
    regime,
    reasons,
    shockMoveBps,
    volRatio,
    maxNetGapBps: Number.isFinite(maxNetGapBps) ? maxNetGapBps : 0,
    maxDepegBps,
  });

  if (!f.valid) {
    reasons.push(f.invalidReason ?? "invalid observation");
    return reading("UNKNOWN");
  }
  if (liquidatable) {
    reasons.push("liquidatable position observed");
    return reading("LIQUIDATION");
  }
  const shockNow =
    shockMoveBps >= p.shockReturnBps ||
    (f.historyLen >= p.minHistory && volRatio >= p.shockVolRatio && shockMoveBps >= p.shockReturnBps / 3);
  if (shockNow) {
    st.shockUntil = f.round + p.shockHoldBlocks;
    reasons.push(`fair moved ${shockMoveBps.toFixed(0)}bps / vol ratio ${volRatio.toFixed(1)}`);
    return reading("SHOCK");
  }
  if (f.round <= st.shockUntil) {
    reasons.push(`shock hold until ${st.shockUntil}`);
    return reading("SHOCK");
  }
  if (f.historyLen < p.minHistory) {
    reasons.push(`history ${f.historyLen} < ${p.minHistory}`);
    return reading("UNKNOWN");
  }
  if (maxDepegBps >= p.depegBps) {
    reasons.push(`stable off par by ${maxDepegBps.toFixed(0)}bps`);
    return reading("DEPEG");
  }
  if (maxNetGapBps >= p.dislocationBps) {
    reasons.push(`venue gap ${maxNetGapBps.toFixed(0)}bps past fee`);
    return reading("DISLOCATION");
  }
  reasons.push("low vol, gaps inside fee band");
  return reading("CALM");
}
