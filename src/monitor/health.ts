/**
 * Server monitoring and automatic recovery.
 *
 * Health status is derived from real observations, never assumed:
 *   - is the container process heartbeating?
 *   - is the game port answering?
 *   - is TPS acceptable?
 *   - is memory near the limit?
 *
 * Recovery is deliberately conservative. A crash-looping server that is
 * restarted blindly can corrupt a world mid-save, so recovery backs off
 * exponentially and gives up after N attempts, leaving the server in ERROR for
 * a human to look at.
 */
import type { ServerStatus } from '../types';
import { newId, now } from '../utils';

export interface Heartbeat {
  serverId: string;
  instanceId: string;
  processAlive: boolean;
  players: number;
  maxPlayers: number;
  tps: number;
  memUsedMb: number;
  memMaxMb: number;
  cpuPercent: number;
  version: string | null;
  motd: string | null;
  worldSavedAt: number | null;
  at: number;
}

export interface HealthConfig {
  /** A heartbeat older than this means the process is gone. */
  staleAfterMs: number;
  /** TPS below this is unhealthy. */
  minTps: number;
  /** Memory above this fraction is critical. */
  memCritical: number;
  memWarning: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  staleAfterMs: 45_000,
  minTps: 15,
  memCritical: 0.92,
  memWarning: 0.8,
};

export interface HealthVerdict {
  status: ServerStatus;
  reason: string;
  /** True when the platform should attempt a restart. */
  shouldRestart: boolean;
  metrics: {
    heartbeatAgeMs: number | null;
    tps: number | null;
    memFraction: number | null;
    players: number | null;
  };
}

export function evaluateHealth(
  hb: Heartbeat | null,
  declaredStatus: ServerStatus,
  cfg: HealthConfig = DEFAULT_HEALTH_CONFIG,
  at = now(),
): HealthVerdict {
  // No heartbeat at all: trust the declared status if it is transitional,
  // otherwise the process is gone.
  if (!hb) {
    if (declaredStatus === 'starting') {
      return verdict('starting', 'no heartbeat yet - container still starting', false, {});
    }
    if (declaredStatus === 'stopping') {
      return verdict('stopping', 'no heartbeat - shutting down', false, {});
    }
    if (declaredStatus === 'offline') {
      return verdict('offline', 'no heartbeat - server is stopped', false, {});
    }
    return verdict('error', 'expected a heartbeat but none arrived', true, {});
  }

  const age = at - hb.at;
  const metrics = {
    heartbeatAgeMs: age,
    tps: hb.tps,
    memFraction: hb.memMaxMb > 0 ? hb.memUsedMb / hb.memMaxMb : null,
    players: hb.players,
  };

  if (!hb.processAlive) {
    return verdict('error', 'container reports the game process is not running', true, metrics);
  }
  if (age > cfg.staleAfterMs) {
    return verdict(
      'error',
      `heartbeat is ${Math.round(age / 1000)}s old (limit ${Math.round(cfg.staleAfterMs / 1000)}s)`,
      true,
      metrics,
    );
  }
  if (hb.tps < cfg.minTps) {
    // Low TPS is a performance problem, not a crash. Flag it, do not restart:
    // restarting a slow server makes it slower for everyone and loses state.
    return verdict('online', `tps ${hb.tps.toFixed(1)} below ${cfg.minTps} - degraded`, false, metrics);
  }
  if (metrics.memFraction !== null && metrics.memFraction >= cfg.memCritical) {
    return verdict(
      'online',
      `memory at ${(metrics.memFraction * 100).toFixed(0)}% - critical, reduce load`,
      false,
      metrics,
    );
  }
  if (metrics.memFraction !== null && metrics.memFraction >= cfg.memWarning) {
    return verdict('online', `memory at ${(metrics.memFraction * 100).toFixed(0)}% - warning`, false, metrics);
  }

  return verdict('online', 'heartbeat fresh, tps and memory nominal', false, metrics);
}

function verdict(
  status: ServerStatus,
  reason: string,
  shouldRestart: boolean,
  metrics: Partial<HealthVerdict['metrics']>,
): HealthVerdict {
  return {
    status,
    reason,
    shouldRestart,
    metrics: {
      heartbeatAgeMs: metrics.heartbeatAgeMs ?? null,
      tps: metrics.tps ?? null,
      memFraction: metrics.memFraction ?? null,
      players: metrics.players ?? null,
    },
  };
}

// -------------------------------------------------------------- recovery
export interface RecoveryState {
  attempts: number;
  lastAttemptAt: number | null;
  gaveUp: boolean;
}

export interface RecoveryDecision {
  action: 'restart' | 'wait' | 'escalate';
  delayMs: number;
  attempt: number;
  reason: string;
  state: RecoveryState;
}

export const RECOVERY = {
  maxAttempts: 4,
  baseDelayMs: 10_000,
  maxDelayMs: 5 * 60_000,
  /** After a successful run of this long, reset the attempt counter. */
  healthyForMs: 10 * 60_000,
};

/**
 * Exponential backoff with a hard stop.
 *
 * Escalating rather than looping forever matters: a server that crashes on
 * world load will do so every time, and endless restarts just burn CPU while
 * hiding the real problem from the operator.
 */
export function decideRecovery(
  state: RecoveryState,
  verdict_: HealthVerdict,
  opts: { lastHealthyAt?: number | null } = {},
  at = now(),
): RecoveryDecision {
  // A long healthy run clears the slate. Both the counter AND the give-up flag
  // must reset together, otherwise a server that recovered once could never be
  // recovered again.
  let attempts = state.attempts;
  let gaveUp = state.gaveUp;
  if (opts.lastHealthyAt && at - opts.lastHealthyAt > RECOVERY.healthyForMs) {
    attempts = 0;
    gaveUp = false;
  }

  if (!verdict_.shouldRestart) {
    return {
      action: 'wait',
      delayMs: 0,
      attempt: attempts,
      reason: verdict_.reason,
      state: { ...state, attempts, gaveUp },
    };
  }

  if (attempts >= RECOVERY.maxAttempts || gaveUp) {
    return {
      action: 'escalate',
      delayMs: 0,
      attempt: attempts,
      reason: `${attempts} consecutive recovery attempts failed - leaving the server in ERROR for manual review`,
      state: { ...state, attempts, gaveUp: true },
    };
  }

  const next = attempts + 1;
  const delayMs = Math.min(RECOVERY.baseDelayMs * 2 ** attempts, RECOVERY.maxDelayMs);
  return {
    action: 'restart',
    delayMs,
    attempt: next,
    reason: `attempt ${next}/${RECOVERY.maxAttempts}, retrying in ${Math.round(delayMs / 1000)}s`,
    state: { attempts: next, lastAttemptAt: at, gaveUp: false },
  };
}

export const healthId = (): string => newId();
