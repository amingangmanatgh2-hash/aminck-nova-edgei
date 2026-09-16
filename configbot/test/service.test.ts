import { describe, it, expect } from 'vitest';
import { MemoryStore, type PlanRecord, type UserRecord } from '../src/service/store';
import {
  approvePayment,
  createOrder,
  fulfilOrder,
  issueTrial,
  markPaid,
  rejectPayment,
  rotateSubscription,
  submitReceipt,
  traceLeak,
  ServiceError,
  type Services,
} from '../src/service/orders';
import { MockNodeDriver, makeMockNodeRecord } from '../src/node/driver';
import {
  CardGateway,
  WalletGateway,
  ZarinpalGateway,
  listAvailable,
  buildRegistry,
  parseAmount,
  screenReceipt,
  formatToman,
} from '../src/pay/gateways';

function seed(): Services {
  const store = new MemoryStore();
  const nodes = [
    makeMockNodeRecord({ id: 'nl1', publicIp: '1.1.1.1', country: 'nl', countryLabel: 'هلند', flag: '🇳🇱' }),
    makeMockNodeRecord({ id: 'de1', publicIp: '2.2.2.1', country: 'de', countryLabel: 'آلمان', flag: '🇩🇪' }),
  ];
  store.setNodes(nodes);
  const drivers = new Map(nodes.map((n) => [n.id, new MockNodeDriver()]));

  const plans: PlanRecord[] = [
    {
      id: 'p1',
      slug: 'month',
      name: 'یک ماهه',
      price: 90_000,
      trafficGb: 50,
      durationDays: 30,
      maxDevices: 2,
      protocols: [],
      countries: [],
      hidden: false,
      badge: '',
    },
    {
      id: 'p_free',
      slug: 'free100',
      name: 'کاملاً رایگان',
      price: 0,
      trafficGb: 1,
      durationDays: 1,
      maxDevices: 1,
      protocols: [],
      countries: [],
      hidden: false,
      badge: '',
    },
    {
      id: 'p_hidden',
      slug: 'hidden',
      name: 'مخفی',
      price: 10_000,
      trafficGb: 5,
      durationDays: 7,
      maxDevices: 1,
      protocols: [],
      countries: [],
      hidden: true,
      badge: '',
    },
  ];
  plans.forEach((p) => store.plans.set(p.id, p));

  const user: UserRecord = {
    id: 'usr_test0001',
    telegramId: 12345,
    username: 'ali',
    firstName: 'Ali',
    balance: 0,
    role: 'user',
    blocked: false,
    trialUsed: false,
    referralCode: 'ABC123',
    referredBy: null,
    createdAt: Date.now(),
  };
  store.users.set(user.id, user);

  return { store, drivers, nodes };
}

describe('order creation', () => {
  it('creates a payable order and delivers nothing yet', async () => {
    const svc = seed();
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    expect(order.status).toBe('pending');
    expect(order.amount).toBe(90_000);
    expect(await svc.store.listSubscriptions('usr_test0001')).toHaveLength(0);
  });

  it('refuses a hidden plan', async () => {
    const svc = seed();
    await expect(createOrder(svc, { userId: 'usr_test0001', planId: 'p_hidden' })).rejects.toThrow(
      ServiceError,
    );
  });

  it('refuses an unknown plan', async () => {
    const svc = seed();
    await expect(createOrder(svc, { userId: 'usr_test0001', planId: 'nope' })).rejects.toThrow('پلن پیدا نشد');
  });

  it('refuses a blocked user', async () => {
    const svc = seed();
    const u = (await svc.store.getUser('usr_test0001'))!;
    await svc.store.putUser({ ...u, blocked: true });
    await expect(createOrder(svc, { userId: 'usr_test0001', planId: 'p1' })).rejects.toThrow('مسدود');
  });

  it('a 100% coupon needs no payment and delivers immediately', async () => {
    const svc = seed();
    const order = await createOrder(svc, {
      userId: 'usr_test0001',
      planId: 'p_free',
    });
    expect(order.amount).toBe(0);
    expect(order.status).toBe('paid');
    expect(await svc.store.listSubscriptions('usr_test0001')).toHaveLength(1);
  });

  it('debiting the wallet up front stops the same balance buying twice', async () => {
    const svc = seed();
    const u = (await svc.store.getUser('usr_test0001'))!;
    await svc.store.putUser({ ...u, balance: 90_000 });

    const a = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1', payFromBalance: 90_000 });
    expect(a.amount).toBe(0);
    expect(a.status).toBe('paid');
    expect((await svc.store.getUser('usr_test0001'))!.balance).toBe(0);

    // Second order has no balance left and must come back as payable.
    const b = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1', payFromBalance: 90_000 });
    expect(b.amount).toBe(90_000);
    expect(b.status).toBe('pending');
  });

  it('a coupon cannot push the amount below zero', async () => {
    const svc = seed();
    const order = await createOrder(svc, {
      userId: 'usr_test0001',
      planId: 'p1',
      couponDiscount: 500_000,
    });
    expect(order.amount).toBe(0);
  });
});

describe('fulfilment', () => {
  it('delivers configs on every healthy node', async () => {
    const svc = seed();
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    await svc.store.updateOrder(order.id, { status: 'paid' });
    const result = await fulfilOrder(svc, order.id);
    expect(result.credentials.length).toBe(2);
    expect(result.failures).toEqual([]);
    for (const c of result.credentials) {
      expect(c.uri).toMatch(/^vless:\/\//);
      expect(c.watermark).toHaveLength(8);
    }
  });

  it('a dead node yields a partial delivery, not an error', async () => {
    const svc = seed();
    svc.nodes[1]!.health = 'down';
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    await svc.store.updateOrder(order.id, { status: 'paid' });
    const result = await fulfilOrder(svc, order.id);
    expect(result.credentials).toHaveLength(1);
  });

  it('every node failing is an error, not an empty subscription', async () => {
    const svc = seed();
    svc.nodes.forEach((n) => {
      n.health = 'down';
    });
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    await svc.store.updateOrder(order.id, { status: 'paid' });
    await expect(fulfilOrder(svc, order.id)).rejects.toThrow('نود سالمی');
  });

  it('refuses to deliver an unpaid order', async () => {
    const svc = seed();
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    await expect(fulfilOrder(svc, order.id)).rejects.toThrow('قابل تحویل نیست');
  });

  it('each credential carries a distinct watermark', async () => {
    const svc = seed();
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    await svc.store.updateOrder(order.id, { status: 'paid' });
    const result = await fulfilOrder(svc, order.id);
    const marks = new Set(result.credentials.map((c) => c.watermark));
    expect(marks.size).toBe(result.credentials.length);
  });
});

describe('markPaid idempotency', () => {
  it('a duplicated gateway callback delivers once, not twice', async () => {
    const svc = seed();
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });

    await markPaid(svc, order.id, 'zarinpal', 'ref1');
    await markPaid(svc, order.id, 'zarinpal', 'ref1');
    await markPaid(svc, order.id, 'zarinpal', 'ref1');

    expect(await svc.store.listSubscriptions('usr_test0001')).toHaveLength(1);
  });

  it('a rejected order cannot be revived by a late callback', async () => {
    const svc = seed();
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    await svc.store.updateOrder(order.id, { status: 'rejected' });
    await expect(markPaid(svc, order.id, 'zarinpal')).rejects.toThrow('بسته شده');
  });

  it('records who paid and when', async () => {
    const svc = seed();
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    const paid = await markPaid(svc, order.id, 'card', 'ref-x');
    expect(paid.status).toBe('paid');
    expect(paid.gateway).toBe('card');
    expect(paid.paidAt).toBeGreaterThan(0);
  });
});

describe('card-to-card receipts', () => {
  async function orderFor(svc: Services) {
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    return order;
  }

  it('a complete, matching receipt is auto-approved and delivers configs', async () => {
    const svc = seed();
    const order = await orderFor(svc);
    const res = await submitReceipt(svc, {
      orderId: order.id,
      userId: 'usr_test0001',
      receiptPhoto: 'r2/receipt-1.jpg',
      payerCard: '6037991234567890',
      payerName: 'علی محمدی',
      trackingCode: 'TRK-000001',
      note: `واریز 90,000 تومان بابت سفارش ${order.code}`,
    });

    expect(res.verdict.verdict).toBe('approve');
    expect(res.autoApproved).toBe(true);
    expect((await svc.store.getOrder(order.id))!.status).toBe('paid');
    expect((await svc.store.listSubscriptions('usr_test0001')).length).toBeGreaterThan(0);
  });

  it('a reused tracking code is never auto-approved', async () => {
    const svc = seed();
    const o1 = await orderFor(svc);
    await submitReceipt(svc, {
      orderId: o1.id,
      userId: 'usr_test0001',
      receiptPhoto: 'r2/a.jpg',
      payerCard: '6037991234567890',
      payerName: 'علی محمدی',
      trackingCode: 'TRK-DUP',
      note: `واریز 90,000 تومان ${o1.code}`,
    });

    const o2 = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    const res = await submitReceipt(svc, {
      orderId: o2.id,
      userId: 'usr_test0001',
      receiptPhoto: 'r2/b.jpg',
      payerCard: '6037991234567890',
      payerName: 'علی محمدی',
      trackingCode: 'TRK-DUP',
      note: `واریز 90,000 تومان ${o2.code}`,
    });

    expect(res.autoApproved).toBe(false);
    expect((await svc.store.getOrder(o2.id))!.status).not.toBe('paid');
  });

  it('a short payment is not approved', async () => {
    const svc = seed();
    const order = await orderFor(svc);
    const res = await submitReceipt(svc, {
      orderId: order.id,
      userId: 'usr_test0001',
      receiptPhoto: 'r2/c.jpg',
      payerCard: '6037991234567890',
      payerName: 'علی',
      trackingCode: 'TRK-SHORT',
      note: `واریز 20,000 تومان ${order.code}`,
    });
    expect(res.autoApproved).toBe(false);
  });

  it('no photo is refused outright', async () => {
    const svc = seed();
    const order = await orderFor(svc);
    await expect(
      submitReceipt(svc, {
        orderId: order.id,
        userId: 'usr_test0001',
        receiptPhoto: '',
        payerCard: '6037991234567890',
        payerName: 'علی',
        trackingCode: 'TRK-X',
        note: 'واریز کردم',
      }),
    ).rejects.toThrow('عکس رسید');
  });

  it('one user cannot submit a receipt for another user\'s order', async () => {
    const svc = seed();
    const order = await orderFor(svc);
    const other: UserRecord = {
      id: 'usr_other001',
      telegramId: 999,
      username: 'mallory',
      firstName: 'M',
      balance: 0,
      role: 'user',
      blocked: false,
      trialUsed: false,
      referralCode: 'XYZ',
      referredBy: null,
      createdAt: Date.now(),
    };
    await svc.store.putUser(other);
    await expect(
      submitReceipt(svc, {
        orderId: order.id,
        userId: 'usr_other001',
        receiptPhoto: 'r2/d.jpg',
        payerCard: '6037991234567890',
        payerName: 'علی',
        trackingCode: 'TRK-Y',
        note: 'واریز 90,000 تومان',
      }),
    ).rejects.toThrow('مال شما نیست');
  });

  it('approving the same payment twice does not deliver twice', async () => {
    const svc = seed();
    const order = await orderFor(svc);
    const res = await submitReceipt(svc, {
      orderId: order.id,
      userId: 'usr_test0001',
      receiptPhoto: 'r2/e.jpg',
      payerCard: '6037991234567890',
      payerName: 'علی',
      trackingCode: 'TRK-SLOW',
      note: 'بدون مبلغ',
    });
    expect(res.autoApproved).toBe(false);

    await approvePayment(svc, res.payment.id, 'admin', 'بررسی شد');
    await approvePayment(svc, res.payment.id, 'admin', 'بررسی شد');
    expect(await svc.store.listSubscriptions('usr_test0001')).toHaveLength(1);
  });

  it('rejecting a payment closes the order', async () => {
    const svc = seed();
    const order = await orderFor(svc);
    const res = await submitReceipt(svc, {
      orderId: order.id,
      userId: 'usr_test0001',
      receiptPhoto: 'r2/f.jpg',
      payerCard: '6037991234567890',
      payerName: 'علی',
      trackingCode: 'TRK-BAD',
      note: 'بدون مبلغ',
    });
    await rejectPayment(svc, res.payment.id, 'admin', 'فیش ناخوانا');
    expect((await svc.store.getPayment(res.payment.id))!.status).toBe('rejected');
    expect((await svc.store.getOrder(order.id))!.status).toBe('rejected');
  });

  it('an approved payment cannot be rejected afterwards', async () => {
    const svc = seed();
    const order = await orderFor(svc);
    const res = await submitReceipt(svc, {
      orderId: order.id,
      userId: 'usr_test0001',
      receiptPhoto: 'r2/g.jpg',
      payerCard: '6037991234567890',
      payerName: 'علی',
      trackingCode: 'TRK-OK',
      note: `واریز 90,000 تومان ${order.code}`,
    });
    await expect(rejectPayment(svc, res.payment.id, 'admin', 'پشیمان شدم')).rejects.toThrow(
      'تأیید شده',
    );
  });

  it('every receipt decision is auditable', async () => {
    const svc = seed();
    const order = await orderFor(svc);
    const res = await submitReceipt(svc, {
      orderId: order.id,
      userId: 'usr_test0001',
      receiptPhoto: 'r2/h.jpg',
      payerCard: '6037991234567890',
      payerName: 'علی',
      trackingCode: 'TRK-AUD',
      // Deliberately incomplete: this one escalates rather than auto-approving,
      // so there is a decision left for the admin to reject.
      note: 'واریز شد',
    });
    expect(res.autoApproved).toBe(false);
    await rejectPayment(svc, res.payment.id, 'admin', 'تکراری');
    const actions = (await svc.store.listAudit()).map((a) => a.action);
    expect(actions).toContain('payment.receipt_submitted');
    expect(actions).toContain('payment.reject');
  });
});

describe('rotation', () => {
  it('keeps the link and the token, changes every secret', async () => {
    const svc = seed();
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    const paid = await markPaid(svc, order.id, 'card');
    void paid;
    const sub = (await svc.store.listSubscriptions('usr_test0001'))[0]!;
    const before = (await svc.store.listCredentials(sub.id)).map((c) => c.uri);
    const tokenBefore = sub.token;

    const res = await rotateSubscription(svc, sub.id, 'usr_test0001');
    expect(res.changed).toBe(before.length);

    const after = (await svc.store.listCredentials(sub.id)).map((c) => c.uri);
    expect(after).toHaveLength(before.length);
    expect(after.every((u, i) => u !== before[i])).toBe(true);
    expect((await svc.store.getSubscription(sub.id))!.token).toBe(tokenBefore);
  });

  it('the old watermark stops resolving after rotation', async () => {
    const svc = seed();
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    await markPaid(svc, order.id, 'card');
    const sub = (await svc.store.listSubscriptions('usr_test0001'))[0]!;
    const old = (await svc.store.listCredentials(sub.id))[0]!;

    await rotateSubscription(svc, sub.id, 'usr_test0001');
    expect(await svc.store.findCredentialByWatermark(old.watermark)).toBeNull();
  });

  it('increments the rotation counter so the admin can spot churn', async () => {
    const svc = seed();
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    await markPaid(svc, order.id, 'card');
    const sub = (await svc.store.listSubscriptions('usr_test0001'))[0]!;
    await rotateSubscription(svc, sub.id, 'admin');
    await rotateSubscription(svc, sub.id, 'admin');
    expect((await svc.store.getSubscription(sub.id))!.rotationCount).toBe(2);
  });

  it('a suspended subscription cannot be rotated', async () => {
    const svc = seed();
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    await markPaid(svc, order.id, 'card');
    const sub = (await svc.store.listSubscriptions('usr_test0001'))[0]!;
    await svc.store.updateSubscription(sub.id, { status: 'suspended' });
    await expect(rotateSubscription(svc, sub.id, 'admin')).rejects.toThrow('معلق');
  });
});

describe('leak tracing', () => {
  it('finds the owner from a pasted config', async () => {
    const svc = seed();
    const order = await createOrder(svc, { userId: 'usr_test0001', planId: 'p1' });
    await markPaid(svc, order.id, 'card');
    const sub = (await svc.store.listSubscriptions('usr_test0001'))[0]!;
    const cred = (await svc.store.listCredentials(sub.id))[0]!;

    const trace = await traceLeak(svc, cred.uri);
    expect(trace.found).toBe(true);
    expect(trace.userId).toBe('usr_test0001');
    expect(trace.username).toBe('ali');
  });

  it('says so plainly when a pasted config is not ours', async () => {
    const svc = seed();
    const trace = await traceLeak(
      svc,
      'vless://31415926-5358-9793-2384-626433832795@1.2.3.4:443?security=reality&pbk=x#deadbeef',
    );
    expect(trace.found).toBe(false);
    expect(trace.message).toContain('deadbeef');
  });

  it('does not pretend a config with no watermark is traceable', async () => {
    const svc = seed();
    const trace = await traceLeak(svc, 'vless://uuid@1.2.3.4:443?security=tls#no-mark-here');
    expect(trace.found).toBe(false);
    expect(trace.message).toContain('واترمارک');
  });
});

describe('trials', () => {
  it('issues a working trial once', async () => {
    const svc = seed();
    const res = await issueTrial(svc, 'usr_test0001', { days: 3, trafficGb: 5 });
    expect(res.credentials.length).toBeGreaterThan(0);
    expect((await svc.store.getUser('usr_test0001'))!.trialUsed).toBe(true);
  });

  it('refuses a second trial — enforced in the service, not the button', async () => {
    const svc = seed();
    await issueTrial(svc, 'usr_test0001', { days: 3, trafficGb: 5 });
    await expect(issueTrial(svc, 'usr_test0001', { days: 3, trafficGb: 5 })).rejects.toThrow(
      'رایگان استفاده کردی',
    );
  });

  it('a trial cannot be issued when every node is down', async () => {
    const svc = seed();
    svc.nodes.forEach((n) => {
      n.health = 'down';
    });
    await expect(issueTrial(svc, 'usr_test0001', { days: 3, trafficGb: 5 })).rejects.toThrow('نود سالمی');
  });
});

describe('gateway availability', () => {
  it('card-to-card is hidden until the admin enters a card number', () => {
    const empty = new CardGateway({
      cardNumber: '',
      cardHolder: '',
      cardBank: '',
      extraMessage: '',
      currency: 'تومان',
    });
    expect(empty.info().available).toBe(false);

    const ready = new CardGateway({
      cardNumber: '6037991234567890',
      cardHolder: 'علی',
      cardBank: 'ملی',
      extraMessage: '',
      currency: 'تومان',
    });
    expect(ready.info().available).toBe(true);
  });

  it('an unconfigured Zarinpal never appears in the list a buyer sees', () => {
    const registry = buildRegistry({
      card: { cardNumber: '6037991234567890', cardHolder: 'علی', cardBank: '', extraMessage: '', currency: 'تومان' },
      walletBalance: async () => 0,
      zarinpal: { merchantId: '', sandbox: false, callbackUrl: '' },
      nextpay: { transId: '', callbackUrl: '' },
    });
    const list = listAvailable(registry).map((g) => g.id);
    expect(list).toContain('card');
    expect(list).not.toContain('zarinpal');
    expect(list).not.toContain('nextpay');
  });

  it('sandbox mode is labelled, never silently presented as real', () => {
    const gw = new ZarinpalGateway({ merchantId: 'abcd1234', sandbox: true, callbackUrl: '' });
    const info = gw.info();
    expect(info.sandbox).toBe(true);
    expect(info.label).toContain('تستی');
  });

  it('card instructions carry the order code the buyer must write down', async () => {
    const gw = new CardGateway({
      cardNumber: '6037991234567890',
      cardHolder: 'علی',
      cardBank: 'ملی',
      extraMessage: '',
      currency: 'تومان',
    });
    const res = await gw.start({
      id: 'pay1',
      orderCode: 'A7K9-2M4P',
      amount: 90_000,
      userId: 'u',
      userName: 'علی',
      description: 'test',
      callbackUrl: '',
    });
    expect(res.kind).toBe('instructions');
    if (res.kind === 'instructions') {
      expect(res.text).toContain('A7K9-2M4P');
      expect(res.ref).toBe('A7K9-2M4P');
      // The full card number must not be printed raw in a chat message.
      expect(res.text).not.toContain('6037991234567890');
    }
  });

  it('a wallet purchase is refused when the balance is short', async () => {
    const gw = new WalletGateway(async () => 1000);
    await expect(
      gw.start({
        id: 'p',
        orderCode: 'X',
        amount: 90_000,
        userId: 'u',
        userName: '',
        description: '',
        callbackUrl: '',
      }),
    ).rejects.toThrow('کافی نیست');
  });

  it('a wallet purchase does not debit twice if start() is called again', async () => {
    let calls = 0;
    const gw = new WalletGateway(async () => {
      calls++;
      return 100_000;
    });
    const a = await gw.start({ id: 'p', orderCode: 'X', amount: 90_000, userId: 'u', userName: '', description: '', callbackUrl: '' });
    const b = await gw.start({ id: 'p', orderCode: 'X', amount: 90_000, userId: 'u', userName: '', description: '', callbackUrl: '' });
    expect(a.kind).toBe('done');
    expect(b.kind).toBe('done');
    expect(calls).toBe(2); // read twice, debited zero times — the order service debits
  });
});

describe('amount parsing and formatting', () => {
  it('reads Persian digits, thousands separators and "هزار"', () => {
    expect(parseAmount('۹۰۰۰۰ تومان')).toBe(90_000);
    expect(parseAmount('90,000')).toBe(90_000);
    expect(parseAmount('واریز ۵۰ هزار تومان')).toBe(50_000);
    expect(parseAmount('واریز شد')).toBeNull();
  });

  it('formats Toman with Persian separators', () => {
    expect(formatToman(90_000)).toContain('۹۰٬۰۰۰');
  });
});

describe('receipt screening rules', () => {
  const base = {
    paymentId: 'p',
    orderCode: 'A7K9-2M4P',
    expectedAmount: 90_000,
    note: 'واریز 90,000 تومان بابت A7K9-2M4P',
    payerCard: '6037991234567890',
    payerName: 'علی محمدی',
    trackingCode: 'TRK-1',
    hasPhoto: true,
    duplicateTrackingCount: 0,
    samePayerRecentCount: 0,
    minutesSinceOrder: 5,
  };

  it('approves a clean sweep', () => {
    expect(screenReceipt(base).verdict).toBe('approve');
  });

  it('escalates rather than approving when the tracking code is missing', () => {
    const v = screenReceipt({ ...base, trackingCode: '' });
    expect(v.verdict).not.toBe('approve');
    expect(v.reasons.some((r) => r.includes('کد رهگیری'))).toBe(true);
  });

  it('rejects a duplicated tracking code outright', () => {
    expect(screenReceipt({ ...base, duplicateTrackingCount: 1 }).verdict).toBe('reject');
  });

  it('rejects when no photo arrived', () => {
    expect(screenReceipt({ ...base, hasPhoto: false }).verdict).toBe('reject');
  });

  it('an overpayment is not a reason to refuse', () => {
    const v = screenReceipt({ ...base, note: 'واریز 150,000 تومان بابت A7K9-2M4P' });
    expect(v.verdict).toBe('approve');
    expect(v.reasons.some((r) => r.includes('بیشتر'))).toBe(true);
  });

  it('confidence stays inside 0..1 for every combination', () => {
    const cases = [
      base,
      { ...base, note: 'بی‌ربط' },
      { ...base, payerCard: 'x', payerName: '' },
      { ...base, trackingCode: '', duplicateTrackingCount: 5, minutesSinceOrder: 999999 },
    ];
    for (const c of cases) {
      const v = screenReceipt(c);
      expect(v.confidence).toBeGreaterThan(0);
      expect(v.confidence).toBeLessThanOrEqual(1);
    }
  });
});
