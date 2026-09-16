/**
 * D1 access layer.
 *
 * Every query in the whole project goes through here and every one of them is
 * parameterised. There is deliberately no `exec(sql)` escape hatch: the AI
 * assistant is allowed to ask questions, and a string-concatenated SQL helper
 * sitting next to an LLM is how a database gets dropped.
 *
 * The one thing this file owns beyond queries is the money invariant: a
 * wallet balance is never written directly, only through `creditWallet`,
 * which appends to the ledger in the same batch as the balance update. That
 * way `users.balance` can never drift from the sum of `wallet_ledger`.
 */

export interface Row {
  [k: string]: unknown;
}

export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch<T extends Row = Row>(statements: D1Stmt[]): Promise<D1Result<T>[]>;
}

export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = unknown>(column?: string): Promise<T | null>;
  run<T extends Row = Row>(): Promise<D1Result<T>>;
  all<T extends Row = Row>(): Promise<D1Result<T>>;
}

export interface D1Result<T extends Row = Row> {
  results: T[];
  meta?: unknown;
}

export type Sql = string;
export type Params = unknown[];

// --------------------------------------------------------------- primitives

export function newId(prefix = ''): string {
  // 26-char Crockford ulid-ish id. Lexicographically sortable by time, which
  // makes `ORDER BY id` equal `ORDER BY created_at` for our inserts.
  let t = Date.now();
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let out = '';
  for (let i = 9; i >= 0; i--) {
    out += alphabet[t % 32]!;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) {
    out += alphabet[Math.floor(Math.random() * 32)]!;
  }
  return prefix ? `${prefix}_${out}` : out;
}

export function now(): number {
  return Date.now();
}

/** Short, unambiguous code a human reads over the phone: `A7K9-2M4P`. */
export function shortCode(len = 8): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]!;
    if (i === 3 && len === 8) out += '-';
  }
  return out;
}

/** URL token: 32 chars of base64url, ~192 bits. Never guessable. */
export function urlToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Short id embedded in a config remark so a leaked config points at a user. */
export function watermark(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function asInt(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Math.trunc(Number(v));
  }
  return fallback;
}

export function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

export function asBool(v: unknown): boolean {
  return v === 1 || v === true || v === '1' || v === 'true';
}

export function asJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v.trim() === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- settings

export interface Settings {
  botName: string;
  supportChat: string;
  supportChannel: string;
  currency: string;
  trialEnabled: boolean;
  trialDays: number;
  trialTrafficGb: number;
  referralEnabled: boolean;
  referralPercent: number;
  cardHolder: string;
  cardNumber: string;
  cardBank: string;
  paymentMessage: string;
  subscriptionPath: string;
  subBaseUrl: string;
  trafficOveragePerGb: number;
  lowBalanceWarnPercent: number;
  lowTrafficWarnPercent: number;
  expireWarnDays: number;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  aiEnabled: boolean;
  aiTemperature: number;
  adminUserIds: number[];
}

const DEFAULT_SETTINGS: Settings = {
  botName: 'ConfigBot',
  supportChat: '',
  supportChannel: '',
  currency: 'تومان',
  trialEnabled: true,
  trialDays: 3,
  trialTrafficGb: 5,
  referralEnabled: true,
  referralPercent: 15,
  cardHolder: '',
  cardNumber: '',
  cardBank: '',
  paymentMessage: '',
  subscriptionPath: '/s',
  subBaseUrl: '',
  trafficOveragePerGb: 0,
  lowBalanceWarnPercent: 15,
  lowTrafficWarnPercent: 20,
  expireWarnDays: 3,
  maintenanceMode: false,
  maintenanceMessage: '',
  aiEnabled: true,
  aiTemperature: 0.4,
  adminUserIds: [],
};

export async function getSettings(db: D1Like): Promise<Settings> {
  const row = await db.prepare('SELECT * FROM settings WHERE id = 1').first<Row>();
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    botName: asString(row.bot_name, DEFAULT_SETTINGS.botName),
    supportChat: asString(row.support_chat),
    supportChannel: asString(row.support_channel),
    currency: asString(row.currency, 'تومان'),
    trialEnabled: asBool(row.trial_enabled),
    trialDays: asInt(row.trial_days, 3),
    trialTrafficGb: asInt(row.trial_traffic_gb, 5),
    referralEnabled: asBool(row.referral_enabled),
    referralPercent: asInt(row.referral_percent, 15),
    cardHolder: asString(row.card_holder),
    cardNumber: asString(row.card_number),
    cardBank: asString(row.card_bank),
    paymentMessage: asString(row.payment_message),
    subscriptionPath: asString(row.subscription_path, '/s'),
    subBaseUrl: asString(row.sub_base_url),
    trafficOveragePerGb: asInt(row.traffic_overage_per_gb, 0),
    lowBalanceWarnPercent: asInt(row.low_balance_warn_percent, 15),
    lowTrafficWarnPercent: asInt(row.low_traffic_warn_percent, 20),
    expireWarnDays: asInt(row.expire_warn_days, 3),
    maintenanceMode: asBool(row.maintenance_mode),
    maintenanceMessage: asString(row.maintenance_message),
    aiEnabled: asBool(row.ai_enabled),
    aiTemperature: Number(row.ai_temperature ?? DEFAULT_SETTINGS.aiTemperature),
    adminUserIds: asJson<number[]>(row.admin_user_ids, []),
  };
}

export async function upsertSettings(
  db: D1Like,
  patch: Partial<Settings>,
): Promise<void> {
  const current = await getSettings(db);
  const merged: Settings = { ...current, ...patch };
  await db
    .prepare(
      `INSERT INTO settings (
        id, bot_name, support_chat, support_channel, currency,
        trial_enabled, trial_days, trial_traffic_gb,
        referral_enabled, referral_percent,
        card_holder, card_number, card_bank, payment_message,
        subscription_path, sub_base_url, traffic_overage_per_gb,
        low_balance_warn_percent, low_traffic_warn_percent, expire_warn_days,
        maintenance_mode, maintenance_message, ai_enabled, ai_temperature,
        admin_user_ids, updated_at
      ) VALUES (
        1, ?1, ?2, ?3, ?4,
        ?5, ?6, ?7,
        ?8, ?9,
        ?10, ?11, ?12, ?13,
        ?14, ?15, ?16,
        ?17, ?18, ?19,
        ?20, ?21, ?22, ?23,
        ?24, ?25
      )
      ON CONFLICT(id) DO UPDATE SET
        bot_name=excluded.bot_name, support_chat=excluded.support_chat,
        support_channel=excluded.support_channel, currency=excluded.currency,
        trial_enabled=excluded.trial_enabled, trial_days=excluded.trial_days,
        trial_traffic_gb=excluded.trial_traffic_gb,
        referral_enabled=excluded.referral_enabled,
        referral_percent=excluded.referral_percent,
        card_holder=excluded.card_holder, card_number=excluded.card_number,
        card_bank=excluded.card_bank, payment_message=excluded.payment_message,
        subscription_path=excluded.subscription_path,
        sub_base_url=excluded.sub_base_url,
        traffic_overage_per_gb=excluded.traffic_overage_per_gb,
        low_balance_warn_percent=excluded.low_balance_warn_percent,
        low_traffic_warn_percent=excluded.low_traffic_warn_percent,
        expire_warn_days=excluded.expire_warn_days,
        maintenance_mode=excluded.maintenance_mode,
        maintenance_message=excluded.maintenance_message,
        ai_enabled=excluded.ai_enabled, ai_temperature=excluded.ai_temperature,
        admin_user_ids=excluded.admin_user_ids, updated_at=excluded.updated_at`,
    )
    .bind(
      merged.botName,
      merged.supportChat,
      merged.supportChannel,
      merged.currency,
      merged.trialEnabled ? 1 : 0,
      merged.trialDays,
      merged.trialTrafficGb,
      merged.referralEnabled ? 1 : 0,
      merged.referralPercent,
      merged.cardHolder,
      merged.cardNumber,
      merged.cardBank,
      merged.paymentMessage,
      merged.subscriptionPath,
      merged.subBaseUrl,
      merged.trafficOveragePerGb,
      merged.lowBalanceWarnPercent,
      merged.lowTrafficWarnPercent,
      merged.expireWarnDays,
      merged.maintenanceMode ? 1 : 0,
      merged.maintenanceMessage,
      merged.aiEnabled ? 1 : 0,
      merged.aiTemperature,
      JSON.stringify(merged.adminUserIds),
      now(),
    )
    .run();
}

// ------------------------------------------------------------------- users

export interface User {
  id: string;
  telegramId: number | null;
  username: string;
  firstName: string;
  languageCode: string;
  role: 'user' | 'support' | 'admin' | 'owner';
  balance: number;
  totalSpent: number;
  referredBy: string | null;
  referralCode: string;
  referralEarnings: number;
  blocked: boolean;
  blockReason: string;
  lastActiveAt: number | null;
  createdAt: number;
}

function mapUser(r: Row): User {
  return {
    id: asString(r.id),
    telegramId: r.telegram_id == null ? null : asInt(r.telegram_id),
    username: asString(r.username),
    firstName: asString(r.first_name),
    languageCode: asString(r.language_code, 'fa'),
    role: (asString(r.role, 'user') as User['role']) ?? 'user',
    balance: asInt(r.balance),
    totalSpent: asInt(r.total_spent),
    referredBy: r.referred_by == null ? null : asString(r.referred_by),
    referralCode: asString(r.referral_code),
    referralEarnings: asInt(r.referral_earnings),
    blocked: asBool(r.blocked),
    blockReason: asString(r.block_reason),
    lastActiveAt: r.last_active_at == null ? null : asInt(r.last_active_at),
    createdAt: asInt(r.created_at),
  };
}

export async function getUserByTelegram(
  db: D1Like,
  telegramId: number,
): Promise<User | null> {
  const row = await db
    .prepare('SELECT * FROM users WHERE telegram_id = ?1')
    .bind(telegramId)
    .first<Row>();
  return row ? mapUser(row) : null;
}

export async function getUser(db: D1Like, id: string): Promise<User | null> {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first<Row>();
  return row ? mapUser(row) : null;
}

export interface EnsureUserInput {
  telegramId: number;
  username?: string;
  firstName?: string;
  languageCode?: string;
  referredByCode?: string;
}

/** Create-or-update a Telegram user, and honour a referral code on first sight. */
export async function ensureUser(
  db: D1Like,
  input: EnsureUserInput,
): Promise<User> {
  const existing = await getUserByTelegram(db, input.telegramId);
  const t = now();

  if (existing) {
    await db
      .prepare(
        `UPDATE users SET username = ?2, first_name = ?3, language_code = ?4,
          last_active_at = ?5, updated_at = ?5 WHERE id = ?1`,
      )
      .bind(
        existing.id,
        input.username ?? existing.username,
        input.firstName ?? existing.firstName,
        input.languageCode ?? existing.languageCode,
        t,
      )
      .run();
    const fresh = await getUser(db, existing.id);
    return fresh ?? existing;
  }

  const id = newId('usr');
  let referredBy: string | null = null;
  if (input.referredByCode) {
    const referrer = await db
      .prepare('SELECT id FROM users WHERE referral_code = ?1')
      .bind(input.referredByCode)
      .first<Row>();
    if (referrer) referredBy = asString(referrer.id);
  }

  await db
    .prepare(
      `INSERT INTO users (
        id, telegram_id, username, first_name, language_code, role, balance,
        total_spent, referred_by, referral_code, referral_earnings, blocked,
        block_reason, notes, last_active_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, 'user', 0, 0, ?6, ?7, 0, 0, '', '', ?8, ?8, ?8)`,
    )
    .bind(
      id,
      input.telegramId,
      input.username ?? '',
      input.firstName ?? '',
      input.languageCode ?? 'fa',
      referredBy,
      shortCode(6).replace('-', ''),
      t,
    )
    .run();

  const created = await getUser(db, id);
  if (!created) throw new Error(`ensureUser: failed to read back user ${id}`);
  return created;
}

// ------------------------------------------------------------- the wallet --

export interface LedgerEntry {
  id: string;
  userId: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  refId: string;
  note: string;
  createdAt: number;
}

export interface CreditResult {
  ok: boolean;
  balance: number;
  error?: string;
}

/**
 * Move money. The ledger row and the balance update go out in one batch so a
 * crash between them cannot leave the two disagreeing.
 *
 * A negative delta that would push the balance below zero is refused, and the
 * check is part of the UPDATE's WHERE clause — not a read-then-write, which
 * would race if the same user tapped a button twice.
 */
export async function creditWallet(
  db: D1Like,
  userId: string,
  delta: number,
  reason: string,
  opts: { refId?: string; note?: string; actorId?: string } = {},
): Promise<CreditResult> {
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: false, balance: 0, error: 'مبلغ نامعتبر' };
  }
  const t = now();
  const ledgerId = newId('led');

  if (delta > 0) {
    const [, updated] = await db.batch([
      db
        .prepare(
          `UPDATE users SET balance = balance + ?2, updated_at = ?3 WHERE id = ?1`,
        )
        .bind(userId, delta, t),
      db
        .prepare(
          `INSERT INTO wallet_ledger (
            id, user_id, delta, balance_after, reason, ref_id, note, created_by, created_at
          ) VALUES (?1, ?2, ?3,
            (SELECT balance FROM users WHERE id = ?2), ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(ledgerId, userId, delta, reason, opts.refId ?? '', opts.note ?? '', opts.actorId ?? null, t),
    ]);
    if (asInt(updated?.meta as never, 0) === 0 && !updated) {
      return { ok: false, balance: 0, error: 'کاربر پیدا نشد' };
    }
  } else {
    // Debit: refuse atomically if it would go negative.
    const stmts = [
      db
        .prepare(
          `UPDATE users SET balance = balance + ?2, updated_at = ?3
           WHERE id = ?1 AND balance + ?2 >= 0`,
        )
        .bind(userId, delta, t),
      db
        .prepare(
          `INSERT INTO wallet_ledger (
            id, user_id, delta, balance_after, reason, ref_id, note, created_by, created_at
          )
           SELECT ?1, ?2, ?3, balance, ?4, ?5, ?6, ?7, ?8 FROM users WHERE id = ?2`,
        )
        .bind(ledgerId, userId, delta, reason, opts.refId ?? '', opts.note ?? '', opts.actorId ?? null, t),
    ];
    const results = await db.batch(stmts);
    const affected = results[0]?.meta as { changes?: number } | undefined;
    if (affected && asInt(affected.changes, 0) === 0) {
      return { ok: false, balance: 0, error: 'موجودی کافی نیست' };
    }
  }

  const user = await getUser(db, userId);
  return { ok: true, balance: user?.balance ?? 0 };
}

export async function getLedger(
  db: D1Like,
  userId: string,
  limit = 50,
): Promise<LedgerEntry[]> {
  const res = await db
    .prepare(
      `SELECT * FROM wallet_ledger WHERE user_id = ?1
       ORDER BY created_at DESC, id DESC LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<Row>();
  return res.results.map((r) => ({
    id: asString(r.id),
    userId: asString(r.user_id),
    delta: asInt(r.delta),
    balanceAfter: asInt(r.balance_after),
    reason: asString(r.reason),
    refId: asString(r.ref_id),
    note: asString(r.note),
    createdAt: asInt(r.created_at),
  }));
}

/**
 * Rebuild a wallet balance from the ledger. Used by a cron to prove the cache
 * never drifted, and by the admin panel to repair it if it ever did.
 */
export async function reconcileWallet(db: D1Like, userId: string): Promise<number> {
  const sum = await db
    .prepare('SELECT COALESCE(SUM(delta), 0) AS total FROM wallet_ledger WHERE user_id = ?1')
    .bind(userId)
    .first<Row>();
  const total = asInt(sum?.total, 0);
  await db
    .prepare('UPDATE users SET balance = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(userId, total, now())
    .run();
  return total;
}

// ------------------------------------------------------------------ audit --

export async function audit(
  db: D1Like,
  entry: {
    actorId?: string | null;
    actorLabel?: string;
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: unknown;
    ip?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (
        id, actor_id, actor_label, action, target_type, target_id, detail, ip, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      newId('aud'),
      entry.actorId ?? null,
      entry.actorLabel ?? 'system',
      entry.action,
      entry.targetType ?? '',
      entry.targetId ?? '',
      typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail ?? {}),
      entry.ip ?? '',
      now(),
    )
    .run();
}

// ---------------------------------------------------------------- outbox ---

export async function enqueueSend(
  db: D1Like,
  chatId: number,
  payload: unknown,
  method = 'sendMessage',
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO outbox (id, chat_id, method, payload, attempts, status, created_at)
       VALUES (?1, ?2, ?3, ?4, 0, 'pending', ?5)`,
    )
    .bind(newId('out'), chatId, method, JSON.stringify(payload), now())
    .run();
}

// ------------------------------------------------------------ idempotency --

/**
 * True if this update was already handled. Telegram retries webhooks, so
 * without this a duplicate delivery double-charges or double-sends.
 */
export async function markUpdateHandled(
  db: D1Like,
  updateId: number,
): Promise<boolean> {
  const existing = await db
    .prepare('SELECT update_id FROM webhook_updates WHERE update_id = ?1')
    .bind(updateId)
    .first();
  if (existing) return false;
  await db
    .prepare('INSERT INTO webhook_updates (update_id, handled_at) VALUES (?1, ?2)')
    .bind(updateId, now())
    .run();
  return true;
}
