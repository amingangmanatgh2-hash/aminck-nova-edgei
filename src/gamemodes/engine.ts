/**
 * Game mode engine.
 *
 * This is the server-side match lifecycle and scoring rules. It is pure logic:
 * the Minecraft plugin drives it by sending events, and the plugin can be
 * swapped without touching these rules.
 *
 * Every mode shares the same lifecycle:
 *   lobby -> queue -> playing -> results -> closed
 * with mode-specific rules deciding when the match ends and who won.
 */
import { GAME_MODES } from '../config';
import type { GameModeSpec, MatchPhase } from '../types';
import { eloDelta, newId, now } from '../utils';

export interface Participant {
  slot: number;
  refId: string;
  kind: 'human' | 'bot';
  team: string | null;
  elo: number;
  score: number;
  kills: number;
  deaths: number;
  objectives: number;
  alive: boolean;
}

export interface MatchState {
  id: string;
  modeId: string;
  phase: MatchPhase;
  slots: number;
  teams: string[][];
  participants: Participant[];
  startedAt: number | null;
  endedAt: number | null;
  /** Mode-specific state: bed counts, zones held, rounds, etc. */
  meta: Record<string, number | string | boolean | number[] | string[]>;
  tick: number;
}

export type MatchEvent =
  | { type: 'join'; refId: string; kind: 'human' | 'bot'; elo: number }
  | { type: 'leave'; refId: string }
  | { type: 'start' }
  | { type: 'kill'; killer: string; victim: string }
  | { type: 'objective'; refId: string; kind: string; value?: number | string }
  | { type: 'tick'; dtMs: number }
  | { type: 'end'; winner?: string };

export interface AppliedResult {
  state: MatchState;
  /** XP/coin awards produced by this event, keyed by participant refId. */
  awards: { refId: string; xp: number; coins: number; reason: string }[];
  /** ELO changes, keyed by refId. */
  elo: { refId: string; delta: number; newElo: number }[];
  /** Human-readable log lines, for the match feed and the admin panel. */
  log: string[];
  ended: boolean;
  winner: string | null;
}

export function createMatch(modeId: string, at = now()): MatchState {
  const spec = GAME_MODES[modeId];
  if (!spec) throw new Error(`unknown mode: ${modeId}`);
  const teams: string[][] = [];
  for (let t = 0; t < spec.teamCount; t++) teams.push([]);
  return {
    id: newId(),
    modeId,
    phase: 'lobby',
    slots: spec.maxPlayers,
    teams,
    participants: [],
    startedAt: null,
    endedAt: null,
    meta: {},
    tick: 0,
  };
}

const spec = (s: MatchState): GameModeSpec => GAME_MODES[s.modeId]!;

function aliveByTeam(state: MatchState): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of state.participants) {
    if (!p.alive || !p.team) continue;
    m.set(p.team, (m.get(p.team) ?? 0) + 1);
  }
  return m;
}

function assignTeam(state: MatchState, refId: string): string {
  // Smallest team first, so teams stay balanced as players trickle in.
  let best = state.teams[0]?.length ?? 0;
  let idx = 0;
  state.teams.forEach((t, i) => {
    if (t.length < best) {
      best = t.length;
      idx = i;
    }
  });
  const team = `team-${idx}`;
  state.teams[idx]?.push(refId);
  return team;
}

export function apply(state: MatchState, event: MatchEvent, at = now()): AppliedResult {
  const out: AppliedResult = { state, awards: [], elo: [], log: [], ended: false, winner: null };
  const g = spec(state);

  switch (event.type) {
    case 'join': {
      if (state.phase === 'closed' || state.phase === 'results') {
        out.log.push(`join rejected: match already ${state.phase}`);
        return out;
      }
      if (state.participants.some((p) => p.refId === event.refId)) {
        out.log.push(`join rejected: ${event.refId} already in match`);
        return out;
      }
      if (state.participants.length >= state.slots) {
        out.log.push(`join rejected: match full (${state.slots})`);
        return out;
      }
      const team = g.teamSize > 1 ? assignTeam(state, event.refId) : `solo-${event.refId}`;
      if (g.teamSize <= 1) state.teams[0]?.push(event.refId);
      state.participants.push({
        slot: state.participants.length,
        refId: event.refId,
        kind: event.kind,
        team,
        elo: event.elo,
        score: 0,
        kills: 0,
        deaths: 0,
        objectives: 0,
        alive: true,
      });
      if (state.phase === 'lobby') state.phase = 'queue';
      out.log.push(`${event.refId} joined (${event.kind}, elo ${event.elo})`);
      return out;
    }

    case 'leave': {
      const i = state.participants.findIndex((p) => p.refId === event.refId);
      if (i < 0) return out;
      const [p] = state.participants.splice(i, 1);
      for (const t of state.teams) {
        const j = t.indexOf(event.refId);
        if (j >= 0) t.splice(j, 1);
      }
      out.log.push(`${event.refId} left`);
      if (state.phase === 'playing') checkEnd(state, out, at);
      void p;
      return out;
    }

    case 'start': {
      if (state.phase === 'playing') return out;
      if (state.participants.length < g.minPlayers) {
        out.log.push(`start blocked: ${state.participants.length}/${g.minPlayers} players`);
        return out;
      }
      state.phase = 'playing';
      state.startedAt = at;
      state.meta.bedwarsBeds = state.meta.bedwarsBeds ?? (state.teams.length as number);
      out.log.push(`match started with ${state.participants.length} players`);
      return out;
    }

    case 'kill': {
      if (state.phase !== 'playing') return out;
      const killer = state.participants.find((p) => p.refId === event.killer);
      const victim = state.participants.find((p) => p.refId === event.victim);
      if (!killer || !victim) return out;
      if (killer.team && killer.team === victim.team) {
        out.log.push(`kill ignored: ${event.killer} and ${event.victim} are teammates`);
        return out;
      }
      killer.kills += 1;
      victim.deaths += 1;
      killer.score += g.rewards.kill;
      out.awards.push({ refId: killer.refId, xp: g.rewards.kill, coins: g.coins.kill, reason: 'kill' });

      // Elimination: solo modes kill permanently; team modes only if the team
      // is out (e.g. all beds destroyed in BedWars).
      const soloMode = g.teamSize <= 1;
      if (soloMode) {
        victim.alive = false;
      } else if (state.meta.bedsDestroyedFor?.toString().includes(victim.team ?? '')) {
        victim.alive = false;
      } else {
        // Respawn after a short penalty; tracked as score loss.
        victim.score = Math.max(0, victim.score - Math.floor(g.rewards.kill / 2));
      }

      // ELO only moves for humans; bots have synthetic ratings.
      if (killer.kind === 'human') {
        const d = eloDelta(killer.elo, victim.elo, true, 20);
        killer.elo += d;
        out.elo.push({ refId: killer.refId, delta: d, newElo: killer.elo });
      }
      if (victim.kind === 'human') {
        const d = eloDelta(victim.elo, killer.elo, false, 20);
        victim.elo += d;
        out.elo.push({ refId: victim.refId, delta: d, newElo: victim.elo });
      }
      out.log.push(`${event.killer} eliminated ${event.victim}`);
      checkEnd(state, out, at);
      return out;
    }

    case 'objective': {
      if (state.phase !== 'playing') return out;
      const p = state.participants.find((x) => x.refId === event.refId);
      if (!p) return out;
      p.objectives += 1;
      p.score += g.rewards.objective;
      out.awards.push({ refId: p.refId, xp: g.rewards.objective, coins: 0, reason: `objective:${event.kind}` });
      if (event.kind === 'bed_destroyed') {
        const destroyed = (state.meta.bedsDestroyed as string[] | undefined) ?? [];
        state.meta.bedsDestroyed = [...destroyed, String(event.value ?? '')];
        state.meta.bedwarsBeds = Math.max(0, Number(state.meta.bedwarsBeds ?? 0) - 1);
      }
      out.log.push(`${event.refId} completed objective ${event.kind}`);
      checkEnd(state, out, at);
      return out;
    }

    case 'tick': {
      if (state.phase !== 'playing') return out;
      state.tick += 1;
      const elapsedMs = at - (state.startedAt ?? at);
      if (g.targetDurationS > 0 && elapsedMs > g.targetDurationS * 1000) {
        out.log.push(`time limit reached after ${g.targetDurationS}s`);
        finish(state, out, at, topScorer(state));
      }
      return out;
    }

    case 'end': {
      finish(state, out, at, event.winner ?? topScorer(state));
      return out;
    }

    default:
      return out;
  }
}

function topScorer(state: MatchState): string | null {
  const alive = state.participants.filter((p) => p.alive);
  const pool = alive.length ? alive : state.participants;
  if (!pool.length) return null;
  return pool.reduce((a, b) => (b.score > a.score ? b : a)).refId;
}

/** Mode-aware win detection. */
function checkEnd(state: MatchState, out: AppliedResult, at: number): void {
  const g = spec(state);
  const aliveCount = state.participants.filter((p) => p.alive).length;

  if (g.teamSize <= 1) {
    // Free-for-all: last one standing wins.
    if (aliveCount <= 1 && state.participants.length > 1) {
      const survivor = state.participants.find((p) => p.alive) ?? null;
      finish(state, out, at, survivor?.refId ?? topScorer(state));
    }
    return;
  }

  // Team modes: win when only one team has living members.
  const alive = aliveByTeam(state);
  const withPlayers = [...alive.entries()].filter(([, c]) => c > 0);
  if (withPlayers.length <= 1 && state.participants.length > 1) {
    const winnerTeam = withPlayers[0]?.[0] ?? null;
    const member = winnerTeam ? state.participants.find((p) => p.team === winnerTeam && p.alive) : null;
    finish(state, out, at, member?.refId ?? topScorer(state), winnerTeam);
  }
}

function finish(state: MatchState, out: AppliedResult, at: number, winner: string | null, winnerTeam?: string | null): void {
  if (state.phase === 'results' || state.phase === 'closed') return;
  const g = spec(state);
  state.phase = 'results';
  state.endedAt = at;
  state.meta.winner = winner ?? '';
  if (winnerTeam) state.meta.winnerTeam = winnerTeam;

  for (const p of state.participants) {
    if (p.kind !== 'human') continue;
    const won = winnerTeam ? p.team === winnerTeam : p.refId === winner;
    const xp = won ? g.rewards.win : g.rewards.loss;
    const coins = won ? g.coins.win : 0;
    p.score += won ? g.rewards.win : 0;
    if (won) p.elo += 0; // ELO already applied per-kill for FFA; award win bonus
    out.awards.push({ refId: p.refId, xp, coins, reason: won ? 'win' : 'loss' });
  }

  out.ended = true;
  out.winner = winner;
  out.log.push(`match ended, winner: ${winner ?? 'none'}`);
}

/** Serialisable summary for the API and the panel. */
export function summarise(state: MatchState) {
  const g = spec(state);
  return {
    id: state.id,
    mode: { id: g.id, titleFa: g.titleFa, titleEn: g.titleEn },
    phase: state.phase,
    players: state.participants.length,
    slots: state.slots,
    humans: state.participants.filter((p) => p.kind === 'human').length,
    bots: state.participants.filter((p) => p.kind === 'bot').length,
    teams: state.teams.map((t) => t.length),
    startedAt: state.startedAt,
    elapsedS: state.startedAt ? Math.round((now() - state.startedAt) / 1000) : 0,
    tick: state.tick,
    winner: (state.meta.winner as string) ?? null,
  };
}
