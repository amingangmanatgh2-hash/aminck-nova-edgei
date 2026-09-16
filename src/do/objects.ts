/**
 * Durable Objects.
 *
 * Three objects, each doing one job:
 *
 *   ServerLock      global mutex so two containers can never run the same
 *                   world at once (world corruption is unrecoverable)
 *   Matchmaker      per-mode queues, bot backfill, and match creation
 *   AntiCheatOracle per-player signal accumulation and evidence storage
 *
 * These hold SMALL hot state only. Anything large (evidence bundles, world
 * snapshots, receipts) goes to R2; anything durable and queryable goes to D1.
 */
import { DurableObject } from 'cloudflare:workers';
import { AntiCheatEngine } from '../anticheat/engine';
import { ANTICHEAT } from '../config';
import { botBackfillCount, chooseTier, createBot } from '../bots/tiering';
import { createMatch, apply } from '../gamemodes/engine';
import type { MatchState } from '../gamemodes/engine';
import { newId, now } from '../utils';

// ============================================================ ServerLock
/**
 * Guarantees a single Minecraft runtime per server id.
 *
 * The container calls acquire() on boot with its instance id. If another
 * instance already holds the lock and is still heartbeating, acquire fails and
 * the new container must exit — two processes writing one world directory
 * corrupts it.
 */
export class ServerLock extends DurableObject {
  private lock: { owner: string; acquiredAt: number; lastHeartbeat: number } | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    void this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<typeof this.lock>('lock');
      this.lock = stored ?? null;
    });
  }

  /** Lease length; a holder must heartbeat inside this window. */
  private static readonly LEASE_MS = 30_000;

  async acquire(owner: string, at = now()): Promise<{ ok: boolean; holder?: string; reason?: string }> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const cur = this.lock;
      if (cur && cur.owner !== owner && at - cur.lastHeartbeat < ServerLock.LEASE_MS) {
        return; // someone else holds a live lease
      }
      this.lock = { owner, acquiredAt: at, lastHeartbeat: at };
      await this.ctx.storage.put('lock', this.lock);
    });
    const cur = this.lock;
    if (!cur || cur.owner !== owner) {
      return { ok: false, holder: cur?.owner, reason: 'lease_held_by_live_instance' };
    }
    return { ok: true };
  }

  async heartbeat(owner: string, at = now()): Promise<{ ok: boolean }> {
    if (!this.lock || this.lock.owner !== owner) return { ok: false };
    if (at - this.lock.lastHeartbeat > ServerLock.LEASE_MS * 3) {
      // Lease lapsed long enough that another instance may have taken over.
      return { ok: false };
    }
    this.lock = { ...this.lock, lastHeartbeat: at };
    await this.ctx.storage.put('lock', this.lock);
    return { ok: true };
  }

  async release(owner: string): Promise<{ ok: boolean }> {
    if (!this.lock || this.lock.owner !== owner) return { ok: false };
    this.lock = null;
    await this.ctx.storage.delete('lock');
    return { ok: true };
  }

  async status(): Promise<{ held: boolean; owner: string | null; ageMs: number; stale: boolean }> {
    const cur = this.lock;
    const age = cur ? now() - cur.lastHeartbeat : 0;
    return {
      held: !!cur,
      owner: cur?.owner ?? null,
      ageMs: age,
      stale: !!cur && age > ServerLock.LEASE_MS,
    };
  }

  /** Force-release. Admin only, and always audited by the caller. */
  async forceRelease(): Promise<{ ok: boolean }> {
    const had = !!this.lock;
    this.lock = null;
    await this.ctx.storage.delete('lock');
    return { ok: had };
  }
}

// =========================================================== Matchmaker
interface QueueEntry {
  refId: string;
  kind: 'human' | 'bot';
  elo: number;
  joinedAt: number;
  partyId?: string;
}

export class Matchmaker extends DurableObject {
  private queues = new Map<string, QueueEntry[]>();
  private matches = new Map<string, MatchState>();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
  }

  async enqueue(modeId: string, e: Omit<QueueEntry, 'joinedAt'>, at = now()): Promise<{ position: number; queueSize: number }> {
    const q = this.queues.get(modeId) ?? [];
    if (!q.some((x) => x.refId === e.refId)) q.push({ ...e, joinedAt: at });
    this.queues.set(modeId, q);
    return { position: q.findIndex((x) => x.refId === e.refId) + 1, queueSize: q.length };
  }

  async dequeue(modeId: string, refId: string): Promise<{ ok: boolean }> {
    const q = this.queues.get(modeId);
    if (!q) return { ok: false };
    const i = q.findIndex((x) => x.refId === refId);
    if (i < 0) return { ok: false };
    q.splice(i, 1);
    return { ok: true };
  }

  async queueState(modeId: string): Promise<{ size: number; entries: QueueEntry[]; avgElo: number }> {
    const q = this.queues.get(modeId) ?? [];
    const avgElo = q.length ? Math.round(q.reduce((a, b) => a + b.elo, 0) / q.length) : 1000;
    return { size: q.length, entries: q, avgElo };
  }

  /**
   * Try to start a match. Pads with bots when humans are waiting but the lobby
   * is short — but never starts a match with zero humans.
   */
  async tryStart(
    modeId: string,
    slots: number,
    at = now(),
  ): Promise<{ started: boolean; matchId?: string; humans: number; bots: number; botTier?: string; reason?: string }> {
    const q = this.queues.get(modeId) ?? [];
    const humans = q.filter((x) => x.kind === 'human');
    if (humans.length === 0) return { started: false, humans: 0, bots: 0, reason: 'no_humans_queued' };

    const botCount = botBackfillCount(humans.length, slots);
    const decision = chooseTier({
      humanElos: humans.map((h) => h.elo),
      slotsNeeded: slots,
    });

    const match = createMatch(modeId, at);
    for (const h of humans) {
      apply(match, { type: 'join', refId: h.refId, kind: 'human', elo: h.elo }, at);
    }
    for (let i = 0; i < botCount; i++) {
      const bot = createBot(match.id, decision, Math.random, at);
      apply(match, { type: 'join', refId: `bot-${bot.id}`, kind: 'bot', elo: bot.eloAssumed }, at);
    }
    apply(match, { type: 'start' }, at);

    this.matches.set(match.id, match);
    this.queues.set(modeId, q.filter((x) => x.kind !== 'human'));

    return {
      started: true,
      matchId: match.id,
      humans: humans.length,
      bots: botCount,
      botTier: decision.tier,
    };
  }

  async applyEvent(matchId: string, event: Parameters<typeof apply>[1], at = now()) {
    const m = this.matches.get(matchId);
    if (!m) return { ok: false, reason: 'unknown_match' as const };
    const res = apply(m, event, at);
    if (m.phase === 'results' || m.phase === 'closed') this.matches.delete(matchId);
    return { ok: true, result: res };
  }

  async matchInfo(matchId: string) {
    const m = this.matches.get(matchId);
    return m
      ? {
          id: m.id,
          mode: m.modeId,
          phase: m.phase,
          players: m.participants.length,
          humans: m.participants.filter((p) => p.kind === 'human').length,
          bots: m.participants.filter((p) => p.kind === 'bot').length,
        }
      : null;
  }

  async activeMatches() {
    return [...this.matches.values()].map((m) => ({
      id: m.id,
      mode: m.modeId,
      phase: m.phase,
      players: m.participants.length,
    }));
  }
}

// ======================================================= AntiCheatOracle
/**
 * Per-player anti-cheat state.
 *
 * The engine itself is pure; this object gives it persistence and a home, and
 * enforces the one rule that must never be violated: an automatic decision is
 * never a permanent ban.
 */
export class AntiCheatOracle extends DurableObject {
  private engine = new AntiCheatEngine();
  private lastActionAt = 0;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
  }

  async evaluate(input: Parameters<AntiCheatEngine['evaluate']>[0]) {
    const res = this.engine.evaluate(input);
    if (res.decision.tier >= 3) this.lastActionAt = now();
    return res;
  }

  /** Exposed so the admin panel can render the ladder state. */
  async snapshot(playerId: string) {
    return {
      playerId,
      signals: this.engine.recentSignals(playerId),
      evidenceSize: this.engine.ring.size(playerId),
      lastActionAt: this.lastActionAt,
      windowMs: ANTICHEAT.windowMs,
    };
  }

  /** Called after a successful appeal or at match end. */
  async reset(playerId: string): Promise<{ ok: boolean }> {
    this.engine.reset(playerId);
    this.lastActionAt = 0;
    return { ok: true };
  }

  /**
   * Record the outcome of an action. `permanent` is refused here as well as in
   * the scoring layer, so there is no path to an automatic permanent ban even
   * if a caller lies about the tier.
   */
  async recordAction(a: { playerId: string; tier: number; action: string; permanent?: boolean }) {
    if (a.permanent) {
      return { recorded: false, reason: 'permanent_bans_require_manual_admin_confirmation' };
    }
    await this.ctx.storage.put(`action:${a.playerId}:${newId()}`, {
      tier: a.tier,
      action: a.action,
      at: now(),
    });
    return { recorded: true };
  }
}
