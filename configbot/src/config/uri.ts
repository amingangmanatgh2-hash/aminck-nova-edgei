/**
 * VPN config URI builders and parsers.
 *
 * This is the heart of the product: if a URI is wrong the customer gets a
 * config that does not connect, and they blame us, not their client.
 *
 * Every builder here has an inverse parser in the same file, and
 * `test/config-uri.test.ts` asserts build -> parse -> compare for each
 * protocol plus a few hundred randomised inputs. That round-trip is the only
 * cheap way to catch an encoding mistake before a customer does.
 *
 * Runtime: Cloudflare Workers. No Node `Buffer`, no external packages —
 * base64 is done with atob/btoa over explicit byte arrays, which is also what
 * makes binary Shadowsocks 2022 keys survive intact.
 */

export type Transport = 'tcp' | 'ws' | 'grpc' | 'httpupgrade';
export type Security = 'none' | 'tls' | 'reality' | 'xtls';

export interface BaseConfig {
  host: string;
  port: number;
  remark: string;
}

export interface VlessConfig extends BaseConfig {
  protocol: 'vless';
  uuid: string;
  network: Transport;
  security: Security;
  flow?: string;
  sni?: string;
  fp?: string;
  pbk?: string;
  sid?: string;
  spx?: string;
  path?: string;
  hostHeader?: string;
  serviceName?: string;
  alpn?: string;
  allowInsecure?: boolean;
}

export interface TrojanConfig extends BaseConfig {
  protocol: 'trojan';
  password: string;
  network: Transport;
  sni?: string;
  path?: string;
  hostHeader?: string;
  serviceName?: string;
  allowInsecure?: boolean;
}

export interface ShadowsocksConfig extends BaseConfig {
  protocol: 'shadowsocks';
  method: string;
  /** For 2022 ciphers this is raw base64 of 32/16 bytes, not a passphrase. */
  password: string;
  plugin?: string;
  pluginOpts?: string;
}

export interface WireguardConfig extends BaseConfig {
  protocol: 'wireguard';
  /** The client's own private key. */
  privateKey: string;
  /** The server's public key. */
  publicKey: string;
  address: string;
  dns?: string;
  mtu?: number;
  reserved?: string;
  noise?: string;
}

export interface TuicConfig extends BaseConfig {
  protocol: 'tuic';
  uuid: string;
  password?: string;
  congestionControl?: string;
  udpRelayMode?: string;
  sni?: string;
  alpn?: string;
  allowInsecure?: boolean;
  disableSni?: boolean;
}

export interface Hysteria2Config extends BaseConfig {
  protocol: 'hysteria2';
  password: string;
  sni?: string;
  allowInsecure?: boolean;
  obfs?: string;
  obfsPassword?: string;
}

export type ServerConfig =
  | VlessConfig
  | TrojanConfig
  | ShadowsocksConfig
  | WireguardConfig
  | TuicConfig
  | Hysteria2Config;

export type Protocol = ServerConfig['protocol'];

export const PROTOCOLS: Protocol[] = [
  'vless',
  'trojan',
  'shadowsocks',
  'wireguard',
  'tuic',
  'hysteria2',
];

/* ------------------------------------------------------------------ base64 */

const B64URL_CHARS = /\+/g;
const B64URL_SLASH = /\//g;
const B64URL_PAD = /=+$/;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** RFC 4648 §5 base64url, unpadded. */
export function base64url(input: string | Uint8Array): string {
  const b64 = typeof input === 'string' ? bytesToBase64(textToBytes(input)) : bytesToBase64(input);
  return b64.replace(B64URL_CHARS, '-').replace(B64URL_SLASH, '_').replace(B64URL_PAD, '');
}

export function fromBase64url(value: string): string {
  return bytesToText(base64ToBytes(value));
}

/**
 * WireGuard keys are 32 raw bytes shown as *standard* base64 with padding —
 * not base64url. Getting this wrong produces a key the client rejects.
 */
export function base64std(bytes: Uint8Array): string {
  return bytesToBase64(bytes);
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function randomUuid(): string {
  const b = randomBytes(16);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ------------------------------------------------------------------- hosts */

/** Brackets IPv6 literals; leaves everything else alone. */
export function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/* ------------------------------------------------------------- query utils */

type Params = Record<string, string | number | boolean | undefined>;

export function buildQuery(params: Params): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (value === false) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value === true ? '1' : String(value))}`);
  }
  return parts.join('&');
}

export function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
    out[key] = value;
  }
  return out;
}

/**
 * Split `scheme://userinfo@host:port?query#remark`.
 *
 * The remark must stay percent-encoded until the very end: a raw `#` or space
 * in a Persian remark otherwise truncates the URI in some clients.
 *
 * The userinfo class deliberately *allows* `/`. WireGuard keys are standard
 * base64 and routinely contain `/` and `+`; excluding `/` here made any key
 * with a slash fail to parse entirely. It is safe because everything else in
 * the URI is percent-encoded, so the `@` we split on is always the only one.
 */
const URI_RE =
  /^([a-z0-9]+):\/\/(?:([^@?#]*)@)?(\[[^\]]+\]|[^:/?#@]*)(?::(\d+))?(?:\?([^#]*))?(?:#([\s\S]*))?$/i;

/**
 * Percent-encode only the characters RFC 3986 forbids inside `userinfo`.
 *
 * Deliberately surgical: `+` and `=` are sub-delims and stay raw, because
 * WireGuard keys are full of them and some clients do not decode the userinfo
 * at all. But `@`, `/`, `?`, `#` MUST be encoded — a Trojan password
 * containing `@` used to make the parser silently take the wrong host, which
 * produces a config that connects to nowhere and looks like our fault.
 */
const USERINFO_ILLEGAL = /[@/?#[\]%\s]/g;

export function encodeUserinfo(value: string): string {
  return value.replace(USERINFO_ILLEGAL, (ch) => encodeURIComponent(ch));
}

export function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray '%' from an externally-supplied password: keep it verbatim
    // rather than throwing away an otherwise usable config.
    return value;
  }
}

export interface ParsedUri {
  scheme: string;
  userinfo: string;
  host: string;
  port: number | undefined;
  query: Record<string, string>;
  remark: string;
}

export function parseUri(uri: string): ParsedUri {
  const match = URI_RE.exec(uri.trim());
  if (!match) throw new Error(`not a supported URI: ${uri.slice(0, 40)}…`);
  const [, scheme, userinfo, host, port, query, fragment] = match;
  return {
    scheme: (scheme as string).toLowerCase(),
    userinfo: userinfo === undefined ? '' : decodeUserinfo(userinfo),
    host: stripBrackets(host ?? ''),
    port: port === undefined ? undefined : Number(port),
    query: parseQuery(query ?? ''),
    remark: fragment === undefined ? '' : decodeURIComponent(fragment),
  };
}

function assemble(scheme: string, userinfo: string, host: string, port: number,
                  query: string, remark: string): string {
  const q = query ? `?${query}` : '';
  const r = remark ? `#${encodeURIComponent(remark)}` : '';
  return `${scheme}://${encodeUserinfo(userinfo)}@${formatHost(host)}:${port}${q}${r}`;
}

/* ---------------------------------------------------------------- builders */

export function buildVless(c: VlessConfig): string {
  const params: Params = {
    type: c.network !== 'tcp' ? c.network : 'tcp',
    security: c.security === 'none' ? undefined : c.security,
    sni: c.sni,
    host: c.hostHeader,
    path: c.path,
    serviceName: c.serviceName,
    alpn: c.alpn,
    allowInsecure: c.allowInsecure ? '1' : undefined,
  };
  if (c.security === 'reality') {
    params.fp = c.fp ?? 'chrome';
    params.pbk = c.pbk;
    params.sid = c.sid;
    params.spx = c.spx;
    if (c.flow) params.flow = c.flow;
  } else if (c.flow) {
    params.flow = c.flow;
  }
  return assemble('vless', c.uuid, c.host, c.port, buildQuery(params), c.remark);
}

export function buildTrojan(c: TrojanConfig): string {
  const params: Params = {
    type: c.network !== 'tcp' ? c.network : 'tcp',
    security: 'tls',
    sni: c.sni,
    host: c.hostHeader,
    path: c.path,
    serviceName: c.serviceName,
    allowInsecure: c.allowInsecure ? '1' : undefined,
  };
  return assemble('trojan', c.password, c.host, c.port, buildQuery(params), c.remark);
}

export function buildShadowsocks(c: ShadowsocksConfig): string {
  // SIP002: userinfo is base64("method:password"). For 2022 ciphers the
  // password half is itself base64 of raw key bytes, so the outer encoding is
  // applied to an already-ASCII string — no double-decoding anywhere.
  const userinfo = base64url(`${c.method}:${c.password}`);
  const params: Params = {};
  if (c.plugin) params.plugin = c.pluginOpts ? `${c.plugin};${c.pluginOpts}` : c.plugin;
  const query = buildQuery(params);
  const r = c.remark ? `#${encodeURIComponent(c.remark)}` : '';
  return `ss://${userinfo}@${formatHost(c.host)}:${c.port}${query ? `?${query}` : ''}${r}`;
}

export function buildWireguard(c: WireguardConfig): string {
  const params: Params = {
    publicKey: c.publicKey,
    address: c.address,
    dns: c.dns,
    mtu: c.mtu,
    reserved: c.reserved,
    noise: c.noise,
  };
  return assemble('wireguard', c.privateKey, c.host, c.port, buildQuery(params), c.remark);
}

export function buildTuic(c: TuicConfig): string {
  const userinfo = c.password ? `${c.uuid}:${c.password}` : c.uuid;
  const params: Params = {
    congestion_control: c.congestionControl ?? 'bbr',
    udp_relay_mode: c.udpRelayMode ?? 'native',
    sni: c.sni,
    alpn: c.alpn,
    allow_insecure: c.allowInsecure ? '1' : undefined,
    disable_sni: c.disableSni ? '1' : undefined,
  };
  return assemble('tuic', userinfo, c.host, c.port, buildQuery(params), c.remark);
}

export function buildHysteria2(c: Hysteria2Config): string {
  const params: Params = {
    sni: c.sni,
    insecure: c.allowInsecure ? '1' : undefined,
    'obfs-password': c.obfsPassword,
    obfs: c.obfs,
  };
  return assemble('hy2', c.password, c.host, c.port, buildQuery(params), c.remark);
}

export function buildUri(config: ServerConfig): string {
  switch (config.protocol) {
    case 'vless': return buildVless(config);
    case 'trojan': return buildTrojan(config);
    case 'shadowsocks': return buildShadowsocks(config);
    case 'wireguard': return buildWireguard(config);
    case 'tuic': return buildTuic(config);
    case 'hysteria2': return buildHysteria2(config);
    default: {
      const exhaustive: never = config;
      throw new Error(`unsupported protocol: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/* ----------------------------------------------------------------- parsers */

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

export function parseVless(uri: string): VlessConfig {
  const u = parseUri(uri);
  if (u.scheme !== 'vless') throw new Error(`expected vless://, got ${u.scheme}://`);
  if (!u.userinfo) throw new Error('vless URI is missing a UUID');
  if (u.port === undefined) throw new Error('vless URI is missing a port');
  const security = (u.query.security ?? 'none') as Security;
  const cfg: VlessConfig = {
    protocol: 'vless',
    uuid: u.userinfo,
    host: u.host,
    port: u.port,
    remark: u.remark,
    network: (u.query.type ?? 'tcp') as Transport,
    security,
  };
  if (u.query.sni) cfg.sni = u.query.sni;
  if (u.query.host) cfg.hostHeader = u.query.host;
  if (u.query.path) cfg.path = u.query.path;
  if (u.query.serviceName) cfg.serviceName = u.query.serviceName;
  if (u.query.alpn) cfg.alpn = u.query.alpn;
  if (u.query.flow) cfg.flow = u.query.flow;
  if (truthy(u.query.allowInsecure)) cfg.allowInsecure = true;
  if (security === 'reality') {
    if (u.query.fp) cfg.fp = u.query.fp;
    if (u.query.pbk) cfg.pbk = u.query.pbk;
    if (u.query.sid) cfg.sid = u.query.sid;
    if (u.query.spx) cfg.spx = u.query.spx;
  }
  return cfg;
}

export function parseTrojan(uri: string): TrojanConfig {
  const u = parseUri(uri);
  if (u.scheme !== 'trojan') throw new Error(`expected trojan://, got ${u.scheme}://`);
  if (!u.userinfo) throw new Error('trojan URI is missing a password');
  if (u.port === undefined) throw new Error('trojan URI is missing a port');
  const cfg: TrojanConfig = {
    protocol: 'trojan',
    password: u.userinfo,
    host: u.host,
    port: u.port,
    remark: u.remark,
    network: (u.query.type ?? 'tcp') as Transport,
  };
  if (u.query.sni) cfg.sni = u.query.sni;
  if (u.query.host) cfg.hostHeader = u.query.host;
  if (u.query.path) cfg.path = u.query.path;
  if (u.query.serviceName) cfg.serviceName = u.query.serviceName;
  if (truthy(u.query.allowInsecure)) cfg.allowInsecure = true;
  return cfg;
}

export function parseShadowsocks(uri: string): ShadowsocksConfig {
  const u = parseUri(uri);
  if (u.scheme !== 'ss' && u.scheme !== 'shadowsocks') {
    throw new Error(`expected ss://, got ${u.scheme}://`);
  }
  if (u.port === undefined) throw new Error('ss URI is missing a port');
  let method: string;
  let password: string;
  if (u.userinfo.includes(':')) {
    // Un-encoded form: ss://method:password@host:port
    const idx = u.userinfo.indexOf(':');
    method = u.userinfo.slice(0, idx);
    password = u.userinfo.slice(idx + 1);
  } else {
    const decoded = fromBase64url(u.userinfo);
    const idx = decoded.indexOf(':');
    if (idx === -1) throw new Error('ss userinfo did not decode to "method:password"');
    method = decoded.slice(0, idx);
    password = decoded.slice(idx + 1);
  }
  const cfg: ShadowsocksConfig = {
    protocol: 'shadowsocks',
    method,
    password,
    host: u.host,
    port: u.port,
    remark: u.remark,
  };
  const plugin = u.query.plugin;
  if (plugin) {
    const semi = plugin.indexOf(';');
    if (semi === -1) {
      cfg.plugin = plugin;
    } else {
      cfg.plugin = plugin.slice(0, semi);
      cfg.pluginOpts = plugin.slice(semi + 1);
    }
  }
  return cfg;
}

export function parseWireguard(uri: string): WireguardConfig {
  const u = parseUri(uri);
  if (u.scheme !== 'wireguard' && u.scheme !== 'wg') {
    throw new Error(`expected wireguard://, got ${u.scheme}://`);
  }
  if (!u.userinfo) throw new Error('wireguard URI is missing a private key');
  if (u.port === undefined) throw new Error('wireguard URI is missing a port');
  if (!u.query.publicKey) throw new Error('wireguard URI is missing publicKey');
  if (!u.query.address) throw new Error('wireguard URI is missing address');
  const cfg: WireguardConfig = {
    protocol: 'wireguard',
    privateKey: u.userinfo,
    publicKey: u.query.publicKey,
    address: u.query.address,
    host: u.host,
    port: u.port,
    remark: u.remark,
  };
  if (u.query.dns) cfg.dns = u.query.dns;
  if (u.query.mtu) cfg.mtu = Number(u.query.mtu);
  if (u.query.reserved) cfg.reserved = u.query.reserved;
  if (u.query.noise) cfg.noise = u.query.noise;
  return cfg;
}

export function parseTuic(uri: string): TuicConfig {
  const u = parseUri(uri);
  if (u.scheme !== 'tuic') throw new Error(`expected tuic://, got ${u.scheme}://`);
  if (!u.userinfo) throw new Error('tuic URI is missing a UUID');
  if (u.port === undefined) throw new Error('tuic URI is missing a port');
  const idx = u.userinfo.indexOf(':');
  const uuid = idx === -1 ? u.userinfo : u.userinfo.slice(0, idx);
  const cfg: TuicConfig = {
    protocol: 'tuic',
    uuid,
    host: u.host,
    port: u.port,
    remark: u.remark,
  };
  if (idx !== -1) cfg.password = u.userinfo.slice(idx + 1);
  if (u.query.congestion_control) cfg.congestionControl = u.query.congestion_control;
  if (u.query.udp_relay_mode) cfg.udpRelayMode = u.query.udp_relay_mode;
  if (u.query.sni) cfg.sni = u.query.sni;
  if (u.query.alpn) cfg.alpn = u.query.alpn;
  if (truthy(u.query.allow_insecure)) cfg.allowInsecure = true;
  if (truthy(u.query.disable_sni)) cfg.disableSni = true;
  return cfg;
}

export function parseHysteria2(uri: string): Hysteria2Config {
  const u = parseUri(uri);
  if (u.scheme !== 'hy2' && u.scheme !== 'hysteria2') {
    throw new Error(`expected hy2://, got ${u.scheme}://`);
  }
  if (!u.userinfo) throw new Error('hy2 URI is missing a password');
  if (u.port === undefined) throw new Error('hy2 URI is missing a port');
  const cfg: Hysteria2Config = {
    protocol: 'hysteria2',
    password: u.userinfo,
    host: u.host,
    port: u.port,
    remark: u.remark,
  };
  if (u.query.sni) cfg.sni = u.query.sni;
  if (truthy(u.query.insecure)) cfg.allowInsecure = true;
  if (u.query.obfs) cfg.obfs = u.query.obfs;
  if (u.query['obfs-password']) cfg.obfsPassword = u.query['obfs-password'];
  return cfg;
}

export function parseUriToConfig(uri: string): ServerConfig {
  const scheme = uri.trim().slice(0, uri.indexOf('://')).toLowerCase();
  switch (scheme) {
    case 'vless': return parseVless(uri);
    case 'trojan': return parseTrojan(uri);
    case 'ss':
    case 'shadowsocks': return parseShadowsocks(uri);
    case 'wireguard':
    case 'wg': return parseWireguard(uri);
    case 'tuic': return parseTuic(uri);
    case 'hy2':
    case 'hysteria2': return parseHysteria2(uri);
    default:
      throw new Error(`unsupported scheme "${scheme}" — supported: ${PROTOCOLS.join(', ')}`);
  }
}

/* ------------------------------------------------------------ validation */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WG_KEY_RE = /^[A-Za-z0-9+/]{42,44}={0,2}$/;

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warn';
}

/**
 * Catches the mistakes that produce a config the client accepts but that
 * never connects — the most expensive kind of bug, because the customer only
 * finds out after paying.
 */
export function validateConfig(c: ServerConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (field: string, message: string) => issues.push({ field, message, severity: 'error' });
  const warn = (field: string, message: string) => issues.push({ field, message, severity: 'warn' });

  if (!c.host) err('host', 'آدرس سرور خالی است');
  if (c.host.includes(' ')) err('host', 'آدرس سرور فاصله دارد');
  if (!Number.isFinite(c.port) || c.port < 1 || c.port > 65535) {
    err('port', `پورت نامعتبر: ${c.port}`);
  } else if (c.port < 1024) {
    warn('port', 'پورت‌های زیر ۱۰۲۴ معمولاً روی VPS نیاز به root دارند');
  }
  if (!c.remark.trim()) warn('remark', 'بدون remark، ردیابی نشتی کانفیگ ممکن نیست');

  switch (c.protocol) {
    case 'vless': {
      if (!UUID_RE.test(c.uuid)) err('uuid', 'UUID معتبر نیست');
      if (c.security === 'reality') {
        if (!c.pbk) err('pbk', 'برای Reality کلید عمومی (pbk) لازم است');
        else if (!WG_KEY_RE.test(c.pbk)) err('pbk', 'pbk باید base64 با طول ۴۴ باشد');
        if (!c.sni) err('sni', 'برای Reality مقدار sni لازم است');
        if (!c.fp) warn('fp', 'fp تعیین نشده؛ پیش‌فرض chrome گذاشته می‌شود');
      }
      if (c.security === 'tls' && !c.sni) warn('sni', 'TLS بدون sni روی اکثر کلاینت‌ها خطا می‌دهد');
      if (c.network === 'ws' && !c.path) warn('path', 'WS بدون path معمولاً کار نمی‌کند');
      break;
    }
    case 'trojan': {
      if (!c.password) err('password', 'رمز trojan خالی است');
      if (!c.sni) warn('sni', 'trojan بدون sni روی اکثر کلاینت‌ها خطا می‌دهد');
      break;
    }
    case 'shadowsocks': {
      if (!c.method) err('method', 'روش رمزنگاری خالی است');
      if (!c.password) err('password', 'کلید shadowsocks خالی است');
      if (c.method.startsWith('2022-')) {
        const raw = base64ToBytes(c.password);
        const expected = c.method.includes('256') || c.method.includes('chacha20') ? 32 : 16;
        if (raw.length !== expected) {
          err('password', `کلید ${c.method} باید ${expected} بایت باشد، ${raw.length} بایت است`);
        }
      }
      break;
    }
    case 'wireguard': {
      if (!WG_KEY_RE.test(c.privateKey)) err('privateKey', 'کلید خصوصی WireGuard معتبر نیست');
      if (!WG_KEY_RE.test(c.publicKey)) err('publicKey', 'کلید عمومی WireGuard معتبر نیست');
      if (!c.address.includes('/')) err('address', 'address باید CIDR باشد، مثلاً 172.16.0.2/24');
      break;
    }
    case 'tuic': {
      if (!UUID_RE.test(c.uuid)) err('uuid', 'UUID معتبر نیست');
      if (!c.sni) warn('sni', 'tuic بدون sni معمولاً وصل نمی‌شود');
      break;
    }
    case 'hysteria2': {
      if (!c.password) err('password', 'رمز hysteria2 خالی است');
      if (!c.sni) warn('sni', 'hy2 بدون sni معمولاً وصل نمی‌شود');
      break;
    }
    default: {
      const exhaustive: never = c;
      err('protocol', `پروتکل ناشناخته: ${JSON.stringify(exhaustive)}`);
    }
  }
  return issues;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/** Build only if the config is valid; otherwise throw with all reasons. */
export function buildValidUri(c: ServerConfig): string {
  const issues = validateConfig(c).filter((i) => i.severity === 'error');
  if (issues.length) {
    throw new Error(`invalid config: ${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`);
  }
  return buildUri(c);
}
