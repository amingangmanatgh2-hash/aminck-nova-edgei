/**
 * Dynamic pricing engine.
 *
 * The brief was: give discounts up to 30% based on real purchase behaviour,
 * decided from data rather than at random. This is that engine, and it is
 * deliberately boring and auditable — every discount carries the numbers that
 * produced it, so an admin can see WHY a price moved.
 *
 * Design constraints:
 *   - discount is capped at ECONOMY.maxDiscountPct (30)
 *   - a product never drops below 60% of its base price
 *   - a product with no data gets NO discount (cold start is not a reason to
 *     give money away)
 *   - the discount is a smooth function of observed conversion, never a
 *     random draw, so the same data always yields the same price
 */
import { ECONOMY } from '../config';
import { mean } from '../utils';

export interface PriceEvent {
  productId: string;
  hourOfDay: number;
  dayOfWeek: number;
  impressions: number;
  conversions: number;
  revenueUsd: number;
}

export interface DiscountDecision {
  productId: string;
  pct: number;
  baseUsd: number;
  finalUsd: number;
  rationale: string;
  factors: Record<string, number>;
}

/** Aggregated demand signal for one product. */
export interface DemandProfile {
  productId: string;
  impressions: number;
  conversions: number;
  conversionRate: number;
  revenueUsd: number;
  /** Hour with the best conversion rate. */
  bestHour: number | null;
  /** Hour with the worst conversion rate. */
  worstHour: number | null;
  /** Conversion rate in the best hour vs the product average. */
  peakLift: number;
  hourlyRates: number[];
}

export function profileDemand(events: PriceEvent[]): Map<string, DemandProfile> {
  const byProduct = new Map<string, PriceEvent[]>();
  for (const e of events) {
    const arr = byProduct.get(e.productId) ?? [];
    arr.push(e);
    byProduct.set(e.productId, arr);
  }

  const out = new Map<string, DemandProfile>();
  for (const [productId, evs] of byProduct) {
    const impressions = evs.reduce((a, e) => a + e.impressions, 0);
    const conversions = evs.reduce((a, e) => a + e.conversions, 0);
    const revenueUsd = evs.reduce((a, e) => a + e.revenueUsd, 0);

    // Aggregate by hour of day.
    const hourly = new Map<number, { imp: number; conv: number }>();
    for (const e of evs) {
      const h = hourly.get(e.hourOfDay) ?? { imp: 0, conv: 0 };
      h.imp += e.impressions;
      h.conv += e.conversions;
      hourly.set(e.hourOfDay, h);
    }
    const hourlyRates: number[] = [];
    let bestHour: number | null = null;
    let worstHour: number | null = null;
    let bestRate = -1;
    let worstRate = 2;
    for (const [hour, h] of hourly) {
      if (h.imp < 10) continue; // not enough traffic to say anything
      const r = h.conv / h.imp;
      hourlyRates.push(r);
      if (r > bestRate) {
        bestRate = r;
        bestHour = hour;
      }
      if (r < worstRate) {
        worstRate = r;
        worstHour = hour;
      }
    }

    const conversionRate = impressions > 0 ? conversions / impressions : 0;
    const avgHourly = mean(hourlyRates);
    const peakLift = avgHourly > 0 && bestRate >= 0 ? bestRate / avgHourly : 1;

    out.set(productId, {
      productId,
      impressions,
      conversions,
      conversionRate,
      revenueUsd,
      bestHour,
      worstHour,
      peakLift,
      hourlyRates,
    });
  }
  return out;
}

/**
 * Decide the discount for a product.
 *
 * Reasoning, in order of weight:
 *   1. LOW conversion with real traffic => the price is the likely blocker, so
 *      discount. This is the main lever.
 *   2. Time-of-day: inside the product's weakest hour, add a small uplift to
 *      the discount to pull demand into the quiet window.
 *   3. HIGH conversion => do not discount. The product sells itself; giving
 *      money away would be pure margin loss.
 */
export function decideDiscount(
  productId: string,
  baseUsd: number,
  profile: DemandProfile | undefined,
  opts: { hourOfDay?: number; maxPct?: number } = {},
): DiscountDecision {
  const maxPct = Math.min(opts.maxPct ?? ECONOMY.maxDiscountPct, ECONOMY.maxDiscountPct);
  const factors: Record<string, number> = {};

  // Cold start: no data means no discount. Never give margin away on a guess.
  if (!profile || profile.impressions < 50) {
    return {
      productId,
      pct: 0,
      baseUsd,
      finalUsd: baseUsd,
      rationale:
        profile && profile.impressions > 0
          ? `only ${profile.impressions} impressions (< 50) - not enough data to discount`
          : 'no purchase data yet - holding list price',
      factors: { impressions: profile?.impressions ?? 0 },
    };
  }

  factors.impressions = profile.impressions;
  factors.conversionRate = +profile.conversionRate.toFixed(4);

  // --- 1. conversion-based lever -----------------------------------------
  // 5%+ conversion is healthy for a game storefront; below 1% is struggling.
  const TARGET = 0.03;
  let pct = 0;
  if (profile.conversionRate < TARGET) {
    // Shortfall ratio, scaled. 0% conversion => full 0.7 of the cap.
    const shortfall = 1 - profile.conversionRate / TARGET;
    pct = shortfall * 0.7 * maxPct;
    factors.conversionShortfall = +shortfall.toFixed(3);
  }

  // --- 2. time-of-day lever -----------------------------------------------
  if (opts.hourOfDay != null && profile.worstHour != null && profile.hourlyRates.length >= 3) {
    const distance = Math.abs(opts.hourOfDay - profile.worstHour);
    const nearWorst = distance <= 1 || distance >= 23;
    if (nearWorst && profile.peakLift > 1.3) {
      // Quiet window AND a meaningfully better window exists: nudge here.
      const uplift = Math.min((profile.peakLift - 1) / 2, 1) * 0.3 * maxPct;
      pct += uplift;
      factors.hourUplift = +uplift.toFixed(2);
      factors.worstHour = profile.worstHour;
      factors.bestHour = profile.bestHour ?? -1;
    }
  }

  // --- 3. margin floor -----------------------------------------------------
  pct = Math.max(0, Math.min(Math.round(pct), maxPct));
  // Never below 60% of list, whatever the model says.
  const hardFloorPct = 40;
  if (pct > hardFloorPct) {
    factors.floorApplied = hardFloorPct;
    pct = hardFloorPct;
  }

  const finalUsd = Math.max(0, Math.round(baseUsd * (1 - pct / 100)));

  const parts: string[] = [];
  if (pct === 0) {
    parts.push(
      `conversion ${(profile.conversionRate * 100).toFixed(2)}% meets or exceeds the ${TARGET * 100}% target - no discount needed`,
    );
  } else {
    parts.push(
      `conversion ${(profile.conversionRate * 100).toFixed(2)}% below the ${TARGET * 100}% target`,
    );
    if (factors.hourUplift) {
      parts.push(`hour ${opts.hourOfDay} is near the weakest window (best hour ${profile.bestHour})`);
    }
  }
  parts.push(`capped at ${maxPct}%`);

  return { productId, pct, baseUsd, finalUsd, rationale: parts.join('; '), factors };
}

/** Price a whole catalogue in one pass. */
export function priceCatalogue(
  items: { productId: string; baseUsd: number }[],
  events: PriceEvent[],
  opts: { hourOfDay?: number } = {},
): Map<string, DiscountDecision> {
  const profiles = profileDemand(events);
  const out = new Map<string, DiscountDecision>();
  for (const it of items) out.set(it.productId, decideDiscount(it.productId, it.baseUsd, profiles.get(it.productId), opts));
  return out;
}

/**
 * Record an impression/conversion. Called from the shop API and the cron job.
 * Kept in D1 (price_events) rather than KV because it is aggregated by SQL.
 */
export function recordEventSql(
  e: { productId: string; at: number; impression: boolean; conversion: boolean; revenueUsd: number },
): { sql: string; bind: unknown[] } {
  const d = new Date(e.at);
  return {
    sql: `INSERT INTO price_events (id, product_id, hour_of_day, day_of_week, conversions, impressions, revenue_usd)
          VALUES (?,?,?,?,?,?,?)`,
    bind: [
      `${e.productId}-${d.getUTCFullYear()}${d.getUTCMonth()}${d.getUTCDate()}${d.getUTCHours()}-${Math.random().toString(36).slice(2, 8)}`,
      e.productId,
      d.getUTCHours(),
      d.getUTCDay(),
      e.conversion ? 1 : 0,
      e.impression ? 1 : 0,
      e.revenueUsd,
    ],
  };
}
