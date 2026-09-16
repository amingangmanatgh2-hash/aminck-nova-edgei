import { describe, expect, it } from 'vitest';
import { decideDiscount, profileDemand, priceCatalogue } from '../src/shop/pricing';
import { extractJson, maskCard, reviewReceipt, zarinpalAvailable, card2cardAvailable } from '../src/shop/payments';
import { CATALOG, catalogToProducts } from '../src/shop/catalog';
import { ECONOMY } from '../src/config';
import type { PriceEvent } from '../src/shop/pricing';

const ev = (productId: string, hour: number, imp: number, conv: number): PriceEvent => ({
  productId,
  hourOfDay: hour,
  dayOfWeek: 3,
  impressions: imp,
  conversions: conv,
  revenueUsd: conv * 100,
});

describe('pricing engine', () => {
  it('gives NO discount when there is no data (cold start)', () => {
    const d = decideDiscount('p1', 1000, undefined);
    expect(d.pct).toBe(0);
    expect(d.finalUsd).toBe(1000);
    expect(d.rationale).toContain('no purchase data');
  });

  it('does not discount on thin data even if some exists', () => {
    const profiles = profileDemand([ev('p1', 12, 20, 0)]);
    const d = decideDiscount('p1', 1000, profiles.get('p1'));
    expect(d.pct).toBe(0);
    expect(d.rationale).toContain('not enough data');
  });

  it('does not discount a product that already converts well', () => {
    const profiles = profileDemand([ev('p1', 12, 1000, 80)]); // 8% conversion
    const d = decideDiscount('p1', 1000, profiles.get('p1'));
    expect(d.pct).toBe(0);
    expect(d.finalUsd).toBe(1000);
    expect(d.rationale).toContain('meets or exceeds');
  });

  it('discounts a product that converts badly', () => {
    const profiles = profileDemand([ev('p1', 12, 1000, 3)]); // 0.3%
    const d = decideDiscount('p1', 1000, profiles.get('p1'));
    expect(d.pct).toBeGreaterThan(10);
    expect(d.finalUsd).toBeLessThan(1000);
  });

  it('never exceeds the 30% cap', () => {
    const profiles = profileDemand([ev('p1', 12, 100_000, 0)]);
    const d = decideDiscount('p1', 1000, profiles.get('p1'));
    expect(d.pct).toBeLessThanOrEqual(ECONOMY.maxDiscountPct);
    expect(d.finalUsd).toBeGreaterThanOrEqual(700);
  });

  it('refuses to be asked for more than the cap', () => {
    const profiles = profileDemand([ev('p1', 12, 100_000, 0)]);
    const d = decideDiscount('p1', 1000, profiles.get('p1'), { maxPct: 95 });
    expect(d.pct).toBeLessThanOrEqual(30);
  });

  it('adds a time-of-day uplift only in the weak window', () => {
    const events = [
      ev('p1', 3, 1000, 0), // 03:00 converts terribly
      ev('p1', 20, 1000, 60), // 20:00 converts well
    ];
    const profiles = profileDemand(events);
    const inWeakHour = decideDiscount('p1', 1000, profiles.get('p1'), { hourOfDay: 3 });
    const inStrongHour = decideDiscount('p1', 1000, profiles.get('p1'), { hourOfDay: 20 });
    expect(inWeakHour.pct).toBeGreaterThanOrEqual(inStrongHour.pct);
  });

  it('is deterministic for the same input (never random)', () => {
    const profiles = profileDemand([ev('p1', 12, 1000, 5)]);
    const a = decideDiscount('p1', 1000, profiles.get('p1'), { hourOfDay: 12 });
    const b = decideDiscount('p1', 1000, profiles.get('p1'), { hourOfDay: 12 });
    expect(a.pct).toBe(b.pct);
    expect(a.finalUsd).toBe(b.finalUsd);
  });

  it('ignores hours with too little traffic to judge', () => {
    const profiles = profileDemand([ev('p1', 3, 5, 0), ev('p1', 12, 2000, 20)]);
    const p = profiles.get('p1')!;
    // The 5-impression hour must not become "worstHour".
    expect(p.worstHour).not.toBe(3);
  });

  it('prices a whole catalogue in one pass', () => {
    const items = catalogToProducts().map((p) => ({ productId: p.id, baseUsd: p.baseUsd }));
    const priced = priceCatalogue(items, [ev(items[0]!.productId, 12, 1000, 1)]);
    expect(priced.size).toBe(items.length);
    for (const d of priced.values()) {
      expect(d.pct).toBeLessThanOrEqual(30);
      expect(d.finalUsd).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('receipt review', () => {
  const png = (n: number): ArrayBuffer => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = i % 251;
    return b.buffer;
  };

  it('rejects a duplicate image hash before spending an AI call', async () => {
    const v = await reviewReceipt({
      bytes: png(20_000),
      contentType: 'image/png',
      claimedAmountUsd: 500,
      existingHashes: [await sha(png(20_000))],
    });
    expect(v.duplicate).toBe(true);
    expect(v.autoApprove).toBe(false);
    expect(v.reasons.join()).toContain('identical receipt');
  });

  it('rejects a suspiciously small upload', async () => {
    const v = await reviewReceipt({
      bytes: png(1000),
      contentType: 'image/png',
      claimedAmountUsd: 500,
      existingHashes: [],
    });
    expect(v.autoApprove).toBe(false);
    expect(v.reasons.join()).toContain('suspiciously small');
  });

  it('rejects a non-image content type', async () => {
    const v = await reviewReceipt({
      bytes: png(20_000),
      contentType: 'application/pdf',
      claimedAmountUsd: 500,
      existingHashes: [],
    });
    expect(v.autoApprove).toBe(false);
  });

  it('requires manual review when AI is not configured', async () => {
    const v = await reviewReceipt({
      bytes: png(20_000),
      contentType: 'image/png',
      claimedAmountUsd: 500,
      existingHashes: [],
    });
    expect(v.autoApprove).toBe(false);
    expect(v.reasons.join()).toContain('AI review not configured');
  });

  it('NEVER auto-approves when the AI reports tampering', async () => {
    const v = await reviewReceipt({
      bytes: png(20_000),
      contentType: 'image/png',
      claimedAmountUsd: 500,
      existingHashes: [],
      ai: {
        run: async () =>
          JSON.stringify({
            readable: true, tampered: true, amountVisible: true, dateVisible: true,
            trackingVisible: true, confidence: 0.99,
          }),
      },
    });
    expect(v.tampered).toBe(true);
    expect(v.autoApprove).toBe(false);
  });

  it('auto-approves only when every field is present and confidence is high', async () => {
    const v = await reviewReceipt({
      bytes: png(20_000),
      contentType: 'image/png',
      claimedAmountUsd: 500,
      existingHashes: [],
      ai: {
        run: async () =>
          JSON.stringify({
            readable: true, tampered: false, amountVisible: true, dateVisible: true,
            trackingVisible: true, confidence: 0.95,
          }),
      },
    });
    expect(v.autoApprove).toBe(true);
  });

  it('withholds auto-approval when a required field is missing', async () => {
    const v = await reviewReceipt({
      bytes: png(20_000),
      contentType: 'image/png',
      claimedAmountUsd: 500,
      existingHashes: [],
      ai: {
        run: async () =>
          JSON.stringify({
            readable: true, tampered: false, amountVisible: true, dateVisible: false,
            trackingVisible: true, confidence: 0.99,
          }),
      },
    });
    expect(v.autoApprove).toBe(false);
    expect(v.reasons.join()).toContain('date not visible');
  });

  it('survives an AI that throws', async () => {
    const v = await reviewReceipt({
      bytes: png(20_000),
      contentType: 'image/png',
      claimedAmountUsd: 500,
      existingHashes: [],
      ai: { run: async () => { throw new Error('model timeout'); } },
    });
    expect(v.autoApprove).toBe(false);
    expect(v.reasons.join()).toContain('AI review failed');
  });

  it('parses JSON the model wrapped in prose or fences', () => {
    expect(extractJson('sure! ```json\n{"a":1}\n``` hope that helps')).toEqual({ a: 1 });
    expect(extractJson('{"a":2}')).toEqual({ a: 2 });
    expect(extractJson('no json here')).toEqual({});
  });
});

async function sha(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('gateway availability is honest', () => {
  it('reports Zarinpal unavailable without a merchant id', () => {
    expect(zarinpalAvailable({ merchantId: null, enabled: true, callbackBase: '' })).toBe(false);
    expect(zarinpalAvailable({ merchantId: 'abc', enabled: true, callbackBase: '' })).toBe(false);
    expect(zarinpalAvailable({ merchantId: 'abcd1234efgh', enabled: false, callbackBase: '' })).toBe(false);
    expect(zarinpalAvailable({ merchantId: 'abcd1234efgh', enabled: true, callbackBase: '' })).toBe(true);
  });
  it('reports card2card unavailable without a card number', () => {
    expect(card2cardAvailable({ enabled: true, cardNumber: null, cardHolder: null })).toBe(false);
    expect(card2cardAvailable({ enabled: true, cardNumber: '1234', cardHolder: 'x' })).toBe(false);
    expect(card2cardAvailable({ enabled: false, cardNumber: '6037991234567890', cardHolder: 'x' })).toBe(false);
    expect(card2cardAvailable({ enabled: true, cardNumber: '6037-9912-3456-7890', cardHolder: 'x' })).toBe(true);
  });
  it('masks card numbers, keeping only the BIN and last four', () => {
    expect(maskCard('6037991234567890')).toBe('603799******7890');
    expect(maskCard(null)).toBe('');
  });
});

describe('catalogue integrity', () => {
  it('has unique SKUs', () => {
    const skus = CATALOG.map((c) => c.sku);
    expect(new Set(skus).size).toBe(skus.length);
  });
  it('gives every PURCHASABLE rank a positive price (free tier is $0)', () => {
    for (const c of CATALOG.filter((x) => x.kind === 'rank' && x.sku !== 'rank-free')) {
      expect(c.priceUsd, c.sku).toBeGreaterThan(0);
    }
    expect(CATALOG.find((c) => c.sku === 'rank-free')!.priceUsd).toBe(0);
  });
  it('keeps prices modest (nothing above $20)', () => {
    for (const c of CATALOG) expect(c.priceUsd, c.sku).toBeLessThanOrEqual(2000);
  });
  it('gates cosmetics behind OTP but leaves free ranks visible', () => {
    const prods = catalogToProducts();
    expect(prods.filter((p) => p.kind === 'cosmetic').every((p) => !p.visibleBeforeAuth)).toBe(true);
    expect(prods.some((p) => p.sku === 'rank-free' && p.visibleBeforeAuth)).toBe(true);
  });
});
