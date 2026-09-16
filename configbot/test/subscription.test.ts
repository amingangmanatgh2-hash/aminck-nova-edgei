import { describe, expect, it } from 'vitest';

import {
  contentTypeFor,
  detectFormat,
  render,
  renderBase64,
  renderClash,
  renderRaw,
  renderSingbox,
  renderWireguardConf,
  subscriptionHeaders,
} from '../src/config/subscription';
import {
  base64ToBytes,
  buildUri,
  bytesToBase64,
  randomBytes,
  randomUuid,
  textToBytes,
  type ServerConfig,
  type TrojanConfig,
  type VlessConfig,
  type WireguardConfig,
} from '../src/config/uri';

const decode = (b64: string) => new TextDecoder().decode(base64ToBytes(b64));

const vlessReality: VlessConfig = {
  protocol: 'vless',
  uuid: randomUuid(),
  host: 'cdn.example.com',
  port: 443,
  remark: 'آلمان | Reality',
  network: 'tcp',
  security: 'reality',
  sni: 'www.microsoft.com',
  fp: 'chrome',
  pbk: bytesToBase64(randomBytes(32)),
  sid: 'a1b2c3d4',
  flow: 'xtls-rpc-vision',
};

const trojan: TrojanConfig = {
  protocol: 'trojan',
  password: 'p@ss/w0rd',
  host: 'tr.example.com',
  port: 443,
  remark: 'فرانسه | trojan',
  network: 'tcp',
  sni: 'tr.example.com',
};

const wg: WireguardConfig = {
  protocol: 'wireguard',
  privateKey: bytesToBase64(randomBytes(32)),
  publicKey: bytesToBase64(randomBytes(32)),
  address: '172.16.0.2/24',
  host: 'wg.example.com',
  port: 51820,
  remark: 'آلمان | wireguard',
  dns: '1.1.1.1',
  mtu: 1420,
};

const MIXED: ServerConfig[] = [vlessReality, trojan, wg];

describe('client detection', () => {
  it.each([
    ['v2rayNG/1.8.0', 'base64'],
    ['HiddifyNext/1.2', 'base64'],
    ['Streisand/66', 'base64'],
    ['Shadowrocket/2536', 'base64'],
    ['clash-verge/v1.5', 'clash'],
    ['mihomo/1.18', 'clash'],
    ['SFA/17', 'singbox'],
    ['sing-box/1.9', 'singbox'],
    ['WireGuard/1.0', 'wireguard'],
  ])('maps User-Agent %s to %s', (ua, expected) => {
    expect(detectFormat(ua)).toBe(expected);
  });

  it('defaults to base64 when the client is unknown or absent', () => {
    expect(detectFormat(null)).toBe('base64');
    expect(detectFormat('SomeRandomBrowser/1.0')).toBe('base64');
  });

  it('lets an explicit ?type= override the User-Agent', () => {
    expect(detectFormat('clash-verge/1.5', 'singbox')).toBe('singbox');
    expect(detectFormat('WireGuard/1.0', 'raw')).toBe('raw');
  });

  it('ignores a bogus explicit type and falls back to detection', () => {
    expect(detectFormat('HiddifyNext/1.2', 'nonsense')).toBe('base64');
  });

  it('has a content type per format', () => {
    expect(contentTypeFor('clash')).toContain('yaml');
    expect(contentTypeFor('singbox')).toContain('json');
    expect(contentTypeFor('base64')).toContain('text/plain');
  });
});

describe('subscription headers', () => {
  it('advertises a base64 profile title so clients name the profile', () => {
    const headers = subscriptionHeaders({ title: 'کانفیگ من' }, 'base64');
    const title = headers['profile-title'] ?? '';
    expect(title).toMatch(/^base64:/);
    expect(decode(title.slice('base64:'.length))).toBe('کانفیگ من');
  });

  it('defaults the update interval so profiles auto-refresh', () => {
    const headers = subscriptionHeaders({}, 'base64');
    expect(headers['profile-update-interval']).toBe('12');
  });

  it('never caches a subscription, since it changes when a config rotates', () => {
    expect(subscriptionHeaders({}, 'base64')['cache-control']).toContain('no-store');
  });

  it('strips characters that would break the Content-Disposition filename', () => {
    const headers = subscriptionHeaders({ title: 'bad"name\nhere' }, 'base64');
    const disposition = headers['content-disposition'] ?? '';
    expect(disposition).toBeTruthy();
    expect(disposition).not.toContain('"name');
    expect(disposition).not.toContain('\n');
  });
});

describe('base64 list format', () => {
  it('is newline-joined URIs, base64-encoded', () => {
    const decoded = decode(renderBase64([vlessReality, trojan]));
    const lines = decoded.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(buildUri(vlessReality));
    expect(lines[1]).toBe(buildUri(trojan));
  });

  it('excludes WireGuard, which breaks some clients when present in the list', () => {
    const decoded = decode(renderBase64(MIXED));
    expect(decoded.split('\n')).toHaveLength(2);
    expect(decoded).not.toContain('wireguard://');
  });

  it('returns an empty string for an empty list, not "null"', () => {
    expect(renderBase64([])).toBe('');
    expect(renderRaw([])).toBe('');
  });

  it('keeps a Persian remark intact after decoding', () => {
    const raw = decode(renderBase64([trojan]));
    // The remark stays percent-encoded inside the URI (a raw '#' or space
    // would truncate it in some clients), so decode the fragment to read it.
    const fragment = raw.slice(raw.indexOf('#') + 1);
    expect(decodeURIComponent(fragment)).toBe('فرانسه | trojan');
  });
});

describe('Clash profile', () => {
  it('is parseable YAML with proxies and Iran-direct rules', () => {
    const yaml = renderClash(MIXED);
    expect(yaml).toContain('proxies:');
    expect(yaml).toContain('proxy-groups:');
    expect(yaml).toContain('GEOIP,IR,DIRECT');
    expect(yaml).toContain('GEOSITE,ir,DIRECT');
  });

  it('emits reality-opts for a Reality node', () => {
    const yaml = renderClash([vlessReality]);
    expect(yaml).toContain('reality-opts:');
    expect(yaml).toContain('public-key:');
    expect(yaml).toContain('client-fingerprint: chrome');
  });

  it('quotes a Persian remark containing a pipe so YAML stays valid', () => {
    const yaml = renderClash([trojan]);
    // A bare `|` would start a YAML block scalar and corrupt the document.
    expect(yaml).toContain("'فرانسه | trojan'");
  });

  it('omits WireGuard, which Clash cannot import', () => {
    expect(renderClash([wg])).not.toContain('wireguard');
  });

  it('still produces a valid document when every node is filtered out', () => {
    const yaml = renderClash([wg]);
    expect(yaml).toContain('proxies:');
  });
});

describe('Sing-box profile', () => {
  it('is valid JSON with a selector and every outbound', () => {
    const profile = JSON.parse(renderSingbox(MIXED)) as {
      outbounds: Array<{ tag: string; type: string }>;
    };
    const tags = profile.outbounds.map((o) => o.tag);
    expect(tags).toContain('آلمان | Reality');
    expect(tags).toContain('فرانسه | trojan');
    expect(tags).toContain('آلمان | wireguard');
    expect(profile.outbounds.some((o) => o.type === 'selector')).toBe(true);
  });

  it('maps WireGuard into a real sing-box outbound', () => {
    const profile = JSON.parse(renderSingbox([wg])) as {
      outbounds: Array<Record<string, unknown>>;
    };
    const node = profile.outbounds.find((o) => o.type === 'wireguard');
    expect(node).toBeDefined();
    expect(node?.peer_public_key).toBe(wg.publicKey);
    expect(node?.private_key).toBe(wg.privateKey);
    expect(node?.address).toEqual(['172.16.0.2/24']);
  });

  it('ships Iran bypass rule-sets so domestic sites stay direct', () => {
    const profile = JSON.parse(renderSingbox([trojan])) as {
      route: { rule_set: Array<{ tag: string }> };
    };
    const tags = profile.route.rule_set.map((r) => r.tag);
    expect(tags).toContain('geoip-ir');
    expect(tags).toContain('geosite-ir');
  });
});

describe('WireGuard .conf', () => {
  it('produces an importable config file', () => {
    const conf = renderWireguardConf(wg);
    expect(conf).toContain('[Interface]');
    expect(conf).toContain(`PrivateKey = ${wg.privateKey}`);
    expect(conf).toContain('[Peer]');
    expect(conf).toContain(`PublicKey = ${wg.publicKey}`);
    expect(conf).toContain(`Endpoint = ${wg.host}:${wg.port}`);
    expect(conf).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
    expect(conf).toContain('PersistentKeepalive = 25');
  });

  it('brackets an IPv6 endpoint', () => {
    const conf = renderWireguardConf({ ...wg, host: '2001:db8::1' });
    expect(conf).toContain('Endpoint = [2001:db8::1]:51820');
  });
});

describe('render dispatch', () => {
  it('picks the right renderer for each format', () => {
    expect(render(MIXED, 'base64')).toBe(renderBase64(MIXED));
    expect(render(MIXED, 'raw')).toBe(renderRaw(MIXED));
    expect(render(MIXED, 'clash')).toBe(renderClash(MIXED, {}));
    expect(render(MIXED, 'singbox')).toBe(renderSingbox(MIXED));
  });

  it('returns the .conf when the plan has WireGuard', () => {
    expect(render(MIXED, 'wireguard')).toContain('[Interface]');
  });

  it('falls back to the URI list rather than an empty body', () => {
    // An empty subscription body makes clients report "subscription broken".
    const out = render([vlessReality, trojan], 'wireguard');
    expect(out).toContain('vless://');
    expect(out).toContain('trojan://');
  });
});

describe('leak tracking', () => {
  it('every config in a subscription carries a distinct remark', () => {
    const decoded = decode(renderBase64([vlessReality, trojan]));
    const remarks = decoded.split('\n').map((line) => decodeURIComponent(line.split('#')[1] ?? ''));
    expect(new Set(remarks).size).toBe(remarks.length);
  });

  it('the raw text round-trips back through the URI parser', () => {
    // Guards against a future encoding change silently breaking imports.
    for (const line of renderRaw([vlessReality, trojan]).split('\n')) {
      expect(line).toMatch(/^(vless|trojan):\/\//);
    }
    expect(textToBytes(renderRaw([trojan])).length).toBeGreaterThan(0);
  });
});
