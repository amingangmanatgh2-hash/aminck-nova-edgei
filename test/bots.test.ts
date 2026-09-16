import { describe, expect, it } from 'vitest';
import { BOT_TIERS, BOT_TIER_ORDER } from '../src/config';
import { botBackfillCount, botPrompt, chooseTier, createBot, shouldPromote } from '../src/bots/tiering';

describe('adaptive tiering', () => {
  it('uses the cheapest model for a fresh lobby', () => {
    const d = chooseTier({ humanElos: [1000, 1020], slotsNeeded: 8 });
    expect(d.tier).toBe('nano');
    expect(d.rationale).toContain('nano');
  });

  it('escalates as the lobby ELO rises', () => {
    const seen = [900, 1200, 1500, 1900].map(
      (elo) => chooseTier({ humanElos: [elo], slotsNeeded: 8 }).tier,
    );
    // Tiers must be non-decreasing as ELO climbs.
    for (let i = 1; i < seen.length; i++) {
      expect(
        BOT_TIER_ORDER.indexOf(seen[i]!),
        `${seen[i - 1]} -> ${seen[i]}`,
      ).toBeGreaterThanOrEqual(BOT_TIER_ORDER.indexOf(seen[i - 1]!));
    }
    expect(seen[seen.length - 1]).toBe('pro');
  });

  it('raises the whole lobby when ONE strong player joins', () => {
    const weak = chooseTier({ humanElos: [950, 980, 1010], slotsNeeded: 8 });
    const withVet = chooseTier({ humanElos: [950, 980, 1010, 2200], slotsNeeded: 8 });
    expect(BOT_TIER_ORDER.indexOf(withVet.tier)).toBeGreaterThan(BOT_TIER_ORDER.indexOf(weak.tier));
  });

  it('defaults to nano when nobody is queued', () => {
    expect(chooseTier({ humanElos: [], slotsNeeded: 8 }).tier).toBe('nano');
  });

  it('only ever steps up one tier at a time', () => {
    const cur = chooseTier({ humanElos: [900], slotsNeeded: 8 });
    const p = shouldPromote(cur.tier, { humanElos: [2300], slotsNeeded: 8 }, null);
    expect(p.promote).toBe(true);
    expect(p.to).toBe('micro'); // nano -> micro, not nano -> pro
  });

  it('rate-limits promotion so bots do not flip mid-fight', () => {
    const now = 1_700_000_000_000;
    const p = shouldPromote('nano', { humanElos: [2300], slotsNeeded: 8 }, now - 10_000, now);
    expect(p.promote).toBe(false);
    expect(p.reason).toContain('cooldown');
  });

  it('does not promote when the lobby is not stronger', () => {
    const p = shouldPromote('small', { humanElos: [1000], slotsNeeded: 8 }, null);
    expect(p.promote).toBe(false);
  });
});

describe('bot backfill', () => {
  it('never pads a lobby that has no humans', () => {
    expect(botBackfillCount(0, 16)).toBe(0);
  });
  it('never makes bots more than 60% of the lobby', () => {
    expect(botBackfillCount(1, 16)).toBeLessThanOrEqual(Math.floor(16 * 0.6));
    expect(botBackfillCount(2, 10)).toBeLessThanOrEqual(6);
  });
  it('fills the remaining slots when humans are plentiful', () => {
    expect(botBackfillCount(8, 10)).toBe(2);
  });
  it('never returns a negative count', () => {
    expect(botBackfillCount(20, 10)).toBe(0);
  });
});

describe('bot imperfection', () => {
  it('gives every bot a reaction delay and an error rate', () => {
    const d = chooseTier({ humanElos: [1000], slotsNeeded: 8 });
    for (let i = 0; i < 20; i++) {
      const b = createBot('m1', d, Math.random);
      expect(b.reactionMs).toBeGreaterThan(100);
      expect(b.errorRate).toBeGreaterThan(0);
      expect(b.skill).toBeGreaterThan(0);
      expect(b.skill).toBeLessThan(1);
    }
  });
  it('makes stronger tiers better but still imperfect', () => {
    const nano = BOT_TIERS.nano!;
    const pro = BOT_TIERS.pro!;
    expect(pro.skill).toBeGreaterThan(nano.skill);
    expect(pro.errorRate).toBeLessThan(nano.errorRate);
    expect(pro.reactionMs[1]).toBeLessThan(nano.reactionMs[1]);
    expect(pro.errorRate).toBeGreaterThan(0); // never flawless
  });
  it('names a concrete Workers AI model for every tier', () => {
    for (const t of BOT_TIER_ORDER) {
      expect(BOT_TIERS[t]!.model, t).toMatch(/^@cf\//);
    }
  });
  it('builds a small, structured prompt', () => {
    const d = chooseTier({ humanElos: [1000], slotsNeeded: 8 });
    const b = createBot('m1', d, () => 0.5);
    const p = botPrompt(b, {
      mode: 'bedwars', objective: 'destroy enemy beds', nearbyThreats: 2,
      health: 14, resources: 30, teammatesAlive: 3,
    });
    expect(p).toContain('bedwars');
    expect(p.length).toBeLessThan(600); // token cost matters
  });
});
