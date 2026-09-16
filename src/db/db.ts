/**
 * D1 access layer.
 *
 * Every query goes through a prepared statement — no string interpolation of
 * user input anywhere in this codebase. Row mappers convert snake_case D1 rows
 * into the camelCase domain types used by the rest of the platform.
 */
import type {
  ActionTier,
  Edition,
  MatchPhase,
  Order,
  OrderStatus,
  PaymentMethod,
  Product,
  ProductKind,
  RankId,
  Runtime,
  ServerRecord,
  ServerStatus,
} from '../types';
import { newId, now } from '../utils';

export interface Env2 {
  GODDB: D1Database;
  GODKV: KVNamespace;
  GODR2: R2Bucket;
}

// --------------------------------------------------------------- helpers
export function q(db: D1Database, sql: string, ...bind: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...bind);
}

export async function one<T>(db: D1Database, sql: string, ...bind: unknown[]): Promise<T | null> {
  const r = await q(db, sql, ...bind).first<T>();
  return r ?? null;
}

export async function all<T>(db: D1Database, sql: string, ...bind: unknown[]): Promise<T[]> {
  const r = await q(db, sql, ...bind).all<T>();
  return r.results ?? [];
}

export async function run(db: D1Database, sql: string, ...bind: unknown[]): Promise<D1Result> {
  return q(db, sql, ...bind).run();
}

export async function exec(db: D1Database, sql: string): Promise<void> {
  await db.exec(sql);
}

const n = (v: unknown, d = 0): number => (typeof v === 'number' ? v : Number(v ?? d) || d);
const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : (v == null ? d : String(v)));
const nullable = <T,>(v: unknown): T | null => (v == null ? null : (v as T));
const bool = (v: unknown): boolean => v === 1 || v === true || v === '1';

// ------------------------------------------------------------------ users
export interface UserRow {
  id: string;
  phone_e164: string;
  phone_hash: string;
  username: string | null;
  email: string | null;
  rank_id: string;
  xp: number;
  coins: number;
  gems: number;
  elo: number;
  status: string;
  locale: string;
  first_ip_hash: string | null;
  created_at: number;
  last_login_at: number | null;
  last_seen_at: number | null;
}

export interface UserRecord {
  id: string;
  phoneE164: string;
  username: string | null;
  email: string | null;
  rankId: RankId;
  xp: number;
  coins: number;
  gems: number;
  elo: number;
  status: string;
  locale: string;
  createdAt: number;
  lastLoginAt: number | null;
  lastSeenAt: number | null;
}

export function mapUser(r: UserRow): UserRecord {
  return {
    id: r.id,
    phoneE164: r.phone_e164,
    username: nullable<string>(r.username),
    email: nullable<string>(r.email),
    rankId: (r.rank_id || 'free') as RankId,
    xp: n(r.xp),
    coins: n(r.coins),
    gems: n(r.gems),
    elo: n(r.elo, 1000),
    status: r.status || 'active',
    locale: r.locale || 'fa-IR',
    createdAt: n(r.created_at),
    lastLoginAt: nullable<number>(r.last_login_at),
    lastSeenAt: nullable<number>(r.last_seen_at),
  };
}

export const userByPhoneHash = (db: D1Database, h: string) =>
  one<UserRow>(db, 'SELECT * FROM users WHERE phone_hash = ?', h);

export const userById = (db: D1Database, id: string) =>
  one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);

export async function createUser(
  db: D1Database,
  u: { phoneE164: string; phoneHash: string; ipHash?: string; username?: string },
): Promise<string> {
  const id = newId();
  await run(
    db,
    `INSERT INTO users (id, phone_e164, phone_hash, username, rank_id, xp, coins, gems, elo,
       status, locale, first_ip_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    u.phoneE164,
    u.phoneHash,
    u.username ?? null,
    'free',
    0,
    0,
    0,
    1000,
    'active',
    'fa-IR',
    u.ipHash ?? null,
    now(),
  );
  return id;
}

export async function touchUser(db: D1Database, id: string, at = now()): Promise<void> {
  await run(db, 'UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?', at, at, id);
}

// ----------------------------------------------------------------- admins
export interface AdminRow {
  id: string;
  username: string;
  password_hash: string;
  password_salt: string;
  role: string;
  permissions: string;
  disabled: number;
  last_login_at: number | null;
  created_at: number;
}

export const adminByUsername = (db: D1Database, username: string) =>
  one<AdminRow>(db, 'SELECT * FROM admins WHERE username = ?', username);

export const adminById = (db: D1Database, id: string) =>
  one<AdminRow>(db, 'SELECT * FROM admins WHERE id = ?', id);

export async function createAdmin(
  db: D1Database,
  a: { username: string; hash: string; salt: string; role?: string; permissions?: string[] },
): Promise<string> {
  const id = newId();
  await run(
    db,
    `INSERT INTO admins (id, username, password_hash, password_salt, role, permissions, disabled, created_at)
     VALUES (?,?,?,?,?,?,0,?)`,
    id,
    a.username,
    a.hash,
    a.salt,
    a.role ?? 'admin',
    JSON.stringify(a.permissions ?? []),
    now(),
  );
  return id;
}

// --------------------------------------------------------------- products
export interface ProductRow {
  id: string;
  kind: string;
  sku: string;
  title_fa: string;
  title_en: string;
  description: string | null;
  price_usd: number;
  base_usd: number;
  image_key: string | null;
  meta: string;
  active: number;
  visible_before_auth: number;
  created_at: number;
}

export function mapProduct(r: ProductRow): Product {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(r.meta || '{}');
  } catch {
    meta = {};
  }
  return {
    id: r.id,
    kind: r.kind as ProductKind,
    sku: r.sku,
    titleFa: r.title_fa,
    titleEn: r.title_en,
    description: nullable<string>(r.description),
    priceUsd: n(r.price_usd),
    baseUsd: n(r.base_usd, n(r.price_usd)),
    imageKey: nullable<string>(r.image_key),
    meta,
    active: bool(r.active),
    visibleBeforeAuth: bool(r.visible_before_auth),
  };
}

export async function upsertProduct(
  db: D1Database,
  p: Omit<Product, 'id'> & { id?: string },
): Promise<string> {
  const id = p.id ?? newId();
  await run(
    db,
    `INSERT INTO products (id, kind, sku, title_fa, title_en, description, price_usd, base_usd,
        image_key, meta, active, visible_before_auth, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       kind=excluded.kind, sku=excluded.sku, title_fa=excluded.title_fa,
       title_en=excluded.title_en, description=excluded.description,
       price_usd=excluded.price_usd, base_usd=excluded.base_usd,
       image_key=excluded.image_key, meta=excluded.meta,
       active=excluded.active, visible_before_auth=excluded.visible_before_auth`,
    id,
    p.kind,
    p.sku,
    p.titleFa,
    p.titleEn,
    p.description ?? null,
    p.priceUsd,
    p.baseUsd,
    p.imageKey ?? null,
    JSON.stringify(p.meta ?? {}),
    p.active ? 1 : 0,
    p.visibleBeforeAuth ? 1 : 0,
    now(),
  );
  return id;
}

// ----------------------------------------------------------------- orders
export interface OrderRow {
  id: string;
  user_id: string | null;
  product_id: string | null;
  amount_usd: number;
  discount_pct: number;
  currency: string;
  method: string;
  gateway_ref: string | null;
  status: string;
  review_verdict: string | null;
  ip_hash: string | null;
  created_at: number;
  paid_at: number | null;
  expires_at: number | null;
}

export function mapOrder(r: OrderRow): Order {
  return {
    id: r.id,
    userId: nullable<string>(r.user_id),
    productId: nullable<string>(r.product_id),
    amountUsd: n(r.amount_usd),
    discountPct: n(r.discount_pct),
    currency: r.currency || 'USD',
    method: r.method as PaymentMethod,
    gatewayRef: nullable<string>(r.gateway_ref),
    status: r.status as OrderStatus,
    createdAt: n(r.created_at),
    paidAt: nullable<number>(r.paid_at),
    expiresAt: nullable<number>(r.expires_at),
  };
}

// ---------------------------------------------------------------- servers
export interface ServerRow {
  id: string;
  name: string;
  host: string;
  java_port: number;
  bedrock_port: number | null;
  bedrock_enabled: number;
  edition: string;
  runtime: string;
  max_players: number;
  view_distance: number;
  sim_distance: number;
  status: string;
  online_players: number;
  tps: number | null;
  mem_used_mb: number | null;
  mem_max_mb: number | null;
  cpu_percent: number | null;
  last_heartbeat: number | null;
  lock_owner: string | null;
  version: string | null;
  motd: string | null;
  created_at: number;
  updated_at: number;
}

export function mapServer(r: ServerRow): ServerRecord {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    javaPort: n(r.java_port, 25565),
    bedrockPort: nullable<number>(r.bedrock_port),
    bedrockEnabled: bool(r.bedrock_enabled),
    edition: (r.edition || 'java') as Edition,
    runtime: (r.runtime || 'paper') as Runtime,
    maxPlayers: n(r.max_players, 20),
    viewDistance: n(r.view_distance, 6),
    simDistance: n(r.sim_distance, 4),
    status: (r.status || 'offline') as ServerStatus,
    onlinePlayers: n(r.online_players),
    tps: nullable<number>(r.tps),
    memUsedMb: nullable<number>(r.mem_used_mb),
    memMaxMb: nullable<number>(r.mem_max_mb),
    cpuPercent: nullable<number>(r.cpu_percent),
    lastHeartbeat: nullable<number>(r.last_heartbeat),
    lockOwner: nullable<string>(r.lock_owner),
    version: nullable<string>(r.version),
    motd: nullable<string>(r.motd),
  };
}

// ------------------------------------------------------------ audit / logs
export async function audit(
  db: D1Database,
  e: { actor: string; action: string; target?: string | null; detail?: string | null; ipHash?: string | null },
): Promise<void> {
  await run(
    db,
    'INSERT INTO audit_logs (id, actor, action, target, detail, ip_hash, created_at) VALUES (?,?,?,?,?,?,?)',
    newId(),
    e.actor,
    e.action,
    e.target ?? null,
    e.detail ?? null,
    e.ipHash ?? null,
    now(),
  );
}

export async function fraudAlert(
  db: D1Database,
  a: { kind: string; severity?: string; subject?: string | null; detail: string },
): Promise<string> {
  const id = newId();
  await run(
    db,
    'INSERT INTO fraud_alerts (id, kind, severity, subject, detail, notified, created_at) VALUES (?,?,?,?,?,0,?)',
    id,
    a.kind,
    a.severity ?? 'warn',
    a.subject ?? null,
    a.detail,
    now(),
  );
  return id;
}

// ------------------------------------------------------------- settings KV
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const r = await one<{ value: string }>(db, 'SELECT value FROM platform_settings WHERE key = ?', key);
  return r?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await run(
    db,
    `INSERT INTO platform_settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    key,
    value,
    now(),
  );
}

export interface SettingsShape {
  serverName: string;
  serverHost: string;
  serverIp: string;
  logoKey: string | null;
  bannerKey: string | null;
  discordUrl: string;
  telegramUrl: string;
  supportEmail: string;
  maintenance: boolean;
  whitelist: boolean;
  cardNumber: string | null;
  cardHolder: string | null;
  zarinpalMerchantId: string | null;
  zarinpalEnabled: boolean;
  card2cardEnabled: boolean;
  shopEnabled: boolean;
}

export const DEFAULT_SETTINGS: SettingsShape = {
  serverName: 'Minecraft God Server',
  serverHost: 'play.example.com',
  serverIp: 'play.example.com',
  logoKey: null,
  bannerKey: null,
  discordUrl: '',
  telegramUrl: '',
  supportEmail: '',
  maintenance: false,
  whitelist: false,
  cardNumber: null,
  cardHolder: null,
  zarinpalMerchantId: null,
  zarinpalEnabled: false,
  card2cardEnabled: false,
  shopEnabled: true,
};

export async function loadSettings(db: D1Database): Promise<SettingsShape> {
  const raw = await getSetting(db, 'platform');
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<SettingsShape>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(db: D1Database, s: SettingsShape): Promise<void> {
  await setSetting(db, 'platform', JSON.stringify(s));
}

// ------------------------------------------------------- anti-cheat tables
export interface CheatCaseRow {
  id: string;
  player_id: string;
  confidence: number;
  tier: number;
  action_taken: string;
  signal_ids: string;
  evidence_keys: string;
  summary: string | null;
  permanent: number;
  created_at: number;
  resolved_at: number | null;
}

export interface AppealRow {
  id: string;
  ban_id: string;
  player_id: string;
  channel: string;
  message: string;
  contact: string | null;
  status: string;
  admin_note: string | null;
  handled_by: string | null;
  created_at: number;
  handled_at: number | null;
}

export interface MatchRow {
  id: string;
  server_id: string | null;
  mode_id: string;
  phase: string;
  slots: number;
  humans: number;
  bots: number;
  avg_elo: number;
  max_elo: number;
  winner: string | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

export type { ActionTier, MatchPhase };
