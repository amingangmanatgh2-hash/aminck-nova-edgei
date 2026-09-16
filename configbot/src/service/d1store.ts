import type { D1Database } from '@cloudflare/workers-types';
import { asBool, asInt, asString, newId, now } from '../db/db';
import type { NodeRecord } from '../node/driver';
import type {
  AuditEntry,
  CredentialRecord,
  OrderRecord,
  PaymentRecord,
  PlanRecord,
  Store,
  SubscriptionRecord,
  TicketRecord,
  UserRecord,
} from './store';

type Row = Record<string, unknown>;

/**
 * D1Store — the production `Store`.
 *
 * It exists so the API layer and the bot speak to the same interface the tests
 * use. That is not ceremony: `MemoryStore` and this file implement the same
 * contract, so a flow proven in tests runs against D1 without a second
 * implementation drifting beside it.
 *
 * Every query is parameterised. There is no raw-SQL escape hatch anywhere in
 * this file, because the admin panel and the AI assistant both sit upstream of
 * it.
 */
export class D1Store implements Store {
  constructor(private db: D1Database) {}

  private q(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).bind(...params);
  }

  // -------------------------------------------------------------- users ---

  async getUser(id: string): Promise<UserRecord | null> {
    const r = await this.q('SELECT * FROM users WHERE id = ?1', id).first<Row>();
    return r ? mapUser(r) : null;
  }

  async getUserByTelegram(telegramId: number): Promise<UserRecord | null> {
    const r = await this.q('SELECT * FROM users WHERE telegram_id = ?1', telegramId).first<Row>();
    return r ? mapUser(r) : null;
  }

  async listUsers(limit = 50, offset = 0): Promise<UserRecord[]> {
    const res = await this.q(
      'SELECT * FROM users ORDER BY created_at DESC LIMIT ?1 OFFSET ?2',
      limit,
      offset,
    ).all<Row>();
    return res.results.map(mapUser);
  }

  async countUsers(): Promise<number> {
    const r = await this.q('SELECT COUNT(*) AS n FROM users').first<Row>();
    return asInt(r?.n, 0);
  }

  async putUser(u: UserRecord): Promise<void> {
    await this.q(
      `INSERT INTO users (id, telegram_id, username, first_name, balance, role, blocked,
        referral_code, referred_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(id) DO UPDATE SET
         username=excluded.username, first_name=excluded.first_name,
         balance=excluded.balance, role=excluded.role, blocked=excluded.blocked,
         updated_at=excluded.updated_at`,
    )
      .bind(u.id, u.telegramId, u.username, u.firstName, u.balance, u.role, u.blocked ? 1 : 0, u.referralCode, u.referredBy, u.createdAt, now())
      .run();
  }

  // -------------------------------------------------------------- plans ---

  async listPlans(includeHidden = false): Promise<PlanRecord[]> {
    const res = includeHidden
      ? await this.q('SELECT * FROM plans ORDER BY sort_order, price').all<Row>()
      : await this.q('SELECT * FROM plans WHERE hidden = 0 ORDER BY sort_order, price').all<Row>();
    return res.results.map(mapPlan);
  }

  async getPlan(id: string): Promise<PlanRecord | null> {
    const r = await this.q('SELECT * FROM plans WHERE id = ?1', id).first<Row>();
    return r ? mapPlan(r) : null;
  }

  // -------------------------------------------------------------- nodes ---

  async listNodes(): Promise<NodeRecord[]> {
    const res = await this.q('SELECT * FROM nodes ORDER BY priority, name').all<Row>();
    return res.results.map(mapNode);
  }

  // ------------------------------------------------------------- orders ---

  async createOrder(o: OrderRecord): Promise<void> {
    await this.q(
      `INSERT INTO orders (id, code, user_id, kind, plan_id, target_sub_id, amount, discount,
        paid_from_balance, status, gateway, gateway_ref, coupon_code, paid_at, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15)`,
    )
      .bind(o.id, o.code, o.userId, o.kind, o.planId, o.targetSubId, o.amount, o.discount, o.paidFromBalance, o.status, o.gateway, o.gatewayRef, o.couponCode, o.paidAt, o.createdAt)
      .run();
  }

  async getOrder(id: string): Promise<OrderRecord | null> {
    const r = await this.q('SELECT * FROM orders WHERE id = ?1', id).first<Row>();
    return r ? mapOrder(r) : null;
  }

  async getOrderByCode(code: string): Promise<OrderRecord | null> {
    const r = await this.q('SELECT * FROM orders WHERE code = ?1', code).first<Row>();
    return r ? mapOrder(r) : null;
  }

  async listOrders(userId?: string, limit = 20): Promise<OrderRecord[]> {
    const res = userId
      ? await this.q('SELECT * FROM orders WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2', userId, limit).all<Row>()
      : await this.q('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?1', limit).all<Row>();
    return res.results.map(mapOrder);
  }

  async updateOrder(id: string, patch: Partial<OrderRecord>): Promise<void> {
    const cur = await this.getOrder(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    await this.q(
      `UPDATE orders SET kind=?2, plan_id=?3, target_sub_id=?4, amount=?5, discount=?6,
        paid_from_balance=?7, status=?8, gateway=?9, gateway_ref=?10, coupon_code=?11,
        paid_at=?12, updated_at=?13 WHERE id=?1`,
    )
      .bind(id, next.kind, next.planId, next.targetSubId, next.amount, next.discount, next.paidFromBalance, next.status, next.gateway, next.gatewayRef, next.couponCode, next.paidAt, now())
      .run();
  }

  // ----------------------------------------------------------- payments ---

  async createPayment(p: PaymentRecord): Promise<void> {
    await this.q(
      `INSERT INTO payments (id, order_id, user_id, gateway, amount, status, receipt_photo,
        payer_card, payer_name, tracking_code, reviewed_by, reviewed_at, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)`,
    )
      .bind(p.id, p.orderId, p.userId, p.gateway, p.amount, p.status, p.receiptPhoto, p.payerCard, p.payerName, p.trackingCode, p.reviewedBy, p.reviewedAt, p.createdAt)
      .run();
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    const r = await this.q('SELECT * FROM payments WHERE id = ?1', id).first<Row>();
    return r ? mapPayment(r) : null;
  }

  async listPayments(filter?: { status?: string; limit?: number }): Promise<PaymentRecord[]> {
    const res = filter?.status
      ? await this.q('SELECT * FROM payments WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2', filter.status, filter.limit ?? 50).all<Row>()
      : await this.q('SELECT * FROM payments ORDER BY created_at DESC LIMIT ?1', filter?.limit ?? 50).all<Row>();
    return res.results.map(mapPayment);
  }

  async updatePayment(id: string, patch: Partial<PaymentRecord>): Promise<void> {
    const cur = await this.getPayment(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    await this.q(
      `UPDATE payments SET status=?2, receipt_photo=?3, payer_card=?4, payer_name=?5,
        tracking_code=?6, reviewed_by=?7, reviewed_at=?8, review_note=?9, updated_at=?10
       WHERE id=?1`,
    )
      .bind(id, next.status, next.receiptPhoto, next.payerCard, next.payerName, next.trackingCode, next.reviewedBy, next.reviewedAt, next.reviewNote, now())
      .run();
  }

  async countPaymentsByTracking(trackingCode: string, excludeId?: string): Promise<number> {
    if (!trackingCode.trim()) return 0;
    const r = await this.q(
      `SELECT COUNT(*) AS n FROM payments WHERE tracking_code = ?1 AND id != ?2`,
      trackingCode,
      excludeId ?? '',
    ).first<Row>();
    return asInt(r?.n, 0);
  }

  // -------------------------------------------------- subs & credentials ---

  async createSubscription(s: SubscriptionRecord): Promise<void> {
    await this.q(
      `INSERT INTO subscriptions (id, token, user_id, plan_id, label, traffic_gb,
        traffic_used_bytes, duration_days, expires_at, status, rotation_count,
        last_rotated_at, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)`,
    )
      .bind(s.id, s.token, s.userId, s.planId, s.label, s.trafficGb, s.trafficUsedBytes, s.durationDays, s.expiresAt, s.status, s.rotationCount, s.lastRotatedAt, s.createdAt)
      .run();
  }

  async getSubscription(id: string): Promise<SubscriptionRecord | null> {
    const r = await this.q('SELECT * FROM subscriptions WHERE id = ?1', id).first<Row>();
    return r ? mapSub(r) : null;
  }

  async getSubscriptionByToken(token: string): Promise<SubscriptionRecord | null> {
    const r = await this.q('SELECT * FROM subscriptions WHERE token = ?1', token).first<Row>();
    return r ? mapSub(r) : null;
  }

  async listSubscriptions(userId: string): Promise<SubscriptionRecord[]> {
    const res = await this.q('SELECT * FROM subscriptions WHERE user_id = ?1 ORDER BY created_at DESC', userId).all<Row>();
    return res.results.map(mapSub);
  }

  async listAllSubscriptions(limit = 100): Promise<SubscriptionRecord[]> {
    const res = await this.q(
      'SELECT * FROM subscriptions ORDER BY created_at DESC LIMIT ?1',
      limit,
    ).all<Row>();
    return res.results.map(mapSub);
  }

  async updateSubscription(id: string, patch: Partial<SubscriptionRecord>): Promise<void> {
    const cur = await this.getSubscription(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    await this.q(
      `UPDATE subscriptions SET label=?2, traffic_gb=?3, traffic_used_bytes=?4,
        duration_days=?5, expires_at=?6, status=?7, rotation_count=?8, last_rotated_at=?9,
        updated_at=?10 WHERE id=?1`,
    )
      .bind(id, next.label, next.trafficGb, next.trafficUsedBytes, next.durationDays, next.expiresAt, next.status, next.rotationCount, next.lastRotatedAt, now())
      .run();
  }

  async createCredential(c: CredentialRecord): Promise<void> {
    await this.q(
      `INSERT INTO credentials (id, user_id, sub_id, node_id, panel_user_id, uri, watermark,
        remark, traffic_limit_bytes, expires_at, status, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)`,
    )
      .bind(c.id, c.userId, c.subId, c.nodeId, c.panelUserId, c.uri, c.watermark, c.remark, c.trafficLimitBytes, c.expiresAt, c.status, c.createdAt)
      .run();
  }

  async listCredentials(subId: string): Promise<CredentialRecord[]> {
    const res = await this.q('SELECT * FROM credentials WHERE sub_id = ?1', subId).all<Row>();
    return res.results.map(mapCred);
  }

  async findCredentialByWatermark(watermark: string): Promise<CredentialRecord | null> {
    const r = await this.q('SELECT * FROM credentials WHERE watermark = ?1', watermark.toLowerCase()).first<Row>();
    return r ? mapCred(r) : null;
  }

  async updateCredential(id: string, patch: Partial<CredentialRecord>): Promise<void> {
    const cur = await this.q('SELECT * FROM credentials WHERE id = ?1', id).first<Row>();
    if (!cur) return;
    const base = mapCred(cur);
    const next = { ...base, ...patch };
    await this.q(
      `UPDATE credentials SET uri=?2, watermark=?3, remark=?4, status=?5, expires_at=?6,
        traffic_limit_bytes=?7, updated_at=?8 WHERE id=?1`,
    )
      .bind(id, next.uri, next.watermark, next.remark, next.status, next.expiresAt, next.trafficLimitBytes, now())
      .run();
  }

  // ------------------------------------------------------------- wallet ---

  /**
   * Credit or debit. The debit is guarded in SQL, so two concurrent requests
   * cannot both spend the same balance — a read-then-write here would race.
   */
  async credit(userId: string, delta: number, reason: string, refId = ''): Promise<number> {
    const t = now();
    if (delta < 0) {
      const res = await this.q(
        `UPDATE users SET balance = balance + ?2, updated_at = ?3 WHERE id = ?1 AND balance + ?2 >= 0`,
      )
        .bind(userId, delta, t)
        .run();
      const changes = asInt((res.meta as { changes?: number } | undefined)?.changes, 0);
      if (changes === 0) throw new Error('موجودی کافی نیست');
    } else {
      await this.q(`UPDATE users SET balance = balance + ?2, updated_at = ?3 WHERE id = ?1`)
        .bind(userId, delta, t)
        .run();
    }
    await this.q(
      `INSERT INTO wallet_ledger (id, user_id, delta, balance_after, reason, ref_id, note, created_at)
       VALUES (?1, ?2, ?3, (SELECT balance FROM users WHERE id = ?2), ?4, ?5, '', ?6)`,
    )
      .bind(newId('led'), userId, delta, reason, refId, t)
      .run();

    const u = await this.getUser(userId);
    return u?.balance ?? 0;
  }

  async ledger(userId: string): Promise<{ delta: number; reason: string; at: number }[]> {
    const res = await this.q(
      'SELECT delta, reason, created_at FROM wallet_ledger WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50',
      userId,
    ).all<Row>();
    return res.results.map((r) => ({
      delta: asInt(r.delta),
      reason: asString(r.reason),
      at: asInt(r.created_at),
    }));
  }

  // ------------------------------------------------------------ tickets ---

  async createTicket(t: TicketRecord): Promise<void> {
    await this.q(
      `INSERT INTO tickets (id, code, user_id, subject, category, status, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?7)`,
    )
      .bind(t.id, t.code, t.userId, t.subject, t.category, t.status, t.createdAt)
      .run();
  }

  async listTickets(filter?: { status?: string; userId?: string }): Promise<TicketRecord[]> {
    let sql = 'SELECT * FROM tickets WHERE 1=1';
    const params: unknown[] = [];
    if (filter?.status) {
      params.push(filter.status);
      sql += ` AND status = ?${params.length}`;
    }
    if (filter?.userId) {
      params.push(filter.userId);
      sql += ` AND user_id = ?${params.length}`;
    }
    sql += ' ORDER BY created_at DESC LIMIT 100';
    const res = await this.db.prepare(sql).bind(...params).all<Row>();
    return res.results.map((r) => ({
      id: asString(r.id),
      code: asString(r.code),
      userId: asString(r.user_id),
      subject: asString(r.subject),
      category: asString(r.category, 'other'),
      status: (asString(r.status, 'open') as TicketRecord['status']) ?? 'open',
      createdAt: asInt(r.created_at),
    }));
  }

  // -------------------------------------------------------------- audit ---

  async audit(entry: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<void> {
    await this.q(
      `INSERT INTO audit_log (id, actor_id, actor_label, action, target_type, target_id, detail, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    )
      .bind(newId('aud'), entry.actorId, entry.actorLabel ?? (entry.actorId ? 'admin' : 'system'), entry.action, entry.targetType, entry.targetId, entry.detail, now())
      .run();
  }

  async listAudit(limit = 50): Promise<AuditEntry[]> {
    const res = await this.q('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?1', limit).all<Row>();
    return res.results.map((r) => ({
      id: asString(r.id),
      actorId: r.actor_id ? asString(r.actor_id) : null,
      action: asString(r.action),
      targetType: asString(r.target_type),
      targetId: asString(r.target_id),
      detail: asString(r.detail),
      createdAt: asInt(r.created_at),
    }));
  }

  // -------------------------------------------------------- idempotency ---

  async markUpdateHandled(updateId: number): Promise<boolean> {
    const existing = await this.q('SELECT update_id FROM webhook_updates WHERE update_id = ?1', updateId).first();
    if (existing) return false;
    await this.q('INSERT INTO webhook_updates (update_id, handled_at) VALUES (?1, ?2)', updateId, now()).run();
    return true;
  }
}

// ----------------------------------------------------------------- mappers --

function mapUser(r: Row): UserRecord {
  return {
    id: asString(r.id),
    telegramId: asInt(r.telegram_id),
    username: asString(r.username),
    firstName: asString(r.first_name),
    balance: asInt(r.balance),
    role: asString(r.role, 'user'),
    blocked: asBool(r.blocked),
    trialUsed: false,
    referralCode: asString(r.referral_code),
    referredBy: r.referred_by ? asString(r.referred_by) : null,
    createdAt: asInt(r.created_at),
  };
}

function mapPlan(r: Row): PlanRecord {
  let protocols: string[] = [];
  let countries: string[] = [];
  try {
    protocols = JSON.parse(asString(r.protocol_filter, '[]')) as string[];
  } catch {
    protocols = [];
  }
  return {
    id: asString(r.id),
    slug: asString(r.slug),
    name: asString(r.name),
    price: asInt(r.price),
    trafficGb: asInt(r.traffic_gb),
    durationDays: asInt(r.duration_days, 30),
    maxDevices: asInt(r.max_devices, 2),
    protocols,
    countries,
    hidden: asBool(r.hidden),
    badge: asString(r.badge),
  };
}

function mapNode(r: Row): NodeRecord {
  return {
    id: asString(r.id),
    name: asString(r.name),
    country: asString(r.country),
    countryLabel: asString(r.country_label, asString(r.country)),
    flag: asString(r.flag),
    driver: asString(r.driver, 'mock'),
    protocol: (asString(r.protocol, 'vless') as NodeRecord['protocol']) ?? 'vless',
    security: (asString(r.security, 'reality') as NodeRecord['security']) ?? 'reality',
    publicIp: asString(r.public_ip),
    port: asInt(r.port, 443),
    sni: asString(r.sni),
    realityPbk: asString(r.reality_pbk),
    realityFp: asString(r.reality_fp, 'chrome'),
    realitySpider: asString(r.reality_spider),
    wsPath: asString(r.ws_path),
    inboundTag: asString(r.inbound_tag, 'VLESS'),
    panelUrl: asString(r.panel_url),
    panelUser: asString(r.panel_user),
    panelKey: asString(r.panel_key),
    priority: asInt(r.priority, 100),
    weight: asInt(r.weight, 1),
    health: (asString(r.health, 'unknown') as NodeRecord['health']) ?? 'unknown',
    consecutiveFailures: asInt(r.consecutive_failures, 0),
    enabled: asBool(r.enabled),
    capacityUsers: asInt(r.capacity_users, 0),
    currentUsers: asInt(r.current_users, 0),
  };
}

function mapOrder(r: Row): OrderRecord {
  return {
    id: asString(r.id),
    code: asString(r.code),
    userId: asString(r.user_id),
    kind: (asString(r.kind, 'subscription') as OrderRecord['kind']) ?? 'subscription',
    planId: r.plan_id ? asString(r.plan_id) : null,
    targetSubId: r.target_sub_id ? asString(r.target_sub_id) : null,
    amount: asInt(r.amount),
    discount: asInt(r.discount),
    paidFromBalance: asInt(r.paid_from_balance),
    status: (asString(r.status, 'pending') as OrderRecord['status']) ?? 'pending',
    gateway: asString(r.gateway),
    gatewayRef: asString(r.gateway_ref),
    couponCode: asString(r.coupon_code),
    paidAt: r.paid_at ? asInt(r.paid_at) : null,
    createdAt: asInt(r.created_at),
  };
}

function mapPayment(r: Row): PaymentRecord {
  return {
    id: asString(r.id),
    orderId: r.order_id ? asString(r.order_id) : null,
    userId: asString(r.user_id),
    gateway: asString(r.gateway),
    amount: asInt(r.amount),
    status: (asString(r.status, 'pending') as PaymentRecord['status']) ?? 'pending',
    receiptPhoto: asString(r.receipt_photo),
    payerCard: asString(r.payer_card),
    payerName: asString(r.payer_name),
    trackingCode: asString(r.tracking_code),
    note: asString(r.raw_response),
    reviewedBy: r.reviewed_by ? asString(r.reviewed_by) : null,
    reviewNote: asString(r.review_note),
    createdAt: asInt(r.created_at),
    reviewedAt: r.reviewed_at ? asInt(r.reviewed_at) : null,
  };
}

function mapSub(r: Row): SubscriptionRecord {
  return {
    id: asString(r.id),
    token: asString(r.token),
    userId: asString(r.user_id),
    planId: r.plan_id ? asString(r.plan_id) : null,
    label: asString(r.label),
    trafficGb: asInt(r.traffic_gb),
    trafficUsedBytes: asInt(r.traffic_used_bytes),
    durationDays: asInt(r.duration_days, 30),
    expiresAt: r.expires_at ? asInt(r.expires_at) : null,
    status: (asString(r.status, 'active') as SubscriptionRecord['status']) ?? 'active',
    createdAt: asInt(r.created_at),
    rotationCount: asInt(r.rotation_count, 0),
    lastRotatedAt: r.last_rotated_at ? asInt(r.last_rotated_at) : null,
  };
}

function mapCred(r: Row): CredentialRecord {
  return {
    id: asString(r.id),
    userId: asString(r.user_id),
    subId: asString(r.sub_id),
    nodeId: asString(r.node_id),
    panelUserId: asString(r.panel_user_id),
    uri: asString(r.uri),
    watermark: asString(r.watermark),
    remark: asString(r.remark),
    trafficLimitBytes: asInt(r.traffic_limit_bytes),
    expiresAt: r.expires_at ? asInt(r.expires_at) : null,
    status: (asString(r.status, 'active') as CredentialRecord['status']) ?? 'active',
    createdAt: asInt(r.created_at),
  };
}
