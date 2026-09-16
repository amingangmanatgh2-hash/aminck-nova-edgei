/**
 * Anti-cheat — detection layer.
 *
 * Every detector is a pure function returning either null (nothing suspicious)
 * or a graded weight in 0..1 plus the NUMBERS that produced it. No detector is
 * allowed to conclude "cheating" on its own; they only contribute evidence.
 *
 * Design rule: a detector that fires on a lagging player is a bug. Every check
 * takes the network state and either relaxes its threshold or declines to fire.
 */
import { ANTICHEAT } from '../config';
import type { CheatCheckId } from '../types';
import { coefficientOfVariation, mean } from '../utils';
import {
  effectiveReachLimit,
  effectiveSpeedLimit,
  isUnreliableSampleGap,
  networkAdjustment,
} from './network';
import type {
  AttackSample,
  BlockBreakSample,
  ClickSample,
  CollusionInput,
  EvaluatedSignal,
  MoveSample,
  NetworkState,
  OreFindSample,
  Vec3,
} from './types';

// ----------------------------------------------------------------- helpers
export function horizontalDistance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distance3d(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function sig(
  checkId: CheatCheckId,
  weight: number,
  metrics: Record<string, number | string | boolean>,
  reason: string,
  reduction = 0,
): EvaluatedSignal {
  return {
    checkId,
    weight: Math.max(0, Math.min(1, weight)),
    metrics,
    networkAdjustment: -Math.abs(reduction),
    reason,
  };
}

/** Linear ramp from lo (0) to hi (1). */
function ramp(value: number, lo: number, hi: number): number {
  if (value <= lo) return 0;
  if (value >= hi) return 1;
  return (value - lo) / (hi - lo);
}

// ============================================================ COMBAT ======

/**
 * Killaura. Three independent sub-signals, each graded:
 *   a) more than one distinct victim hit within a single 50 ms tick
 *   b) hits accepted with no line of sight (through walls)
 *   c) aim snapping — a huge yaw/pitch change immediately before the hit
 */
export function checkKillaura(
  attacks: AttackSample[],
  net: NetworkState | null,
): EvaluatedSignal[] {
  const adj = networkAdjustment(net);
  if (adj.discard) return [];
  const out: EvaluatedSignal[] = [];
  if (!attacks.length) return out;

  // (a) multi-target in one tick -----------------------------------------
  const buckets = new Map<number, Set<string>>();
  for (const a of attacks) {
    const k = Math.floor(a.t / 50);
    let s = buckets.get(k);
    if (!s) buckets.set(k, (s = new Set()));
    s.add(a.victimId);
  }
  const maxTargets = Math.max(0, ...[...buckets.values()].map((s) => s.size));
  if (maxTargets >= 2) {
    // 2 targets is already implausible; 4+ is decisive.
    const w = ramp(maxTargets, 1, 4);
    out.push(
      sig('killaura', w, { maxTargetsPerTick: maxTargets }, `hit ${maxTargets} distinct players inside one 50ms tick`),
    );
  }

  // (b) no line of sight --------------------------------------------------
  const noLos = attacks.filter((a) => !a.lineOfSight).length;
  if (noLos > 0) {
    const ratio = noLos / attacks.length;
    // A lagging player can desync slightly, so require a real proportion.
    if (ratio >= 0.25 / adj.tolerance || noLos >= 5) {
      out.push(
        sig('killaura', ramp(ratio, 0.15, 0.8), { noLosCount: noLos, total: attacks.length, ratio: +ratio.toFixed(3) },
          `${noLos}/${attacks.length} hits had no line of sight (through-block)`),
      );
    }
  }

  // (c) aim snapping ------------------------------------------------------
  // 60deg was too low a bar: competent flick-shot players routinely rotate
  // 60-90deg between targets, so that threshold flagged clean high-skill PvP.
  // A killaura snap is a near-instant reorientation onto the target, so we use
  // 90deg and additionally require the snaps to be *uniform* in magnitude -
  // machine aim is consistent, human aim is not.
  const snaps = attacks.filter((a) => a.aimDeltaDeg > 90);
  if (snaps.length > 0 && attacks.length >= 3) {
    const ratio = snaps.length / attacks.length;
    const avgDelta = mean(attacks.map((a) => a.aimDeltaDeg));
    const snapCv = coefficientOfVariation(snaps.map((a) => a.aimDeltaDeg));
    // Uniform snaps (low CV) are machine-like; wildly varying snaps are human
    // flicks that happened to be large, so they are discounted.
    const uniformity = snapCv < 0.35 ? 1 : Math.max(0, 1 - (snapCv - 0.35) / 0.45);
    if (ratio >= 0.4 && uniformity > 0) {
      out.push(
        sig('killaura', ramp(ratio, 0.3, 0.95) * uniformity, {
          snapCount: snaps.length,
          avgAimDeltaDeg: Math.round(avgDelta),
          snapCv: +snapCv.toFixed(3),
          uniformity: +uniformity.toFixed(3),
        }, `${snaps.length}/${attacks.length} hits preceded by a >90deg snap (avg ${Math.round(avgDelta)}deg, CV ${snapCv.toFixed(3)})`),
      );
    }
  }

  return out;
}

/** Reach: attacking from further than the latency-adjusted limit. */
export function checkReach(
  attacks: AttackSample[],
  net: NetworkState | null,
): EvaluatedSignal | null {
  const adj = networkAdjustment(net);
  if (adj.discard || !attacks.length) return null;

  const limit = effectiveReachLimit(net);
  const hard = ANTICHEAT.reachHardLimit * adj.tolerance;
  const over = attacks.filter((a) => a.distance > limit);
  if (!over.length) return null;

  const maxDist = Math.max(...over.map((a) => a.distance));
  const ratio = over.length / attacks.length;
  // Only escalates past the hard ceiling; between limit and hard it is weak.
  const w = Math.max(ramp(maxDist, limit, hard + 1.2), ramp(ratio, 0.1, 0.7) * 0.6);
  if (w <= 0) return null;

  return sig('reach', w, {
    maxDistance: +maxDist.toFixed(2),
    limitUsed: +limit.toFixed(2),
    hardLimit: +hard.toFixed(2),
    overCount: over.length,
    total: attacks.length,
  }, `attack distance ${maxDist.toFixed(2)} exceeds latency-adjusted limit ${limit.toFixed(2)}`);
}

/** Collusion / kill farming: two players repeatedly killing each other. */
export function checkCollusion(input: CollusionInput): EvaluatedSignal | null {
  const hot = input.pairs.filter(
    (p) => p.kills >= ANTICHEAT.collusionKillPairs && p.resistTicks < p.kills * 12,
  );
  if (!hot.length) return null;
  const worst = hot.reduce((a, b) => (b.kills > a.kills ? b : a));
  const resistPerKill = worst.resistTicks / Math.max(1, worst.kills);
  return sig('collusion', ramp(worst.kills, ANTICHEAT.collusionKillPairs - 1, 20), {
    pairs: hot.length,
    worstPairKills: worst.kills,
    resistTicksPerKill: +resistPerKill.toFixed(1),
    windowMs: input.windowMs,
  }, `${worst.kills} mutual kills with only ${resistPerKill.toFixed(1)} ticks of resistance each`);
}

// ========================================================== MOVEMENT ======

interface MoveWindow {
  /** Longest unbroken airborne streak, in samples. */
  maxAirStreak: number;
  /** Max horizontal speed observed, blocks/sec. */
  maxSpeed: number;
  /** How many samples exceeded the speed limit. */
  overSpeedSamples: number;
  totalSamples: number;
  /** Samples where the player was inside a solid block while moving. */
  insideBlockSamples: number;
  /** Repeated small upward hops without ever touching ground. */
  hopCount: number;
  /** Client ticking faster than the server expects. */
  timerRatio: number;
}

export function analyseMovement(
  samples: MoveSample[],
  net: NetworkState | null,
): MoveWindow {
  const adj = networkAdjustment(net);
  const speedLimit = effectiveSpeedLimit(ANTICHEAT.sprintJumpSpeed, net);

  let airStreak = 0;
  let maxAirStreak = 0;
  let maxSpeed = 0;
  let overSpeedSamples = 0;
  let insideBlockSamples = 0;
  let hopCount = 0;
  let counted = 0;
  let prevY: number | null = null;
  let rising = false;

  for (const s of samples) {
    // Never judge a sample that arrived after a stall — that is lag, not flight.
    if (isUnreliableSampleGap(s.dtMs, net)) {
      airStreak = 0;
      prevY = null;
      rising = false;
      continue;
    }
    counted++;

    if (s.onGround) {
      maxAirStreak = Math.max(maxAirStreak, airStreak);
      airStreak = 0;
      rising = false;
    } else {
      airStreak++;
    }

    if (s.inBlock && horizontalDistance(s.from, s.to) > 0.01) insideBlockSamples++;

    const dtS = Math.max(s.dtMs, 1) / 1000;
    const speed = horizontalDistance(s.from, s.to) / dtS;
    if (speed > maxSpeed) maxSpeed = speed;
    if (speed > speedLimit) overSpeedSamples++;

    // Jetpack / bunny-hop: keeps rising without ever grounding.
    if (prevY !== null) {
      if (s.to.y > prevY + 0.05) {
        if (!rising) hopCount++;
        rising = true;
      } else if (s.to.y < prevY - 0.05) {
        rising = false;
      }
    }
    prevY = s.to.y;
  }
  maxAirStreak = Math.max(maxAirStreak, airStreak);

  // Timer: if the client delivers ticks much faster than 50ms cadence, it is
  // running a timer. Compare median dt against the expected 50ms.
  const dts = samples.map((s) => s.dtMs).filter((d) => d > 0);
  const medianDt = dts.length ? [...dts].sort((a, b) => a - b)[Math.floor(dts.length / 2)]! : 50;
  const timerRatio = medianDt > 0 ? 50 / medianDt : 1;

  // Latency must make these LESS suspicious, not more.
  const dampen = adj.tolerance;
  return {
    maxAirStreak,
    maxSpeed: maxSpeed / dampen,
    overSpeedSamples: Math.floor(overSpeedSamples / dampen),
    totalSamples: counted,
    insideBlockSamples,
    hopCount,
    timerRatio,
  };
}

export function checkFly(w: MoveWindow, net: NetworkState | null): EvaluatedSignal | null {
  if (w.totalSamples < 10) return null;
  const limit = ANTICHEAT.flyMaxAirTicks * networkAdjustment(net).tolerance;
  const suspicious = ANTICHEAT.flySuspiciousAirTicks * networkAdjustment(net).tolerance;
  if (w.maxAirStreak < suspicious) return null;
  return sig('fly', ramp(w.maxAirStreak, suspicious, limit * 1.5), {
    maxAirStreakTicks: w.maxAirStreak,
    suspiciousAt: Math.round(suspicious),
    hardLimit: Math.round(limit),
    samples: w.totalSamples,
  }, `airborne for ${w.maxAirStreak} consecutive ticks without grounding (limit ${Math.round(limit)})`);
}

export function checkSpeed(w: MoveWindow, net: NetworkState | null): EvaluatedSignal | null {
  if (w.totalSamples < 8 || w.overSpeedSamples === 0) return null;
  const limit = effectiveSpeedLimit(ANTICHEAT.sprintJumpSpeed, net);
  const ratio = w.overSpeedSamples / w.totalSamples;
  // A single burst is a slime block / TNT launch. Sustained excess is not.
  if (ratio < 0.15) return null;
  const magnitude = ramp(w.maxSpeed, limit, limit * 1.5);
  const persistence = ramp(ratio, 0.15, 0.6);
  const weight = Math.min(1, magnitude * 0.6 + persistence * 0.7);
  return sig('speed', weight, {
    maxSpeedBps: +w.maxSpeed.toFixed(2),
    limitBps: +limit.toFixed(2),
    overSamples: w.overSpeedSamples,
    ratio: +ratio.toFixed(3),
  }, `speed ${w.maxSpeed.toFixed(2)} b/s over limit ${limit.toFixed(2)} in ${(ratio * 100).toFixed(0)}% of samples`);
}

export function checkNoClip(w: MoveWindow): EvaluatedSignal | null {
  if (w.totalSamples < 8 || w.insideBlockSamples === 0) return null;
  const ratio = w.insideBlockSamples / w.totalSamples;
  if (ratio < 0.08) return null;
  return sig('noclip', ramp(ratio, 0.08, 0.45), {
    insideBlockSamples: w.insideBlockSamples,
    ratio: +ratio.toFixed(3),
  }, `moved through solid blocks in ${w.insideBlockSamples} samples (${(ratio * 100).toFixed(1)}%)`);
}

export function checkJetpack(w: MoveWindow, net: NetworkState | null): EvaluatedSignal | null {
  if (w.totalSamples < 20) return null;
  const tol = networkAdjustment(net).tolerance;
  const hops = w.hopCount / tol;
  // Legit bunny-hopping produces hops too; require a lot, plus no grounding.
  if (hops < 12 || w.maxAirStreak < ANTICHEAT.flySuspiciousAirTicks) return null;
  return sig('jetpack', ramp(hops, 12, 45), {
    hopCount: w.hopCount,
    maxAirStreakTicks: w.maxAirStreak,
  }, `${w.hopCount} ungrounded upward hops in one window`);
}

/** Timer / fast client: ticks arrive faster than the 50 ms cadence allows. */
export function checkTimer(w: MoveWindow, net: NetworkState | null): EvaluatedSignal | null {
  if (w.totalSamples < 25) return null;
  const tol = networkAdjustment(net).tolerance;
  const ratio = w.timerRatio / tol;
  if (ratio < 1.35) return null;
  return sig('timer', ramp(ratio, 1.35, 1.8), {
    timerRatio: +ratio.toFixed(3),
  }, `client ticking ${ratio.toFixed(2)}x faster than the 50ms server cadence`);
}

// ============================================================ BLOCKS =======

export function checkFastBreak(
  breaks: BlockBreakSample[],
  net: NetworkState | null,
): EvaluatedSignal | null {
  const adj = networkAdjustment(net);
  if (adj.discard) return null;
  const valid = breaks.filter((b) => b.sinceLastBreakMs > 0);
  if (valid.length < 5) return null;

  // Without a suitable tool a block cannot break this fast, legitimately.
  const impossible = valid.filter(
    (b) => !b.toolAdequate && b.sinceLastBreakMs < ANTICHEAT.fastBreakMinMs,
  );
  if (impossible.length === 0) return null;

  const minMs = Math.min(...impossible.map((b) => b.sinceLastBreakMs));
  const ratio = impossible.length / valid.length;
  if (ratio < 0.2) return null;
  return sig('fastbreak', ramp(ratio, 0.2, 0.9), {
    impossibleBreaks: impossible.length,
    total: valid.length,
    minBreakMs: minMs,
    floorMs: ANTICHEAT.fastBreakMinMs,
  }, `${impossible.length}/${valid.length} breaks faster than ${ANTICHEAT.fastBreakMinMs}ms with no adequate tool`);
}

export function checkXray(
  finds: OreFindSample[],
  windowMs: number,
): EvaluatedSignal | null {
  if (finds.length < 6) return null;
  // Use the span the finds actually cover. A caller-supplied window that is
  // wider than the data would dilute the rate and hide a blatant x-ray.
  const ts = finds.map((f) => f.t);
  const spanMs = Math.max(Math.max(...ts) - Math.min(...ts), 1000);
  const minutes = Math.max(Math.min(spanMs, windowMs) / 60_000, 1 / 60);
  const perMin = finds.length / minutes;
  const avgStraight = mean(finds.map((f) => f.pathStraightness));
  const avgExplored = mean(finds.map((f) => f.exploredBlocks));

  // All three must hold: high rate, near-perfectly straight tunnels, and very
  // little exploration. Mining straight down a natural cave is not x-ray.
  if (perMin < ANTICHEAT.xrayOresPerMinute) return null;
  if (avgStraight < ANTICHEAT.xrayStraightnessMin) return null;
  if (avgExplored > 260) return null;

  return sig('xray', ramp(perMin, ANTICHEAT.xrayOresPerMinute, ANTICHEAT.xrayBlatantPerMinute), {
    oresPerMinute: +perMin.toFixed(1),
    avgPathStraightness: +avgStraight.toFixed(3),
    avgExploredBlocks: Math.round(avgExplored),
    findCount: finds.length,
    windowMs,
  }, `${perMin.toFixed(1)} rare ores/min with ${avgStraight.toFixed(2)} tunnel straightness and only ${Math.round(avgExplored)} blocks explored`);
}

// ============================================================ CLICKS ======

/**
 * Autoclicker. Two conditions, because high CPS alone is legitimate
 * (jitter-clicking, drag-clicking, butterfly-clicking are real techniques):
 *   1) rate above the suspicious floor, AND
 *   2) the inter-click interval is mathematically uniform — humans are noisy.
 */
export function checkAutoclick(
  clicks: ClickSample[],
  windowMs: number,
): EvaluatedSignal | null {
  if (clicks.length < 20) return null;
  const ts = clicks.map((c) => c.t).sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i]! - ts[i - 1]!;
    if (d > 0 && d < 2000) intervals.push(d);
  }
  if (intervals.length < 15) return null;

  const cps = (ts.length / Math.max(windowMs, 1)) * 1000;
  const cv = coefficientOfVariation(intervals);
  const avgMs = mean(intervals);
  const minMs = Math.min(...intervals);

  if (cps < ANTICHEAT.cpsSuspicious) return null;
  // Regularity is the real tell. A noisy human at 18 CPS is fine.
  if (cv > ANTICHEAT.cvHuman) return null;

  const regularity = ramp(ANTICHEAT.cvHuman, ANTICHEAT.cvMachineLike, cv) || 1 - ramp(cv, ANTICHEAT.cvMachineLike, ANTICHEAT.cvHuman);
  const rate = ramp(cps, ANTICHEAT.cpsSuspicious, ANTICHEAT.cpsHardLimit * 1.6);
  const w = Math.min(1, Math.max(regularity, 0) * 0.75 + rate * 0.45);
  if (w <= 0) return null;

  return sig('autoclick', w, {
    cps: +cps.toFixed(2),
    coefficientOfVariation: +cv.toFixed(4),
    avgIntervalMs: Math.round(avgMs),
    minIntervalMs: minMs,
    samples: ts.length,
  }, `${cps.toFixed(1)} CPS with CV=${cv.toFixed(4)} (machine-like below ${ANTICHEAT.cvMachineLike})`);
}
