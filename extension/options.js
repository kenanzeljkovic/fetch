const DEFAULTS = { twentyUrl: '', appUrl: 'https://app.fetchdialer.com', repEmail: '', theme: 'auto', defaultCallerId: '' };
const SCRIPT_ID = 'fetch-twenty-custom';
const $ = (id) => document.getElementById(id);

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

// Any port: localhost:5173 in dev is covered by http://localhost/*.
function hostPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

async function registerFor(origin) {
  const pattern = origin + '/*';
  try { await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }); } catch { /* not registered yet */ }
  await chrome.scripting.registerContentScripts([{
    id: SCRIPT_ID,
    matches: [pattern],
    js: ['dock.css.js', 'content.js'],
    css: ['content.css'],
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }]);
}

function fmtPhone(e164) {
  const d = (e164 || '').replace(/\D/g, '');
  return d.length === 11 && d[0] === '1' ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : e164;
}

// Caller ID choices come from the Fetch server (GET /api/telnyx/numbers), which holds the Telnyx key.
// Needs host permission for the app URL, which Save settings requests.
async function loadNumbers(appUrl, selected) {
  const select = $('defaultCallerId');
  const hint = $('callerIdHint');
  select.length = 1; // keep "Server default"
  try {
    const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/telnyx/numbers`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `The Fetch server answered ${res.status}.`);
    select.options[0].textContent = body.defaultNumber ? `Server default (${fmtPhone(body.defaultNumber)})` : 'Server default';
    for (const n of body.numbers || []) select.add(new Option(fmtPhone(n.phoneNumber), n.phoneNumber));
    hint.textContent = 'The number prospects see. You can still switch it per call in the dialer.';
    hint.className = 'hint';
  } catch {
    hint.textContent = 'Could not load your Telnyx numbers. Check the Fetch app URL and click Save settings.';
    hint.className = 'hint err';
  }
  // A saved number that is no longer on the account falls back to the server default.
  select.value = [...select.options].some((o) => o.value === selected) ? selected : '';
}

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('twentyUrl').value = s.twentyUrl || '';
  $('appUrl').value = s.appUrl || DEFAULTS.appUrl;
  $('repEmail').value = s.repEmail || '';
  $('theme').value = s.theme || 'auto';
  loadNumbers($('appUrl').value, s.defaultCallerId || '');
}

async function save() {
  const twentyUrl = $('twentyUrl').value.trim();
  const appUrl = $('appUrl').value.trim() || DEFAULTS.appUrl;
  const repEmail = $('repEmail').value.trim().toLowerCase();
  const theme = $('theme').value;
  const defaultCallerId = $('defaultCallerId').value;

  if (!originOf(appUrl)) return setStatus('Fetch app URL must be a full URL, e.g. https://app.fetchdialer.com', 'err');
  if (twentyUrl && !originOf(twentyUrl)) return setStatus('Twenty URL must be a full URL, e.g. https://crm.yourcompany.com', 'err');

  setStatus('Saving…');
  try {
    // One request, before any other await: Chrome only shows the prompt during the click.
    // The Fetch app's origin is for the offscreen dialer, which fetches its Telnyx token from there.
    const origins = [hostPattern(appUrl)];
    if (twentyUrl) origins.push(originOf(twentyUrl) + '/*');
    if (!(await chrome.permissions.request({ origins }))) throw new Error('Chrome permission was not granted, so settings were not saved.');
    if (twentyUrl) await registerFor(originOf(twentyUrl));
    await chrome.storage.sync.set({ twentyUrl: twentyUrl ? originOf(twentyUrl) : '', appUrl: originOf(appUrl), repEmail, theme, defaultCallerId });
    setStatus('Saved. Reload your Twenty tab to see Fetch.', 'ok');
    loadNumbers(originOf(appUrl), defaultCallerId); // the app URL may have changed, or permission was just granted
  } catch (e) {
    setStatus(e.message || String(e), 'err');
  }
}

// Calls run in the extension's offscreen document, which can't show a permission prompt.
// The grant made here (on chrome-extension://<id>) is the one it uses.
async function refreshMic() {
  let state = 'prompt';
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    state = p.state;
    p.onchange = refreshMic;
  } catch { /* unknown: offer the button */ }
  const el = $('micStatus');
  $('enableMic').hidden = state === 'granted';
  if (state === 'granted') { el.textContent = 'Microphone enabled.'; el.className = 'ok'; }
  else if (state === 'denied') { el.textContent = 'Microphone is blocked. Click the icon at the left of the address bar, set Microphone to Allow, then reload this page.'; el.className = 'err'; }
  else { el.textContent = 'Not enabled yet. Fetch cannot place calls until you allow it.'; el.className = ''; }
}

async function enableMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch { /* refreshMic shows the result */ }
  refreshMic();
}

$('save').addEventListener('click', save);
$('enableMic').addEventListener('click', enableMic);
load();
refreshMic();
