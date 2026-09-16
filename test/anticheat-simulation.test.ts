/**
 * Anti-cheat — simulation harness.
 *
 * Runs the engine over many synthetic players (clean and cheating) and
 * measures the two numbers that actually matter:
 *
 *   FALSE POSITIVE  a clean player against whom action was taken
 *   FALSE NEGATIVE  a cheater who escaped detection
 *
 * Hard requirement from the spec: if even ONE simulated innocent receives a
 * PERMANENT ban, the whole suite fails. Automatic scoring never sets
 * `permanent`, and this test asserts that structurally as well as empirically.
 */
import { describe, expect, it } from 'vitest';
import { AntiCheatEngine } from '../src/anticheat/engine';
import { ANTICHEAT } from '../src/config';
import type { ActionTier } from '../src/types';
import {
  CHEATER_PROFILES,
  CLEAN_PROFILES,
  buildResyncScenario,
  buildScenario,
  type ProfileKind,
} from './sim/generate';

const RUNS_PER_PROFILE = 12;

interface Row {
  profile: ProfileKind;
  isCheater: boolean;
  label: string;
  maxConfidence: number;
  maxTier: ActionTier;
  permanentBans: number;
  tempBans: number;
  kicks: number;
  alerts: number;
  detected: number; // runs where an action (tier>=3) was taken
  actions: string[];
}

function runProfile(profile: ProfileKind): Row {
  const first = buildScenario(profile, 1);
  const row: Row = {
    profile,
    isCheater: first.isCheater,
    label: first.label,
    maxConfidence: 0,
    maxTier: 1,
    permanentBans: 0,
    tempBans: 0,
    kicks: 0,
    alerts: 0,
    detected: 0,
    actions: [],
  };

  for (let run = 0; run < RUNS_PER_PROFILE; run++) {
    const s = buildScenario(profile, run + 1);
    const engine = new AntiCheatEngine();
    const res = engine.evaluate({
      playerId: `p-${run}`,
      movements: s.movements,
      attacks: s.attacks,
      breaks: s.breaks,
      ores: s.ores,
      oreWindowMs: ANTICHEAT.windowMs,
      clicks: s.clicks,
      clickWindowMs: 10_000,
      collusion: s.collusion,
      network: s.network,
      at: 1_700_000_000_000,
    });

    const d = res.decision;
    row.maxConfidence = Math.max(row.maxConfidence, d.confidence);
    row.maxTier = Math.max(row.maxTier, d.tier) as ActionTier;
    if (d.permanent) row.permanentBans++;
    if (d.actionTaken === 'temporary_ban') row.tempBans++;
    if (d.actionTaken === 'match_kick') row.kicks++;
    if (d.actionTaken.startsWith('hidden_admin_alert')) row.alerts++;
    if (d.tier >= 3) {
      row.detected++;
      row.actions.push(d.actionTaken);
    }

    // Structural guarantee: automatic scoring must never mark permanent.
    expect(d.permanent).toBe(false);
  }
  return row;
}

describe('anti-cheat simulation', () => {
  const cleanRows = CLEAN_PROFILES.map(runProfile);
  const cheatRows = CHEATER_PROFILES.map(runProfile);

  const fp = cleanRows.filter((r) => r.detected > 0);

  /**
   * Cheats are graded by how unambiguous they are, and held to different
   * standards — this is deliberate, not a way to make the numbers look good:
   *
   *  HARD  physically impossible in vanilla (killaura, fly, noclip, reach,
   *        speed, timer, jetpack, fastbreak, xray) => must be KICKED (tier 3+)
   *  GREY  genuinely ambiguous (autoclick — jitter/drag/butterfly clicking are
   *        real techniques; collusion — smurfing and alt play look identical)
   *        => must at least raise a hidden admin alert (tier 2+)
   */
  const GREY = new Set(['cheat-autoclick', 'cheat-collusion']);
  const hardRows = cheatRows.filter((r) => !GREY.has(r.profile));
  const greyRows = cheatRows.filter((r) => GREY.has(r.profile));
  const fn = hardRows.filter((r) => r.maxTier < 3);
  const greyMissed = greyRows.filter((r) => r.maxTier < 2);
  const alerted = cheatRows.filter((r) => r.maxTier >= 2);
  const fpRate = fp.length / cleanRows.length;
  const fnRate = fn.length / Math.max(hardRows.length, 1);
  const detectionRate = alerted.length / cheatRows.length;

  const report = (): string => {
    const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
    const lines: string[] = [];
    lines.push('');
    lines.push(pad('PROFILE', 26) + pad('KIND', 8) + pad('maxConf', 9) + pad('maxTier', 9) + pad('ban', 6) + pad('kick', 6) + pad('alert', 7) + 'ACTION');
    lines.push('-'.repeat(104));
    for (const r of [...cleanRows, ...cheatRows]) {
      lines.push(
        pad(r.profile, 26) +
          pad(r.isCheater ? 'CHEAT' : 'clean', 8) +
          pad(r.maxConfidence.toFixed(1), 9) +
          pad(String(r.maxTier), 9) +
          pad(String(r.tempBans), 6) +
          pad(String(r.kicks), 6) +
          pad(String(r.alerts), 7) +
          (r.actions[0] ?? '-'),
      );
    }
    lines.push('-'.repeat(104));
    lines.push(`FALSE POSITIVE rate: ${(fpRate * 100).toFixed(1)}%  (${fp.length}/${cleanRows.length} clean profiles had action taken)`);
    lines.push(`FALSE NEGATIVE rate (hard cheats): ${(fnRate * 100).toFixed(1)}%  (${fn.length}/${hardRows.length} hard cheats escaped a kick)`);
    lines.push(`Grey-area cheats alerted:          ${greyRows.length - greyMissed.length}/${greyRows.length}`);
    lines.push(`Overall cheat detection (tier>=2):  ${(detectionRate * 100).toFixed(1)}%  (${alerted.length}/${cheatRows.length})`);
    lines.push(`PERMANENT bans issued automatically: ${[...cleanRows, ...cheatRows].reduce((a, r) => a + r.permanentBans, 0)}`);
    if (fp.length) lines.push(`FP profiles: ${fp.map((r) => `${r.profile} (conf ${r.maxConfidence.toFixed(1)})`).join(', ')}`);
    if (fn.length) lines.push(`FN profiles: ${fn.map((r) => `${r.profile} (conf ${r.maxConfidence.toFixed(1)}, tier ${r.maxTier})`).join(', ')}`);
    if (greyMissed.length) lines.push(`Grey cheats not even alerted: ${greyMissed.map((r) => r.profile).join(', ')}`);
    lines.push('');
    return lines.join('\n');
  };

  it('produces a readable scorecard', () => {
    // Always printed, so the numbers live in the test output instead of being
    // asserted about and then hidden.
    const r = report();
    // eslint-disable-next-line no-console
    console.log(r);
    expect(r).toContain('FALSE POSITIVE rate');
  });

  it('NEVER issues an automatic permanent ban to anyone', () => {
    const total = [...cleanRows, ...cheatRows].reduce((a, r) => a + r.permanentBans, 0);
    expect(total).toBe(0);
  });

  it('never takes action against a clean player (zero false positives)', () => {
    const offenders = fp.map((r) => `${r.profile}: ${r.actions.join(',')}`);
    expect(offenders, `clean players wrongly acted on:\n${report()}`).toEqual([]);
  });

  it('kicks every HARD cheat (physically impossible behaviour)', () => {
    const escaped = fn.map((r) => `${r.profile} (conf ${r.maxConfidence.toFixed(1)}, tier ${r.maxTier})`);
    expect(escaped, `hard cheats that escaped a kick:\n${report()}`).toEqual([]);
  });

  it('flags every GREY cheat with at least a hidden admin alert', () => {
    const missed = greyMissed.map((r) => `${r.profile} (conf ${r.maxConfidence.toFixed(1)})`);
    expect(missed, `grey cheats not alerted:\n${report()}`).toEqual([]);
  });

  it('keeps false-positive rate below 5% and false-negative rate below 10%', () => {
    expect(fpRate).toBeLessThan(0.05);
    expect(fnRate).toBeLessThan(0.1);
    expect(detectionRate).toBeGreaterThanOrEqual(0.9);
  });
});

describe('anti-cheat — Iran network calibration', () => {
  it('does not act on a laggy Iranian player mid rubber-band resync', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const s = buildResyncScenario(seed);
      const engine = new AntiCheatEngine();
      const res = engine.evaluate({
        playerId: `lag-${seed}`,
        movements: s.movements,
        attacks: s.attacks,
        clicks: s.clicks,
        network: s.network,
        at: 1_700_000_000_000,
      });
      expect(res.decision.permanent).toBe(false);
      expect(
        res.decision.tier,
        `seed ${seed} escalated to tier ${res.decision.tier} (conf ${res.decision.confidence}) despite resync`,
      ).toBeLessThan(3);
    }
  });

  it('still catches a cheater who also has a bad connection', () => {
    // Latency must not become a cheat enabler.
    const s = buildScenario('cheat-killaura', 5);
    const engine = new AntiCheatEngine();
    const res = engine.evaluate({
      playerId: 'laggy-cheater',
      movements: s.movements,
      attacks: s.attacks,
      network: { pingMs: 300, pingMaxMs: 700, packetLossPct: 9, resyncedRecently: false, msSinceResync: 60_000, region: 'IR' },
      at: 1_700_000_000_000,
    });
    expect(res.decision.tier).toBeGreaterThanOrEqual(2);
    expect(res.decision.permanent).toBe(false);
  });
});

describe('anti-cheat — ladder invariants', () => {
  it('requires multiple distinct checks before a temporary ban', () => {
    // Reach alone, hammered hard, must not reach tier 4.
    const s = buildScenario('cheat-reach', 3);
    const engine = new AntiCheatEngine();
    const res = engine.evaluate({
      playerId: 'reach-only',
      attacks: s.attacks,
      network: s.network,
      at: 1_700_000_000_000,
    });
    expect(res.decision.distinctChecks.length).toBe(1);
    expect(res.decision.actionTaken).not.toBe('temporary_ban');
    expect(res.decision.permanent).toBe(false);
  });

  it('captures evidence whenever a signal exists', () => {
    const s = buildScenario('cheat-fly', 2);
    const engine = new AntiCheatEngine();
    const res = engine.evaluate({
      playerId: 'evidence',
      movements: s.movements,
      network: s.network,
      at: 1_700_000_000_000,
    });
    expect(res.evidence).not.toBeNull();
    expect(res.evidence!.signals.length).toBeGreaterThan(0);
    expect(res.evidence!.movement.length).toBeGreaterThan(0);
    // Metrics must be numeric, not a bare verdict.
    for (const sig of res.evidence!.signals) {
      expect(Object.keys(sig.metrics).length).toBeGreaterThan(0);
      expect(typeof sig.weight).toBe('number');
    }
  });
});
