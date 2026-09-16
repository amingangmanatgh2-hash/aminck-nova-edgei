/**
 * Anti-cheat — engine.
 *
 * Stateless core: feed it samples plus network state, get back signals and a
 * tier decision. The Durable Object (AntiCheatOracle in src/index.ts) holds
 * per-player state and persists results; this file is pure so it can be
 * simulated exhaustively in tests.
 */
import { ANTICHEAT } from '../config';
import type { ActionTier, CheatCheckId } from '../types';
import {
  analyseMovement,
  checkAutoclick,
  checkCollusion,
  checkFastBreak,
  checkFly,
  checkJetpack,
  checkKillaura,
  checkNoClip,
  checkReach,
  checkSpeed,
  checkTimer,
  checkXray,
} from './checks';
import { EvidenceRing, type EvidenceBundle } from './evidence';
import { describeNetwork, networkAdjustment } from './network';
import { buildCaseSummary, scoreAndDecide, toScored, type ScoredSignal, type TierDecision } from './scoring';
import type {
  AttackSample,
  BlockBreakSample,
  ClickSample,
  CollusionInput,
  EvaluatedSignal,
  MoveSample,
  NetworkState,
  OreFindSample,
} from './types';

export interface EvaluationInput {
  playerId: string;
  matchId?: string | null;
  serverId?: string | null;
  movements?: MoveSample[];
  attacks?: AttackSample[];
  breaks?: BlockBreakSample[];
  ores?: OreFindSample[];
  oreWindowMs?: number;
  clicks?: ClickSample[];
  clickWindowMs?: number;
  collusion?: CollusionInput;
  network?: NetworkState | null;
  /** Positive number = benefit of the doubt from a clean history. */
  standingCredit?: number;
  at?: number;
}

export interface EvaluationResult {
  playerId: string;
  signals: ScoredSignal[];
  decision: TierDecision;
  evidence: EvidenceBundle | null;
  networkDescription: string;
  at: number;
}

export class AntiCheatEngine {
  readonly ring = new EvidenceRing();
  private history = new Map<string, ScoredSignal[]>();

  /** Ingest raw movement/combat so evidence always exists. */
  ingest(playerId: string, moves: MoveSample[] = [], attacks: AttackSample[] = []): void {
    for (const m of moves) this.ring.recordMove(playerId, m);
    for (const a of attacks) this.ring.recordAttack(playerId, a);
  }

  evaluate(input: EvaluationInput): EvaluationResult {
    const at = input.at ?? Date.now();
    const net = input.network ?? null;
    const adj = networkAdjustment(net);

    const raw: EvaluatedSignal[] = [];

    // Movement-derived checks share one pass over the samples.
    const moves = input.movements ?? [];
    if (moves.length) {
      const w = analyseMovement(moves, net);
      for (const c of [
        checkFly(w, net),
        checkSpeed(w, net),
        checkNoClip(w),
        checkJetpack(w, net),
        checkTimer(w, net),
      ]) {
        if (c) raw.push(c);
      }
    }

    // Combat checks.
    const attacks = input.attacks ?? [];
    if (attacks.length) {
      raw.push(...checkKillaura(attacks, net));
      const reach = checkReach(attacks, net);
      if (reach) raw.push(reach);
    }

    if (input.breaks?.length) {
      const fb = checkFastBreak(input.breaks, net);
      if (fb) raw.push(fb);
    }

    if (input.ores?.length) {
      const x = checkXray(input.ores, input.oreWindowMs ?? ANTICHEAT.windowMs);
      if (x) raw.push(x);
    }

    if (input.clicks?.length) {
      const ac = checkAutoclick(input.clicks, input.clickWindowMs ?? 1000);
      if (ac) raw.push(ac);
    }

    if (input.collusion) {
      const co = checkCollusion(input.collusion);
      if (co) raw.push(co);
    }

    // Movement evidence is worthless right after a rubber-band resync.
    const usable = adj.discard
      ? raw.filter((s) => s.checkId !== 'fly' && s.checkId !== 'speed' && s.checkId !== 'noclip' && s.checkId !== 'jetpack')
      : raw;

    const signals = usable.map((s) => toScored(input.playerId, s, at));

    // Accumulate with the player's recent history so repeated checks build up.
    const prev = this.history.get(input.playerId) ?? [];
    const all = [...prev, ...signals].filter((s) => at - s.createdAt < ANTICHEAT.windowMs);
    this.history.set(input.playerId, all);

    const networkReduction =
      adj.reduction + usable.reduce((a, s) => a + Math.abs(Math.min(0, s.networkAdjustment)), 0);

    const decision = scoreAndDecide({
      signals: all,
      at,
      networkReduction,
      standingCredit: input.standingCredit ?? 0,
    });

    // Anything tier 2+ gets evidence captured, so an admin can always review.
    let evidence: EvidenceBundle | null = null;
    if (all.length) {
      this.ingest(input.playerId, moves, attacks);
      evidence = this.ring.snapshot(input.playerId, all, {
        matchId: input.matchId ?? null,
        serverId: input.serverId ?? null,
        network: {
          description: describeNetwork(net),
          ...(net
            ? {
                pingMs: Math.round(net.pingMs),
                pingMaxMs: Math.round(net.pingMaxMs),
                packetLossPct: net.packetLossPct ?? 0,
                resynced: net.resyncedRecently ? 1 : 0,
              }
            : {}),
          adjustment: adj.reduction,
          tolerance: +adj.tolerance.toFixed(3),
          discarded: adj.discard ? 1 : 0,
        },
      }, at);
    }

    return {
      playerId: input.playerId,
      signals,
      decision,
      evidence,
      networkDescription: describeNetwork(net),
      at,
    };
  }

  /** Clear accumulated state (on match end / on successful appeal). */
  reset(playerId: string): void {
    this.history.delete(playerId);
    this.ring.clear(playerId);
  }

  recentSignals(playerId: string): ScoredSignal[] {
    return this.history.get(playerId) ?? [];
  }
}

export type { ActionTier, CheatCheckId, TierDecision };
