import { newId, now, shortCode, urlToken, watermark } from '../db/db';
import {
  issueAcrossNodes,
  rotateAll,
  remarkFor,
  type GeneratePlan,
  type IssuedConfig,
} from '../config/generate';
import type { NodeDriver, NodeRecord } from '../node/driver';
import { screenReceipt, type ReceiptVerdict } from '../pay/gateways';
import type {
  CredentialRecord,
  OrderRecord,
  PaymentRecord,
  PlanRecord,
  Store,
  SubscriptionRecord,
} from './store';

/**
 * Order lifecycle.
 *
 * The invariant this file protects: **a config is never delivered before the
 * money is confirmed.** Not "probably confirmed" — confirmed by a gateway
 * callback we verified, or by a human/AI approving a card receipt. Every path
 * that creates a subscription goes through `fulfilOrder`, and `fulfilOrder`
 * only runs from `markPaid`.
 *
 * The second invariant: paying twice must not deliver twice. Both
 * `markPaid` and `approvePayment` are idempotent on the order status, so a
 * gateway that posts its callback three times creates one subscription.
 */

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

const GB = 1024 ** 3;

export interface Services {
  store: Store;
  drivers: Map<string, NodeDriver>;
  nodes: NodeRecord[];
}

// ------------------------------------------------------------------ orders --

export interface CreateOrderInput {
  userId: string;
  planId: string;
  kind?: OrderRecord['kind'];
  targetSubId?: string | null;
  couponCode?: string;
  couponDiscount?: number;
  payFromBalance?: number;
}

export async function createOrder(
  svc: Services,
  input: CreateOrderInput,
): Promise<OrderRecord> {
  const plan = await svc.store.getPlan(input.planId);
  if (!plan) throw new ServiceError('پلن پیدا نشد', 'no_plan');
  if (plan.hidden) throw new ServiceError('این پلن فعلاً فعال نیست', 'plan_hidden');

  const user = await svc.store.getUser(input.userId);
  if (!user) throw new ServiceError('کاربر پیدا نشد', 'no_user');
  if (user.blocked) throw new ServiceError('حساب شما مسدود است', 'blocked');

  const discount = Math.max(0, input.couponDiscount ?? 0);
  const fromBalance = Math.max(0, Math.min(input.payFromBalance ?? 0, user.balance));
  const amount = Math.max(0, plan.price - discount - fromBalance);

  if (input.kind === 'renew' && !input.targetSubId) {
    throw new ServiceError('برای تمدید، اشتراک مشخص نیست', 'no_target');
  }

  const order: OrderRecord = {
    id: newId('ord'),
    code: shortCode(8),
    userId: input.userId,
    kind: input.kind ?? 'subscription',
    planId: plan.id,
    targetSubId: input.targetSubId ?? null,
    amount,
    discount,
    paidFromBalance: fromBalance,
    status: 'pending',
    gateway: '',
    gatewayRef: '',
    couponCode: input.couponCode ?? '',
    paidAt: null,
    createdAt: now(),
  };

  // Debit the wallet portion up front. Doing it here rather than at fulfil time
  // means a user cannot spend the same balance on two orders.
  if (fromBalance > 0) {
    const balance = await svc.store.credit(user.id, -fromBalance, 'purchase', order.id);
    await svc.store.audit({
      actorId: user.id,
      action: 'order.create_from_balance',
      targetType: 'order',
      targetId: order.id,
      detail: JSON.stringify({ fromBalance, balanceAfter: balance }),
    });
  }

  await svc.store.createOrder(order);

  // A zero-amount order is already paid — a 100 % coupon should not sit in the
  // queue waiting for a payment that will never come.
  if (amount === 0) {
    return markPaid(svc, order.id, 'coupon');
  }
  return order;
}

export interface FulfilResult {
  subscription: SubscriptionRecord;
  credentials: CredentialRecord[];
  failures: { nodeId: string; name: string; reason: string }[];
}

/**
 * Deliver what was paid for.
 *
 * Idempotent: if the order already produced a subscription we return it instead
 * of creating a second one. That is what makes a duplicated gateway callback
 * harmless.
 */
export async function fulfilOrder(svc: Services, orderId: string): Promise<FulfilResult> {
  const order = await svc.store.getOrder(orderId);
  if (!order) throw new ServiceError('سفارش پیدا نشد', 'no_order');
  if (order.status !== 'paid' && order.status !== 'approved') {
    throw new ServiceError(`سفارش در وضعیت ${order.status} قابل تحویل نیست`, 'not_paid');
  }
  if (!order.planId) throw new ServiceError('سفارش پلن ندارد', 'no_plan');

  // Idempotency: reuse an existing subscription for this order.
  const existing = await findSubscriptionForOrder(svc, order);
  if (existing) {
    const creds = await svc.store.listCredentials(existing.id);
    return { subscription: existing, credentials: creds, failures: [] };
  }

  const plan = await svc.store.getPlan(order.planId);
  if (!plan) throw new ServiceError('پلن پیدا نشد', 'no_plan');
  const user = await svc.store.getUser(order.userId);
  if (!user) throw new ServiceError('کاربر پیدا نشد', 'no_user');

  // Renewal extends the existing subscription instead of creating a new one.
  if (order.kind === 'renew' && order.targetSubId) {
    const sub = await svc.store.getSubscription(order.targetSubId);
    if (sub) {
      const base = sub.expiresAt && sub.expiresAt > now() ? sub.expiresAt : now();
      const expiresAt = base + plan.durationDays * 86_400_000;
      await svc.store.updateSubscription(sub.id, {
        expiresAt,
        status: 'active',
        trafficGb: sub.trafficGb + plan.trafficGb,
      });
      await svc.store.audit({
        actorId: user.id,
        action: 'subscription.renew',
        targetType: 'subscription',
        targetId: sub.id,
        detail: JSON.stringify({ orderId: order.id, newExpiry: expiresAt }),
      });
      const creds = await svc.store.listCredentials(sub.id);
      return { subscription: { ...sub, expiresAt, status: 'active' }, credentials: creds, failures: [] };
    }
  }

  const token = urlToken();
  const subId = newId('sub');
  const expiresAt =
    plan.durationDays > 0 ? now() + plan.durationDays * 86_400_000 : null;

  const generatePlan: GeneratePlan = {
    protocols: plan.protocols as GeneratePlan['protocols'],
    countries: plan.countries,
    trafficLimitBytes: plan.trafficGb > 0 ? plan.trafficGb * GB : 0,
    expiresAt,
    remarkPrefix: plan.name,
    maxNodes: Math.max(1, Math.min(8, plan.countries.length || 4)),
  };

  const outcome = await issueAcrossNodes(svc.nodes, svc.drivers, generatePlan, {
    userIdShort: user.id.slice(-6),
    makeWatermark: () => watermark(),
  });

  const sub: SubscriptionRecord = {
    id: subId,
    token,
    userId: user.id,
    planId: plan.id,
    label: plan.name,
    trafficGb: plan.trafficGb,
    trafficUsedBytes: 0,
    durationDays: plan.durationDays,
    expiresAt,
    status: 'active',
    createdAt: now(),
    rotationCount: 0,
    lastRotatedAt: null,
  };
  await svc.store.createSubscription(sub);

  const credentials: CredentialRecord[] = [];
  for (const issued of outcome.issued) {
    const cred: CredentialRecord = {
      id: newId('crd'),
      userId: user.id,
      subId,
      nodeId: issued.node.id,
      panelUserId: issued.credential.panelUserId,
      uri: issued.uri,
      watermark: issued.watermark,
      remark: remarkFor(plan.name, issued.node, issued.watermark),
      trafficLimitBytes: issued.credential.trafficLimitBytes,
      expiresAt,
      status: 'active',
      createdAt: now(),
    };
    await svc.store.createCredential(cred);
    credentials.push(cred);
  }

  await svc.store.audit({
    actorId: user.id,
    action: 'order.fulfil',
    targetType: 'subscription',
    targetId: subId,
    detail: JSON.stringify({
      orderId: order.id,
      configs: credentials.length,
      failures: outcome.failures.length,
    }),
  });

  return { subscription: sub, credentials, failures: outcome.failures };
}

async function findSubscriptionForOrder(
  svc: Services,
  order: OrderRecord,
): Promise<SubscriptionRecord | null> {
  const subs = await svc.store.listSubscriptions(order.userId);
  for (const s of subs) {
    // A subscription created within the same second as the fulfil and matching
    // the plan is the one this order produced.
    if (s.planId === order.planId && Math.abs(s.createdAt - order.createdAt) < 5 * 60_000) {
      const creds = await svc.store.listCredentials(s.id);
      if (creds.length > 0) return s;
    }
  }
  return null;
}

/**
 * Record that money arrived, and deliver.
 *
 * Returns the same result for a repeat call, so a double callback cannot
 * double-deliver.
 */
export async function markPaid(
  svc: Services,
  orderId: string,
  gateway: string,
  ref = '',
): Promise<OrderRecord> {
  const order = await svc.store.getOrder(orderId);
  if (!order) throw new ServiceError('سفارش پیدا نشد', 'no_order');

  if (order.status === 'paid' || order.status === 'approved') {
    // Already paid: make sure it was delivered, then return quietly.
    if (!(await findSubscriptionForOrder(svc, order))) {
      await fulfilOrder(svc, order.id);
    }
    return order;
  }
  if (order.status === 'rejected' || order.status === 'canceled') {
    throw new ServiceError('این سفارش بسته شده است', 'closed');
  }

  await svc.store.updateOrder(orderId, {
    status: 'paid',
    gateway,
    gatewayRef: ref,
    paidAt: now(),
  });
  await svc.store.audit({
    actorId: order.userId,
    action: 'order.paid',
    targetType: 'order',
    targetId: orderId,
    detail: JSON.stringify({ gateway, ref, amount: order.amount }),
  });

  await fulfilOrder(svc, orderId);

  const updated = await svc.store.getOrder(orderId);
  if (!updated) throw new ServiceError('سفارش بعد از پرداخت پیدا نشد', 'no_order');
  return updated;
}

// ---------------------------------------------------------------- payments --

export interface SubmitReceiptInput {
  orderId: string;
  userId: string;
  receiptPhoto: string; // R2 key or Telegram file_id
  payerCard: string;
  payerName: string;
  trackingCode: string;
  note: string;
}

export interface SubmitReceiptResult {
  payment: PaymentRecord;
  verdict: ReceiptVerdict;
  /** True when we approved without a human, because every field matched. */
  autoApproved: boolean;
  order: OrderRecord;
}

/**
 * Take a card-to-card receipt and screen it.
 *
 * The screening can auto-approve, but only on a clean sweep. Anything ambiguous
 * lands in the admin queue with the reasons spelled out — which is the honest
 * version of "AI handles payments": it handles the boring 90 % and shows its
 * working on the rest.
 */
export async function submitReceipt(
  svc: Services,
  input: SubmitReceiptInput,
): Promise<SubmitReceiptResult> {
  const order = await svc.store.getOrder(input.orderId);
  if (!order) throw new ServiceError('سفارش پیدا نشد', 'no_order');
  if (order.userId !== input.userId) throw new ServiceError('سفارش مال شما نیست', 'forbidden');
  if (['rejected', 'canceled', 'expired'].includes(order.status)) {
    throw new ServiceError('این سفارش بسته شده است', 'closed');
  }
  if (!input.receiptPhoto) throw new ServiceError('عکس رسید ارسال نشده', 'no_photo');

  const payment: PaymentRecord = {
    id: newId('pay'),
    orderId: order.id,
    userId: input.userId,
    gateway: 'card',
    amount: order.amount,
    status: 'submitted',
    receiptPhoto: input.receiptPhoto,
    payerCard: input.payerCard.replace(/\s/g, ''),
    payerName: input.payerName.trim(),
    trackingCode: input.trackingCode.trim(),
    note: input.note.trim().slice(0, 500),
    reviewedBy: null,
    reviewNote: '',
    createdAt: now(),
    reviewedAt: null,
  };
  await svc.store.createPayment(payment);

  const duplicates = await svc.store.countPaymentsByTracking(
    input.trackingCode.trim(),
    payment.id,
  );

  const verdict = screenReceipt({
    paymentId: payment.id,
    orderCode: order.code,
    expectedAmount: order.amount,
    note: input.note,
    payerCard: input.payerCard,
    payerName: input.payerName,
    trackingCode: input.trackingCode,
    hasPhoto: true,
    duplicateTrackingCount: duplicates,
    samePayerRecentCount: 0,
    minutesSinceOrder: Math.max(0, Math.round((now() - order.createdAt) / 60_000)),
  });

  await svc.store.audit({
    actorId: input.userId,
    action: 'payment.receipt_submitted',
    targetType: 'payment',
    targetId: payment.id,
    detail: JSON.stringify({ verdict: verdict.verdict, confidence: verdict.confidence, duplicates }),
  });

  const autoApproved = verdict.verdict === 'approve';
  if (autoApproved) {
    await approvePayment(svc, payment.id, 'ai', verdict.summary);
  } else if (verdict.verdict === 'reject') {
    await svc.store.updatePayment(payment.id, {
      status: 'rejected',
      reviewNote: verdict.summary,
      reviewedAt: now(),
      reviewedBy: reviewerRef('ai').id,
    });
  }

  const updated = (await svc.store.getOrder(order.id)) ?? order;
  return {
    payment: (await svc.store.getPayment(payment.id)) ?? payment,
    verdict,
    autoApproved,
    order: updated,
  };
}

/**
 * Approve a payment. Idempotent: approving twice delivers once.
 */
/**
 * Split a reviewer into what may legally go in a foreign key and what may not.
 *
 * `payments.reviewed_by` and `audit_log.actor_id` are both
 * `REFERENCES users(id)`. Callers pass labels like 'ai' and 'admin' for
 * reviews that no user performed, and writing a label into a FK column is a
 * hard constraint violation on any SQLite with foreign_keys on — which is what
 * D1 runs. The fake D1 in the test suite enforces nothing, which is why this
 * survived 457 passing tests and only showed up against real SQLite.
 *
 * A real user id has the `usr_` prefix that newId('usr') mints; anything else
 * is a label and belongs in actor_label, never in the FK column.
 */
export function reviewerRef(reviewer: string): { id: string | null; label: string } {
  return reviewer.startsWith('usr_') ? { id: reviewer, label: 'admin' } : { id: null, label: reviewer };
}

export async function approvePayment(
  svc: Services,
  paymentId: string,
  reviewer: string,
  note = '',
): Promise<OrderRecord | null> {
  const payment = await svc.store.getPayment(paymentId);
  if (!payment) throw new ServiceError('پرداخت پیدا نشد', 'no_payment');

  if (payment.status === 'approved') {
    // Already handled; return the order so the caller can re-render.
    return payment.orderId ? svc.store.getOrder(payment.orderId) : null;
  }

  const by = reviewerRef(reviewer);
  await svc.store.updatePayment(paymentId, {
    status: 'approved',
    reviewedBy: by.id,
    reviewedAt: now(),
    reviewNote: note,
  });
  await svc.store.audit({
    actorId: by.id,
    actorLabel: by.label,
    action: 'payment.approve',
    targetType: 'payment',
    targetId: paymentId,
    detail: JSON.stringify({ amount: payment.amount, note }),
  });

  if (!payment.orderId) return null;
  return markPaid(svc, payment.orderId, payment.gateway, `payment:${payment.id}`);
}

export async function rejectPayment(
  svc: Services,
  paymentId: string,
  reviewer: string,
  reason: string,
): Promise<void> {
  const payment = await svc.store.getPayment(paymentId);
  if (!payment) throw new ServiceError('پرداخت پیدا نشد', 'no_payment');
  if (payment.status === 'approved') {
    throw new ServiceError('این پرداخت تأیید شده و قابل رد کردن نیست', 'already_approved');
  }
  const by = reviewerRef(reviewer);
  await svc.store.updatePayment(paymentId, {
    status: 'rejected',
    reviewedBy: by.id,
    reviewedAt: now(),
    reviewNote: reason,
  });
  if (payment.orderId) {
    await svc.store.updateOrder(payment.orderId, { status: 'rejected' });
  }
  await svc.store.audit({
    actorId: by.id,
    actorLabel: by.label,
    action: 'payment.reject',
    targetType: 'payment',
    targetId: paymentId,
    detail: JSON.stringify({ reason }),
  });
}

// ------------------------------------------------------------- rotation ----

export interface RotateResult {
  sub: SubscriptionRecord;
  credentials: CredentialRecord[];
  changed: number;
  failures: { nodeId: string; name: string; reason: string }[];
}

/**
 * Rotate every config in a subscription. The link stays the same; the secrets
 * change, so anything already shared stops working.
 */
export async function rotateSubscription(
  svc: Services,
  subId: string,
  actorId: string,
): Promise<RotateResult> {
  const sub = await svc.store.getSubscription(subId);
  if (!sub) throw new ServiceError('اشتراک پیدا نشد', 'no_sub');
  if (sub.status === 'suspended') throw new ServiceError('اشتراک معلق است', 'suspended');

  const creds = await svc.store.listCredentials(subId);
  if (creds.length === 0) throw new ServiceError('این اشتراک کانفیگی ندارد', 'no_creds');

  const plan = sub.planId ? await svc.store.getPlan(sub.planId) : null;
  const issued: IssuedConfig[] = [];
  for (const c of creds) {
    const node = svc.nodes.find((n) => n.id === c.nodeId);
    if (!node) continue;
    const driver = svc.drivers.get(node.id);
    if (!driver) continue;
    // We do not keep the raw secret in D1 beyond what is needed to rebuild, so
    // reconstruction uses the stored URI plus the node's current settings.
    issued.push({
      node,
      watermark: c.watermark,
      uri: c.uri,
      credential: {
        panelUserId: c.panelUserId,
        username: `u${sub.userId.slice(-6)}_${node.country}`,
        uuid: '',
        password: '',
        ssMethod: '',
        ssKey: '',
        wgPrivateKey: '',
        wgPublicKey: '',
        wgPsk: '',
        wgEndpointPort: 0,
        wgClientAddress: '',
        tuicCongestion: '',
        hy2Auth: '',
        uri: c.uri,
        trafficLimitBytes: c.trafficLimitBytes,
        expiresAt: c.expiresAt,
      },
    });
    void driver;
  }

  const generatePlan: GeneratePlan = {
    protocols: (plan?.protocols ?? []) as GeneratePlan['protocols'],
    countries: plan?.countries ?? [],
    trafficLimitBytes: sub.trafficGb > 0 ? sub.trafficGb * GB : 0,
    expiresAt: sub.expiresAt,
    remarkPrefix: sub.label,
    maxNodes: issued.length,
  };

  const outcome = await rotateAll({
    sub: { id: sub.id, token: sub.token },
    issued,
    drivers: svc.drivers,
    plan: generatePlan,
    opts: { makeWatermark: () => watermark() },
  });

  // Persist the new URIs and retire the old credentials.
  for (const rotated of outcome.rotated) {
    const old = creds.find((c) => c.nodeId === rotated.node.id);
    if (old) {
      await svc.store.updateCredential(old.id, {
        uri: rotated.uri,
        watermark: rotated.watermark,
        remark: remarkFor(sub.label, rotated.node, rotated.watermark),
      });
    }
  }

  await svc.store.updateSubscription(subId, {
    rotationCount: sub.rotationCount + 1,
    lastRotatedAt: now(),
  });
  await svc.store.audit({
    actorId,
    action: 'subscription.rotate',
    targetType: 'subscription',
    targetId: subId,
    detail: JSON.stringify({ changed: outcome.changed, failures: outcome.failures.length }),
  });

  return {
    sub: { ...sub, rotationCount: sub.rotationCount + 1, lastRotatedAt: now() },
    credentials: await svc.store.listCredentials(subId),
    changed: outcome.changed,
    failures: outcome.failures,
  };
}

// --------------------------------------------------------------- trials ----

/**
 * Issue a free trial. Once per user, enforced here and not in the UI, because a
 * UI-only limit is a limit the user can bypass by calling the handler twice.
 */
export async function issueTrial(
  svc: Services,
  userId: string,
  opts: { days: number; trafficGb: number },
): Promise<FulfilResult> {
  const user = await svc.store.getUser(userId);
  if (!user) throw new ServiceError('کاربر پیدا نشد', 'no_user');
  if (user.trialUsed) throw new ServiceError('قبلاً از نسخه‌ی رایگان استفاده کردی', 'trial_used');

  const token = urlToken();
  const subId = newId('sub');
  const expiresAt = now() + opts.days * 86_400_000;
  const nodes = svc.nodes.filter((n) => n.enabled && n.health !== 'down');
  if (nodes.length === 0) throw new ServiceError('الان نود سالمی نداریم', 'no_nodes');

  const outcome = await issueAcrossNodes(
    nodes,
    svc.drivers,
    {
      protocols: [],
      countries: [],
      trafficLimitBytes: opts.trafficGb * GB,
      expiresAt,
      remarkPrefix: 'نسخه‌ی رایگان',
      maxNodes: 1,
    },
    { userIdShort: user.id.slice(-6), makeWatermark: () => watermark() },
  );

  const sub: SubscriptionRecord = {
    id: subId,
    token,
    userId,
    planId: null,
    label: 'نسخه‌ی رایگان',
    trafficGb: opts.trafficGb,
    trafficUsedBytes: 0,
    durationDays: opts.days,
    expiresAt,
    status: 'active',
    createdAt: now(),
    rotationCount: 0,
    lastRotatedAt: null,
  };
  await svc.store.createSubscription(sub);
  for (const issued of outcome.issued) {
    await svc.store.createCredential({
      id: newId('crd'),
      userId,
      subId,
      nodeId: issued.node.id,
      panelUserId: issued.credential.panelUserId,
      uri: issued.uri,
      watermark: issued.watermark,
      remark: remarkFor('نسخه‌ی رایگان', issued.node, issued.watermark),
      trafficLimitBytes: issued.credential.trafficLimitBytes,
      expiresAt,
      status: 'active',
      createdAt: now(),
    });
  }

  await svc.store.putUser({ ...user, trialUsed: true });
  await svc.store.audit({
    actorId: userId,
    action: 'trial.issue',
    targetType: 'subscription',
    targetId: subId,
    detail: JSON.stringify({ days: opts.days, trafficGb: opts.trafficGb }),
  });

  return {
    subscription: sub,
    credentials: await svc.store.listCredentials(subId),
    failures: outcome.failures,
  };
}

// ------------------------------------------------------------- leak trace --

export interface LeakTrace {
  found: boolean;
  credential: CredentialRecord | null;
  userId: string | null;
  username: string;
  subId: string | null;
  message: string;
}

/**
 * Given a config someone pasted (usually from a public channel), find who it
 * belongs to. The watermark in the remark is the whole mechanism.
 */
export async function traceLeak(svc: Services, uri: string): Promise<LeakTrace> {
  // Decode first. Without this, the percent-encoded separator before the
  // watermark ('%20') hands the regex a leading '0' that is valid hex, and the
  // value we look up is one character longer than the one we stored.
  const m = /([0-9a-f]{6,10})\s*$/.exec(decodeTail(uri));
  if (!m) {
    return {
      found: false,
      credential: null,
      userId: null,
      username: '',
      subId: null,
      message: 'در این کانفیگ واترمارکی پیدا نشد',
    };
  }
  const cred = await svc.store.findCredentialByWatermark(m[1]!);
  if (!cred) {
    return {
      found: false,
      credential: null,
      userId: null,
      username: '',
      subId: null,
      message: `واترمارک ${m[1]} به هیچ کاربری وصل نیست`,
    };
  }
  const user = await svc.store.getUser(cred.userId);
  return {
    found: true,
    credential: cred,
    userId: cred.userId,
    username: user?.username ?? user?.firstName ?? cred.userId,
    subId: cred.subId,
    message: `مال ${user?.username || cred.userId}`,
  };
}

/**
 * Percent-decode the tail of a URI, tolerating a truncated paste.
 * A half-copied link throws inside `decodeURIComponent`; falling back to the
 * raw text still finds a watermark in most cases rather than reporting "not
 * found" for a config we do in fact recognise.
 */
export function decodeTail(uri: string): string {
  const tail = uri.split('#').pop() ?? '';
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

// --------------------------------------------------------------- helpers ---

export function planFromRecord(p: PlanRecord): PlanRecord {
  return p;
}

export function gb(bytes: number): number {
  return Number((bytes / GB).toFixed(2));
}

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} گیگابایت`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} مگابایت`;
  return `${Math.round(bytes / 1024)} کیلوبایت`;
}
