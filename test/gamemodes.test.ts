import { describe, expect, it } from 'vitest';
import { apply, createMatch, summarise } from '../src/gamemodes/engine';
import { GAME_MODES, MODE_IDS } from '../src/config';

const T0 = 1_700_000_000_000;

describe('mode catalogue', () => {
  it('ships all 14 required modes', () => {
    const required = ['bedwars','skywars','survivalgames','tntrun','murdermystery','parkour',
      'buildbattle','spleef','thebridge','uhc','zombiesurvival','kitpvp','duels','factions'];
    for (const id of required) expect(MODE_IDS, `missing mode ${id}`).toContain(id);
  });
  it('gives every mode rewards, a scoring rule and bot skills', () => {
    for (const id of MODE_IDS) {
      const g = GAME_MODES[id]!;
      expect(g.titleFa, id).toBeTruthy();
      expect(g.maxPlayers, id).toBeGreaterThan(1);
      expect(g.minPlayers, id).toBeGreaterThan(0);
      expect(g.minPlayers, id).toBeLessThanOrEqual(g.maxPlayers);
      expect(g.rewards.kill, id).toBeGreaterThanOrEqual(0);
      expect(g.botSkills.length, id).toBeGreaterThan(0);
    }
  });
  it('has a finite duration except persistent modes', () => {
    for (const id of MODE_IDS) {
      if (id === 'kitpvp' || id === 'factions') continue;
      expect(GAME_MODES[id]!.targetDurationS, id).toBeGreaterThan(0);
    }
  });
});

describe('match lifecycle', () => {
  it('refuses to start below the minimum player count', () => {
    const m = createMatch('bedwars');
    apply(m, { type: 'join', refId: 'a', kind: 'human', elo: 1000 }, T0);
    const r = apply(m, { type: 'start' }, T0);
    expect(m.phase).toBe('queue');
    expect(r.log.join()).toContain('start blocked');
  });

  it('rejects a duplicate join and a join to a full match', () => {
    const m = createMatch('duels'); // 2 slots
    apply(m, { type: 'join', refId: 'a', kind: 'human', elo: 1000 }, T0);
    apply(m, { type: 'join', refId: 'a', kind: 'human', elo: 1000 }, T0);
    expect(m.participants.length).toBe(1);
    apply(m, { type: 'join', refId: 'b', kind: 'human', elo: 1000 }, T0);
    const extra = apply(m, { type: 'join', refId: 'c', kind: 'human', elo: 1000 }, T0);
    expect(m.participants.length).toBe(2);
    expect(extra.log.join()).toContain('full');
  });

  it('ends a free-for-all when one player remains', () => {
    const m = createMatch('skywars');
    for (let i = 0; i < 5; i++) apply(m, { type: 'join', refId: `p${i}`, kind: 'human', elo: 1000 }, T0);
    apply(m, { type: 'start' }, T0);
    for (let i = 1; i < 5; i++) apply(m, { type: 'kill', killer: 'p0', victim: `p${i}` }, T0);
    expect(m.phase).toBe('results');
    expect(m.meta.winner).toBe('p0');
  });

  it('awards XP and coins to the winner but not the losers', () => {
    const m = createMatch('duels');
    apply(m, { type: 'join', refId: 'a', kind: 'human', elo: 1000 }, T0);
    apply(m, { type: 'join', refId: 'b', kind: 'human', elo: 1000 }, T0);
    apply(m, { type: 'start' }, T0);
    const res = apply(m, { type: 'kill', killer: 'a', victim: 'b' }, T0);
    const winner = res.awards.filter((a) => a.refId === 'a');
    expect(winner.some((a) => a.reason === 'win')).toBe(true);
    expect(res.awards.filter((a) => a.refId === 'b' && a.reason === 'win').length).toBe(0);
  });

  it('moves ELO in opposite directions for killer and victim', () => {
    const m = createMatch('duels');
    apply(m, { type: 'join', refId: 'a', kind: 'human', elo: 1200 }, T0);
    apply(m, { type: 'join', refId: 'b', kind: 'human', elo: 1200 }, T0);
    apply(m, { type: 'start' }, T0);
    const res = apply(m, { type: 'kill', killer: 'a', victim: 'b' }, T0);
    const a = res.elo.find((e) => e.refId === 'a')!;
    const b = res.elo.find((e) => e.refId === 'b')!;
    expect(a.delta).toBeGreaterThan(0);
    expect(b.delta).toBeLessThan(0);
  });

  it('ignores team kills', () => {
    const m = createMatch('bedwars');
    for (let i = 0; i < 8; i++) apply(m, { type: 'join', refId: `p${i}`, kind: 'human', elo: 1000 }, T0);
    apply(m, { type: 'start' }, T0);
    const team = m.participants.find((p) => p.refId === 'p0')!.team!;
    const mate = m.participants.find((p) => p.team === team && p.refId !== 'p0')!;
    const res = apply(m, { type: 'kill', killer: 'p0', victim: mate.refId }, T0);
    expect(res.log.join()).toContain('teammates');
    expect(mate.kills).toBe(0);
  });

  it('ends a team mode when one team is wiped', () => {
    const m = createMatch('thebridge'); // 4v4
    for (let i = 0; i < 8; i++) apply(m, { type: 'join', refId: `p${i}`, kind: 'human', elo: 1000 }, T0);
    apply(m, { type: 'start' }, T0);
    const teamA = m.participants.find((p) => p.refId === 'p0')!.team!;
    const enemies = m.participants.filter((p) => p.team !== teamA);
    // Destroy the enemy bed so kills are permanent, then eliminate them.
    apply(m, { type: 'objective', refId: 'p0', kind: 'bed_destroyed', value: enemies[0]!.team! }, T0);
    m.meta.bedsDestroyedFor = enemies[0]!.team!;
    for (const e of enemies) apply(m, { type: 'kill', killer: 'p0', victim: e.refId }, T0);
    expect(m.phase).toBe('results');
    expect(m.meta.winnerTeam).toBe(teamA);
  });

  it('ends on the time limit and picks the top scorer', () => {
    const m = createMatch('parkour');
    // parkour is 30 solo slots, so minPlayers is floor(30/3) = 10.
    const need = GAME_MODES.parkour!.minPlayers;
    for (let i = 0; i < need; i++) apply(m, { type: 'join', refId: `p${i}`, kind: 'human', elo: 1000 }, T0);
    expect(apply(m, { type: 'start' }, T0).log.join()).not.toContain('start blocked');
    apply(m, { type: 'objective', refId: 'p2', kind: 'checkpoint' }, T0);
    apply(m, { type: 'objective', refId: 'p2', kind: 'checkpoint' }, T0);
    const later = T0 + (GAME_MODES.parkour!.targetDurationS + 5) * 1000;
    const res = apply(m, { type: 'tick', dtMs: 50 }, later);
    expect(res.ended).toBe(true);
    expect(m.meta.winner).toBe('p2');
  });

  it('ignores events that arrive outside the playing phase', () => {
    const m = createMatch('duels');
    apply(m, { type: 'join', refId: 'a', kind: 'human', elo: 1000 }, T0);
    const res = apply(m, { type: 'kill', killer: 'a', victim: 'zzz' }, T0);
    expect(res.awards.length).toBe(0);
    expect(m.participants[0]!.kills).toBe(0);
  });

  it('summarises a match for the API', () => {
    const m = createMatch('bedwars');
    for (let i = 0; i < 6; i++) {
      apply(m, { type: 'join', refId: `p${i}`, kind: i < 4 ? 'human' : 'bot', elo: 1000 }, T0);
    }
    apply(m, { type: 'start' }, T0);
    const s = summarise(m);
    expect(s.players).toBe(6);
    expect(s.humans).toBe(4);
    expect(s.bots).toBe(2);
    expect(s.phase).toBe('playing');
    expect(s.mode.id).toBe('bedwars');
  });
});
