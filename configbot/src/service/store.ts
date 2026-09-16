/**
 * Store — the persistence seam for the business logic.
 *
 * `service/orders.ts` holds the money and config lifecycle. Testing it against
 * real D1 would mean spinning up miniflare for every assertion, and testing it
 * against nothing would mean testing a re-implementation. So it talks to this
 * interface: `D1Store` in production, `MemoryStore` in tests. Both are real
 * code paths, and the tests exercise the same order lifecycle the Worker runs.
 */

import { newId, now } from '../db/db';
import type { NodeRecord } from '../node/driver';

export type OrderStatus =
  | 'pending'
  | 'awaiting_payment'
  | 'paid'
  | 'approved'
  | 'rejected'
  | 'canceled'
  | 'expired'
  | 'failed';

export type PaymentStatus = 'pending' | 'submitted' | 'approved' | 'rejected' | 'refunded';

export interface PlanRecord {
  id: string;
  slug: string;
  name: string;
  price: number;
  trafficGb: number;
  durationDays: number;
  maxDevices: number;
  protocols: string[];
  countries: string[];
  hidden: boolean;
  badge: string;
}

export interface SubscriptionRecord {
  id: string;
  token: string;
  userId: string;
  planId: string | null;
  label: string;
  trafficGb: number;
  trafficUsedBytes: number;
  durationDays: number;
  expiresAt: number | null;
  status: 'active' | 'expired' | 'suspended' | 'canceled';
  createdAt: number;
  rotationCount: number;
  lastRotatedAt: number | null;
}

export interface CredentialRecord {
  id: string;
  userId: string;
  subId: string;
  nodeId: string;
  panelUserId: string;
  uri: string;
  watermark: string;
  remark: string;
  trafficLimitBytes: number;
  expiresAt: number | null;
  status: 'active' | 'suspended' | 'revoked' | 'expired' | 'migrated';
  createdAt: number;
}

export interface OrderRecord {
  id: string;
  code: string;
  userId: string;
  kind: 'subscription' | 'refill' | 'renew' | 'trial';
  planId: string | null;
  targetSubId: string | null;
  amount: number;
  discount: number;
  paidFromBalance: number;
  status: OrderStatus;
  gateway: string;
  gatewayRef: string;
  couponCode: string;
  paidAt: number | null;
  createdAt: number;
}

export interface PaymentRecord {
  id: string;
  orderId: string | null;
  userId: string;
  gateway: string;
  amount: number;
  status: PaymentStatus;
  receiptPhoto: string;
  payerCard: string;
  payerName: string;
  trackingCode: string;
  note: string;
  reviewedBy: string | null;
  reviewNote: string;
  createdAt: number;
  reviewedAt: number | null;
}

export interface UserRecord {
  id: string;
  telegramId: number;
  username: string;
  firstName: string;
  balance: number;
  role: string;
  blocked: boolean;
  trialUsed: boolean;
  referralCode: string;
  referredBy: string | null;
  createdAt: number;
}

export interface TicketRecord {
  id: string;
  code: string;
  userId: string;
  subject: string;
  category: string;
  status: 'open' | 'pending_user' | 'answered' | 'closed';
  createdAt: number;
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: string;
  createdAt: number;
}

export interface Store {
  // users
  getUser(id: string): Promise<UserRecord | null>;
  getUserByTelegram(telegramId: number): Promise<UserRecord | null>;
  putUser(user: UserRecord): Promise<void>;
  /** Admin-only: paged user list for the panel. */
  listUsers(limit?: number, offset?: number): Promise<UserRecord[]>;
  countUsers(): Promise<number>;

  // plans
  listPlans(includeHidden?: boolean): Promise<PlanRecord[]>;
  getPlan(id: string): Promise<PlanRecord | null>;

  // nodes
  listNodes(): Promise<NodeRecord[]>;

  // orders
  createOrder(order: OrderRecord): Promise<void>;
  getOrder(id: string): Promise<OrderRecord | null>;
  getOrderByCode(code: string): Promise<OrderRecord | null>;
  listOrders(userId?: string, limit?: number): Promise<OrderRecord[]>;
  updateOrder(id: string, patch: Partial<OrderRecord>): Promise<void>;

  // payments
  createPayment(payment: PaymentRecord): Promise<void>;
  getPayment(id: string): Promise<PaymentRecord | null>;
  listPayments(filter?: { status?: PaymentStatus; limit?: number }): Promise<PaymentRecord[]>;
  updatePayment(id: string, patch: Partial<PaymentRecord>): Promise<void>;
  countPaymentsByTracking(trackingCode: string, excludeId?: string): Promise<number>;

  // subscriptions + credentials
  createSubscription(sub: SubscriptionRecord): Promise<SubscriptionRecord | null | void> extends never ? never : Promise<void>;
  getSubscription(id: string): Promise<SubscriptionRecord | null>;
  getSubscriptionByToken(token: string): Promise<SubscriptionRecord | null>;
  listSubscriptions(userId: string): Promise<SubscriptionRecord[]>;
  /** Admin-only: every subscription, newest first. */
  listAllSubscriptions(limit?: number): Promise<SubscriptionRecord[]>;
  updateSubscription(id: string, patch: Partial<SubscriptionRecord>): Promise<void>;

  createCredential(cred: CredentialRecord): Promise<void>;
  listCredentials(subId: string): Promise<CredentialRecord[]>;
  findCredentialByWatermark(watermark: string): Promise<CredentialRecord | null>;
  updateCredential(id: string, patch: Partial<CredentialRecord>): Promise<void>;

  // wallet
  credit(userId: string, delta: number, reason: string, refId?: string): Promise<number>;
  ledger(userId: string): Promise<{ delta: number; reason: string; at: number }[]>;

  // tickets
  createTicket(ticket: TicketRecord): Promise<void>;
  listTickets(filter?: { status?: string; userId?: string }): Promise<TicketRecord[]>;

  // audit
  audit(entry: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<void>;
  listAudit(limit?: number): Promise<AuditEntry[]>;

  // idempotency
  markUpdateHandled(updateId: number): Promise<boolean>;
}

// ----------------------------------------------------------- MemoryStore ---

/**
 * In-memory Store for tests and for `wrangler dev`.
 *
 * It implements the same invariants as D1 — a debit cannot go negative, a
 * duplicate `update_id` is refused, a watermark lookup is unique — so a test
 * that passes here is testing behaviour, not a stub.
 */
export class MemoryStore implements Store {
  readonly users = new Map<string, UserRecord>();
  readonly plans = new Map<string, PlanRecord>();
  readonly orders = new Map<string, OrderRecord>();
  readonly payments = new Map<string, PaymentRecord>();
  readonly subs = new Map<string, SubscriptionRecord>();
  readonly credentials = new Map<string, CredentialRecord>();
  readonly tickets = new Map<string, TicketRecord>();
  readonly audits: AuditEntry[] = [];
  readonly ledgerRows: { userId: string; delta: number; reason: string; refId: string; at: number }[] = [];
  private readonly seenUpdates = new Set<number>();
  private nodes: NodeRecord[] = [];

  setNodes(nodes: NodeRecord[]): void {
    this.nodes = nodes;
  }

  async getUser(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async getUserByTelegram(telegramId: number): Promise<UserRecord | null> {
    for (const u of this.users.values()) if (u.telegramId === telegramId) return u;
    return null;
  }

  async putUser(user: UserRecord): Promise<void> {
    this.users.set(user.id, user);
  }

  async listUsers(limit = 50, offset = 0): Promise<UserRecord[]> {
    return [...this.users.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(offset, offset + limit);
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async listPlans(includeHidden = false): Promise<PlanRecord[]> {
    return [...this.plans.values()].filter((p) => includeHidden || !p.hidden);
  }

  async getPlan(id: string): Promise<PlanRecord | null> {
    return this.plans.get(id) ?? null;
  }

  async listNodes(): Promise<NodeRecord[]> {
    return this.nodes;
  }

  async createOrder(order: OrderRecord): Promise<void> {
    this.orders.set(order.id, order);
  }

  async getOrder(id: string): Promise<OrderRecord | null> {
    return this.orders.get(id) ?? null;
  }

  async getOrderByCode(code: string): Promise<OrderRecord | null> {
    for (const o of this.orders.values()) if (o.code === code) return o;
    return null;
  }

  async listOrders(userId?: string, limit = 20): Promise<OrderRecord[]> {
    const all = [...this.orders.values()].sort((a, b) => b.createdAt - a.createdAt);
    const filtered = userId ? all.filter((o) => o.userId === userId) : all;
    return filtered.slice(0, limit);
  }

  async updateOrder(id: string, patch: Partial<OrderRecord>): Promise<void> {
    const cur = this.orders.get(id);
    if (cur) this.orders.set(id, { ...cur, ...patch });
  }

  async createPayment(payment: PaymentRecord): Promise<void> {
    this.payments.set(payment.id, payment);
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    return this.payments.get(id) ?? null;
  }

  async listPayments(filter?: { status?: PaymentStatus; limit?: number }): Promise<PaymentRecord[]> {
    const all = [...this.payments.values()].sort((a, b) => b.createdAt - a.createdAt);
    const filtered = filter?.status ? all.filter((p) => p.status === filter.status) : all;
    return filtered.slice(0, filter?.limit ?? 50);
  }

  async updatePayment(id: string, patch: Partial<PaymentRecord>): Promise<void> {
    const cur = this.payments.get(id);
    if (cur) this.payments.set(id, { ...cur, ...patch });
  }

  async countPaymentsByTracking(trackingCode: string, excludeId?: string): Promise<number> {
    if (!trackingCode.trim()) return 0;
    let n = 0;
    for (const p of this.payments.values()) {
      if (p.id === excludeId) continue;
      if (p.trackingCode && p.trackingCode === trackingCode) n++;
    }
    return n;
  }

  async createSubscription(sub: SubscriptionRecord): Promise<void> {
    this.subs.set(sub.id, sub);
  }

  async getSubscription(id: string): Promise<SubscriptionRecord | null> {
    return this.subs.get(id) ?? null;
  }

  async getSubscriptionByToken(token: string): Promise<SubscriptionRecord | null> {
    for (const s of this.subs.values()) if (s.token === token) return s;
    return null;
  }

  async listSubscriptions(userId: string): Promise<SubscriptionRecord[]> {
    return [...this.subs.values()].filter((s) => s.userId === userId);
  }

  async listAllSubscriptions(limit = 100): Promise<SubscriptionRecord[]> {
    return [...this.subs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async updateSubscription(id: string, patch: Partial<SubscriptionRecord>): Promise<void> {
    const cur = this.subs.get(id);
    if (cur) this.subs.set(id, { ...cur, ...patch });
  }

  async createCredential(cred: CredentialRecord): Promise<void> {
    this.credentials.set(cred.id, cred);
  }

  async listCredentials(subId: string): Promise<CredentialRecord[]> {
    return [...this.credentials.values()].filter((c) => c.subId === subId);
  }

  async findCredentialByWatermark(watermark: string): Promise<CredentialRecord | null> {
    const w = watermark.toLowerCase();
    for (const c of this.credentials.values()) {
      if (c.watermark.toLowerCase() === w) return c;
    }
    return null;
  }

  async updateCredential(id: string, patch: Partial<CredentialRecord>): Promise<void> {
    const cur = this.credentials.get(id);
    if (cur) this.credentials.set(id, { ...cur, ...patch });
  }

  async credit(userId: string, delta: number, reason: string, refId = ''): Promise<number> {
    const user = this.users.get(userId);
    if (!user) throw new Error('user not found');
    const next = user.balance + delta;
    if (next < 0) throw new Error('موجودی کافی نیست');
    user.balance = next;
    this.ledgerRows.push({ userId, delta, reason, refId, at: now() });
    return next;
  }

  async ledger(userId: string): Promise<{ delta: number; reason: string; at: number }[]> {
    return this.ledgerRows.filter((r) => r.userId === userId);
  }

  async createTicket(ticket: TicketRecord): Promise<void> {
    this.tickets.set(ticket.id, ticket);
  }

  async listTickets(filter?: { status?: string; userId?: string }): Promise<TicketRecord[]> {
    let all = [...this.tickets.values()];
    if (filter?.status) all = all.filter((t) => t.status === filter.status);
    if (filter?.userId) all = all.filter((t) => t.userId === filter.userId);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async audit(entry: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<void> {
    this.audits.push({ ...entry, id: newId('aud'), createdAt: now() });
  }

  async listAudit(limit = 50): Promise<AuditEntry[]> {
    return this.audits.slice(-limit).reverse();
  }

  async markUpdateHandled(updateId: number): Promise<boolean> {
    if (this.seenUpdates.has(updateId)) return false;
    this.seenUpdates.add(updateId);
    return true;
  }
}
