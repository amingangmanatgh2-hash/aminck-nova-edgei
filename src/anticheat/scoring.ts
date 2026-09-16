/**
 * Anti-cheat — scoring and action ladder.
 *
 * THE GOLDEN RULE LIVES HERE: no single signal ever bans anyone. Signals
 * accumulate in a rolling window, each individual check is capped, higher
 * action tiers require several DISTINCT checks to agree, network conditions
 * subtract from the total, and an automatic ban is always temporary.
 */
import { ANTICHEAT } from '../config';
import type { ActionTier, CheatCheckId } from '../types';
import { newId, now } from '../utils';
import type { EvaluatedSignal } from './types';

export interface ScoredSignal extends EvaluatedSignal {
  id: string;
  playerId: string;
  createdAt: number;
  /** Weight after the per-check cap and time decay. */
  effective: number;
}

export interface TierDecision {
  confidence: number;
  tier: ActionTier;
  actionTaken: string;
  /** Distinct check ids that contributed. */
  distinctChecks: CheatCheckId[];
  reasons: string[];
  /** True only when a temporary ban was applied. */
  banned: boolean;
  /** Never true from automatic scoring. */
  permanent: boolean;
}

/**
 * Per-check weighting. Some checks are far more reliable than others, so they
 * earn more per unit of weight; noisy ones earn less. This is what keeps a
 * single flaky detector from escalating anyone.
 */
export const CHECK_RELIABILITY: Record<CheatCheckId, number> = {
  killaura: 1.0,
  reach: 0.95,
  noclip: 0.9,
  fly: 0.85,
  timer: 0.9,
  fastbreak: 0.85,
  autoclick: 0.6, // high-CPS is a legit technique; only regularity matters
  xray: 0.7, // heavily caveated by exploration evidence
  speed: 0.8,
  jetpack: 0.75,
  collusion: 0.65, // smurfing/alt-play produces false positives
};

/** How many points one fully-weighted signal of this check contributes. */
/**
 * Effective maximum points per check — trust already folded in, so a check is
 * not discounted twice. Tuned so that one fully-corroborated impossible-event
 * check clears the KICK threshold (40) but can never reach the BAN threshold
 * (70) on its own, because singleCheckCap is 55.
 */
export const CHECK_POINTS: Record<CheatCheckId, number> = {
  noclip: 55,
  killaura: 52,
  fly: 52,
  timer: 46,
  speed: 44,
  reach: 42,
  fastbreak: 42,
  xray: 42,
  jetpack: 40,
  autoclick: 18,
  collusion: 24,
};

/**
 * Checks describing events that CANNOT happen in unmodified Minecraft:
 * passing through solid blocks, staying airborne indefinitely, hitting several
 * distinct players in one 50 ms swing, a client ticking faster than the server.
 * A strongly-corroborated hit here may escalate to a KICK on its own — but
 * never to a ban, and never while the network story is murky.
 */
export const IMPOSSIBLE_CHECKS: ReadonlySet<CheatCheckId> = new Set<CheatCheckId>([
  'killaura',
  'noclip',
  'fly',
  'timer',
  'reach',
  'fastbreak',
  // Each of these already demands internal corroboration before it fires at
  // all: speed needs sustained overspeed in >=15% of samples, fastbreak needs
  // sub-45ms breaks with no adequate tool, xray needs rate + straightness +
  // low exploration together. A high weight on them is not a coin flip.
  'speed',
  'xray',
]);

/**
 * Checks that are genuinely ambiguous — high CPS is a real technique and
 * collusion patterns also appear in smurf/alt play. These can raise an alert
 * but can never escalate on their own.
 */
export const GREY_AREA_CHECKS: ReadonlySet<CheatCheckId> = new Set<CheatCheckId>([
  'autoclick',
  'collusion',
]);

/** Exponential decay: a signal from 5 minutes ago counts for much less. */
export function decayFactor(ageMs: number, windowMs = ANTICHEAT.windowMs): number {
  if (ageMs >= windowMs) return 0;
  return Math.exp(-2.2 * (ageMs / windowMs));
}

export function toScored(
  playerId: string,
  s: EvaluatedSignal,
  at = now(),
): ScoredSignal {
  // NOTE: reliability is NOT applied here. It is already folded into
  // CHECK_POINTS. Applying it in both places double-penalised every check and
  // made blatant cheats score below the kick threshold.
  return { ...s, id: newId(), playerId, createdAt: at, effective: s.weight };
}

export interface ScoreInput {
  signals: ScoredSignal[];
  at: number;
  /** Sum of network reductions from the signals themselves. */
  networkReduction?: number;
  /** Extra context: sustained high ping, known-good history, etc. */
  standingCredit?: number;
}

/**
 * Aggregate signals into a confidence score and decide the action tier.
 *
 * Constraints enforced here:
 *  - each check contributes at most ANTICHEAT.singleCheckCap points total
 *  - tier 3 (kick) needs >= minDistinctChecksForKick distinct checks
 *  - tier 4 (ban)  needs >= minDistinctChecksForBan distinct checks
 *  - network reductions and standing credit are subtracted
 *  - `permanent` is hardcoded false
 */
export function scoreAndDecide(input: ScoreInput): TierDecision {
  const { signals, at } = input;
  const windowMs = ANTICHEAT.windowMs;

  const live = signals.filter((s) => at - s.createdAt < windowMs);

  // --- group by check and apply the per-check cap -------------------------
  const byCheck = new Map<CheatCheckId, ScoredSignal[]>();
  for (const s of live) {
    const arr = byCheck.get(s.checkId) ?? [];
    arr.push(s);
    byCheck.set(s.checkId, arr);
  }

  let total = 0;
  const reasons: string[] = [];
  let signalCount = 0;
  let decisiveCheck: CheatCheckId | null = null;
  let decisiveWeight = 0;
  let greyOnly = true;

  for (const [check, list] of byCheck) {
    const pts = CHECK_POINTS[check] ?? 10;
    // Sum the decayed effective weights, but never exceed the cap for one check.
    let raw = 0;
    let peak = 0;
    for (const s of list) {
      const decayed = s.effective * decayFactor(at - s.createdAt, windowMs);
      raw += decayed;
      peak = Math.max(peak, decayed);
    }
    signalCount += list.length;
    const contributed = Math.min(raw, 1) * pts; // multiple hits of one check saturate
    const capped = Math.min(contributed, ANTICHEAT.singleCheckCap);
    total += capped;
    if (!GREY_AREA_CHECKS.has(check)) greyOnly = false;
    if (IMPOSSIBLE_CHECKS.has(check) && peak >= ANTICHEAT.decisiveWeight && peak > decisiveWeight) {
      decisiveCheck = check;
      decisiveWeight = peak;
    }
    reasons.push(
      `${check}: ${list.length} signal(s), ${capped.toFixed(1)} pts` +
        (contributed > ANTICHEAT.singleCheckCap ? ' (capped)' : ''),
    );
  }

  // --- network conditions REDUCE the score -------------------------------
  const netReduction =
    (input.networkReduction ?? 0) +
    live.reduce((a, s) => a + Math.abs(Math.min(0, s.networkAdjustment)), 0);
  const credit = input.standingCredit ?? 0;
  const before = total;
  total = Math.max(0, total - netReduction - credit);
  if (netReduction > 0 || credit > 0) {
    reasons.push(
      `network/lag reduction -${netReduction.toFixed(1)}, history credit -${credit.toFixed(1)} ` +
        `(${before.toFixed(1)} -> ${total.toFixed(1)})`,
    );
  }

  const distinct = [...byCheck.keys()];
  const confidence = Math.round(total * 100) / 100;

  // --- ladder -------------------------------------------------------------
  const [t1, t2, t3, t4] = ANTICHEAT.tierThresholds;
  void t1;

  let tier: ActionTier = 1;
  let actionTaken = 'logged';
  let banned = false;

  // Level 2: a hidden alert to the admin. The player sees nothing.
  if (confidence >= t2) {
    tier = 2;
    actionTaken = 'hidden_admin_alert';
  }

  // Level 3: kick from the match (never a ban). Requires corroboration —
  // either several distinct checks agreeing, several signals accumulating, or
  // a single physically-impossible event observed with high confidence.
  const corroborated =
    distinct.length >= ANTICHEAT.minDistinctChecksForKick ||
    signalCount >= ANTICHEAT.minSignalsForKick;
  const decisive = decisiveCheck !== null && !greyOnly;

  if (confidence >= t3 && (corroborated || decisive)) {
    tier = 3;
    actionTaken = 'match_kick';
    if (decisive && !corroborated) {
      reasons.push(
        `single decisive check '${decisiveCheck}' at weight ${decisiveWeight.toFixed(2)} ` +
          `(>= ${ANTICHEAT.decisiveWeight}) escalated to kick alone`,
      );
    }
  } else if (confidence >= t3) {
    actionTaken = 'hidden_admin_alert_needs_second_signal';
    tier = 2;
    reasons.push(
      `score ${confidence} clears tier 3 but has ${distinct.length} distinct check(s) and ` +
        `${signalCount} signal(s) - not escalating`,
    );
  }

  // Level 4: temporary ban. Always needs genuine corroboration; a single
  // check is never enough no matter how confident.
  if (
    confidence >= t4 &&
    distinct.length >= ANTICHEAT.minDistinctChecksForBan &&
    signalCount >= ANTICHEAT.minSignalsForBan
  ) {
    tier = 4;
    actionTaken = 'temporary_ban';
    banned = true;
  } else if (confidence >= t4) {
    tier = 3;
    actionTaken = 'match_kick';
    reasons.push(
      `score ${confidence} clears the ban threshold but has ${distinct.length} distinct check(s) / ` +
        `${signalCount} signal(s) (needs ${ANTICHEAT.minDistinctChecksForBan}/${ANTICHEAT.minSignalsForBan}) ` +
        `- downgraded to kick`,
    );
  }

  if (tier === 1) {
    reasons.push(`score ${confidence} below tier-2 threshold ${t2} - log only, no action`);
  }

  return {
    confidence,
    tier,
    actionTaken,
    distinctChecks: distinct,
    reasons,
    banned,
    // Automatic decisions are NEVER permanent. Only an admin can escalate.
    permanent: false,
  };
}

/** Convenience: the case record to persist for an action. */
export function buildCaseSummary(decision: TierDecision, playerId: string): {
  id: string;
  playerId: string;
  confidence: number;
  tier: ActionTier;
  actionTaken: string;
  permanent: boolean;
} {
  return {
    id: newId(),
    playerId,
    confidence: decision.confidence,
    tier: decision.tier,
    actionTaken: decision.actionTaken,
    permanent: false,
  };
}
