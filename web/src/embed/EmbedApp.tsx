/**
 * EmbedApp — the container behind /?embed=1 (the dialer panel inside Twenty's dock).
 *
 * Owns embed-only state (session queue, theme, timer, postMessage bridge) and drives EmbedDialer
 * with the same pieces the standalone app uses: the `api` client, the ringback tone, and the
 * disposition list.
 *
 * No WebRTC here. The extension's offscreen document owns Telnyx, the microphone and call audio;
 * this iframe only drives it through ExtensionDialer. It never creates a Telnyx client, never asks
 * for a Telnyx token, and never calls getUserMedia. Guard, call records, and note logging all stay on the
 * server exactly as in Phase 1 — this file only sequences those calls.
 *
 * Contact association: a call from Twenty carries { objectType, recordId } from the page URL.
 * The server re-reads that record by id and decides the name, the Guard inputs, and where the
 * note goes. Names shown here before the server answers are display-only.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, sessionId, type CallRecord, type Disposition, type TelnyxNumber } from '../lib/api';
import type { DialEvent, Dialer } from '../lib/dialer';
import { startRingback, stopRingback } from '../lib/tones';
import { DISPOSITIONS } from '../components/CallPanel';
import EmbedDialer, { formatPhone, type CallerIdOption, type CallState, type EmbedContact, type LogStatus, type QueueItem, type Stats } from './EmbedDialer';
import { onParentMessage, sendToParent, type DialerHost, type EmbedContactRef, type ParentToEmbed } from './embedBridge';
import { ExtensionDialer } from './extensionDialer';

type TwentyRef = Pick<EmbedContactRef, 'objectType' | 'recordId'>;
interface QueueEntry extends QueueItem { twenty: TwentyRef | null }
interface Current extends EmbedContact { twenty: TwentyRef | null }

const OUTCOMES = DISPOSITIONS.map((d) => ({ code: d.key, label: d.label }));
const ACTIVE: CallState[] = ['dialing', 'ringing', 'connected'];
/** Outcomes with side effects beyond the note need a second click. */
const CONFIRM_FIRST: Disposition[] = ['do_not_call'];

/** Keypad digits → E.164. Anything ambiguous is refused here and never reaches the server. */
function manualToE164(digits: string): string | null {
  const d = digits.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  if (d.length >= 11 && d.length <= 15 && d[0] !== '1' && d[0] !== '0') return `+${d}`;
  return null;
}

/** [fetch:log] trace of the call -> outcome -> Twenty note flow. Shows in the iframe's console. */
const trace = (step: string, data?: unknown) => console.log(`[fetch:log] ${step}`, data ?? '');

const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : (e as Error)?.message || fallback);

const toCurrent = (q: QueueEntry): Current => ({
  id: q.id,
  objectType: q.twenty?.objectType ?? null,
  name: q.name,
  company: q.company ?? null,
  phone: q.phone,
  twenty: q.twenty,
});

export default function EmbedApp() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [view, setView] = useState<'call' | 'manual'>('call');
  const [stats, setStats] = useState<Stats>({ callsToday: 0, connects: 0, talkSeconds: 0 });
  // Caller ID: the account's numbers (GET /api/telnyx/numbers), the rep's default from the extension
  // settings (FETCH_INIT.defaultCallerId), and the pick for the next call. The server re-checks the pick.
  const [numbers, setNumbers] = useState<TelnyxNumber[]>([]);
  const [serverDefaultNumber, setServerDefaultNumber] = useState<string | null>(null);
  const [repDefaultNumber, setRepDefaultNumber] = useState<string | null>(null);
  const [pickedNumber, setPickedNumber] = useState<string | null>(null);

  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [activeQueueId, setActiveQueueId] = useState<string | null>(null);
  const [current, setCurrent] = useState<Current | null>(null);

  const [callState, setCallStateRaw] = useState<CallState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [blockedDetail, setBlockedDetail] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [call, setCallRaw] = useState<CallRecord | null>(null);

  const [notes, setNotesRaw] = useState('');
  const [outcome, setOutcome] = useState<Disposition | null>(null);
  const [confirmOutcome, setConfirmOutcome] = useState<Disposition | null>(null);
  const [logStatus, setLogStatus] = useState<LogStatus | null>(null);

  const [manualDigits, setManualDigits] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  // Async handlers (Telnyx events, postMessage, timers) read these instead of stale render state.
  const stateRef = useRef<CallState>('idle');
  const callRef = useRef<CallRecord | null>(null);
  const notesRef = useRef('');
  const repRef = useRef('');
  const callerIdRef = useRef<string | null>(null);
  const phaseStartRef = useRef<number | null>(null);
  const endedRef = useRef(false);
  const notesTimer = useRef<number | null>(null);
  const confirmTimer = useRef<number | null>(null);
  const savedOutcomeRef = useRef<Disposition | null>(null); // outcome already on the server record (picked mid-call)
  const dialerPromise = useRef<Promise<Dialer> | null>(null);
  // Settled by the first FETCH_INIT: whether Telnyx runs in the extension or in this iframe.
  const dialerHost = useRef<{ promise: Promise<DialerHost>; resolve: (h: DialerHost) => void } | null>(null);
  if (!dialerHost.current) {
    let resolve!: (h: DialerHost) => void;
    dialerHost.current = { promise: new Promise<DialerHost>((r) => { resolve = r; }), resolve };
  }

  const setCallState = (s: CallState) => { stateRef.current = s; setCallStateRaw(s); };
  const setCall = (c: CallRecord | null) => { callRef.current = c; setCallRaw(c); };
  const setNotes = (v: string) => { notesRef.current = v; setNotesRaw(v); };
  const busy = () => stateRef.current === 'checking' || ACTIVE.includes(stateRef.current);

  /**
   * Calls always run in the extension's offscreen document. An extension too old to host the dialer
   * (its FETCH_INIT has no dialerHost) gets an error, never an in-iframe Telnyx client.
   * Connected as soon as FETCH_INIT arrives, instead of on first call.
   */
  const getDialer = (): Promise<Dialer> => {
    if (!dialerPromise.current) {
      const p = (async () => {
        if ((await dialerHost.current!.promise) !== 'extension') {
          throw new Error('This version of the Fetch extension is out of date and cannot place calls. Update the extension, then reload this tab.');
        }
        const d = new ExtensionDialer();
        try { await d.ready(); } catch (e) { d.destroy(); throw e; }
        setServerDefaultNumber((n) => n ?? (d.callerNumber || null));
        return d;
      })();
      p.catch(() => { if (dialerPromise.current === p) dialerPromise.current = null; }); // next dial retries
      dialerPromise.current = p;
    }
    return dialerPromise.current;
  };

  const loadStats = () => { api.statsToday(repRef.current || null).then(setStats).catch(() => { /* header stats are non-critical */ }); };

  /** Server-confirmed name/company for a Twenty record replaces whatever the page scraped. */
  const applyRecordInfo = (recordId: string, info: { name: string; company: string | null }) => {
    setCurrent((c) => (c?.twenty?.recordId === recordId ? { ...c, name: info.name, company: info.company } : c));
    setQueue((q) => q.map((it) => (it.twenty?.recordId === recordId ? { ...it, name: info.name, company: info.company } : it)));
  };

  /** Clears the previous call from the panel. Its record stays in the store (unlogged if no outcome was picked). */
  const resetCall = () => {
    // A notes autosave still waiting on its debounce belongs to the call being cleared: send it now.
    if (notesTimer.current) {
      window.clearTimeout(notesTimer.current);
      notesTimer.current = null;
      const prev = callRef.current;
      if (prev && !prev.loggedAt) api.saveNotes(prev.id, notesRef.current).catch(() => { /* the record stays unlogged; best effort */ });
    }
    if (callRef.current) setNotes(''); // notes typed before the first dial carry over; a finished call's do not
    if (confirmTimer.current) { window.clearTimeout(confirmTimer.current); confirmTimer.current = null; }
    setCall(null);
    endedRef.current = false;
    phaseStartRef.current = null;
    savedOutcomeRef.current = null;
    setError(null); setBlockedDetail([]); setOutcome(null); setConfirmOutcome(null); setLogStatus(null); setSeconds(0);
    setCallState('idle');
  };

  const scheduleNotesSave = () => {
    const cur = callRef.current;
    if (!cur || cur.loggedAt) return;
    if (notesTimer.current) window.clearTimeout(notesTimer.current);
    notesTimer.current = window.setTimeout(() => {
      notesTimer.current = null;
      api.saveNotes(cur.id, notesRef.current).catch((e) => setError(errMsg(e, 'Notes did not save — check your connection.')));
    }, 600);
  };

  /**
   * One request: the notes on screen + the outcome go with POST /log, which saves them onto the record
   * and then writes the note (or saves locally for a manual dial). Idempotent on the server.
   */
  const logCall = async (callId: string, disposition: Disposition | null) => {
    const stillCurrent = () => callRef.current?.id === callId;
    const notes = notesRef.current;
    setLogStatus({ state: 'logging', message: 'Logging…' });
    trace('log start', { callId, disposition, twentyContactId: callRef.current?.twentyContactId ?? null, notesLength: notes.length });
    try {
      if (notesTimer.current) { window.clearTimeout(notesTimer.current); notesTimer.current = null; } // superseded by the log request
      const r = await api.logCall(callId, { notes, disposition });
      trace('POST /log response', {
        callId,
        twentyNoteId: r.call.twentyNoteId,
        twentyContactId: r.call.twentyContactId,
        noContact: !!r.noContact,
        alreadyLogged: !!r.alreadyLogged,
        mock: !!r.mock,
        lastLogError: r.call.lastLogError,
        notesLength: r.call.notes?.length ?? 0,
      });
      loadStats();
      if (!stillCurrent()) return;
      setCall(r.call);
      const dnc = r.call.disposition === 'do_not_call' ? ' Number added to Do Not Call.' : '';
      if (r.noContact) {
        setLogStatus({ state: 'local', message: `Saved in Fetch. This number isn't a Twenty record, so no note was written.${dnc}` });
      } else if (r.call.twentyNoteId) {
        // Only a note id from the server counts as logged.
        setLogStatus({ state: 'logged', message: `Logged to Twenty ✓${r.mock ? ' (mock)' : ''}${dnc}` });
      } else {
        setLogStatus({ state: 'failed', message: 'The server did not confirm a Twenty note. Pick an outcome to retry.' });
      }
    } catch (e) {
      trace('log FAILED', { callId, error: errMsg(e, 'unknown'), status: (e as ApiError)?.status, code: (e as ApiError)?.code, body: (e as ApiError)?.body });
      if (stillCurrent()) setLogStatus({ state: 'failed', message: `${errMsg(e, 'Could not log the call.')} Pick an outcome to retry.` });
    }
  };

  const onDialEvent = async (e: DialEvent) => {
    const cur = callRef.current;
    if (!cur || endedRef.current) return;
    try {
      if (e.state === 'calling') {
        // The dialer's first "calling" is local (before Telnyx answers); one with a call id means it's ringing out.
        if (e.telnyxCallId && stateRef.current === 'dialing') {
          setCallState('ringing');
          await api.updateStatus(cur.id, { status: 'calling', telnyxCallId: e.telnyxCallId });
        }
      } else if (e.state === 'connected') {
        if (stateRef.current === 'connected') return;
        phaseStartRef.current = Date.now();
        setSeconds(0);
        setCallState('connected');
        const r = await api.updateStatus(cur.id, { status: 'connected', telnyxCallId: e.telnyxCallId, startedAt: new Date().toISOString() });
        if (!endedRef.current && callRef.current?.id === cur.id) setCall(r.call);
      } else if (e.state === 'ended' || e.state === 'failed') {
        endedRef.current = true;
        if (e.error) setError(e.error);
        const status = e.state === 'failed' ? 'failed' : e.neverConnected ? 'no-answer' : 'completed';
        setCallState('ended');
        const where = cur.twentyContactId ? 'log this call to Twenty' : 'save this call in Fetch';
        setLogStatus((s) => s ?? {
          state: 'pending',
          message: savedOutcomeRef.current ? `Outcome saved. Add notes, then ${where}.` : `Pick an outcome to ${where}.`,
        });
        // Pre-select the obvious outcome (same as the standalone app); nothing is logged until the rep clicks one.
        setOutcome((d) => d ?? (status === 'completed' ? 'connected' : status === 'no-answer' ? 'no_answer' : null));
        const r = await api.updateStatus(cur.id, { status, telnyxCallId: e.telnyxCallId ?? cur.telnyxCallId, endedAt: new Date().toISOString() });
        if (callRef.current?.id === cur.id) {
          setCall(r.call);
          if (r.call.startedAt && r.call.durationSeconds != null) setSeconds(r.call.durationSeconds);
        }
        loadStats();
      }
    } catch (err) {
      setError(err instanceof ApiError ? `Server update failed: ${err.message}` : 'Server update failed.');
    }
  };

  /** Server record (normalise + Guard, by record id) → Telnyx dial. Mirrors App.startCall. */
  const placeCall = async (target: Current) => {
    if (busy()) return;
    resetCall();
    setCurrent(target);
    setView('call');
    setCallState('checking');
    trace('POST /api/calls request', { twenty: target.twenty, phone: target.phone, repEmail: repRef.current || null });
    try {
      const r = await api.createCall({
        twenty: target.twenty,
        contactName: target.name || target.phone,
        phoneNumber: target.phone,
        sessionId,
        repEmail: repRef.current || null,
        callerId: callerIdRef.current,
      });
      trace('POST /api/calls response', { callId: r.call.id, twentyContactId: r.call.twentyContactId, twentyObjectType: r.call.twentyObjectType, contact: r.contact ?? null });
      setCall(r.call);
      if (r.contact && target.twenty) applyRecordInfo(target.twenty.recordId, r.contact);
      if (notesRef.current) scheduleNotesSave();
      phaseStartRef.current = Date.now();
      setCallState('dialing');
      const dialer = await getDialer();
      // Dial from the number the server accepted for this call, not whatever the picker shows now.
      await dialer.dial(r.call.phoneNumber, onDialEvent, r.call.callerId || undefined);
    } catch (e) {
      trace('POST /api/calls error', { error: errMsg(e, 'unknown'), status: (e as ApiError)?.status, code: (e as ApiError)?.code });
      if (e instanceof ApiError && e.code === 'BLOCKED') {
        const blocked: CallRecord | null = e.body.call ?? null;
        if (e.body.contact && target.twenty) applyRecordInfo(target.twenty.recordId, e.body.contact);
        setCall(blocked);
        setBlockedDetail(Array.isArray(e.body.detail) && e.body.detail.length ? e.body.detail : [e.message]);
        setCallState('blocked');
        if (blocked) logCall(blocked.id, null); // "Blocked by Fetch Guard: …" on the record (local-only for a manual dial)
        return;
      }
      setError(errMsg(e, 'Could not start the call.'));
      // If the dialer already reported the failure, the record is closed out and outcomes are available.
      if (!endedRef.current) { setCall(null); setCallState('idle'); }
    }
  };

  const onDialMessage = (phone: string, ref: EmbedContactRef | null) => {
    trace('FETCH_DIAL received', { phone, contact: ref });
    const twenty = ref ? { objectType: ref.objectType, recordId: ref.recordId } : null;
    const id = twenty ? `${twenty.objectType}:${twenty.recordId}:${phone}` : phone;
    const entry: QueueEntry = { id, name: ref?.name || formatPhone(phone), company: ref?.company || null, phone, twenty };
    setQueue((q) => (q.some((x) => x.id === id) ? q : [...q, entry]));
    if (busy()) return; // queued behind the current call
    setActiveQueueId(id);
    placeCall(toCurrent(entry));
  };

  const handleMessage = (m: ParentToEmbed) => {
    switch (m.type) {
      case 'FETCH_INIT':
        dialerHost.current!.resolve(m.dialerHost === 'extension' ? 'extension' : 'page'); // later INITs change nothing here
        repRef.current = String(m.repEmail || '').trim().toLowerCase();
        setRepDefaultNumber(typeof m.defaultCallerId === 'string' && m.defaultCallerId ? m.defaultCallerId : null);
        if (m.theme === 'light' || m.theme === 'dark') setTheme(m.theme);
        loadStats();
        break;
      case 'FETCH_THEME':
        if (m.theme === 'light' || m.theme === 'dark') setTheme(m.theme);
        break;
      case 'FETCH_OPEN':
        if (m.view === 'call' || m.view === 'manual') setView(m.view);
        break;
      case 'FETCH_DIAL':
        if (typeof m.phone === 'string' && m.phone) onDialMessage(m.phone, m.contact ?? null);
        break;
    }
  };
  const handlerRef = useRef(handleMessage);
  handlerRef.current = handleMessage;

  // Mount: listen, tell the extension we're ready (it queues messages until then), and connect
  // Telnyx once its FETCH_INIT says where the dialer lives.
  useEffect(() => {
    let cancelled = false;
    const off = onParentMessage((m) => handlerRef.current(m));
    sendToParent({ type: 'FETCH_READY' });
    api.telnyxNumbers().then(
      (r) => { if (!cancelled) { setNumbers(r.numbers); setServerDefaultNumber(r.defaultNumber); } },
      (e) => trace('caller ID list unavailable, using the server default', { error: errMsg(e, 'unknown') }),
    );
    dialerHost.current!.promise.then(() => {
      if (cancelled) return;
      getDialer().catch((e) => { if (!cancelled) setError(errMsg(e, 'Could not connect to Telnyx.')); });
    });
    return () => {
      cancelled = true;
      off();
      const p = dialerPromise.current;
      dialerPromise.current = null;
      p?.then((d) => d.destroy()).catch(() => { /* never connected */ });
    };
  }, []);

  // Timer: from dial start while dialing/ringing, from answer once connected.
  useEffect(() => {
    if (!ACTIVE.includes(callState)) return;
    const tick = () => setSeconds(phaseStartRef.current ? Math.floor((Date.now() - phaseStartRef.current) / 1000) : 0);
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [callState]);

  useEffect(() => {
    if (callState === 'dialing' || callState === 'ringing') startRingback(); else stopRingback();
    return () => stopRingback();
  }, [callState]);

  // The pill in Twenty mirrors this: every state change, and every second while a call is live.
  const contactName = current ? current.name || formatPhone(current.phone) : '';
  useEffect(() => {
    sendToParent({ type: 'FETCH_STATE', state: callState, seconds, contactName });
  }, [callState, seconds, contactName]);

  const onOutcome = (code: string) => {
    const cur = callRef.current;
    const d = code as Disposition;
    trace('outcome clicked', { code, callId: cur?.id ?? null, callState: stateRef.current });
    if (!cur) return;
    if (CONFIRM_FIRST.includes(d) && confirmOutcome !== d) {
      setConfirmOutcome(d);
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirmOutcome(null), 5000);
      return;
    }
    if (confirmTimer.current) { window.clearTimeout(confirmTimer.current); confirmTimer.current = null; }
    setConfirmOutcome(null);
    setOutcome(d);
    if (stateRef.current === 'ended' || stateRef.current === 'blocked') { logCall(cur.id, d); return; }
    // During the call: save the outcome on the record now (with the notes so far), so it survives even if
    // the rep never comes back to this call. The Twenty note is written once the call is over.
    savedOutcomeRef.current = null;
    api.setDisposition(cur.id, d, notesRef.current).then(
      (r) => { trace('disposition saved mid-call', { callId: cur.id, disposition: r.call.disposition }); if (callRef.current?.id === cur.id) savedOutcomeRef.current = d; },
      (e) => { if (callRef.current?.id === cur.id) setError(`The outcome did not save: ${errMsg(e, 'unknown error')}`); },
    );
  };

  const onSelectQueue = (item: QueueItem) => {
    if (busy()) return;
    const entry = queue.find((q) => q.id === item.id);
    if (!entry) return;
    resetCall();
    setActiveQueueId(entry.id);
    setCurrent(toCurrent(entry));
  };

  const onManualCall = () => {
    const digits = manualDigits.replace(/\D/g, '');
    const e164 = manualToE164(digits);
    if (!e164) {
      setManualError(digits ? 'Enter a 10-digit US number, or a full international number starting with its country code.' : 'Enter a number to call.');
      return;
    }
    if (busy()) { setManualError('Finish the current call first.'); return; }
    setManualError(null);
    setManualDigits('');
    setActiveQueueId(null);
    placeCall({ id: null, objectType: null, name: null, company: null, phone: e164, twenty: null });
  };

  // The rep's pick, else their saved default (if it's still on the account), else TELNYX_PHONE_NUMBER.
  const isOurs = (n: string | null) => !!n && numbers.some((x) => x.phoneNumber === n);
  const selectedNumber = (isOurs(pickedNumber) && pickedNumber) || (isOurs(repDefaultNumber) && repDefaultNumber) || serverDefaultNumber;
  callerIdRef.current = selectedNumber;
  const callerIdOptions: CallerIdOption[] = numbers.map((n) => ({
    value: n.phoneNumber,
    label: `${formatPhone(n.phoneNumber)}${n.phoneNumber === serverDefaultNumber ? ' (default)' : ''}`,
  }));
  // While a call is live the (locked) picker shows the number it was actually placed from.
  const shownCallerId = (ACTIVE.includes(callState) && call?.callerId) || selectedNumber;

  const logLocked = logStatus?.state === 'logging' || logStatus?.state === 'logged' || logStatus?.state === 'local';

  return (
    <EmbedDialer
      theme={theme}
      view={view}
      onViewChange={(v) => { setView(v); setManualError(null); }}
      onMinimize={() => sendToParent({ type: 'FETCH_MINIMIZE' })}
      stats={stats}
      queue={queue}
      activeQueueId={activeQueueId}
      onSelectQueue={onSelectQueue}
      contact={current}
      callerId={shownCallerId}
      callerIdOptions={callerIdOptions}
      onCallerIdChange={setPickedNumber}
      callState={callState}
      seconds={seconds}
      blockedDetail={blockedDetail}
      error={error}
      notes={notes}
      onNotesChange={(v) => { setNotes(v); scheduleNotesSave(); }}
      notesDisabled={logStatus?.state === 'logged' || logStatus?.state === 'local'}
      outcomes={OUTCOMES}
      outcome={outcome}
      onOutcome={onOutcome}
      outcomesDisabled={!call || callState === 'checking' || logLocked}
      confirmOutcome={confirmOutcome}
      logStatus={logStatus}
      onLogOutcome={outcome && logStatus?.state === 'pending' && call ? () => logCall(call.id, outcome) : undefined}
      onCall={() => { if (current) placeCall(current); }}
      onHangup={() => { dialerPromise.current?.then((d) => d.hangup()).catch(() => { /* nothing to hang up */ }); }}
      manualDigits={manualDigits}
      onManualDigitsChange={(d) => { setManualDigits(d); setManualError(null); }}
      onManualCall={onManualCall}
      manualError={manualError}
    />
  );
}
