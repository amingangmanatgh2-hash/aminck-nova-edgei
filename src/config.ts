/**
 * Minecraft God Server — central configuration: ranks, game modes, bot tiers,
 * resource preset. Every number here is enforced server-side, never trusted
 * from the client.
 */
import type { BotTierSpec, GameModeSpec, RankSpec, RankId } from './types';

export const APP_NAME = 'Minecraft God Server';
export const BRAND = 'GodMC';

// ------------------------------------------------------------------- ranks
export const RANKS: Record<RankId, RankSpec> = {
  free: {
    id: 'free',
    labelFa: 'رایگان',
    labelEn: 'Free',
    tier: 0,
    tag: '',
    colour: '#9aa7b4',
    priceUsd: null,
    xpThreshold: 0,
    maxPaths: 2,
    permissions: ['play', 'chat'],
    perks: ['lobby-access'],
  },
  noob: {
    id: 'noob',
    labelFa: 'نوب',
    labelEn: 'Noob',
    tier: 1,
    tag: '[نوب]',
    colour: '#8bc34a',
    priceUsd: 99,
    xpThreshold: 1_000,
    maxPaths: 4,
    permissions: ['play', 'chat', 'cosmetic:basic', 'party:create'],
    perks: ['2-home', 'colored-chat'],
  },
  normal: {
    id: 'normal',
    labelFa: 'معمولی',
    labelEn: 'Normal',
    tier: 2,
    tag: '[معمولی]',
    colour: '#03a9f4',
    priceUsd: 249,
    xpThreshold: 5_000,
    maxPaths: 8,
    permissions: ['play', 'chat', 'cosmetic:basic', 'cosmetic:cape', 'party:create', 'queue:priority'],
    perks: ['3-home', 'nick-color', 'queue-skip'],
  },
  pro: {
    id: 'pro',
    labelFa: 'پرو',
    labelEn: 'Pro',
    tier: 3,
    tag: '[پرو]',
    colour: '#9c27b0',
    priceUsd: 499,
    xpThreshold: 20_000,
    maxPaths: 16,
    permissions: ['play', 'chat', 'cosmetic:*', 'party:create', 'queue:priority', 'pet'],
    perks: ['5-home', 'trail-effect', 'monthly-500-gems'],
  },
  god: {
    id: 'god',
    labelFa: 'گاد',
    labelEn: 'God',
    tier: 4,
    tag: '[گاد]',
    colour: '#ffc107',
    priceUsd: 999,
    xpThreshold: 60_000,
    maxPaths: 32,
    permissions: ['play', 'chat', 'cosmetic:*', 'party:create', 'queue:priority', 'pet', 'fly:lobby'],
    perks: ['10-home', 'portal-effect', 'monthly-1500-gems', 'private-game'],
  },
  ultragod: {
    id: 'ultragod',
    labelFa: 'الترا گاد',
    labelEn: 'Ultra God',
    tier: 5,
    tag: '[الترا گاد]',
    colour: '#ff5252',
    priceUsd: 1999,
    xpThreshold: 150_000,
    maxPaths: 64,
    permissions: ['play', 'chat', 'cosmetic:*', 'party:create', 'queue:priority', 'pet', 'fly:lobby', 'beta-features'],
    perks: ['20-home', 'custom-join-message', 'monthly-4000-gems', 'dedicated-slot', 'season-badge'],
  },
};

export const RANK_ORDER: RankId[] = ['free', 'noob', 'normal', 'pro', 'god', 'ultragod'];

export function rankByXp(xp: number): RankId {
  let best: RankId = 'free';
  for (const id of RANK_ORDER) if (xp >= RANKS[id]!.xpThreshold) best = id;
  return best;
}

// -------------------------------------------------------------- game modes
const m = (
  id: string,
  titleFa: string,
  titleEn: string,
  teamSize: number,
  teamCount: number,
  targetDurationS: number,
  botSkills: string[],
  rewards: { win: number; loss: number; kill: number; objective: number },
  coins: { win: number; kill: number },
): GameModeSpec => ({
  id,
  titleFa,
  titleEn,
  teamSize,
  teamCount,
  minPlayers: Math.max(2, Math.floor((teamSize * teamCount) / 3)),
  maxPlayers: teamSize * teamCount,
  targetDurationS,
  rewards,
  coins,
  botSkills,
  icon: `/img/modes/${id}.png`,
  banner: `/img/modes/${id}-banner.png`,
});

export const GAME_MODES: Record<string, GameModeSpec> = Object.fromEntries(
  [
    m('bedwars', 'بدوارز', 'BedWars', 4, 4, 1500, ['build', 'combat', 'objective', 'economy'],
      { win: 500, loss: 120, kill: 40, objective: 90 }, { win: 250, kill: 12 }),
    m('skywars', 'اسکای‌وارز', 'SkyWars', 1, 12, 600, ['combat', 'loot', 'movement'],
      { win: 400, loss: 90, kill: 50, objective: 0 }, { win: 200, kill: 15 }),
    m('survivalgames', 'سروایول گیمز', 'Survival Games', 1, 24, 900, ['combat', 'loot', 'survival'],
      { win: 450, loss: 100, kill: 45, objective: 0 }, { win: 220, kill: 14 }),
    m('tntrun', 'تی‌ان‌تی ران', 'TNT Run', 1, 20, 420, ['movement', 'timing'],
      { win: 300, loss: 70, kill: 0, objective: 30 }, { win: 150, kill: 0 }),
    m('murdermystery', 'مردر میستری', 'Murder Mystery', 1, 12, 600, ['deduction', 'combat', 'stealth'],
      { win: 380, loss: 85, kill: 60, objective: 40 }, { win: 190, kill: 18 }),
    m('parkour', 'پارکور', 'Parkour', 1, 30, 300, ['movement', 'timing'],
      { win: 250, loss: 50, kill: 0, objective: 60 }, { win: 120, kill: 0 }),
    m('buildbattle', 'بیلد بتل', 'Build Battle', 2, 6, 720, ['build', 'creativity'],
      { win: 420, loss: 110, kill: 0, objective: 80 }, { win: 210, kill: 0 }),
    m('spleef', 'اسپلیف', 'Spleef', 1, 16, 360, ['timing', 'movement'],
      { win: 280, loss: 60, kill: 20, objective: 0 }, { win: 140, kill: 8 }),
    m('thebridge', 'بریج', 'The Bridge', 4, 2, 600, ['combat', 'build', 'objective'],
      { win: 440, loss: 105, kill: 40, objective: 70 }, { win: 220, kill: 12 }),
    m('uhc', 'یواچ‌سی', 'UHC', 2, 8, 1800, ['combat', 'survival', 'pvp'],
      { win: 600, loss: 140, kill: 70, objective: 50 }, { win: 300, kill: 20 }),
    m('zombiesurvival', 'زامبی سروایول', 'Zombie Survival', 4, 3, 900, ['combat', 'defense', 'objective'],
      { win: 470, loss: 110, kill: 25, objective: 60 }, { win: 235, kill: 8 }),
    m('kitpvp', 'کیت‌پی‌وی‌پی', 'KitPvP', 1, 24, 0, ['combat', 'pvp'],
      { win: 0, loss: 0, kill: 30, objective: 0 }, { win: 0, kill: 10 }),
    m('duels', 'دوئل', 'Duels', 1, 2, 300, ['combat', 'pvp'],
      { win: 320, loss: 80, kill: 35, objective: 0 }, { win: 160, kill: 0 }),
    m('factions', 'فکشنز لایت', 'Factions Lite', 4, 6, 0, ['build', 'economy', 'strategy', 'combat'],
      { win: 520, loss: 130, kill: 35, objective: 65 }, { win: 260, kill: 11 }),
  ].map((g) => [g.id, g]),
);

export const MODE_IDS = Object.keys(GAME_MODES);

// ---------------------------------------------------------------- bot tiers
/**
 * Adaptive bot intelligence. The tier is chosen from the ELO of the *humans
 * actually present in the match*, not from a constant — see bots/tiering.ts.
 * Cheap models first; escalate as the lobby gets stronger.
 */
export const BOT_TIERS: Record<string, BotTierSpec> = {
  nano: {
    tier: 'nano',
    model: '@cf/meta/llama-3.2-1b-instruct',
    minAvgElo: 0,
    minMaxElo: 0,
    skill: 0.22,
    reactionMs: [420, 900],
    errorRate: 0.38,
  },
  micro: {
    tier: 'micro',
    model: '@cf/meta/llama-3.2-3b-instruct',
    minAvgElo: 1150,
    minMaxElo: 1300,
    skill: 0.41,
    reactionMs: [300, 650],
    errorRate: 0.27,
  },
  small: {
    tier: 'small',
    model: '@cf/meta/llama-3.1-8b-instruct',
    minAvgElo: 1450,
    minMaxElo: 1700,
    skill: 0.63,
    reactionMs: [210, 470],
    errorRate: 0.17,
  },
  pro: {
    tier: 'pro',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    minAvgElo: 1800,
    minMaxElo: 2100,
    skill: 0.84,
    reactionMs: [150, 340],
    errorRate: 0.08,
  },
};

export const BOT_TIER_ORDER = ['nano', 'micro', 'small', 'pro'] as const;

// --------------------------------------------------- low-resource preset
/**
 * CLOUDFLARE_LOW_RESOURCE — conservative defaults for a constrained runtime.
 * These are SAFE STARTING values, not measured optima: no benchmark has been
 * run on Cloudflare Containers yet, so they are explicitly not claimed to be
 * optimal. Tune after real profiling (see docs/FEASIBILITY.md).
 */
export const CLOUDFLARE_LOW_RESOURCE = {
  maxPlayers: 20,
  viewDistance: 6,
  simDistance: 4,
  maxEntitiesPerChunk: 8,
  maxAutoSavePerTick: 4,
  mobSpawnLimit: 35,
  redstoneTickBudgetMs: 10,
  saveIntervalTicks: 6000,
  // Pre-generated worlds only: no chunk generation on player join.
  pregenerateRadiusChunks: 16,
  notes:
    'Starting-point values. NOT benchmark-verified. Do not present as optimal.',
} as const;

// -------------------------------------------------------------- economy
export const ECONOMY = {
  usdToCoins: 1000, // 1 USD => 1000 coins
  dailyLoginCoins: 50,
  referralRewardCoins: 300,
  maxDiscountPct: 30,
  maxBundleDiscountPct: 25,
} as const;

// ----------------------------------------------------------- anti-cheat
export const ANTICHEAT = {
  /** Rolling window over which signals accumulate. */
  windowMs: 5 * 60 * 1000,
  /**
   * Confidence required to reach each action tier.
   * Calibrated against the simulation in test/anticheat-simulation.test.ts:
   * 15 = hidden alert, 40 = match kick, 70 = temporary ban.
   */
  tierThresholds: [0, 15, 40, 70] as [number, number, number, number],
  /** Above this, a temporary ban (never permanent). */
  banThreshold: 70,
  /**
   * A single check can never push a player past this on its own. Set equal to
   * the strongest check's points, so one fully-corroborated impossible-event
   * check can reach a KICK but can never reach a BAN alone.
   */
  singleCheckCap: 55,
  /** Corroborating observations needed before escalation. */
  minSignalsForKick: 2,
  minSignalsForBan: 4,
  minDistinctChecksForKick: 2,
  minDistinctChecksForBan: 2,
  /**
   * Weight at which a physically-impossible check may escalate on its own.
   * Only members of IMPOSSIBLE_CHECKS qualify, and only ever to a kick.
   */
  decisiveWeight: 0.85,
  /** Minecraft-legit reach: 3.0 blocks + tolerance for lag compensation. */
  reachHardLimit: 3.6,
  reachSuspicious: 3.1,
  /** CPS: human upper bound, and the regularity floor. */
  cpsHardLimit: 20,
  cpsSuspicious: 15,
  /** Below this coefficient of variation the clicking is machine-like. */
  cvMachineLike: 0.06,
  cvHuman: 0.16,
  /** Network conditions that REDUCE suspicion. */
  lagPingMs: 180,
  lagPacketLossPct: 4,
  /** Movement speeds (blocks/sec) that are physically plausible. */
  walkSpeed: 4.317,
  sprintSpeed: 5.612,
  sprintJumpSpeed: 7.127,
  speedHardMultiplier: 1.55,
  /** Vertical: how long a player may keep gaining height without ground. */
  flyMaxAirTicks: 30,
  flySuspiciousAirTicks: 18,
  /** FastBreak: min ms per block break by tool-less hand. */
  fastBreakMinMs: 45,
  /** X-ray: ore-per-minute that is suspicious without exploration. */
  xrayOresPerMinute: 22,
  xrayBlatantPerMinute: 40,
  xrayStraightnessMin: 0.93,
  /** Collusion: repeated unopposed kills between the same pair. */
  collusionKillPairs: 8,
  collusionWindowMs: 10 * 60 * 1000,
  /** Temp ban duration when tier 4 fires. */
  tempBanMs: 24 * 60 * 60 * 1000,
  /** Evidence ring buffer, ms of history kept around an incident. */
  evidenceBufferMs: 10_000,
} as const;

// ------------------------------------------------------------------ otp
export const OTP = {
  codeLength: 5,
  ttlMs: 3 * 60 * 1000,
  maxVerifyAttempts: 5,
  maxRequestsPerPhonePerHour: 5,
  maxRequestsPerIpPerHour: 10,
  /** Distinct accounts from one IP inside this window triggers an alert. */
  ipClusterWindowMs: 60 * 60 * 1000,
  ipClusterThreshold: 6,
  /** Minimum delay before a code can be re-requested. */
  resendCooldownMs: 90 * 1000,
} as const;

// --------------------------------------------------------------- session
export const SESSION = {
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  adminTtlMs: 12 * 60 * 60 * 1000,
  loginLockAfter: 10,
  loginLockMs: 15 * 60 * 1000,
  loginDelayMs: 600,
} as const;
