/*
 * Nova Termux UI. Plain browser JS, no build step, no CDN.
 *
 * CSP in server.py is `script-src 'self'`, so everything lives here — no
 * inline handlers and no remote includes.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function api(path, options) {
    return fetch(path, options).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'bad_response' }; });
    });
  }

  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  var toastTimer = null;
  function toast(message) {
    var node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove('show'); }, 3200);
  }

  function faNumber(value) {
    return String(value).replace(/[0-9]/g, function (d) {
      return '۰۱۲۳۴۵۶۷۸۹'[parseInt(d, 10)];
    });
  }

  /* ------------------------------------------------------------- tabs */

  var tabs = document.querySelectorAll('nav.tabs button');
  var loaded = {};

  function showTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('section.tab'), function (s) {
      s.classList.toggle('active', s.id === 'tab-' + name);
    });
    Array.prototype.forEach.call(tabs, function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    if (!loaded[name]) {
      loaded[name] = true;
      if (name === 'places') loadPlaces();
      if (name === 'location') { loadFix(); loadGpsStatus(); }
      if (name === 'shop') loadShop();
      if (name === 'files') loadFiles('');
    }
  }

  Array.prototype.forEach.call(tabs, function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
  });

  /* ------------------------------------------------------------ status */

  function refreshStatus() {
    api('/api/status').then(function (s) {
      var gps = s.gps || {};
      var pill = $('pill-gps');
      if (gps.termux_api_installed) {
        pill.textContent = 'جی‌پی‌اس آماده';
        pill.className = 'pill ok';
      } else {
        pill.textContent = 'Termux:API ندارد';
        pill.className = 'pill warn';
      }
      $('pill-places').textContent = 'مکان: ' + faNumber(s.places_count);
    });
  }

  /* -------------------------------------------------------------- chat */

  var log = $('chat-log');

  function addMessage(text, who, meta) {
    var box = el('div', 'msg ' + who);
    box.textContent = text;
    if (meta) box.appendChild(el('div', 'meta', meta));
    log.appendChild(box);
    window.scrollTo(0, document.body.scrollHeight);
    return box;
  }

  function setChips(list) {
    var wrap = $('quick-chips');
    wrap.innerHTML = '';
    (list || []).slice(0, 5).forEach(function (s) {
      var chip = el('button', 'chip', s);
      chip.addEventListener('click', function () { send(s); });
      wrap.appendChild(chip);
    });
  }

  var QUICK = [
    'کجام؟',
    'اینجا رو سیو کن به اسم خونه',
    'مکان‌های ذخیره شده',
    'وضعیت جی‌پی‌اس',
    'گیم‌مودها',
    'رنک‌ها',
    'تخفیف',
    'ضد تقلب'
  ];
  setChips(QUICK);

  function send(text) {
    text = (text || '').trim();
    if (!text) return;
    addMessage(text, 'user');
    $('chat-input').value = '';
    var pending = addMessage('…', 'bot');
    pending.innerHTML = '<span class="spinner"></span>';
    post('/api/ask', { text: text }).then(function (reply) {
      pending.textContent = reply.text || '(پاسخی نیامد)';
      pending.classList.toggle('err', reply.kind === 'error' || reply.kind === 'not_found');
      pending.appendChild(el('div', 'meta',
        'نیت: ' + reply.intent + ' • اطمینان: ' + Number(reply.confidence || 0).toFixed(2)));
      if (reply.sources && reply.sources.length) {
        pending.appendChild(el('div', 'meta', 'منبع: ' + reply.sources.join('، ')));
      }
      setChips(reply.suggestions && reply.suggestions.length ? reply.suggestions : QUICK);
      refreshStatus();
    }).catch(function () {
      pending.textContent = 'ارتباط با سرور محلی قطع شد.';
      pending.classList.add('err');
    });
  }

  $('btn-send').addEventListener('click', function () { send($('chat-input').value); });
  $('chat-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') send(this.value);
  });
  $('btn-help').addEventListener('click', function () { send('کمک'); });

  /* ------------------------------------------------------------ places */

  function loadPlaces() {
    api('/api/places').then(function (res) {
      var tbody = $('places-table').querySelector('tbody');
      tbody.innerHTML = '';
      var places = res.places || [];
      $('places-empty').style.display = places.length ? 'none' : 'block';
      $('places-table').style.display = places.length ? 'table' : 'none';
      places.forEach(function (p) {
        var tr = el('tr');
        var tdName = el('td');
        tdName.appendChild(el('strong', null, p.name));
        if (p.aliases && p.aliases.length) {
          tdName.appendChild(el('div', 'muted small', p.aliases.join('، ')));
        }
        if (p.note) tdName.appendChild(el('div', 'muted small', p.note));
        tr.appendChild(tdName);
        tr.appendChild(el('td', 'mono', p.lat.toFixed(5) + ', ' + p.lon.toFixed(5)));
        tr.appendChild(el('td', null, faNumber(p.visits)));
        var tdAct = el('td');
        var route = el('button', 'small', 'مسیر');
        route.addEventListener('click', function () { showRoute(p.name); });
        var del = el('button', 'small danger', 'حذف');
        del.addEventListener('click', function () { removePlace(p.name); });
        tdAct.appendChild(route);
        tdAct.appendChild(del);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      });
    });
  }

  function showRoute(name) {
    api('/api/route?to=' + encodeURIComponent(name)).then(function (res) {
      if (!res.ok) { toast('مکان پیدا نشد'); return; }
      if (res.error === 'no_current_location') {
        toast(res.hint_fa || 'موقعیت فعلی در دسترس نیست');
        return;
      }
      var leg = res.leg;
      toast('به ' + name + ': ' + leg.distance_fa + ' سمت ' + leg.compass +
            ' • پیاده ' + faNumber(Math.round(leg.eta.walk / 60)) + ' دقیقه');
      addMessage('مسیر «' + name + '»\nجهت: ' + leg.compass +
                 ' (' + faNumber(Math.round(leg.bearing)) + '°)\nفاصله: ' + leg.distance_fa,
                 'bot', 'از /api/route');
      showTab('assistant');
    });
  }

  function removePlace(name) {
    if (!confirm('«' + name + '» پاک شود؟')) return;
    api('/api/places/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function (res) {
        toast(res.ok ? 'پاک شد' : 'پاک نشد');
        loadPlaces();
        refreshStatus();
      });
  }

  $('btn-save-here').addEventListener('click', function () {
    $('save-box').style.display = 'block';
    $('save-fix').innerHTML = '<span class="spinner"></span> در حال گرفتن موقعیت…';
    $('save-name').focus();
    api('/api/gps').then(function (res) {
      if (!res.ok) {
        $('save-fix').textContent = res.hint_fa || 'موقعیت گرفته نشد.';
        return;
      }
      $('save-fix').textContent = 'موقعیت: ' + res.fix.lat.toFixed(6) + ', ' +
        res.fix.lon.toFixed(6) + ' • ' + res.fix.quality_fa + ' • ' + res.fix.age_fa;
    });
  });

  $('btn-save-cancel').addEventListener('click', function () {
    $('save-box').style.display = 'none';
  });

  $('btn-save-confirm').addEventListener('click', function () {
    var name = $('save-name').value.trim();
    if (!name) { toast('اسم را بنویس'); return; }
    post('/api/places', { name: name }).then(function (res) {
      if (!res.ok) { toast(res.hint_fa || 'ذخیره نشد'); return; }
      toast(res.created ? 'ذخیره شد' : 'به‌روزرسانی شد');
      $('save-box').style.display = 'none';
      $('save-name').value = '';
      loadPlaces();
      refreshStatus();
    });
  });

  /* ---------------------------------------------------------- location */

  function loadFix() {
    $('fix-body').innerHTML = '<span class="spinner"></span> در حال گرفتن موقعیت…';
    api('/api/gps?timeout=25').then(function (res) {
      if (!res.ok) {
        $('fix-body').textContent = res.hint_fa || 'موقعیت گرفته نشد.';
        return;
      }
      var f = res.fix;
      var node = el('div');
      node.appendChild(el('div', null, '📍 ' + faNumber(f.lat.toFixed(6)) + '، ' + faNumber(f.lon.toFixed(6))));
      node.appendChild(el('div', 'muted small', f.quality_fa + ' • منبع: ' + f.source + ' • ' + f.age_fa));
      if (res.notes && res.notes.length) {
        node.appendChild(el('div', 'muted small', res.notes.join(' | ')));
      }
      var link = el('a', 'small', 'باز کردن در نقشه');
      link.href = res.maps; link.target = '_blank'; link.rel = 'noopener';
      node.appendChild(el('div', null, link));
      $('fix-body').innerHTML = '';
      $('fix-body').appendChild(node);
    });
  }

  function loadGpsStatus() {
    api('/api/gps/status').then(function (st) {
      $('gps-status').textContent = JSON.stringify(st, null, 2);
    });
  }

  $('btn-refresh-fix').addEventListener('click', loadFix);

  $('btn-watch').addEventListener('click', function () {
    var starting = this.getAttribute('data-on') !== '1';
    var btn = this;
    post('/api/gps/watch', { action: starting ? 'start' : 'stop' }).then(function (res) {
      btn.setAttribute('data-on', res.watching ? '1' : '0');
      btn.textContent = res.watching ? 'توقف پایش' : 'پایش زنده';
      toast(res.watching ? 'پایش زنده فعال شد' : (res.hint_fa || 'پایش متوقف شد'));
    });
  });

  $('btn-nearest').addEventListener('click', function () {
    api('/api/places/nearest').then(function (res) {
      if (!res.ok) { toast(res.hint_fa || 'موقعیت نیست'); return; }
      if (!res.nearest || !res.nearest.length) { toast('مکانی ذخیره نشده'); return; }
      var lines = res.nearest.map(function (n) {
        return '• ' + n.place.name + ' — ' + faNumber(Math.round(n.metres)) + ' متر';
      });
      addMessage('نزدیک‌ترین مکان‌ها:\n' + lines.join('\n'), 'bot', 'از /api/places/nearest');
      showTab('assistant');
    });
  });

  $('btn-manual').addEventListener('click', function () {
    var lat = parseFloat($('manual-lat').value);
    var lon = parseFloat($('manual-lon').value);
    if (isNaN(lat) || isNaN(lon)) { toast('دو عدد معتبر لازم است'); return; }
    post('/api/gps/manual', { lat: lat, lon: lon }).then(function (res) {
      toast(res.ok ? 'موقعیت دستی ثبت شد' : 'نامعتبر');
      if (res.ok) loadFix();
    });
  });

  /* -------------------------------------------------------------- shop */

  var KIND_FA = { rank: 'رنک', cosmetic: 'آرایشی', booster: 'بوست', bundle: 'بسته' };

  function loadShop() {
    api('/api/catalog').then(function (cat) {
      var wrap = $('shop-groups');
      wrap.innerHTML = '';
      if (!cat.products || !cat.products.length) {
        wrap.appendChild(el('div', 'card muted',
          'data/catalog.json پیدا نشد. در پوشه‌ی پروژه اجرا کن: node scripts/export-catalog.mjs'));
        return;
      }
      var groups = {};
      cat.products.forEach(function (p) {
        (groups[p.kind] = groups[p.kind] || []).push(p);
      });
      Object.keys(groups).forEach(function (kind) {
        var card = el('div', 'card');
        card.appendChild(el('h2', null, (KIND_FA[kind] || kind) +
          ' (' + faNumber(groups[kind].length) + ')'));
        var table = el('table', 'grid');
        var thead = el('thead');
        thead.innerHTML = '<tr><th>محصول</th><th>قیمت</th><th></th></tr>';
        table.appendChild(thead);
        var tbody = el('tbody');
        groups[kind].forEach(function (p) {
          var tr = el('tr');
          var td = el('td');
          td.appendChild(el('div', null, p.title_fa));
          td.appendChild(el('div', 'muted small', p.description));
          tr.appendChild(td);
          tr.appendChild(el('td', 'mono', '$' + (p.price_usd / 100).toFixed(2)));
          var tdA = el('td');
          var ask = el('button', 'small', 'بپرس');
          ask.addEventListener('click', function () {
            showTab('assistant');
            send('درباره ' + p.title_fa + ' توضیح بده');
          });
          tdA.appendChild(ask);
          tr.appendChild(tdA);
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        card.appendChild(table);
        wrap.appendChild(card);
      });
    });
  }

  /* ------------------------------------------------------------- files */

  var currentPath = '';

  function loadFiles(path) {
    currentPath = path || '';
    api('/api/files?path=' + encodeURIComponent(currentPath)).then(function (res) {
      var list = $('files-list');
      list.innerHTML = '';
      $('files-path').textContent = '/' + currentPath;
      if (!res.ok) { list.appendChild(el('div', 'muted', 'خوانده نشد')); return; }
      res.entries.forEach(function (e) {
        var row = el('div', 'file-row');
        if (e.is_dir) {
          var link = el('a', null, '📁 ' + e.name);
          link.href = '#';
          link.addEventListener('click', function (ev) {
            ev.preventDefault();
            loadFiles(e.path);
          });
          row.appendChild(link);
          row.appendChild(el('span', 'muted small', '—'));
        } else {
          var fl = el('a', null, '📄 ' + e.name);
          fl.href = '/fs/' + e.path;
          fl.target = '_blank';
          fl.rel = 'noopener';
          row.appendChild(fl);
          row.appendChild(el('span', 'muted small', e.size_fa));
        }
        list.appendChild(row);
      });
    });
  }

  $('btn-files-up').addEventListener('click', function () {
    var parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    loadFiles(parts.join('/'));
  });

  /* -------------------------------------------------------------- init */

  refreshStatus();
  setInterval(refreshStatus, 30000);

  addMessage(
    'سلام! 👋 آفلاین و آماده‌ام.\n' +
    '• جایی که هستی را سیو کن: «اینجا رو سیو کن به اسم خونه»\n' +
    '• بعد بگو: «برم خونه»\n' +
    '• یا هر سؤالی داری بپرس.',
    'bot', 'nova-termux'
  );
})();
