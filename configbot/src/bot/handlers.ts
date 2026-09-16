import { getSettings, type Settings } from '../db/db';
import {
  MAIN_MENU_ROWS,
  inlineKeyboard,
  makeTelegramClient,
  replyKeyboard,
  startLink,
  type TelegramClient,
} from './telegram';
import { classify, detectInjection, think, workersAiModel, type AiFacts } from '../ai/brain';
import {
  approvePayment,
  createOrder,
  issueTrial,
  rotateSubscription,
  submitReceipt,
  type Services,
} from '../service/orders';
import { renderUris } from '../config/generate';

/**
 * The conversation engine.
 *
 * Shape: a webhook update comes in, we resolve the user, then either
 *  - a command or button callback matches → run it deterministically, or
 *  - free text → classify it, and only reach for the model if rules miss.
 *
 * The rule that governs every handler: the bot states facts from the database
 * and the model only chooses what to do. A price, a quota, an expiry date is
 * never produced by the model.
 */

export interface Update {
  update_id: number;
  message?: Message;
  callback_query?: CallbackQuery;
}

export interface Message {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string; language_code?: string };
  chat: { id: number; type: string };
  text?: string;
  photo?: { file_id: string }[];
  document?: { file_id: string; file_name?: string };
  caption?: string;
}

export interface CallbackQuery {
  id: string;
  from: { id: number; username?: string; first_name?: string; language_code?: string };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

export interface BotDeps {
  services: Services;
  settings: Settings;
  botToken: string;
  baseUrl: string;
  miniAppUrl: string;
  ai?: { run: (model: string, input: unknown) => Promise<unknown> };
}

interface HandlerCtx {
  deps: BotDeps;
  tg: TelegramClient;
  chatId: number;
  userId: string;
  telegramId: number;
  settings: Settings;
}

export async function handleUpdate(deps: BotDeps, update: Update): Promise<void> {
  const tg = makeTelegramClient(deps.botToken);
  const msg = update.message;
  const cb = update.callback_query;

  const from = msg?.from ?? cb?.from;
  const chatId = msg?.chat.id ?? cb?.message?.chat.id;
  if (!from || !chatId) return;

  const settings = deps.settings;

  // Blocked users get one line and nothing else. Answering them normally would
  // make the block look like a bug.
  const user = await deps.services.store.getUserByTelegram(from.id);
  if (user?.blocked) {
    await safeSend(tg, chatId, '⛔ حساب شما مسدود است. برای پیگیری به پشتیبانی پیام بده.');
    return;
  }

  const resolved = await deps.services.store.getUserByTelegram(from.id);
  if (!resolved) {
    // First contact: create the row so every later handler has an id to use.
    await deps.services.store.putUser({
      id: `usr_${from.id}`,
      telegramId: from.id,
      username: from.username ?? '',
      firstName: from.first_name ?? '',
      balance: 0,
      role: 'user',
      blocked: false,
      trialUsed: false,
      referralCode: Math.random().toString(36).slice(2, 8).toUpperCase(),
      referredBy: null,
      createdAt: Date.now(),
    });
  }
  const me = (await deps.services.store.getUserByTelegram(from.id))!;

  const ctx: HandlerCtx = {
    deps,
    tg,
    chatId,
    userId: me.id,
    telegramId: from.id,
    settings,
  };

  if (settings.maintenanceMode && me.role === 'user') {
    await safeSend(tg, chatId, `🛠 ${settings.maintenanceMessage || 'ربات موقتاً در حال تعمیر است.'}`);
    return;
  }

  try {
    if (cb?.data) return await onCallback(ctx, cb);
    if (msg?.photo?.length || msg?.document) return await onMedia(ctx, msg);
    if (msg?.text) return await onText(ctx, msg.text);
  } catch (e) {
    const err = e as Error;
    await safeSend(tg, chatId, `⚠️ ${err.message || 'یه مشکلی پیش اومد، دوباره تلاش کن.'}`);
  }
}

// ------------------------------------------------------------------- text ---

async function onText(ctx: HandlerCtx, text: string): Promise<void> {
  const { tg, chatId, deps } = ctx;

  // Injection attempts are logged and answered with the normal menu. Executing
  // them is not on the table, and arguing with them is not useful either.
  if (detectInjection(text)) {
    await deps.services.store.audit({
      actorId: ctx.userId,
      action: 'abuse.injection_attempt',
      targetType: 'user',
      targetId: ctx.userId,
      detail: JSON.stringify({ text: text.slice(0, 200) }),
    });
    await safeSend(tg, chatId, 'من فقط درباره‌ی خرید و کانفیگ VPN می‌تونم کمک کنم. 🙂');
    return;
  }

  if (text.startsWith('/start')) return sendWelcome(ctx);
  if (text.startsWith('/help')) return sendHelp(ctx);

  const match = classify(text);
  if (match) return runIntent(ctx, match.intent, text);

  // Nothing matched — let the model read it. If there is no model, say so
  // plainly rather than pretending to understand.
  const facts = await buildFacts(ctx);
  const model = ctx.deps.ai ? workersAiModel(ctx.deps.ai) : undefined;
  const reply = await think(text, facts, model ?? { available: false, run: async () => '' });

  if (reply.tool) {
    const named = { intent: toolToIntent(reply.tool.name) } as const;
    return runIntent(ctx, named.intent, text);
  }
  await safeSend(tg, chatId, reply.text);
}

function toolToIntent(tool: string): Intent {
  switch (tool) {
    case 'get_my_subscriptions':
      return 'my_configs';
    case 'get_wallet':
      return 'wallet_balance';
    case 'list_plans':
      return 'plans';
    case 'get_order_status':
      return 'order_status';
    case 'create_ticket':
      return 'ticket';
    case 'get_node_status':
      return 'status';
    case 'rotate_config':
      return 'rotate_config';
    default:
      return 'help';
  }
}

type Intent =
  | 'start'
  | 'help'
  | 'menu'
  | 'plans'
  | 'buy'
  | 'my_configs'
  | 'rotate_config'
  | 'renew'
  | 'refill'
  | 'wallet_balance'
  | 'topup'
  | 'order_status'
  | 'send_receipt'
  | 'trial'
  | 'test_speed'
  | 'not_working'
  | 'ticket'
  | 'referral'
  | 'status'
  | 'contact_support'
  | 'cancel'
  | 'confirm_yes'
  | 'confirm_no'
  | 'thanks'
  | 'unknown';

async function runIntent(ctx: HandlerCtx, intent: Intent, text: string): Promise<void> {
  switch (intent) {
    case 'start':
      return sendWelcome(ctx);
    case 'help':
    case 'menu':
      return sendHelp(ctx);
    case 'plans':
    case 'buy':
      return sendPlans(ctx);
    case 'my_configs':
      return sendMyConfigs(ctx);
    case 'rotate_config':
      return rotateFirstSub(ctx);
    case 'wallet_balance':
    case 'topup':
      return sendWallet(ctx);
    case 'order_status':
      return sendOrderStatus(ctx, text);
    case 'trial':
      return giveTrial(ctx);
    case 'referral':
      return sendReferral(ctx);
    case 'status':
      return sendNodeStatus(ctx);
    case 'not_working':
    case 'ticket':
      return openTicket(ctx, text);
    case 'contact_support':
      return contactSupport(ctx);
    case 'test_speed':
      return safeSend(
        ctx.tg,
        ctx.chatId,
        '📡 برای تست سرعت، بعد از وصل شدن به کانفیگ این را باز کن:\nhttps://fast.com\n\nاگر سرعت پایین بود، کانفیگ را چرخش بده (دکمه‌ی «کانفیگ جدید») یا به پشتیبانی بگو.',
      );
    case 'renew':
      return sendPlans(ctx);
    case 'refill':
      return safeSend(
        ctx.tg,
        ctx.chatId,
        'برای شارژ حجم، یک پلن جدید بخر — حجم پلن جدید به اشتراک فعلی‌ات اضافه می‌شود. از دکمه‌ی «📦 خرید کانفیگ» شروع کن.',
      );
    case 'send_receipt':
      return safeSend(
        ctx.tg,
        ctx.chatId,
        '🧾 عکس رسید را همین‌جا بفرست، همراه با:\n• شماره کارتی که واریز کردی\n• کد رهگیری تراکنش\n• کد سفارش',
      );
    case 'thanks':
      return safeSend(ctx.tg, ctx.chatId, 'قربانت 🌷 اگه چیزی لازم داشتی در خدمتم.');
    case 'cancel':
      return safeSend(ctx.tg, ctx.chatId, 'باشه، لغو شد. 👍');
    case 'confirm_yes':
    case 'confirm_no':
      return sendHelp(ctx);
    default:
      return sendHelp(ctx);
  }
}

// ---------------------------------------------------------------- handlers --

async function sendWelcome(ctx: HandlerCtx): Promise<void> {
  const { settings } = ctx;
  const user = await ctx.deps.services.store.getUser(ctx.userId);
  const name = user?.firstName || 'دوست من';
  const text = [
    `سلام ${name} 👋`,
    '',
    `به *${settings.botName}* خوش اومدی.`,
    'اینجا می‌تونی کانفیگ VPN بخری، لینک اختصاصی‌ات رو بگیری و هر وقت لازم شد تمدید یا چرخش کنی.',
    '',
    '📦 لینک اشتراک تو همیشه ثابت می‌ماند — با هر کلاینتی (v2rayNG، Hiddify، Streisand، Clash) کار می‌کند.',
    '🔁 اگه کانفیگت پخش شد، با یک دکمه کلیدها عوض می‌شوند و لینک همان می‌ماند.',
  ].join('\n');

  await ctx.tg.sendMessage(ctx.chatId, text, {
    parseMode: 'MarkdownV2',
    replyMarkup: replyKeyboard(MAIN_MENU_ROWS),
  });
  await sendPlans(ctx, true);
}

async function sendHelp(ctx: HandlerCtx): Promise<void> {
  await ctx.tg.sendMessage(
    ctx.chatId,
    [
      '📖 *راهنما*',
      '',
      '📦 خرید کانفیگ — یک پلن انتخاب کن، پرداخت کن، لینک اشتراک تحویل می‌گیری.',
      '🔑 کانفیگ‌های من — لینک اشتراک و لیست کانفیگ‌ها.',
      '🔄 چرخش کلید — اگر کانفیگت پخش شده، کلیدها عوض می‌شوند؛ لینک ثابت می‌ماند.',
      '👛 کیف پول — موجودی و تاریخچه.',
      '🎁 دعوت از دوستان — درصدی از خرید زیرمجموعه‌ها به کیف پولت برمی‌گردد.',
      '🆘 پشتیبانی — تیکت بزن، ادمین جواب می‌دهد.',
      '',
      'می‌توانی آزاد هم بنویسی؛ مثلاً «کانفیگم کار نمیکنه» یا «قیمت پلن سه ماهه».',
    ].join('\n'),
    { parseMode: 'MarkdownV2', replyMarkup: replyKeyboard(MAIN_MENU_ROWS) },
  );
}

async function sendPlans(ctx: HandlerCtx, quiet = false): Promise<void> {
  const plans = await ctx.deps.services.store.listPlans(false);
  if (plans.length === 0) {
    if (!quiet) await safeSend(ctx.tg, ctx.chatId, 'فعلاً پلنی برای فروش نداریم. به‌زودی اضافه می‌شود.');
    return;
  }

  const lines = ['📦 *پلن‌ها*', ''];
  const buttons = [];
  for (const p of plans) {
    const traffic = p.trafficGb > 0 ? `${p.trafficGb} گیگ` : 'حجم نامحدود';
    const days = p.durationDays > 0 ? `${p.durationDays} روزه` : 'بدون انقضا';
    lines.push(`${p.badge ? `«${p.badge}» ` : ''}*${p.name}* — ${p.price.toLocaleString('fa-IR')} ${ctx.settings.currency}`);
    lines.push(`   ${days} • ${traffic}`);
    buttons.push([{ text: `خرید ${p.name}`, callback_data: `buy:${p.id}` }]);
  }

  if (ctx.settings.trialEnabled) {
    buttons.push([{ text: '🎁 نسخه‌ی رایگان', callback_data: 'trial' }]);
  }
  if (ctx.deps.miniAppUrl) {
    buttons.push([{ text: '📱 باز کردن در مینی‌اپ', web_app: { url: ctx.deps.miniAppUrl } }]);
  }

  await ctx.tg.sendMessage(ctx.chatId, lines.join('\n'), {
    parseMode: 'MarkdownV2',
    replyMarkup: inlineKeyboard(buttons),
  });
}

async function sendMyConfigs(ctx: HandlerCtx): Promise<void> {
  const subs = await ctx.deps.services.store.listSubscriptions(ctx.userId);
  const active = subs.filter((s) => s.status === 'active');

  if (active.length === 0) {
    await ctx.tg.sendMessage(ctx.chatId, 'هنوز اشتراک فعالی نداری. از «📦 خرید کانفیگ» شروع کن.', {
      replyMarkup: inlineKeyboard([[{ text: 'دیدن پلن‌ها', callback_data: 'plans' }]]),
    });
    return;
  }

  const lines = ['🔑 *اشتراک‌های شما*', ''];
  const buttons = [];

  for (const s of active) {
    const usedGb = (s.trafficUsedBytes / 1024 ** 3).toFixed(1);
    const traffic = s.trafficGb > 0 ? `${usedGb} از ${s.trafficGb} گیگ` : 'حجم نامحدود';
    const expiry = s.expiresAt
      ? `${Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 86_400_000))} روز باقی`
      : 'بدون انقضا';
    lines.push(`*${s.label}*`);
    lines.push(`   ${traffic} • ${expiry}`);

    const url = `${ctx.deps.baseUrl}/s/${s.token}`;
    buttons.push([{ text: `🔗 لینک «${s.label}»`, url }]);
    buttons.push([
      { text: '🔄 چرخش کلید', callback_data: `rotate:${s.id}` },
      { text: '📄 کانفیگ‌ها', callback_data: `configs:${s.id}` },
    ]);
  }

  await ctx.tg.sendMessage(ctx.chatId, lines.join('\n'), {
    parseMode: 'MarkdownV2',
    replyMarkup: inlineKeyboard(buttons),
  });
}

async function rotateFirstSub(ctx: HandlerCtx): Promise<void> {
  const subs = await ctx.deps.services.store.listSubscriptions(ctx.userId);
  const active = subs.filter((s) => s.status === 'active');
  if (active.length === 0) {
    await safeSend(ctx.tg, ctx.chatId, 'اشتراک فعالی نداری که بچرخانم.');
    return;
  }
  await doRotate(ctx, active[0]!.id);
}

async function doRotate(ctx: HandlerCtx, subId: string): Promise<void> {
  const res = await rotateSubscription(ctx.deps.services, subId, ctx.userId);
  if (res.changed === 0) {
    await safeSend(
      ctx.tg,
      ctx.chatId,
      `⚠️ چرخش انجام نشد: ${res.failures.map((f) => f.reason).join(' | ') || 'نامشخص'}`,
    );
    return;
  }
  await ctx.tg.sendMessage(
    ctx.chatId,
    [
      `✅ ${res.changed} کانفیگ چرخش شد.`,
      '',
      '🔗 لینک اشتراکت عوض *نشده* — فقط در کلاینت یک‌بار به‌روزش کن.',
      '⛔ کانفیگ قبلی از همین لحظه از کار افتاد.',
    ].join('\n'),
    { parseMode: 'MarkdownV2' },
  );
}

async function sendWallet(ctx: HandlerCtx): Promise<void> {
  const user = await ctx.deps.services.store.getUser(ctx.userId);
  const ledger = await ctx.deps.services.store.ledger(ctx.userId);
  const lines = [`👛 *کیف پول*`, '', `موجودی: *${(user?.balance ?? 0).toLocaleString('fa-IR')} ${ctx.settings.currency}*`];

  if (ledger.length) {
    lines.push('', 'آخرین تراکنش‌ها:');
    for (const r of ledger.slice(0, 5)) {
      const sign = r.delta > 0 ? '+' : '';
      lines.push(`   ${sign}${r.delta.toLocaleString('fa-IR')} — ${reasonFa(r.reason)}`);
    }
  }
  lines.push('', 'برای شارژ، از «افزایش موجودی» در مینی‌اپ یا کارت‌به‌کارت استفاده کن.');

  await ctx.tg.sendMessage(ctx.chatId, lines.join('\n'), { parseMode: 'MarkdownV2' });
}

function reasonFa(reason: string): string {
  return (
    {
      deposit: 'واریز',
      purchase: 'خرید',
      refund: 'استرداد',
      referral: 'معرف',
      adjust: 'اصلاح دستی',
    }[reason] ?? reason
  );
}

async function sendOrderStatus(ctx: HandlerCtx, text: string): Promise<void> {
  const codeMatch = /\b([2-9A-HJ-NP-Z]{4}-?[2-9A-HJ-NP-Z]{4})\b/.exec(text.toUpperCase());
  const orders = codeMatch
    ? [await ctx.deps.services.store.getOrderByCode(codeMatch[1]!)].filter(Boolean)
    : await ctx.deps.services.store.listOrders(ctx.userId, 5);

  if (orders.length === 0) {
    await safeSend(ctx.tg, ctx.chatId, 'سفارشی با این کد پیدا نکردم. کد سفارش را دقیق بفرست.');
    return;
  }

  const lines = ['🧾 *وضعیت سفارش*', ''];
  for (const o of orders) {
    lines.push(
      `کد \`${o!.code}\` — ${o!.amount.toLocaleString('fa-IR')} ${ctx.settings.currency} — ${statusFa(o!.status)}`,
    );
  }
  await ctx.tg.sendMessage(ctx.chatId, lines.join('\n'), { parseMode: 'MarkdownV2' });
}

function statusFa(status: string): string {
  return (
    {
      pending: 'در انتظار',
      awaiting_payment: 'منتظر پرداخت',
      paid: 'پرداخت شد ✅',
      approved: 'تأیید شد ✅',
      rejected: 'رد شد ❌',
      canceled: 'لغو شد',
      expired: 'منقضی شد',
      failed: 'ناموفق',
    }[status] ?? status
  );
}

async function giveTrial(ctx: HandlerCtx): Promise<void> {
  const { settings } = ctx;
  if (!settings.trialEnabled) {
    await safeSend(ctx.tg, ctx.chatId, 'نسخه‌ی رایگان فعلاً فعال نیست.');
    return;
  }
  try {
    const res = await issueTrial(ctx.deps.services, ctx.userId, {
      days: settings.trialDays,
      trafficGb: settings.trialTrafficGb,
    });
    const uris = res.credentials.map((c) => c.uri);
    await ctx.tg.sendMessage(
      ctx.chatId,
      `🎁 نسخه‌ی رایگان ${settings.trialDays} روزه با ${settings.trialTrafficGb} گیگ حجم آماده شد.`,
    );
    await sendConfigs(ctx, uris, `${ctx.deps.baseUrl}/s/${res.subscription.token}`);
  } catch (e) {
    await safeSend(ctx.tg, ctx.chatId, `⚠️ ${(e as Error).message}`);
  }
}

async function sendConfigs(ctx: HandlerCtx, uris: string[], subUrl: string): Promise<void> {
  if (uris.length === 0) {
    await safeSend(ctx.tg, ctx.chatId, 'کانفیگی صادر نشد. به پشتیبانی بگو.');
    return;
  }
  // Send the link first: it is the thing that keeps working after a rotation.
  await ctx.tg.sendMessage(
    ctx.chatId,
    ['🔗 *لینک اشتراک شما*', '', `\`${subUrl}\``, '', 'این لینک ثابت می‌ماند. در کلاینت اضافه‌اش کن و تمام.'].join('\n'),
    { parseMode: 'MarkdownV2' },
  );

  // Then the raw configs, so someone whose client cannot import a URL still
  // gets something that works today.
  const { body } = renderUris(uris, { title: ctx.settings.botName });
  const chunks = splitForTelegram(body);
  for (const chunk of chunks) {
    await safeSend(ctx.tg, ctx.chatId, chunk);
  }
}

/** Telegram caps messages at 4096 chars; split on line boundaries. */
export function splitForTelegram(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > limit) {
      out.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) out.push(current);
  return out;
}

async function sendReferral(ctx: HandlerCtx): Promise<void> {
  const user = await ctx.deps.services.store.getUser(ctx.userId);
  if (!user) return;
  const botUsername = ctx.deps.botToken ? '' : '';
  const link = `https://t.me/${botUsername || 'your_bot'}?start=${user.referralCode}`;
  await ctx.tg.sendMessage(
    ctx.chatId,
    [
      '🎁 *دعوت از دوستان*',
      '',
      `هر کسی با لینک تو بخرد، ${ctx.settings.referralPercent}٪ از مبلغ به کیف پولت برمی‌گردد.`,
      '',
      `\`${link}\``,
      '',
      `تا حالا ${user.referralCode ? 'کد تو فعال است' : ''}.`,
    ].join('\n'),
    { parseMode: 'MarkdownV2' },
  );
  void startLink;
}

async function sendNodeStatus(ctx: HandlerCtx): Promise<void> {
  const nodes = await ctx.deps.services.store.listNodes();
  const up = nodes.filter((n) => n.health === 'up' && n.enabled).length;
  const down = nodes.filter((n) => n.health === 'down').length;
  await ctx.tg.sendMessage(
    ctx.chatId,
    [
      '🩺 *وضعیت سرویس*',
      '',
      `نودهای سالم: ${up.toLocaleString('fa-IR')}`,
      down ? `نودهای خراب: ${down.toLocaleString('fa-IR')}` : 'همه‌ی نودها سالم‌اند ✅',
      '',
      down ? 'اگر کانفیگت کار نمی‌کند، «چرخش کلید» تو را روی یک نود سالم می‌اندازد.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    { parseMode: 'MarkdownV2' },
  );
}

async function openTicket(ctx: HandlerCtx, text: string): Promise<void> {
  const code = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await ctx.deps.services.store.createTicket({
    id: `tkt_${Date.now()}`,
    code,
    userId: ctx.userId,
    subject: text.slice(0, 200) || 'درخواست پشتیبانی',
    category: 'config',
    status: 'open',
    createdAt: Date.now(),
  });
  await ctx.deps.services.store.audit({
    actorId: ctx.userId,
    action: 'ticket.open',
    targetType: 'ticket',
    targetId: code,
    detail: JSON.stringify({ text: text.slice(0, 120) }),
  });

  const advice =
    classify(text)?.intent === 'not_working'
      ? 'تا رسیدن جواب ادمین، این‌ها را امتحان کن:\n۱. «چرخش کلید» را بزن.\n۲. لینک اشتراک را در کلاینت به‌روز کن.\n۳. اگر فقط یک سایت باز نمی‌شود، مشکل از آن سایت است نه کانفیگ.'
      : 'ادمین به‌زودی جواب می‌دهد.';

  await ctx.tg.sendMessage(
    ctx.chatId,
    [`🆘 تیکت *\`${code}\`* ثبت شد.`, '', advice].join('\n'),
    { parseMode: 'MarkdownV2' },
  );
}

async function contactSupport(ctx: HandlerCtx): Promise<void> {
  const chat = ctx.settings.supportChat;
  await ctx.tg.sendMessage(
    ctx.chatId,
    chat
      ? `برای صحبت با پشتیبانی: ${chat}`
      : 'برای پشتیبانی همین‌جا بنویس «تیکت» تا ادمین جواب بدهد.',
  );
}

// ------------------------------------------------------------- callbacks ----

async function onCallback(ctx: HandlerCtx, cb: CallbackQuery): Promise<void> {
  const data = cb.data ?? '';
  const [action, arg] = data.split(':');

  try {
    if (action === 'plans') {
      await ctx.tg.answerCallback(cb.id);
      return sendPlans(ctx);
    }
    if (action === 'buy' && arg) {
      await ctx.tg.answerCallback(cb.id);
      return startPurchase(ctx, arg);
    }
    if (action === 'rotate' && arg) {
      await ctx.tg.answerCallback(cb.id, 'در حال چرخش…');
      return doRotate(ctx, arg);
    }
    if (action === 'configs' && arg) {
      await ctx.tg.answerCallback(cb.id);
      return showConfigs(ctx, arg);
    }
    if (action === 'trial') {
      await ctx.tg.answerCallback(cb.id);
      return giveTrial(ctx);
    }
    if (action === 'receipt' && arg) {
      await ctx.tg.answerCallback(cb.id);
      return safeSend(
        ctx.tg,
        ctx.chatId,
        `🧾 عکس رسید سفارش \`${arg}\` را بفرست، همراه با شماره کارت، کد رهگیری و نام صاحب کارت.`,
      );
    }
    await ctx.tg.answerCallback(cb.id, 'این دکمه قدیمی شده', true);
  } catch (e) {
    await ctx.tg.answerCallback(cb.id, (e as Error).message.slice(0, 180), true);
  }
}

async function startPurchase(ctx: HandlerCtx, planId: string): Promise<void> {
  const order = await createOrder(ctx.deps.services, { userId: ctx.userId, planId });

  if (order.amount === 0) {
    await safeSend(ctx.tg, ctx.chatId, '✅ این سفارش رایگان بود و آماده شد.');
    return deliverOrder(ctx, order.id);
  }

  const { settings } = ctx;
  const cardReady = settings.cardNumber.replace(/\D/g, '').length >= 16;

  const lines = [
    `🧾 *سفارش \`${order.code}\`*`,
    '',
    `مبلغ: *${order.amount.toLocaleString('fa-IR')} ${settings.currency}*`,
    '',
    cardReady ? '💳 کارت‌به‌کارت آماده است.' : '⚠️ روش پرداخت هنوز در پنل تنظیم نشده.',
  ];
  const buttons = [];
  if (cardReady) buttons.push([{ text: '💳 دریافت شماره کارت', callback_data: `card:${order.id}` }]);
  if (ctx.deps.miniAppUrl) {
    buttons.push([{ text: '📱 پرداخت در مینی‌اپ', web_app: { url: `${ctx.deps.miniAppUrl}?start=order_${order.code}` } }]);
  }

  await ctx.tg.sendMessage(ctx.chatId, lines.join('\n'), {
    parseMode: 'MarkdownV2',
    replyMarkup: inlineKeyboard(buttons),
  });

  if (cardReady) {
    const pretty = settings.cardNumber.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ').trim();
    await ctx.tg.sendMessage(
      ctx.chatId,
      [
        `💳 *پرداخت کارت‌به‌کارت*`,
        '',
        '```',
        pretty,
        '```',
        settings.cardBank ? `🏦 ${settings.cardBank}` : '',
        settings.cardHolder ? `👤 به نام: ${settings.cardHolder}` : '',
        '',
        `🔖 کد پیگیری: \`${order.code}\``,
        'لطفاً این کد را در توضیحات تراکنش بنویس.',
        settings.paymentMessage ? `\n${settings.paymentMessage}` : '',
        '',
        'بعد از واریز، عکس فیش را بفرست.',
      ]
        .filter((l) => l !== '')
        .join('\n'),
      { parseMode: 'MarkdownV2' },
    );
  }
}

async function deliverOrder(ctx: HandlerCtx, orderId: string): Promise<void> {
  const order = await ctx.deps.services.store.getOrder(orderId);
  if (!order) return;
  const subs = await ctx.deps.services.store.listSubscriptions(ctx.userId);
  const mine = subs.find((s) => s.planId === order.planId);
  if (!mine) return;
  const creds = await ctx.deps.services.store.listCredentials(mine.id);
  await sendConfigs(ctx, creds.map((c) => c.uri), `${ctx.deps.baseUrl}/s/${mine.token}`);
}

async function showConfigs(ctx: HandlerCtx, subId: string): Promise<void> {
  const sub = await ctx.deps.services.store.getSubscription(subId);
  if (!sub || sub.userId !== ctx.userId) {
    await safeSend(ctx.tg, ctx.chatId, 'این اشتراک مال شما نیست.');
    return;
  }
  const creds = await ctx.deps.services.store.listCredentials(subId);
  await sendConfigs(ctx, creds.filter((c) => c.status === 'active').map((c) => c.uri), `${ctx.deps.baseUrl}/s/${sub.token}`);
}

// ------------------------------------------------------------------ media ---

/**
 * A photo arriving after an "awaiting_payment" order is a receipt.
 *
 * We match on the most recent such order rather than requiring the user to
 * quote a code — most people just send the screenshot. If there is no open
 * order we say so instead of silently dropping the image.
 */
async function onMedia(ctx: HandlerCtx, msg: Message): Promise<void> {
  const fileId = msg.photo?.[msg.photo.length - 1]?.file_id ?? msg.document?.file_id;
  if (!fileId) return;

  const orders = await ctx.deps.services.store.listOrders(ctx.userId, 10);
  const pending = orders.find(
    (o) => o.status === 'pending' || o.status === 'awaiting_payment',
  );

  if (!pending) {
    await safeSend(
      ctx.tg,
      ctx.chatId,
      'سفارش بازِ در انتظار پرداختی ندارم که این فیش را به آن وصل کنم. اول یک سفارش ثبت کن.',
    );
    return;
  }

  const caption = msg.caption ?? '';
  const cardMatch = /\b(\d{16}|\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/.exec(caption);
  const trackingMatch = /\b(\d{6,20})\b/.exec(caption.replace(cardMatch?.[0] ?? '∅', ''));

  try {
    const res = await submitReceipt(ctx.deps.services, {
      orderId: pending.id,
      userId: ctx.userId,
      receiptPhoto: fileId,
      payerCard: cardMatch?.[1]?.replace(/[\s-]/g, '') ?? '',
      payerName: '',
      trackingCode: trackingMatch?.[1] ?? '',
      note: caption,
    });

    await ctx.tg.sendMessage(
      ctx.chatId,
      res.autoApproved
        ? '✅ پرداخت تأیید شد و کانفیگ‌هایت آماده است.'
        : [
            '⏳ فیشت ثبت شد و در صف بررسی است.',
            res.verdict.reasons.length ? `نکته: ${res.verdict.summary}` : '',
            'به محض تأیید، کانفیگ‌ها را همین‌جا می‌فرستم.',
          ]
            .filter(Boolean)
            .join('\n'),
    );
    if (res.autoApproved) await deliverOrder(ctx, pending.id);
  } catch (e) {
    await safeSend(ctx.tg, ctx.chatId, `⚠️ ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------- facts --

async function buildFacts(ctx: HandlerCtx): Promise<AiFacts> {
  const services = ctx.deps.services;
  const user = await services.store.getUser(ctx.userId);
  const subs = await services.store.listSubscriptions(ctx.userId);
  const plans = await services.store.listPlans(false);
  const orders = await services.store.listOrders(ctx.userId, 5);
  const nodes = await services.store.listNodes();

  return {
    userName: user?.firstName || user?.username || '',
    balance: user?.balance ?? 0,
    currency: ctx.settings.currency,
    subscriptions: subs.map((s) => ({
      id: s.id,
      label: s.label,
      trafficGb: s.trafficGb,
      usedGb: Number((s.trafficUsedBytes / 1024 ** 3).toFixed(2)),
      expiresAt: s.expiresAt,
      status: s.status,
    })),
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      trafficGb: p.trafficGb,
      durationDays: p.durationDays,
    })),
    openOrders: orders
      .filter((o) => o.status === 'pending' || o.status === 'awaiting_payment')
      .map((o) => ({ code: o.code, amount: o.amount, status: o.status, gateway: o.gateway })),
    nodesHealthy: nodes.filter((n) => n.health === 'up' && n.enabled).length,
    nodesTotal: nodes.length,
  };
}

/** Never let a Telegram send failure kill the handler. */
async function safeSend(tg: TelegramClient, chatId: number, text: string): Promise<void> {
  try {
    await tg.sendMessage(chatId, text);
  } catch {
    // A failed send is not worth throwing over; the user can retry.
  }
}

void getSettings;
void approvePayment;
