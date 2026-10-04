// Fetch Dialer for Twenty — content script.
//
// What lives where:
//   • This file owns everything that is drawn INSIDE Twenty's page: the resting pill,
//     the quick-call card, and the "Call with Fetch" tags next to phone numbers.
//   • The full dialer panel (queue / active call / notes / outcome / manual keypad) is the
//     Fetch web app itself, loaded in an iframe at  <appUrl>/?embed=1 . The two sides talk
//     over postMessage — see PROTOCOL below. Nothing about calling, Guard, or logging is
//     reimplemented here.
//
// PROTOCOL (parent → iframe)
//   FETCH_INIT   { repEmail, theme, twentyOrigin, dialerHost: 'extension', defaultCallerId }
//   FETCH_DIAL   { phone, contact: { objectType, recordId, name, company } | null }
//   FETCH_THEME  { theme }
//   FETCH_OPEN   { view: 'call' | 'manual' }
//   FETCH_DIALER_RESULT { id, ok, error?, callerNumber?, mock? }       answer to FETCH_DIALER
//   FETCH_DIALER_EVENT  { event: { state, telnyxCallId?, error?, neverConnected? } }
// PROTOCOL (iframe → parent)
//   FETCH_READY  {}
//   FETCH_STATE  { state, seconds, contactName }   state: idle|checking|blocked|dialing|ringing|connected|ended
//   FETCH_MINIMIZE {}
//   FETCH_CLOSE  {}
//   FETCH_DIALER { id, op: 'connect' | 'dial' | 'hangup', destinationNumber?, callerNumber? }
//
// Calls run in the extension's offscreen document (offscreen.html), not in the iframe, so the
// microphone belongs to the extension and Twenty's Permissions-Policy can't block it. This file
// only relays FETCH_DIALER to background.js and passes results and call events back.
//
// Contact association: the Twenty record id comes from the URL (/object/person/<uuid>),
// never from a name match. The server re-reads that record by id before logging anything.

(() => {
  'use strict';
  if (window.top !== window) return;            // never run inside iframes
  if (window.__fetchDialerLoaded) return;
  window.__fetchDialerLoaded = true;

  const DEFAULTS = { appUrl: 'https://app.fetchdialer.com', repEmail: '', theme: 'auto', defaultCallerId: '' };
  const ACTIVE = new Set(['dialing', 'ringing', 'connected']);

  const S = {
    settings: { ...DEFAULTS },
    appOrigin: '',
    ready: false,
    pending: null,          // last message queued before the iframe said FETCH_READY
    call: 'idle',
    seconds: 0,
    callName: '',
    card: null,             // { phone, contact } currently shown in the quick-call card
  };

  let host, root, pill, pillDot, pillStatus, card, panel, frame, toast;

  // ---------------------------------------------------------------- helpers
  const $ = (sel) => root.querySelector(sel);

  function normalize(raw) {
    if (!raw) return null;
    const t = String(raw).trim();
    const d = t.replace(/\D/g, '');
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    if (t.startsWith('+') && d.length >= 8 && d.length <= 15) return '+' + d;
    return null;
  }
  function fmtPhone(e164) {
    const d = (e164 || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    return e164 || '';
  }
  const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const initials = (name) =>
    (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '#';

  // The Twenty record a phone number belongs to. In a table (e.g. /objects/people) the URL names no
  // record, so it comes from the number's own row; on a record page it comes from the URL.
  function recordFor(el) {
    return (el && rowRecord(el)) || currentRecord();
  }

  // Table rows carry data-selectable-id="<record uuid>". The object type is read only from a link in
  // that row pointing at that same id: rows also link to related records (a company row's point of
  // contact), so no other link in the row is trusted. No matching link → no record, never a guess.
  function rowRecord(el) {
    const row = el.closest('[data-selectable-id]');
    const id = row && row.getAttribute('data-selectable-id');
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    for (const a of row.querySelectorAll('a[href*="/object/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/object\/(person|people|company|companies)\/([0-9a-f-]{36})(?:[/?#]|$)/i);
      if (!m || m[2].toLowerCase() !== id.toLowerCase()) continue;
      // Display only (the server re-reads the record): the chip's last text leaf, skipping its avatar initial.
      const leaves = [...a.querySelectorAll('*')].filter((e) => !e.children.length && e.textContent.trim());
      const name = (leaves.length ? leaves[leaves.length - 1].textContent : a.textContent).trim();
      return { objectType: /^(person|people)$/i.test(m[1]) ? 'person' : 'company', recordId: id, name, company: '' };
    }
    return null;
  }

  // Twenty record pages: /object/person/<uuid> and /object/company/<uuid> (hosted and self-hosted).
  function currentRecord() {
    const m = location.pathname.match(/\/object\/(person|people|company|companies)\/([0-9a-f-]{36})/i);
    if (!m) return null;
    const objectType = /^(person|people)$/i.test(m[1]) ? 'person' : 'company';
    return { objectType, recordId: m[2], name: pageRecordName(), company: pageCompanyName(objectType) };
  }
  function pageRecordName() {
    // Twenty puts the record name in the tab title; fall back to the first heading on the page.
    const t = document.title.replace(/\s*[-|–—]\s*Twenty.*$/i, '').trim();
    if (t && !/^twenty$/i.test(t)) return t;
    const h = document.querySelector('h1, h2');
    return h ? h.textContent.trim() : '';
  }
  function pageCompanyName(objectType) {
    if (objectType !== 'person') return '';
    // Best effort: a company link on a person page. The server gets the authoritative value by id.
    const a = document.querySelector('a[href*="/object/company/"]');
    return a ? a.textContent.trim() : '';
  }

  // Theme: follow the page (Twenty's own light/dark), unless the user forced one in settings.
  function pageIsDark() {
    try {
      for (const el of [document.body, document.documentElement, document.getElementById('root')]) {
        if (!el) continue;
        const c = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
        if (!c || c.length < 3 || (c[3] !== undefined && Number(c[3]) === 0)) continue;
        const [r, g, b] = c.map(Number);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
      }
    } catch { /* ignore */ }
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function theme() {
    const t = S.settings.theme;
    return t === 'light' || t === 'dark' ? t : pageIsDark() ? 'dark' : 'light';
  }
  function applyTheme() {
    const t = theme();
    if (root.dataset.theme !== t) {
      root.dataset.theme = t;
      post({ type: 'FETCH_THEME', theme: t });
    }
    document.querySelectorAll('.fetch-call-tag').forEach((el) => (el.dataset.dark = t === 'dark' ? '1' : '0'));
  }

  // ---------------------------------------------------------------- dock UI
  function logoSvg(size) {
    // Placeholder mark: orange rounded square with sound-wave bars. Swap for the real Fetch logo any time.
    return `<svg class="fd-logo" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="#F26A1E"/>
      <rect x="5" y="9" width="2.4" height="6" rx="1.2" fill="#fff"/>
      <rect x="9.2" y="6" width="2.4" height="12" rx="1.2" fill="#fff"/>
      <rect x="13.4" y="8" width="2.4" height="8" rx="1.2" fill="#fff"/>
      <rect x="17.6" y="10" width="2.4" height="4" rx="1.2" fill="#fff"/>
    </svg>`;
  }

  function build() {
    host = document.createElement('div');
    host.id = 'fetch-dialer-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = window.__FETCH_DOCK_CSS || '';
    shadow.appendChild(style);

    root = document.createElement('div');
    root.className = 'fd';
    root.dataset.theme = theme();
    root.innerHTML = `
      <div class="fd-panel" data-preload="1"></div>
      <div class="fd-card" hidden>
        <div class="fd-card-top">
          <div class="fd-avatar"></div>
          <div>
            <div class="fd-card-name"></div>
            <div class="fd-card-sub"></div>
          </div>
          <button class="fd-card-close" aria-label="Close">×</button>
        </div>
        <div class="fd-card-actions">
          <button class="fd-btn fd-btn-primary fd-card-call">Call</button>
          <button class="fd-btn fd-btn-quiet fd-card-open">Open dialer</button>
        </div>
      </div>
      <div class="fd-toast" hidden></div>
      <div class="fd-pill" role="button" tabindex="0" aria-label="Fetch dialer">
        ${logoSvg(24)}
        <span class="fd-pill-name">Fetch</span>
        <span class="fd-dot" data-state="idle"></span>
        <span class="fd-pill-status">Ready</span>
      </div>`;
    shadow.appendChild(root);
    (document.body || document.documentElement).appendChild(host);

    pill = $('.fd-pill');
    pillDot = $('.fd-dot');
    pillStatus = $('.fd-pill-status');
    card = $('.fd-card');
    panel = $('.fd-panel');
    toast = $('.fd-toast');

    frame = document.createElement('iframe');
    frame.className = 'fd-frame';
    frame.title = 'Fetch dialer';
    frame.allow = 'autoplay';          // ringback tone; the mic is used by offscreen.html, not here
    frame.src = S.settings.appUrl.replace(/\/$/, '') + '/?embed=1';
    panel.appendChild(frame);

    pill.addEventListener('click', onPillClick);
    pill.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPillClick(); } });
    $('.fd-card-close').addEventListener('click', hideCard);
    $('.fd-card-call').addEventListener('click', () => S.card && dial(S.card.phone, S.card.contact));
    $('.fd-card-open').addEventListener('click', () => { hideCard(); openPanel('manual'); });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!card.hidden) hideCard();
      else if (!panel.hidden && !panel.dataset.preload && !ACTIVE.has(S.call)) closePanel();
    });
  }

  function onPillClick() {
    if (ACTIVE.has(S.call) || S.call === 'blocked') return openPanel('call');
    const rec = currentRecord();
    const phone = firstPhoneOnPage();
    if (rec && phone) return showCard(phone, rec);
    openPanel('manual');
  }

  function showCard(phone, contact) {
    S.card = { phone, contact };
    $('.fd-avatar').textContent = initials(contact && contact.name);
    $('.fd-card-name').textContent = (contact && contact.name) || 'Twenty contact';
    $('.fd-card-sub').textContent = contact && contact.company ? `${contact.company} · ${fmtPhone(phone)}` : fmtPhone(phone);
    card.hidden = false;
    $('.fd-card-call').focus();
  }
  function hideCard() { card.hidden = true; S.card = null; }

  function openPanel(view) {
    hideCard();
    delete panel.dataset.preload;
    panel.hidden = false;
    if (view) post({ type: 'FETCH_OPEN', view });
  }
  function closePanel() {
    // Hide, don't unmount: an active call keeps running behind the pill.
    panel.hidden = true;
    renderPill();
  }

  function showToast(html, ms = 4000) {
    toast.innerHTML = html;
    toast.hidden = false;
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => (toast.hidden = true), ms);
  }

  function renderPill() {
    const active = ACTIVE.has(S.call);
    pill.dataset.active = active ? '1' : '0';
    pillDot.dataset.state = S.call;
    if (active) {
      const verb = S.call === 'connected' ? 'In call' : 'Calling';
      pillStatus.textContent = `${verb} ${fmtTime(S.seconds)}${S.callName ? ' · ' + S.callName : ''}`;
    } else if (S.call === 'blocked') {
      pillStatus.textContent = 'Blocked';
    } else {
      pillStatus.textContent = 'Ready';
    }
  }

  // ---------------------------------------------------------------- iframe bridge
  function post(msg) {
    if (!frame) return;
    if (!S.ready) { S.pending = msg.type === 'FETCH_DIAL' || !S.pending ? msg : S.pending; return; }
    frame.contentWindow.postMessage(msg, S.appOrigin);
  }
  function initMsg() {
    return { type: 'FETCH_INIT', repEmail: S.settings.repEmail, theme: theme(), twentyOrigin: location.origin, dialerHost: 'extension', defaultCallerId: S.settings.defaultCallerId || '' };
  }

  const EXTENSION_RELOADED = 'The Fetch extension was updated. Reload this tab to keep calling.';
  function relayDialer(m) {
    const reply = (r) => post({ ...r, type: 'FETCH_DIALER_RESULT', id: String(m.id || '') });
    try {
      chrome.runtime
        .sendMessage({ target: 'background', type: 'FETCH_DIALER', op: m.op, destinationNumber: m.destinationNumber, callerNumber: m.callerNumber })
        .then((r) => reply(r || { ok: false, error: 'The Fetch extension did not answer.' }), () => reply({ ok: false, error: EXTENSION_RELOADED }));
    } catch {
      reply({ ok: false, error: EXTENSION_RELOADED }); // chrome.runtime is gone once the extension reloads
    }
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'FETCH_DIALER_EVENT') post({ type: 'FETCH_DIALER_EVENT', event: msg.event });
  });

  function dial(phone, contact) {
    if (!normalize(phone)) { showToast('<b>Not a valid number.</b> Fetch needs a 10-digit US number or a full international number.'); return; }
    openPanel();
    const msg = {
      type: 'FETCH_DIAL',
      phone: normalize(phone),
      contact: contact
        ? { objectType: contact.objectType, recordId: contact.recordId, name: contact.name || '', company: contact.company || '' }
        : null,
    };
    // [fetch:log] trace. contact: null means no Twenty record on this page/row, so no note can go to Twenty.
    console.log('[fetch:log] FETCH_DIAL', msg.contact ? `${msg.contact.objectType} ${msg.contact.recordId}` : 'NO TWENTY RECORD', msg);
    post(msg);
  }

  window.addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow || e.origin !== S.appOrigin) return;
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'FETCH_READY':
        S.ready = true;
        post(initMsg());
        if (S.pending) { const p = S.pending; S.pending = null; post(p); }
        break;
      case 'FETCH_STATE':
        S.call = m.state || 'idle';
        S.seconds = Number(m.seconds) || 0;
        S.callName = m.contactName || '';
        renderPill();
        if (S.call === 'dialing' || S.call === 'blocked') openPanel();
        break;
      case 'FETCH_MINIMIZE':
      case 'FETCH_CLOSE':
        closePanel();
        break;
      case 'FETCH_DIALER':
        relayDialer(m);
        break;
      default:
        break;
    }
  });

  // ---------------------------------------------------------------- phone numbers in Twenty's DOM
  const PHONE_RE = /^\s*(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\s*$/;
  const SKIP = /^(SCRIPT|STYLE|INPUT|TEXTAREA|SELECT|BUTTON)$/;

  function firstPhoneOnPage() {
    const a = document.querySelector('a[href^="tel:"]');
    if (a) return normalize(decodeURIComponent(a.getAttribute('href').slice(4)));
    const tag = document.querySelector('.fetch-call-tag');
    return tag ? tag.dataset.phone : null;
  }

  function makeTag(phone) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fetch-call-tag';
    b.dataset.phone = phone;
    b.dataset.dark = theme() === 'dark' ? '1' : '0';
    b.textContent = 'Call with Fetch';
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showCard(phone, recordFor(b)); });
    return b;
  }

  function scan() {
    // 1) tel: links (how Twenty renders phone fields)
    document.querySelectorAll('a[href^="tel:"]:not([data-fetch-tagged])').forEach((a) => {
      const phone = normalize(decodeURIComponent(a.getAttribute('href').slice(4)));
      a.dataset.fetchTagged = phone ? '1' : '0';
      if (phone) a.insertAdjacentElement('afterend', makeTag(phone));
    });
    // 2) plain-text numbers in small elements (cells, chips). We only ever add a SIBLING element
    //    after the element, never rewrite React-owned text nodes.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP.test(p.tagName) || p.closest('#fetch-dialer-host, [contenteditable="true"], a[href^="tel:"]')) return NodeFilter.FILTER_REJECT;
        if (p.dataset.fetchTagged || n.nodeValue.length > 24 || !PHONE_RE.test(n.nodeValue)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) hits.push(n);
    for (const n of hits) {
      const p = n.parentElement;
      const phone = normalize(n.nodeValue);
      p.dataset.fetchTagged = phone ? '1' : '0';
      if (phone) p.insertAdjacentElement('afterend', makeTag(phone));
    }
  }

  // Intercept clicks on tel: links so they open the Fetch card instead of the OS dialer.
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href^="tel:"]');
    if (!a) return;
    const phone = normalize(decodeURIComponent(a.getAttribute('href').slice(4)));
    if (!phone) return;
    e.preventDefault();
    e.stopPropagation();
    showCard(phone, recordFor(a));
  }, true);

  // ---------------------------------------------------------------- SPA navigation + DOM changes
  let scanTimer = 0;
  function scheduleScan() { clearTimeout(scanTimer); scanTimer = setTimeout(() => { scan(); applyTheme(); }, 250); }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    hideCard();           // the card belongs to the record you were just on
    scheduleScan();
  }, 400);

  // ---------------------------------------------------------------- boot
  chrome.storage.sync.get(DEFAULTS, (saved) => {
    S.settings = { ...DEFAULTS, ...saved };
    try { S.appOrigin = new URL(S.settings.appUrl).origin; } catch { S.appOrigin = new URL(DEFAULTS.appUrl).origin; }
    build();
    scan();
    new MutationObserver(scheduleScan).observe(document.body, { subtree: true, childList: true });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const k of Object.keys(changes)) S.settings[k] = changes[k].newValue;
    if (changes.theme) applyTheme();
    if ((changes.repEmail || changes.defaultCallerId) && S.ready) post(initMsg());
    if (changes.appUrl) showToast('Fetch app URL changed. Reload this tab to use it.');
  });
})();
