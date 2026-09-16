/**
 * Admin panel.
 *
 * Every button here maps to a real backend endpoint. There are no decorative
 * controls: if the platform cannot do something, the control is absent rather
 * than present-and-dead.
 */
export const ADMIN_JS = `/*NOVA-ADMIN-START*/
(function(){
"use strict";
var me = null;

function el(id){ return document.getElementById(id); }
function esc(s){
  return String(s==null?"":s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}
function toast(m,k){
  var t=document.createElement("div"); t.className="toast "+(k||""); t.textContent=m;
  document.body.appendChild(t); setTimeout(function(){t.remove();},4000);
}
function api(path, opts){
  opts = opts || {};
  opts.credentials = "same-origin";
  opts.headers = Object.assign({"content-type":"application/json"}, opts.headers||{});
  return fetch(path, opts).then(function(r){
    return r.json().catch(function(){return {};}).then(function(j){ return {ok:r.ok,status:r.status,body:j}; });
  });
}
function usd(c){ return "$" + ((c||0)/100).toFixed(2); }
function ago(ts){
  if (!ts) return "—";
  var s = Math.round((Date.now()-ts)/1000);
  if (s<60) return s+"s"; if (s<3600) return Math.round(s/60)+"m";
  if (s<86400) return Math.round(s/3600)+"h"; return Math.round(s/86400)+"d";
}

/* ------------------------------------------------------------- boot */
function boot(){
  var f = el("loginForm");
  if (f) f.onsubmit = onLogin;
  var lg = el("logout");
  if (lg) lg.onclick = function(){
    fetch("/api/auth/logout",{method:"POST",credentials:"same-origin"}).then(function(){ location.reload(); });
  };
  checkSession();
  var nav = el("menu");
  if (nav){
    Array.prototype.forEach.call(nav.querySelectorAll("[data-view]"), function(a){
      a.onclick = function(e){ e.preventDefault(); show(a.getAttribute("data-view")); };
    });
  }
}

function checkSession(){
  api("/api/admin/overview").then(function(r){
    if (!r.ok){ el("loginView").classList.remove("hidden"); el("panelView").classList.add("hidden"); return; }
    me = r.body.admin;
    el("loginView").classList.add("hidden");
    el("panelView").classList.remove("hidden");
    el("adminName").textContent = me.username + " (" + me.role + ")";
    renderOverview(r.body);
  });
}

function onLogin(e){
  e.preventDefault();
  api("/api/admin/login",{method:"POST",body:JSON.stringify({
    username: el("username").value.trim(), password: el("password").value
  })}).then(function(r){
    if (!r.ok){ toast(r.body.error==="invalid_credentials" ? "نام کاربری یا رمز اشتباه است" : "خطا","err"); return; }
    location.reload();
  });
}

/* ----------------------------------------------------------- views */
function show(v){
  Array.prototype.forEach.call(document.querySelectorAll("[data-panel]"), function(p){
    p.classList.toggle("hidden", p.getAttribute("data-panel") !== v);
  });
  Array.prototype.forEach.call(el("menu").querySelectorAll("[data-view]"), function(a){
    a.classList.toggle("on", a.getAttribute("data-view") === v);
  });
  if (v==="overview") api("/api/admin/overview").then(function(r){ if(r.ok) renderOverview(r.body); });
  if (v==="settings") api("/api/admin/settings").then(function(r){ if(r.ok) renderSettings(r.body.settings); });
  if (v==="anticheat") loadAnticheat();
  if (v==="appeals") loadAppeals();
  if (v==="alerts") loadAlerts();
  if (v==="servers") api("/api/status").then(function(r){ if(r.ok) renderServers(r.body.servers); });
}

function renderOverview(d){
  var s = d.stats;
  var cards = [
    ["کاربران", s.users], ["سرورها", s.servers], ["بازیکن آنلاین", s.onlinePlayers],
    ["سفارش موفق", s.paidOrders], ["درآمد", usd(s.revenueUsdCents)],
    ["فیش در انتظار", s.pendingReceipts], ["اعتراض باز", s.openAppeals],
    ["هشدار خوانده‌نشده", s.unreadAlerts], ["پرونده آنتی‌چیت ۲۴ ساعت", s.cheatCases24h]
  ];
  el("stats").innerHTML = cards.map(function(c){
    return '<div class="card stat"><div class="n">'+esc(c[1])+'</div><div class="l">'+esc(c[0])+'</div></div>';
  }).join("");
  el("serverTable").innerHTML = d.servers.map(function(sv){
    var cls = sv.status==="online"?"ok":sv.status==="error"?"err":sv.status==="offline"?"off":"warn";
    return '<tr><td>'+esc(sv.name)+'</td><td>'+esc(sv.edition)+'</td>'
      +'<td><span class="badge '+cls+'">'+esc(sv.status)+'</span></td>'
      +'<td>'+sv.onlinePlayers+'/'+sv.maxPlayers+'</td>'
      +'<td>'+(sv.tps==null?"—":Number(sv.tps).toFixed(1))+'</td>'
      +'<td>'+(sv.memUsedMb==null?"—":sv.memUsedMb+"/"+(sv.memMaxMb||0)+"MB")+'</td>'
      +'<td>'+ago(sv.lastHeartbeat)+'</td></tr>';
  }).join("") || '<tr><td colspan="7" class="muted">سروری ثبت نشده</td></tr>';
}

/* -------------------------------------------------------- settings */
function renderSettings(s){
  var f = el("settingsForm");
  f.serverName.value = s.serverName||"";
  f.serverHost.value = s.serverHost||"";
  f.serverIp.value = s.serverIp||"";
  f.discordUrl.value = s.discordUrl||"";
  f.telegramUrl.value = s.telegramUrl||"";
  f.supportEmail.value = s.supportEmail||"";
  f.cardHolder.value = s.cardHolder||"";
  f.cardNumber.value = s.cardNumber||"";
  f.zarinpalMerchantId.value = s.zarinpalMerchantId||"";
  f.maintenance.checked = !!s.maintenance;
  f.whitelist.checked = !!s.whitelist;
  f.shopEnabled.checked = s.shopEnabled !== false;
  f.zarinpalEnabled.checked = !!s.zarinpalEnabled;
  f.card2cardEnabled.checked = !!s.card2cardEnabled;
  f.onsubmit = function(e){
    e.preventDefault();
    var payload = {
      serverName:f.serverName.value, serverHost:f.serverHost.value, serverIp:f.serverIp.value,
      discordUrl:f.discordUrl.value, telegramUrl:f.telegramUrl.value, supportEmail:f.supportEmail.value,
      cardHolder:f.cardHolder.value, zarinpalMerchantId:f.zarinpalMerchantId.value,
      maintenance:f.maintenance.checked, whitelist:f.whitelist.checked, shopEnabled:f.shopEnabled.checked,
      zarinpalEnabled:f.zarinpalEnabled.checked, card2cardEnabled:f.card2cardEnabled.checked
    };
    if (f.cardNumber.value && f.cardNumber.value.indexOf("*")===-1) payload.cardNumber = f.cardNumber.value;
    api("/api/admin/settings",{method:"PUT",body:JSON.stringify(payload)}).then(function(r){
      toast(r.ok ? "ذخیره شد" : (r.body.error||"خطا"), r.ok?"ok":"err");
      if (r.ok) renderSettings(r.body.settings);
    });
  };
}

/* ------------------------------------------------------- anticheat */
function loadAnticheat(){
  api("/api/admin/cheat-cases").then(function(r){
    if (!r.ok) return;
    el("caseTable").innerHTML = r.body.cases.map(function(c){
      return '<tr><td><code>'+esc(String(c.id).slice(0,8))+'</code></td>'
        +'<td>'+esc(String(c.player_id).slice(0,8))+'</td>'
        +'<td>'+Number(c.confidence).toFixed(1)+'</td>'
        +'<td><span class="badge '+(c.tier>=4?"err":c.tier>=3?"warn":"info")+'">سطح '+c.tier+'</span></td>'
        +'<td>'+esc(c.action_taken)+'</td>'
        +'<td>'+(c.permanent?'<span class="badge err">دائم</span>':'موقت')+'</td>'
        +'<td>'+ago(c.created_at)+'</td>'
        +'<td><button class="btn sm" data-evidence="'+esc(c.evidence_keys||'[]')+'">شواهد</button></td></tr>';
    }).join("") || '<tr><td colspan="8" class="muted">پرونده‌ای وجود ندارد</td></tr>';
    Array.prototype.forEach.call(el("caseTable").querySelectorAll("[data-evidence]"), function(b){
      b.onclick = function(){
        var keys = [];
        try { keys = JSON.parse(b.getAttribute("data-evidence")); } catch(e){}
        el("evidenceBox").textContent = keys.length
          ? keys.map(function(k){ return "R2: " + k; }).join("\\n")
          : "شواهدی برای این پرونده ذخیره نشده است.";
      };
    });
  });
}

/* --------------------------------------------------------- appeals */
function loadAppeals(){
  api("/api/admin/appeals").then(function(r){
    if (!r.ok) return;
    el("appealTable").innerHTML = r.body.appeals.map(function(a){
      return '<tr><td><code>'+esc(String(a.id).slice(0,8))+'</code></td>'
        +'<td>'+esc(a.ban_reason||"")+'</td>'
        +'<td>'+esc(a.message||"")+'</td>'
        +'<td>'+esc(a.contact||"—")+'</td>'
        +'<td>'+ago(a.created_at)+'</td>'
        +'<td><button class="btn sm" data-appeal="'+esc(a.id)+'" data-ok="1">تایید</button> '
        +'<button class="btn sm danger" data-appeal="'+esc(a.id)+'" data-ok="0">رد</button></td></tr>';
    }).join("") || '<tr><td colspan="6" class="muted">اعتراض بازی وجود ندارد</td></tr>';
    Array.prototype.forEach.call(el("appealTable").querySelectorAll("[data-appeal]"), function(b){
      b.onclick = function(){
        api("/api/admin/appeals/decide",{method:"POST",body:JSON.stringify({
          appealId:b.getAttribute("data-appeal"), approve:b.getAttribute("data-ok")==="1",
          note:"decided from admin panel"
        })}).then(function(r2){
          toast(r2.ok?"ثبت شد":"خطا", r2.ok?"ok":"err");
          if (r2.ok) loadAppeals();
        });
      };
    });
  });
}

/* ---------------------------------------------------------- alerts */
function loadAlerts(){
  api("/api/admin/alerts").then(function(r){
    if (!r.ok) return;
    el("alertTable").innerHTML = r.body.alerts.map(function(a){
      var cls = a.severity==="critical"?"err":a.severity==="warn"?"warn":"info";
      return '<tr><td><span class="badge '+cls+'">'+esc(a.severity)+'</span></td>'
        +'<td>'+esc(a.kind)+'</td><td>'+esc(a.detail)+'</td><td>'+ago(a.created_at)+'</td></tr>';
    }).join("") || '<tr><td colspan="4" class="muted">هشداری وجود ندارد</td></tr>';
  });
}

/* --------------------------------------------------------- servers */
function renderServers(list){
  el("serverList").innerHTML = (list||[]).map(function(s){
    return '<div class="card row spread"><div><strong>'+esc(s.name)+'</strong>'
      +' <span class="badge '+(s.status==="online"?"ok":"off")+'">'+esc(s.status)+'</span></div>'
      +'<div class="muted">'+s.onlinePlayers+'/'+s.maxPlayers+'</div></div>';
  }).join("") || '<p class="muted">سروری ثبت نشده است.</p>';
}

if (document.readyState==="loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
})();
/*NOVA-ADMIN-END*/`;

export const ADMIN_HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>پنل مدیریت</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>

<div id="loginView" class="hidden">
  <div class="wrap" style="max-width:400px;padding-top:80px">
    <div class="card">
      <h2>ورود مدیر</h2>
      <form id="loginForm">
        <div class="field"><label>نام کاربری</label>
          <input id="username" value="AMINCK" autocomplete="username"></div>
        <div class="field"><label>رمز عبور</label>
          <input id="password" type="password" autocomplete="current-password" required></div>
        <button class="btn primary" style="width:100%">ورود</button>
      </form>
    </div>
  </div>
</div>

<div id="panelView" class="hidden">
<nav class="top"><div class="inner">
  <span class="brand">پنل مدیریت</span>
  <span class="muted" id="adminName"></span>
  <span class="links"><a href="/">سایت</a><button class="btn sm" id="logout">خروج</button></span>
</div></nav>

<main class="wrap" style="padding-top:18px">
<div class="sidebar">
  <div class="card menu" id="menu">
    <a href="#" data-view="overview" class="on">داشبورد</a>
    <a href="#" data-view="servers">سرورها</a>
    <a href="#" data-view="anticheat">آنتی‌چیت</a>
    <a href="#" data-view="appeals">اعتراض‌ها</a>
    <a href="#" data-view="alerts">هشدارها</a>
    <a href="#" data-view="settings">تنظیمات</a>
  </div>

  <div>
    <div data-panel="overview">
      <h2>داشبورد</h2>
      <div id="stats" class="grid g4" style="margin-bottom:16px"></div>
      <div class="card">
        <h3>سرورها</h3>
        <table><thead><tr><th>نام</th><th>نسخه</th><th>وضعیت</th>
          <th>بازیکن</th><th>TPS</th><th>حافظه</th><th>آخرین ضربان</th></tr></thead>
        <tbody id="serverTable"></tbody></table>
      </div>
    </div>

    <div data-panel="servers" class="hidden">
      <h2>سرورها</h2>
      <div id="serverList" class="grid g2"></div>
    </div>

    <div data-panel="anticheat" class="hidden">
      <h2>پرونده‌های آنتی‌چیت</h2>
      <p class="muted">بن دائم فقط از اینجا و با تایید دستی شما انجام می‌شود. سیستم هرگز خودکار بن دائم نمی‌زند.</p>
      <div class="card">
        <table><thead><tr><th>پرونده</th><th>بازیکن</th><th>امتیاز</th><th>سطح</th>
          <th>اقدام</th><th>نوع</th><th>زمان</th><th></th></tr></thead>
        <tbody id="caseTable"></tbody></table>
      </div>
      <div class="card" style="margin-top:14px"><h3>شواهد</h3>
        <pre class="evidence" id="evidenceBox">یک پرونده را انتخاب کنید.</pre></div>
    </div>

    <div data-panel="appeals" class="hidden">
      <h2>اعتراض‌ها</h2>
      <div class="card">
        <table><thead><tr><th>شناسه</th><th>دلیل بن</th><th>پیام</th>
          <th>تماس</th><th>زمان</th><th></th></tr></thead>
        <tbody id="appealTable"></tbody></table>
      </div>
    </div>

    <div data-panel="alerts" class="hidden">
      <h2>هشدارهای تقلب</h2>
      <div class="card">
        <table><thead><tr><th>شدت</th><th>نوع</th><th>جزئیات</th><th>زمان</th></tr></thead>
        <tbody id="alertTable"></tbody></table>
      </div>
    </div>

    <div data-panel="settings" class="hidden">
      <h2>تنظیمات</h2>
      <form id="settingsForm" class="card">
        <div class="grid g2">
          <div class="field"><label>نام سرور</label><input name="serverName"></div>
          <div class="field"><label>دامنه سرور</label><input name="serverHost"></div>
          <div class="field"><label>آی‌پی نمایشی</label><input name="serverIp"></div>
          <div class="field"><label>ایمیل پشتیبانی</label><input name="supportEmail"></div>
          <div class="field"><label>لینک دیسکورد</label><input name="discordUrl"></div>
          <div class="field"><label>لینک تلگرام</label><input name="telegramUrl"></div>
        </div>
        <h3 style="margin-top:18px">پرداخت</h3>
        <div class="grid g2">
          <div class="field"><label>شناسه زرین‌پال</label><input name="zarinpalMerchantId"></div>
          <div class="field"><label>دارنده کارت</label><input name="cardHolder"></div>
          <div class="field"><label>شماره کارت</label><input name="cardNumber" inputmode="numeric"></div>
        </div>
        <div class="row" style="margin:12px 0">
          <label style="display:flex;gap:6px;align-items:center;margin:0">
            <input type="checkbox" name="shopEnabled" style="width:auto"> فروشگاه فعال</label>
          <label style="display:flex;gap:6px;align-items:center;margin:0">
            <input type="checkbox" name="zarinpalEnabled" style="width:auto"> زرین‌پال فعال</label>
          <label style="display:flex;gap:6px;align-items:center;margin:0">
            <input type="checkbox" name="card2cardEnabled" style="width:auto"> کارت‌به‌کارت فعال</label>
          <label style="display:flex;gap:6px;align-items:center;margin:0">
            <input type="checkbox" name="maintenance" style="width:auto"> حالت تعمیر</label>
          <label style="display:flex;gap:6px;align-items:center;margin:0">
            <input type="checkbox" name="whitelist" style="width:auto"> وایت‌لیست</label>
        </div>
        <button class="btn primary">ذخیره تنظیمات</button>
      </form>
    </div>
  </div>
</div>
</main>
</div>

<script src="/admin.js"></script>
</body>
</html>`;
