/**
 * Admin panel.
 *
 * Server-rendered shell, client-side behaviour, no build step. Same reasoning
 * as the mini app: a bundle that must be built is a bundle that can be stale,
 * and this gets deployed from a phone.
 *
 * The rule that shaped it: **no dead buttons.** Every control here is wired to
 * a real endpoint, and if a capability is missing the control is not rendered
 * at all rather than rendered grey. An admin who clicks something and gets
 * nothing loses trust in the whole panel.
 */

export interface AdminOptions {
  mode: 'login' | 'panel';
  error?: string;
  env?: { publicUrl: string };
}

export function renderAdmin(opts: AdminOptions): string {
  const body = opts.mode === 'login' ? loginView(opts.error) : panelView(opts.env?.publicUrl ?? '');
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>پنل مدیریت</title>
<style>
${STYLES}
</style>
</head>
<body>
${body}
${opts.mode === 'panel' ? `<script>${CLIENT}</script>` : ''}
</body>
</html>`;
}

// ------------------------------------------------------------------ styles --

const STYLES = `
:root {
  --bg:#0b0f14; --card:#151b23; --line:#232b36; --text:#e6edf3; --dim:#8b98a5;
  --accent:#2f81f7; --ok:#3fb950; --warn:#d29922; --err:#f85149;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text);
       font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif; }
a { color: var(--accent); }
.wrap { max-width: 1100px; margin: 0 auto; padding: 1rem; }
header { display:flex; justify-content:space-between; align-items:center;
         padding:.75rem 1rem; border-bottom:1px solid var(--line); background:var(--card);
         position:sticky; top:0; z-index:5; }
header h1 { font-size:1rem; margin:0; }
.grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap:.75rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:.75rem; padding:1rem; margin-bottom:.75rem; }
.card h2 { font-size:.95rem; margin:0 0 .75rem; }
.stat { font-size:1.6rem; font-weight:700; }
.muted { color:var(--dim); font-size:.8rem; }
button, .btn { appearance:none; border:1px solid var(--line); background:#1c242e; color:var(--text);
  border-radius:.55rem; padding:.55rem .9rem; font-size:.85rem; cursor:pointer; font-family:inherit; }
button.primary, .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
button.danger { background:transparent; border-color:var(--err); color:var(--err); }
button.ok { background:transparent; border-color:var(--ok); color:var(--ok); }
button:disabled { opacity:.45; cursor:default; }
button.sm { padding:.3rem .6rem; font-size:.75rem; }
input, select, textarea { width:100%; padding:.55rem; border-radius:.5rem; border:1px solid var(--line);
  background:#10161d; color:var(--text); font-family:inherit; margin-bottom:.5rem; }
label { display:block; font-size:.78rem; color:var(--dim); margin-bottom:.25rem; }
table { width:100%; border-collapse:collapse; font-size:.83rem; }
th, td { text-align:right; padding:.5rem .4rem; border-bottom:1px solid var(--line); }
th { color:var(--dim); font-weight:500; font-size:.75rem; }
tr:hover td { background:#10161d; }
.badge { font-size:.7rem; padding:.15rem .5rem; border-radius:999px; background:var(--line); color:var(--dim); white-space:nowrap; }
.badge.ok { background:rgba(63,185,80,.15); color:var(--ok); }
.badge.warn { background:rgba(210,153,34,.15); color:var(--warn); }
.badge.err { background:rgba(248,81,73,.15); color:var(--err); }
nav.tabs { display:flex; gap:.3rem; flex-wrap:wrap; margin-bottom:1rem; }
nav.tabs button { background:transparent; }
nav.tabs button.active { background:#1c242e; border-color:var(--accent); color:var(--accent); }
.hidden { display:none; }
.row { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
.login { max-width:26rem; margin:6rem auto; }
.err { color:var(--err); font-size:.85rem; }
pre { background:#10161d; border:1px solid var(--line); border-radius:.5rem; padding:.6rem;
      font-size:.7rem; overflow:auto; white-space:pre-wrap; word-break:break-all; }
.toast { position:fixed; bottom:1rem; left:50%; transform:translateX(-50%); background:#1c242e;
  border:1px solid var(--line); border-radius:.5rem; padding:.6rem 1rem; font-size:.85rem;
  opacity:0; transition:opacity .2s; z-index:20; }
.toast.show { opacity:1; }
`;

// ------------------------------------------------------------------- login --

function loginView(error?: string): string {
  return `<div class="login">
  <div class="card">
    <h2>ورود به پنل مدیریت</h2>
    <p class="muted">برای ورود، شناسه‌ی تلگرام خود را وارد کنید. فقط شناسه‌هایی که در
      <code>ADMIN_USER_IDS</code> تنظیم شده‌اند اجازه‌ی ورود دارند.</p>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
    <form method="GET" action="/admin">
      <label for="tg">شناسه‌ی تلگرام (عددی)</label>
      <input id="tg" name="tg" inputmode="numeric" autocomplete="off" required>
      <button class="primary" type="submit">ورود</button>
    </form>
    <p class="muted" style="margin-top:1rem">
      شناسه‌ی خود را در تلگرام از <code>@userinfobot</code> بگیرید.
    </p>
  </div>
</div>`;
}

// ------------------------------------------------------------------- panel --

function panelView(publicUrl: string): string {
  return `<header>
  <h1>پنل مدیریت کانفیگ‌بات</h1>
  <div class="row">
    <span class="muted" id="clock"></span>
    <a class="btn sm" href="/admin/logout">خروج</a>
  </div>
</header>
<div class="wrap">
  <div class="card" id="health-strip"></div>

  <nav class="tabs" id="tabs">
    <button data-tab="dash" class="active">داشبورد</button>
    <button data-tab="payments">پرداخت‌ها</button>
    <button data-tab="orders">سفارش‌ها</button>
    <button data-tab="subs">اشتراک‌ها</button>
    <button data-tab="nodes">نودها</button>
    <button data-tab="plans">پلن‌ها</button>
    <button data-tab="users">کاربران</button>
    <button data-tab="tickets">تیکت‌ها</button>
    <button data-tab="leak">پیگیری نشتی</button>
    <button data-tab="settings">تنظیمات</button>
    <button data-tab="audit">لاگ</button>
  </nav>

  <section id="tab-dash"></section>
  <section id="tab-payments" class="hidden"></section>
  <section id="tab-orders" class="hidden"></section>
  <section id="tab-subs" class="hidden"></section>
  <section id="tab-nodes" class="hidden"></section>
  <section id="tab-plans" class="hidden"></section>
  <section id="tab-users" class="hidden"></section>
  <section id="tab-tickets" class="hidden"></section>
  <section id="tab-leak" class="hidden"></section>
  <section id="tab-settings" class="hidden"></section>
  <section id="tab-audit" class="hidden"></section>
</div>
<script>window.PUBLIC_URL = ${JSON.stringify(publicUrl)};</script>`;
}

// ------------------------------------------------------------------ client --

const CLIENT = `
(function () {
  'use strict';

  function api(path, opts) {
    return fetch(path, {
      method: (opts && opts.method) || 'GET',
      headers: { 'content-type': 'application/json' },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function toast(msg, isErr) {
    var el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.style.borderColor = isErr ? 'var(--err)' : 'var(--line)';
    el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function faNum(n) { return String(n == null ? 0 : n).replace(/[0-9]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[+d]; }); }
  function money(n) { return faNum(n) + ' تومان'; }
  function faDate(ms) {
    if (!ms) return '—';
    try { return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms)); }
    catch (e) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
  }
  function esc(s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }

  function badge(text, kind) { return el('span', { class: 'badge ' + (kind || ''), text: text }); }

  function statCard(label, value, hint) {
    return el('div', { class: 'card' }, [
      el('p', { class: 'muted', text: label }),
      el('div', { class: 'stat', text: value }),
      hint ? el('p', { class: 'muted', text: hint }) : null
    ]);
  }

  function table(headers, rows) {
    var t = el('table');
    var thead = el('thead'); var tr = el('tr');
    headers.forEach(function (h) { tr.appendChild(el('th', { text: h })); });
    thead.appendChild(tr); t.appendChild(thead);
    var tbody = el('tbody');
    rows.forEach(function (r) { tbody.appendChild(r); });
    t.appendChild(tbody);
    return t;
  }

  // ---- dashboard ---------------------------------------------------------
  function loadDash(host) {
    api('/admin/api/dashboard').then(function (d) {
      host.innerHTML = '';
      var strip = document.getElementById('health-strip');
      strip.innerHTML = '';
      strip.appendChild(el('div', { class: 'row' }, [
        badge(d.nodes.up + ' نود سالم', 'ok'),
        badge(d.nodes.down + ' نود خراب', d.nodes.down ? 'err' : ''),
        badge(d.queue + ' فیش در صف', d.queue ? 'warn' : ''),
        d.maintenance ? badge('حالت تعمیر', 'warn') : null
      ]));

      var grid = el('div', { class: 'grid' }, [
        statCard('کاربران', faNum(d.users.total), faNum(d.users.active7d) + ' فعال در ۷ روز'),
        statCard('اشتراک فعال', faNum(d.subs.active), faNum(d.subs.expiringSoon) + ' رو به اتمام'),
        statCard('درآمد ۳۰ روز', money(d.revenue.d30), faNum(d.orders.paid30) + ' سفارش'),
        statCard('درآمد امروز', money(d.revenue.today), ''),
        statCard('کانفیگ صادرشده', faNum(d.credentials.total), faNum(d.credentials.active) + ' فعال'),
        statCard('چرخش‌ها', faNum(d.rotations), '')
      ]);
      host.appendChild(grid);

      if (d.recentOrders.length) {
        host.appendChild(el('div', { class: 'card' }, [
          el('h2', { text: 'آخرین سفارش‌ها' }),
          table(['کد', 'کاربر', 'مبلغ', 'وضعیت', 'زمان'], d.recentOrders.map(function (o) {
            return el('tr', {}, [
              el('td', { text: o.code }),
              el('td', { text: o.user }),
              el('td', { text: money(o.amount) }),
              el('td', {}, [badge(statusFa(o.status), statusKind(o.status))]),
              el('td', { class: 'muted', text: faDate(o.createdAt) })
            ]);
          }))
        ]));
      }
    }).catch(function (e) { toast(e.message, true); });
  }

  function statusFa(s) {
    return { pending: 'در انتظار', awaiting_payment: 'منتظر پرداخت', paid: 'پرداخت شده',
             approved: 'تأیید شده', rejected: 'رد شده', canceled: 'لغو', expired: 'منقضی',
             failed: 'ناموفق', active: 'فعال', suspended: 'معلق', open: 'باز',
             pending_user: 'منتظر کاربر', answered: 'پاسخ داده شد', closed: 'بسته',
             submitted: 'ارسال شده', refunded: 'مسترد' }[s] || s;
  }
  function statusKind(s) {
    return ['paid', 'approved', 'active', 'answered', 'sent'].indexOf(s) >= 0 ? 'ok'
      : ['rejected', 'canceled', 'failed', 'suspended', 'expired', 'refunded'].indexOf(s) >= 0 ? 'err'
      : 'warn';
  }

  // ---- payments queue ----------------------------------------------------
  function loadPayments(host) {
    api('/admin/api/payments').then(function (d) {
      host.innerHTML = '';
      host.appendChild(el('div', { class: 'card' }, [
        el('h2', { text: 'فیش‌های در انتظار بررسی' }),
        d.pending.length ? table(['کد سفارش', 'کاربر', 'مبلغ', 'کارت', 'رهگیری', 'نظر AI', 'عملیات'],
          d.pending.map(function (p) {
            return el('tr', {}, [
              el('td', { text: p.orderCode }),
              el('td', { text: p.user }),
              el('td', { text: money(p.amount) }),
              el('td', { class: 'muted', text: maskCard(p.payerCard) }),
              el('td', { class: 'muted', text: p.trackingCode || '—' }),
              el('td', {}, [
                badge(p.verdict || '—', p.verdict === 'approve' ? 'ok' : p.verdict === 'reject' ? 'err' : 'warn'),
                el('p', { class: 'muted', text: p.verdictNote || '' })
              ]),
              el('td', {}, [el('div', { class: 'row' }, [
                el('button', { class: 'ok sm', text: 'تأیید', onclick: function () { decide(p.id, 'approve'); } }),
                el('button', { class: 'danger sm', text: 'رد', onclick: function () { decide(p.id, 'reject'); } })
              ])])
            ]);
          })) : el('p', { class: 'muted', text: 'صف خالی است ✅' })
      ]));

      host.appendChild(el('div', { class: 'card' }, [
        el('h2', { text: 'تاریخچه' }),
        d.recent.length ? table(['زمان', 'کاربر', 'مبلغ', 'درگاه', 'وضعیت'], d.recent.map(function (p) {
          return el('tr', {}, [
            el('td', { class: 'muted', text: faDate(p.createdAt) }),
            el('td', { text: p.user }),
            el('td', { text: money(p.amount) }),
            el('td', { text: p.gateway }),
            el('td', {}, [badge(statusFa(p.status), statusKind(p.status))])
          ]);
        })) : el('p', { class: 'muted', text: 'هنوز پرداختی ثبت نشده' })
      ]));
    }).catch(function (e) { toast(e.message, true); });
  }

  function maskCard(c) {
    var d = String(c || '').replace(/\\D/g, '');
    if (d.length < 8) return c || '—';
    return d.slice(0, 4) + ' **** **** ' + d.slice(-4);
  }

  function decide(paymentId, action) {
    api('/admin/api/payments/' + paymentId + '/review', { method: 'POST', body: { action: action } })
      .then(function () { toast(action === 'approve' ? 'تأیید و تحویل شد' : 'رد شد'); loadPayments(document.getElementById('tab-payments')); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---- orders ------------------------------------------------------------
  function loadOrders(host) {
    api('/admin/api/orders').then(function (d) {
      host.innerHTML = '';
      host.appendChild(el('div', { class: 'card' }, [
        el('h2', { text: 'سفارش‌ها' }),
        table(['کد', 'کاربر', 'نوع', 'مبلغ', 'درگاه', 'وضعیت', 'زمان'], d.orders.map(function (o) {
          return el('tr', {}, [
            el('td', { text: o.code }),
            el('td', { text: o.user }),
            el('td', { text: kindFa(o.kind) }),
            el('td', { text: money(o.amount) }),
            el('td', { class: 'muted', text: o.gateway || '—' }),
            el('td', {}, [badge(statusFa(o.status), statusKind(o.status))]),
            el('td', { class: 'muted', text: faDate(o.createdAt) })
          ]);
        }))
      ]));
    }).catch(function (e) { toast(e.message, true); });
  }

  function kindFa(k) {
    return { subscription: 'خرید', refill: 'شارژ حجم', renew: 'تمدید', trial: 'رایگان' }[k] || k;
  }

  // ---- subscriptions -----------------------------------------------------
  function loadSubs(host) {
    api('/admin/api/subscriptions').then(function (d) {
      host.innerHTML = '';
      host.appendChild(el('div', { class: 'card' }, [
        el('h2', { text: 'اشتراک‌ها' }),
        table(['کاربر', 'پلن', 'حجم', 'انقضا', 'چرخش', 'وضعیت', 'عملیات'], d.subs.map(function (s) {
          return el('tr', {}, [
            el('td', { text: s.user }),
            el('td', { text: s.label }),
            el('td', { class: 'muted', text: s.trafficGb > 0 ? faNum(Math.round(s.usedGb)) + '/' + faNum(s.trafficGb) + ' گیگ' : 'نامحدود' }),
            el('td', { class: 'muted', text: s.expiresAt ? faDate(s.expiresAt) : 'بدون انقضا' }),
            el('td', { text: faNum(s.rotationCount) }),
            el('td', {}, [badge(statusFa(s.status), statusKind(s.status))]),
            el('td', {}, [el('div', { class: 'row' }, [
              el('button', { class: 'sm', text: 'چرخش', onclick: function () { rotateSub(s.id); } }),
              el('button', { class: 'sm', text: 'لینک', onclick: function () { copyLink(s.token); } }),
              el('button', {
                class: 'sm ' + (s.status === 'suspended' ? 'ok' : 'danger'),
                text: s.status === 'suspended' ? 'فعال' : 'تعلیق',
                onclick: function () { toggleSub(s.id, s.status !== 'suspended'); }
              })
            ])])
          ]);
        }))
      ]));
    }).catch(function (e) { toast(e.message, true); });
  }

  function rotateSub(id) {
    if (!confirm('کلید همه‌ی کانفیگ‌های این اشتراک عوض شود؟')) return;
    api('/admin/api/subscriptions/' + id + '/rotate', { method: 'POST' })
      .then(function (r) { toast(r.changed + ' کانفیگ چرخش شد'); loadSubs(document.getElementById('tab-subs')); })
      .catch(function (e) { toast(e.message, true); });
  }

  function toggleSub(id, suspend) {
    api('/admin/api/subscriptions/' + id + '/suspend', { method: 'POST', body: { suspend: suspend } })
      .then(function () { toast(suspend ? 'معلق شد' : 'فعال شد'); loadSubs(document.getElementById('tab-subs')); })
      .catch(function (e) { toast(e.message, true); });
  }

  function copyLink(token) {
    var url = (window.PUBLIC_URL || location.origin) + '/s/' + token;
    navigator.clipboard.writeText(url).then(function () { toast('لینک کپی شد'); },
      function () { prompt('لینک را دستی کپی کن:', url); });
  }

  // ---- nodes -------------------------------------------------------------
  function loadNodes(host) {
    api('/admin/api/nodes').then(function (d) {
      host.innerHTML = '';
      host.appendChild(el('div', { class: 'card' }, [
        el('h2', { text: 'نودها' }),
        table(['نام', 'کشور', 'پروتکل', 'IP:پورت', 'سلامت', 'کاربر', 'عملیات'], d.nodes.map(function (n) {
          return el('tr', {}, [
            el('td', { text: n.flag + ' ' + n.name }),
            el('td', { text: n.countryLabel }),
            el('td', { text: n.protocol + (n.security === 'reality' ? ' Reality' : '') }),
            el('td', { class: 'muted', text: n.publicIp + ':' + n.port }),
            el('td', {}, [badge(healthFa(n.health), n.health === 'up' ? 'ok' : n.health === 'down' ? 'err' : 'warn')]),
            el('td', { text: n.capacityUsers > 0 ? faNum(n.currentUsers) + '/' + faNum(n.capacityUsers) : faNum(n.currentUsers) }),
            el('td', {}, [el('div', { class: 'row' }, [
              el('button', { class: 'sm', text: 'تست', onclick: function () { probeNode(n.id); } }),
              el('button', { class: 'sm', text: n.enabled ? 'غیرفعال' : 'فعال', onclick: function () { toggleNode(n.id, !n.enabled); } })
            ])])
          ]);
        }))
      ]));
    }).catch(function (e) { toast(e.message, true); });
  }

  function healthFa(h) { return { up: 'سالم', down: 'خراب', unknown: 'نامشخص' }[h] || h; }

  function probeNode(id) {
    toast('در حال تست…');
    api('/admin/api/nodes/' + id + '/probe', { method: 'POST' })
      .then(function (r) { toast(r.ok ? ('سالم — ' + r.latencyMs + 'ms') : ('خراب: ' + r.detail), !r.ok);
        loadNodes(document.getElementById('tab-nodes')); })
      .catch(function (e) { toast(e.message, true); });
  }

  function toggleNode(id, enabled) {
    api('/admin/api/nodes/' + id, { method: 'PATCH', body: { enabled: enabled } })
      .then(function () { toast(enabled ? 'فعال شد' : 'غیرفعال شد'); loadNodes(document.getElementById('tab-nodes')); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---- plans -------------------------------------------------------------
  function loadPlans(host) {
    api('/admin/api/plans').then(function (d) {
      host.innerHTML = '';
      host.appendChild(el('div', { class: 'card' }, [
        el('h2', { text: 'پلن‌ها' }),
        table(['نام', 'قیمت', 'حجم', 'مدت', 'دستگاه', 'وضعیت', 'عملیات'], d.plans.map(function (p) {
          return el('tr', {}, [
            el('td', { text: p.name }),
            el('td', { text: money(p.price) }),
            el('td', { text: p.trafficGb > 0 ? faNum(p.trafficGb) + ' گیگ' : 'نامحدود' }),
            el('td', { text: faNum(p.durationDays) + ' روز' }),
            el('td', { text: faNum(p.maxDevices) }),
            el('td', {}, [badge(p.hidden ? 'مخفی' : 'نمایش', p.hidden ? '' : 'ok')]),
            el('td', {}, [el('button', {
              class: 'sm', text: p.hidden ? 'نمایش بده' : 'مخفی کن',
              onclick: function () { togglePlan(p.id, !p.hidden); }
            })])
          ]);
        }))
      ]));
    }).catch(function (e) { toast(e.message, true); });
  }

  function togglePlan(id, hidden) {
    api('/admin/api/plans/' + id, { method: 'PATCH', body: { hidden: hidden } })
      .then(function () { toast('ذخیره شد'); loadPlans(document.getElementById('tab-plans')); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---- users -------------------------------------------------------------
  function loadUsers(host) {
    api('/admin/api/users').then(function (d) {
      host.innerHTML = '';
      var search = document.createElement('input');
      search.placeholder = 'جستجو با نام کاربری یا شناسه…';
      search.addEventListener('input', function () {
        var q = search.value.trim().toLowerCase();
        Array.prototype.forEach.call(host.querySelectorAll('tbody tr'), function (tr) {
          tr.style.display = !q || tr.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
        });
      });

      host.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'کاربران' }), search,
        table(['کاربر', 'شناسه', 'موجودی', 'مجموع خرید', 'اشتراک', 'وضعیت', 'عملیات'], d.users.map(function (u) {
          return el('tr', {}, [
            el('td', { text: u.username || u.firstName || '—' }),
            el('td', { class: 'muted', text: faNum(u.telegramId) }),
            el('td', { text: money(u.balance) }),
            el('td', { text: money(u.totalSpent) }),
            el('td', { text: faNum(u.subs) }),
            el('td', {}, [u.blocked ? badge('مسدود', 'err') : badge('فعال', 'ok')]),
            el('td', {}, [el('div', { class: 'row' }, [
              el('button', {
                class: 'sm ' + (u.blocked ? 'ok' : 'danger'),
                text: u.blocked ? 'رفع مسدودی' : 'مسدود',
                onclick: function () { toggleUser(u.id, !u.blocked); }
              })
            ])])
          ]);
        }))
      ]));
    }).catch(function (e) { toast(e.message, true); });
  }

  function toggleUser(id, blocked) {
    api('/admin/api/users/' + id, { method: 'PATCH', body: { blocked: blocked } })
      .then(function () { toast(blocked ? 'مسدود شد' : 'رفع مسدودی شد'); loadUsers(document.getElementById('tab-users')); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---- tickets -----------------------------------------------------------
  function loadTickets(host) {
    api('/admin/api/tickets').then(function (d) {
      host.innerHTML = '';
      host.appendChild(el('div', { class: 'card' }, [
        el('h2', { text: 'تیکت‌ها' }),
        d.tickets.length ? table(['کد', 'کاربر', 'موضوع', 'دسته', 'وضعیت', 'زمان'], d.tickets.map(function (t) {
          return el('tr', {}, [
            el('td', { text: t.code }),
            el('td', { text: t.user }),
            el('td', { text: t.subject }),
            el('td', { class: 'muted', text: catFa(t.category) }),
            el('td', {}, [badge(statusFa(t.status), statusKind(t.status))]),
            el('td', { class: 'muted', text: faDate(t.createdAt) })
          ]);
        })) : el('p', { class: 'muted', text: 'تیکتی نیست ✅' })
      ]));
    }).catch(function (e) { toast(e.message, true); });
  }

  function catFa(c) {
    return { payment: 'پرداخت', config: 'کانفیگ', speed: 'سرعت', access: 'دسترسی',
             refund: 'استرداد', other: 'سایر' }[c] || c;
  }

  // ---- leak trace --------------------------------------------------------
  function loadLeak(host) {
    host.innerHTML = '';
    var input = document.createElement('textarea');
    input.placeholder = 'کانفیگ لو رفته را اینجا بچسبان (vless://… یا trojan://…)';
    input.rows = 4;
    var out = el('div');
    var btn = el('button', { class: 'primary', text: 'پیدا کن مال کیه' });
    btn.addEventListener('click', function () {
      if (!input.value.trim()) { toast('اول کانفیگ را بچسبان', true); return; }
      btn.disabled = true;
      api('/admin/api/trace', { method: 'POST', body: { uri: input.value.trim() } })
        .then(function (r) {
          out.innerHTML = '';
          out.appendChild(el('div', { class: 'card', style: 'border-color:' + (r.found ? 'var(--warn)' : 'var(--line)') }, [
            el('h2', { text: r.found ? 'پیدا شد' : 'پیدا نشد' }),
            el('p', { text: r.message }),
            r.found ? el('p', {}, [
              el('span', { class: 'muted', text: 'کاربر: ' }), el('strong', { text: r.username }),
              el('br'),
              el('span', { class: 'muted', text: 'واترمارک: ' }), el('code', { text: r.watermark || '' })
            ]) : null,
            r.found ? el('div', { class: 'row' }, [
              el('button', { class: 'danger', text: 'چرخش فوری کانفیگ‌های این کاربر', onclick: function () { traceRotate(r.subId); } })
            ]) : null
          ]));
        })
        .catch(function (e) { toast(e.message, true); })
        .then(function () { btn.disabled = false; });
    });

    host.appendChild(el('div', { class: 'card' }, [
      el('h2', { text: 'پیگیری کانفیگ لو رفته' }),
      el('p', { class: 'muted', text: 'هر کانفیگی که ربات می‌دهد یک واترمارک یکتا در remark دارد. با آن می‌شود فهمید مال کیست.' }),
      input, btn
    ]));
    host.appendChild(out);
  }

  function traceRotate(subId) {
    if (!subId) { toast('اشتراکی پیدا نشد', true); return; }
    if (!confirm('کلید همه‌ی کانفیگ‌های این اشتراک عوض شود؟ کانفیگ لو رفته از کار می‌افتد.')) return;
    api('/admin/api/subscriptions/' + subId + '/rotate', { method: 'POST' })
      .then(function (r) { toast(r.changed + ' کانفیگ چرخش شد ✅'); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ---- settings ----------------------------------------------------------
  function loadSettings(host) {
    api('/admin/api/settings').then(function (d) {
      host.innerHTML = '';
      var s = d.settings;
      function field(key, label, type, hint) {
        var i = document.createElement('input');
        i.value = s[key] == null ? '' : String(s[key]);
        if (type) i.type = type;
        return el('div', {}, [el('label', { text: label }), i, hint ? el('p', { class: 'muted', text: hint }) : null,
          (function () { i.dataset.key = key; return el('span', { class: 'hidden' }); })()]);
      }

      var form = el('div', { class: 'card' }, [
        el('h2', { text: 'اطلاعات کارت (کارت به کارت)' }),
        el('p', { class: 'muted', text: 'تا این سه فیلد پر نشود، دکمه‌ی کارت‌به‌کارت به کاربر نشان داده نمی‌شود.' }),
        field('cardNumber', 'شماره کارت', 'text', 'مثلاً 6037991234567890'),
        field('cardHolder', 'به نام', 'text'),
        field('cardBank', 'نام بانک', 'text', 'مثلاً ملی'),
        field('paymentMessage', 'توضیح اضافی برای خریدار', 'text', 'اختیاری')
      ]);

      var form2 = el('div', { class: 'card' }, [
        el('h2', { text: 'نسخه‌ی رایگان و معرف' }),
        field('trialEnabled', 'نسخه‌ی رایگان فعال', 'checkbox'),
        field('trialDays', 'روزهای رایگان', 'number'),
        field('trialTrafficGb', 'حجم رایگان (گیگ)', 'number'),
        field('referralEnabled', 'سیستم معرف فعال', 'checkbox'),
        field('referralPercent', 'درصد معرف', 'number')
      ]);

      var form3 = el('div', { class: 'card' }, [
        el('h2', { text: 'هشدارها و هوش مصنوعی' }),
        field('expireWarnDays', 'روزهای قبل از انقضا برای هشدار', 'number'),
        field('lowTrafficWarnPercent', 'درصد مصرف برای هشدار حجم', 'number'),
        field('aiEnabled', 'هوش مصنوعی فعال', 'checkbox'),
        field('maintenanceMode', 'حالت تعمیر', 'checkbox'),
        field('maintenanceMessage', 'پیام حالت تعمیر', 'text')
      ]);

      var save = el('button', { class: 'primary', text: 'ذخیره‌ی تنظیمات' });
      save.addEventListener('click', function () {
        var payload = {};
        [form, form2, form3].forEach(function (f) {
          Array.prototype.forEach.call(f.querySelectorAll('input'), function (i) {
            if (!i.dataset.key) return;
            payload[i.dataset.key] = i.type === 'checkbox' ? i.checked : i.value;
          });
        });
        save.disabled = true;
        api('/admin/api/settings', { method: 'POST', body: payload })
          .then(function () { toast('ذخیره شد ✅'); })
          .catch(function (e) { toast(e.message, true); })
          .then(function () { save.disabled = false; });
      });

      host.appendChild(form); host.appendChild(form2); host.appendChild(form3);
      host.appendChild(el('div', { class: 'card' }, [save]));

      // Gateways are shown only when configured, or with a "how to" note.
      host.appendChild(el('div', { class: 'card' }, [
        el('h2', { text: 'درگاه‌های پرداخت' }),
        table(['درگاه', 'وضعیت', 'توضیح'], d.gateways.map(function (g) {
          return el('tr', {}, [
            el('td', { text: g.label }),
            el('td', {}, [badge(g.available ? 'فعال' : 'غیرفعال', g.available ? 'ok' : ''),
              g.sandbox ? badge('تستی', 'warn') : null]),
            el('td', { class: 'muted', text: g.hint })
          ]);
        }))
      ]));
    }).catch(function (e) { toast(e.message, true); });
  }

  // ---- audit -------------------------------------------------------------
  function loadAudit(host) {
    api('/admin/api/audit').then(function (d) {
      host.innerHTML = '';
      host.appendChild(el('div', { class: 'card' }, [
        el('h2', { text: 'لاگ تغییرات' }),
        table(['زمان', 'کار', 'بازیگر', 'هدف', 'جزئیات'], d.entries.map(function (a) {
          return el('tr', {}, [
            el('td', { class: 'muted', text: faDate(a.createdAt) }),
            el('td', { text: a.action }),
            el('td', { text: a.actorLabel || 'سیستم' }),
            el('td', { class: 'muted', text: a.targetType + (a.targetId ? ':' + a.targetId.slice(-6) : '') }),
            el('td', {}, [el('pre', { text: a.detail })])
          ]);
        }))
      ]));
    }).catch(function (e) { toast(e.message, true); });
  }

  // ---- shell -------------------------------------------------------------
  var loaders = {
    dash: loadDash, payments: loadPayments, orders: loadOrders, subs: loadSubs,
    nodes: loadNodes, plans: loadPlans, users: loadUsers, tickets: loadTickets,
    leak: loadLeak, settings: loadSettings, audit: loadAudit
  };

  function show(tab) {
    Object.keys(loaders).forEach(function (t) {
      var sec = document.getElementById('tab-' + t);
      if (sec) sec.classList.toggle('hidden', t !== tab);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    var sec = document.getElementById('tab-' + tab);
    if (sec && loaders[tab]) loaders[tab](sec);
  }

  document.getElementById('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b && b.dataset.tab) show(b.dataset.tab);
  });

  function tick() {
    var c = document.getElementById('clock');
    if (c) {
      try { c.textContent = new Intl.DateTimeFormat('fa-IR', { timeStyle: 'short' }).format(new Date()); }
      catch (e) { c.textContent = new Date().toTimeString().slice(0, 5); }
    }
  }
  tick(); setInterval(tick, 30000);

  show('dash');
})();
`;

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
