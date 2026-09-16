import {
  CLIENTS,
  IOS_NOTE,
  PLATFORM_LABEL,
  PLATFORM_ORDER,
  androidAbiHint,
  type ClientPlatform,
} from './clients';

/**
 * The public website.
 *
 * One place for everything a buyer touches: what they are buying, the client
 * to install, and their own configs. It is server-rendered — no build step, no
 * bundle, nothing to go stale — and every number on it comes from D1.
 *
 * Three rules this file holds to:
 *   1. No dead controls. Every button posts to an endpoint that exists.
 *   2. Nothing is invented. Prices come from the plans table, client links
 *      come from ui/clients.ts (verified against the GitHub API).
 *   3. Where something is not available we say so, rather than showing a
 *      button that fails when clicked.
 */

export interface SitePlan {
  id: string;
  name: string;
  price: number;
  trafficGb: number;
  durationDays: number;
  maxDevices: number;
  badge: string;
}

export interface SiteSettings {
  botName: string;
  currency: string;
  supportChat: string;
  supportChannel: string;
  maintenanceMode: boolean;
  maintenanceMessage: string;
}

export interface SiteOptions {
  mode: 'landing' | 'download' | 'panel';
  plans: SitePlan[];
  settings: SiteSettings;
  /** Detected from User-Agent, only to sort the download list. */
  platform: ClientPlatform;
  userAgent: string | null;
  /** Telegram @username, empty if we could not resolve it. */
  botUsername: string;
  /** Card-to-card is only offered once the admin has set a card number. */
  cardEnabled: boolean;
  publicUrl: string;
  /** Prefill the panel lookup box, e.g. from ?sub=. */
  initialToken?: string;
}

export function renderSite(opts: SiteOptions): string {
  const { mode, settings } = opts;
  const title =
    mode === 'download'
      ? 'دانلود برنامه — ' + settings.botName
      : mode === 'panel'
        ? 'کانفیگ‌های من — ' + settings.botName
        : settings.botName + ' — خرید کانفیگ VPN';

  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index, follow">
<title>${esc(title)}</title>
<meta name="description" content="خرید کانفیگ VPN با لینک اشتراک ثابت، پشتیبانی تلگرام و برنامه‌های رسمی برای اندروید، ویندوز و مک.">
<meta name="theme-color" content="#0b0f14">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔐</text></svg>">
<style>${CSS}</style>
</head>
<body>
${header(opts)}
${settings.maintenanceMode ? maintenance(settings) : ''}
<main>
${mode === 'landing' ? landing(opts) : ''}
${mode === 'download' ? downloadPage(opts) : ''}
${mode === 'panel' ? panelPage(opts) : ''}
</main>
${footer(opts)}
<script>${JS}</script>
</body>
</html>`;
}

// -------------------------------------------------------------------- parts --

function header(o: SiteOptions): string {
  const link = (href: string, label: string, active: boolean) =>
    `<a class="${active ? 'on' : ''}" href="${href}">${label}</a>`;
  return `<header class="bar">
  <div class="wrap nav">
    <a class="brand" href="/"><span class="logo">🔐</span> ${esc(o.settings.botName)}</a>
    <nav>
      ${link('/', 'خانه', o.mode === 'landing')}
      ${link('/download', 'دانلود برنامه', o.mode === 'download')}
      ${link('/panel', 'کانفیگ‌های من', o.mode === 'panel')}
    </nav>
  </div>
</header>`;
}

function maintenance(s: SiteSettings): string {
  return `<div class="wrap"><div class="note warn">🛠 ${esc(
    s.maintenanceMessage || 'سایت موقتاً در حالت نگهداری است.',
  )}</div></div>`;
}

function landing(o: SiteOptions): string {
  const { settings } = o;
  return `
<section class="hero">
  <h1>کانفیگ VPN، بدون دردسر</h1>
  <p class="lede">لینک اشتراک ثابت، سرعت روی سرورهای اختصاصی، و پشتیبانی که جواب می‌دهد.
     یک بار لینک را در برنامه وارد می‌کنی و تمام.</p>
  <div class="cta">
    <a class="btn" href="#plans">دیدن پلن‌ها</a>
    <a class="btn ghost" href="/download">دانلود برنامه</a>
    ${o.botUsername ? `<a class="btn ghost" href="https://t.me/${esc(o.botUsername)}">ربات تلگرام</a>` : ''}
  </div>
</section>

<section class="wrap" id="plans">
  <h2>پلن‌ها</h2>
  ${settings.maintenanceMode ? '' : plans(o.plans, settings.currency, o.cardEnabled)}
</section>

<section class="wrap split">
  <div>
    <h2>چطور وصل شوم؟</h2>
    <ol class="steps">
      <li><b>برنامه را نصب کن.</b> از <a href="/download">صفحه‌ی دانلود</a> نسخه‌ی گوشی یا کامپیوترت را بردار.</li>
      <li><b>لینک اشتراک را بگیر.</b> بعد از خرید، هم در تلگرام و هم در <a href="/panel">صفحه‌ی کانفیگ‌های من</a> هست.</li>
      <li><b>وارد کن و وصل شو.</b> در برنامه گزینه‌ی «افزودن از لینک» را بزن و لینک را paste کن.</li>
    </ol>
  </div>
  <div>
    <h2>لینک اشتراک یعنی چه؟</h2>
    <p>یک آدرس ثابت که همه‌ی کانفیگ‌هایت داخلش است. هر بار که برنامه را به‌روز می‌کنی،
       لیست تازه را می‌گیرد. اگر کانفیگی از کار بیفتد، ما سمت سرور عوضش می‌کنیم و
       <b>لینک تو عوض نمی‌شود</b> — فقط یک بار دیگر به‌روزش کن.</p>
    <div class="note">اگر لینک اشتراک را قبلاً گرفته‌ای،
      <a href="/panel">اینجا</a> بزن تا کانفیگ‌هایت را ببینی.</div>
  </div>
</section>

<section class="wrap">
  <h2>دانلود برنامه</h2>
  <p>ما برنامه‌ی اختصاصی نمی‌سازیم و فایل امضانشده جعل نمی‌کنیم. این‌ها همان
     برنامه‌های متن‌باز و رسمی‌اند که everybody استفاده می‌کند، با لینک مستقیم
     به نسخه‌ی اصلی.</p>
  ${clientCards(o, 4)}
  <p><a class="btn ghost" href="/download">همه‌ی نسخه‌ها و راهنمای نصب</a></p>
</section>

<section class="wrap faq">
  <h2>سؤال‌های رایج</h2>
  <details><summary>لینک اشتراک کار نمی‌کند.</summary>
    <p>اول در برنامه «به‌روزرسانی اشتراک» را بزن. اگر درست نشد، در
    <a href="/panel">صفحه‌ی کانفیگ‌های من</a> وضعیت را ببین: ممکن است اشتراک تمام شده باشد.</p></details>
  <details><summary>کانفیگ‌ها لو رفته‌اند؟</summary>
    <p>هر کانفیگی که می‌گیری یک نشان یکتا دارد. اگر جایی پخش شود، از روی همان نشان
    پیدا می‌شود که از حساب کدام کاربر بوده. پس لینک اشتراکت را عمومی نکن.</p></details>
  <details><summary>چطور پرداخت کنم؟</summary>
    <p>${
      o.cardEnabled
        ? 'کارت‌به‌کارت همیشه فعال است: سفارش را ثبت کن، واریز کن، عکس فیش را بفرست. تأیید معمولاً چند دقیقه طول می‌کشد.'
        : 'در حال حاضر پرداخت از طریق ربات تلگرام انجام می‌شود. برای خرید به ربات پیام بده.'
    }</p></details>
  <details><summary>روی آیفون چه کنم؟</summary>
    <p>${esc(IOS_NOTE)}</p></details>
</section>`;
}

function downloadPage(o: SiteOptions): string {
  const hint = o.platform === 'android' ? androidAbiHint(o.userAgent) : '';
  return `
<section class="wrap">
  <h1>دانلود برنامه</h1>
  <p class="lede">این‌ها بیلد رسمی خود پروژه‌ها هستند، مستقیم از GitHub. ما فایل را
     دوباره بسته‌بندی نمی‌کنیم، چون یک نصب‌کننده‌ی VPN که منبعش معلوم نباشد
     بدترین چیزی است که می‌توانی روی گوشی‌ات نصب کنی.</p>
  ${hint ? `<div class="note">${esc(hint)}</div>` : ''}
  ${PLATFORM_ORDER.map((p) => platformBlock(o, p)).join('\n')}
</section>

<section class="wrap">
  <h2>بعد از نصب</h2>
  <ol class="steps">
    <li>برنامه را باز کن و گزینه‌ی <b>«افزودن پروفایل از لینک»</b> را بزن.</li>
    <li>لینک اشتراکت را paste کن. اگر لینک را نداری، از <a href="/panel">صفحه‌ی کانفیگ‌های من</a> بردار.</li>
    <li>ذخیره کن و دکمه‌ی اتصال را بزن. تمام.</li>
  </ol>
  <div class="note">لینک اشتراک مثل رمز عبور است. هرکس آن را داشته باشد به
    ترافیک تو وصل می‌شود، پس در کانال عمومی نگذارش.</div>
</section>`;
}

function platformBlock(o: SiteOptions, p: ClientPlatform): string {
  const list = CLIENTS.filter((c) => c.platform === p);
  const label = PLATFORM_LABEL[p];
  if (!list.length) {
    return `<div class="plat" id="p-${p}">
      <h3>${esc(label)}</h3>
      <div class="note">${esc(IOS_NOTE)}</div>
    </div>`;
  }
  return `<div class="plat" id="p-${p}">
    <h3>${esc(label)}</h3>
    <div class="cards">
      ${list.map((c) => clientCard(c)).join('\n')}
    </div>
  </div>`;
}

function clientCards(o: SiteOptions, limit: number): string {
  // Show the recommended one per platform, most-used platforms first.
  const picks: typeof CLIENTS = [];
  for (const p of PLATFORM_ORDER) {
    const primary = CLIENTS.find((c) => c.platform === p && c.primary);
    if (primary) picks.push(primary);
    if (picks.length >= limit) break;
  }
  return `<div class="cards">${picks.map(clientCard).join('\n')}</div>`;
}

function clientCard(c: (typeof CLIENTS)[number]): string {
  const ext = c.ext.toUpperCase();
  return `<article class="card${c.primary ? ' primary' : ''}">
    <div class="card-top">
      <h4>${esc(c.name)}</h4>
      ${c.primary ? '<span class="tag">پیشنهادی</span>' : ''}
    </div>
    <p class="muted">${esc(c.why)}</p>
    <ul class="meta">
      <li>${esc(c.arch)}</li>
      <li>فایل ${ext} · ${c.sizeMb} مگابایت</li>
    </ul>
    <a class="btn" href="${esc(c.url)}" rel="nofollow noopener" target="_blank">
      دانلود ${ext}
    </a>
    <p class="src">منبع: ${esc(c.source)}</p>
  </article>`;
}

function panelPage(o: SiteOptions): string {
  const token = o.initialToken ?? '';
  return `
<section class="wrap narrow">
  <h1>کانفیگ‌های من</h1>
  <p class="lede">لینک اشتراکت را وارد کن تا کانفیگ‌ها، وضعیت و تاریخ انقضا را ببینی.
     لازم نیست وارد حساب شوی — خودِ لینک، کلید است.</p>

  <form id="lookup" class="row" autocomplete="off">
    <input id="token" name="token" type="text" inputmode="url"
      placeholder="https://…/s/… یا فقط توکن"
      value="${esc(token)}">
    <button class="btn" type="submit">نمایش</button>
  </form>
  <p class="muted">لینک اشتراک را در تلگرام، در پیام «اشتراک شما» پیدا می‌کنی.</p>

  <div id="result" aria-live="polite"></div>
</section>`;
}

function plans(list: SitePlan[], currency: string, cardEnabled: boolean): string {
  if (!list.length) {
    return `<div class="note warn">فعلاً پلنی برای فروش فعال نیست. برای اطلاع به پشتیبانی پیام بده.</div>`;
  }
  return `<div class="cards plans">${list
    .map((p) => {
      const unlimited = p.trafficGb <= 0;
      return `<article class="card plan${p.badge ? ' primary' : ''}">
        <div class="card-top">
          <h4>${esc(p.name)}</h4>
          ${p.badge ? `<span class="tag">${esc(p.badge)}</span>` : ''}
        </div>
        <div class="price">${money(p.price)} <small>${esc(currency)}</small></div>
        <ul class="meta">
          <li>${p.durationDays} روز</li>
          <li>${unlimited ? 'حجم نامحدود' : `${p.trafficGb} گیگابایت`}</li>
          <li>${p.maxDevices > 0 ? `${p.maxDevices} دستگاه` : 'بدون محدودیت دستگاه'}</li>
        </ul>
        ${
          cardEnabled
            ? `<button class="btn buy" data-plan="${esc(p.id)}" data-name="${esc(p.name)}">خرید</button>`
            : `<a class="btn" href="#plans" data-via-bot="1">خرید از ربات</a>`
        }
      </article>`;
    })
    .join('\n')}</div>
  <div id="buybox" hidden></div>`;
}

function money(n: number): string {
  return n.toLocaleString('fa-IR');
}

function footer(o: SiteOptions): string {
  const s = o.settings;
  const links: string[] = [];
  if (s.supportChat) links.push(`<a href="${esc(s.supportChat)}">پشتیبانی</a>`);
  if (s.supportChannel) links.push(`<a href="${esc(s.supportChannel)}">کانال</a>`);
  if (o.botUsername) links.push(`<a href="https://t.me/${esc(o.botUsername)}">ربات</a>`);
  return `<footer class="bar">
  <div class="wrap nav foot">
    <span>${esc(s.botName)}</span>
    <span>${links.join(' · ')}</span>
  </div>
</footer>`;
}

// -------------------------------------------------------------------- css ----

const CSS = `
:root{color-scheme:dark;--bg:#0b0f14;--bg2:#111820;--fg:#e6edf3;--mut:#93a4b5;
--acc:#2f81f7;--ok:#2ea043;--warn:#d29922;--line:#1f2933;--rad:.75rem}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;line-height:1.85}
a{color:var(--acc);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:64rem;margin:0 auto;padding:1.25rem}
.wrap.narrow{max-width:40rem}
h1{font-size:1.9rem;margin:.2rem 0 .6rem}
h2{font-size:1.3rem;margin:2.2rem 0 .8rem}
h3{font-size:1.05rem;margin:1.6rem 0 .6rem}
h4{margin:0;font-size:1.05rem}
p{color:#c8d4df}
.lede{color:var(--mut);font-size:1.05rem;max-width:44rem}
.muted{color:var(--mut);font-size:.85rem}
.bar{background:var(--bg2);border-bottom:1px solid var(--line)}
footer.bar{border-bottom:0;border-top:1px solid var(--line);margin-top:3rem}
.nav{display:flex;align-items:center;gap:1rem;justify-content:space-between;flex-wrap:wrap}
.nav nav{display:flex;gap:.25rem;flex-wrap:wrap}
.nav a{color:var(--mut);padding:.55rem .8rem;border-radius:.5rem}
.nav a:hover{color:var(--fg);background:#182230;text-decoration:none}
.nav a.on{color:var(--fg);background:#182230}
.brand{color:var(--fg)!important;font-weight:700}
.logo{margin-inline-end:.2rem}
.foot{color:var(--mut);font-size:.85rem}
.hero{max-width:64rem;margin:0 auto;padding:3rem 1.25rem 1rem}
.cta{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.2rem}
.btn{display:inline-block;padding:.62rem 1.15rem;border-radius:.6rem;background:var(--acc);
color:#fff;font-weight:600;border:0;cursor:pointer;font-size:.95rem;font-family:inherit}
.btn:hover{filter:brightness(1.1);text-decoration:none}
.btn.ghost{background:#182230;color:var(--fg);border:1px solid var(--line)}
.cards{display:grid;gap:.9rem;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:var(--rad);padding:1rem}
.card.primary{border-color:#2b4a75}
.card-top{display:flex;align-items:center;gap:.5rem;justify-content:space-between}
.tag{background:#182230;border:1px solid #2b4a75;color:#9ec5fe;border-radius:1rem;
padding:.05rem .55rem;font-size:.72rem;white-space:nowrap}
.meta{list-style:none;padding:0;margin:.6rem 0;color:var(--mut);font-size:.85rem}
.meta li{padding:.12rem 0}
.meta li::before{content:"· ";color:#3d4b5a}
.src{color:#5b6b7c;font-size:.72rem;margin:.6rem 0 0}
.price{font-size:1.5rem;font-weight:700;margin:.5rem 0}
.price small{font-size:.8rem;color:var(--mut);font-weight:400}
.plat{margin-top:1rem}
.split{display:grid;gap:2rem;grid-template-columns:1fr 1fr}
@media(max-width:44rem){.split{grid-template-columns:1fr}}
.steps{padding-inline-start:1.2rem}
.steps li{margin:.5rem 0}
.note{background:#12202e;border:1px solid #1d3a55;
border-radius:.6rem;padding:.7rem .9rem;font-size:.9rem;margin:.8rem 0}
.note.warn{background:#2a2410;border-color:#5c4a17}
.faq details{background:var(--bg2);border:1px solid var(--line);border-radius:.6rem;
padding:.7rem .9rem;margin:.5rem 0}
.faq summary{cursor:pointer;font-weight:600}
.row{display:flex;gap:.5rem;flex-wrap:wrap}
.row input{flex:1;min-width:14rem}
input,select{background:#0d141b;border:1px solid var(--line);color:var(--fg);
border-radius:.5rem;padding:.6rem .7rem;font-family:inherit;font-size:.95rem}
input:focus{outline:2px solid var(--acc);outline-offset:-1px}
.box{background:var(--bg2);border:1px solid var(--line);border-radius:var(--rad);
padding:1rem;margin:1rem 0}
.ok{color:#4ac26b}.bad{color:#f0776d}.mid{color:var(--warn)}
pre.uri{background:#0d141b;border:1px solid var(--line);border-radius:.5rem;
padding:.6rem;overflow-x:auto;font-size:.75rem;direction:ltr;text-align:left;
white-space:pre-wrap;word-break:break-all;color:#a9c7e8;margin:.4rem 0}
.paybox{background:#0d141b;border:1px solid var(--line);border-radius:.5rem;
padding:.8rem .9rem;font-size:.92rem;line-height:2}
.paybox pre{background:#111a23;border:1px solid var(--line);border-radius:.4rem;
padding:.6rem;direction:ltr;text-align:left;font-size:1.05rem;letter-spacing:.06em;
overflow-x:auto;margin:.5rem 0}
.paybox code{background:#111a23;border:1px solid var(--line);border-radius:.3rem;
padding:.05rem .35rem;direction:ltr;display:inline-block}
.paybox strong{color:#fff}
.sublink{background:#0d141b;border:1px solid var(--line);border-radius:.5rem;
padding:.6rem;direction:ltr;text-align:left;word-break:break-all;font-size:.8rem}
.kv{display:grid;grid-template-columns:auto 1fr;gap:.2rem .9rem;font-size:.9rem}
.kv dt{color:var(--mut)}
.kv dd{margin:0}
.spin{display:inline-block;width:.9rem;height:.9rem;border:2px solid #33475c;
border-top-color:var(--acc);border-radius:50%;animation:s .7s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
`;

// --------------------------------------------------------------------- js ----

/**
 * Everything the page does client-side.
 *
 * Deliberately small and dependency-free: it talks to `/pub/api/*` with
 * `fetch`, and it never stores the subscription token anywhere but the URL
 * hash, so a shared computer does not keep it.
 */
const JS = `
(function(){
  var $ = function(s,r){ return (r||document).querySelector(s); };
  var out = $('#result');

  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function tokenFrom(v){
    v = (v||'').trim();
    var m = v.match(/\\/s\\/([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : v.replace(/[^A-Za-z0-9_-]/g,'');
  }

  function fmtDate(ms){
    if(!ms) return '—';
    try { return new Date(ms).toLocaleDateString('fa-IR'); } catch(e){ return '—'; }
  }
  function days(ms){
    if(!ms) return null;
    return Math.ceil((ms - Date.now())/86400000);
  }

  async function lookup(tok){
    if(!out) return;
    out.innerHTML = '<p><span class="spin"></span> در حال گرفتن کانفیگ‌ها…</p>';
    var r;
    try { r = await fetch('/pub/api/subscription?token=' + encodeURIComponent(tok)); }
    catch(e){ out.innerHTML = '<p class="bad">خطای شبکه. دوباره تلاش کن.</p>'; return; }
    var d;
    try { d = await r.json(); } catch(e){ out.innerHTML = '<p class="bad">پاسخ نامعتبر بود.</p>'; return; }
    if(!d.ok){ out.innerHTML = '<p class="bad">' + esc(d.error || 'پیدا نشد') + '</p>'; return; }
    render(d);
    if(history.replaceState) history.replaceState(null,'','#' + tok);
  }

  function render(d){
    var s = d.subscription;
    var dLeft = days(s.expiresAt);
    var stateCls = s.status === 'active' ? 'ok' : 'bad';
    var stateTxt = s.status === 'active' ? 'فعال' :
                   s.status === 'expired' ? 'منقضی شده' :
                   s.status === 'suspended' ? 'غیرفعال شده' : s.status;
    var pct = s.trafficGb > 0 ? Math.min(100, Math.round(s.usedGb / s.trafficGb * 100)) : 0;

    var h = '<div class="box">';
    h += '<dl class="kv">';
    h += '<dt>وضعیت</dt><dd class="' + stateCls + '">' + esc(stateTxt) + '</dd>';
    h += '<dt>انقضا</dt><dd>' + fmtDate(s.expiresAt) +
         (dLeft !== null ? ' <span class="muted">(' + (dLeft > 0 ? dLeft + ' روز مانده' : 'تمام شده') + ')</span>' : '') + '</dd>';
    h += '<dt>حجم</dt><dd>' + (s.trafficGb > 0
          ? s.usedGb + ' از ' + s.trafficGb + ' گیگابایت (' + pct + '٪)'
          : 'نامحدود') + '</dd>';
    h += '<dt>چرخش‌ها</dt><dd>' + s.rotationCount + '</dd>';
    h += '</dl>';

    h += '<h3>لینک اشتراک</h3>';
    h += '<div class="sublink" id="suburl">' + esc(d.subUrl) + '</div>';
    h += '<p><button class="btn ghost" id="copy">کپی لینک</button> ';
    h += '<a class="btn" href="/download">دانلود برنامه</a></p>';

    if(d.configs && d.configs.length){
      h += '<h3>کانفیگ‌ها (' + d.configs.length + ')</h3>';
      d.configs.forEach(function(c){
        h += '<p class="muted" style="margin-bottom:0">' + esc(c.remark) + '</p>';
        h += '<pre class="uri">' + esc(c.uri) + '</pre>';
      });
      h += '<p><button class="btn ghost" id="copyall">کپی همه</button></p>';
    } else {
      h += '<div class="note warn">کانفیگ فعالی روی این اشتراک نیست. به پشتیبانی پیام بده.</div>';
    }
    h += '</div>';
    out.innerHTML = h;

    var cp = $('#copy');
    if(cp) cp.onclick = function(){ copy(d.subUrl, cp, 'لینک کپی شد'); };
    var ca = $('#copyall');
    if(ca) ca.onclick = function(){
      copy(d.configs.map(function(c){return c.uri;}).join('\\n'), ca, 'کپی شد');
    };
  }

  function copy(text, btn, msg){
    var done = function(){ var t = btn.textContent; btn.textContent = msg;
      setTimeout(function(){ btn.textContent = t; }, 1600); };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done, function(){ fallback(text, done); });
    } else { fallback(text, done); }
  }
  function fallback(text, done){
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch(e){}
    document.body.removeChild(ta);
  }

  var form = $('#lookup');
  if(form) form.onsubmit = function(e){
    e.preventDefault();
    var tok = tokenFrom($('#token').value);
    if(!tok){ out.innerHTML = '<p class="bad">لینک یا توکن را وارد کن.</p>'; return; }
    lookup(tok);
  };

  // Deep link: /panel#<token>
  if(form && location.hash.length > 3) {
    $('#token').value = location.hash.slice(1);
    lookup(tokenFrom(location.hash.slice(1)));
  } else if(form && $('#token').value) {
    lookup(tokenFrom($('#token').value));
  }

  // Buy buttons: reveal the order form instead of pretending to pay in place.
  document.querySelectorAll('.buy').forEach(function(b){
    b.onclick = function(){ openBuy(b.dataset.plan, b.dataset.name); };
  });

  function openBuy(planId, planName){
    var box = $('#buybox');
    if(!box) return;
    box.hidden = false;
    box.innerHTML =
      '<div class="box"><h3>خرید «' + esc(planName) + '»</h3>' +
      '<p>برای ثبت سفارش باید یک حساب تلگرام داشته باشیم تا کانفیگ را به آن تحویل بدهیم.</p>' +
      '<form id="buyform" class="row">' +
      '<input id="tg" type="text" inputmode="numeric" placeholder="آیدی عددی تلگرام (مثلاً 123456789)">' +
      '<button class="btn" type="submit">ثبت سفارش</button></form>' +
      '<p class="muted">آیدی عددی‌ات را از ربات @userinfobot بگیر. بعد از ثبت، ' +
      'اطلاعات کارت و کد پیگیری را همین‌جا می‌بینی.</p>' +
      '<div id="buyres"></div></div>';
    box.scrollIntoView({behavior:'smooth', block:'center'});
    $('#buyform').onsubmit = function(e){
      e.preventDefault();
      var tg = $('#tg').value.trim();
      var res = $('#buyres');
      if(!/^\\d{5,}$/.test(tg)){ res.innerHTML = '<p class="bad">آیدی تلگرام باید عدد باشد.</p>'; return; }
      res.innerHTML = '<p><span class="spin"></span> در حال ثبت سفارش…</p>';
      fetch('/pub/api/order', {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ planId: planId, telegramId: Number(tg) })
      }).then(function(r){ return r.json(); }).then(function(d){
        if(!d.ok){ res.innerHTML = '<p class="bad">' + esc(d.error||'خطا') + '</p>'; return; }
        showCheckout(res, d);
      }, function(){ res.innerHTML = '<p class="bad">خطای شبکه.</p>'; });
    };
  }

  /**
   * The second half of checkout: pay, then hand us the receipt.
   *
   * This is the step that was missing entirely — the order was created and the
   * page then linked to a field the API never returned, so a web buyer could
   * place an order and had no way to pay for it. Everything here reads only
   * fields that placeOrder actually sends back. (No backticks in this comment:
   * the whole block is a template literal, and a stray one closes the string.)
   */
  function showCheckout(res, d){
    var h = '<div class="note"><b>سفارش ' + esc(d.orderCode) + ' ثبت شد.</b><br>' +
            'مبلغ قابل پرداخت: <b>' + esc(d.amountText) + '</b></div>';

    if(!d.pay || d.pay.kind !== 'instructions'){
      h += '<div class="note warn">' +
           esc((d.pay && d.pay.reason) || 'پرداخت آنلاین فعال نیست.') +
           '</div>';
      res.innerHTML = h;
      return;
    }

    h += '<h3>۱. واریز کن</h3>';
    // d.pay.html is escaped-then-marked-up server side, so it goes in as HTML.
    // Falling back to the escaped raw text keeps this safe if html is absent.
    h += d.pay.html
      ? '<div class="paybox">' + d.pay.html + '</div>'
      : '<pre class="uri">' + esc(d.pay.text || '') + '</pre>';
    if(d.pay.tracking){
      h += '<p>کد پیگیری سفارش: <b>' + esc(d.pay.tracking) + '</b><br>' +
           '<span class="muted">همین کد را در توضیحات انتقال بنویس، وگرنه ' +
           'پرداختت به این سفارش وصل نمی‌شود.</span></p>';
    }

    h += '<h3>۲. عکس فیش را بفرست</h3>';
    h += '<form id="rcpt">' +
         '<div class="row"><input id="rname" placeholder="نام صاحب کارت" required></div>' +
         '<div class="row"><input id="rcard" inputmode="numeric" placeholder="شماره کارت پرداخت‌کننده" required></div>' +
         '<div class="row"><input id="rtrack" placeholder="کد پیگیری بانک" value="' +
           esc(d.pay.tracking || '') + '" required></div>' +
         '<div class="row"><input id="rnote" placeholder="متن توضیحاتی که نوشتی (مثلاً: ۹۰۰۰۰ تومان)"></div>' +
         '<div class="row"><input id="rphoto" type="file" accept="image/jpeg,image/png,image/webp" required></div>' +
         '<button class="btn" type="submit">ارسال فیش</button>' +
         '</form>';
    h += '<div id="rcptres"></div>';
    res.innerHTML = h;

    var f = $('#rcpt');
    if(!f) return;
    f.onsubmit = function(e){
      e.preventDefault();
      var out = $('#rcptres');
      var file = $('#rphoto').files[0];
      if(!file){ out.innerHTML = '<p class="bad">عکس فیش را انتخاب کن.</p>'; return; }
      if(file.size > 5 * 1024 * 1024){
        out.innerHTML = '<p class="bad">حجم عکس باید کمتر از ۵ مگابایت باشد.</p>'; return;
      }

      var fd = new FormData();
      fd.set('photo', file);
      fd.set('payerName', $('#rname').value.trim());
      fd.set('payerCard', $('#rcard').value.trim());
      fd.set('trackingCode', $('#rtrack').value.trim());
      fd.set('note', $('#rnote').value.trim());

      out.innerHTML = '<p><span class="spin"></span> در حال ارسال فیش…</p>';
      fetch('/pub/api/receipt', { method:'POST', body: fd })
        .then(function(r){ return r.json().then(function(j){ return { status:r.status, body:j }; }); })
        .then(function(x){
          var b = x.body || {};
          if(!b.ok){
            out.innerHTML = '<p class="bad">' + esc(b.error || ('خطا (' + x.status + ')')) + '</p>';
            return;
          }
          if(b.alreadyPaid){
            out.innerHTML = '<div class="note ok">این سفارش قبلاً پرداخت شده.</div>';
            return;
          }
          out.innerHTML = '<div class="note ' + (b.autoApproved ? 'ok' : '') + '">' +
            esc(b.message || 'فیشت ثبت شد.') + '</div>';
          f.querySelector('button[type=submit]').disabled = true;
        }, function(){ out.innerHTML = '<p class="bad">خطای شبکه. دوباره تلاش کن.</p>'; });
    };
  }

  // Plans with no card configured: send them to the bot rather than failing.
  document.querySelectorAll('[data-via-bot]').forEach(function(a){
    a.onclick = function(){
      a.textContent = 'در تلگرام به ربات پیام بده';
    };
  });
})();
`;

// ------------------------------------------------------------------ helpers --

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
