/**
 * Product catalogue.
 *
 * Prices are in USD cents. They are deliberately modest: this is a community
 * game server, not a luxury storefront. Ranks are ALSO earnable through XP, so
 * nobody is locked out for not paying.
 */
import { ECONOMY, RANKS } from '../config';
import type { Product, ProductKind, RankId } from '../types';

export interface CatalogEntry {
  sku: string;
  kind: ProductKind;
  titleFa: string;
  titleEn: string;
  description: string;
  priceUsd: number;
  meta: Record<string, unknown>;
  /** Ranks and a few basics stay visible; cosmetics are gated behind OTP. */
  visibleBeforeAuth: boolean;
}

const rank = (id: RankId, desc: string): CatalogEntry => ({
  sku: `rank-${id}`,
  kind: 'rank',
  titleFa: `رنک ${RANKS[id]!.labelFa}`,
  titleEn: `${RANKS[id]!.labelEn} Rank`,
  description: desc,
  priceUsd: RANKS[id]!.priceUsd ?? 0,
  meta: { rank_id: id, tier: RANKS[id]!.tier, perks: RANKS[id]!.perks },
  visibleBeforeAuth: id === 'free',
});

const cosmetic = (
  slot: string,
  key: string,
  titleFa: string,
  titleEn: string,
  priceUsd: number,
  desc: string,
): CatalogEntry => ({
  sku: `cos-${key}`,
  kind: 'cosmetic',
  titleFa,
  titleEn,
  description: desc,
  priceUsd,
  meta: { slot, cosmetic_key: key },
  visibleBeforeAuth: false,
});

export const CATALOG: CatalogEntry[] = [
  // ------------------------------------------------------------------ ranks
  // The free tier is listed (not purchasable) so a visitor can see the whole
  // ladder before verifying their phone number.
  {
    sku: 'rank-free',
    kind: 'rank',
    titleFa: 'رنک رایگان',
    titleEn: 'Free Rank',
    description: 'دسترسی به لابی و همهٔ گیم‌مودها. همه از اینجا شروع می‌کنند.',
    priceUsd: 0,
    meta: { rank_id: 'free', tier: 0, perks: RANKS.free!.perks },
    visibleBeforeAuth: true,
  },
  rank('noob', '۲ خانه، چت رنگی، ساخت پارتی. با ۱۰۰۰ امتیاز هم رایگان به دست می‌آید.'),
  rank('normal', '۳ خانه، رنگ نیک‌نیم، صف اولویت‌دار. با ۵۰۰۰ امتیاز رایگان.'),
  rank('pro', '۵ خانه، افکت دنباله، ۵۰۰ جم ماهانه. با ۲۰۰۰۰ امتیاز رایگان.'),
  rank('god', '۱۰ خانه، افکت پرتال، پرواز در لابی، ۱۵۰۰ جم ماهانه. با ۶۰۰۰۰ امتیاز رایگان.'),
  rank('ultragod', '۲۰ خانه، پیام ورود اختصاصی، اسلات اختصاصی، ۴۰۰۰ جم ماهانه. با ۱۵۰۰۰۰ امتیاز رایگان.'),

  // ------------------------------------------------------------- cosmetics
  cosmetic('cape', 'cape-ender', 'کیپ اندر', 'Ender Cape', 149, 'کیپ بنفش با ذرات اندر'),
  cosmetic('cape', 'cape-god', 'کیپ گاد', 'God Cape', 299, 'کیپ طلایی متحرک، مخصوص رنک گاد به بالا'),
  cosmetic('cape', 'cape-void', 'کیپ وید', 'Void Cape', 199, 'کیپ سیاه با افکت کهکشان'),
  cosmetic('hat', 'hat-crown', 'تاج پادشاه', 'King Crown', 249, 'تاج طلایی با ذرات درخشان'),
  cosmetic('hat', 'hat-halo', 'هاله فرشته', 'Angel Halo', 179, 'هاله نور بالای سر'),
  cosmetic('hat', 'hat-horns', 'شاخ شیطان', 'Demon Horns', 179, 'شاخ قرمز با افکت دود'),
  cosmetic('hat', 'hat-dragon', 'کلاه اژدها', 'Dragon Helm', 349, 'کلاه اژدها با ذرات آتش'),
  cosmetic('trail', 'trail-rainbow', 'دنباله رنگین‌کمان', 'Rainbow Trail', 129, 'دنباله رنگی هنگام حرکت'),
  cosmetic('trail', 'trail-flame', 'دنباله آتش', 'Flame Trail', 149, 'دنباله آتش هنگام حرکت'),
  cosmetic('trail', 'trail-snow', 'دنباله برف', 'Snow Trail', 119, 'دنباله برف و یخ'),
  cosmetic('portal', 'portal-vortex', 'افکت پرتال گردباد', 'Vortex Portal', 199, 'افکت پرتال چرخشی بنفش'),
  cosmetic('portal', 'portal-lightning', 'افکت پرتال صاعقه', 'Lightning Portal', 229, 'افکت پرتال با جرقه برق'),
  cosmetic('nickcolour', 'nick-rainbow', 'نیک‌نیم رنگین‌کمانی', 'Rainbow Nickname', 99, 'نام کاربری با رنگ متحرک'),
  cosmetic('nickcolour', 'nick-gold', 'نیک‌نیم طلایی', 'Golden Nickname', 79, 'نام کاربری طلایی'),
  cosmetic('chattag', 'tag-vip', 'تگ چت VIP', 'VIP Chat Tag', 89, 'تگ [VIP] کنار نام در چت'),
  cosmetic('chattag', 'tag-mvp', 'تگ چت MVP', 'MVP Chat Tag', 129, 'تگ [MVP] متحرک کنار نام'),
  cosmetic('pet', 'pet-wolf', 'پت گرگ', 'Wolf Pet', 259, 'گرگ همراه با قلاده رنگی'),
  cosmetic('pet', 'pet-dragon', 'پت بچه‌اژدها', 'Baby Dragon Pet', 449, 'بچه‌اژدهای پرنده دنبال شما'),
  cosmetic('killfx', 'fx-lightning', 'افکت کیل صاعقه', 'Lightning Kill FX', 139, 'صاعقه روی قربانی هنگام کیل'),
  cosmetic('killfx', 'fx-explosion', 'افکت کیل انفجار', 'Explosion Kill FX', 159, 'انفجار ذرات هنگام کیل'),

  // --------------------------------------------------------------- bundles
  {
    sku: 'bundle-starter',
    kind: 'bundle',
    titleFa: 'باندل استارتر',
    titleEn: 'Starter Bundle',
    description: 'رنک معمولی + کیپ اندر + دنباله رنگین‌کمان + ۵۰۰ جم',
    priceUsd: 399,
    meta: { includes: ['rank-normal', 'cos-cape-ender', 'cos-trail-rainbow'], gems: 500 },
    visibleBeforeAuth: false,
  },
  {
    sku: 'bundle-warrior',
    kind: 'bundle',
    titleFa: 'باندل جنگجو',
    titleEn: 'Warrior Bundle',
    description: 'رنک پرو + تاج پادشاه + افکت کیل صاعقه + ۱۵۰۰ جم',
    priceUsd: 749,
    meta: { includes: ['rank-pro', 'cos-hat-crown', 'cos-fx-lightning'], gems: 1500 },
    visibleBeforeAuth: false,
  },
  {
    sku: 'bundle-legend',
    kind: 'bundle',
    titleFa: 'باندل افسانه',
    titleEn: 'Legend Bundle',
    description: 'رنک گاد + کلاه اژدها + پت بچه‌اژدها + افکت پرتال گردباد + ۴۰۰۰ جم',
    priceUsd: 1499,
    meta: { includes: ['rank-god', 'cos-hat-dragon', 'cos-pet-dragon', 'cos-portal-vortex'], gems: 4000 },
    visibleBeforeAuth: false,
  },

  // --------------------------------------------------------------- boosters
  {
    sku: 'boost-xp-2x-7d',
    kind: 'booster',
    titleFa: 'بوستر ۲ برابر امتیاز (۷ روز)',
    titleEn: '2x XP Booster (7 days)',
    description: 'تمام امتیازهای بازی دو برابر می‌شود',
    priceUsd: 199,
    meta: { multiplier: 2, days: 7 },
    visibleBeforeAuth: false,
  },
  {
    sku: 'boost-coins-2x-7d',
    kind: 'booster',
    titleFa: 'بوستر ۲ برابر سکه (۷ روز)',
    titleEn: '2x Coins Booster (7 days)',
    description: 'تمام سکه‌های دریافتی دو برابر می‌شود',
    priceUsd: 199,
    meta: { multiplier: 2, days: 7 },
    visibleBeforeAuth: false,
  },
  {
    sku: 'gems-1000',
    kind: 'booster',
    titleFa: '۱۰۰۰ جم',
    titleEn: '1000 Gems',
    description: 'جم برای خریدهای داخل بازی',
    priceUsd: 99,
    meta: { gems: 1000 },
    visibleBeforeAuth: false,
  },
  {
    sku: 'gems-5000',
    kind: 'booster',
    titleFa: '۵۰۰۰ جم',
    titleEn: '5000 Gems',
    description: 'جم برای خریدهای داخل بازی',
    priceUsd: 399,
    meta: { gems: 5000 },
    visibleBeforeAuth: false,
  },
];

export const CATALOG_BY_SKU: Record<string, CatalogEntry> = Object.fromEntries(
  CATALOG.map((c) => [c.sku, c]),
);

export function catalogToProducts(): Product[] {
  return CATALOG.map((c, i) => ({
    id: `p-${c.sku}`,
    kind: c.kind,
    sku: c.sku,
    titleFa: c.titleFa,
    titleEn: c.titleEn,
    description: c.description,
    priceUsd: c.priceUsd,
    baseUsd: c.priceUsd,
    imageKey: `/img/shop/${c.sku}.png`,
    meta: c.meta,
    active: true,
    visibleBeforeAuth: c.visibleBeforeAuth,
    // index i is unused for identity but keeps catalogue order stable
    ...(i < 0 ? { unused: true } : {}),
  }));
}

export const usdToCoins = (usdCents: number): number =>
  Math.round((usdCents / 100) * ECONOMY.usdToCoins);
