/**
 * Anti-cheat — input event contracts.
 *
 * The server plugin streams these; the engine never trusts a raw client claim,
 * only derived numeric measurements.
 */
import type { CheatCheckId } from '../types';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One sampled tick of a player's movement. */
export interface MoveSample {
  t: number; // ms epoch
  from: Vec3;
  to: Vec3;
  onGround: boolean;
  /** True if the client claims to be colliding with a block. */
  inBlock: boolean;
  /** Server-side tick delta since the previous sample. */
  dtMs: number;
}

export interface AttackSample {
  t: number;
  attackerId: string;
  victimId: string;
  /** Distance at the moment the server accepted the hit. */
  distance: number;
  /** Yaw/pitch delta the player made in the tick before the hit. */
  aimDeltaDeg: number;
  /** Whether a block ray between attacker and victim is unobstructed. */
  lineOfSight: boolean;
  /** Victim's bounding box; used for hitbox-legitimacy checks. */
  victimOnGround: boolean;
}

export interface BlockBreakSample {
  t: number;
  playerId: string;
  material: string;
  /** ms between the previous accepted break by the same player. */
  sinceLastBreakMs: number;
  x: number;
  y: number;
  z: number;
  /** Whether the player had a tool that could break this in that time. */
  toolAdequate: boolean;
}

export interface OreFindSample {
  t: number;
  playerId: string;
  /** Rare ore exposed by the break. */
  material: string;
  /** Straightness of the tunnel leading here, 0..1. */
  pathStraightness: number;
  /** How many blocks the player actually explored to get here. */
  exploredBlocks: number;
  y: number;
}

export interface ClickSample {
  t: number;
  playerId: string;
}

/** Measured network state for a player, from the server's own observations. */
export interface NetworkState {
  /** Smoothed round-trip time in ms. */
  pingMs: number;
  /** Rolling maximum, to catch spikes. */
  pingMaxMs: number;
  /** 0..100 */
  packetLossPct: number;
  /** True if a large position correction just happened (rubber-band). */
  resyncedRecently: boolean;
  /** ms since the last resync / teleport-back. */
  msSinceResync: number;
  /** Country hint from the edge, used for Iran-specific calibration. */
  region?: string;
}

export interface PlayerCombatStats {
  playerId: string;
  /** [attackerId, victimId, count] style pairs are handled in checks. */
  killsLast10m: number;
  deathsLast10m: number;
}

export interface CollusionInput {
  pairs: { a: string; b: string; kills: number; resistTicks: number }[];
  windowMs: number;
}

export interface EvaluatedSignal {
  checkId: CheatCheckId;
  /** 0..1 raw suspicion for this single observation. */
  weight: number;
  metrics: Record<string, number | string | boolean>;
  /** >=0 reduces suspicion (lag), applied additively to the case score. */
  networkAdjustment: number;
  /** Human-readable reason, shown in the admin evidence view. */
  reason: string;
}

export const NO_SIGNAL: EvaluatedSignal | null = null;
