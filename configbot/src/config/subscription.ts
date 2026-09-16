/**
 * Subscription link output.
 *
 * One URL, four shapes, chosen by `User-Agent` (or `?type=`). This matters
 * more than it looks: a customer pastes the same link into v2rayNG, Hiddify,
 * Sing-box or WireGuard and expects all of them to work. If we only emit one
 * format, half of them get a broken import and open a support ticket.
 *
 * Everything here is pure and synchronous so it can be cached with the Cache
 * API and served from the edge.
 */

import {
  buildUri,
  bytesToBase64,
  textToBytes,
  type ServerConfig,
  type VlessConfig,
  type TrojanConfig,
  type ShadowsocksConfig,
  type WireguardConfig,
} from './uri';

export type SubFormat = 'base64' | 'clash' | 'singbox' | 'wireguard' | 'raw';

export interface SubscriptionMeta {
  title: string;
  /** Profile update interval in hours, advertised to the client. */
  updateIntervalHours: number;
  profileWebPageUrl?: string;
}

const DEFAULT_META: SubscriptionMeta = {
  title: 'Config Subscription',
  updateIntervalHours: 12,
};

/* -------------------------------------------------------- client detection */

const UA_PATTERNS: Array<[RegExp, SubFormat]> = [
  [/wireguard/i, 'wireguard'],
  [/sing-?box|sfa|sfi|sfm|sft/i, 'singbox'],
  [/clash|meta|mihomo/i, 'clash'],
  // v2rayNG, Hiddify, Streisand, Shadowrocket, V2Box all read the plain
  // base64 list. Listed last so the specific ones win.
  [/v2ray|v2rayng|hiddify|streisand|shadowrocket|v2box|fair|napsternet|oneclick|foxray/i, 'base64'],
];

export function detectFormat(userAgent: string | null, explicit?: string): SubFormat {
  const wanted = (explicit ?? '').toLowerCase();
  if (wanted === 'base64' || wanted === 'clash' || wanted === 'singbox'
      || wanted === 'wireguard' || wanted === 'raw') {
    return wanted;
  }
  if (!userAgent) return 'base64';
  for (const [re, format] of UA_PATTERNS) {
    if (re.test(userAgent)) return format;
  }
  return 'base64';
}

export function contentTypeFor(format: SubFormat): string {
  switch (format) {
    case 'clash': return 'text/yaml; charset=utf-8';
    case 'singbox': return 'application/json; charset=utf-8';
    case 'wireguard': return 'text/plain; charset=utf-8';
    case 'raw': return 'text/plain; charset=utf-8';
    default: return 'text/plain; charset=utf-8';
  }
}

/**
 * Headers that make clients auto-name and auto-refresh the profile.
 * Without these, v2rayNG/Hiddify show an untitled profile that never updates.
 */
export function subscriptionHeaders(meta: Partial<SubscriptionMeta>, format: SubFormat): Record<string, string> {
  const merged = { ...DEFAULT_META, ...meta };
  const headers: Record<string, string> = {
    'content-type': contentTypeFor(format),
    'content-disposition': `attachment; filename="${merged.title.replace(/["\n]/g, '')}.txt"`,
    'profile-title': `base64:${bytesToBase64(textToBytes(merged.title))}`,
    'profile-update-interval': String(merged.updateIntervalHours),
    'cache-control': 'private, max-age=0, no-store',
  };
  if (merged.profileWebPageUrl) {
    headers['profile-web-page-url'] = merged.profileWebPageUrl;
  }
  return headers;
}

/* ----------------------------------------------------------- base64 list */

/**
 * The format v2rayNG / Hiddify / Streisand expect: one URI per line, the
 * whole thing base64-encoded.
 *
 * WireGuard configs are excluded from this list on purpose — those clients
 * cannot import them and a stray `wireguard://` line makes some of them fail
 * the entire import instead of skipping the line.
 */
export function renderBase64(configs: ServerConfig[]): string {
  const lines = configs
    .filter((c) => c.protocol !== 'wireguard')
    .map((c) => buildUri(c));
  return bytesToBase64(textToBytes(lines.join('\n')));
}

export function renderRaw(configs: ServerConfig[]): string {
  return configs.map((c) => buildUri(c)).join('\n');
}

/* ------------------------------------------------------------------- clash */

function yamlString(value: string): string {
  // Quote only when needed; a Persian remark with a colon would break YAML.
  if (/^[\w.\-/@ ]+$/u.test(value) && !/^\d+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

function clashNode(c: ServerConfig): Record<string, unknown> | null {
  switch (c.protocol) {
    case 'vless': {
      const v = c as VlessConfig;
      const node: Record<string, unknown> = {
        name: v.remark,
        type: 'vless',
        server: v.host,
        port: v.port,
        uuid: v.uuid,
        udp: true,
      };
      if (v.security === 'reality' || v.security === 'tls') {
        node.tls = true;
        node.servername = v.sni ?? '';
        node['client-fingerprint'] = v.fp ?? 'chrome';
        if (v.security === 'reality') {
          node['reality-opts'] = {
            'public-key': v.pbk ?? '',
            'short-id': v.sid ?? '',
          };
        }
      }
      if (v.flow) node.flow = v.flow;
      if (v.network === 'ws') {
        node.network = 'ws';
        node['ws-opts'] = { path: v.path ?? '/', headers: { Host: v.hostHeader ?? v.sni ?? '' } };
      } else if (v.network === 'grpc') {
        node.network = 'grpc';
        node['grpc-opts'] = { 'grpc-service-name': v.serviceName ?? '' };
      }
      if (v.alpn) node.alpn = v.alpn.split(',');
      return node;
    }
    case 'trojan': {
      const t = c as TrojanConfig;
      const node: Record<string, unknown> = {
        name: t.remark,
        type: 'trojan',
        server: t.host,
        port: t.port,
        password: t.password,
        udp: true,
      };
      if (t.sni) node.sni = t.sni;
      if (t.network === 'ws') {
        node.network = 'ws';
        node['ws-opts'] = { path: t.path ?? '/', headers: { Host: t.hostHeader ?? t.sni ?? '' } };
      }
      return node;
    }
    case 'shadowsocks': {
      const s = c as ShadowsocksConfig;
      const node: Record<string, unknown> = {
        name: s.remark,
        type: 'ss',
        server: s.host,
        port: s.port,
        cipher: s.method,
        password: s.password,
        udp: true,
      };
      if (s.plugin) {
        node.plugin = s.plugin;
        if (s.pluginOpts) node['plugin-opts'] = s.pluginOpts;
      }
      return node;
    }
    case 'tuic': {
      const t = c as import('./uri').TuicConfig;
      return {
        name: t.remark,
        type: 'tuic',
        server: t.host,
        port: t.port,
        uuid: t.uuid,
        password: t.password ?? '',
        sni: t.sni ?? '',
        'congestion-controller': t.congestionControl ?? 'bbr',
        'udp-relay-mode': t.udpRelayMode ?? 'native',
        alpn: t.alpn ? t.alpn.split(',') : ['h3'],
        'disable-sni': t.disableSni ?? false,
        udp: true,
      };
    }
    case 'hysteria2': {
      const h = c as import('./uri').Hysteria2Config;
      return {
        name: h.remark,
        type: 'hysteria2',
        server: h.host,
        port: h.port,
        password: h.password,
        sni: h.sni ?? '',
        'skip-cert-verify': h.allowInsecure ?? false,
        obfs: h.obfs,
        'obfs-password': h.obfsPassword,
        udp: true,
      };
    }
    case 'wireguard':
      return null; // Clash has no native wg support in most builds
    default:
      return null;
  }
}

function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return `${pad}null\n`;
  if (typeof value === 'boolean' || typeof value === 'number') return `${pad}${value}\n`;
  if (typeof value === 'string') return `${pad}${yamlString(value)}\n`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const nested = toYaml(item, indent + 1).replace(/^ {2}/, `${pad}- `);
          return nested;
        }
        return `${pad}- ${typeof item === 'string' ? yamlString(item) : item}\n`;
      })
      .join('');
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      }
      if (Array.isArray(v)) {
        return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      }
      return `${pad}${k}: ${typeof v === 'string' ? yamlString(v) : v}\n`;
    })
    .join('');
}

export function renderClash(configs: ServerConfig[], meta: Partial<SubscriptionMeta> = {}): string {
  const nodes = configs
    .map((c) => clashNode(c))
    .filter((n): n is Record<string, unknown> => n !== null);
  const names = nodes.map((n) => String(n.name));
  const title = meta.title ?? DEFAULT_META.title;
  const profile: Record<string, unknown> = {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    'unified-delay': true,
    proxies: nodes,
    'proxy-groups': [
      {
        name: 'PROXY',
        type: 'select',
        proxies: [...names, 'DIRECT'],
      },
    ],
    rules: [
      'GEOIP,IR,DIRECT',
      'GEOSITE,ir,DIRECT',
      'MATCH,PROXY',
    ],
  };
  return `# ${title}\n# Generated by configbot\n\n${toYaml(profile)}`;
}

/* ----------------------------------------------------------------- singbox */

function singOutbound(c: ServerConfig): Record<string, unknown> | null {
  const base = { tag: c.remark, detour: undefined };
  switch (c.protocol) {
    case 'vless': {
      const v = c as VlessConfig;
      const out: Record<string, unknown> = {
        ...base,
        type: 'vless',
        server: v.host,
        server_port: v.port,
        uuid: v.uuid,
      };
      if (v.flow) out.flow = v.flow;
      if (v.security === 'reality') {
        out.tls = {
          enabled: true,
          server_name: v.sni ?? '',
          utls: { enabled: true, fingerprint: v.fp ?? 'chrome' },
          reality: { enabled: true, public_key: v.pbk ?? '', short_id: v.sid ?? '' },
        };
      } else if (v.security === 'tls') {
        out.tls = { enabled: true, server_name: v.sni ?? '' };
      }
      if (v.network === 'ws') {
        out.transport = {
          type: 'ws',
          path: v.path ?? '/',
          headers: v.hostHeader ? { Host: v.hostHeader } : undefined,
        };
      } else if (v.network === 'grpc') {
        out.transport = { type: 'grpc', service_name: v.serviceName ?? '' };
      }
      return out;
    }
    case 'trojan': {
      const t = c as TrojanConfig;
      const out: Record<string, unknown> = {
        ...base,
        type: 'trojan',
        server: t.host,
        server_port: t.port,
        password: t.password,
      };
      if (t.sni) out.tls = { enabled: true, server_name: t.sni };
      if (t.network === 'ws') out.transport = { type: 'ws', path: t.path ?? '/' };
      return out;
    }
    case 'shadowsocks': {
      const s = c as ShadowsocksConfig;
      return {
        ...base,
        type: 'shadowsocks',
        server: s.host,
        server_port: s.port,
        method: s.method,
        password: s.password,
        plugin: s.plugin,
        plugin_opts: s.pluginOpts,
      };
    }
    case 'tuic': {
      const t = c as import('./uri').TuicConfig;
      return {
        ...base,
        type: 'tuic',
        server: t.host,
        server_port: t.port,
        uuid: t.uuid,
        password: t.password ?? '',
        congestion_control: t.congestionControl ?? 'bbr',
        udp_relay_mode: t.udpRelayMode ?? 'native',
        tls: { enabled: true, server_name: t.sni ?? '', alpn: t.alpn ? t.alpn.split(',') : ['h3'] },
      };
    }
    case 'hysteria2': {
      const h = c as import('./uri').Hysteria2Config;
      return {
        ...base,
        type: 'hysteria2',
        server: h.host,
        server_port: h.port,
        password: h.password,
        tls: { enabled: true, server_name: h.sni ?? '', insecure: h.allowInsecure ?? false },
        obfs: h.obfs,
        obfs_password: h.obfsPassword,
      };
    }
    case 'wireguard': {
      const w = c as WireguardConfig;
      return {
        ...base,
        type: 'wireguard',
        server: w.host,
        server_port: w.port,
        private_key: w.privateKey,
        peer_public_key: w.publicKey,
        address: w.address.split(',').map((a) => a.trim()),
        mtu: w.mtu ?? 1420,
        reserved: w.reserved,
      };
    }
    default:
      return null;
  }
}

export function renderSingbox(configs: ServerConfig[]): string {
  const outbounds = configs
    .map((c) => singOutbound(c))
    .filter((o): o is Record<string, unknown> => o !== null);
  const tags = outbounds.map((o) => String(o.tag));
  const profile = {
    log: { level: 'warn', timestamp: true },
    dns: {
      servers: [
        { tag: 'remote', address: 'https://1.1.1.1/dns-query', detour: 'select' },
        { tag: 'local', address: 'local', detour: 'direct' },
      ],
      rules: [{ outbound: 'any', server: 'local' }],
      strategy: 'prefer_ipv4',
    },
    outbounds: [
      {
        type: 'selector',
        tag: 'select',
        outbounds: [...tags, 'direct'],
      },
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
      { type: 'dns', tag: 'dns-out' },
      ...outbounds,
    ],
    route: {
      rules: [
        { protocol: 'dns', outbound: 'dns-out' },
        { ip_is_private: true, outbound: 'direct' },
        { rule_set: ['geoip-ir', 'geosite-ir'], outbound: 'direct' },
      ],
      rule_set: [
        { tag: 'geoip-ir', type: 'remote', format: 'binary', url: 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geoip-ir.srs' },
        { tag: 'geosite-ir', type: 'remote', format: 'binary', url: 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-ir.srs' },
      ],
      auto_detect_interface: true,
    },
  };
  return `${JSON.stringify(profile, null, 2)}\n`;
}

/* -------------------------------------------------------------- wireguard */

/**
 * A real `.conf` file. WireGuard clients will not read a `wireguard://` URI
 * from a subscription, so if the customer's plan is WireGuard we hand them
 * something they can actually import.
 */
export function renderWireguardConf(c: WireguardConfig): string {
  const lines = [
    '[Interface]',
    `PrivateKey = ${c.privateKey}`,
    `Address = ${c.address}`,
  ];
  if (c.dns) lines.push(`DNS = ${c.dns}`);
  if (c.mtu) lines.push(`MTU = ${c.mtu}`);
  if (c.reserved) lines.push(`# reserved = ${c.reserved}`);
  lines.push('', '[Peer]', `PublicKey = ${c.publicKey}`,
    `Endpoint = ${c.host.includes(':') ? `[${c.host}]` : c.host}:${c.port}`,
    'AllowedIPs = 0.0.0.0/0, ::/0',
    'PersistentKeepalive = 25',
    '',
  );
  return lines.join('\n');
}

export function render(configs: ServerConfig[], format: SubFormat,
                       meta: Partial<SubscriptionMeta> = {}): string {
  switch (format) {
    case 'base64': return renderBase64(configs);
    case 'raw': return renderRaw(configs);
    case 'clash': return renderClash(configs, meta);
    case 'singbox': return renderSingbox(configs);
    case 'wireguard': {
      const wg = configs.find((c): c is WireguardConfig => c.protocol === 'wireguard');
      if (wg) return renderWireguardConf(wg);
      // No WireGuard in this plan: fall back to the URI list rather than an
      // empty body, which clients interpret as "subscription broken".
      return renderRaw(configs);
    }
    default:
      return renderBase64(configs);
  }
}
