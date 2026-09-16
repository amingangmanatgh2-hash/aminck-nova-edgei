import { describe, expect, it } from 'vitest';

import {
  base64ToBytes,
  base64url,
  buildHysteria2,
  buildShadowsocks,
  buildTuic,
  buildTrojan,
  buildUri,
  buildValidUri,
  buildVless,
  buildWireguard,
  bytesToBase64,
  formatHost,
  hasErrors,
  parseHysteria2,
  parseShadowsocks,
  parseTuic,
  parseTrojan,
  parseUri,
  parseUriToConfig,
  parseVless,
  parseWireguard,
  randomBytes,
  randomUuid,
  encodeUserinfo,
  decodeUserinfo,
  stripBrackets,
  validateConfig,
  type Hysteria2Config,
  type ServerConfig,
  type ShadowsocksConfig,
  type TrojanConfig,
  type TuicConfig,
  type VlessConfig,
  type WireguardConfig,
} from '../src/config/uri';

/* ------------------------------------------------------------- fixtures */

const WG_PRIVATE = bytesToBase64(randomBytes(32));
const WG_PUBLIC = bytesToBase64(randomBytes(32));
// A key that actually contains '/' and '+' — the case that broke the parser.
const SLASHY_KEY = 'A/9+Zm3Kq7vT0xNpLrEiHdGfCsBaYoWuJtMnOlPqRk=';

const vlessReality: VlessConfig = {
  protocol: 'vless',
  uuid: '6f7ca1e2-4b3d-4a1c-9e5f-2d8b7a6c5e4f',
  host: 'cdn.example.com',
  port: 443,
  remark: 'آلمان | پرسرعت | 30d',
  network: 'tcp',
  security: 'reality',
  flow: 'xtls-rpc-vision',
  sni: 'www.microsoft.com',
  fp: 'chrome',
  pbk: WG_PUBLIC,
  sid: 'a1b2c3d4',
  spx: '/',
};

const vlessWs: VlessConfig = {
  protocol: 'vless',
  uuid: randomUuid(),
  host: 'edge.example.com',
  port: 8443,
  remark: 'WS | هلند',
  network: 'ws',
  security: 'tls',
  sni: 'edge.example.com',
  path: '/vless-ws',
  hostHeader: 'edge.example.com',
  alpn: 'h2,http/1.1',
};

const vlessPlain: VlessConfig = {
  protocol: 'vless',
  uuid: randomUuid(),
  host: '1.2.3.4',
  port: 2053,
  remark: 'plain',
  network: 'tcp',
  security: 'none',
};

const trojan: TrojanConfig = {
  protocol: 'trojan',
  password: 'Tr0jan!P@ss/w0rd+with=tricky',
  host: 'tr.example.com',
  port: 443,
  remark: 'trojan | فرانسه',
  network: 'tcp',
  sni: 'tr.example.com',
};

const ss2022: ShadowsocksConfig = {
  protocol: 'shadowsocks',
  method: '2022-blake3-aes-256-gcm',
  password: bytesToBase64(randomBytes(32)),
  host: 'ss.example.com',
  port: 8388,
  remark: 'ss2022 | ترکیه',
};

const ssLegacy: ShadowsocksConfig = {
  protocol: 'shadowsocks',
  method: 'aes-256-gcm',
  password: 'legacyPass#1',
  host: 'ss2.example.com',
  port: 8389,
  remark: 'legacy',
  plugin: 'v2ray-plugin',
  pluginOpts: 'tls;host=ss2.example.com',
};

const wg: WireguardConfig = {
  protocol: 'wireguard',
  privateKey: WG_PRIVATE,
  publicKey: WG_PUBLIC,
  address: '172.16.0.2/24',
  host: 'wg.example.com',
  port: 51820,
  remark: 'wireguard | آلمان',
  dns: '1.1.1.1,8.8.8.8',
  mtu: 1420,
  reserved: '1,0,1',
};

const tuic: TuicConfig = {
  protocol: 'tuic',
  uuid: randomUuid(),
  password: 'tuicPass',
  host: 'tuic.example.com',
  port: 443,
  remark: 'tuic | کانادا',
  congestionControl: 'bbr',
  udpRelayMode: 'native',
  sni: 'tuic.example.com',
  alpn: 'h3',
};

const hy2: Hysteria2Config = {
  protocol: 'hysteria2',
  password: 'hy2Pass/with+slash',
  host: 'hy2.example.com',
  port: 443,
  remark: 'hy2 | انگلیس',
  sni: 'hy2.example.com',
  obfs: 'salamander',
  obfsPassword: 'obfs/secret+1',
};

const ALL: ServerConfig[] = [
  vlessReality, vlessWs, vlessPlain, trojan, ss2022, ssLegacy, wg, tuic, hy2,
];

const roundTrip = (config: ServerConfig): ServerConfig =>
  parseUriToConfig(buildUri(config));

/* ------------------------------------------------------------- base64 util */

describe('base64 helpers', () => {
  it('round-trips arbitrary binary bytes', () => {
    for (let len = 0; len < 40; len += 1) {
      const bytes = randomBytes(len);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it('base64url drops padding and swaps the URL-unsafe characters', () => {
    const encoded = base64url('subjects?_d=1');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });

  it('base64url round-trips UTF-8 Persian text', () => {
    const text = 'کانفیگ پرسرعت آلمان 🚀';
    expect(new TextDecoder().decode(base64ToBytes(base64url(text)))).toBe(text);
  });

  it('keeps standard-base64 padding for WireGuard keys', () => {
    const key = bytesToBase64(randomBytes(32));
    expect(key).toMatch(/={1,2}$/);
    expect(key.length).toBe(44);
  });

  it('generates RFC 4122 v4 UUIDs', () => {
    for (let i = 0; i < 50; i += 1) {
      const uuid = randomUuid();
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it('encodes only the illegal userinfo characters', () => {
    expect(encodeUserinfo('a+b=c')).toBe('a+b=c'); // sub-delims stay raw
    expect(encodeUserinfo('a@b')).toBe('a%40b');
    expect(encodeUserinfo('a/b')).toBe('a%2Fb');
    expect(encodeUserinfo('100%')).toBe('100%25');
    expect(decodeUserinfo('100%25')).toBe('100%');
    // A stray '%' must not throw away an otherwise usable password.
    expect(decodeUserinfo('bad%zz')).toBe('bad%zz');
  });

  it('brackets IPv6 hosts and strips them back', () => {
    expect(formatHost('2001:db8::1')).toBe('[2001:db8::1]');
    expect(formatHost('example.com')).toBe('example.com');
    expect(stripBrackets('[2001:db8::1]')).toBe('2001:db8::1');
  });
});

/* --------------------------------------------------------------- builders */

describe('VLESS', () => {
  it('builds a Reality URI with every required parameter', () => {
    const uri = buildVless(vlessReality);
    expect(uri.startsWith('vless://')).toBe(true);
    expect(uri).toContain('security=reality');
    expect(uri).toContain('flow=xtls-rpc-vision');
    expect(uri).toContain('pbk=');
    expect(uri).toContain('sid=a1b2c3d4');
    // '/' in spx must be encoded or it terminates the query in some clients.
    expect(uri).toContain('spx=%2F');
  });

  it('round-trips Reality, WS and plain transports', () => {
    for (const config of [vlessReality, vlessWs, vlessPlain]) {
      expect(roundTrip(config)).toEqual(config);
    }
  });

  it('omits the security parameter for plaintext but restores it on parse', () => {
    const uri = buildVless(vlessPlain);
    expect(uri).not.toContain('security=');
    expect(parseVless(uri).security).toBe('none');
  });

  it('keeps a Persian remark with spaces and a pipe intact', () => {
    const parsed = parseVless(buildVless(vlessReality));
    expect(parsed.remark).toBe('آلمان | پرسرعت | 30d');
  });

  it('survives a remark containing the URI delimiter characters', () => {
    const tricky: VlessConfig = {
      ...vlessPlain,
      remark: 'a#b?c@d/e:f گ#100%',
    };
    expect(parseVless(buildVless(tricky)).remark).toBe(tricky.remark);
  });

  it('rejects a URI without a UUID or port', () => {
    expect(() => parseVless('vless://example.com:443')).toThrow(/missing a UUID/);
    expect(() => parseVless('vless://aaa@bbb')).toThrow(/missing a port/);
    expect(() => parseVless('trojan://x@y:1')).toThrow(/expected vless/);
  });
});

describe('Trojan', () => {
  it('round-trips a password containing the reserved characters', () => {
    const parsed = roundTrip(trojan) as TrojanConfig;
    expect(parsed.password).toBe(trojan.password);
    expect(parsed).toEqual(trojan);
  });

  it('always advertises TLS, since plaintext trojan is not a thing', () => {
    expect(buildTrojan(trojan)).toContain('security=tls');
  });

  it('encodes "@" in a password so the host cannot be swallowed', () => {
    // Regression: an un-encoded '@' made the parser take "w@h" as the host.
    const config: TrojanConfig = { ...trojan, password: 'p@ss', host: 'real.host' };
    const uri = buildTrojan(config);
    expect(uri).toContain('p%40ss@real.host');
    const parsed = parseTrojan(uri);
    expect(parsed.password).toBe('p@ss');
    expect(parsed.host).toBe('real.host');
  });

  it('round-trips a password containing every reserved character', () => {
    const config: TrojanConfig = { ...trojan, password: 'a@b/c?d#e[f]g%h i' };
    expect(parseTrojan(buildTrojan(config)).password).toBe(config.password);
  });
});

describe('Shadowsocks', () => {
  it('encodes userinfo as base64("method:password")', () => {
    const uri = buildShadowsocks(ssLegacy);
    const userinfo = uri.slice('ss://'.length, uri.indexOf('@'));
    const decoded = new TextDecoder().decode(base64ToBytes(userinfo));
    expect(decoded).toBe(`${ssLegacy.method}:${ssLegacy.password}`);
  });

  it('preserves a binary 2022 key byte-for-byte', () => {
    const parsed = roundTrip(ss2022) as ShadowsocksConfig;
    expect(base64ToBytes(parsed.password)).toEqual(base64ToBytes(ss2022.password));
    expect(parsed.password).toBe(ss2022.password);
  });

  it('round-trips the legacy form with a plugin', () => {
    expect(roundTrip(ssLegacy)).toEqual(ssLegacy);
  });

  it('parses the un-encoded ss://method:pass@host:port form too', () => {
    const parsed = parseShadowsocks('ss://aes-256-gcm:pw@1.2.3.4:8388#x');
    expect(parsed.method).toBe('aes-256-gcm');
    expect(parsed.password).toBe('pw');
  });

  it('rejects a 2022 key of the wrong length', () => {
    const bad: ShadowsocksConfig = { ...ss2022, password: bytesToBase64(randomBytes(16)) };
    const issues = validateConfig(bad);
    expect(hasErrors(issues)).toBe(true);
    expect(issues.some((i) => i.field === 'password' && /32/.test(i.message))).toBe(true);
  });
});

describe('WireGuard', () => {
  it('round-trips', () => {
    expect(roundTrip(wg)).toEqual(wg);
  });

  it('percent-encodes "/" in a private key and decodes it back', () => {
    const config: WireguardConfig = { ...wg, privateKey: SLASHY_KEY };
    const uri = buildWireguard(config);
    // '/' is a gen-delim and illegal raw in userinfo; '+' is a sub-delim and
    // stays raw for maximum client compatibility.
    expect(uri).toContain('A%2F9+Zm3');
    expect(uri).not.toContain('A/9');
    expect(parseWireguard(uri).privateKey).toBe(SLASHY_KEY);
  });

  it('accepts a public key containing "/"', () => {
    const config: WireguardConfig = { ...wg, publicKey: SLASHY_KEY };
    expect(parseWireguard(buildWireguard(config)).publicKey).toBe(SLASHY_KEY);
  });

  it('requires publicKey and address', () => {
    expect(() => parseWireguard(`wireguard://${WG_PRIVATE}@h:51820`))
      .toThrow(/missing publicKey/);
    expect(() => parseWireguard(`wireguard://${WG_PRIVATE}@h:51820?publicKey=${WG_PUBLIC}`))
      .toThrow(/missing address/);
  });
});

describe('TUIC and Hysteria2', () => {
  it('round-trips TUIC with uuid:password userinfo', () => {
    expect(roundTrip(tuic)).toEqual(tuic);
  });

  it('parses a TUIC URI that carries no password', () => {
    const noPass: TuicConfig = { ...tuic, password: undefined };
    const parsed = parseTuic(buildTuic(noPass));
    expect(parsed.uuid).toBe(noPass.uuid);
    expect(parsed.password).toBeUndefined();
  });

  it('round-trips Hysteria2 with slashes in both secrets', () => {
    expect(roundTrip(hy2)).toEqual(hy2);
  });
});

describe('IPv6 and odd hosts', () => {
  it('brackets an IPv6 endpoint and parses it back', () => {
    const config: VlessConfig = { ...vlessPlain, host: '2001:db8::1' };
    const uri = buildUri(config);
    expect(uri).toContain('@[2001:db8::1]:2053');
    expect(parseVless(uri).host).toBe('2001:db8::1');
  });
});

/* --------------------------------------------------------- parse dispatch */

describe('parseUriToConfig', () => {
  it('dispatches on scheme for every protocol', () => {
    for (const config of ALL) {
      expect(roundTrip(config)).toEqual(config);
    }
  });

  it('accepts the wg:// alias', () => {
    const uri = buildWireguard(wg).replace(/^wireguard:/, 'wg:');
    expect(parseUriToConfig(uri).protocol).toBe('wireguard');
  });

  it('rejects an unknown scheme with the supported list', () => {
    expect(() => parseUriToConfig('socks://x@y:1')).toThrow(/unsupported scheme "socks"/);
    expect(() => parseUri('not a uri at all')).toThrow(/not a supported URI/);
  });
});

/* ------------------------------------------------------------- validation */

describe('validateConfig', () => {
  it('passes every fixture without errors', () => {
    for (const config of ALL) {
      const issues = validateConfig(config).filter((i) => i.severity === 'error');
      expect(issues, `unexpected errors for ${config.remark}: ${JSON.stringify(issues)}`)
        .toHaveLength(0);
    }
  });

  it('flags a malformed UUID', () => {
    expect(hasErrors(validateConfig({ ...vlessPlain, uuid: 'not-a-uuid' }))).toBe(true);
  });

  it('flags an out-of-range port', () => {
    expect(hasErrors(validateConfig({ ...vlessPlain, port: 0 }))).toBe(true);
    expect(hasErrors(validateConfig({ ...vlessPlain, port: 70000 }))).toBe(true);
  });

  it('warns but does not fail on a privileged port', () => {
    const issues = validateConfig({ ...vlessPlain, port: 443 });
    expect(hasErrors(issues)).toBe(false);
    expect(issues.some((i) => i.severity === 'warn' && i.field === 'port')).toBe(true);
  });

  it('requires pbk and sni for Reality', () => {
    expect(hasErrors(validateConfig({ ...vlessReality, pbk: undefined }))).toBe(true);
    expect(hasErrors(validateConfig({ ...vlessReality, sni: undefined }))).toBe(true);
  });

  it('requires a CIDR address for WireGuard', () => {
    expect(hasErrors(validateConfig({ ...wg, address: '172.16.0.2' }))).toBe(true);
  });

  it('warns when there is no remark, because leak tracking depends on it', () => {
    const issues = validateConfig({ ...vlessPlain, remark: '' });
    expect(issues.some((i) => i.field === 'remark' && i.severity === 'warn')).toBe(true);
  });

  it('buildValidUri refuses to emit a broken config', () => {
    expect(() => buildValidUri({ ...vlessPlain, uuid: 'nope' })).toThrow(/invalid config/);
    expect(buildValidUri(vlessPlain)).toBe(buildUri(vlessPlain));
  });
});

/* ---------------------------------------------------- randomised round trip */

describe('randomised round-trip', () => {
  const hosts = ['1.2.3.4', 'cdn.example.com', '2001:db8::42', 'a-b.c.io'];
  const remarks = [
    'plain', 'فارسی', 'a#b', 'with space', '100%', 'x?y=z', '@at', 'a/b',
    'emoji 🚀', 'very long remark '.repeat(3),
  ];

  const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)] as T;

  it('survives 300 randomised VLESS configs', () => {
    for (let i = 0; i < 300; i += 1) {
      const isReality = Math.random() < 0.5;
      const config: VlessConfig = {
        protocol: 'vless',
        uuid: randomUuid(),
        host: pick(hosts),
        port: 1 + Math.floor(Math.random() * 65535),
        remark: pick(remarks),
        network: pick(['tcp', 'ws', 'grpc'] as const),
        security: isReality ? 'reality' : (Math.random() < 0.5 ? 'tls' : 'none'),
        ...(isReality
          ? { sni: 'sni.example.com', fp: 'chrome', pbk: bytesToBase64(randomBytes(32)), sid: 'deadbeef' }
          : {}),
        ...(Math.random() < 0.5 ? { sni: 'tls.example.com' } : {}),
        ...(Math.random() < 0.5 ? { path: '/p ath/1' } : {}),
        ...(Math.random() < 0.5 ? { hostHeader: 'h.example.com' } : {}),
      };
      expect(roundTrip(config), `failed for ${JSON.stringify(config)}`).toEqual(config);
    }
  });

  it('survives 200 randomised configs across every protocol', () => {
    for (let i = 0; i < 200; i += 1) {
      const config = pick(ALL);
      const variant = {
        ...config,
        host: pick(hosts),
        port: 1 + Math.floor(Math.random() * 65535),
        remark: pick(remarks),
      } as ServerConfig;
      expect(roundTrip(variant), `failed for ${JSON.stringify(variant)}`).toEqual(variant);
    }
  });
});
