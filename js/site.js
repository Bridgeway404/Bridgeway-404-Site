/* Bridgeway 404 — shared public-site behavior.
   Everything here is progressive enhancement: links, phone numbers and
   Netlify forms all work with JavaScript turned off. */
(function () {
  'use strict';

  var PHONE_DISPLAY = '404-565-4216';

  /* ---------- Mobile navigation ---------- */
  var toggle = document.querySelector('.menu-toggle');
  var panel = document.getElementById('mobile-panel');
  function setMenu(open) {
    if (!toggle || !panel) return;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    panel.classList.toggle('open', open);
    document.body.classList.toggle('menu-open', open);
    if (open) { var first = panel.querySelector('a'); if (first) first.focus(); }
  }
  if (toggle && panel) {
    toggle.addEventListener('click', function () { setMenu(toggle.getAttribute('aria-expanded') !== 'true'); });
    panel.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('open')) { setMenu(false); toggle.focus(); }
    });
    window.matchMedia('(min-width: 981px)').addEventListener('change', function (m) { if (m.matches) setMenu(false); });
  }

  /* ---------- Call links: dial on phones, show a modal on desktop ---------- */
  var modal = document.getElementById('call-modal');
  var lastFocus = null;
  function isTouchPhone() { return window.matchMedia('(hover: none) and (pointer: coarse)').matches; }
  function openModal(trigger) {
    if (!modal) return;
    lastFocus = trigger || document.activeElement;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    var c = modal.querySelector('.modal-close'); if (c) c.focus();
  }
  function closeModal() {
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
    var s = modal.querySelector('.modal-status'); if (s) s.textContent = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  document.querySelectorAll('[data-call]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      if (modal && !isTouchPhone()) { e.preventDefault(); openModal(el); }
    });
  });
  if (modal) {
    modal.addEventListener('click', function (e) { if (e.target === modal || e.target.closest('.modal-close')) closeModal(); });
    document.addEventListener('keydown', function (e) {
      if (!modal.classList.contains('open')) return;
      if (e.key === 'Escape') { closeModal(); return; }
      if (e.key === 'Tab') {
        var f = modal.querySelectorAll('a[href], button:not([disabled])');
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    var copyBtn = modal.querySelector('[data-copy-phone]');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      var status = modal.querySelector('.modal-status');
      function done() { if (status) status.textContent = 'Number copied'; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(PHONE_DISPLAY).then(done, fallback);
      } else { fallback(); }
      function fallback() {
        var t = document.createElement('textarea');
        t.value = PHONE_DISPLAY; t.setAttribute('readonly', ''); t.style.position = 'absolute'; t.style.left = '-9999px';
        document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); } catch (err) { /* ignore */ }
        document.body.removeChild(t); done();
      }
    });
  }

  /* ---------- Tabs (quote page) ---------- */
  document.querySelectorAll('[role="tablist"]').forEach(function (list) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        var p = document.getElementById(t.getAttribute('aria-controls'));
        if (p) p.hidden = !on;
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t); history.replaceState(null, '', '#' + t.dataset.tab); });
      t.addEventListener('keydown', function (e) {
        var n = null;
        if (e.key === 'ArrowRight') n = tabs[(i + 1) % tabs.length];
        if (e.key === 'ArrowLeft') n = tabs[(i - 1 + tabs.length) % tabs.length];
        if (n) { e.preventDefault(); select(n, true); }
      });
    });
    var wanted = (location.hash || '').replace('#', '');
    var params = new URLSearchParams(location.search);
    if (params.get('service') === 'furniture-assembly') wanted = 'assembly';
    var match = tabs.filter(function (t) { return t.dataset.tab === wanted; })[0];
    select(match || tabs[0]);
    // Same-page links such as /quote/#assembly change only the hash
    window.addEventListener('hashchange', function () {
      var h = location.hash.replace('#', '');
      var t = tabs.filter(function (x) { return x.dataset.tab === h; })[0];
      if (t) { select(t); list.scrollIntoView({ block: 'start' }); }
    });
  });

  /* ---------- Pre-select a service from ?service= ---------- */
  (function () {
    var svc = new URLSearchParams(location.search).get('service');
    var sel = document.getElementById('qr-service');
    if (!svc || !sel) return;
    if (Array.prototype.some.call(sel.options, function (o) { return o.value === svc; })) sel.value = svc;
  })();

  /* ---------- Commercial form: preselect business type from ?type= or [data-type] links ---------- */
  (function () {
    var sel = document.getElementById('cp-type');
    if (!sel) return;
    function set(v) {
      if (v && Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) sel.value = v;
    }
    set(new URLSearchParams(location.search).get('type'));
    document.querySelectorAll('[data-type]').forEach(function (a) {
      a.addEventListener('click', function () { set(a.getAttribute('data-type')); });
    });
  })();

  /* ---------- Consent mirror: hidden Yes/No field for clean CRM import ---------- */
  document.querySelectorAll('[data-consent-mirror]').forEach(function (box) {
    var hidden = document.getElementById(box.getAttribute('data-consent-mirror'));
    if (!hidden) return;
    function sync() { hidden.value = box.checked ? 'Yes' : 'No'; }
    box.addEventListener('change', sync); sync();
  });

  /* ---------- Email becomes required only when it is the chosen contact method ---------- */
  document.querySelectorAll('[data-email-if]').forEach(function (sel) {
    var email = document.getElementById(sel.getAttribute('data-email-if'));
    if (!email) return;
    var marker = document.querySelector('[data-email-marker="' + email.id + '"]');
    function sync() {
      var need = sel.value === 'email';
      email.required = need;
      if (marker) marker.hidden = !need;
    }
    sel.addEventListener('change', sync); sync();
  });

  /* ---------- Legacy anchors from the old one-page site ---------- */
  if (document.body.dataset.page === 'home') {
    var legacy = { '#quote': '/quote/', '#assembly-form': '/quote/#assembly', '#contact': '/quote/#contact' };
    if (legacy[location.hash]) location.replace(legacy[location.hash]);
  }

  /* ---------- Commercial page: point the sticky mobile CTA at the partner form ---------- */
  if (document.body.dataset.page === 'commercial') {
    var primary = document.querySelector('.action-bar a.primary');
    if (primary) {
      primary.setAttribute('href', '#partner-form');
      primary.lastChild.textContent = 'Partner Inquiry';
    }
  }

  /* ---------- Footer year ---------- */
  document.querySelectorAll('[data-year]').forEach(function (el) { el.textContent = new Date().getFullYear(); });
})();
