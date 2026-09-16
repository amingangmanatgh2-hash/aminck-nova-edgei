/**
 * Anti-cheat — network calibration.
 *
 * THE MOST IMPORTANT FILE FOR FAIRNESS. Iranian connections routinely show
 * 150-350 ms RTT, jitter, packet loss and rubber-banding. None of that is
 * cheating, and none of it may raise a player's suspicion score. This module
 * converts measured network state into (a) a suspicion *reduction* and (b)
 * relaxed physical thresholds.
 */
import { ANTICHEAT } from '../config';
import type { NetworkState } from './types';

export interface NetworkAdjustment {
  /** Subtracted from the accumulated suspicion score (positive number). */
  reduction: number;
  /** Multiplier applied to physical thresholds; >1 means more lenient. */
  tolerance: number;
  /** True when the observation should be dropped entirely. */
  discard: boolean;
  reasons: string[];
}

const NEUTRAL: NetworkAdjustment = {
  reduction: 0,
  tolerance: 1,
  discard: false,
  reasons: [],
};

/**
 * High latency inflates apparent reach and apparent speed because the client's
 * view of the world is stale. We widen thresholds proportionally, and cap the
 * widening so it cannot be abused as a free pass.
 */
export function networkAdjustment(net: NetworkState | null | undefined): NetworkAdjustment {
  if (!net) return NEUTRAL;

  const reasons: string[] = [];
  let tolerance = 1;
  let reduction = 0;
  let discard = false;

  const ping = net.pingMs ?? 0;
  const pingMax = net.pingMaxMs ?? ping;
  const loss = net.packetLossPct ?? 0;

  // --- latency: widen thresholds, never add suspicion ---------------------
  if (ping >= ANTICHEAT.lagPingMs) {
    // 180ms -> 1.12x, 350ms -> 1.33x, hard cap 1.45x
    const t = 1 + Math.min((ping - ANTICHEAT.lagPingMs) / 900, 0.45);
    tolerance = Math.max(tolerance, t);
    reasons.push(`ping=${Math.round(ping)}ms => tolerance x${t.toFixed(2)}`);
    reduction += Math.min((ping - ANTICHEAT.lagPingMs) / 40, 8);
  }

  // --- jitter: a large gap between smoothed and peak RTT means the player's
  //     apparent position is unreliable.
  if (pingMax - ping > 120) {
    tolerance = Math.max(tolerance, 1.2);
    reasons.push(`jitter=${Math.round(pingMax - ping)}ms => tolerance raised`);
    reduction += 2;
  }

  // --- packet loss: dropped movement packets look like teleporting.
  if (loss >= ANTICHEAT.lagPacketLossPct) {
    tolerance = Math.max(tolerance, 1 + Math.min(loss / 40, 0.35));
    reduction += Math.min(loss / 2, 10);
    reasons.push(`packetLoss=${loss.toFixed(1)}% => suspicion reduced`);
  }

  // --- rubber-banding: the server just corrected the player's position.
  //     Any movement signal in the seconds after that is meaningless.
  if (net.resyncedRecently || net.msSinceResync < 4000) {
    discard = true;
    reasons.push(`resync ${Math.round(net.msSinceResync)}ms ago => movement evidence discarded`);
  }

  // --- Iran / high-latency region: a small standing benefit of the doubt.
  if (net.region && /^(ir|iran)$/i.test(net.region)) {
    tolerance = Math.max(tolerance, 1.08);
    reduction += 3;
    reasons.push('region=IR baseline latency allowance');
  }

  return { reduction: Math.round(reduction * 100) / 100, tolerance, discard, reasons };
}

/**
 * Effective reach limit for a player, accounting for latency. Vanilla is 3.0
 * blocks; servers allow ~3.0-3.2. We add ~1 block per 250 ms over baseline,
 * capped, because a lagging client's hit registration is genuinely delayed.
 */
export function effectiveReachLimit(net: NetworkState | null | undefined): number {
  const adj = networkAdjustment(net);
  const ping = net?.pingMs ?? 0;
  const latencyAllowance = Math.min(Math.max(ping - 100, 0) / 250, 0.8);
  return Math.min(
    (ANTICHEAT.reachSuspicious + latencyAllowance) * adj.tolerance,
    ANTICHEAT.reachHardLimit + 0.6,
  );
}

/** Effective max plausible ground speed, widened by network tolerance. */
export function effectiveSpeedLimit(
  base: number,
  net: NetworkState | null | undefined,
): number {
  const adj = networkAdjustment(net);
  return base * ANTICHEAT.speedHardMultiplier * adj.tolerance;
}

/**
 * Movement samples arriving after a long gap are the classic false positive:
 * a lag spike or a client freeze makes the player look like they teleported.
 * Anything with a gap beyond this is not movement evidence.
 */
export function isUnreliableSampleGap(dtMs: number, net: NetworkState | null | undefined): boolean {
  const ping = net?.pingMs ?? 0;
  const budget = 1200 + ping * 3 + (net?.packetLossPct ?? 0) * 40;
  return dtMs > budget;
}

export function describeNetwork(net: NetworkState | null | undefined): string {
  if (!net) return 'no network telemetry';
  return `ping=${Math.round(net.pingMs)}ms max=${Math.round(net.pingMaxMs)}ms loss=${(net.packetLossPct ?? 0).toFixed(1)}% resync=${net.resyncedRecently ? 'yes' : 'no'}`;
}
