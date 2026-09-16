/**
 * Telegram Bot API client.
 *
 * Thin on purpose. It does three things the rest of the code should not repeat:
 *  - turns a thrown fetch failure into a typed `TelegramError` instead of a
 *    500 that Telegram will retry forever,
 *  - truncates captions to the API's own limit rather than letting a long
 *    config list get rejected,
 *  - validates `initData` from the mini app, because that HMAC is the only
 *    thing standing between a stranger and someone else's subscription.
 */

export const API = 'https://api.telegram.org';

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly description: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

export interface TelegramClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SendOptions {
  parseMode?: 'HTML' | 'MarkdownV2';
  disablePreview?: boolean;
  replyMarkup?: unknown;
  replyTo?: number;
}

export interface TelegramClient {
  call<T = unknown>(method: string, payload: unknown): Promise<T>;
  sendMessage(chatId: number | string, text: string, opts?: SendOptions): Promise<number>;
  sendPhoto(
    chatId: number | string,
    photoUrl: string,
    caption?: string,
    opts?: SendOptions,
  ): Promise<number>;
  editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    opts?: SendOptions,
  ): Promise<void>;
  answerCallback(callbackId: string, text?: string, showAlert?: boolean): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
  getMe(): Promise<{ id: number; username: string }>;
}

export function makeTelegramClient(token: string, opts: TelegramClientOptions = {}): TelegramClient {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (!token) throw new Error('BOT_TOKEN تنظیم نشده است');

  async function call<T>(method: string, payload: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await f(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      throw new TelegramError(
        `ارتباط با تلگرام برقرار نشد (${(e as Error).message})`,
        0,
        (e as Error).message,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };

    if (!json.ok) {
      const code = json.error_code ?? res.status;
      const desc = json.description ?? `HTTP ${res.status}`;
      // 429 and 5xx are worth retrying; 4xx means our payload is wrong and
      // retrying will just burn rate limit.
      const retryable = code === 429 || code >= 500;
      throw new TelegramError(`تلگرام: ${desc}`, code, desc, retryable);
    }
    return json.result as T;
  }

  return {
    call,

    async sendMessage(chatId, text, sendOpts = {}) {
      // Telegram rejects messages over 4096 chars. Config lists get long, so we
      // cut at a boundary that keeps earlier configs intact.
      const body = text.length > 4000 ? `${text.slice(0, 4000)}\n… (ادامه در لینک اشتراک)` : text;
      const out = await call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text: body,
        parse_mode: sendOpts.parseMode,
        disable_web_page_preview: sendOpts.disablePreview ?? true,
        reply_markup: sendOpts.replyMarkup,
        reply_to_message_id: sendOpts.replyTo,
      });
      return out.message_id;
    },

    async sendPhoto(chatId, photoUrl, caption, sendOpts = {}) {
      const cap = caption && caption.length > 1024 ? caption.slice(0, 1024) : caption;
      const out = await call<{ message_id: number }>('sendPhoto', {
        chat_id: chatId,
        photo: photoUrl,
        caption: cap,
        parse_mode: sendOpts.parseMode,
        reply_markup: sendOpts.replyMarkup,
      });
      return out.message_id;
    },

    async editMessageText(chatId, messageId, text, sendOpts = {}) {
      await call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: text.length > 4000 ? text.slice(0, 4000) : text,
        parse_mode: sendOpts.parseMode,
        reply_markup: sendOpts.replyMarkup,
        disable_web_page_preview: sendOpts.disablePreview ?? true,
      });
    },

    async answerCallback(callbackId, text, showAlert = false) {
      await call('answerCallbackQuery', {
        callback_query_id: callbackId,
        text: text ?? undefined,
        show_alert: showAlert,
      });
    },

    async setWebhook(url, secret) {
      await call('setWebhook', {
        url,
        secret_token: secret,
        allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
        max_connections: 40,
        drop_pending_updates: false,
      });
    },

    async getMe() {
      return call<{ id: number; username: string }>('getMe', {});
    },
  };
}

// ------------------------------------------------------------- keyboards ---

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
}

export function inlineKeyboard(rows: InlineButton[][]): { inline_keyboard: InlineButton[][] } {
  return { inline_keyboard: rows };
}

export function replyKeyboard(rows: string[][], resize = true): {
  keyboard: { text: string }[][];
  resize_keyboard: boolean;
  input_field_placeholder: string;
} {
  return {
    keyboard: rows.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: resize,
    input_field_placeholder: 'یا از دکمه‌ها انتخاب کن',
  };
}

export const MAIN_MENU_ROWS = [
  ['📦 خرید کانفیگ', '🔑 کانفیگ‌های من'],
  ['👛 کیف پول', '🎁 دعوت از دوستان'],
  ['🩺 تست و وضعیت', '🆘 پشتیبانی'],
];

// ------------------------------------------------------------- initData ----

/**
 * Verify the `initData` string a Telegram Web App sends.
 *
 * The scheme is Telegram's own: `secret = HMAC_SHA256(botToken, "WebAppData")`,
 * then `HMAC_SHA256(secret, dataCheckString)` must equal the `hash` field.
 * `dataCheckString` is the *sorted* `key=value` pairs joined by newlines, with
 * the `hash` key excluded.
 *
 * This is the only authentication the mini app has. Skipping it means anyone
 * who guesses a numeric user id can read that user's configs, so it is not
 * optional and it is not skippable "in development".
 */
export interface InitDataUser {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  languageCode: string;
  isPremium: boolean;
}

export interface InitDataResult {
  ok: boolean;
  error?: string;
  user?: InitDataUser;
  authDate?: number;
  startParam?: string;
  query?: Record<string, string>;
}

export async function verifyInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSeconds?: number; now?: number } = {},
): Promise<InitDataResult> {
  const maxAge = opts.maxAgeSeconds ?? 86_400;
  const nowMs = opts.now ?? Date.now();

  if (!initData) return { ok: false, error: 'initData خالی است' };
  if (!botToken) return { ok: false, error: 'BOT_TOKEN تنظیم نشده' };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, error: 'initData قابل پارس نیست' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'hash ندارد' };

  const pairs: string[] = [];
  params.forEach((v, k) => {
    if (k !== 'hash') pairs.push(`${k}=${v}`);
  });
  pairs.sort();
  const dataCheck = pairs.join('\n');

  const secret = await hmacSha256(utf8('WebAppData'), utf8(botToken));
  const expected = toHex(await hmacSha256(new Uint8Array(secret), utf8(dataCheck)));

  if (!timingSafeEqualHex(expected, hash)) {
    return { ok: false, error: 'امضا معتبر نیست' };
  }

  const authDate = Number(params.get('auth_date') ?? '0');
  if (authDate > 0 && nowMs / 1000 - authDate > maxAge) {
    return { ok: false, error: 'initData منقضی شده' };
  }

  const rawUser = params.get('user');
  let user: InitDataUser | undefined;
  if (rawUser) {
    try {
      const u = JSON.parse(rawUser) as Record<string, unknown>;
      user = {
        id: Number(u.id ?? 0),
        username: String(u.username ?? ''),
        firstName: String(u.first_name ?? ''),
        lastName: String(u.last_name ?? ''),
        languageCode: String(u.language_code ?? 'fa'),
        isPremium: u.is_premium === true,
      };
      if (!user.id) user = undefined;
    } catch {
      return { ok: false, error: 'user نامعتبر' };
    }
  }
  if (!user) return { ok: false, error: 'کاربر در initData نیست' };

  const query: Record<string, string> = {};
  params.forEach((v, k) => {
    query[k] = v;
  });

  return { ok: true, user, authDate, startParam: params.get('start_param') ?? undefined, query };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, data);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish compare. Hex strings, fixed length, no early exit. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// -------------------------------------------------------- webhook secrets --

/**
 * Check `X-Telegram-Bot-Api-Secret-Token`.
 *
 * Without this, anyone who finds the webhook URL can post fake updates and
 * make the bot send configs to themselves. The comparison is length- and
 * content-safe for the same reason as the hash check above.
 */
export function checkWebhookSecret(received: string | null, expected: string): boolean {
  if (!expected) return false;
  if (!received) return false;
  return timingSafeEqualHex(received.padEnd(64, '0'), expected.padEnd(64, '0'));
}

// ------------------------------------------------------------- formatting --

/** Escape for MarkdownV2. Every special char, or Telegram rejects the message. */
export function mdEscape(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** Build a tg:// deep link that pre-fills /start with a referral code. */
export function startLink(botUsername: string, param?: string): string {
  const base = `https://t.me/${botUsername.replace(/^@/, '')}`;
  return param ? `${base}?start=${encodeURIComponent(param)}` : base;
}

/** Mask a card number for display: `6037 99** **** 1234`. */
export function maskCard(card: string): string {
  const digits = card.replace(/\D/g, '');
  if (digits.length < 8) return card;
  return `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
}
