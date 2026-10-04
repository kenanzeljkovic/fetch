/**
 * Offscreen document — hosts the Telnyx WebRTC client for the Chrome extension.
 * Built into extension/offscreen.js by `npm run build:extension`.
 *
 * It runs at chrome-extension://<id>, so the microphone permission belongs to the extension and
 * Twenty's Permissions-Policy has no say. Offscreen documents cannot show a permission prompt:
 * the rep grants the mic once from the extension's settings page, and dialing here fails with a
 * clear error until they do.
 *
 * Only chrome.runtime exists here. Commands arrive from background.js (relayed from the Twenty tab's
 * embed iframe); call events go back through background.js to the tab that placed the call.
 */
import { MockDialer, TelnyxDialer, type DialEvent, type Dialer } from '../lib/dialer';

declare const chrome: any;

type Op = 'connect' | 'dial' | 'hangup' | 'tabClosed';
interface Command { target: 'offscreen'; op: Op; tabId: number; appUrl?: string; destinationNumber?: string; callerNumber?: string }
interface Connection { dialer: Dialer; callerNumber: string; mock: boolean }

const MIC_NOT_ENABLED = 'The microphone is not enabled for Fetch. Click the Fetch icon in the Chrome toolbar and choose "Enable microphone".';

let conn: { appUrl: string; promise: Promise<Connection> } | null = null;
let ownerTabId: number | null = null;   // the tab whose panel placed the current call
let inCall = false;
let stuckTimer: number | undefined;

/** Token from the Fetch server → Telnyx (or mock) dialer. Shared by every Twenty tab. */
function connect(appUrl: string): Promise<Connection> {
  if (conn && conn.appUrl !== appUrl && !inCall) {
    const old = conn.promise;
    conn = null;
    old.then((c) => c.dialer.destroy()).catch(() => { /* never connected */ });
  }
  if (!conn) {
    const promise = (async (): Promise<Connection> => {
      let res: Response;
      try {
        res = await fetch(`${appUrl}/api/telnyx/token`, { method: 'POST' });
      } catch {
        // Most often the extension lacks host permission for the app URL (settings saved before 0.5.0).
        throw new Error('Could not reach the Fetch server. Open Fetch settings from the Chrome toolbar and click Save settings.');
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `The Fetch server answered ${res.status}.`);
      const dialer: Dialer = body.mock ? new MockDialer() : new TelnyxDialer(body.token, body.callerNumber);
      await dialer.ready();
      return { dialer, callerNumber: body.callerNumber, mock: !!body.mock };
    })();
    const entry = { appUrl, promise };
    conn = entry;
    promise.catch(() => { if (conn === entry) conn = null; }); // next command retries
  }
  return conn.promise;
}

async function micGranted(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state === 'granted';
  } catch {
    return true; // can't tell; let getUserMedia decide
  }
}

function emit(event: DialEvent) {
  if (event.state === 'ended' || event.state === 'failed') { inCall = false; clearTimeout(stuckTimer); }
  chrome.runtime.sendMessage({ target: 'background', type: 'FETCH_DIALER_EVENT', tabId: ownerTabId, event }).catch(() => { /* background asleep and waking; nothing to do */ });
}

async function hangupCurrent() {
  const c = conn && (await conn.promise.catch(() => null));
  await c?.dialer.hangup();
  // A hangup before Telnyx created the call produces no "ended" event; don't block dialing forever.
  if (inCall) {
    clearTimeout(stuckTimer);
    stuckTimer = window.setTimeout(() => { inCall = false; }, 5000);
  }
}

async function handle(cmd: Command): Promise<Record<string, unknown>> {
  switch (cmd.op) {
    case 'connect': {
      // The same tab mounting its panel again means it reloaded mid-call. End the call, as the
      // in-iframe dialer did, rather than leave it running with no UI.
      if (inCall && cmd.tabId === ownerTabId) await hangupCurrent();
      const c = await connect(cmd.appUrl!);
      return { callerNumber: c.callerNumber, mock: c.mock };
    }
    case 'dial': {
      if (inCall) throw new Error(cmd.tabId === ownerTabId ? 'A call is already in progress.' : 'A call is already in progress in another Twenty tab.');
      const number = cmd.destinationNumber;
      if (typeof number !== 'string' || !/^\+\d{8,15}$/.test(number)) throw new Error('Not a valid number.');
      // The server already checked this is one of the account's numbers when it created the call record.
      const from = cmd.callerNumber;
      if (from != null && (typeof from !== 'string' || !/^\+\d{8,15}$/.test(from))) throw new Error('Not a valid caller ID.');
      inCall = true; // claim the line before any await so two tabs can't both dial
      clearTimeout(stuckTimer);
      ownerTabId = cmd.tabId;
      try {
        const c = await connect(cmd.appUrl!);
        if (!c.mock && !(await micGranted())) throw new Error(MIC_NOT_ENABLED);
        await c.dialer.dial(number, emit, from || undefined);
      } catch (e) {
        inCall = false;
        throw e;
      }
      return {};
    }
    case 'hangup':
      if (cmd.tabId === ownerTabId) await hangupCurrent();
      return {};
    case 'tabClosed':
      if (inCall && cmd.tabId === ownerTabId) await hangupCurrent();
      return {};
  }
}

chrome.runtime.onMessage.addListener((msg: Command, sender: { tab?: unknown }, sendResponse: (r: unknown) => void) => {
  if (!msg || msg.target !== 'offscreen' || sender.tab) return false; // commands come only from background.js
  handle(msg).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});
