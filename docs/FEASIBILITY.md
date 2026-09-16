# Technical Feasibility — Minecraft on Cloudflare

Verified 2026-09-15 against official Cloudflare documentation. No claim in this
file is a guess; each one names the source that settles it.

---

## 1. Bedrock Edition (UDP 19132) — **NOT POSSIBLE on Cloudflare-only**

Cloudflare Spectrum's own limitations page states verbatim:

> **"Minecraft Java Edition is supported but Minecraft Bedrock Edition is not
> supported."**
> — <https://developers.cloudflare.com/spectrum/reference/limitations/>

Public UDP additionally requires BYOIP, which is an Enterprise feature:

> "Spectrum UDP applications are supported with BYOIP… They are not currently
> supported with Magic Transit service bindings."

And Cloudflare Tunnel has never supported public UDP — the feature request
[`cloudflared#964`](https://github.com/cloudflare/cloudflared/issues/964) has
been open since 2022 with no resolution. UDP inside Zero Trust exists, but only
for clients running WARP and joined to your organisation, which no public
Minecraft player will do.

**Conclusion: there is no Cloudflare-only path to Bedrock on UDP 19132.**
`wrangler.jsonc` therefore defaults `bedrock_enabled = 0`, and the schema stores
`bedrock_port` as nullable. Nothing in this repository pretends a TCP or
WebSocket endpoint is a UDP Bedrock server.

---

## 2. Java Edition (TCP 25565) — **possible, but not Cloudflare-only, and untestable here**

What exists:

| Mechanism | Status | Blocks a Cloudflare-only Minecraft server because… |
|---|---|---|
| Spectrum `tcp/25565` | GA, **Pro plan and up**, one Minecraft app | It is a *proxy*. It needs a real origin server to forward bytes to. It does not execute Minecraft. |
| Spectrum arbitrary TCP/UDP | **Enterprise only**, paid add-on | Same — still needs an origin. |
| Workers `connect(socket)` inbound handler | **Private beta**, behind an experimental compat flag (announced 2026-08-03) | Would let a Worker terminate TCP and pipe it into a Container via `getTcpPort()`. Not GA, so it cannot be relied on in production. |

Source for the plan matrix: <https://developers.cloudflare.com/spectrum/protocols-per-plan/>

> | | Free | Pro | Business | Enterprise |
> |---|---|---|---|---|
> | TCP / UDP | No | No | No | Paid add-on |
> | Minecraft (one app) | No | Yes | Yes | Yes |

Also relevant: Spectrum's Minecraft allowance is **5 GB/month on Pro, 10 GB on
Business, then $1/GB overage**. A populated Minecraft server exhausts that
quickly.

**Conclusion: Java Edition can be fronted by Cloudflare, but the game process
itself must run somewhere that exposes TCP — i.e. outside Cloudflare, or inside
a Container reached via the private-beta `connect()` path.**

---

## 3. What this repository actually does

It is **not** a fake Minecraft server. It is the platform layer, which *is*
fully supported by Cloudflare:

```
Player (browser)                Player (Minecraft client)
        |                                |
        v                                v
Cloudflare edge                 [ OUT OF SCOPE for Cloudflare-only ]
        |                        needs a TCP origin, see section 2
        v
   Worker (src/index.ts)
    |    |    |    |
    |    |    |    +---> Durable Objects
    |    |    |            ServerLock      (single-instance guarantee)
    |    |    |            Matchmaker      (queues, bot backfill)
    |    |    |            AntiCheatOracle (per-player signal state)
    |    |    |
    |    |    +---------> D1   (users, servers, orders, bans, appeals, audit)
    |    +--------------> KV   (cache, rate limits, OTP challenge metadata)
    +-------------------> R2   (payment receipts, world snapshots, art)
                             |
                             +--> Cron Triggers (health, pricing, backups)
```

The Minecraft runtime reports heartbeat/status to this platform over HTTP. The
platform never claims to *be* the game server.

---

## 4. `CLOUDFLARE_LOW_RESOURCE` preset — **not benchmarked**

`src/config.ts` ships conservative starting values (20 players, view distance 6,
simulation distance 4, 35 mob cap, 10 ms redstone budget).

**These have NOT been benchmarked on Cloudflare Containers.** They are safe
defaults, not measured optima, and the code comments say so explicitly. Treat
them as a starting point and profile before trusting any number.

---

## 5. What could not be verified from this environment

| Item | Result |
|---|---|
| `api.cloudflare.com` reachable | **No** (HTTP 000) |
| `wrangler whoami` | `You are not authenticated` |
| `wrangler deploy --temporary` | `fetch failed` |

So **no deployment was performed and no live URL exists.** Anything claiming
otherwise would be false. Deployment requires the operator to authenticate with
their own Cloudflare account:

```bash
wrangler login
wrangler d1 create minecraft-god-server     # put the id in wrangler.jsonc
wrangler kv namespace create GODKV          # put the id in wrangler.jsonc
wrangler r2 bucket create minecraft-god-server
npm run db:apply:remote
wrangler secret put ADMIN_PASSWORD
wrangler secret put SESSION_SECRET
wrangler secret put OTP_SECRET
wrangler deploy
```

What *was* verified locally, with real tooling:

- `tsc --noEmit` — clean
- `vitest run` — 15 tests passing
- `src/db/schema.sql` applied against a real Miniflare D1 (SQLite), including
  foreign-key and unique-constraint enforcement

---

## 6. "۶۰۰ پلیر روی کلادفلر رایگان" — ناممکن، و چرا

این یک محدودیت نرم‌افزاری نیست که با بهینه‌سازی حل شود. اعداد:

| منبع | محدودیت پلن رایگان Workers |
|---|---|
| CPU | ۱۰ میلی‌ثانیه در هر درخواست |
| Containers | **اصلاً در پلن رایگان نیست** (نیاز به Workers Paid) |
| ورودی عمومی TCP | ندارد |
| ورودی عمومی UDP | ندارد |
| Durable Objects | موجود، ولی برای state کوچک |

یک سرور ماینکرفت با ۶۰۰ پلیر هم‌زمان به طور واقع‌بینانه نیاز دارد به:

- **۴ تا ۸ گیگابایت RAM** (هر پلیر + موجودات + chunkها)
- **چند هستهٔ CPU اختصاصی** با tick ثابت ۵۰ms
- **پهنای باند پایدار** برای ۶۰۰ اتصال باز

این اعداد با Workers/Durable Objects جور نمی‌شوند، چون آن سرویس‌ها برای
درخواست‌های کوتاه و stateless طراحی شده‌اند، نه برای یک فرآیند پردازهٔ دائمی
با حافظهٔ بزرگ. **هیچ مقدار بهینه‌سازی کد این شکاف را پر نمی‌کند.**

### آنچه واقع‌بینانه شدنی است

| مقیاس | زیرساخت |
|---|---|
| پلتفرم وب برای هزاران کاربر | ✅ Workers رایگان کاملاً کافی است |
| ۲۰–۴۰ پلیر ماینکرفت | یک VPS کوچک + پریست `CLOUDFLARE_LOW_RESOURCE` |
| ۶۰۰ پلیر ماینکرفت | سرور اختصاصی با ۸–۱۶ گیگ RAM (خارج از Cloudflare) |

معماری این پروژه طوری است که **لایهٔ وب روی Cloudflare بماند** و رانتایم بازی
هرجا که TCP مجاز است اجرا شود و از طریق `minecraft/plugin/GodBridge.java` به
پلتفرم گزارش بدهد. این جداسازی عمدی است.
