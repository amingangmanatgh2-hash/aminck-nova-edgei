import { describe, it, expect } from 'vitest';
import {
  MockNodeDriver,
  makeMockNodeRecord,
  buildUriFor,
  safeUsername,
  NodeError,
  type NodeHealth,
} from '../src/node/driver';
import {
  applyProbe,
  isSelectable,
  pickMigrationTarget,
  pickNode,
  rankNodes,
  validateNode,
} from '../src/node/pool';
import { parseUriToConfig } from '../src/config/uri';

describe('NodeDriver contract', () => {
  const node = makeMockNodeRecord({ id: 'n1', publicIp: '1.2.3.4', port: 443 });
  const driver = new MockNodeDriver();

  const req = {
    node,
    username: 'u_abc_nl',
    watermark: '4f2a91c0',
    protocol: 'vless' as const,
    trafficLimitBytes: 10 * 1024 ** 3,
    expiresAt: Date.now() + 30 * 86_400_000,
    // The caller embeds the watermark in the remark prefix; a driver never
    // invents one. Mirrors what issueAcrossNodes does.
    remarkPrefix: `پلن ماهانه · هلند · Reality · ${'4f2a91c0'}`,
  };

  it('issues a credential that parses back into a real config', async () => {
    const cred = await driver.issue(req);
    const parsed = parseUriToConfig(cred.uri);
    expect(parsed.protocol).toBe('vless');
    expect(parsed.host).toBe('1.2.3.4');
    expect(parsed.port).toBe(443);
    expect(parsed.protocol === 'vless' && parsed.uuid).toBe(cred.uuid);
  });

  it('embeds the watermark in the remark so a leak is traceable', async () => {
    const cred = await driver.issue(req);
    expect(cred.uri).toContain('4f2a91c0');
  });

  it('produces a different secret on every issue', async () => {
    const a = await driver.issue(req);
    const b = await driver.issue(req);
    expect(a.uuid).not.toBe(b.uuid);
    expect(a.uri).not.toBe(b.uri);
  });

  it('rotation keeps the panel account but changes the key', async () => {
    const first = await driver.issue(req);
    const second = await driver.rotate(first.panelUserId, node, req);
    expect(second.panelUserId).toBe(first.panelUserId);
    expect(second.uuid).not.toBe(first.uuid);
    // The old link must be dead, not merely superseded.
    expect(second.uri).not.toBe(first.uri);
  });

  it('rotation on an unknown panel account fails loudly instead of creating one', async () => {
    await expect(driver.rotate('nope', node, req)).rejects.toThrow(NodeError);
  });

  it('suspend and revoke are visible in usage', async () => {
    const cred = await driver.issue(req);
    await driver.suspend(cred.panelUserId, node, true);
    const usage = await driver.usage(cred.panelUserId, node);
    expect(usage.online).toBe(false);
    await driver.revoke(cred.panelUserId, node);
    await expect(driver.usage(cred.panelUserId, node)).rejects.toThrow(NodeError);
  });

  it('a failing panel call surfaces as NodeError, never as a silent empty config', async () => {
    const cred = await driver.issue(req);
    driver.failOnce(cred.panelUserId);
    await expect(driver.rotate(cred.panelUserId, node, req)).rejects.toThrow('پنل پاسخ نداد');
  });

  it('builds a valid URI for every protocol', async () => {
    const protocols = ['vless', 'trojan', 'shadowsocks', 'wireguard', 'tuic', 'hysteria2'] as const;
    for (const protocol of protocols) {
      const n = makeMockNodeRecord({ id: `n_${protocol}`, publicIp: '5.6.7.8', port: 8443, protocol });
      const d = new MockNodeDriver();
      const cred = await d.issue({ ...req, node: n, protocol });
      const parsed = parseUriToConfig(cred.uri);
      expect(parsed.protocol).toBe(protocol);
      expect(parsed.host).toBe('5.6.7.8');
      expect(parsed.port).toBe(8443);
    }
  });

  it('buildUriFor is independent of the driver that produced the secret', () => {
    const cred = {
      panelUserId: 'x',
      username: 'u',
      uuid: '31415926-5358-9793-2384-626433832795',
      password: '',
      ssMethod: '',
      ssKey: '',
      wgPrivateKey: '',
      wgPublicKey: '',
      wgPsk: '',
      wgEndpointPort: 0,
      wgClientAddress: '',
      tuicCongestion: '',
      hy2Auth: '',
      trafficLimitBytes: 0,
      expiresAt: null,
    };
    const uri = buildUriFor(node, { ...cred, wgClientAddress: '' }, 'تست');
    expect(uri).toMatch(/^vless:\/\//);
    expect(parseUriToConfig(uri).remark).toBe('تست');
  });

  it('sanitises usernames that would break a panel', () => {
    expect(safeUsername('کاربر/فارسی با فاصله')).not.toContain('/');
    expect(safeUsername('کاربر/فارسی با فاصله')).not.toContain(' ');
    expect(safeUsername('')).toBeTruthy();
  });
});

describe('node selection', () => {
  type NodePatch = Partial<ReturnType<typeof makeMockNodeRecord>>;
  const mk = (id: string, over: NodePatch = {}) =>
    makeMockNodeRecord({ id, publicIp: `10.0.0.${id.length}`, ...over });

  it('excludes disabled, down and full nodes', () => {
    expect(isSelectable(mk('a', { enabled: false }))).toBe(false);
    expect(isSelectable(mk('b', { health: 'down' }))).toBe(false);
    expect(isSelectable(mk('c', { capacityUsers: 5, currentUsers: 5 }))).toBe(false);
    expect(isSelectable(mk('d'))).toBe(true);
  });

  it('a node with no capacity limit is never "full"', () => {
    expect(isSelectable(mk('e', { capacityUsers: 0, currentUsers: 9999 }))).toBe(true);
  });

  it('filters by protocol and country', () => {
    const nodes = [
      mk('a', { protocol: 'vless', country: 'nl' }),
      mk('b', { protocol: 'trojan', country: 'de' }),
    ];
    expect(pickNode(nodes, { protocols: ['trojan'] })?.id).toBe('b');
    expect(pickNode(nodes, { countries: ['nl'] })?.id).toBe('a');
    expect(pickNode(nodes, { countries: ['us'] })).toBeNull();
  });

  it('picks deterministically when the RNG is fixed', () => {
    const nodes = [mk('a'), mk('b'), mk('c')];
    expect(pickNode(nodes, {}, () => 0)?.id).toBe('a');
    expect(pickNode(nodes, {}, () => 0.9999)?.id).toBe('c');
  });

  it('never hands back a node marked down', () => {
    const nodes = [mk('a', { health: 'down' }), mk('b', { health: 'down' })];
    for (let i = 0; i < 20; i++) expect(pickNode(nodes, {}, () => i / 20)).toBeNull();
  });

  it('ranks healthy primary nodes first', () => {
    const nodes = [
      mk('low', { priority: 500, health: 'up' }),
      mk('primary', { priority: 100, health: 'up' }),
      mk('unknown', { priority: 100, health: 'unknown' }),
    ];
    expect(rankNodes(nodes).map((n) => n.id)).toEqual(['primary', 'low', 'unknown']);
  });

  it('an unprobed node is tried but not preferred', () => {
    const picks = new Map<string, number>();
    const nodes = [mk('proven', { health: 'up' }), mk('fresh', { health: 'unknown' })];
    for (let i = 0; i < 2000; i++) {
      const id = pickNode(nodes, {}, Math.random)!.id;
      picks.set(id, (picks.get(id) ?? 0) + 1);
    }
    expect(picks.get('proven')!).toBeGreaterThan(picks.get('fresh')!);
    // But it must still be used, or a new node would never be validated.
    expect(picks.get('fresh')!).toBeGreaterThan(100);
  });
});

describe('health probes', () => {
  const base = makeMockNodeRecord({ id: 'n', publicIp: '1.1.1.1' });

  it('one failure does not remove a node', () => {
    const r = applyProbe({ ...base, health: 'up', consecutiveFailures: 0 }, false, 3);
    expect(r.health).not.toBe('down');
    expect(r.consecutiveFailures).toBe(1);
  });

  it('three consecutive failures mark it down', () => {
    let health: NodeHealth = 'up';
    let failures = 0;
    for (let i = 0; i < 3; i++) {
      const r = applyProbe({ ...base, health, consecutiveFailures: failures }, false, 3);
      health = r.health;
      failures = r.consecutiveFailures;
    }
    expect(health).toBe('down');
  });

  it('a success resets the counter, so a flaky node can recover', () => {
    const node = { ...base, health: 'up' as const, consecutiveFailures: 2 };
    const r = applyProbe(node, true, 3);
    expect(r.consecutiveFailures).toBe(0);
    expect(r.health).toBe('up');
  });

  it('recovery is reported so the admin can be notified once, not every probe', () => {
    expect(applyProbe({ ...base, health: 'down' }, true).justChanged).toBe(true);
    expect(applyProbe({ ...base, health: 'up' }, true).justChanged).toBe(false);
  });

  it('a down node stays down through a single failure', () => {
    expect(applyProbe({ ...base, health: 'down', consecutiveFailures: 5 }, false).health).toBe('down');
  });
});

describe('migration targets', () => {
  const nl = makeMockNodeRecord({ id: 'nl1', publicIp: '1.1.1.1', country: 'nl' });
  const nl2 = makeMockNodeRecord({ id: 'nl2', publicIp: '1.1.1.2', country: 'nl' });
  const de = makeMockNodeRecord({ id: 'de1', publicIp: '2.2.2.1', country: 'de' });

  it('prefers staying in the same country', () => {
    const target = pickMigrationTarget([nl, nl2, de], 'nl1', 'nl', () => 0);
    expect(target?.country).toBe('nl');
    expect(target?.id).not.toBe('nl1');
  });

  it('falls back to another country when nothing local is healthy', () => {
    const target = pickMigrationTarget([{ ...nl2, health: 'down' as const }, de], 'nl1', 'nl', () => 0);
    expect(target?.id).toBe('de1');
  });

  it('never migrates onto the node being left', () => {
    for (let i = 0; i < 20; i++) {
      expect(pickMigrationTarget([nl, nl2, de], 'nl1', 'nl', () => i / 20)?.id).not.toBe('nl1');
    }
  });

  it('returns null rather than a dead node when there is nowhere to go', () => {
    expect(pickMigrationTarget([{ ...nl2, health: 'down' as const }], 'nl1', 'nl')).toBeNull();
  });
});

describe('node validation', () => {
  const good = {
    id: 'n',
    name: 'هلند ۱',
    publicIp: '1.2.3.4',
    port: 443,
    protocol: 'vless' as const,
    security: 'reality' as const,
    realityPbk: 'abc',
    country: 'nl',
  };

  it('accepts a correct node', () => {
    expect(validateNode(good).errors).toEqual([]);
  });

  it('refuses Reality without a public key — a config that cannot connect', () => {
    const r = validateNode({ ...good, realityPbk: '' });
    expect(r.errors.some((e) => e.includes('pbk'))).toBe(true);
  });

  it('refuses a private IP, which the customer could never reach', () => {
    expect(validateNode({ ...good, publicIp: '192.168.1.5' }).errors.length).toBeGreaterThan(0);
    expect(validateNode({ ...good, publicIp: '10.0.0.1' }).errors.length).toBeGreaterThan(0);
  });

  it('warns about privileged ports without blocking them', () => {
    const r = validateNode({ ...good, port: 80 });
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBe(1);
  });

  it('rejects an out-of-range port', () => {
    expect(validateNode({ ...good, port: 70000 }).errors.length).toBeGreaterThan(0);
    expect(validateNode({ ...good, port: 0 }).errors.length).toBeGreaterThan(0);
  });

  it('rejects a nameless node', () => {
    expect(validateNode({ ...good, name: '  ' }).errors.length).toBeGreaterThan(0);
  });
});
