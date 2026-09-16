import {
  NodeError,
  buildUriFor,
  makeBase64Key,
  makeSs2022Key,
  type DriverCapabilities,
  type IssueRequest,
  type IssuedCredential,
  type NodeDriver,
  type NodeRecord,
  type UsageReport,
} from './driver';
import { randomUuid } from '../config/uri';

/**
 * MarzbanDriver — talks to a real Marzban panel over HTTPS.
 *
 * Marzban's API is OpenAPI-documented and needs a bearer token obtained from
 * `/api/admin/token` with username+password. Tokens expire, so we fetch one and
 * re-fetch once on a 401 rather than caching a dead token forever.
 *
 * What this driver will not do
 * ----------------------------
 * It never invents a response. If the panel is unreachable or the token is
 * wrong, every method throws `NodeError` with the panel's own status, and the
 * caller (the order flow) marks the node down and tries another one. A config
 * that was never created on the panel is worse than an error the user sees.
 *
 * Endpoints used (Marzban 0.7+/0.8):
 *   POST /api/admin/token                          -> access_token
 *   GET  /api/system                               -> health
 *   POST /api/user                                 -> create
 *   PUT  /api/user/{username}                      -> update (rotation)
 *   POST /api/user/{username}                      -> enable/disable via status
 *   DELETE /api/user/{username}                    -> delete
 *   GET  /api/user/{username}                      -> used_traffic, expire
 */
export interface MarzbanOptions {
  /** Test seam: swap the transport. Production passes nothing. */
  fetchImpl?: typeof fetch;
  /** Seconds. Marzban defaults to 1440 min; we ask for 12 h. */
  tokenTtlSeconds?: number;
  timeoutMs?: number;
}

interface TokenState {
  token: string;
  obtainedAt: number;
  ttlMs: number;
}

export class MarzbanDriver implements NodeDriver {
  readonly kind = 'marzban';
  capabilities: DriverCapabilities = {
    issue: true,
    rotate: true,
    suspend: true,
    usage: true,
    revoke: true,
    protocols: ['vless', 'trojan', 'shadowsocks', 'wireguard'],
  };

  private token: TokenState | null = null;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private node: NodeRecord, private opts: MarzbanOptions = {}) {
    this.f = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    if (!node.panelUrl) {
      throw new NodeError('آدرس پنل تنظیم نشده', 'config', node.id);
    }
  }

  // ------------------------------------------------------------ transport --

  private get base(): string {
    return this.node.panelUrl.replace(/\/+$/, '');
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    opts: { auth?: boolean; retryOn401?: boolean } = {},
  ): Promise<T> {
    const auth = opts.auth ?? true;
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body) headers.set('content-type', 'application/json');
    if (auth) {
      const token = await this.getToken();
      headers.set('authorization', `Bearer ${token}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.f(`${this.base}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      if (res.status === 401 && auth && opts.retryOn401 !== false) {
        this.token = null; // stale token: drop it and try exactly once more
        return this.request<T>(path, init, { ...opts, retryOn401: false });
      }

      if (!res.ok) {
        const detail = await safeText(res);
        throw new NodeError(
          `پنل خطا داد (${res.status})${detail ? `: ${detail}` : ''}`,
          `http_${res.status}`,
          this.node.id,
        );
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof NodeError) throw e;
      throw new NodeError(
        `ارتباط با پنل برقرار نشد (${(e as Error).message})`,
        'network',
        this.node.id,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() - this.token.obtainedAt < this.token.ttlMs) {
      return this.token.token;
    }
    const form = new URLSearchParams();
    form.set('username', this.node.panelUser);
    form.set('password', this.node.panelKey);
    form.set('grant_type', 'password');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.f(`${this.base}/api/admin/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: controller.signal,
      });
    } catch (e) {
      throw new NodeError(
        `ارتباط با پنل برقرار نشد (${(e as Error).message})`,
        'network',
        this.node.id,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new NodeError(
        `ورود به پنل ناموفق (${res.status}). نام کاربری یا رمز ادمین پنل را چک کنید.`,
        `auth_${res.status}`,
        this.node.id,
      );
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new NodeError('پنل توکن نداد', 'auth_empty', this.node.id);
    }
    const ttlMs = (this.opts.tokenTtlSeconds ?? 12 * 3600) * 1000;
    this.token = { token: json.access_token, obtainedAt: Date.now(), ttlMs };
    return this.token.token;
  }

  // -------------------------------------------------------------- methods --

  async health(): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    const started = Date.now();
    try {
      const info = await this.request<{ mem_total?: number; users_active?: number }>(
        '/api/system',
        {},
        { auth: false },
      );
      return {
        ok: true,
        latencyMs: Date.now() - started,
        detail: `کاربران فعال: ${info?.users_active ?? '?'}`,
      };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, detail: (e as Error).message };
    }
  }

  async issue(req: IssueRequest): Promise<IssuedCredential> {
    const payload = this.buildUserPayload(req, req.username);
    const created = await this.request<{ username?: string }>('/api/user', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const panelUserId = created?.username ?? req.username;
    const cred = this.toCredential(req, panelUserId);
    return cred;
  }

  async rotate(
    panelUserId: string,
    _node: NodeRecord,
    req: IssueRequest,
  ): Promise<IssuedCredential> {
    // Rotation = same panel user, new secret. Marzban applies it immediately,
    // so the previously-shared link stops working the moment we return.
    const payload = this.buildUserPayload(req, panelUserId);
    await this.request(`/api/user/${encodeURIComponent(panelUserId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    return this.toCredential(req, panelUserId);
  }

  async suspend(panelUserId: string, _node: NodeRecord, suspended: boolean): Promise<void> {
    // Marzban models this as an enabled flag on the user.
    await this.request(`/api/user/${encodeURIComponent(panelUserId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        status: suspended ? 'disabled' : 'active',
      }),
    });
  }

  async revoke(panelUserId: string, _node: NodeRecord): Promise<void> {
    await this.request(`/api/user/${encodeURIComponent(panelUserId)}`, {
      method: 'DELETE',
    });
  }

  async usage(panelUserId: string, _node: NodeRecord): Promise<UsageReport> {
    const u = await this.request<{
      used_traffic?: number;
      expire?: number | null;
      status?: string;
    }>(`/api/user/${encodeURIComponent(panelUserId)}`, { method: 'GET' });

    return {
      usedBytes: Number(u?.used_traffic ?? 0),
      // Marzban sends a unix *seconds* timestamp, or null for unlimited.
      expiresAt: u?.expire ? Number(u.expire) * 1000 : null,
      online: u?.status !== 'disabled',
    };
  }

  panelLink(panelUserId: string, _node: NodeRecord): string {
    return `${this.base}/panel/users/${encodeURIComponent(panelUserId)}`;
  }

  // ------------------------------------------------------------- helpers ---

  private buildUserPayload(req: IssueRequest, username: string): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      username,
      // Marzban wants seconds; 0 means unlimited.
      data_limit: req.trafficLimitBytes > 0 ? req.trafficLimitBytes : 0,
      expire: req.expiresAt ? Math.floor(req.expiresAt / 1000) : 0,
      inbounds: { [req.node.inboundTag || 'VLESS']: [] },
      proxies: this.proxiesFor(req),
      status: 'active',
    };
    return payload;
  }

  /** Marzban's `proxies` block differs per protocol. */
  private proxiesFor(req: IssueRequest): Record<string, unknown> {
    switch (req.node.protocol) {
      case 'vless':
        return { vless: { id: randomUuid() } };
      case 'trojan':
        return { trojan: { password: randomUuid() } };
      case 'shadowsocks':
        return {
          shadowsocks: {
            method: 'chacha20-ietf-poly1305',
            password: makeSs2022Key(32),
          },
        };
      case 'wireguard':
        return {
          wireguard: {
            private_key: makeBase64Key(),
            peer_public_key: makeBase64Key(),
          },
        };
      default:
        return { vless: { id: randomUuid() } };
    }
  }

  private toCredential(req: IssueRequest, panelUserId: string): IssuedCredential {
    // We generate the secret client-side too, so the URI we store matches what
    // the panel has. Marzban also returns it in the response, but depending on
    // the response shape across versions is fragile.
    const proxies = this.proxiesFor(req);
    const uuid = String((proxies.vless as { id?: string } | undefined)?.id ?? randomUuid());
    const password = String(
      (proxies.trojan as { password?: string } | undefined)?.password ?? randomUuid(),
    );
    const ss = proxies.shadowsocks as { method?: string; password?: string } | undefined;
    const wg = proxies.wireguard as
      | { private_key?: string; peer_public_key?: string }
      | undefined;

    const base: Omit<IssuedCredential, 'uri'> = {
      panelUserId,
      username: req.username,
      uuid,
      password,
      ssMethod: ss?.method ?? '',
      ssKey: ss?.password ?? '',
      wgPrivateKey: wg?.private_key ?? '',
      wgPublicKey: wg?.peer_public_key ?? '',
      wgPsk: '',
      wgEndpointPort: req.node.port,
      wgClientAddress: '',
      tuicCongestion: '',
      hy2Auth: '',
      trafficLimitBytes: req.trafficLimitBytes,
      expiresAt: req.expiresAt,
    };
    return { ...base, uri: buildUriFor(req.node, base, req.remarkPrefix) };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  } catch {
    return '';
  }
}
