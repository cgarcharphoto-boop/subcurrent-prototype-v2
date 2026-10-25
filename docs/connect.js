// Live connector to the real subcurrent-backend API.
//
// index.html is generated (see CLAUDE.md), so this file never reaches into its
// minified internals. It works from the outside only:
//   1. Listens (capture phase) for the app's own buttons, such as checkout "Pay"
//      and owner "Publish", reads the selection from the DOM, and makes the
//      matching real API call alongside the prototype's simulated flow.
//   2. Adds a "Live" panel with real accounts, real tickets with rotating
//      door codes, real door check-in, the owner dashboard, publishing, and
//      AI flyer reading.
// It survives regeneration of index.html and stays invisible if the API is down.
(function () {
  'use strict';

  // Same origin as the app (Vercel serves the API under /api). A file:// copy,
  // localhost or the GitHub Pages mirror falls back to the deployed v2.
  var API_BASE = /^https?:$/.test(location.protocol) && !/^(localhost|127\.)|\.github\.io$/.test(location.hostname)
    ? location.origin + '/api' : 'https://subcurrent-prototype-v2.vercel.app/api';
  try { API_BASE = localStorage.getItem('sc_api') || API_BASE; } catch (e) {}

  // App event id -> backend slug, and app tier id -> backend tier name.
  var EVENT_SLUG = { frost: 'ReturnalNights-Oct23', thin: 'ReturnalNights-Oct24', white: 'HallowCurrentAfters', alt: 'UndertowAfters' };
  var TIER_NAME = { early: 'Early bird', ga: 'General admission', vip: 'VIP' };

  // ---------- storage ----------
  function load(k) { try { return JSON.parse(localStorage.getItem('sc_' + k) || 'null'); } catch (e) { return null; } }
  function save(k, v) { try { v == null ? localStorage.removeItem('sc_' + k) : localStorage.setItem('sc_' + k, JSON.stringify(v)); } catch (e) {} }
  var fan = load('fan');     // { token, name, email, demo }
  var owner = load('owner'); // { token, name, role }

  // ---------- api ----------
  function api(path, opts, token) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(API_BASE + path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || ('Request failed (' + res.status + ')'));
            err.status = res.status;
            throw err;
          }
          return data;
        });
      });
  }

  function demoFan() {
    return api('/auth/fan/demo', { method: 'POST' }).then(function (d) {
      fan = { token: d.token, name: d.fan.name, email: d.fan.email, demo: true };
      save('fan', fan);
      return fan;
    });
  }
  function ensureFan() { return fan ? Promise.resolve(fan) : demoFan(); }

  // Fan call with one recovery: the demo backend's database resets on cold
  // start, which invalidates stored demo identities. Re-issue and retry once.
  function fanApi(path, opts) {
    return ensureFan().then(function (f) {
      return api(path, opts, f.token).catch(function (e) {
        if (f.demo && (e.status === 401 || e.status === 500)) {
          return demoFan().then(function (f2) { return api(path, opts, f2.token); });
        }
        if (!f.demo && e.status === 500) {
          throw new Error('The demo server restarted and cleared accounts. Sign up again.');
        }
        throw e;
      });
    });
  }
  function ownerApi(path, opts) {
    if (!owner) return Promise.reject(new Error('Sign in as owner first.'));
    return api(path, opts, owner.token).catch(function (e) {
      if (e.status === 401 || e.status === 403) { owner = null; save('owner', null); render(); }
      throw e;
    });
  }

  var eventCache = {};
  function getEvent(slug) {
    if (eventCache[slug]) return Promise.resolve(eventCache[slug]);
    return api('/events/' + encodeURIComponent(slug)).then(function (ev) { eventCache[slug] = ev; return ev; });
  }

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(c) { return '$' + (c / 100).toFixed(c % 100 ? 2 : 0); }
  function when(d) { try { return new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }
  function $(sel, root) { return (root || document).querySelector(sel); }

  var toastTimer;
  function toast(msg, bad) {
    var t = $('#sc-toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'on' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 4200);
  }

  // ---------- styles ----------
  function injectStyles() {
    var s = document.createElement('style');
    s.textContent = [
      '#sc-pill{position:fixed;left:14px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:9998;font:600 12px/1 -apple-system,system-ui,sans-serif;background:#15101F;color:#EEE8FF;border:1px solid rgba(238,232,255,.26);border-radius:999px;padding:9px 14px;display:flex;align-items:center;gap:7px;box-shadow:0 8px 24px rgba(0,0,0,.45);cursor:pointer}',
      '#sc-pill .dot{width:7px;height:7px;border-radius:50%;background:#4CC48D;box-shadow:0 0 8px #4CC48D}',
      '#sc-panel{position:fixed;left:14px;bottom:calc(128px + env(safe-area-inset-bottom));z-index:9999;width:min(380px,calc(100vw - 28px));max-height:min(620px,calc(100vh - 150px));overflow:auto;background:#0D0A14;color:#EEE8FF;border:1px solid rgba(238,232,255,.26);border-radius:16px;box-shadow:0 18px 48px rgba(0,0,0,.6);font:14px/1.45 -apple-system,system-ui,sans-serif;display:none}',
      '#sc-panel.on{display:block}',
      '#sc-panel header{position:sticky;top:0;background:#0D0A14;padding:14px 16px 0;border-bottom:1px solid rgba(238,232,255,.12)}',
      '#sc-panel h2{font-size:15px;margin:0 0 10px;display:flex;align-items:center;gap:8px}',
      '#sc-panel h2 .x{margin-left:auto;background:none;border:0;color:#C4B5E6;font-size:20px;cursor:pointer;line-height:1}',
      '#sc-tabs{display:flex;gap:4px}',
      '#sc-tabs{overflow-x:auto;scrollbar-width:none}#sc-tabs button{flex:1 0 auto;background:none;border:0;border-bottom:2px solid transparent;color:#8C7FB3;padding:8px 6px 10px;font:600 12px -apple-system,system-ui,sans-serif;cursor:pointer;white-space:nowrap}',
      '#sc-tabs button[aria-selected=true]{color:#EEE8FF;border-bottom-color:#C99BFF}',
      '#sc-body{padding:14px 16px 18px}',
      '#sc-body h3{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8C7FB3;margin:16px 0 8px}',
      '#sc-body h3:first-child{margin-top:0}',
      '#sc-body p{margin:0 0 8px;color:#C4B5E6}',
      '#sc-body .muted{color:#8C7FB3;font-size:12px}',
      '#sc-body input,#sc-body select{width:100%;box-sizing:border-box;background:#15101F;color:#EEE8FF;border:1px solid rgba(238,232,255,.26);border-radius:10px;padding:9px 10px;font:14px -apple-system,system-ui,sans-serif;margin:0 0 8px}',
      '#sc-body .row{display:flex;gap:8px}',
      '#sc-body .row>*{flex:1}',
      '#sc-body .b{display:block;box-sizing:border-box;background:#C99BFF;color:#040307;border:0;border-radius:10px;padding:9px 12px;font:700 13px -apple-system,system-ui,sans-serif;cursor:pointer;width:100%;margin:0 0 8px}',
      '#sc-body .b.g{background:none;color:#EEE8FF;border:1px solid rgba(238,232,255,.26)}',
      '#sc-body button:disabled{opacity:.5;cursor:default}',
      '#sc-body .card{background:#15101F;border:1px solid rgba(238,232,255,.12);border-radius:12px;padding:12px;margin:0 0 8px}',
      '#sc-body .code{font:700 26px/1.1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.12em;color:#C99BFF;margin:6px 0}',
      '#sc-body .bar{height:3px;background:rgba(238,232,255,.12);border-radius:2px;overflow:hidden}',
      '#sc-body .bar i{display:block;height:100%;background:#C99BFF;transition:width 1s linear}',
      '#sc-body .kv{display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid rgba(238,232,255,.08)}',
      '#sc-body .ok{color:#4CC48D}#sc-body .bad{color:#FF6B85}#sc-body .warn{color:#F2C94B}',
      '#sc-body .result{font-weight:700;font-size:16px;padding:10px;border-radius:10px;text-align:center;margin:0 0 8px}',
      '#sc-body .result.ok{background:rgba(76,196,141,.14)}#sc-body .result.bad{background:rgba(255,107,133,.14)}#sc-body .result.warn{background:rgba(242,201,75,.14)}',
      '#sc-body .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0 0 8px}',
      '#sc-body .stats div{background:#15101F;border-radius:10px;padding:10px;text-align:center}',
      '#sc-body .stats b{display:block;font-size:20px}',
      '#sc-body pre{white-space:pre-wrap;background:#15101F;border-radius:10px;padding:10px;font:12px ui-monospace,monospace;color:#C4B5E6}',
      '#sc-body textarea{width:100%;box-sizing:border-box;background:#15101F;color:#EEE8FF;border:1px solid rgba(238,232,255,.26);border-radius:10px;padding:9px 10px;font:14px/1.4 -apple-system,system-ui,sans-serif;margin:0 0 8px;resize:vertical;min-height:64px}',
      '#sc-body .post{background:#15101F;border:1px solid rgba(238,232,255,.12);border-radius:12px;padding:12px;margin:0 0 8px}',
      '#sc-body .post.pin{border-color:#C99BFF}',
      '#sc-body .who{display:flex;align-items:center;gap:6px;font-weight:700;margin:0 0 4px}',
      '#sc-body .who .t{font:600 11px -apple-system,system-ui,sans-serif;color:#8C7FB3;margin-left:auto}',
      '#sc-body .badge{font:700 10px/1 -apple-system,system-ui,sans-serif;background:#C99BFF;color:#040307;border-radius:6px;padding:3px 5px}',
      '#sc-body .txt{white-space:pre-wrap;word-wrap:break-word;color:#EEE8FF;margin:0 0 8px}',
      '#sc-body .acts{display:flex;gap:14px}',
      '#sc-body .acts button{background:none;border:0;color:#C4B5E6;font:600 12px -apple-system,system-ui,sans-serif;cursor:pointer;padding:2px 0}',
      '#sc-body .acts button.on{color:#FF6B85}',
      '#sc-body .cms{margin-top:8px;border-top:1px solid rgba(238,232,255,.08);padding-top:8px}',
      '#sc-body .cm{font-size:13px;margin:0 0 6px;color:#C4B5E6}#sc-body .cm b{color:#EEE8FF}',
      '#sc-body .chat{display:flex;flex-direction:column;gap:6px;max-height:330px;overflow:auto;margin:0 0 8px;padding:2px}',
      '#sc-body .bub{max-width:82%;padding:8px 11px;border-radius:14px;background:#15101F;white-space:pre-wrap;word-wrap:break-word;font-size:14px}',
      '#sc-body .bub.me{align-self:flex-end;background:#C99BFF;color:#040307}',
      '#sc-body .bub small{display:block;font-size:10px;opacity:.65;margin-top:3px}',
      '#sc-body .th{display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;background:#15101F;border:1px solid rgba(238,232,255,.12);border-radius:12px;padding:10px 12px;margin:0 0 6px;color:#EEE8FF;cursor:pointer;font:14px -apple-system,system-ui,sans-serif}',
      '#sc-body .th .n{background:#FF6B85;color:#fff;border-radius:999px;font:700 11px/1 -apple-system,system-ui,sans-serif;padding:4px 7px;align-self:center}',
      '#sc-body label.ck{display:flex;align-items:center;gap:8px;font-size:13px;color:#C4B5E6;margin:0 0 8px}#sc-body label.ck input{width:auto;margin:0}',
      '#sc-panel .sc-thread{max-height:220px;overflow:auto;margin:6px 0;display:grid;gap:6px}',
      '#sc-panel .sc-cm{background:#15101F;border-radius:10px;padding:7px 10px;font-size:13px}#sc-panel .sc-cm.me{background:#2A1B47}',
      '#sc-panel .sc-cm.al,#sc-panel .sc-ping{border-left:3px solid #A64DFF}#sc-panel .k-urgent,#sc-panel .k-capacity{border-left-color:#FF2EC4!important}#sc-panel .k-break{border-left-color:#F2C94B!important}',
      '#sc-panel .sc-ping.done{opacity:.55}#sc-panel .sc-gauge{height:8px;margin-top:8px}#sc-panel .sc-gauge i{transition:width .4s}',
      '#sc-pill .n{background:#FF6B85;color:#fff;border-radius:999px;font:700 10px/1 -apple-system,system-ui,sans-serif;padding:3px 6px}',
      '#sc-toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);z-index:10000;background:#15101F;color:#EEE8FF;border:1px solid #4CC48D;border-radius:12px;padding:10px 14px;font:600 13px -apple-system,system-ui,sans-serif;opacity:0;pointer-events:none;transition:.25s;max-width:calc(100vw - 40px)}',
      '#sc-toast.on{opacity:1;transform:translate(-50%,0)}#sc-toast.bad{border-color:#FF6B85}'
    ].join('');
    document.head.appendChild(s);
  }

  // ---------- panel ----------
  var tab = load('tab') || 'tickets';
  var health = null;
  var codeTimer = null;
  var lastScan = null;
  var flyerResult = null;

  function mount() {
    injectStyles();
    var pill = document.createElement('button');
    pill.id = 'sc-pill';
    pill.innerHTML = '<span class="dot"></span><span>Live</span>';
    pill.setAttribute('aria-expanded', 'false');
    pill.onclick = function () { togglePanel(); };
    var panel = document.createElement('div');
    panel.id = 'sc-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Live backend');
    var t = document.createElement('div');
    t.id = 'sc-toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(panel);
    document.body.appendChild(pill);
    document.body.appendChild(t);
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('keydown', onPanelKey);
  }

  function togglePanel(force) {
    var p = $('#sc-panel');
    var on = force != null ? force : !p.classList.contains('on');
    p.classList.toggle('on', on);
    $('#sc-pill').setAttribute('aria-expanded', String(on));
    if (on) render(); else { stopCodes(); stopPoll(); }
  }

  function render() {
    var p = $('#sc-panel');
    if (!p || !p.classList.contains('on')) return;
    stopCodes();
    stopPoll();
    var tabs = [['tickets', 'Tickets'], ['feed', 'Feed'], ['msgs', 'Messages'], ['crew', 'Crew'], ['door', 'Door'], ['owner', 'Owner'], ['status', 'Status']];
    p.innerHTML = '<header><h2><span style="width:8px;height:8px;border-radius:50%;background:#4CC48D;display:inline-block"></span>Live backend<button class="x" data-sc="close" aria-label="Close">×</button></h2>' +
      '<div id="sc-tabs" role="tablist">' + tabs.map(function (t) {
        return '<button role="tab" data-sc="tab" data-v="' + t[0] + '" aria-selected="' + (tab === t[0]) + '">' + t[1] + '</button>';
      }).join('') + '</div></header><div id="sc-body">Loading…</div>';
    (({ tickets: renderTickets, feed: renderFeed, msgs: renderMsgs, door: renderDoor, crew: renderCrew, owner: renderOwner, status: renderStatus })[tab] || renderTickets)();
  }
  function body(html) { var b = $('#sc-body'); if (b) b.innerHTML = html; }

  // ----- Tickets tab -----
  function accountBlock() {
    if (fan && !fan.demo) {
      return '<h3>Account</h3><div class="card"><div class="kv"><span>' + esc(fan.name) + '</span><span class="muted">' + esc(fan.email) + '</span></div></div>' +
        '<button class="b g" data-sc="fan-logout">Sign out</button>';
    }
    return '<h3>Account</h3><p class="muted">' + (fan ? 'Using the demo fan, Alex R. ' : '') + 'Sign in or create a real account. Purchases are saved to it.</p>' +
      '<input id="sc-f-name" placeholder="Name (sign up only)" autocomplete="name">' +
      '<input id="sc-f-email" type="email" placeholder="Email" autocomplete="email">' +
      '<input id="sc-f-pass" type="password" placeholder="Password, 8+ characters" autocomplete="current-password">' +
      '<div class="row"><button class="b" data-sc="fan-login">Sign in</button><button class="b g" data-sc="fan-signup">Sign up</button></div>';
  }

  function renderTickets() {
    body('<h3>Buy a real ticket</h3><div id="sc-buy">Loading shows…</div><h3>My tickets</h3><div id="sc-mine">Loading…</div>' +
      '<h3>Notifications</h3><button class="b g" data-sc="push">Enable real push on this device</button>' + accountBlock());
    api('/events').then(function (events) {
      var el = $('#sc-buy');
      if (!el) return;
      var opts = events.filter(function (e) { return e.slug !== 'ReTurnalNights'; });
      if (!opts.length) opts = events;
      el.innerHTML = '<select id="sc-ev">' + opts.map(function (e) { return '<option value="' + esc(e.slug) + '">' + esc(e.title) + '</option>'; }).join('') + '</select>' +
        '<div class="row"><select id="sc-tier"></select><select id="sc-qty" style="flex:.4">' + [1, 2, 3, 4].map(function (n) { return '<option>' + n + '</option>'; }).join('') + '</select></div>' +
        '<button class="b" data-sc="buy">Buy</button><p class="muted">' + (health && health.integrations.payments ? 'Charges a real card through Stripe.' : 'Payments are in test mode. No card is charged.') + '</p>';
      opts.forEach(function (e) { eventCache[e.slug] = e; });
      fillTiers();
      $('#sc-ev').onchange = fillTiers;
    }).catch(function (e) { var el = $('#sc-buy'); if (el) el.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
    loadMine();
  }
  function fillTiers() {
    var ev = eventCache[$('#sc-ev').value];
    $('#sc-tier').innerHTML = ev.tiers.map(function (t) {
      var open = t.salesOpen && t.remaining > 0;
      return '<option value="' + esc(t.id) + '"' + (open ? '' : ' disabled') + '>' + esc(t.name) + ' ' + money(t.priceCents) + (open ? ' · ' + t.remaining + ' left' : ' · sold out') + '</option>';
    }).join('');
    var firstOpen = ev.tiers.filter(function (t) { return t.salesOpen && t.remaining > 0; })[0];
    if (firstOpen) $('#sc-tier').value = firstOpen.id;
  }

  var myTickets = [];
  function loadMine() {
    fanApi('/tickets/mine').then(function (list) {
      myTickets = list;
      var el = $('#sc-mine');
      if (!el) return;
      if (!list.length) { el.innerHTML = '<p class="muted">No real tickets yet. Buy one here or check out in the app.</p>'; return; }
      el.innerHTML = list.map(function (t) {
        return '<div class="card"><div class="kv"><b>' + esc(t.event.title) + '</b><span class="muted">' + esc(when(t.event.startAt)) + '</span></div>' +
          '<div class="kv"><span>' + esc(t.tierName) + ' · ' + esc(t.holderName) + '</span>' + (t.checkedInAt ? '<span class="ok">Checked in</span>' : '<span class="muted">Not scanned</span>') + '</div>' +
          '<div class="code" data-code="' + esc(t.id) + '">' + esc(t.liveCode) + '</div><div class="bar"><i data-bar="' + esc(t.id) + '" style="width:100%"></i></div>' +
          '<p class="muted" style="margin-top:6px">Door code changes every 10 seconds.</p>' +
          '<button class="b g" data-sc="copypass" data-v="' + esc(t.id) + '">Copy door pass</button>' +
          (t.checkedInAt ? '' : '<div class="row" style="margin-top:6px"><input id="sc-tr-' + esc(t.id) + '" placeholder="@handle of a friend" autocomplete="off"><button class="b g" data-sc="transfer" data-v="' + esc(t.id) + '" style="flex:.5">Send</button></div>') + '</div>';
      }).join('');
      startCodes();
    }).catch(function (e) { var el = $('#sc-mine'); if (el) el.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  }
  function startCodes() {
    stopCodes();
    var left = 10;
    codeTimer = setInterval(function () {
      left--;
      document.querySelectorAll('[data-bar]').forEach(function (b) { b.style.width = (left * 10) + '%'; });
      if (left > 0) return;
      left = 10;
      myTickets.forEach(function (t) {
        fanApi('/tickets/' + encodeURIComponent(t.id) + '/code').then(function (d) {
          t.liveCode = d.code;
          var el = document.querySelector('[data-code="' + t.id + '"]');
          if (el) el.textContent = d.code;
        }).catch(function () {});
      });
    }, 1000);
  }
  function stopCodes() { if (codeTimer) clearInterval(codeTimer); codeTimer = null; }

  function buy(slug, tierId, qty, source) {
    return ensureFan().then(function (f) {
      return getEvent(slug).then(function (ev) {
        return fanApi('/tickets/purchase', { method: 'POST', body: { eventId: ev.id, tierId: tierId, qty: qty, holderName: fan.name || f.name } })
          .then(function (r) {
            delete eventCache[slug];
            toast('Real ' + (qty > 1 ? qty + ' tickets' : 'ticket') + ' issued' + (r.mockPayment ? ' (test payment)' : '') + '. Open Live to see the door code.');
            if (source !== 'app') render();
            return r;
          });
      });
    }).catch(function (e) { toast('Real purchase failed: ' + e.message, true); });
  }

  // ----- Door tab -----
  function renderDoor() {
    if (!owner) { body('<p>Door check-in needs a staff or owner sign-in.</p>' + ownerLoginForm()); return; }
    body('<h3>Check in a ticket</h3><select id="sc-d-ev"><option>Loading…</option></select>' +
      '<input id="sc-d-pass" placeholder="Paste door pass, or ticket ID:code" autocomplete="off">' +
      '<button class="b" data-sc="scan">Check in</button><button class="b g" data-sc="scanmine">Use my newest ticket</button>' +
      '<div id="sc-d-res">' + (lastScan ? scanHtml(lastScan) : '') + '</div>');
    ownerApi('/owner/events').then(function (events) {
      var sel = $('#sc-d-ev');
      if (!sel) return;
      sel.innerHTML = events.filter(function (e) { return e.status !== 'draft'; }).map(function (e) {
        return '<option value="' + esc(e.id) + '" data-slug="' + esc(e.slug) + '">' + esc(e.title) + '</option>';
      }).join('');
    }).catch(function (e) { toast(e.message, true); });
  }
  function scanHtml(r) {
    var map = {
      valid: ['ok', 'Valid. Let them in.'],
      already_used: ['warn', 'Already checked in'],
      wrong_event: ['bad', 'Ticket is for a different show'],
      invalid_code: ['bad', 'Invalid or expired code']
    };
    var m = map[r.result] || ['bad', r.result];
    return '<div class="result ' + m[0] + '">' + m[1] + '</div>' +
      (r.holderName ? '<div class="kv"><span>' + esc(r.holderName) + '</span><span>' + esc(r.tierName) + '</span></div>' : '') +
      (r.checkedInAt ? '<p class="muted">First scanned ' + esc(when(r.checkedInAt)) + '</p>' : '');
  }
  function doScan(pass) {
    var parts = String(pass || '').trim().split(':');
    if (parts.length !== 2 || parts[1].length !== 8) { toast('Door pass should look like ticketId:12345678', true); return; }
    var evId = $('#sc-d-ev').value;
    ownerApi('/owner/scan', { method: 'POST', body: { ticketId: parts[0], code: parts[1], eventId: evId } })
      .then(function (r) { lastScan = r; })
      .catch(function (e) { lastScan = e.status === 404 ? { result: 'invalid_code' } : null; if (!lastScan) toast(e.message, true); })
      .then(function () {
        var el = $('#sc-d-res'); if (el && lastScan) el.innerHTML = scanHtml(lastScan);
        try { navigator.vibrate && navigator.vibrate(lastScan && lastScan.result === 'valid' ? 40 : [60, 40, 60]); } catch (e) {}
      });
  }

  // ----- Owner tab -----
  function ownerLoginForm() {
    return '<h3>Owner sign-in</h3><input id="sc-o-email" type="email" placeholder="Owner email" autocomplete="username">' +
      '<input id="sc-o-pass" type="password" placeholder="Password" autocomplete="current-password">' +
      '<button class="b" data-sc="owner-login">Sign in</button>';
  }
  function renderOwner() {
    if (!owner) { body('<p>Sign in to see real sales, publish shows, and read flyers.</p>' + ownerLoginForm()); return; }
    body('<div class="kv"><span>Signed in as <b>' + esc(owner.name) + '</b></span><span class="muted">' + esc(owner.role) + '</span></div>' +
      '<h3>Dashboard</h3><div class="stats" id="sc-o-stats"><div><b>–</b>Fans</div><div><b>–</b>Shows live</div><div><b>–</b>Check-ins</div></div>' +
      inboxHtml() + '<h3>Needs review</h3><div id="sc-mod">Loading\u2026</div>' + '<h3>Shows</h3><div id="sc-o-events">Loading\u2026</div>' +
      '<h3>Read a flyer</h3><p class="muted">' + (health && health.integrations.flyerAi ? 'Claude reads the flyer and fills in the show details.' : 'AI flyer reading is in sample mode until an Anthropic key is added.') + '</p>' +
      '<input id="sc-o-flyer" type="file" accept="image/*"><div id="sc-o-flyerres">' + (flyerResult ? '<pre>' + esc(JSON.stringify(flyerResult, null, 2)) + '</pre>' : '') + '</div>' +
      ownerExtrasHtml() +
      '<h3>Change owner password</h3><input id="sc-pw-cur" type="password" placeholder="Current password" autocomplete="current-password">' +
      '<input id="sc-pw-new" type="password" placeholder="New password, 12+ characters" autocomplete="new-password">' +
      '<button class="b g" data-sc="changepw">Change password</button><p class="muted">Changing it signs out every other owner session.</p>' +
      '<button class="b g" data-sc="owner-logout" style="margin-top:8px">Sign out</button>');
    ownerApi('/owner/dashboard').then(function (d) {
      var el = $('#sc-o-stats');
      if (el) el.innerHTML = '<div><b>' + d.fanCount + '</b>Fans</div><div><b>' + d.upcomingEvents + '</b>Shows live</div><div><b>' + d.totalCheckIns + '</b>Check-ins</div>';
    }).catch(function () {});
    loadOwnerEvents();
    loadTonight();
    loadBooks();
    loadInbox();
    loadModeration();
    startPoll(function () { loadInbox(); loadModeration(); }, 5000);
    var f = $('#sc-o-flyer');
    if (f) f.onchange = function () { readFlyer(f.files[0]); };
  }
  function loadOwnerEvents() {
    ownerApi('/owner/events').then(function (events) {
      var el = $('#sc-o-events');
      if (!el) return;
      el.innerHTML = events.map(function (e) {
        var sold = e.tiers.reduce(function (n, t) { return n + t.sold; }, 0);
        var cap = e.tiers.reduce(function (n, t) { return n + t.capacity; }, 0);
        var gross = e.tiers.reduce(function (n, t) { return n + t.sold * t.priceCents; }, 0);
        return '<div class="card"><div class="kv"><b>' + esc(e.title) + '</b><span class="' + (e.status === 'draft' ? 'warn' : 'ok') + '">' + esc(e.status.replace('_', ' ')) + '</span></div>' +
          '<div class="kv"><span>' + sold + ' / ' + cap + ' sold</span><span>' + money(gross) + ' gross</span></div>' +
          (e.status === 'draft' ? '<button class="b" style="margin-top:8px" data-sc="publish" data-v="' + esc(e.id) + '">Publish and notify all fans</button>' : '') + '</div>';
      }).join('');
    }).catch(function (e) { var el = $('#sc-o-events'); if (el) el.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  }
  function publish(id) {
    return ownerApi('/owner/events/' + encodeURIComponent(id) + '/publish', { method: 'POST' }).then(function (r) {
      var sent = r.push && (r.push.sent != null ? r.push.sent : r.push.delivered);
      toast('Published ' + r.event.title + (sent != null ? '. Real push sent to ' + sent + ' device' + (sent === 1 ? '' : 's') + '.' : '.'));
      render();
    }).catch(function (e) { toast('Publish failed: ' + e.message, true); });
  }
  function readFlyer(file) {
    if (!file) return;
    var res = $('#sc-o-flyerres');
    if (res) res.innerHTML = '<p class="muted">Reading…</p>';
    var r = new FileReader();
    r.onload = function () {
      var data = String(r.result);
      var m = data.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) { toast('Could not read that file', true); return; }
      ownerApi('/owner/flyer-read', { method: 'POST', body: { imageBase64: m[2], mediaType: m[1] } })
        .then(function (d) { flyerResult = d; var el = $('#sc-o-flyerres'); if (el) el.innerHTML = '<pre>' + esc(JSON.stringify(d, null, 2)) + '</pre>'; })
        .catch(function (e) { toast('Flyer read failed: ' + e.message, true); var el = $('#sc-o-flyerres'); if (el) el.innerHTML = ''; });
    };
    r.readAsDataURL(file);
  }

  // ----- Status tab -----
  function renderStatus() {
    var rows = [['Accounts and sign-in', true], ['Tickets and inventory', true], ['Rotating door codes', true], ['Door check-in', true],
      ['Push notifications', health && health.integrations.push], ['Card payments (Stripe)', health && health.integrations.payments],
      ['Text messages (Twilio)', health && health.integrations.sms], ['AI flyer reading', health && health.integrations.flyerAi],
      ['Crew ops: pings, channels, door count', health && health.integrations.crew], ['Broadcast to the app feed', true],
      ['Broadcast to Facebook', health && health.integrations.social_facebook], ['Broadcast to Instagram', health && health.integrations.social_instagram],
      ['Broadcast to X', health && health.integrations.social_x], ['AI night recap', health && health.integrations.flyerAi]];
    body('<h3>What is real right now</h3>' + rows.map(function (r) {
      return '<div class="kv"><span>' + r[0] + '</span><span class="' + (r[1] ? 'ok' : 'warn') + '">' + (r[1] ? 'Live' : 'Test mode') + '</span></div>';
    }).join('') +
      '<h3>Data</h3><p class="muted">Everything is stored in a real Postgres database, so tickets, posts, crew pings and door counts persist.</p>' +
      '<p class="muted">API: ' + esc(API_BASE) + '</p>');
  }


  // ----- Crew tab: the Teams portal for real -----
  // Crew sign in with an owner-issued code; the demo uses Jules, door lead,
  // matching the prototype's Teams portal.
  var crew = load('crew'); // { token, name, dept, demo }
  var crewState = null;
  var crewChan = load('crewchan') || 'all';
  var CREW_CHANNELS = [['all', 'All crew'], ['ops', 'Ops'], ['door', 'Door'], ['sec', 'Security'], ['bar', 'Bar'], ['prod', 'Production'], ['light', 'Lighting'], ['art', 'Artists']];
  var CHAN_BY_NAME = { 'All crew': 'all', all: 'all', Ops: 'ops', Door: 'door', Security: 'sec', Bar: 'bar', Production: 'prod', Lighting: 'light', Artists: 'art' };
  function demoCrew() {
    return api('/crew/demo', { method: 'POST' }).then(function (d) {
      crew = { token: d.token, name: d.crew.name, dept: d.crew.dept, demo: true };
      save('crew', crew);
      return crew;
    });
  }
  // Owners act as Ops; otherwise the stored crew login, or the demo one.
  function crewApi(path, opts) {
    if (owner) return ownerApi(path, opts);
    var go = function (c) { return api(path, opts, c.token); };
    return (crew ? Promise.resolve(crew) : demoCrew()).then(function (c) {
      return go(c).catch(function (e) {
        if (c.demo && e.status === 401) return demoCrew().then(go);
        throw e;
      });
    });
  }
  function gaugeHtml(d) {
    if (!d) return '<p class="muted">No show tonight.</p>';
    var pct = Math.min(100, d.pct);
    var cls = d.hold ? 'bad' : pct >= 95 ? 'warn' : 'ok';
    return '<div class="card"><div class="kv"><b>' + esc(d.title) + '</b><span class="' + cls + '">' + (d.hold ? 'ENTRY ON HOLD' : pct >= 95 ? 'Nearly full' : 'Admitting') + '</span></div>' +
      '<div class="stats"><div><b>' + d.inside + '</b>Inside</div><div><b>' + d.capacity + '</b>Capacity</div><div><b>' + d.peak + '</b>Peak</div></div>' +
      '<div class="bar sc-gauge"><i style="width:' + pct + '%;background:' + (d.hold ? '#FF6B85' : pct >= 95 ? '#F2C94B' : '#4CC48D') + '"></i></div>' +
      '<div class="row" style="margin-top:8px"><button class="b" data-sc="crew-in"' + (d.hold ? ' disabled' : '') + '>+1 In</button><button class="b g" data-sc="crew-out">−1 Out</button></div>' +
      '<p class="muted">Real ticket scans count here too. At 95% the door and security get a heads up; at 100% every crew phone gets the hold.</p></div>';
  }
  function pingHtml(p) {
    var answered = p.acks.filter(function (a) { return a.answer !== 'cant'; }).length;
    return '<div class="card sc-ping k-' + esc(p.kind) + (p.resolved ? ' done' : '') + '"><div class="kv"><b>' + esc(p.title) + '</b><span class="muted">' + esc(ago(p.at)) + '</span></div>' +
      (p.body ? '<p style="margin:4px 0">' + esc(p.body) + '</p>' : '') +
      '<div class="kv"><span class="muted">From ' + esc(p.from) + ' · to ' + esc(p.to.join(', ')) + '</span><span class="' + (answered ? 'ok' : 'warn') + '">' + answered + ' on it</span></div>' +
      (p.resolved ? '<p class="muted">Closed</p>' : p.mine ? '<p class="ok">You answered: ' + (p.mine === 'ok' ? 'on it' : p.mine === 'done' ? 'done' : 'can’t') + '</p>' :
        '<div class="row"><button class="b" data-sc="crew-ack" data-v="' + esc(p.id) + '">On it</button>' +
          (p.kind === 'task' ? '<button class="b g" data-sc="crew-done" data-v="' + esc(p.id) + '">Done</button>' : '') + '<button class="b g" data-sc="crew-cant" data-v="' + esc(p.id) + '">Can’t</button></div>') +
      (!p.resolved && (owner || p.from === (crew && crew.name)) ? '<button class="b g" data-sc="crew-resolve" data-v="' + esc(p.id) + '" style="margin-top:6px">Close ping</button>' : '') + '</div>';
  }
  function renderCrew() {
    var who = owner ? 'Ops (owner)' : crew ? esc(crew.name) + ' · ' + esc(crew.dept) + (crew.demo ? ' (demo)' : '') : 'Jules · door (demo)';
    body('<div class="kv"><span>On the crew channel as <b>' + who + '</b></span>' + (crew && !crew.demo && !owner ? '<button class="b g" data-sc="crew-leave" style="width:auto">Leave</button>' : '') + '</div>' +
      '<h3>Door</h3><div id="sc-c-door">Loading…</div>' +
      '<h3>My shift</h3><div id="sc-c-shift"></div>' +
      '<h3>Quick calls</h3><div class="row"><button class="b g" data-sc="crew-inc" data-v="incident">Log incident</button><button class="b g" data-sc="crew-inc" data-v="medic">Call medic</button><button class="b g" data-sc="crew-inc" data-v="backup">Backup</button></div>' +
      '<h3>Pings</h3><div id="sc-c-pings"></div>' +
      '<h3>Channel</h3><select id="sc-c-chan">' + CREW_CHANNELS.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === crewChan ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select>' +
      '<div id="sc-c-thread" class="sc-thread"></div><div class="row"><input id="sc-c-msg" placeholder="Message the channel" autocomplete="off"><button class="b" data-sc="crew-send" style="flex:.4">Send</button></div>' +
      (owner ? '<h3>Send a ping</h3><select id="sc-c-pk"><option value="task">Task</option><option value="urgent">Urgent</option><option value="info">Heads up</option><option value="break">Break</option></select>' +
        '<input id="sc-c-pt" placeholder="Title, e.g. Restock wristbands" maxlength="80"><button class="b" data-sc="crew-ping">Ping the ' + 'selected channel</button>' : '') +
      (crew && !crew.demo || owner ? '' : '<h3>Join your crew</h3><p class="muted">Got a code from the owner? Use it to join under your own name.</p>' +
        '<div class="row"><input id="sc-c-code" placeholder="Crew code" autocapitalize="characters"><input id="sc-c-name" placeholder="Your name"></div><button class="b g" data-sc="crew-join">Join</button>'));
    var sel = $('#sc-c-chan');
    if (sel) sel.onchange = function () { crewChan = sel.value; save('crewchan', crewChan); drawCrew(); };
    loadCrew();
    startPoll(loadCrew, 4000);
  }
  function loadCrew() {
    return crewApi('/crew/state').then(function (s) { crewState = s; drawCrew(); return s; })
      .catch(function (e) { var el = $('#sc-c-door'); if (el) el.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  }
  function drawCrew() {
    var s = crewState;
    if (!s) return;
    var d = $('#sc-c-door'); if (d) d.innerHTML = gaugeHtml(s.door);
    var sh = $('#sc-c-shift'); if (sh) sh.innerHTML = shiftHtml(s.shift);
    var p = $('#sc-c-pings');
    if (p) p.innerHTML = s.pings.filter(function (x) { return !x.resolved; }).slice(0, 6).map(pingHtml).join('') || '<p class="muted">No open pings.</p>';
    var t = $('#sc-c-thread');
    if (t) {
      var stick = t.scrollTop + t.clientHeight >= t.scrollHeight - 20;
      var list = s.channels[crewChan] || [];
      t.innerHTML = list.length ? list.map(function (m) {
        return '<div class="sc-cm' + (m.mine ? ' me' : '') + (m.alert ? ' al k-' + esc(m.alert) : '') + '"><b>' + esc(m.by) + '</b> <span class="muted">' + esc(ago(m.at)) + '</span><div>' + esc(m.text) + '</div></div>';
      }).join('') : '<p class="muted">Nothing on this channel yet.</p>';
      if (stick) t.scrollTop = t.scrollHeight;
    }
  }
  function mins(n) { return n >= 60 ? Math.floor(n / 60) + 'h ' + (n % 60) + 'm' : n + 'm'; }
  function shiftHtml(sh) {
    if (!sh) return '<div class="card"><div class="kv"><span class="muted">Not clocked in</span><button class="b" data-sc="crew-clock" data-v="in" style="width:auto">Clock in</button></div></div>';
    return '<div class="card"><div class="kv"><b>On since ' + esc(when(sh.in)) + '</b><span class="' + (sh.onBreak ? 'warn' : 'ok') + '">' + (sh.onBreak ? 'On break' : 'Working') + '</span></div>' +
      '<div class="stats"><div><b>' + mins(sh.workedMins) + '</b>Worked</div><div><b>' + mins(sh.breakMins) + '</b>Breaks</div></div>' +
      '<div class="row"><button class="b g" data-sc="crew-break" data-v="' + (sh.onBreak ? 'end' : 'start') + '">' + (sh.onBreak ? 'End break' : 'Start 15-min break') + '</button>' +
      '<button class="b g" data-sc="crew-clock" data-v="out">Clock out</button></div><p class="muted">Hours here feed team pay in the owner’s books.</p></div>';
  }
  function crewClock(action) {
    return crewApi('/crew/clock', { method: 'POST', body: { action: action } }).then(function (r) {
      if (crewState) { crewState.shift = r.shift && !r.shift.out ? r.shift : null; drawCrew(); }
      toast(action === 'in' ? 'Clocked in for real. Ops can see it.' : 'Clocked out. ' + mins(r.shift.workedMins) + ' on the books.');
      return r;
    }).catch(function (e) { toast('Clock ' + action + ' failed: ' + e.message, true); });
  }
  function crewBreak(action) {
    return crewApi('/crew/break', { method: 'POST', body: { action: action } }).then(function (r) {
      if (crewState) { crewState.shift = r.shift; drawCrew(); }
      toast(action === 'start' ? 'Break started. Your channel knows you’re off for 15.' : 'Back from break.');
      return r;
    }).catch(function (e) { toast('Break failed: ' + e.message, true); });
  }
  // The app's own pings are simulated; answer the real one with the same title.
  function ackByTitle(title, answer) {
    if (!title) return Promise.resolve(null);
    return crewApi('/crew/state').then(function (st) {
      crewState = st;
      var p = st.pings.filter(function (x) { return !x.resolved && x.title.trim().toLowerCase() === title.trim().toLowerCase(); })[0];
      if (!p) return null;
      return crewApi('/crew/pings/' + encodeURIComponent(p.id) + '/ack', { method: 'POST', body: { answer: answer } });
    });
  }
  function doorMove(delta, quiet) {
    return crewApi('/crew/door', { method: 'POST', body: { delta: delta } }).then(function (r) {
      if (crewState) { crewState.door = r.state; drawCrew(); }
      if (r.crossed === 'hold') toast('Venue at capacity. Entry is on hold and every crew phone was pinged.', true);
      else if (r.crossed === 'warn') toast('Venue at ' + Math.round(r.state.pct) + '%. Door and security were warned.');
      else if (r.crossed === 'release') toast('Entry reopened. ' + r.state.inside + ' of ' + r.state.capacity + ' inside.');
      else if (r.refused && delta > 0) toast('Entry is on hold at capacity. One out, one in.', true);
      else if (!quiet) toast('Live headcount: ' + r.state.inside + ' of ' + r.state.capacity + '.');
      return r;
    }).catch(function (e) { toast('Door count failed: ' + e.message, true); });
  }
  function crewIncident(kind, note) {
    return crewApi('/crew/incidents', { method: 'POST', body: note ? { kind: kind, note: note } : { kind: kind } })
      .then(function (r) { toast(r.ping.title + '. Real ping sent to ' + r.ping.to.join(' + ') + '.'); loadCrew(); })
      .catch(function (e) { toast('Could not log it: ' + e.message, true); });
  }
  function crewSend(channel, text) {
    return crewApi('/crew/messages', { method: 'POST', body: { channel: channel, text: text } });
  }
  function onCrewClick(act, v, b) {
    if (act === 'crew-in') return doorMove(1);
    if (act === 'crew-out') return doorMove(-1);
    if (act === 'crew-inc') return crewIncident(v);
    if (act === 'crew-clock') return crewClock(v);
    if (act === 'crew-break') return crewBreak(v);
    if (act === 'crew-ack' || act === 'crew-cant' || act === 'crew-done') {
      b.disabled = true;
      return crewApi('/crew/pings/' + encodeURIComponent(v) + '/ack', { method: 'POST', body: { answer: act === 'crew-cant' ? 'cant' : act === 'crew-done' ? 'done' : 'ok' } }).then(loadCrew)
        .catch(function (e) { toast(e.message, true); b.disabled = false; });
    }
    if (act === 'crew-resolve') return crewApi('/crew/pings/' + encodeURIComponent(v) + '/resolve', { method: 'POST' }).then(loadCrew).catch(function (e) { toast(e.message, true); });
    if (act === 'crew-send') {
      var text = val('sc-c-msg');
      if (!text) return;
      return crewSend(crewChan, text).then(function () { $('#sc-c-msg').value = ''; loadCrew(); }).catch(function (e) { toast(e.message, true); });
    }
    if (act === 'crew-ping') {
      var title = val('sc-c-pt');
      if (!title) return toast('Give the ping a title', true);
      return crewApi('/crew/pings', { method: 'POST', body: { kind: $('#sc-c-pk').value, title: title, to: [crewChan] } })
        .then(function () { toast('Ping sent to ' + crewChan + '.'); $('#sc-c-pt').value = ''; loadCrew(); }).catch(function (e) { toast(e.message, true); });
    }
    if (act === 'crew-join') {
      return api('/crew/join', { method: 'POST', body: { code: val('sc-c-code'), name: val('sc-c-name') } }).then(function (d) {
        crew = { token: d.token, name: d.crew.name, dept: d.crew.dept, demo: false };
        save('crew', crew); toast('Joined the crew as ' + crew.name + ', ' + crew.dept + '.'); render();
      }).catch(function (e) { toast(e.message, true); });
    }
    if (act === 'crew-leave') { crew = null; save('crew', null); return render(); }
    if (act === 'crew-invite') {
      return ownerApi('/owner/crew/invites', { method: 'POST', body: { dept: $('#sc-o-idept').value } }).then(function (r) {
        var el = $('#sc-o-invite'); if (el) el.innerHTML = '<div class="code">' + esc(r.code) + '</div><p class="muted">Good for 3 days' + (r.dept ? ', joins ' + esc(r.dept) : '') + '. Crew enter it under Live, then Crew.</p>';
      }).catch(function (e) { toast(e.message, true); });
    }
    if (act === 'night-report') {
      var el = $('#sc-o-report'); if (el) el.innerHTML = '<p class="muted">Pulling the numbers…</p>';
      return ownerApi('/owner/night-report').then(function (r) {
        var el2 = $('#sc-o-report');
        if (!el2) return;
        el2.innerHTML = '<div class="card"><div class="kv"><b>' + esc(r.show.title) + '</b><span class="muted">' + (r.summary.ai ? 'Written by Claude' : 'Auto summary') + '</span></div>' +
          '<p style="margin:6px 0">' + esc(r.summary.text) + '</p>' +
          '<div class="stats"><div><b>' + r.sales.sold + '</b>Sold</div><div><b>' + money(r.sales.grossCents) + '</b>Gross</div><div><b>' + r.door.peak + '</b>Peak inside</div></div>' +
          '<div class="stats"><div><b>' + r.crew.pings + '</b>Pings</div><div><b>' + (r.crew.medianAckSeconds != null ? r.crew.medianAckSeconds + 's' : '–') + '</b>Median answer</div><div><b>' + r.incidents.length + '</b>Incidents</div></div></div>';
      }).catch(function (e) { toast(e.message, true); });
    }
    if (act === 'transfer') {
      var h = val('sc-tr-' + v);
      if (!h) return toast('Enter their @handle', true);
      b.disabled = true;
      return fanApi('/tickets/' + encodeURIComponent(v) + '/transfer', { method: 'POST', body: { handle: h } }).then(function (r) {
        toast('Sent to ' + r.to.name + '. Your old code stopped working the moment it landed.'); render();
      }).catch(function (e) { toast('Transfer failed: ' + e.message, true); b.disabled = false; });
    }
  }
  function ownerExtrasHtml() {
    var live = health && health.integrations || {};
    var plat = [['Facebook', live.social_facebook], ['Instagram', live.social_instagram], ['X', live.social_x]];
    return '<h3>Tonight</h3><div id="sc-o-tonight">Loading…</div>' +
      '<h3>Books</h3><div id="sc-o-books">Loading…</div>' +
      '<h3>Night recap</h3><button class="b g" data-sc="night-report">Build tonight’s recap</button><div id="sc-o-report"></div>' +
      '<h3>Crew codes</h3><div class="row"><select id="sc-o-idept"><option value="">Any department</option>' + CREW_CHANNELS.slice(1).map(function (c) { return '<option value="' + c[0] + '">' + c[1] + '</option>'; }).join('') + '</select>' +
      '<button class="b g" data-sc="crew-invite" style="flex:.6">New code</button></div><div id="sc-o-invite"></div>' +
      '<h3>Broadcast</h3><p class="muted">Posting from Owner → Feed → Broadcast in the app sends for real: the app feed always' +
      plat.map(function (p) { return ', ' + p[0] + (p[1] ? ' (connected)' : ' (not connected yet)'); }).join('') + '.</p>';
  }

  // ----- Owner: tonight's drop and giveaway, and the books -----
  var CATS = [['talent', 'Artist booking'], ['travel', 'Travel and food'], ['rider', 'Rider and bar'], ['prod', 'Production'], ['crew', 'Crew and staffing'], ['marketing', 'Marketing'], ['gear', 'Gear'], ['office', 'Office and software'], ['other', 'Other']];
  function loadTonight() {
    if (!owner) return Promise.resolve();
    return ownerApi('/owner/events/current/giveaway').then(function (g) {
      var el = $('#sc-o-tonight');
      if (!el) return;
      el.innerHTML = '<div class="card"><div class="kv"><b>' + esc(g.title) + '</b><span class="muted">' + g.entries + ' giveaway entr' + (g.entries === 1 ? 'y' : 'ies') + '</span></div>' +
        (g.winners.length ? '<p class="ok">Winners: ' + g.winners.map(function (w) { return esc(w.name) + (w.handle ? ' (@' + esc(w.handle) + ')' : ''); }).join(', ') + '</p>' : '') +
        '<div class="row"><button class="b" data-sc="tn-drop">Drop the location now</button><button class="b g" data-sc="tn-draw"' + (g.entries > g.winners.length ? '' : ' disabled') + '>Draw a winner</button></div>' +
        '<p class="muted">The drop reveals the address in the app and pushes it to every ticket holder. Winners get a message from Subcurrent.</p></div>';
    }).catch(function (e) { var el = $('#sc-o-tonight'); if (el) el.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  }
  function dropNow() {
    return ownerApi('/owner/events/current/drop', { method: 'POST', body: {} }).then(function (r) {
      toast('Location dropped: ' + (r.venueName ? r.venueName + ', ' : '') + r.venueAddr + '. ' + r.holders + ' ticket holder' + (r.holders === 1 ? '' : 's') + (r.push.sent ? ', ' + r.push.sent + ' push sent.' : '.'));
      return r;
    }).catch(function (e) { toast('Drop failed: ' + e.message, true); });
  }
  function bookRow(l, r, cls) { return '<div class="kv"><span>' + l + '</span><span' + (cls ? ' class="' + cls + '"' : '') + '>' + r + '</span></div>'; }
  function loadBooks() {
    if (!owner) return Promise.resolve();
    return Promise.all([ownerApi('/owner/books/pnl'), ownerApi('/owner/books/team'), ownerApi('/owner/books/expenses'), getEvents()]).then(function (r) {
      var pnl = r[0], team = r[1], spend = r[2], events = r[3];
      var el = $('#sc-o-books');
      if (!el) return;
      el.innerHTML = '<div class="card">' + bookRow('Ticket revenue (' + pnl.revenue.sold + ' sold)', money(pnl.revenue.gross)) +
        bookRow('Purchases and bills', '−' + money(pnl.expenses.total)) +
        bookRow('Crew labor (' + pnl.labor.hours + ' h)', '−' + money(pnl.labor.total)) +
        bookRow('<b>Net</b>', '<b>' + (pnl.net < 0 ? '−' : '') + money(Math.abs(pnl.net)) + '</b>', pnl.net < 0 ? 'bad' : 'ok') +
        (pnl.labor.unrated.length ? '<p class="warn" style="font-size:12px">No rate on the roster for: ' + pnl.labor.unrated.map(esc).join(', ') + '</p>' : '') +
        '<button class="b g" data-sc="bk-csv" style="margin-top:6px">Download CSV for the accountant</button></div>' +
        '<p class="muted" style="margin-top:10px">Team (' + team.length + ')</p>' +
        team.map(function (m) { return bookRow(esc(m.name) + ' <span class="muted">' + esc(m.role) + '</span>', money(m.rateCents) + ' / ' + esc(m.basis) + ' <button class="b g" data-sc="bk-rmteam" data-v="' + esc(m.id) + '" style="width:auto;padding:2px 8px">×</button>'); }).join('') +
        '<div class="row"><input id="sc-bk-mname" placeholder="Name (match their crew name)"><input id="sc-bk-mrole" placeholder="Role"></div>' +
        '<div class="row"><input id="sc-bk-mrate" inputmode="decimal" placeholder="Rate $"><select id="sc-bk-mbasis"><option value="hour">per hour</option><option value="night">per night</option><option value="flat">flat</option></select>' +
        '<button class="b g" data-sc="bk-addteam" style="flex:.6">Add</button></div>' +
        '<p class="muted" style="margin-top:10px">Purchases and bills (' + spend.length + ')</p>' +
        spend.slice(0, 8).map(function (x) { return bookRow(esc(x.vendor) + ' <span class="muted">' + esc(x.category) + (x.eventSlug ? ' · show' : '') + '</span>', money(x.amountCents) + ' <button class="b g" data-sc="bk-rmexp" data-v="' + esc(x.id) + '" style="width:auto;padding:2px 8px">×</button>'); }).join('') +
        '<div class="row"><input id="sc-bk-vendor" placeholder="Vendor"><input id="sc-bk-amt" inputmode="decimal" placeholder="Amount $"></div>' +
        '<div class="row"><select id="sc-bk-cat">' + CATS.map(function (c) { return '<option value="' + c[0] + '">' + c[1] + '</option>'; }).join('') + '</select>' +
        '<select id="sc-bk-show"><option value="">Company cost</option>' + events.map(function (e) { return '<option value="' + esc(e.slug) + '">' + esc(e.title) + ', ' + esc(when(e.startAt).split(',')[0]) + '</option>'; }).join('') + '</select></div>' +
        '<div class="row"><select id="sc-bk-kind"><option value="purchase">Purchase</option><option value="bill">Bill</option></select><button class="b g" data-sc="bk-addexp">Log it</button></div>';
    }).catch(function (e) { var el = $('#sc-o-books'); if (el) el.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  }
  var eventsList = null;
  function getEvents() { return eventsList ? Promise.resolve(eventsList) : api('/events').then(function (l) { eventsList = l; return l; }); }
  function cents(v) { var n = parseFloat(String(v || '').replace(/[$,\s]/g, '')); return n > 0 ? Math.round(n * 100) : 0; }
  // The app labels shows like "Re:Turnal Nights, Oct 23"; match on the date.
  function slugFromLabel(label) {
    if (!label) return Promise.resolve(null);
    return getEvents().then(function (list) {
      var hit = list.filter(function (e) {
        var d = new Date(e.startAt);
        var md = d.toLocaleString('en-US', { month: 'short', timeZone: 'America/Denver' }) + ' ' + d.toLocaleString('en-US', { day: 'numeric', timeZone: 'America/Denver' });
        return label.indexOf(md) > -1;
      })[0];
      return hit ? hit.slug : null;
    });
  }
  function addMember(m) {
    return ownerApi('/owner/books/team', { method: 'POST', body: m });
  }
  function addExpense(x) {
    return ownerApi('/owner/books/expenses', { method: 'POST', body: x });
  }
  function onBooksClick(act, v, b) {
    if (act === 'tn-drop') return dropNow().then(loadTonight);
    if (act === 'tn-draw') {
      b.disabled = true;
      return ownerApi('/owner/events/current/giveaway/draw', { method: 'POST', body: { winners: 1 } }).then(function (r) {
        toast('Winner: ' + r.winners.map(function (w) { return w.name; }).join(', ') + '. They got a message from Subcurrent.'); return loadTonight();
      }).catch(function (e) { b.disabled = false; toast(e.message, true); });
    }
    if (act === 'bk-addteam') {
      var name = val('sc-bk-mname');
      if (!name) return toast('Add a name', true);
      return addMember({ name: name, role: val('sc-bk-mrole') || 'Crew', rateCents: cents(val('sc-bk-mrate')), basis: $('#sc-bk-mbasis').value })
        .then(function () { toast('Added ' + name + ' to the team.'); return loadBooks(); }).catch(function (e) { toast(e.message, true); });
    }
    if (act === 'bk-addexp') {
      var amt = cents(val('sc-bk-amt'));
      if (!amt) return toast('Enter an amount', true);
      var x = { vendor: val('sc-bk-vendor') || 'Purchase', amountCents: amt, category: $('#sc-bk-cat').value, kind: $('#sc-bk-kind').value };
      if ($('#sc-bk-show').value) x.eventSlug = $('#sc-bk-show').value;
      return addExpense(x).then(function () { toast('Logged ' + money(amt) + '.'); return loadBooks(); }).catch(function (e) { toast(e.message, true); });
    }
    if (act === 'bk-rmteam') return ownerApi('/owner/books/team/' + encodeURIComponent(v), { method: 'DELETE' }).then(loadBooks).catch(function (e) { toast(e.message, true); });
    if (act === 'bk-rmexp') return ownerApi('/owner/books/expenses/' + encodeURIComponent(v), { method: 'DELETE' }).then(loadBooks).catch(function (e) { toast(e.message, true); });
    if (act === 'bk-csv') {
      return fetch(API_BASE + '/owner/books/export.csv', { headers: { Authorization: 'Bearer ' + owner.token } })
        .then(function (r) { if (!r.ok) throw new Error('Export failed (' + r.status + ')'); return r.blob(); })
        .then(function (blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = 'subcurrent-books.csv';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        }).catch(function (e) { toast(e.message, true); });
    }
  }

  // ---------- polling ----------
  var pollTimer = null;
  function startPoll(fn, ms) { stopPoll(); pollTimer = setInterval(fn, ms); }
  function stopPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
  function ago(d) {
    var s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  var SLUG_TITLE = { 'ReturnalNights-Oct23': 'Re:Turnal Night One', 'ReturnalNights-Oct24': 'Re:Turnal Night Two', HallowCurrentAfters: 'Hallow Current Afters', UndertowAfters: 'Undertow Afters' };

  // ----- Feed tab -----
  var feedPosts = [];
  var openComments = {}; // postId -> true
  var openReport = null; // postId with the report picker open
  var draft = { photo: null, poll: false, opts: ['', ''] };
  function feedCall(path, opts) {
    // Reads work signed out; a fan token adds liked/mine/vote and your held posts.
    if (!opts && !fan) return api(path);
    return fanApi(path, opts);
  }

  // Shrinks a photo to fit the API's size cap (longest side 1280px, JPEG).
  function compressImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var max = 1280, w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var q = 0.85, out = c.toDataURL('image/jpeg', q);
        while (out.length > 650000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
        if (out.length > 650000) return reject(new Error('Photo is too large'));
        resolve(out);
      };
      img.onerror = function () { reject(new Error('That file is not a photo this browser can read')); };
      img.src = src;
    });
  }
  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('Could not read that file')); };
      r.readAsDataURL(file);
    });
  }

  function composerHtml() {
    var asTeam = Boolean(owner);
    return '<h3>New post</h3><textarea id="sc-p-text" maxlength="1000" placeholder="Say something to the Subcurrent crowd"></textarea>' +
      (draft.photo ? '<div style="position:relative;margin:0 0 8px"><img src="' + esc(draft.photo) + '" alt="Photo to post" style="width:100%;border-radius:10px;display:block"><button class="b g" data-sc="nophoto" style="position:absolute;top:6px;right:6px;width:auto;background:#040307cc">Remove</button></div>' : '') +
      (draft.poll ? '<div id="sc-p-poll">' + draft.opts.map(function (o, i) { return '<input data-popt="' + i + '" maxlength="80" placeholder="Option ' + (i + 1) + '" value="' + esc(o) + '">'; }).join('') +
        (draft.opts.length < 4 ? '<button class="b g" data-sc="addopt">Add an option</button>' : '') + '</div>' : '') +
      '<div class="row"><label class="b g" style="text-align:center;margin:0 0 8px">Photo<input type="file" accept="image/*" id="sc-p-photo" hidden></label>' +
      '<button class="b g" data-sc="togglepoll" aria-pressed="' + draft.poll + '">' + (draft.poll ? 'No poll' : 'Poll') + '</button></div>' +
      '<select id="sc-p-show"><option value="">No show tagged</option>' + Object.keys(SLUG_TITLE).map(function (k) { return '<option value="' + k + '">' + esc(SLUG_TITLE[k]) + '</option>'; }).join('') + '</select>' +
      (asTeam ? '<label class="ck"><input type="checkbox" id="sc-p-team" checked> Post as Subcurrent (owner)</label><label class="ck"><input type="checkbox" id="sc-p-pin"> Pin to top</label><label class="ck"><input type="checkbox" id="sc-p-push"> Send push to all fans</label>' : '') +
      '<button class="b" data-sc="post">Post</button>' +
      '<p class="muted">' + (asTeam ? 'With the box checked, posts and comments go out as Subcurrent. Uncheck it to post as ' + esc(fan ? fan.name : 'the demo fan') + '.' : (!fan || fan.demo ? 'Posting as the demo fan, Alex R. Sign in on the Tickets tab to post as yourself.' : 'Posting as ' + esc(fan.name) + '.')) +
      ' Posts that look like ticket resale wait for the team to review them.</p>';
  }
  function saveDraftFields() {
    document.querySelectorAll('[data-popt]').forEach(function (i) { draft.opts[+i.getAttribute('data-popt')] = i.value; });
  }
  function renderFeed() {
    body('<div id="sc-composer">' + composerHtml() + '</div><h3>Feed</h3><div id="sc-feed">Loading…</div>');
    wireComposer();
    loadFeed();
    startPoll(function () {
      var a = document.activeElement;
      if (openReport || (a && a.closest && a.closest('#sc-feed'))) return;
      loadFeed(true);
    }, 15000);
  }
  function redrawComposer() {
    var text = val('sc-p-text'), show = val('sc-p-show');
    saveDraftFields();
    var el = $('#sc-composer');
    if (!el) return;
    el.innerHTML = composerHtml();
    $('#sc-p-text').value = text;
    $('#sc-p-show').value = show;
    wireComposer();
  }
  function wireComposer() {
    var f = $('#sc-p-photo');
    if (f) f.onchange = function () {
      if (!f.files[0]) return;
      fileToDataUrl(f.files[0]).then(compressImage)
        .then(function (d) { draft.photo = d; redrawComposer(); })
        .catch(function (e) { toast(e.message, true); });
    };
  }
  function loadFeed(quiet) {
    return feedCall('/feed').then(function (d) {
      feedPosts = d.posts;
      drawFeed();
    }).catch(function (e) { if (!quiet) { var el = $('#sc-feed'); if (el) el.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; } });
  }
  function pollHtml(p) {
    var total = p.poll.votes.reduce(function (a, b) { return a + b; }, 0);
    return '<div style="margin:0 0 8px">' + p.poll.options.map(function (o, i) {
      var pct = total ? Math.round(p.poll.votes[i] * 100 / total) : 0;
      var mine = p.poll.mine === i;
      return '<button data-sc="vote" data-v="' + esc(p.id) + ':' + i + '" aria-pressed="' + mine + '" style="position:relative;display:block;width:100%;text-align:left;background:#0D0A14;border:1px solid ' + (mine ? '#C99BFF' : 'rgba(238,232,255,.18)') + ';border-radius:10px;padding:8px 10px;margin:0 0 6px;color:#EEE8FF;font:14px -apple-system,system-ui,sans-serif;cursor:pointer;overflow:hidden">' +
        '<span style="position:absolute;inset:0;width:' + pct + '%;background:rgba(201,155,255,.16)"></span><span style="position:relative">' + esc(o) + (mine ? ' ✓' : '') + '</span><span style="position:relative;float:right" class="muted">' + pct + '%</span></button>';
    }).join('') + '<p class="muted">' + total + ' vote' + (total === 1 ? '' : 's') + (p.poll.mine == null ? '. Tap to vote.' : '. Tap another option to change your vote.') + '</p></div>';
  }
  var REPORT_REASONS = ['Ticket scam or resale', 'Spam', 'Harassment or hate', 'Something else'];
  function drawFeed() {
    var el = $('#sc-feed');
    if (!el) return;
    if (!feedPosts.length) { el.innerHTML = '<p class="muted">No posts yet. Start the conversation.</p>'; return; }
    el.innerHTML = feedPosts.map(function (p) {
      var held = p.status === 'held';
      var canRemove = p.mine || Boolean(owner);
      var canReport = !p.mine && !held;
      return '<div class="post' + (p.pinned ? ' pin' : '') + '" data-post="' + esc(p.id) + '"' + (held ? ' style="opacity:.7"' : '') + '>' +
        '<div class="who">' + esc(p.author) + (p.fromTeam ? ' <span class="badge">TEAM</span>' : '') + (p.pinned ? ' <span class="muted">Pinned</span>' : '') + '<span class="t">' + ago(p.createdAt) + '</span></div>' +
        (held ? '<p class="warn" style="font-size:12px">Held for review. Only you can see this until the team approves it. ' + esc(p.heldReason || '') + '</p>' : '') +
        (p.text ? '<div class="txt">' + esc(p.text) + '</div>' : '') +
        (p.image ? '<img src="' + esc(API_BASE + p.image) + '" alt="Photo from ' + esc(p.author) + '" loading="lazy" style="width:100%;border-radius:10px;display:block;margin:0 0 8px">' : '') +
        (p.poll ? pollHtml(p) : '') +
        (p.eventSlug && SLUG_TITLE[p.eventSlug] ? '<p class="muted">' + esc(SLUG_TITLE[p.eventSlug]) + '</p>' : '') +
        '<div class="acts">' + (held ? '' : '<button data-sc="like" data-v="' + esc(p.id) + '" class="' + (p.liked ? 'on' : '') + '" aria-pressed="' + p.liked + '">♥ ' + p.likes + '</button>' +
        '<button data-sc="cms" data-v="' + esc(p.id) + '">Comments ' + p.comments + '</button>') +
        (canReport ? '<button data-sc="report" data-v="' + esc(p.id) + '">Report</button>' : '') +
        (canRemove ? '<button data-sc="rmpost" data-v="' + esc(p.id) + '">Remove</button>' : '') + '</div>' +
        (openReport === p.id ? '<div class="cms"><p class="muted">Why are you reporting this?</p>' + REPORT_REASONS.map(function (r) {
          return '<button class="b g" data-sc="reportwhy" data-v="' + esc(p.id) + '|' + esc(r) + '">' + esc(r) + '</button>';
        }).join('') + '</div>' : '') +
        (openComments[p.id] ? '<div class="cms" id="sc-cms-' + esc(p.id) + '">Loading…</div>' : '') + '</div>';
    }).join('');
    Object.keys(openComments).forEach(loadComments);
  }
  function loadComments(id) {
    api('/feed/' + encodeURIComponent(id) + '/comments').then(function (list) {
      var el = document.getElementById('sc-cms-' + id);
      if (!el) return;
      var d = el.querySelector('input');
      var keep = d ? d.value : '';
      el.innerHTML = list.map(function (c) {
        return '<p class="cm"><b>' + esc(c.author) + '</b>' + (c.fromTeam ? ' <span class="badge">TEAM</span>' : '') + ' ' + esc(c.text) + ' <span class="muted">' + ago(c.createdAt) + '</span></p>';
      }).join('') + '<div class="row"><input data-cmin="' + esc(id) + '" maxlength="500" placeholder="Add a comment"><button class="b" style="flex:.35" data-sc="addcm" data-v="' + esc(id) + '">Send</button></div>';
      if (keep) el.querySelector('input').value = keep;
    }).catch(function () { delete openComments[id]; });
  }
  function postAs(text, slug, opts) {
    opts = opts || {};
    var payload = { text: text || '' };
    if (slug) payload.eventSlug = slug;
    if (opts.image) payload.image = opts.image;
    if (opts.poll && opts.poll.length >= 2) payload.poll = opts.poll;
    var send = function () {
      if (opts.team) {
        payload.pinned = Boolean(opts.pin);
        payload.notify = Boolean(opts.push);
        return ownerApi('/feed', { method: 'POST', body: payload });
      }
      return fanApi('/feed', { method: 'POST', body: payload });
    };
    // Re-compress if a caller hands over a big photo (e.g. from the app's composer).
    if (payload.image && payload.image.length > 650000) {
      return compressImage(payload.image).then(function (d) { payload.image = d; return send(); });
    }
    return send();
  }
  function postedToast(r, prefix) {
    var p = r.post || {};
    if (p.status === 'held') return toast((prefix || 'Posted') + ', but it is held for review: ' + (p.heldReason || 'the team will check it') + '.', true);
    toast((prefix || 'Posted to the live feed') + (r.push && r.push.sent ? '. Push sent to ' + r.push.sent + ' device' + (r.push.sent === 1 ? '' : 's') + '.' : '.'));
  }

  // ----- Messages tab -----
  // Two kinds: the fan's conversation with the Subcurrent team, and direct
  // messages with other fans (found by @handle).
  var teamUnreadFan = 0, dmUnread = 0, teamUnread = 0;
  var msgView = load('msgview') || 'team';
  var dmWith = null; // handle of the open fan conversation
  function bubbles(list, mineIsTeam) {
    if (!list.length) return '<p class="muted">No messages yet.</p>';
    return list.map(function (m) {
      var me = m.mine != null ? m.mine : (mineIsTeam ? m.fromTeam : !m.fromTeam);
      return '<div class="bub' + (me ? ' me' : '') + '">' + esc(m.text) + '<small>' + esc(me ? 'You' : (m.author || '')) + (me || m.author ? ' · ' : '') + ago(m.createdAt) + '</small></div>';
    }).join('');
  }
  function renderMsgs() {
    var seg = '<div class="row" role="tablist" style="margin:0 0 12px">' +
      '<button class="b' + (msgView === 'team' ? '' : ' g') + '" data-sc="msgview" data-v="team" aria-selected="' + (msgView === 'team') + '">Subcurrent team' + (teamUnreadFan ? ' (' + teamUnreadFan + ')' : '') + '</button>' +
      '<button class="b' + (msgView === 'fans' ? '' : ' g') + '" data-sc="msgview" data-v="fans" aria-selected="' + (msgView === 'fans') + '">Fans' + (dmUnread ? ' (' + dmUnread + ')' : '') + '</button></div>';
    if (msgView === 'fans') return renderDms(seg);
    body(seg + '<p class="muted">Questions about tickets, entry, or the shows. The team answers from the owner portal.' +
      (!fan || fan.demo ? ' You are the demo fan, Alex R. Sign in on the Tickets tab to message as yourself.' : '') + '</p>' +
      '<div class="chat" id="sc-chat">Loading…</div>' +
      '<div class="row"><input id="sc-m-in" maxlength="2000" placeholder="Write a message"><button class="b" style="flex:.35" data-sc="sendmsg">Send</button></div>');
    loadChat();
    startPoll(loadChat, 5000);
    var inp = $('#sc-m-in');
    if (inp) inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); sendFanMsg(); } };
  }
  function loadChat() {
    return fanApi('/messages').then(function (d) {
      teamUnreadFan = 0; badge();
      var el = $('#sc-chat');
      if (!el) return;
      var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      el.innerHTML = bubbles(d.messages, false);
      if (atBottom || d.unread) el.scrollTop = el.scrollHeight;
    }).catch(function (e) { var el = $('#sc-chat'); if (el) el.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  }
  function sendFanMsg() {
    var inp = $('#sc-m-in');
    var text = inp && inp.value.trim();
    if (!text) return;
    inp.value = '';
    fanApi('/messages', { method: 'POST', body: { text: text } })
      .then(function () { return loadChat(); })
      .then(function () { var el = $('#sc-chat'); if (el) el.scrollTop = el.scrollHeight; })
      .catch(function (e) { inp.value = text; toast('Message not sent: ' + e.message, true); });
  }

  // ----- fan-to-fan direct messages -----
  function refreshMe() {
    return fanApi('/auth/fan/me').then(function (m) { fan.handle = m.handle; save('fan', fan); return fan; });
  }
  function renderDms(seg) {
    body(seg + '<div id="sc-dm">Loading…</div>');
    ensureFan().then(refreshMe).then(function () {
      if (!fan.handle) return drawHandleForm();
      if (dmWith) return openDm(dmWith);
      drawDmList();
    }).catch(function (e) { var el = $('#sc-dm'); if (el) el.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  }
  function drawHandleForm() {
    var el = $('#sc-dm');
    if (!el) return;
    el.innerHTML = '<p>Pick a handle so other fans can find and message you.</p><input id="sc-h-in" maxlength="24" placeholder="handle, like maya.rails" autocapitalize="off">' +
      '<button class="b" data-sc="sethandle">Save handle</button><p class="muted">3 to 24 letters, numbers, dots or underscores.</p>';
  }
  function drawDmList() {
    stopPoll();
    var el = $('#sc-dm');
    if (!el) return;
    el.innerHTML = '<p class="muted">You are <b>@' + esc(fan.handle) + '</b>. <button class="b g" data-sc="edithandle" style="width:auto;padding:4px 8px;margin:0">Change</button></p>' +
      '<input id="sc-dm-q" placeholder="Find a fan by @handle or name" autocomplete="off"><div id="sc-dm-res"></div><h3>Conversations</h3><div id="sc-dm-list">Loading…</div>';
    var q = $('#sc-dm-q'), t;
    q.oninput = function () { clearTimeout(t); t = setTimeout(function () { searchFans(q.value); }, 250); };
    loadDmList();
    startPoll(loadDmList, 8000);
  }
  function searchFans(q) {
    var res = $('#sc-dm-res');
    if (!res) return;
    if (q.trim().length < 2) { res.innerHTML = ''; return; }
    fanApi('/dms/search?q=' + encodeURIComponent(q.trim())).then(function (list) {
      res.innerHTML = list.length ? list.map(function (f) {
        return '<button class="th" data-sc="opendm" data-v="' + esc(f.handle) + '"><span><b>' + esc(f.name) + '</b> <span class="muted">@' + esc(f.handle) + '</span></span><span class="muted">Message</span></button>';
      }).join('') : '<p class="muted">No fans match. They need to pick a handle first.</p>';
    }).catch(function (e) { res.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  }
  function loadDmList() {
    return fanApi('/dms').then(function (list) {
      var el = $('#sc-dm-list');
      if (!el) return;
      dmUnread = list.reduce(function (n, t) { return n + t.unread; }, 0); badge();
      el.innerHTML = list.length ? list.map(function (t) {
        return '<button class="th" data-sc="opendm" data-v="' + esc(t.handle || '') + '"' + (t.handle ? '' : ' disabled') + '><span><b>' + esc(t.name) + '</b> <span class="muted">@' + esc(t.handle || '') + '</span><br><span class="muted">' + esc((t.last.mine ? 'You: ' : '') + t.last.text.slice(0, 60)) + '</span></span>' +
          (t.unread ? '<span class="n">' + t.unread + '</span>' : '<span class="muted">' + ago(t.last.createdAt) + '</span>') + '</button>';
      }).join('') : '<p class="muted">No conversations yet. Search for a fan above.</p>';
    }).catch(function () {});
  }
  function openDm(handle) {
    dmWith = handle;
    stopPoll();
    var el = $('#sc-dm');
    if (!el) return Promise.resolve();
    el.innerHTML = 'Loading…';
    var first = true;
    function load() {
      return fanApi('/dms/with/' + encodeURIComponent(handle)).then(function (d) {
        var box = $('#sc-dm');
        if (!box || dmWith !== handle) return;
        var chat = box.querySelector('.chat');
        if (!chat || first) {
          box.innerHTML = '<button class="b g" data-sc="closedm">← All conversations</button>' +
            '<div class="kv"><span><b>' + esc(d.with.name) + '</b> <span class="muted">@' + esc(d.with.handle) + '</span></span>' +
            '<button class="b g" style="width:auto;margin:0;padding:4px 10px" data-sc="' + (d.iBlocked ? 'unblock' : 'block') + '" data-v="' + esc(d.with.handle) + '">' + (d.iBlocked ? 'Unblock' : 'Block') + '</button></div>' +
            '<div class="chat" style="margin-top:8px"></div>' +
            (d.blocked ? '<p class="muted">' + (d.iBlocked ? 'You blocked this fan. Unblock to message again.' : 'You can’t message this fan.') + '</p>' :
              '<div class="row"><input id="sc-dm-in" maxlength="2000" placeholder="Message @' + esc(d.with.handle) + '"><button class="b" style="flex:.35" data-sc="senddm">Send</button></div>');
          chat = box.querySelector('.chat');
          var inp = $('#sc-dm-in');
          if (inp) inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); sendDm(); } };
          first = false;
        }
        var atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
        chat.innerHTML = bubbles(d.messages);
        if (atBottom || chat.dataset.n !== String(d.messages.length)) chat.scrollTop = chat.scrollHeight;
        chat.dataset.n = String(d.messages.length);
        checkUnread();
      }).catch(function (e) { toast(e.message, true); dmWith = null; drawDmList(); });
    }
    startPoll(load, 5000);
    return load();
  }
  function sendDm() {
    var inp = $('#sc-dm-in');
    var text = inp && inp.value.trim();
    if (!text || !dmWith) return;
    inp.value = '';
    fanApi('/dms/with/' + encodeURIComponent(dmWith), { method: 'POST', body: { text: text } })
      .then(function () { return openDm(dmWith); })
      .catch(function (e) { inp.value = text; toast('Message not sent: ' + e.message, true); });
  }

  // ----- Owner inbox -----
  var inboxSel = null;
  function inboxHtml() {
    return '<h3>Inbox</h3><div id="sc-inbox">Loading…</div>';
  }
  function loadInbox() {
    if (!owner) return Promise.resolve();
    if (inboxSel) return loadInboxThread();
    return ownerApi('/owner/inbox').then(function (list) {
      teamUnread = list.reduce(function (n, t) { return n + t.unread; }, 0); badge();
      var el = $('#sc-inbox');
      if (!el) return;
      el.innerHTML = list.length ? list.map(function (t) {
        return '<button class="th" data-sc="openth" data-v="' + esc(t.id) + '"><span><b>' + esc(t.fan) + '</b><br><span class="muted">' + esc(t.last ? (t.last.fromTeam ? 'You: ' : '') + t.last.text.slice(0, 60) : '') + '</span></span>' +
          (t.unread ? '<span class="n">' + t.unread + '</span>' : '<span class="muted">' + (t.last ? ago(t.last.createdAt) : '') + '</span>') + '</button>';
      }).join('') : '<p class="muted">No conversations yet. Fans message the team from the Messages tab.</p>';
    }).catch(function () {});
  }
  function loadInboxThread() {
    return ownerApi('/owner/inbox/' + encodeURIComponent(inboxSel)).then(function (d) {
      var el = $('#sc-inbox');
      if (!el) return;
      var chat = el.querySelector('.chat');
      if (!chat) {
        el.innerHTML = '<button class="b g" data-sc="closeth">← All conversations</button><p><b>' + esc(d.fan) + '</b></p><div class="chat"></div>' +
          '<div class="row"><input id="sc-r-in" maxlength="2000" placeholder="Reply as Subcurrent"><button class="b" style="flex:.35" data-sc="reply">Send</button></div><p class="muted">Replies send a real push if the fan turned it on.</p>';
        chat = el.querySelector('.chat');
        var inp = $('#sc-r-in');
        inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); sendReply(); } };
      }
      var atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
      chat.innerHTML = bubbles(d.messages, true);
      if (atBottom) chat.scrollTop = chat.scrollHeight;
      checkUnread();
    }).catch(function (e) { inboxSel = null; toast(e.message, true); });
  }
  function sendReply() {
    var inp = $('#sc-r-in');
    var text = inp && inp.value.trim();
    if (!text || !inboxSel) return;
    inp.value = '';
    ownerApi('/owner/inbox/' + encodeURIComponent(inboxSel), { method: 'POST', body: { text: text } })
      .then(function (r) {
        if (r.push && r.push.sent) toast('Sent. Push delivered to ' + r.push.sent + ' device' + (r.push.sent === 1 ? '' : 's') + '.');
        return loadInboxThread();
      })
      .then(function () { var chat = $('#sc-inbox .chat'); if (chat) chat.scrollTop = chat.scrollHeight; })
      .catch(function (e) { inp.value = text; toast('Reply not sent: ' + e.message, true); });
  }

  // ----- Owner moderation queue -----
  function loadModeration() {
    if (!owner) return Promise.resolve();
    return ownerApi('/owner/moderation').then(function (list) {
      var el = $('#sc-mod');
      if (!el) return;
      el.innerHTML = list.length ? list.map(function (p) {
        return '<div class="post"><div class="who">' + esc(p.author) + '<span class="t">' + ago(p.createdAt) + '</span></div>' +
          '<p class="warn" style="font-size:12px">' + esc(p.heldReason || 'Held') + (p.reports && p.reports.length ? '. Reasons: ' + esc(p.reports.join(', ')) : '') + '</p>' +
          (p.text ? '<div class="txt">' + esc(p.text) + '</div>' : '') +
          (p.image ? '<img src="' + esc(API_BASE + p.image) + '" alt="" style="width:100%;border-radius:10px;margin:0 0 8px">' : '') +
          '<div class="row"><button class="b" data-sc="modapprove" data-v="' + esc(p.id) + '">Approve</button><button class="b g" data-sc="modremove" data-v="' + esc(p.id) + '">Remove</button></div>' +
          (p.fromTeam ? '' : '<button class="b g" data-sc="modban" data-v="' + esc(p.id) + '" style="margin-top:6px;color:#FF6B85">Remove and ban 30 days</button>') + '</div>';
      }).join('') : '<p class="muted">Nothing waiting. Held resale posts and posts reported by 3 fans show up here.</p>';
    }).catch(function () {});
  }

  // ----- unread badge on the Live pill -----
  function badge() {
    var pill = $('#sc-pill');
    if (!pill) return;
    var n = teamUnreadFan + dmUnread + teamUnread;
    var el = pill.querySelector('.n');
    if (!n) { if (el) el.remove(); pill.removeAttribute('aria-label'); return; }
    if (!el) { el = document.createElement('span'); el.className = 'n'; pill.appendChild(el); }
    el.textContent = n > 9 ? '9+' : String(n);
    pill.setAttribute('aria-label', 'Live, ' + n + ' unread');
  }
  function checkUnread() {
    if (document.hidden) return;
    if (fan) {
      api('/messages/unread', null, fan.token).then(function (d) { teamUnreadFan = d.unread; badge(); }).catch(function () {});
      api('/dms/unread', null, fan.token).then(function (d) { dmUnread = d.unread; badge(); }).catch(function () {});
    }
    if (owner) api('/owner/inbox', null, owner.token).then(function (l) { teamUnread = l.reduce(function (n, t) { return n + t.unread; }, 0); badge(); }).catch(function () {});
  }

  // ---------- push ----------
  function urlBase64ToUint8Array(base64) {
    var pad = '='.repeat((4 - (base64.length % 4)) % 4);
    var raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(Array.prototype.map.call(raw, function (c) { return c.charCodeAt(0); }));
  }
  function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toast('This browser does not support push. On iPhone, add the app to your Home Screen first.', true); return; }
    Notification.requestPermission()
      .then(function (perm) { if (perm !== 'granted') throw new Error('Notifications permission was not granted'); return api('/push/vapid-public-key'); })
      .then(function (k) { return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(k.key) }); }); })
      .then(function (sub) { var j = sub.toJSON(); return fanApi('/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } }); })
      .then(function () { return fanApi('/push/demo-notify', { method: 'POST', body: { title: 'Subcurrent', body: 'Real push is on for this device.', url: './' } }); })
      .then(function () { toast('Real push enabled. A test notification is on its way.'); })
      .catch(function (e) { toast('Could not enable push: ' + e.message, true); });
  }

  // ---------- panel clicks ----------
  function val(id) { var el = $('#' + id); return el ? el.value.trim() : ''; }
  function onPanelKey(e) {
    if (e.key !== 'Enter' || !e.target.getAttribute) return;
    var id = e.target.getAttribute('data-cmin');
    if (!id) return;
    e.preventDefault();
    var btn = document.querySelector('[data-sc="addcm"][data-v="' + id + '"]');
    if (btn) btn.click();
  }
  function onPanelClick(e) {
    var b = e.target.closest('[data-sc]');
    if (!b) return;
    var act = b.getAttribute('data-sc'), v = b.getAttribute('data-v');
    if (act === 'close') return togglePanel(false);
    if (act === 'tab') { tab = v; save('tab', tab); return render(); }
    if (act === 'push') return enablePush();
    if (/^(crew-|night-report$|transfer$)/.test(act)) return onCrewClick(act, v, b);
    if (/^(bk-|tn-)/.test(act)) return onBooksClick(act, v, b);
    if (act === 'buy') {
      b.disabled = true;
      return buy($('#sc-ev').value, $('#sc-tier').value, Number($('#sc-qty').value), 'panel').then(function () { b.disabled = false; });
    }
    if (act === 'copypass') {
      var t = myTickets.filter(function (x) { return x.id === v; })[0];
      if (!t) return;
      var pass = t.id + ':' + t.liveCode;
      try { navigator.clipboard.writeText(pass); toast('Door pass copied. It works for about 10 seconds.'); } catch (err) { toast(pass); }
      return;
    }
    if (act === 'fan-login' || act === 'fan-signup') {
      var signup = act === 'fan-signup';
      var payload = { email: val('sc-f-email'), password: $('#sc-f-pass').value };
      if (signup) payload.name = val('sc-f-name');
      if (signup && !payload.name) return toast('Add your name to sign up.', true);
      b.disabled = true;
      return api(signup ? '/auth/fan/signup' : '/auth/fan/login', { method: 'POST', body: payload })
        .then(function (d) { fan = { token: d.token, name: d.fan.name, email: d.fan.email, demo: false }; save('fan', fan); toast((signup ? 'Account created. ' : '') + 'Signed in as ' + d.fan.name + '.'); render(); })
        .catch(function (err) { b.disabled = false; toast(err.status === 400 ? 'Check the email, and use a password of 8 or more characters.' : err.message, true); });
    }
    if (act === 'fan-logout') { fan = null; save('fan', null); teamUnreadFan = 0; dmUnread = 0; dmWith = null; badge(); toast('Signed out. Back to the demo fan.'); return render(); }
    if (act === 'owner-login') {
      b.disabled = true;
      return api('/auth/owner/login', { method: 'POST', body: { email: val('sc-o-email'), password: $('#sc-o-pass').value } })
        .then(function (d) { owner = { token: d.token, name: d.owner.name, role: d.owner.role }; save('owner', owner); toast('Signed in as ' + d.owner.name + '.'); render(); })
        .catch(function (err) { b.disabled = false; toast(err.status === 400 ? 'Enter an email and password.' : err.message, true); });
    }
    if (act === 'owner-logout') { owner = null; save('owner', null); inboxSel = null; teamUnread = 0; badge(); return render(); }
    if (act === 'scan') return doScan(val('sc-d-pass'));
    if (act === 'scanmine') {
      return fanApi('/tickets/mine').then(function (list) {
        if (!list.length) { toast('Your fan account has no real tickets yet.', true); return; }
        var t = list[0];
        var sel = $('#sc-d-ev');
        var slug = t.event.slug;
        Array.prototype.forEach.call(sel.options, function (o) { if (o.getAttribute('data-slug') === slug) sel.value = o.value; });
        $('#sc-d-pass').value = t.id + ':' + t.liveCode;
        doScan(t.id + ':' + t.liveCode);
      }).catch(function (err) { toast(err.message, true); });
    }
    if (act === 'publish') { b.disabled = true; return publish(v); }
    if (act === 'post') {
      var text = val('sc-p-text');
      saveDraftFields();
      var pollOpts = draft.poll ? draft.opts.map(function (o) { return o.trim(); }).filter(Boolean) : null;
      if (draft.poll && pollOpts.length < 2) return toast('Add at least two poll options.', true);
      if (!text && !draft.photo && !pollOpts) return toast('Write something, add a photo, or add a poll.', true);
      var team = $('#sc-p-team') && $('#sc-p-team').checked;
      b.disabled = true;
      return postAs(text, val('sc-p-show'), { team: team, pin: $('#sc-p-pin') && $('#sc-p-pin').checked, push: $('#sc-p-push') && $('#sc-p-push').checked, image: draft.photo, poll: pollOpts })
        .then(function (r) {
          draft = { photo: null, poll: false, opts: ['', ''] };
          redrawComposer();
          $('#sc-p-text').value = '';
          postedToast(r);
          return loadFeed();
        })
        .catch(function (err) { toast('Post failed: ' + err.message, true); })
        .then(function () { var btn = document.querySelector('[data-sc="post"]'); if (btn) btn.disabled = false; });
    }
    if (act === 'nophoto') { draft.photo = null; return redrawComposer(); }
    if (act === 'togglepoll') { saveDraftFields(); draft.poll = !draft.poll; return redrawComposer(); }
    if (act === 'addopt') { saveDraftFields(); if (draft.opts.length < 4) draft.opts.push(''); return redrawComposer(); }
    if (act === 'vote') {
      var vp = v.split(':');
      return fanApi('/feed/' + encodeURIComponent(vp[0]) + '/vote', { method: 'POST', body: { option: Number(vp[1]) } }).then(function (r) {
        feedPosts.forEach(function (p) { if (p.id === vp[0]) p.poll = r; });
        drawFeed();
      }).catch(function (err) { toast(err.message, true); });
    }
    if (act === 'report') { openReport = openReport === v ? null : v; return drawFeed(); }
    if (act === 'reportwhy') {
      var rp = v.split('|');
      openReport = null;
      return fanApi('/feed/' + encodeURIComponent(rp[0]) + '/report', { method: 'POST', body: { reason: rp[1] } })
        .then(function (r) { toast(r.already ? 'You already reported this post.' : 'Reported. The team will review it.'); return loadFeed(); })
        .catch(function (err) { toast(err.message, true); drawFeed(); });
    }
    if (act === 'modban') {
      b.disabled = true;
      return ownerApi('/owner/moderation/' + encodeURIComponent(v), { method: 'POST', body: { action: 'ban' } })
        .then(function (r) { toast('Removed. They can’t post or comment until ' + new Date(r.bannedUntil).toLocaleDateString() + '.'); return loadModeration(); })
        .catch(function (err) { b.disabled = false; toast(err.message, true); });
    }
    if (act === 'modapprove' || act === 'modremove') {
      b.disabled = true;
      return ownerApi('/owner/moderation/' + encodeURIComponent(v), { method: 'POST', body: { action: act === 'modapprove' ? 'approve' : 'remove' } })
        .then(function () { toast(act === 'modapprove' ? 'Approved. It is live in the feed.' : 'Removed.'); return loadModeration(); })
        .catch(function (err) { b.disabled = false; toast(err.message, true); });
    }
    if (act === 'changepw') {
      var cur = $('#sc-pw-cur').value, nxt = $('#sc-pw-new').value;
      if (nxt.length < 12) return toast('Use at least 12 characters for the new password.', true);
      b.disabled = true;
      return ownerApi('/auth/owner/password', { method: 'POST', body: { current: cur, next: nxt } })
        .then(function (r) { owner.token = r.token; save('owner', owner); $('#sc-pw-cur').value = ''; $('#sc-pw-new').value = ''; toast('Password changed. Other owner sessions are signed out.'); })
        .catch(function (err) { toast(/Current password/.test(err.message) ? 'Current password is wrong.' : err.message, true); })
        .then(function () { b.disabled = false; });
    }
    if (act === 'msgview') { msgView = v; dmWith = null; save('msgview', v); return render(); }
    if (act === 'sethandle') {
      var h = val('sc-h-in').toLowerCase().replace(/^@/, '');
      b.disabled = true;
      return fanApi('/auth/fan/me', { method: 'PATCH', body: { handle: h } })
        .then(function (m) { fan.handle = m.handle; save('fan', fan); toast('You are @' + m.handle + '.'); drawDmList(); })
        .catch(function (err) { b.disabled = false; toast(err.status === 400 ? 'Use 3 to 24 letters, numbers, dots or underscores.' : err.message, true); });
    }
    if (act === 'edithandle') { stopPoll(); drawHandleForm(); var hi = $('#sc-h-in'); if (hi) hi.value = fan.handle || ''; return; }
    if (act === 'opendm') return openDm(v);
    if (act === 'closedm') { dmWith = null; return drawDmList(); }
    if (act === 'senddm') return sendDm();
    if (act === 'block' || act === 'unblock') {
      return fanApi('/dms/block/' + encodeURIComponent(v), { method: act === 'block' ? 'POST' : 'DELETE' })
        .then(function () { toast(act === 'block' ? 'Blocked @' + v + '. They can’t message you or find you.' : 'Unblocked @' + v + '.'); return openDm(v); })
        .catch(function (err) { toast(err.message, true); });
    }
    if (act === 'like') {
      return fanApi('/feed/' + encodeURIComponent(v) + '/like', { method: 'POST' }).then(function (r) {
        feedPosts.forEach(function (p) { if (p.id === v) { p.liked = r.liked; p.likes = r.likes; } });
        b.className = r.liked ? 'on' : ''; b.setAttribute('aria-pressed', String(r.liked)); b.textContent = '♥ ' + r.likes;
      }).catch(function (err) { toast(err.message, true); });
    }
    if (act === 'cms') { if (openComments[v]) delete openComments[v]; else openComments[v] = true; return drawFeed(); }
    if (act === 'addcm') {
      var inp = document.querySelector('[data-cmin="' + v + '"]');
      var t = inp && inp.value.trim();
      if (!t) return;
      var asOwner = owner && $('#sc-p-team') && $('#sc-p-team').checked;
      (asOwner ? ownerApi : fanApi)('/feed/' + encodeURIComponent(v) + '/comments', { method: 'POST', body: { text: t } })
        .then(function () { inp.value = ''; return loadFeed(true); })
        .catch(function (err) { toast('Comment failed: ' + err.message, true); });
      return;
    }
    if (act === 'rmpost') {
      var mine = feedPosts.filter(function (p) { return p.id === v; })[0];
      return (mine && mine.mine ? fanApi : ownerApi)('/feed/' + encodeURIComponent(v), { method: 'DELETE' })
        .then(function () { delete openComments[v]; toast('Post removed.'); return loadFeed(); })
        .catch(function (err) { toast(err.message, true); });
    }
    if (act === 'sendmsg') return sendFanMsg();
    if (act === 'openth') { inboxSel = v; var box = $('#sc-inbox'); if (box) box.innerHTML = 'Loading…'; return loadInboxThread().then(function () { var c = $('#sc-inbox .chat'); if (c) c.scrollTop = c.scrollHeight; }); }
    if (act === 'closeth') { inboxSel = null; return loadInbox(); }
    if (act === 'reply') return sendReply();
  }

  // ---------- hooks into the app's own buttons ----------
  // Capture phase, so we read the selection before the app re-renders.
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-act]');
    if (!b || !health) return;
    var act = b.getAttribute('data-act');

    if (act === 'pay') {
      var slug = EVENT_SLUG[b.getAttribute('data-v')];
      // The checkout sheet's first line reads "2 \u00d7 General admission".
      var sheet = b.closest('#sheet') || document;
      var line = sheet.querySelector('.rows > div > span');
      var m = line && line.textContent.match(/^\s*(\d+)\s*\u00d7\s*(.+?)\s*$/);
      var qty = m ? Math.max(1, Math.min(8, parseInt(m[1], 10))) : 1;
      var tierName = m && m[2];
      if (!slug || !tierName) return;
      getEvent(slug).then(function (ev) {
        var tier = ev.tiers.filter(function (t) { return t.name === tierName; })[0];
        if (!tier) throw new Error('That ticket type is not on the server');
        return buy(slug, tier.id, qty, 'app');
      }).catch(function (err) { toast('Real purchase failed: ' + err.message, true); });
    }

    // Owner portal "Publish": if an owner is signed in, publish the real draft
    // too, which sends a real push to every subscribed fan.
    if (act === 'publish' && owner) {
      ownerApi('/owner/events').then(function (events) {
        var draft = events.filter(function (x) { return x.slug === EVENT_SLUG.alt && x.status === 'draft'; })[0];
        if (draft) return publish(draft.id);
      }).catch(function () {});
    }

    // Fan composer "Post": mirror text, photo and poll to the real shared feed.
    if (act === 'post' && !b.closest('#sc-panel')) {
      var cp = document.getElementById('cpText');
      var ptext = cp ? cp.value.trim() : '';
      var pshow = document.getElementById('cpShow');
      var ph = document.querySelector('#sheet .cp-photo .ph');
      var pm = ph && (ph.getAttribute('style') || '').match(/url\(["']?(data:image\/[^"')]+)["']?\)/);
      var pphoto = pm ? pm[1] : null;
      var popts = Array.prototype.map.call(document.querySelectorAll('#sheet [data-cpopt]'), function (i) { return i.value.trim(); }).filter(Boolean);
      if (ptext || pphoto || popts.length >= 2) {
        postAs(ptext, EVENT_SLUG[pshow && pshow.value] || null, { image: pphoto, poll: popts.length >= 2 ? popts : null })
          .then(function (r) { postedToast(r, 'Also posted to the live feed'); appCounts.at = 0; if (tab === 'feed') loadFeed(true); })
          .catch(function (err) { toast('Live feed post failed: ' + err.message, true); });
      }
    }

    // Owner portal feed "Post": with an owner signed in, post as Subcurrent
    // for real, honoring the Pin and Push switches.
    if (act === 'ofpost' && owner) {
      var of = document.getElementById('ofText');
      var otext = of && of.value.trim();
      if (otext) {
        var oshow = document.getElementById('ofShow');
        postAs(otext, EVENT_SLUG[oshow && oshow.value] || null, {
          team: true,
          pin: document.getElementById('ofPin') && document.getElementById('ofPin').checked,
          push: document.getElementById('ofPush') && document.getElementById('ofPush').checked
        }).then(function (r) {
          toast('Posted to the live feed as Subcurrent' + (r.push && r.push.sent ? '. Real push sent to ' + r.push.sent + ' device' + (r.push.sent === 1 ? '' : 's') + '.' : '.'));
        }).catch(function (err) { toast('Live feed post failed: ' + err.message, true); });
      }
    }

    // Likes, poll votes and reports on the app's built-in posts go to the
    // matching server posts (seeded under the same ids).
    if (act === 'like' && !b.closest('#sc-panel')) {
      var lk = b.getAttribute('data-v');
      appPost(lk).then(function (p) {
        if (!p) return;
        return fanApi('/feed/' + encodeURIComponent(p.id) + '/like', { method: 'POST' }).then(function (r) {
          p.liked = r.liked; p.likes = r.likes; syncAppCounts(true);
        });
      }).catch(function (err) { toast('Real like failed: ' + err.message, true); });
    }
    if (act === 'vote' && !b.closest('#sc-panel')) {
      var vt = (b.getAttribute('data-v') || '').split(':');
      appPost(vt[0]).then(function (p) {
        if (!p || !p.poll) return;
        return fanApi('/feed/' + encodeURIComponent(p.id) + '/vote', { method: 'POST', body: { option: Number(vt[1]) } })
          .then(function (r) { p.poll = r; toast('Vote counted for real. ' + r.votes.reduce(function (x, y) { return x + y; }, 0) + ' real votes so far.'); });
      }).catch(function (err) { toast('Real vote failed: ' + err.message, true); });
    }
    if (act === 'reportwhy' && !b.closest('#sc-panel')) {
      var rw = (b.getAttribute('data-v') || '').split('|');
      if (rw[0] && rw[0].indexOf('dm:') !== 0) {
        appPost(rw[0]).then(function (p) {
          if (p) return fanApi('/feed/' + encodeURIComponent(p.id) + '/report', { method: 'POST', body: { reason: rw[1] || 'Reported in app' } });
        }).catch(function () {});
      }
    }

    // ---- Teams portal (the crew's phone) goes to the real crew API ----
    if (act === 'tsend') {
      var tm = document.getElementById('tMsg');
      var ttext = tm && tm.value.trim();
      var tt = document.querySelector('#tBody .topbar-t');
      var tch = CHAN_BY_NAME[tt ? tt.textContent.replace(/^#\s*/, '').trim() : 'all'] || 'all';
      if (ttext) crewSend(tch, ttext).then(function () { toast('Sent on the real #' + tch + ' channel. Open Live, then Crew, to see replies.'); }).catch(function (err) { toast('Crew message failed: ' + err.message, true); });
    }
    if (act === 'tquick') crewIncident(b.getAttribute('data-v'));
    if (act === 'tscan') doorMove(1);
    if (act === 'tout') doorMove(-1);
    if (act === 'tsim') {
      var sim = b.getAttribute('data-v');
      if (sim === 'fight') crewIncident('backup', 'Fight in the lobby');
      else if (sim === 'task') crewApi('/crew/pings', { method: 'POST', body: { kind: 'task', title: 'Restock wristbands at the door', to: ['door'] } }).then(function () { toast('Real task ping sent to #door.'); }).catch(function () {});
      else if (sim === 'set') crewApi('/crew/pings', { method: 'POST', body: { kind: 'info', title: 'Set change in 10', to: ['all'] } }).then(function () { toast('Real heads-up sent to all crew.'); }).catch(function () {});
      else if (sim === 'cap') toast('The real capacity hold fires on its own when the live headcount hits 100%. Count people in under Live, then Crew.');
    }

    // ---- Owner Broadcast: sends for real when an owner is signed in ----
    if (act === 'xpsend') {
      if (!owner) { toast('Sign in as the owner under Live to send broadcasts for real.'); }
      else {
        var xt = document.getElementById('xpText');
        var xtext = xt && xt.value.trim();
        var PL = { fb: 'facebook', ig: 'instagram', x: 'x' };
        var plats = Array.prototype.map.call(document.querySelectorAll('[data-act="xpp"][aria-pressed="true"]'), function (n) { return PL[n.getAttribute('data-v')]; }).filter(Boolean);
        var xa = document.querySelector('[data-act="xpapp"]');
        if (xa && xa.getAttribute('aria-pressed') === 'true') plats.push('app');
        var xi = document.querySelector('[data-act="xpimg"]');
        var withImg = xi && xi.getAttribute('aria-pressed') === 'true';
        if (xtext && plats.length) {
          (withImg ? fetch('og-image.jpg').then(function (r) { return r.blob(); }).then(fileToDataUrl) : Promise.resolve(null)).then(function (img) {
            return ownerApi('/owner/broadcast', { method: 'POST', body: img ? { text: xtext, platforms: plats, image: img } : { text: xtext, platforms: plats } });
          }).then(function (r) { toast('Broadcast: ' + r.summary); })
            .catch(function (err) { toast('Broadcast failed: ' + err.message, true); });
        }
      }
    }

    // ---- Fan intent: Going, giveaway, follows, profile ----
    if (act === 'going' && !b.closest('#sc-panel')) {
      var gwant = b.getAttribute('aria-pressed') !== 'true';
      appPost(b.getAttribute('data-v')).then(function (p) {
        return fanApi('/events/' + encodeURIComponent((p && p.eventSlug) || 'current') + '/going', { method: 'POST', body: { going: gwant } });
      }).then(function (r) { if (r.going) toast('You’re on the real list. ' + r.goingCount + ' going so far.'); })
        .catch(function (err) { toast('Real RSVP failed: ' + err.message, true); });
    }
    if (act === 'giveaway' && !b.disabled) {
      fanApi('/events/current/giveaway', { method: 'POST' })
        .then(function (r) { toast((r.already ? 'Already entered. ' : 'Entered for real. ') + r.entries + ' entr' + (r.entries === 1 ? 'y' : 'ies') + ' so far.'); })
        .catch(function (err) { toast('Real entry failed: ' + err.message, true); });
    }
    // Only artists exist on the server under the app's ids; demo fans don't.
    if (act === 'follow') {
      var row = b.parentNode;
      var isArtist = row && row.querySelector('[data-act="ext"][data-v="SoundCloud"]');
      if (isArtist) {
        var fwant = !/Following/.test(b.textContent);
        fanApi('/follows', { method: 'POST', body: { target: 'artist:' + b.getAttribute('data-v'), follow: fwant } })
          .then(function (r) { if (r.following) toast('Following for real. ' + r.followers + ' follower' + (r.followers === 1 ? '' : 's') + ' on the live app.'); })
          .catch(function (err) { toast('Real follow failed: ' + err.message, true); });
      }
    }
    if (act === 'obsave' && !b.disabled) {
      var oh = document.getElementById('obHandle'), ob = document.getElementById('obBio');
      var prof = {};
      var hv = oh && oh.value.trim().replace(/^@/, '').toLowerCase();
      if (hv && /^[a-z0-9._]{3,24}$/.test(hv)) prof.handle = hv;
      if (ob) prof.bio = ob.value.trim().slice(0, 280);
      if (prof.handle || prof.bio) {
        fanApi('/auth/fan/me', { method: 'PATCH', body: prof }).then(function (m) {
          if (fan && m.handle) { fan.handle = m.handle; save('fan', fan); }
          toast('Profile saved to your real account' + (m.handle ? ' as @' + m.handle : '') + '.');
        }).catch(function (err) { toast(err.status === 409 ? 'That @handle is taken on the live app. Pick another under Live.' : 'Profile not saved: ' + err.message, true); });
      }
    }

    // ---- Teams portal: shifts, breaks, task check-offs and acks ----
    if (act === 'clock') crewClock(/Clock out/.test(b.textContent) ? 'out' : 'in');
    if (act === 'tbreak') crewBreak(/End break/.test(b.textContent) ? 'end' : 'start');
    if (act === 'tdone' && b.getAttribute('aria-pressed') !== 'true') {
      var tli = b.closest('li'), tb = tli && tli.querySelector('b');
      ackByTitle(tb && tb.textContent, 'done').then(function (r) { if (r) toast('Marked done on the real task. Ops can see it.'); }).catch(function () {});
    }
    if (act === 'tack') {
      var tbox = b.closest('li') || b.closest('[class*="tp"]') || b.parentNode.parentNode;
      var th = tbox && tbox.querySelector('h2, h3, b');
      ackByTitle(th && th.textContent, b.getAttribute('data-x') === 'cant' ? 'cant' : 'ok').then(function (r) { if (r) toast('Answered the real ping.'); }).catch(function () {});
    }

    // ---- Owner portal: drop, books, feed pins ----
    var OWNER_ONLY = { dropnow: 1, savemember: 1, savebuy: 1, ofpin: 1, ofdel: 1 };
    if (OWNER_ONLY[act] && !b.closest('#sc-panel') && !owner) toast('Sign in as the owner under Live to do this for real too.');
    if (owner && !b.closest('#sc-panel')) {
      if (act === 'dropnow') dropNow();
      if (act === 'savemember') {
        var mn = document.getElementById('mName'), mr = document.getElementById('mRole'), mrate = document.getElementById('mRate'), mb = document.getElementById('mBasis');
        var basis = mb && mb.value;
        // Salary and retainers aren't per shift, so they don't cost out crew hours.
        var perShift = basis === 'hourly' || basis === 'flat';
        if (mn && mn.value.trim() && cents(mrate && mrate.value)) {
          addMember({ name: mn.value.trim(), role: (mr && mr.value.trim()) || 'Crew', rateCents: perShift ? cents(mrate.value) : 0, basis: basis === 'hourly' ? 'hour' : 'flat' })
            .then(function (m) { toast('Added ' + m.name + ' to the real roster.'); })
            .catch(function (err) { toast('Roster save failed: ' + err.message, true); });
        }
      }
      if (act === 'savebuy') {
        var bamt = cents(document.getElementById('bAmt') && document.getElementById('bAmt').value);
        var bshow = document.getElementById('bShow'), bdate = document.getElementById('bDate');
        var blabel = bshow && bshow.value && bshow.selectedOptions[0] ? bshow.selectedOptions[0].textContent : '';
        var bvendor = (document.getElementById('bVendor') && document.getElementById('bVendor').value.trim()) || 'Purchase';
        var bcat = document.getElementById('bCat') && document.getElementById('bCat').value;
        if (bamt) {
          slugFromLabel(blabel).then(function (slug) {
            var x = { vendor: bvendor, amountCents: bamt, category: bcat || 'other' };
            if (slug) x.eventSlug = slug;
            if (bdate && bdate.value) x.spentAt = bdate.value;
            return addExpense(x);
          }).then(function (x) { toast('Logged ' + money(x.amountCents) + ' in the real books' + (x.eventSlug ? ' against the show.' : '.')); })
            .catch(function (err) { toast('Books save failed: ' + err.message, true); });
        }
      }
      if (act === 'ofpin' || act === 'ofdel') {
        var ok = act;
        appPost(b.getAttribute('data-v')).then(function (p) {
          if (!p) return null;
          return ok === 'ofpin'
            ? ownerApi('/feed/' + encodeURIComponent(p.id) + '/pin', { method: 'POST', body: { pinned: !p.pinned } }).then(function (r) { p.pinned = r.pinned; toast(r.pinned ? 'Pinned on the live feed.' : 'Unpinned on the live feed.'); })
            : ownerApi('/feed/' + encodeURIComponent(p.id), { method: 'DELETE' }).then(function () { delete appCounts.byKey[b.getAttribute('data-v')]; toast('Removed from the live feed.'); });
        }).catch(function (err) { toast(err.message, true); });
      }
    }

    // "My tickets" in the app: nudge toward the real ones.
    if (act === 'viewtickets' || (act === 'tab' && b.getAttribute('data-v') === 'tickets')) {
      fanApi('/tickets/mine').then(function (list) {
        if (list.length) toast('You have ' + list.length + ' real ticket' + (list.length === 1 ? '' : 's') + ' with live door codes. Tap Live to see them.');
      }).catch(function () {});
    }
  }, true);

  // Comments typed under the app's built-in posts go to the server post too.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!health || !f.matches || !f.matches('form[data-form="sendcm"]')) return;
    var inp = f.querySelector('input.input');
    var text = inp && inp.value.trim();
    var key = f.getAttribute('data-v');
    if (!text || !key) return;
    appPost(key).then(function (p) {
      if (!p) return;
      return fanApi('/feed/' + encodeURIComponent(p.id) + '/comments', { method: 'POST', body: { text: text } })
        .then(function () { p.comments++; syncAppCounts(true); });
    }).catch(function (err) { toast('Real comment failed: ' + err.message, true); });
  }, true);

  // The app's chat with Subcurrent (thread "th-cbh") also goes to the real
  // team inbox. Other app chats are with demo people and stay simulated.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!health || !f.matches || !f.matches('form[data-form="sendmsg"][data-v="th-cbh"]')) return;
    var inp = f.querySelector('input.input');
    var text = inp && inp.value.trim();
    if (!text) return;
    fanApi('/messages', { method: 'POST', body: { text: text } })
      .then(function () { toast('Delivered to the real Subcurrent inbox. Replies show under Live, then Messages.'); })
      .catch(function (err) { toast('Real message failed: ' + err.message, true); });
  }, true);

  // Real like/comment counts on the app's built-in posts. The app's numbers
  // are demo data; once the server post exists these show real activity.
  var appCounts = { at: 0, byKey: {}, pending: null };
  function fetchAppCounts(keys) {
    if (appCounts.pending) return appCounts.pending;
    appCounts.pending = feedCall('/feed/by-app-keys?keys=' + encodeURIComponent(keys.join(',')))
      .then(function (m) { Object.keys(m).forEach(function (k) { appCounts.byKey[k] = m[k]; }); appCounts.at = Date.now(); return appCounts.byKey; })
      .finally(function () { appCounts.pending = null; });
    return appCounts.pending;
  }
  function appPost(key) {
    if (!key || !/^p\d+$/.test(key)) return Promise.resolve(null);
    if (appCounts.byKey[key]) return Promise.resolve(appCounts.byKey[key]);
    return fetchAppCounts([key]).then(function (m) { return m[key] || null; });
  }
  function fmtCount(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(n); }
  function syncAppCounts(force) {
    if (!health) return;
    var likeBtns = document.querySelectorAll('[data-act="like"][data-v^="p"]');
    if (!likeBtns.length) return;
    var keys = [];
    likeBtns.forEach(function (bn) { var k = bn.getAttribute('data-v'); if (/^p\d+$/.test(k) && keys.indexOf(k) < 0) keys.push(k); });
    var stale = force || Date.now() - appCounts.at > 20000 || keys.some(function (k) { return !(k in appCounts.byKey); });
    var apply = function () {
      keys.forEach(function (k) {
        var p = appCounts.byKey[k];
        if (!p) return;
        document.querySelectorAll('[data-act="like"][data-v="' + k + '"]').forEach(function (bn) {
          var num = bn.querySelector('.num');
          var want = fmtCount(p.likes);
          if (num && num.textContent !== want) num.textContent = want;
          if (bn.classList.contains('liked') !== p.liked) bn.classList.toggle('liked', p.liked);
          if (bn.getAttribute('aria-pressed') !== String(p.liked)) bn.setAttribute('aria-pressed', String(p.liked));
        });
        document.querySelectorAll('[data-act="comments"][data-v="' + k + '"] .num').forEach(function (num) {
          var want = fmtCount(p.comments);
          if (num.textContent !== want) num.textContent = want;
        });
      });
    };
    apply();
    if (stale && !appCounts.pending) fetchAppCounts(keys).then(apply).catch(function () {});
  }

  // Replace the app's simulated "N left" with real remaining counts whenever
  // the checkout sheet renders.
  function syncSheetInventory() {
    if (!health) return;
    var cta = document.querySelector('[data-act="checkout"][data-v]');
    var tiers = document.querySelectorAll('[data-act="tier"]');
    if (!cta || !tiers.length) return;
    var slug = EVENT_SLUG[cta.getAttribute('data-v')];
    if (!slug) return;
    getEvent(slug).then(function (ev) {
      tiers.forEach(function (btn) {
        var tier = ev.tiers.filter(function (t) { return t.name === TIER_NAME[btn.getAttribute('data-v')]; })[0];
        var sub = btn.querySelector('.t-sub');
        if (!tier || !sub || sub.getAttribute('data-sc-live') === String(tier.remaining)) return;
        var soldOut = !tier.salesOpen || tier.remaining <= 0;
        if (soldOut && sub.textContent === 'Sold out') return;
        sub.textContent = soldOut ? 'Sold out' : tier.remaining + ' left';
        sub.setAttribute('data-sc-live', String(tier.remaining));
      });
    }).catch(function () {});
  }

  // ---------- boot ----------
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 6000);
  fetch(API_BASE + '/health', { signal: ctrl.signal })
    .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : null; })
    .then(function (h) {
      if (!h) return;
      health = h;
      mount();
      var syncQueued = false;
      new MutationObserver(function () {
        syncSheetInventory();
        if (syncQueued) return;
        syncQueued = true;
        requestAnimationFrame(function () { syncQueued = false; syncAppCounts(false); });
      }).observe(document.body, { childList: true, subtree: true });
      syncAppCounts(true);
      checkUnread();
      setInterval(checkUnread, 30000);
    })
    .catch(function () { /* backend unreachable: stay invisible, app runs as a pure prototype */ });
})();
