/**
 * Anti-cheat simulation fixtures.
 *
 * Generates realistic player behaviour for both clean and cheating profiles.
 * The point is not to flatter the engine: several clean profiles here are
 * deliberately adversarial for a naive detector (legit jitter-clickers,
 * laggy Iranian connections, efficient miners, sharp PvP aimers).
 */
import type {
  AttackSample,
  BlockBreakSample,
  ClickSample,
  CollusionInput,
  MoveSample,
  NetworkState,
  OreFindSample,
} from '../../src/anticheat/types';

export type ProfileKind =
  | 'clean-normal'
  | 'clean-jitterclicker'
  | 'clean-laggy-ir'
  | 'clean-pro-aimer'
  | 'clean-builder'
  | 'clean-efficient-miner'
  | 'clean-knockback-burst'
  | 'cheat-killaura'
  | 'cheat-fly'
  | 'cheat-speed'
  | 'cheat-noclip'
  | 'cheat-reach'
  | 'cheat-autoclick'
  | 'cheat-xray'
  | 'cheat-fastbreak'
  | 'cheat-timer'
  | 'cheat-jetpack'
  | 'cheat-collusion';

export interface SimScenario {
  kind: ProfileKind;
  isCheater: boolean;
  label: string;
  network: NetworkState;
  movements: MoveSample[];
  attacks: AttackSample[];
  breaks: BlockBreakSample[];
  ores: OreFindSample[];
  clicks: ClickSample[];
  collusion?: CollusionInput;
}

// ------------------------------------------------------------- tiny rng
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const gauss = (rng: () => number): number => {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const TICK = 50;

// -------------------------------------------------------------- networks
const NET_GOOD: NetworkState = {
  pingMs: 45,
  pingMaxMs: 70,
  packetLossPct: 0,
  resyncedRecently: false,
  msSinceResync: 60_000,
  region: 'EU',
};

/** Typical bad-but-legit Iranian connection. */
const NET_IR_LAGGY: NetworkState = {
  pingMs: 265,
  pingMaxMs: 520,
  packetLossPct: 7.5,
  resyncedRecently: false,
  msSinceResync: 30_000,
  region: 'IR',
};

/** Mid-fight rubber-band — the classic false-positive generator. */
const NET_IR_RESYNC: NetworkState = {
  pingMs: 310,
  pingMaxMs: 900,
  packetLossPct: 14,
  resyncedRecently: true,
  msSinceResync: 800,
  region: 'IR',
};

// ------------------------------------------------------------- movement
interface MoveOpts {
  ticks: number;
  speedBps: number; // target horizontal speed
  jumpEvery?: number;
  groundFraction: number;
  inBlockFraction?: number;
  rng: () => number;
  /** Insert occasional large gaps (stalls) to mimic lag. */
  stallEvery?: number;
  rising?: boolean;
  timerRatio?: number;
}

function buildMoves(o: MoveOpts, t0: number): MoveSample[] {
  const out: MoveSample[] = [];
  let x = 0;
  let y = 64;
  let z = 0;
  const dt = TICK / (o.timerRatio ?? 1);
  for (let i = 0; i < o.ticks; i++) {
    const stall = o.stallEvery && i % o.stallEvery === 0 && i > 0;
    const dtMs = stall ? 2500 + o.rng() * 2000 : dt;
    const jitter = 1 + gauss(o.rng) * 0.08;
    const step = (o.speedBps * (dtMs / 1000)) * jitter;
    const dir = o.rng() * Math.PI * 2;
    const nx = x + Math.cos(dir) * step;
    const nz = z + Math.sin(dir) * step;

    const shouldJump = o.jumpEvery ? i % o.jumpEvery === 0 : false;
    const ny = o.rising ? y + 0.35 : shouldJump ? y + 1.0 : o.groundFraction > o.rng() ? 64 : y;

    out.push({
      t: t0 + i * TICK,
      from: { x, y, z },
      to: { x: nx, y: ny, z: nz },
      onGround: o.groundFraction > o.rng(),
      inBlock: (o.inBlockFraction ?? 0) > o.rng(),
      dtMs,
    });
    x = nx;
    y = o.rising ? ny : shouldJump ? 64 : ny;
    z = nz;
  }
  return out;
}

// --------------------------------------------------------------- attacks
interface AttackOpts {
  ticks: number;
  cps: number;
  distance: number;
  victims: string[];
  aimDelta: [number, number];
  /** Fraction of hits with a clear line of sight. */
  losTrue: number;
  rng: () => number;
  /**
   * When set, every 50ms bucket gets this many hits on DISTINCT victims —
   * the physical signature of killaura (one swing, several targets).
   */
  multiTargetPerTick?: number;
  /** Normal play rotates target only every few swings. */
  targetRotateEvery?: number;
}

function buildAttacks(o: AttackOpts, t0: number): AttackSample[] {
  const out: AttackSample[] = [];
  const interval = 1000 / o.cps;
  const duration = o.ticks * TICK;

  const emit = (t: number, victimId: string): void => {
    out.push({
      t,
      attackerId: 'p',
      victimId,
      distance: o.distance * (1 + gauss(o.rng) * 0.06),
      aimDeltaDeg: o.aimDelta[0] + o.rng() * (o.aimDelta[1] - o.aimDelta[0]),
      lineOfSight: o.rng() < o.losTrue,
      victimOnGround: true,
    });
  };

  if (o.multiTargetPerTick && o.multiTargetPerTick > 1) {
    // One 50ms bucket => several distinct victims. This is what killaura does.
    for (let bucket = 0; bucket * TICK < duration; bucket++) {
      for (let k = 0; k < o.multiTargetPerTick; k++) {
        emit(t0 + bucket * TICK + k * 4, o.victims[k % o.victims.length]!);
      }
    }
    return out;
  }

  const rotate = o.targetRotateEvery ?? 4;
  const n = Math.floor(duration / interval);
  for (let i = 0; i < n; i++) {
    emit(t0 + i * interval, o.victims[Math.floor(i / rotate) % o.victims.length]!);
  }
  return out;
}

// ---------------------------------------------------------------- clicks
function buildClicks(cps: number, seconds: number, rng: () => number, cv: number, t0: number): ClickSample[] {
  const out: ClickSample[] = [];
  const mean = 1000 / cps;
  const n = Math.floor(cps * seconds);
  let t = t0;
  for (let i = 0; i < n; i++) {
    out.push({ t, playerId: 'p' });
    // cv controls how machine-like the interval pattern is.
    t += Math.max(8, mean * (1 + gauss(rng) * cv));
  }
  return out;
}

// ----------------------------------------------------------------- builds
function buildBreaks(
  o: { count: number; minMs: number; toolAdequate: boolean; rng: () => number },
  t0: number,
): BlockBreakSample[] {
  const out: BlockBreakSample[] = [];
  let t = t0;
  for (let i = 0; i < o.count; i++) {
    t += o.minMs * (1 + o.rng() * 0.6);
    out.push({
      t,
      playerId: 'p',
      material: 'stone',
      sinceLastBreakMs: o.minMs * (1 + o.rng() * 0.6),
      x: Math.floor(o.rng() * 16),
      y: 20 + Math.floor(o.rng() * 40),
      z: Math.floor(o.rng() * 16),
      toolAdequate: o.toolAdequate,
    });
  }
  return out;
}

function buildOres(
  o: { count: number; minutes: number; straightness: number; explored: number; rng: () => number },
  t0: number,
): OreFindSample[] {
  const out: OreFindSample[] = [];
  const step = (o.minutes * 60_000) / Math.max(o.count, 1);
  for (let i = 0; i < o.count; i++) {
    out.push({
      t: t0 + i * step,
      playerId: 'p',
      material: 'diamond_ore',
      pathStraightness: o.straightness * (1 - o.rng() * 0.02),
      exploredBlocks: Math.round(o.explored * (1 + o.rng() * 0.2)),
      y: 12 + Math.floor(o.rng() * 4),
    });
  }
  return out;
}

// ================================================================ factory
export function buildScenario(kind: ProfileKind, seed: number): SimScenario {
  const rng = makeRng(seed * 7919 + 13);
  const t0 = 1_700_000_000_000;
  const base: SimScenario = {
    kind,
    isCheater: kind.startsWith('cheat-'),
    label: kind,
    network: NET_GOOD,
    movements: [],
    attacks: [],
    breaks: [],
    ores: [],
    clicks: [],
  };

  switch (kind) {
    // ---------------------------------------------------------- CLEAN
    case 'clean-normal':
      return {
        ...base,
        label: 'Casual player, good connection',
        movements: buildMoves({ ticks: 200, speedBps: 4.2, jumpEvery: 30, groundFraction: 0.9, rng }, t0),
        attacks: buildAttacks({ ticks: 200, cps: 6, distance: 2.4, victims: ['v1'], aimDelta: [5, 25], losTrue: 0.99, rng }, t0),
        breaks: buildBreaks({ count: 40, minMs: 320, toolAdequate: true, rng }, t0),
        clicks: buildClicks(6, 10, rng, 0.35, t0),
      };

    case 'clean-jitterclicker':
      // High CPS is a legitimate technique. Only regularity is suspicious.
      return {
        ...base,
        label: 'Legit jitter-clicker (17 CPS, very noisy)',
        movements: buildMoves({ ticks: 200, speedBps: 5.2, jumpEvery: 20, groundFraction: 0.85, rng }, t0),
        attacks: buildAttacks({ ticks: 200, cps: 17, distance: 2.7, victims: ['v1'], aimDelta: [10, 40], losTrue: 0.97, rng }, t0),
        clicks: buildClicks(17, 10, rng, 0.42, t0),
      };

    case 'clean-laggy-ir':
      // The most important clean profile: bad Iranian connection.
      return {
        ...base,
        label: 'Iranian player, 265ms ping + 7.5% loss',
        network: NET_IR_LAGGY,
        movements: buildMoves({ ticks: 200, speedBps: 4.6, jumpEvery: 25, groundFraction: 0.8, stallEvery: 40, rng }, t0),
        attacks: buildAttacks({ ticks: 200, cps: 7, distance: 3.0, victims: ['v1'], aimDelta: [8, 35], losTrue: 0.94, rng }, t0),
        clicks: buildClicks(7, 10, rng, 0.4, t0),
      };

    case 'clean-pro-aimer':
      // Sharp, fast, high-skill PvP. Must not be mistaken for killaura.
      return {
        ...base,
        label: 'High-skill PvP player (sharp aim, 12 CPS)',
        movements: buildMoves({ ticks: 240, speedBps: 6.2, jumpEvery: 14, groundFraction: 0.75, rng }, t0),
        attacks: buildAttacks({ ticks: 240, cps: 12, distance: 2.9, victims: ['v1', 'v2'], aimDelta: [30, 75], losTrue: 0.96, rng }, t0),
        clicks: buildClicks(12, 10, rng, 0.28, t0),
      };

    case 'clean-builder':
      return {
        ...base,
        label: 'Builder (fast breaking, always has the right tool)',
        movements: buildMoves({ ticks: 200, speedBps: 3.4, jumpEvery: 60, groundFraction: 0.95, rng }, t0),
        breaks: buildBreaks({ count: 120, minMs: 110, toolAdequate: true, rng }, t0),
      };

    case 'clean-efficient-miner':
      // Straight tunnels AND high ore rate, but genuinely explored a lot.
      return {
        ...base,
        label: 'Efficient miner (straight tunnels, real exploration)',
        movements: buildMoves({ ticks: 200, speedBps: 3.8, jumpEvery: 40, groundFraction: 0.9, rng }, t0),
        breaks: buildBreaks({ count: 200, minMs: 240, toolAdequate: true, rng }, t0),
        ores: buildOres({ count: 26, minutes: 1.2, straightness: 0.95, explored: 900, rng }, t0),
      };

    case 'clean-knockback-burst':
      // Slime block / TNT launch: a short huge speed spike, then normal.
      return {
        ...base,
        label: 'Player launched by TNT once (single burst)',
        movements: [
          ...buildMoves({ ticks: 60, speedBps: 4.2, jumpEvery: 30, groundFraction: 0.9, rng }, t0),
          ...buildMoves({ ticks: 4, speedBps: 22, jumpEvery: 2, groundFraction: 0.0, rng }, t0 + 60 * TICK),
          ...buildMoves({ ticks: 140, speedBps: 4.2, jumpEvery: 30, groundFraction: 0.9, rng }, t0 + 64 * TICK),
        ],
      };

    // -------------------------------------------------------- CHEATERS
    case 'cheat-killaura':
      return {
        ...base,
        label: 'Killaura: 3 victims per 50ms tick, no LOS, aim snapping',
        movements: buildMoves({ ticks: 200, speedBps: 4.4, jumpEvery: 25, groundFraction: 0.85, rng }, t0),
        attacks: buildAttacks(
          {
            ticks: 200,
            cps: 14,
            distance: 2.8,
            victims: ['v1', 'v2', 'v3'],
            aimDelta: [80, 180],
            losTrue: 0.25,
            rng,
            multiTargetPerTick: 3,
          },
          t0,
        ),
      };

    case 'cheat-fly':
      return {
        ...base,
        label: 'Fly: 90 ticks airborne, never grounds',
        movements: buildMoves({ ticks: 200, speedBps: 5.0, groundFraction: 0.0, rising: true, rng }, t0),
      };

    case 'cheat-speed':
      return {
        ...base,
        label: 'Speed: sustained 1.9x sprint-jump speed',
        movements: buildMoves({ ticks: 200, speedBps: 13.5, jumpEvery: 10, groundFraction: 0.85, rng }, t0),
      };

    case 'cheat-noclip':
      return {
        ...base,
        label: 'NoClip: moving through solids in 40% of samples',
        movements: buildMoves({ ticks: 200, speedBps: 4.0, groundFraction: 0.85, inBlockFraction: 0.4, rng }, t0),
      };

    case 'cheat-reach':
      return {
        ...base,
        label: 'Reach: 5.2 block attack distance',
        movements: buildMoves({ ticks: 200, speedBps: 4.3, jumpEvery: 30, groundFraction: 0.9, rng }, t0),
        attacks: buildAttacks({ ticks: 200, cps: 8, distance: 5.2, victims: ['v1'], aimDelta: [5, 30], losTrue: 0.98, rng }, t0),
      };

    case 'cheat-autoclick':
      return {
        ...base,
        label: 'Autoclicker: 24 CPS with CV=0.02',
        movements: buildMoves({ ticks: 200, speedBps: 4.3, jumpEvery: 30, groundFraction: 0.9, rng }, t0),
        clicks: buildClicks(24, 10, rng, 0.02, t0),
      };

    case 'cheat-xray':
      return {
        ...base,
        label: 'X-ray: 45 ores/min, perfectly straight, no exploration',
        movements: buildMoves({ ticks: 200, speedBps: 3.6, groundFraction: 0.9, rng }, t0),
        breaks: buildBreaks({ count: 150, minMs: 260, toolAdequate: true, rng }, t0),
        ores: buildOres({ count: 45, minutes: 1, straightness: 0.99, explored: 60, rng }, t0),
      };

    case 'cheat-fastbreak':
      return {
        ...base,
        label: 'FastBreak: 20ms breaks with no adequate tool',
        movements: buildMoves({ ticks: 200, speedBps: 3.6, groundFraction: 0.9, rng }, t0),
        breaks: buildBreaks({ count: 80, minMs: 20, toolAdequate: false, rng }, t0),
      };

    case 'cheat-timer':
      return {
        ...base,
        label: 'Timer: client running 1.8x speed',
        movements: buildMoves({ ticks: 200, speedBps: 4.3, groundFraction: 0.9, timerRatio: 1.8, rng }, t0),
      };

    case 'cheat-jetpack':
      return {
        ...base,
        label: 'Jetpack: 30 ungrounded upward hops',
        movements: buildMoves({ ticks: 240, speedBps: 4.0, groundFraction: 0.0, rising: true, jumpEvery: 8, rng }, t0),
      };

    case 'cheat-collusion':
      return {
        ...base,
        label: 'Kill farming: 16 mutual kills, no resistance',
        movements: buildMoves({ ticks: 200, speedBps: 4.0, groundFraction: 0.9, rng }, t0),
        collusion: {
          pairs: [{ a: 'p', b: 'friend', kills: 16, resistTicks: 20 }],
          windowMs: 10 * 60_000,
        },
      };

    default:
      return base;
  }
}

export const CLEAN_PROFILES: ProfileKind[] = [
  'clean-normal',
  'clean-jitterclicker',
  'clean-laggy-ir',
  'clean-pro-aimer',
  'clean-builder',
  'clean-efficient-miner',
  'clean-knockback-burst',
];

export const CHEATER_PROFILES: ProfileKind[] = [
  'cheat-killaura',
  'cheat-fly',
  'cheat-speed',
  'cheat-noclip',
  'cheat-reach',
  'cheat-autoclick',
  'cheat-xray',
  'cheat-fastbreak',
  'cheat-timer',
  'cheat-jetpack',
  'cheat-collusion',
];

/** A laggy innocent, evaluated right after a rubber-band resync. */
export function buildResyncScenario(seed: number): SimScenario {
  const s = buildScenario('clean-laggy-ir', seed);
  return { ...s, label: 'Iranian player mid rubber-band resync', network: NET_IR_RESYNC };
}
