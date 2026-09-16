# Nova Edge — Minecraft God Server + ConfigBot

پلتفرم کامل سرور ماینکرفت روی **Cloudflare Workers + D1 + KV + R2 + Durable Objects**:
سایت، فروشگاه با احراز هویت OTP، پنل ادمین، آنتی‌چیت چندلایه، بات‌های هوشمند تطبیقی،
۱۴ گیم‌مود و مانیتورینگ.

> ⚠️ **قبل از هر چیز [docs/FEASIBILITY.md](docs/FEASIBILITY.md) را بخوانید.**
> چند بخش از خواسته‌های اولیه روی Cloudflare-only **از نظر فنی ناممکن** است و آن سند
> با استناد به مستندات رسمی توضیح می‌دهد چرا. این پروژه وانمود نمی‌کند که آن بخش‌ها کار می‌کنند.

---

## وضعیت صادقانه

| بخش | وضعیت |
|---|---|
| پلتفرم وب (سایت، API، پنل ادمین) | ✅ ساخته و تست شده با Miniflare |
| احراز هویت OTP + ضداسپم | ✅ ساخته و تست شده |
| فروشگاه + قیمت‌گذاری پویا + بررسی فیش | ✅ ساخته و تست شده |
| آنتی‌چیت چندلایه | ✅ ساخته و **کالیبره با شبیه‌سازی** (FP صفر) |
| ۱۴ گیم‌مود + منطق امتیاز | ✅ ساخته و تست شده |
| بات‌های تطبیقی بر اساس ELO | ✅ ساخته و تست شده |
| بخش ترموکس (جی‌پی‌اس، سیو مکان، دستیار آفلاین) | ✅ ساخته و تست شده (۱۸۲ تست) — جی‌پی‌اس سخت‌افزاری روی گوشی تست نشده |
| رانتایم ماینکرفت | ⚠️ Dockerfile + پلاگین آماده، ولی **روی Cloudflare قابل اتصال عمومی نیست** |
| ۶۰۰ پلیر روی پلن رایگان | ❌ **ناممکن** — به محدودیت‌های فیزیکی برمی‌گردد، نه به کد |
| **ConfigBot** (ربات فروش کانفیگ VPN + مینی‌اپ + پنل + سایت) | ✅ ساخته و تست شده (۳۱۴ تست) |
| سایت فروش ConfigBot (`/`, `/download`, `/panel`) | ✅ ساخته و تست شده در سطح HTTP — در مرورگر رندر نشده |
| فایل نصب اختصاصی exe/apk | ❌ **عمداً ساخته نشد** — به‌جایش لینک بیلد رسمی و متن‌باز (Hiddify / v2rayNG / v2rayN) |
| دیپلوی | ❌ از این محیط انجام نشد (بدون دسترسی به `api.cloudflare.com`) |

## بخش ترموکس — برنامه‌ی کاملاً آفلاین

برای وقتی که نه کلودفلر در دسترس است نه اینترنت. یک برنامه‌ی پایتون که
**همه‌چیز را از همین پوشه می‌خواند** و روی گوشی اجرا می‌شود:

```bash
python3 setup.py             # بررسی محیط + نصب termux-api + اجرای تست‌ها
python3 run.py               # → http://127.0.0.1:8000/
python3 run.py --open        # اجرا + باز کردن مرورگر
python3 run.py --status      # چه چیزی الان در دسترس است
python3 run.py --ask "کجام؟"
python3 run.py --selftest    # ۱۸۲ تست، بدون هیچ بسته‌ی اضافی
```

هر دو فقط با کتابخانه‌ی استاندارد پایتون کار می‌کنند (`setup.py` تنها چیزی که
ممکن است نصب کند `termux-api` است، با `pkg`).

سه کار اصلی:

- **جی‌پی‌اس واقعی** از راه `Termux:API` — با خطاهای نوع‌دار و راهنمای فارسی
  وقتی افزونه/اجازه/جی‌پی‌اس نیست. عدد الکی نمی‌دهد.
- **سیوِ مکان**: یک بار «اینجا رو سیو کن به اسم خونه»، بعد همیشه «برم خونه».
  جهت قطب‌نما، فاصله، تخمین زمان و لینک نقشه — همه آفلاین.
- **دستیار آفلاین فارسی**: نرمال‌سازی فارسی + ۲۵ نیت + بازیابی BM25 +
  تطبیق آوایی. چیزی را که نمی‌داند **نمی‌سازد**؛ می‌گوید «نمی‌دانم».

جزئیات کامل: [docs/TERMUX.md](docs/TERMUX.md)

---

## اجرا

```bash
npm install          # .npmrc شامل legacy-peer-deps است (باگ arborist در npm)
npm test             # تست‌های تایپ‌اسکریپت
npm run check        # tsc --noEmit + بررسی JS مرورگر
python3 main.py --selftest   # تست‌های بخش پایتون
```

### دیپلوی

```bash
wrangler login
wrangler d1 create minecraft-god-server      # شناسه را در wrangler.jsonc بگذارید
wrangler kv namespace create GODKV
wrangler r2 bucket create minecraft-god-server
npm run db:apply:remote
wrangler secret put ADMIN_PASSWORD
wrangler secret put SESSION_SECRET
wrangler secret put OTP_SECRET
wrangler secret put SERVER_INGEST_SECRET
wrangler deploy
```

بعد از دیپلوی باید کاتالوگ در D1 seed شود (تابع `seedCatalogue` در `src/db/seed.ts`).

## ساختار

```
src/
  index.ts              ورودی Worker + کرون‌ها (سلامت، قیمت‌گذاری، بکاپ)
  api/router.ts         همهٔ endpointها با جدول مسیریابی صریح
  db/schema.sql         ۳۵ جدول با FK و ایندکس
  db/db.ts              لایهٔ دسترسی D1 (همه prepared statement)
  db/seed.ts            seed کاتالوگ در D1
  auth/otp.ts           کد تایید یکبارمصرف + ضداسپم + هشدار کلاستر IP
  auth/session.ts       نشست بازیکن (HMAC) و ادمین (D1)
  net/security.ts       هدرهای امنیتی، Same-Origin، rate limit
  shop/catalog.ts       کاتالوگ محصولات
  shop/pricing.ts       موتور قیمت‌گذاری مبتنی بر داده (سقف ۳۰٪)
  shop/payments.ts      زرین‌پال + کارت‌به‌کارت + بررسی فیش
  anticheat/            ۱۱ لایه تشخیص + امتیازدهی + شواهد + کالیبراسیون ایران
  bots/tiering.ts       انتخاب مدل بات بر اساس ELO لابی
  gamemodes/engine.ts   چرخهٔ عمر مچ و قوانین امتیاز ۱۴ گیم‌مود
  monitor/health.ts     ارزیابی سلامت + backoff بازیابی
  do/objects.ts         ServerLock، Matchmaker، AntiCheatOracle
  ui/                   سایت و پنل ادمین (بدون CDN)
minecraft/              Dockerfile + پریست کم‌مصرف + پلاگین GodBridge

configbot/              ربات فروش کانفیگ VPN (Cloudflare Worker جداگانه)
  src/index.ts            ورودی Worker: وب‌هوک، سایت، API، پنل، کرون‌ها
  src/config/uri.ts       ساخت/اعتبارسنجی URI برای ۶ پروتکل
  src/config/subscription.ts  ۵ فرمت اشتراک (base64, clash, singbox, wg, raw)
  src/config/generate.ts  صدور، چرخش، واترمارک
  src/node/               NodeDriver + MarzbanDriver + MockNodeDriver
  src/pay/gateways.ts     کارت‌به‌کارت، کیف پول، زرین‌پال، نکست‌پی + غربالگری فیش
  src/ai/brain.ts         ابزار-محور؛ پول و سهمیه فقط از D1، هرگز از مدل
  src/api/public.ts       API عمومی سایت (بدون initData)
  src/ui/site.ts          سایت فروش — server-rendered، بدون build step
  src/ui/clients.ts       لینک بیلد رسمی کلاینت‌ها (تأییدشده با GitHub API)
  src/ui/miniapp.ts       مینی‌اپ تلگرام
  src/ui/admin.ts         پنل ادمین
  test/                   ۹ سوئیت، ۳۱۴ تست

docs/FEASIBILITY.md     امکان‌سنجی ماینکرفت با استناد به مستندات رسمی
docs/CONFIGBOT-LIMITS.md    محدودیت‌های صادقانهٔ ConfigBot + فهرست TESTED = NO
```

## ConfigBot — سایت و ربات فروش کانفیگ

```
/            ویترین: پلن‌ها، راهنما، سؤالات
/download    برنامه‌ها: Hiddify، v2rayNG، v2rayN — بیلد رسمی، لینک مستقیم
/panel       کانفیگ‌های من: با لینک اشتراک وارد شو، کانفیگ و وضعیت را ببین
/app         مینی‌اپ تلگرام
/admin       پنل ادمین
/s/<token>   لینک اشتراک (۵ فرمت، بر اساس User-Agent)
/webhook     وب‌هوک تلگرام
```

**چرا فایل exe/apk اختصاصی ندارد:** کلاینت VPN باینری native است و toolchain
و امضای release می‌خواهد. در این محیط هیچ‌کدام نیست، و نصب‌کننده‌ی VPN
امضانشده بدترین چیزی است که می‌شود به کسی داد. به‌جایش همان برنامه‌های
متن‌باز و رسمی لینک شده‌اند؛ نام هر asset از GitHub API گرفته و هر URL با
HEAD تأیید شده. جزئیات در `docs/CONFIGBOT-LIMITS.md` §۵٫۵.

**سرور VPN کجاست؟** روی Cloudflare نمی‌آید — Workers هیچ TCP/UDP خامی ندارند.
Xray یا Marzban باید روی یک VPS باشد؛ بقیه‌ی چیزها (ربات، سایت، مینی‌اپ، پنل،
پرداخت، صدور کانفیگ، لینک اشتراک) همه روی Cloudflare‌اند.

## قانون آنتی‌چیت

هیچ سیگنال تکی باعث بن نمی‌شود. برای جزئیات و اعداد واقعی شبیه‌سازی به
`test/anticheat-simulation.test.ts` نگاه کنید — کارت امتیاز در خروجی تست چاپ می‌شود.

**بن دائم فقط با تایید دستی ادمین.** سیستم به‌صورت ساختاری هیچ‌وقت بن دائم خودکار صادر نمی‌کند
و این هم در لایهٔ امتیازدهی و هم در Durable Object اعمال می‌شود.

## لایسنس

MIT
