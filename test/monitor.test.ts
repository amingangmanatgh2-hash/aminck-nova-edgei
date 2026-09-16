import { describe, expect, it } from 'vitest';
import { DEFAULT_HEALTH_CONFIG, decideRecovery, evaluateHealth, RECOVERY } from '../src/monitor/health';
import type { Heartbeat, RecoveryState } from '../src/monitor/health';

const T0 = 1_700_000_000_000;
const hb = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  serverId: 's1', instanceId: 'i1', processAlive: true, players: 5, maxPlayers: 20,
  tps: 19.8, memUsedMb: 1200, memMaxMb: 2048, cpuPercent: 40,
  version: '1.21.1', motd: 'test', worldSavedAt: T0 - 1000, at: T0,
  ...over,
});

describe('health evaluation', () => {
  it('reports online for a fresh, healthy heartbeat', () => {
    const v = evaluateHealth(hb(), 'online', DEFAULT_HEALTH_CONFIG, T0);
    expect(v.status).toBe('online');
    expect(v.shouldRestart).toBe(false);
  });
  it('reports error and asks for restart when the process is dead', () => {
    const v = evaluateHealth(hb({ processAlive: false }), 'online', DEFAULT_HEALTH_CONFIG, T0);
    expect(v.status).toBe('error');
    expect(v.shouldRestart).toBe(true);
  });
  it('treats a stale heartbeat as a crash', () => {
    const v = evaluateHealth(hb({ at: T0 - 120_000 }), 'online', DEFAULT_HEALTH_CONFIG, T0);
    expect(v.status).toBe('error');
    expect(v.reason).toContain('old');
  });
  it('does NOT restart on low TPS (that is a perf problem, not a crash)', () => {
    const v = evaluateHealth(hb({ tps: 8 }), 'online', DEFAULT_HEALTH_CONFIG, T0);
    expect(v.status).toBe('online');
    expect(v.shouldRestart).toBe(false);
    expect(v.reason).toContain('degraded');
  });
  it('flags memory pressure without restarting', () => {
    const warn = evaluateHealth(hb({ memUsedMb: 1700 }), 'online', DEFAULT_HEALTH_CONFIG, T0);
    expect(warn.reason).toContain('warning');
    expect(warn.shouldRestart).toBe(false);
    const crit = evaluateHealth(hb({ memUsedMb: 1950 }), 'online', DEFAULT_HEALTH_CONFIG, T0);
    expect(crit.reason).toContain('critical');
    expect(crit.shouldRestart).toBe(false);
  });
  it('trusts a transitional status when no heartbeat has arrived yet', () => {
    expect(evaluateHealth(null, 'starting', DEFAULT_HEALTH_CONFIG, T0).status).toBe('starting');
    expect(evaluateHealth(null, 'stopping', DEFAULT_HEALTH_CONFIG, T0).status).toBe('stopping');
    expect(evaluateHealth(null, 'offline', DEFAULT_HEALTH_CONFIG, T0).status).toBe('offline');
  });
  it('reports error when a heartbeat was expected but missing', () => {
    const v = evaluateHealth(null, 'online', DEFAULT_HEALTH_CONFIG, T0);
    expect(v.status).toBe('error');
    expect(v.shouldRestart).toBe(true);
  });
});

describe('recovery backoff', () => {
  const fresh: RecoveryState = { attempts: 0, lastAttemptAt: null, gaveUp: false };

  it('waits when nothing is wrong', () => {
    const d = decideRecovery(fresh, evaluateHealth(hb(), 'online', DEFAULT_HEALTH_CONFIG, T0), {}, T0);
    expect(d.action).toBe('wait');
  });
  it('backs off exponentially', () => {
    const crash = evaluateHealth(hb({ processAlive: false }), 'online', DEFAULT_HEALTH_CONFIG, T0);
    const d1 = decideRecovery(fresh, crash, {}, T0);
    const d2 = decideRecovery({ attempts: 1, lastAttemptAt: T0, gaveUp: false }, crash, {}, T0);
    const d3 = decideRecovery({ attempts: 2, lastAttemptAt: T0, gaveUp: false }, crash, {}, T0);
    expect(d2.delayMs).toBeGreaterThan(d1.delayMs);
    expect(d3.delayMs).toBeGreaterThan(d2.delayMs);
    expect(d3.delayMs).toBeLessThanOrEqual(RECOVERY.maxDelayMs);
  });
  it('escalates instead of looping forever', () => {
    const crash = evaluateHealth(hb({ processAlive: false }), 'online', DEFAULT_HEALTH_CONFIG, T0);
    const d = decideRecovery({ attempts: RECOVERY.maxAttempts, lastAttemptAt: T0, gaveUp: false }, crash, {}, T0);
    expect(d.action).toBe('escalate');
    expect(d.state.gaveUp).toBe(true);
    expect(d.reason).toContain('manual review');
  });
  it('clears the attempt counter after a long healthy run', () => {
    const crash = evaluateHealth(hb({ processAlive: false }), 'online', DEFAULT_HEALTH_CONFIG, T0);
    const d = decideRecovery(
      { attempts: 3, lastAttemptAt: T0 - 1000, gaveUp: true },
      crash,
      { lastHealthyAt: T0 - RECOVERY.healthyForMs - 1 },
      T0,
    );
    expect(d.action).toBe('restart');
    expect(d.attempt).toBe(1);
  });
});
