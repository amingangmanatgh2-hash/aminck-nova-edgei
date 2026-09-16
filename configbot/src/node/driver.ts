import {
  buildHysteria2,
  buildShadowsocks,
  buildTrojan,
  buildTuic,
  buildUri,
  buildWireguard,
  buildVless,
  randomUuid,
  type Hysteria2Config,
  type Protocol,
  type Security,
  type ShadowsocksConfig,
  type TrojanConfig,
  type TuicConfig,
  type VlessConfig,
  type WireguardConfig,
} from '../config/uri';

/**
 * NodeDriver — the seam between Cloudflare and the VPN server.
 *
 * Why this exists
 * ---------------
 * A Worker cannot open a TCP or UDP socket, so the VPN server itself will never
 * live on Cloudflare. It lives on a VPS. This interface is the whole of our
 * dependency on that VPS: everything above it — orders, subscriptions, the
 * mini app, the admin panel — only ever talks to a `NodeDriver`, so a node can
 * be Marzban, 3x-ui, a raw Xray box, or (in tests) nothing at all.
 *
 * The contract is deliberately small. Six methods. A driver that cannot
 * implement one of them reports it through `capabilities` and the layers above
 * degrade honestly instead of pretending: no `rotate` means the UI hides the
 * "new config" button rather than showing one that 404s.
 */
export interface NodeRecord {
  id: string;
  name: string;
  country: string;
  countryLabel: string;
  flag: string;
  /** Which panel this node runs: 'marzban' | 'xray' | '3xui' | 'mock'. */
  driver: string;
  protocol: Protocol;
  security: Security;
  publicIp: string;
  port: number;
  sni: string;
  realityPbk: string;
  realityFp: string;
  realitySpider: string;
  wsPath: string;
  inboundTag: string;
  panelUrl: string;
  panelUser: string;
  panelKey: string;
  priority: number;
  weight: number;
  health: NodeHealth;
  /** Consecutive failed health probes; 3 in a row marks the node down. */
  consecutiveFailures: number;
  enabled: boolean;
  capacityUsers: number;
  currentUsers: number;
}

export type NodeHealth = 'up' | 'down' | 'unknown';

export interface IssuedCredential {
  /** Panel-side user id, so we can update or delete the account later. */
  panelUserId: string;
  username: string;
  uuid: string;
  password: string;
  ssMethod: string;
  ssKey: string;
  wgPrivateKey: string;
  wgPublicKey: string;
  wgPsk: string;
  wgEndpointPort: number;
  /** Client address inside the tunnel, e.g. 172.16.0.2/32. */
  wgClientAddress: string;
  tuicCongestion: string;
  hy2Auth: string;
  /** The finished URI. The driver builds it because only it knows the node. */
  uri: string;
  trafficLimitBytes: number;
  expiresAt: number | null;
}

export interface IssueRequest {
  node: NodeRecord;
  /** Display name for the client, e.g. `u_abc123_nl`. */
  username: string;
  /** Short id we also embed in the remark, for leak tracing. */
  watermark: string;
  protocol: Protocol;
  trafficLimitBytes: number;
  expiresAt: number | null;
  remarkPrefix: string;
}

export interface DriverCapabilities {
  /** Can create a user on the panel. */
  issue: boolean;
  /** Can replace the secret and keep the account. */
  rotate: boolean;
  /** Can suspend without deleting. */
  suspend: boolean;
  /** Can read back live traffic usage. */
  usage: boolean;
  /** Can delete the account from the panel. */
  revoke: boolean;
  /** Protocols this node can actually serve. */
  protocols: Protocol[];
}

export interface UsageReport {
  usedBytes: number;
  /** Only set when the panel exposes an expiry. */
  expiresAt: number | null;
  online: boolean;
}

export class NodeError extends Error {
  readonly code: string;
  readonly nodeId: string;
  constructor(message: string, code: string, nodeId: string) {
    super(message);
    this.name = 'NodeError';
    this.code = code;
    this.nodeId = nodeId;
  }
}

export interface NodeDriver {
  readonly kind: string;
  capabilities: DriverCapabilities;
  health(): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
  issue(req: IssueRequest): Promise<IssuedCredential>;
  rotate(
    panelUserId: string,
    node: NodeRecord,
    req: IssueRequest,
  ): Promise<IssuedCredential>;
  suspend(panelUserId: string, node: NodeRecord, suspended: boolean): Promise<void>;
  revoke(panelUserId: string, node: NodeRecord): Promise<void>;
  usage(panelUserId: string, node: NodeRecord): Promise<UsageReport>;
  /** Panel link the admin can hand to a user, or '' if unsupported. */
  panelLink(panelUserId: string, node: NodeRecord): string;
}

// ---------------------------------------------------------- building URIs --

/**
 * Turn a freshly-issued credential into a client-ready URI.
 *
 * Kept as a free function rather than a method on each driver because every
 * driver produces the same fields — only the way it obtains the secret
 * differs. That also means one code path is tested for all of them.
 */
export function buildUriFor(
  node: NodeRecord,
  cred: Omit<IssuedCredential, 'uri'>,
  remark: string,
): string {
  const host = node.publicIp;
  const port = node.port;

  switch (node.protocol) {
    case 'vless': {
      const c: VlessConfig = {
        protocol: 'vless',
        host,
        port,
        remark,
        uuid: cred.uuid,
        network: node.wsPath ? 'ws' : 'tcp',
        security: node.security === 'reality' ? 'reality' : node.security === 'tls' ? 'tls' : 'none',
        flow: node.security === 'reality' ? 'xtls-rprx-vision' : undefined,
        sni: node.sni || undefined,
        fp: node.realityFp || 'chrome',
        pbk: node.security === 'reality' ? node.realityPbk : undefined,
        spx: node.security === 'reality' && node.realitySpider ? node.realitySpider : undefined,
        path: node.wsPath || undefined,
        hostHeader: node.wsPath ? node.sni || undefined : undefined,
      };
      return buildVless(c);
    }
    case 'trojan': {
      const c: TrojanConfig = {
        protocol: 'trojan',
        host,
        port,
        remark,
        password: cred.password,
        network: node.wsPath ? 'ws' : 'tcp',
        sni: node.sni || undefined,
        path: node.wsPath || undefined,
      };
      return buildTrojan(c);
    }
    case 'shadowsocks': {
      const c: ShadowsocksConfig = {
        protocol: 'shadowsocks',
        host,
        port,
        remark,
        method: cred.ssMethod || 'chacha20-ietf-poly1305',
        password: cred.ssKey,
      };
      return buildShadowsocks(c);
    }
    case 'wireguard': {
      const c: WireguardConfig = {
        protocol: 'wireguard',
        host,
        port,
        remark,
        privateKey: cred.wgPrivateKey,
        publicKey: cred.wgPublicKey,
        // The client address inside the tunnel. One /32 per user keeps peers
        // distinguishable in the server's routing table.
        address: cred.wgClientAddress || '172.16.0.2/32',
      };
      return buildWireguard(c);
    }
    case 'tuic': {
      const c: TuicConfig = {
        protocol: 'tuic',
        host,
        port,
        remark,
        uuid: cred.uuid,
        password: cred.password || undefined,
        congestionControl: cred.tuicCongestion || 'cubic',
        sni: node.sni || undefined,
      };
      return buildTuic(c);
    }
    case 'hysteria2': {
      const c: Hysteria2Config = {
        protocol: 'hysteria2',
        host,
        port,
        remark,
        password: cred.hy2Auth || cred.password,
        sni: node.sni || undefined,
      };
      return buildHysteria2(c);
    }
    default: {
      // Unreachable while `Protocol` is a closed union, but a switch without a
      // default silently returns undefined the day someone adds a protocol.
      throw new Error(`پروتکل پشتیبانی‌نشده: ${String(node.protocol)}`);
    }
  }
}

void buildUri;

/** A username that is safe for every panel we support. */
export function safeUsername(base: string): string {
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || `u_${Date.now()}`;
}

// ------------------------------------------------------- MockNodeDriver ----

/**
 * An in-memory driver for tests and for running the bot before a VPS exists.
 *
 * It is not a fake payment or a proxy dressed up as a VPN — it is labelled
 * `mock` everywhere it appears, the admin panel shows its nodes with a warning
 * stripe, and configs from it never reach a real client because there is no
 * server behind them. Its job is to let every layer above it be exercised.
 */
export class MockNodeDriver implements NodeDriver {
  readonly kind = 'mock';
  capabilities: DriverCapabilities = {
    issue: true,
    rotate: true,
    suspend: true,
    usage: true,
    revoke: true,
    protocols: ['vless', 'trojan', 'shadowsocks', 'wireguard', 'tuic', 'hysteria2'],
  };

  /** Visible to tests: what we think the panel holds. */
  readonly accounts = new Map<
    string,
    { username: string; suspended: boolean; usedBytes: number; expiresAt: number | null }
  >();

  private readonly failNext = new Set<string>();

  constructor(private opts: { latencyMs?: number } = {}) {}

  /** Make the next call for this panel user fail, to test error paths. */
  failOnce(panelUserId: string): void {
    this.failNext.add(panelUserId);
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    return { ok: true, latencyMs: this.opts.latencyMs ?? 3, detail: 'mock' };
  }

  async issue(req: IssueRequest): Promise<IssuedCredential> {
    this.maybeFail('', req);
    const cred = this.makeCredential(req);
    this.accounts.set(cred.panelUserId, {
      username: cred.username,
      suspended: false,
      usedBytes: 0,
      expiresAt: req.expiresAt,
    });
    return cred;
  }

  async rotate(
    panelUserId: string,
    _node: NodeRecord,
    req: IssueRequest,
  ): Promise<IssuedCredential> {
    this.maybeFail(panelUserId, req);
    const existing = this.accounts.get(panelUserId);
    if (!existing) {
      throw new NodeError('اکانت در پنل پیدا نشد', 'not_found', req.node.id);
    }
    // Same panel account, brand-new secret — this is what makes rotation safe:
    // the old link dies the moment the new one is issued.
    const cred = this.makeCredential(req, panelUserId);
    existing.usedBytes = 0;
    existing.expiresAt = req.expiresAt;
    return cred;
  }

  async suspend(panelUserId: string, node: NodeRecord, suspended: boolean): Promise<void> {
    const acc = this.accounts.get(panelUserId);
    if (!acc) throw new NodeError('اکانت پیدا نشد', 'not_found', node.id);
    acc.suspended = suspended;
  }

  async revoke(panelUserId: string, node: NodeRecord): Promise<void> {
    if (!this.accounts.has(panelUserId)) {
      throw new NodeError('اکانت پیدا نشد', 'not_found', node.id);
    }
    this.accounts.delete(panelUserId);
  }

  async usage(panelUserId: string, node: NodeRecord): Promise<UsageReport> {
    const acc = this.accounts.get(panelUserId);
    if (!acc) throw new NodeError('اکانت پیدا نشد', 'not_found', node.id);
    return { usedBytes: acc.usedBytes, expiresAt: acc.expiresAt, online: !acc.suspended };
  }

  panelLink(panelUserId: string, node: NodeRecord): string {
    return node.panelUrl
      ? `${node.panelUrl.replace(/\/$/, '')}/panel/clients/${encodeURIComponent(panelUserId)}`
      : '';
  }

  /** Simulate traffic so quota alerts can be tested. */
  addTraffic(panelUserId: string, bytes: number): void {
    const acc = this.accounts.get(panelUserId);
    if (acc) acc.usedBytes += bytes;
  }

  private maybeFail(panelUserId: string, req: IssueRequest): void {
    if (this.failNext.has(panelUserId)) {
      this.failNext.delete(panelUserId);
      throw new NodeError('پنل پاسخ نداد (ساختگی)', 'unavailable', req.node.id);
    }
  }

  private makeCredential(req: IssueRequest, reuseId?: string): IssuedCredential {
    const uuid = randomUuid();
    const base: Omit<IssuedCredential, 'uri'> = {
      panelUserId: reuseId ?? `${req.username}_${uuid.slice(0, 8)}`,
      username: req.username,
      uuid,
      password: randomUuid(),
      ssMethod: 'chacha20-ietf-poly1305',
      ssKey: '',
      wgPrivateKey: '',
      wgPublicKey: '',
      wgPsk: '',
      wgEndpointPort: 0,
      wgClientAddress: '',
      tuicCongestion: 'cubic',
      hy2Auth: '',
      trafficLimitBytes: req.trafficLimitBytes,
      expiresAt: req.expiresAt,
    };

    switch (req.node.protocol) {
      case 'shadowsocks':
        base.ssKey = makeSs2022Key(32);
        break;
      case 'wireguard':
        base.wgPrivateKey = makeBase64Key();
        base.wgPublicKey = makeBase64Key();
        base.wgEndpointPort = req.node.port;
        break;
      case 'hysteria2':
        base.hy2Auth = randomUuid();
        break;
      case 'trojan':
        break; // password already set
      case 'tuic':
        break; // uuid already set
      case 'vless':
        break; // uuid already set
    }

    return { ...base, uri: buildUriFor(req.node, base, `${req.remarkPrefix}`) };
  }
}

export function makeBase64Key(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** Shadowsocks 2022 keys are base64 of exactly 16 or 32 raw bytes. */
export function makeSs2022Key(bytes: 16 | 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

// ------------------------------------------------------- driver registry ---

export function makeMockNodeRecord(
  over: Partial<NodeRecord> & { id: string; publicIp: string },
): NodeRecord {
  return {
    name: over.id,
    driver: 'mock',
    country: 'nl',
    countryLabel: 'هلند',
    flag: '🇳🇱',
    protocol: 'vless',
    security: 'reality',
    port: 443,
    sni: 'www.microsoft.com',
    // A real 44-char base64 of 32 bytes. The validator rejects anything else,
    // and it is right to: a Reality config without a valid pbk cannot connect.
    realityPbk: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
    realityFp: 'chrome',
    realitySpider: '',
    wsPath: '',
    inboundTag: 'VLESS',
    panelUrl: '',
    panelUser: '',
    panelKey: '',
    priority: 100,
    weight: 1,
    health: 'up',
    consecutiveFailures: 0,
    enabled: true,
    capacityUsers: 0,
    currentUsers: 0,
    ...over,
  };
}
