/*NOVA-SITE-START*/
(function(){
"use strict";
var state = { me:null, products:[], payments:{}, settings:null, status:null };

function el(id){ return document.getElementById(id); }
function esc(s){
  return String(s==null?"":s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}
function toast(msg, kind){
  var t = document.createElement("div");
  t.className = "toast " + (kind||"");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 4200);
}
function api(path, opts){
  opts = opts || {};
  opts.credentials = "same-origin";
  opts.headers = Object.assign({"content-type":"application/json"}, opts.headers||{});
  return fetch(path, opts).then(function(r){
    return r.json().then(function(j){ return {ok:r.ok, status:r.status, body:j}; });
  });
}
function money(cents){
  var usd = (cents/100);
  return "$" + (usd % 1 === 0 ? usd.toFixed(0) : usd.toFixed(2));
}

/* ------------------------------------------------------------- boot */
function boot(){
  var themeBtn = el("theme");
  if (themeBtn){
    var saved = localStorage.getItem("theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    themeBtn.onclick = function(){
      var cur = document.documentElement.getAttribute("data-theme")==="light" ? "" : "light";
      if (cur) document.documentElement.setAttribute("data-theme", cur);
      else document.documentElement.removeAttribute("data-theme");
      localStorage.setItem("theme", cur);
    };
  }
  api("/api/status").then(function(r){
    if (!r.ok) return;
    state.status = r.body;
    renderStatus(); renderModes(); renderRanks();
    document.title = (r.body.name||"Minecraft Server") + " — سرور ماینکرفت";
    var n = el("serverName"); if (n) n.textContent = r.body.name || "";
    var ip = el("serverIp"); if (ip) ip.textContent = r.body.ip || "";
  });
  refreshMe();
  var f = el("otpForm"); if (f) f.onsubmit = onOtpRequest;
  var v = el("otpVerify"); if (v) v.onsubmit = onOtpVerify;
  var lg = el("logout"); if (lg) lg.onclick = onLogout;
}

function refreshMe(){
  return api("/api/me").then(function(r){
    if (r.ok){ state.me = r.body.user; showAuthed(); loadShop(); }
    else { state.me = null; showGated(); }
  });
}

/* ------------------------------------------------- OTP verification */
function onOtpRequest(e){
  e.preventDefault();
  var phone = el("phone").value.trim();
  var btn = e.target.querySelector("button");
  btn.disabled = true;
  api("/api/auth/otp/request", {method:"POST", body:JSON.stringify({phone:phone})})
    .then(function(r){
      btn.disabled = false;
      if (!r.ok){ toast(r.body.reason || "خطا در ارسال کد", "err"); return; }
      el("step1").classList.add("hidden");
      el("step2").classList.remove("hidden");
      if (r.body.devCode){
        toast("حالت توسعه: کد شما " + r.body.devCode, "info");
        el("code").value = r.body.devCode;
      } else {
        toast("کد ارسال شد (" + r.body.channel + ")", "ok");
      }
    });
}

function onOtpVerify(e){
  e.preventDefault();
  var phone = el("phone").value.trim();
  var code = el("code").value.trim();
  api("/api/auth/otp/verify", {method:"POST", body:JSON.stringify({phone:phone, code:code})})
    .then(function(r){
      if (!r.ok){
        toast(r.body.reason === "invalid_code"
          ? "کد اشتباه است (" + (r.body.attemptsLeft||0) + " تلاش باقی)"
          : (r.body.reason || "خطا"), "err");
        return;
      }
      toast("ورود موفق", "ok");
      refreshMe();
    });
}

function onLogout(){
  api("/api/auth/logout", {method:"POST"}).then(function(){
    state.me = null; showGated(); toast("خارج شدید", "ok");
  });
}

function showAuthed(){
  el("gated").classList.add("hidden");
  el("authed").classList.remove("hidden");
  el("shopSection").classList.remove("hidden");
  var u = state.me;
  el("meName").textContent = u.username || ("بازیکن " + String(u.id).slice(0,6));
  el("meRank").textContent = (u.rank && u.rank.labelFa) || u.rankId;
  el("meRank").style.color = (u.rank && u.rank.colour) || "#fff";
  el("meXp").textContent = u.xp;
  el("meCoins").textContent = u.coins;
  el("meGems").textContent = u.gems;
  el("meElo").textContent = u.elo;
  if (u.nextRankXp){
    var pct = Math.min(100, Math.round((u.xp / u.nextRankXp) * 100));
    el("xpBar").style.width = pct + "%";
    el("xpText").textContent = u.xp + " / " + u.nextRankXp + " (" + pct + "%)";
  } else {
    el("xpBar").style.width = "100%";
    el("xpText").textContent = "حداکثر رنک";
  }
}

function showGated(){
  el("gated").classList.remove("hidden");
  el("authed").classList.add("hidden");
  el("shopSection").classList.add("hidden");
}

/* ------------------------------------------------------------- shop */
function loadShop(){
  api("/api/products").then(function(r){
    if (!r.ok) return;
    state.products = r.body.products || [];
    state.payments = r.body.payments || {};
    renderProducts();
    renderPaymentInfo();
  });
}

function renderProducts(){
  var host = el("products");
  if (!host) return;
  var groups = {};
  state.products.forEach(function(p){
    (groups[p.kind] = groups[p.kind] || []).push(p);
  });
  var titles = {rank:"رنک‌ها", cosmetic:"کاستومایز", bundle:"باندل‌ها", booster:"بوستر و جم", config:"کانفیگ اتصال"};
  var html = "";
  Object.keys(titles).forEach(function(kind){
    var list = groups[kind];
    if (!list || !list.length) return;
    html += '<h3 style="margin-top:26px">' + esc(titles[kind]) + '</h3><div class="grid g3">';
    list.forEach(function(p){
      var disc = p.discountPct > 0;
      html += '<div class="card">'
        + '<div class="row spread"><strong>' + esc(p.titleFa) + '</strong>'
        + (disc ? '<span class="badge warn">' + p.discountPct + '% تخفیف</span>' : '') + '</div>'
        + '<div class="muted" style="font-size:.86rem;min-height:2.6em">' + esc(p.description||"") + '</div>'
        + '<div class="price">' + money(p.priceUsd)
        + (disc ? ' <s>' + money(p.baseUsd) + '</s>' : '') + '</div>'
        + '<div class="row" style="margin-top:10px">'
        + (state.payments.zarinpal
            ? '<button class="btn primary sm" data-buy="' + esc(p.sku) + '" data-m="zarinpal">پرداخت آنلاین</button>' : '')
        + (state.payments.card2card
            ? '<button class="btn sm" data-buy="' + esc(p.sku) + '" data-m="card2card">کارت‌به‌کارت</button>' : '')
        + '</div></div>';
    });
    html += '</div>';
  });
  host.innerHTML = html || '<p class="muted">محصولی موجود نیست.</p>';
  Array.prototype.forEach.call(host.querySelectorAll("[data-buy]"), function(b){
    b.onclick = function(){ checkout(b.getAttribute("data-buy"), b.getAttribute("data-m")); };
  });
}

function renderPaymentInfo(){
  var box = el("paymentInfo");
  if (!box) return;
  var p = state.payments;
  var lines = [];
  if (p.zarinpal) lines.push("پرداخت آنلاین فعال است.");
  if (p.card2card) lines.push("کارت‌به‌کارت: " + (p.cardMasked||"") + " — " + (p.cardHolder||""));
  if (!lines.length) lines.push("درگاه پرداخت هنوز توسط مدیر فعال نشده است.");
  box.innerHTML = lines.map(function(l){ return "<div>" + esc(l) + "</div>"; }).join("");
}

function checkout(sku, method){
  api("/api/shop/checkout", {method:"POST", body:JSON.stringify({sku:sku, method:method})})
    .then(function(r){
      if (!r.ok){ toast(r.body.error || "خطا در ساخت سفارش", "err"); return; }
      if (r.body.paymentUrl){ window.location.href = r.body.paymentUrl; return; }
      if (r.body.method === "card2card"){ openReceiptModal(r.body); return; }
      toast("سفارش ساخته شد", "ok");
    });
}

function openReceiptModal(order){
  var html = '<div class="modal-bg" id="rbg"><div class="modal">'
    + '<h3>پرداخت کارت‌به‌کارت</h3>'
    + '<p class="muted">مبلغ <b>' + money(order.amountUsd) + '</b> را به کارت زیر واریز کنید:</p>'
    + '<div class="card"><div><b>' + esc(order.card||"") + '</b></div>'
    + '<div class="muted">' + esc(order.cardHolder||"") + '</div></div>'
    + '<p class="muted" style="margin-top:12px">' + esc(order.instructions||"") + '</p>'
    + '<div class="field"><label>تصویر فیش واریزی</label>'
    + '<input type="file" id="receiptFile" accept="image/*"></div>'
    + '<div class="row"><button class="btn primary" id="sendReceipt">ارسال فیش</button>'
    + '<button class="btn" id="closeReceipt">بستن</button></div>'
    + '<p class="muted" style="font-size:.8rem;margin-top:10px">فیش‌ها توسط هوش مصنوعی بررسی و در صورت نیاز توسط مدیر تایید می‌شوند. تایید خودکار انجام نمی‌شود.</p>'
    + '</div></div>';
  var wrap = document.createElement("div");
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstChild);
  el("closeReceipt").onclick = function(){ el("rbg").remove(); };
  el("sendReceipt").onclick = function(){
    var f = el("receiptFile").files[0];
    if (!f){ toast("ابتدا فایل را انتخاب کنید", "err"); return; }
    var fd = new FormData();
    fd.append("receipt", f);
    fetch("/api/shop/receipt?order=" + encodeURIComponent(order.orderId), {
      method:"POST", body:fd, credentials:"same-origin"
    }).then(function(r){ return r.json(); }).then(function(j){
      if (!j.ok){ toast(j.error || "خطا در ارسال فیش", "err"); return; }
      el("rbg").remove();
      toast(j.autoApprove ? "فیش دریافت شد، در حال بررسی" : "فیش برای بررسی مدیر ارسال شد", "ok");
    });
  };
}

/* -------------------------------------------------------- sections */
function renderStatus(){
  var s = state.status; if (!s) return;
  var host = el("servers"); if (!host) return;
  if (!s.servers.length){
    host.innerHTML = '<p class="muted">سروری ثبت نشده است.</p>';
    return;
  }
  host.innerHTML = s.servers.map(function(sv){
    var cls = sv.status==="online" ? "ok" : sv.status==="error" ? "err"
            : sv.status==="offline" ? "off" : "warn";
    return '<div class="card row spread">'
      + '<div><strong>' + esc(sv.name) + '</strong>'
      + ' <span class="badge ' + cls + '">' + esc(sv.status) + '</span></div>'
      + '<div class="muted">' + sv.onlinePlayers + ' / ' + sv.maxPlayers + ' بازیکن'
      + (sv.bedrock ? ' — Bedrock:' + sv.bedrock.port : '') + '</div></div>';
  }).join("");
}

function renderModes(){
  var s = state.status; if (!s) return;
  var host = el("modes"); if (!host) return;
  host.innerHTML = s.modes.map(function(m){
    return '<div class="card"><h3>' + esc(m.titleFa) + '</h3>'
      + '<div class="muted" style="font-size:.85rem">' + esc(m.titleEn) + '</div>'
      + '<div class="muted" style="font-size:.85rem;margin-top:8px">'
      + m.minPlayers + '–' + m.maxPlayers + ' بازیکن</div></div>';
  }).join("");
}

function renderRanks(){
  var s = state.status; if (!s) return;
  var host = el("ranks"); if (!host) return;
  host.innerHTML = s.ranks.map(function(r){
    return '<div class="card" style="border-color:' + esc(r.colour) + '">'
      + '<div class="tag" style="background:' + esc(r.colour) + '22;color:' + esc(r.colour) + '">'
      + esc(r.tag || r.labelFa) + '</div>'
      + '<h3 style="margin-top:8px">' + esc(r.labelFa) + '</h3>'
      + '<ul class="muted" style="font-size:.85rem;padding-inline-start:18px">'
      + r.perks.map(function(p){ return "<li>" + esc(p) + "</li>"; }).join("") + '</ul>'
      + '<div class="muted" style="font-size:.82rem">رایگان با ' + r.xpThreshold + ' امتیاز'
      + (r.priceUsd ? ' یا ' + money(r.priceUsd) : '') + '</div></div>';
  }).join("");
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
})();
/*NOVA-SITE-END*/