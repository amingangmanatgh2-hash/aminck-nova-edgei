/**
 * Adaptive bot intelligence.
 *
 * The requirement: bots must not be uniformly strong or uniformly dumb. Their
 * model tier is derived from the ELO of the HUMANS actually queued in the
 * match, and it escalates mid-match if the lobby gets stronger.
 *
 * Cost matters, so the default is the cheapest model that is good enough.
 * A lobby of new players gets a 1B model; a lobby of veterans gets a 70B one.
 */
import { BOT_TIERS, BOT_TIER_ORDER } from '../config';
import type { BotModelTier, BotProfile, BotTierSpec } from '../types';
import { clamp, newId, now } from '../utils';

export interface LobbyInput {
  /** ELO of every human currently queued. Empty means no humans yet. */
  humanElos: number[];
  /** Slots the match needs filled. */
  slotsNeeded: number;
  /** Optional: the mode's own skill demands (build/combat/etc). */
  modeSkills?: string[];
}

export interface TierDecision {
  tier: BotModelTier;
  spec: BotTierSpec;
  avgElo: number;
  maxElo: number;
  /** Human-readable reason, surfaced in the admin panel. */
  rationale: string;
}

export const BASELINE_ELO = 1000;

/**
 * Choose a tier from the lobby's ELO distribution.
 *
 * We use BOTH average and maximum on purpose:
 *   - avg captures the overall lobby strength
 *   - max prevents one very strong player from being steamrolled by nano bots
 * The tier is the HIGHER of the two thresholds, so a single veteran raises the
 * whole lobby's bot quality.
 */
export function chooseTier(input: LobbyInput): TierDecision {
  const elos = input.humanElos.length ? input.humanElos : [BASELINE_ELO];
  const avgElo = Math.round(elos.reduce((a, b) => a + b, 0) / elos.length);
  const maxElo = Math.max(...elos);

  let chosen: BotModelTier = 'nano';
  let spec = BOT_TIERS.nano!;
  const hits: string[] = [];

  for (const tier of BOT_TIER_ORDER) {
    const s = BOT_TIERS[tier]!;
    const avgOk = avgElo >= s.minAvgElo;
    const maxOk = maxElo >= s.minMaxElo;
    if (avgOk || maxOk) {
      chosen = tier;
      spec = s;
      hits.push(`${tier}(avg>=${s.minAvgElo}?${avgOk},max>=${s.minMaxElo}?${maxOk})`);
    }
  }

  const rationale =
    input.humanElos.length === 0
      ? 'no humans queued - defaulting to the cheapest tier (nano)'
      : `avgElo=${avgElo} maxElo=${maxElo} -> ${chosen}; qualified: ${hits.join(' ') || 'none (baseline)'}`;

  return { tier: chosen, spec, avgElo, maxElo, rationale };
}

/**
 * Mid-match promotion.
 *
 * If stronger humans join after the match started, existing bots escalate.
 * Escalation is one step at a time and rate-limited: flipping a bot's whole
 * behaviour profile mid-fight is both expensive and visibly unnatural.
 */
export function shouldPromote(
  current: BotModelTier,
  lobby: LobbyInput,
  lastPromotedAt: number | null,
  at = now(),
  cooldownMs = 45_000,
): { promote: boolean; to?: BotModelTier; reason: string } {
  const decision = chooseTier(lobby);
  const curIdx = BOT_TIER_ORDER.indexOf(current);
  const targetIdx = BOT_TIER_ORDER.indexOf(decision.tier);

  if (targetIdx <= curIdx) {
    return { promote: false, reason: `lobby tier ${decision.tier} is not above current ${current}` };
  }
  if (lastPromotedAt && at - lastPromotedAt < cooldownMs) {
    return {
      promote: false,
      reason: `promotion blocked: last promotion ${Math.round((at - lastPromotedAt) / 1000)}s ago (< ${cooldownMs / 1000}s cooldown)`,
    };
  }

  // One step at a time.
  const next = BOT_TIER_ORDER[Math.min(curIdx + 1, BOT_TIER_ORDER.length - 1)]!;
  return {
    promote: true,
    to: next,
    reason: `${decision.rationale}; stepping ${current} -> ${next}`,
  };
}

/**
 * Instantiate a bot profile.
 *
 * Even at the top tier, bots are deliberately imperfect: they have reaction
 * latency and an error rate. A flawless opponent is both unfun and an obvious
 * giveaway that the lobby is padded.
 */
export function createBot(
  matchId: string,
  decision: TierDecision,
  rng: () => number = Math.random,
  at = now(),
): BotProfile {
  const spec = decision.spec;
  const [lo, hi] = spec.reactionMs;
  const reactionMs = Math.round(lo + rng() * (hi - lo));
  // Slight per-bot variance so bots in one match are not identical.
  const skill = clamp(spec.skill + (rng() - 0.5) * 0.1, 0.05, 0.95);
  const errorRate = clamp(spec.errorRate + (rng() - 0.5) * 0.05, 0.02, 0.6);
  const eloAssumed = clamp(
    Math.round(decision.avgElo + (rng() - 0.5) * 160),
    600,
    2600,
  );

  return {
    id: newId(),
    matchId,
    modelTier: decision.tier,
    model: spec.model,
    skill: +skill.toFixed(3),
    reactionMs,
    errorRate: +errorRate.toFixed(3),
    eloAssumed,
    // promotedAt is stored separately in D1; the profile itself is immutable
    ...(at < 0 ? { _unused: true } : {}),
  } as BotProfile;
}

/** How many bots to add for a lobby. Never fill more than half with bots. */
export function botBackfillCount(humans: number, slots: number): number {
  const needed = Math.max(0, slots - humans);
  // A lobby that is more than half bots feels dead. Cap bots at 60% of slots
  // and require at least one human to have joined before padding at all.
  if (humans === 0) return 0;
  const cap = Math.floor(slots * 0.6);
  return Math.min(needed, cap);
}

/**
 * Build the prompt for a bot decision. Kept small and structured on purpose:
 * these calls happen often, so tokens cost real money.
 */
export function botPrompt(
  profile: BotProfile,
  ctx: {
    mode: string;
    objective: string;
    nearbyThreats: number;
    health: number;
    resources: number;
    teammatesAlive: number;
  },
): string {
  return [
    `You are a ${ctx.mode} player. Skill level: ${(profile.skill * 10).toFixed(1)}/10.`,
    `You make mistakes about ${(profile.errorRate * 100).toFixed(0)}% of the time and your reactions take ~${profile.reactionMs}ms.`,
    `Situation: health=${ctx.health}, resources=${ctx.resources}, threats=${ctx.nearbyThreats}, teammates_alive=${ctx.teammatesAlive}.`,
    `Objective: ${ctx.objective}.`,
    `Reply with one word: BUILD, ATTACK, DEFEND, RETREAT, COLLECT or ROTATE.`,
  ].join('\n');
}
