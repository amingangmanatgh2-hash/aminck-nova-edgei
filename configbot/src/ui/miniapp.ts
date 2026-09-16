/**
 * The Telegram Mini App.
 *
 * Rendered as a single static HTML document with no build step. That is a
 * deliberate choice, not a shortcut: a bundle that has to be built is a bundle
 * that can be stale, and the person deploying this does it from a phone.
 *
 * What it does and does not contain
 * ---------------------------------
 * The HTML contains no secrets. `initData` is handed to the page because the
 * Telegram Web Apps API hands it to the page anyway — it is in
 * `window.Telegram.WebApp.initData` on the client regardless. The server never
 * trusts it: `/api/*` re-verifies the HMAC on every request.
 *
 * There is no business logic here either. The page renders state and posts to
 * `/api/*`. Prices, quotas and expiry all come from the server, so a modified
 * client can see its own data but cannot change what it costs.
 */

export interface MiniAppOptions {
  botToken: string;
  initData: string;
  startParam: string;
  apiBase: string;
}

export function renderMiniApp(opts: MiniAppOptions): string {
  // initData and startParam come from a query string; escaping them stops a
  // crafted URL from closing the script tag and injecting.
  const initData = escapeJs(opts.initData);
  const startParam = escapeJs(opts.startParam);

  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>کانفیگ من</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
${STYLES}
</style>
</head>
<body>
<div id="app">
  <div class="loading">در حال بارگذاری…</div>
</div>

<template id="tpl-error">
  <div class="card error">
    <h2>نشد</h2>
    <p id="err-msg"></p>
    <button class="btn" data-act="retry">تلاش دوباره</button>
  </div>
</template>

<script>
${CLIENT_JS.replace('__INIT_DATA__', `'${initData}'`).replace('__START_PARAM__', `'${startParam}'`)}
</script>
</body>
</html>`;
}

// ------------------------------------------------------------------ styles --

const STYLES = `
:root {
  --bg: #0b0f14; --card: #151b23; --line: #232b36;
  --text: #e6edf3; --dim: #8b98a5; --accent: #2f81f7;
  --ok: #3fb950; --warn: #d29922; --err: #f85149;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif;
  -webkit-tap-highlight-color: transparent;
}
#app { max-width: 480px; margin: 0 auto; padding: 1rem 1rem 6rem; }
.loading { text-align: center; color: var(--dim); padding: 4rem 0; }
h1 { font-size: 1.2rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 0 0 .75rem; }
.sub { color: var(--dim); font-size: .8rem; margin: 0 0 1rem; }
.card {
  background: var(--card); border: 1px solid var(--line);
  border-radius: .75rem; padding: 1rem; margin-bottom: .75rem;
}
.card.error { border-color: var(--err); }
.row { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
.muted { color: var(--dim); font-size: .8rem; }
.bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; margin: .5rem 0; }
.bar > i { display: block; height: 100%; background: var(--accent); }
.bar > i.warn { background: var(--warn); }
.bar > i.err { background: var(--err); }
.badge { font-size: .7rem; padding: .15rem .5rem; border-radius: 999px; background: var(--line); color: var(--dim); }
.badge.ok { background: rgba(63,185,80,.15); color: var(--ok); }
.badge.err { background: rgba(248,81,73,.15); color: var(--err); }
button, .btn {
  appearance: none; border: 1px solid var(--line); background: #1c242e; color: var(--text);
  border-radius: .6rem; padding: .65rem 1rem; font-size: .9rem; cursor: pointer;
  font-family: inherit; width: 100%; text-align: center; text-decoration: none; display: block;
}
button.primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
button:disabled { opacity: .5; cursor: default; }
.actions { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-top: .75rem; }
.configs { display: grid; gap: .4rem; margin-top: .5rem; }
.config { background: #10161d; border: 1px solid var(--line); border-radius: .5rem; padding: .5rem .65rem; }
.config code { font-size: .68rem; color: var(--dim); word-break: break-all; display: block; }
.plan { display: flex; justify-content: space-between; align-items: center; }
.plan .price { font-weight: 700; color: var(--accent); }
.toast {
  position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%);
  background: #1c242e; border: 1px solid var(--line); border-radius: .5rem;
  padding: .6rem 1rem; font-size: .85rem; z-index: 10; opacity: 0; transition: opacity .2s;
}
.toast.show { opacity: 1; }
nav {
  position: fixed; bottom: 0; left: 0; right: 0; background: var(--card);
  border-top: 1px solid var(--line); display: flex; justify-content: space-around;
  padding: .5rem 0 calc(.5rem + env(safe-area-inset-bottom));
}
nav button { width: auto; border: 0; background: none; color: var(--dim); padding: .3rem .8rem; font-size: .75rem; }
nav button.active { color: var(--accent); }
`;

// ------------------------------------------------------------------ client --

const CLIENT_JS = `
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg && tg.initData ? tg.initData : __INIT_DATA__;
  var startParam = tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param
    ? tg.initDataUnsafe.start_param : __START_PARAM__;
  var state = { tab: 'home', data: null };

  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor('#0b0f14');
    if (tg.setBackgroundColor) tg.setBackgroundColor('#0b0f14');
  }

  // ---- transport ---------------------------------------------------------
  // Every call carries initData. The server verifies its HMAC each time, so a
  // forged request gets a 401 rather than someone else's configs.
  function api(path, opts) {
    return fetch(path, {
      method: (opts && opts.method) || 'GET',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ initData: initData }, (opts && opts.body) || {}))
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok || json.ok === false) throw new Error(json.error || ('HTTP ' + res.status));
        return json;
      });
    });
  }

  function toast(msg) {
    var el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  // ---- helpers -----------------------------------------------------------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function faNum(n) { return String(n).replace(/[0-9]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[+d]; }); }

  function faDate(ms) {
    if (!ms) return 'بدون انقضا';
    try {
      return new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' })
        .format(new Date(ms));
    } catch (e) { return new Date(ms).toISOString().slice(0, 10); }
  }

  function daysLeft(ms) {
    if (!ms) return null;
    return Math.ceil((ms - Date.now()) / 86400000);
  }

  function usageClass(pct) { return pct >= 95 ? 'err' : pct >= 80 ? 'warn' : ''; }

  async function copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
      toast('کپی شد');
    } catch (e) { toast('کپی نشد، دستی کپی کن'); }
  }

  // ---- views -------------------------------------------------------------
  function renderHome(d) {
    var wrap = el('div');
    wrap.appendChild(el('h1', { text: 'سلام ' + (d.userName || '') + ' 👋' }));
    wrap.appendChild(el('p', { class: 'sub', text: d.botName || 'کانفیگ من' }));

    var wallet = el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [
        el('span', { class: 'muted', text: 'موجودی کیف پول' }),
        el('strong', { text: faNum(d.balance) + ' ' + (d.currency || 'تومان') })
      ]),
      el('div', { class: 'actions' }, [
        el('button', { text: 'افزایش موجودی', onclick: function () { go('wallet'); } }),
        el('button', { text: 'خرید کانفیگ', class: 'primary', onclick: function () { go('plans'); } })
      ])
    ]);
    wrap.appendChild(wallet);

    if (!d.subscriptions.length) {
      wrap.appendChild(el('div', { class: 'card' }, [
        el('h2', { text: 'هنوز اشتراکی نداری' }),
        el('p', { class: 'muted', text: 'یک پلن انتخاب کن تا لینک اختصاصی‌ات ساخته شود.' }),
        el('button', { class: 'primary', text: 'دیدن پلن‌ها', onclick: function () { go('plans'); } })
      ]));
    } else {
      d.subscriptions.forEach(function (s) { wrap.appendChild(subCard(s, d)); });
    }

    if (d.alerts && d.alerts.length) {
      d.alerts.forEach(function (a) {
        wrap.appendChild(el('div', { class: 'card', style: 'border-color:var(--warn)' }, [
          el('p', { class: 'muted', text: a })
        ]));
      });
    }
    return wrap;
  }

  function subCard(s, d) {
    var pct = s.trafficGb > 0 ? Math.min(100, Math.round((s.usedGb / s.trafficGb) * 100)) : 0;
    var left = daysLeft(s.expiresAt);
    var card = el('div', { class: 'card' });

    card.appendChild(el('div', { class: 'row' }, [
      el('h2', { text: s.label }),
      el('span', {
        class: 'badge ' + (s.status === 'active' ? 'ok' : 'err'),
        text: s.status === 'active' ? 'فعال' : s.status === 'suspended' ? 'معلق' : 'منقضی'
      })
    ]));

    if (s.trafficGb > 0) {
      card.appendChild(el('div', { class: 'row' }, [
        el('span', { class: 'muted', text: 'حجم مصرفی' }),
        el('span', { class: 'muted', text: faNum(s.usedGb) + ' از ' + faNum(s.trafficGb) + ' گیگ' })
      ]));
      card.appendChild(el('div', { class: 'bar' }, [
        el('i', { class: usageClass(pct), style: 'width:' + pct + '%' })
      ]));
    } else {
      card.appendChild(el('p', { class: 'muted', text: 'حجم نامحدود' }));
    }

    card.appendChild(el('p', {
      class: 'muted',
      text: left === null ? 'بدون انقضا'
        : left < 0 ? 'منقضی شده'
        : faNum(left) + ' روز باقی مانده • تا ' + faDate(s.expiresAt)
    }));

    // The subscription link is the one thing worth copying: it never changes,
    // so it works in every client without re-importing after a rotation.
    card.appendChild(el('button', {
      class: 'primary',
      text: 'کپی لینک اشتراک',
      onclick: function () { copy(s.subUrl); }
    }));

    card.appendChild(el('div', { class: 'actions' }, [
      el('button', { text: 'کانفیگ‌ها', onclick: function () { showConfigs(s); } }),
      el('button', { text: 'چرخش کلید', onclick: function () { rotate(s, card); } })
    ]));

    if (s.status === 'expired') {
      card.appendChild(el('div', { class: 'actions' }, [
        el('button', { class: 'primary', text: 'تمدید', onclick: function () { go('plans'); } })
      ]));
    }
    return card;
  }

  function showConfigs(s) {
    api('/api/subscriptions/' + encodeURIComponent(s.id) + '/configs').then(function (res) {
      var root = document.getElementById('app');
      root.innerHTML = '';
      var back = el('button', { text: '← برگشت', onclick: function () { render(); } });
      root.appendChild(back);
      var card = el('div', { class: 'card' }, [el('h2', { text: 'کانفیگ‌های «' + s.label + '»' })]);
      var list = el('div', { class: 'configs' });
      res.configs.forEach(function (c) {
        list.appendChild(el('div', { class: 'config' }, [
          el('div', { class: 'row' }, [
            el('span', { text: c.remark }),
            el('button', { style: 'width:auto;padding:.3rem .6rem', text: 'کپی', onclick: function () { copy(c.uri); } })
          ]),
          el('code', { text: c.uri })
        ]));
      });
      card.appendChild(list);
      root.appendChild(card);
    }).catch(function (e) { fail(e.message); });
  }

  function rotate(s, card) {
    if (tg && tg.showConfirm) {
      tg.showConfirm('کلید همه‌ی کانفیگ‌ها عوض می‌شود. لینک ثابت می‌ماند ولی کانفیگ قبلی از کار می‌افتد. ادامه بدم؟', function (ok) {
        if (ok) doRotate(s, card);
      });
    } else { doRotate(s, card); }
  }

  function doRotate(s, card) {
    card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    api('/api/subscriptions/' + encodeURIComponent(s.id) + '/rotate', { method: 'POST' })
      .then(function (res) {
        toast(res.changed + ' کانفیگ چرخش شد');
        load();
      })
      .catch(function (e) { toast(e.message); load(); });
  }

  function renderPlans(d) {
    var wrap = el('div');
    wrap.appendChild(el('h1', { text: 'پلن‌ها' }));
    wrap.appendChild(el('p', { class: 'sub', text: 'قیمت‌ها به ' + (d.currency || 'تومان') }));
    d.plans.forEach(function (p) {
      wrap.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'plan' }, [
          el('div', {}, [
            el('strong', { text: p.name }),
            el('p', { class: 'muted', text: describePlan(p) })
          ]),
          el('div', { style: 'text-align:left' }, [
            el('div', { class: 'price', text: faNum(p.price) }),
            el('div', { class: 'muted', text: (d.currency || 'تومان') })
          ])
        ]),
        el('div', { class: 'actions' }, [
          el('button', { class: 'primary', text: 'خرید', onclick: function () { buy(p, d); } })
        ])
      ]));
    });
    return wrap;
  }

  function describePlan(p) {
    var bits = [];
    bits.push(p.durationDays > 0 ? faNum(p.durationDays) + ' روزه' : 'بدون انقضا');
    bits.push(p.trafficGb > 0 ? faNum(p.trafficGb) + ' گیگ' : 'حجم نامحدود');
    return bits.join(' • ');
  }

  function buy(plan, d) {
    api('/api/orders', { method: 'POST', body: { planId: plan.id, startParam: startParam } })
      .then(function (res) { renderPayment(res, d); })
      .catch(function (e) { fail(e.message); });
  }

  function renderPayment(order, d) {
    var root = document.getElementById('app');
    root.innerHTML = '';
    root.appendChild(el('h1', { text: 'پرداخت' }));
    root.appendChild(el('p', { class: 'sub', text: 'کد سفارش: ' + order.code }));

    var amountCard = el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [
        el('span', { class: 'muted', text: 'مبلغ قابل پرداخت' }),
        el('strong', { text: faNum(order.amount) + ' ' + (d.currency || 'تومان') })
      ])
    ]);
    if (order.discount > 0) {
      amountCard.appendChild(el('div', { class: 'row' }, [
        el('span', { class: 'muted', text: 'تخفیف' }),
        el('span', { text: faNum(order.discount) })
      ]));
    }
    root.appendChild(amountCard);

    if (order.amount === 0) {
      root.appendChild(el('div', { class: 'card' }, [
        el('p', { text: 'این سفارش رایگان است و آماده شد. ✅' }),
        el('button', { class: 'primary', text: 'برگشت', onclick: function () { go('home'); } })
      ]));
      return;
    }

    var methods = el('div');
    (order.gateways || []).forEach(function (g) {
      methods.appendChild(el('button', {
        class: 'primary',
        text: (g.icon || '') + ' ' + g.label,
        style: 'margin-bottom:.5rem',
        onclick: function () { startPay(order, g.id, methods); }
      }));
      methods.appendChild(el('p', { class: 'muted', text: g.hint, style: 'margin:-.3rem 0 .6rem' }));
    });
    root.appendChild(methods);
    root.appendChild(el('button', { text: 'انصراف', onclick: function () { go('home'); } }));
  }

  function startPay(order, gateway, container) {
    container.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    api('/api/orders/' + encodeURIComponent(order.id) + '/pay', { method: 'POST', body: { gateway: gateway } })
      .then(function (res) {
        if (res.kind === 'redirect' && res.url) {
          // Online gateway: open it, then the callback finishes the order.
          window.location.href = res.url;
          return;
        }
        showCardInstructions(res);
      })
      .catch(function (e) { toast(e.message); container.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); });
  }

  function showCardInstructions(res) {
    var root = document.getElementById('app');
    root.innerHTML = '';
    root.appendChild(el('h1', { text: 'کارت به کارت' }));
    var pre = el('pre', { style: 'white-space:pre-wrap;font-size:.85rem;line-height:1.8' });
    pre.textContent = res.text;
    root.appendChild(el('div', { class: 'card' }, [pre]));
    root.appendChild(el('button', {
      class: 'primary', text: 'فیش را فرستادم',
      onclick: function () { openReceiptForm(res.ref); }
    }));
    root.appendChild(el('div', { class: 'actions' }, [
      el('button', { text: 'برگشت', onclick: function () { go('home'); } })
    ]));
  }

  function openReceiptForm(orderId) {
    var root = document.getElementById('app');
    root.innerHTML = '';
    root.appendChild(el('h1', { text: 'ثبت فیش' }));
    root.appendChild(el('p', { class: 'sub', text: 'اطلاعات تراکنش را وارد کن تا سریع‌تر تأیید شود.' }));

    var card = document.createElement('input');
    card.placeholder = 'شماره کارتی که با آن واریز کردی';
    card.inputMode = 'numeric';
    var name = document.createElement('input');
    name.placeholder = 'نام صاحب کارت';
    var tracking = document.createElement('input');
    tracking.placeholder = 'کد رهگیری تراکنش';
    var note = document.createElement('input');
    note.placeholder = 'توضیحات تراکنش (اختیاری)';
    [card, name, tracking, note].forEach(function (i) {
      i.style.cssText = 'width:100%;padding:.65rem;margin-bottom:.5rem;border-radius:.5rem;border:1px solid var(--line);background:#10161d;color:var(--text);font-family:inherit';
    });

    var submit = el('button', { class: 'primary', text: 'ارسال برای بررسی' });
    submit.addEventListener('click', function () {
      if (!tracking.value.trim()) { toast('کد رهگیری لازم است'); return; }
      submit.disabled = true;
      api('/api/orders/' + encodeURIComponent(orderId) + '/receipt', {
        method: 'POST',
        body: {
          payerCard: card.value,
          payerName: name.value,
          trackingCode: tracking.value,
          note: note.value,
          receiptPhoto: 'pending-upload'
        }
      }).then(function (res) {
        root.innerHTML = '';
        root.appendChild(el('div', { class: 'card' }, [
          el('h2', { text: res.autoApproved ? 'تأیید شد ✅' : 'ثبت شد ⏳' }),
          el('p', { class: 'muted', text: res.autoApproved ? 'سفارشت آماده شد.' : 'به‌زودی بررسی می‌شود. نتیجه را در ربات می‌فرستیم.' }),
          el('p', { class: 'muted', text: res.verdict && res.verdict.summary ? res.verdict.summary : '' }),
          el('button', { class: 'primary', text: 'برگشت', onclick: function () { go('home'); } })
        ]));
      }).catch(function (e) { toast(e.message); submit.disabled = false; });
    });

    root.appendChild(el('div', { class: 'card' }, [card, name, tracking, note]));
    root.appendChild(submit);
    root.appendChild(el('p', {
      class: 'muted',
      text: 'نکته: عکس فیش را در ربات تلگرام هم بفرست تا بررسی سریع‌تر انجام شود.',
      style: 'margin-top:.75rem'
    }));
  }

  function renderWallet(d) {
    var wrap = el('div');
    wrap.appendChild(el('h1', { text: 'کیف پول' }));
    wrap.appendChild(el('div', { class: 'card' }, [
      el('p', { class: 'muted', text: 'موجودی فعلی' }),
      el('h2', { text: faNum(d.balance) + ' ' + (d.currency || 'تومان') })
    ]));

    var amounts = [50000, 100000, 200000, 500000];
    var grid = el('div', { class: 'actions' });
    amounts.forEach(function (a) {
      grid.appendChild(el('button', {
        text: faNum(a / 1000) + ' هزار',
        onclick: function () { toast('برای شارژ، در ربات بنویس «افزایش موجودی»'); }
      }));
    });
    wrap.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'شارژ کیف پول' }), grid]));

    if (d.ledger && d.ledger.length) {
      var list = el('div');
      d.ledger.slice(0, 12).forEach(function (r) {
        list.appendChild(el('div', { class: 'row', style: 'padding:.4rem 0;border-bottom:1px solid var(--line)' }, [
          el('span', { class: 'muted', text: r.reason }),
          el('span', { text: (r.delta > 0 ? '+' : '') + faNum(r.delta) })
        ]));
      });
      wrap.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'تراکنش‌ها' }), list]));
    }
    return wrap;
  }

  function renderTickets(d) {
    var wrap = el('div');
    wrap.appendChild(el('h1', { text: 'پشتیبانی' }));
    var subject = document.createElement('input');
    subject.placeholder = 'موضوع پیام';
    subject.style.cssText = 'width:100%;padding:.65rem;margin-bottom:.5rem;border-radius:.5rem;border:1px solid var(--line);background:#10161d;color:var(--text);font-family:inherit';
    wrap.appendChild(el('div', { class: 'card' }, [
      el('h2', { text: 'تیکت جدید' }),
      subject,
      el('button', {
        class: 'primary', text: 'ارسال',
        onclick: function () {
          if (!subject.value.trim()) { toast('موضوع را بنویس'); return; }
          api('/api/tickets', { method: 'POST', body: { subject: subject.value } })
            .then(function () { toast('تیکت ثبت شد'); load(); })
            .catch(function (e) { toast(e.message); });
        }
      })
    ]));

    (d.tickets || []).forEach(function (t) {
      wrap.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'row' }, [
          el('strong', { text: t.subject }),
          el('span', { class: 'badge', text: statusFa(t.status) })
        ]),
        el('p', { class: 'muted', text: 'کد ' + t.code + ' • ' + faDate(t.createdAt) })
      ]));
    });
    return wrap;
  }

  function statusFa(s) {
    return { open: 'باز', pending_user: 'منتظر شما', answered: 'پاسخ داده شد', closed: 'بسته' }[s] || s;
  }

  // ---- shell -------------------------------------------------------------
  function nav() {
    var bar = el('nav');
    [['home', 'خانه'], ['plans', 'پلن‌ها'], ['wallet', 'کیف پول'], ['support', 'پشتیبانی']]
      .forEach(function (item) {
        var b = el('button', {
          class: state.tab === item[0] ? 'active' : '',
          text: item[1],
          onclick: function () { go(item[0]); }
        });
        bar.appendChild(b);
      });
    return bar;
  }

  function go(tab) { state.tab = tab; render(); }

  function render() {
    var root = document.getElementById('app');
    root.innerHTML = '';
    if (!state.data) { root.appendChild(el('div', { class: 'loading', text: 'در حال بارگذاری…' })); return; }
    var d = state.data;
    if (state.tab === 'plans') root.appendChild(renderPlans(d));
    else if (state.tab === 'wallet') root.appendChild(renderWallet(d));
    else if (state.tab === 'support') root.appendChild(renderTickets(d));
    else root.appendChild(renderHome(d));
    var old = document.querySelector('nav');
    if (old) old.remove();
    document.body.appendChild(nav());
  }

  function fail(msg) {
    var root = document.getElementById('app');
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'card error' }, [
      el('h2', { text: 'مشکل' }),
      el('p', { text: msg }),
      el('button', { text: 'تلاش دوباره', onclick: load })
    ]));
  }

  function load() {
    api('/api/bootstrap' + (startParam ? '?start=' + encodeURIComponent(startParam) : ''))
      .then(function (res) { state.data = res; render(); })
      .catch(function (e) { fail(e.message); });
  }

  if (tg && tg.onEvent) {
    tg.onEvent('viewportChanged', function () { /* layout is fluid; nothing to do */ });
  }

  load();
})();
`;

/** Escape for embedding inside a single-quoted JS string literal. */
function escapeJs(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}
