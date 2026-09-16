/**
 * Anti-cheat — evidence capture.
 *
 * Whenever anything is recorded (even a tier-1 log), we snapshot the movement
 * and combat history around the moment. An admin must be able to see the
 * NUMBERS, not just a verdict, before escalating to a permanent ban.
 */
import { ANTICHEAT } from '../config';
import { newId, now } from '../utils';
import type { AttackSample, MoveSample } from './types';
import type { ScoredSignal } from './scoring';

export interface EvidenceBundle {
  id: string;
  playerId: string;
  matchId: string | null;
  serverId: string | null;
  createdAt: number;
  /** ms of history retained either side of the incident. */
  bufferMs: number;
  movement: MoveSample[];
  combat: AttackSample[];
  signals: {
    checkId: string;
    weight: number;
    metrics: Record<string, number | string | boolean>;
    reason: string;
    createdAt: number;
  }[];
  network: Record<string, number | string | boolean>;
  /** Where this bundle is stored (R2 key) once uploaded. */
  r2Key?: string;
}

/**
 * Ring buffer of raw samples per player. Kept deliberately small: we store
 * only ~10s around an incident, not the whole session.
 */
export class EvidenceRing {
  private moves = new Map<string, MoveSample[]>();
  private attacks = new Map<string, AttackSample[]>();
  private readonly windowMs: number;

  constructor(windowMs: number = ANTICHEAT.evidenceBufferMs) {
    this.windowMs = windowMs;
  }

  recordMove(playerId: string, s: MoveSample): void {
    const arr = this.moves.get(playerId) ?? [];
    arr.push(s);
    this.prune(arr, s.t);
    this.moves.set(playerId, arr);
  }

  recordAttack(playerId: string, s: AttackSample): void {
    const arr = this.attacks.get(playerId) ?? [];
    arr.push(s);
    this.prune(arr, s.t);
    this.attacks.set(playerId, arr);
  }

  private prune(arr: { t: number }[], latest: number): void {
    const cutoff = latest - this.windowMs;
    while (arr.length && arr[0]!.t < cutoff) arr.shift();
    // Hard cap so a burst cannot grow memory without bound.
    if (arr.length > 4000) arr.splice(0, arr.length - 4000);
  }

  snapshot(
    playerId: string,
    signals: ScoredSignal[],
    opts: { matchId?: string | null; serverId?: string | null; network?: Record<string, number | string | boolean> } = {},
    at = now(),
  ): EvidenceBundle {
    return {
      id: newId(),
      playerId,
      matchId: opts.matchId ?? null,
      serverId: opts.serverId ?? null,
      createdAt: at,
      bufferMs: this.windowMs,
      movement: [...(this.moves.get(playerId) ?? [])],
      combat: [...(this.attacks.get(playerId) ?? [])],
      signals: signals.map((s) => ({
        checkId: s.checkId,
        weight: +s.weight.toFixed(4),
        metrics: s.metrics,
        reason: s.reason,
        createdAt: s.createdAt,
      })),
      network: opts.network ?? {},
    };
  }

  clear(playerId: string): void {
    this.moves.delete(playerId);
    this.attacks.delete(playerId);
  }

  size(playerId: string): { moves: number; attacks: number } {
    return {
      moves: this.moves.get(playerId)?.length ?? 0,
      attacks: this.attacks.get(playerId)?.length ?? 0,
    };
  }
}

/** Compact, human-readable rendering for the admin panel. */
export function renderEvidence(b: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push(`# Evidence ${b.id} — player ${b.playerId}`);
  lines.push(`captured: ${new Date(b.createdAt).toISOString()} (±${b.bufferMs / 1000}s)`);
  lines.push(`network: ${JSON.stringify(b.network)}`);
  lines.push(``);
  lines.push(`## Signals (${b.signals.length})`);
  for (const s of b.signals) {
    lines.push(`- [${s.checkId}] weight=${s.weight} :: ${s.reason}`);
    lines.push(`    metrics: ${JSON.stringify(s.metrics)}`);
  }
  lines.push(``);
  lines.push(`## Movement (${b.movement.length} samples)`);
  for (const s of b.movement.slice(-40)) {
    lines.push(
      `  t=${s.t} (${s.from.x.toFixed(1)},${s.from.y.toFixed(1)},${s.from.z.toFixed(1)}) -> ` +
        `(${s.to.x.toFixed(1)},${s.to.y.toFixed(1)},${s.to.z.toFixed(1)}) dt=${s.dtMs}ms ground=${s.onGround} inBlock=${s.inBlock}`,
    );
  }
  lines.push(``);
  lines.push(`## Combat (${b.combat.length} hits)`);
  for (const a of b.combat.slice(-40)) {
    lines.push(
      `  t=${a.t} -> ${a.victimId} dist=${a.distance.toFixed(2)} aim=${a.aimDeltaDeg.toFixed(1)}deg los=${a.lineOfSight}`,
    );
  }
  return lines.join('\n');
}
