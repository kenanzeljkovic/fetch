// Fetch Dialer for Twenty — background service worker.
// Content scripts for a self-hosted Twenty domain are registered from the
// options page (needs a user gesture for the permission prompt) and persist
// across browser sessions, so there is nothing to re-register here.
//
// It also relays the dialer: the embed iframe in a Twenty tab asks content.js, content.js asks
// here, and this forwards to the offscreen document (offscreen.html), which owns Telnyx and the
// microphone. Offscreen documents can only use chrome.runtime, so call events come back through
// here and go out to the tab that placed the call. Nothing is kept in memory: Chrome may stop
// this worker at any time, and the offscreen document tracks which tab owns the call.

const OFFSCREEN_PATH = 'offscreen.html';
const DEFAULT_APP_URL = 'https://app.fetchdialer.com';
const DIALER_OPS = new Set(['connect', 'dial', 'hangup']);

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

let creating = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  // Only one offscreen document may exist; two dials racing here must share one createDocument.
  creating = creating || chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Places Telnyx WebRTC calls, which need the microphone.',
    })
    .finally(() => { creating = null; });
  await creating;
}

async function toOffscreen(cmd) {
  await ensureOffscreen();
  const { appUrl } = await chrome.storage.sync.get({ appUrl: DEFAULT_APP_URL });
  const res = await chrome.runtime.sendMessage({ ...cmd, appUrl: (appUrl || DEFAULT_APP_URL).replace(/\/$/, ''), target: 'offscreen' });
  return res || { ok: false, error: 'The Fetch dialer did not answer.' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'background' || sender.id !== chrome.runtime.id) return false;

  // Twenty tab (content.js) → offscreen
  if (msg.type === 'FETCH_DIALER' && sender.tab && DIALER_OPS.has(msg.op)) {
    toOffscreen({ op: msg.op, tabId: sender.tab.id, destinationNumber: msg.destinationNumber, callerNumber: msg.callerNumber })
      .then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true;
  }

  // offscreen → the Twenty tab that placed the call
  if (msg.type === 'FETCH_DIALER_EVENT' && !sender.tab && sender.url === chrome.runtime.getURL(OFFSCREEN_PATH)) {
    if (typeof msg.tabId === 'number') {
      chrome.tabs.sendMessage(msg.tabId, { type: 'FETCH_DIALER_EVENT', event: msg.event }).catch(() => { /* tab gone */ });
    }
  }
  return false;
});

// Closing the tab that owns a call hangs it up instead of leaving it running with no UI.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!(await hasOffscreen())) return;
  chrome.runtime.sendMessage({ target: 'offscreen', op: 'tabClosed', tabId }).catch(() => { /* nothing to do */ });
});
