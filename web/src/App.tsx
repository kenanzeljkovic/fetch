import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, callerIdStore, repStore, sessionId, type CallRecord, type Contact, type Disposition, type Health, type TelnyxNumber } from './lib/api';
import { MockDialer, TelnyxDialer, type DialEvent, type DialState, type Dialer } from './lib/dialer';
import { Banner } from './components/Banner';
import { ContactList } from './components/ContactList';
import { ContactCard } from './components/ContactCard';
import { CallPanel } from './components/CallPanel';
import { PendingCalls } from './components/PendingCalls';
import { Keypad } from './components/Keypad';
import { startRingback, stopRingback } from './lib/tones';


export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [rep, setRep] = useState<string>(repStore.get());
  const [numbers, setNumbers] = useState<TelnyxNumber[]>([]);
  const [defaultNumber, setDefaultNumber] = useState<string | null>(null);
  const [callerId, setCallerId] = useState<string>(callerIdStore.get());

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [selected, setSelected] = useState<Contact | null>(null);

  const dialerRef = useRef<Dialer | null>(null);
  const [dialState, setDialState] = useState<DialState>('idle');
  const [call, setCall] = useState<CallRecord | null>(null);
  const callRef = useRef<CallRecord | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  const [disposition, setDisposition] = useState<Disposition | null>(null);
  const [notes, setNotesState] = useState('');
  const [manualNumber, setManualNumber] = useState('');
  const [notesError, setNotesError] = useState<string | null>(null);
  const isManualDial = !!call && call.twentyContactId == null;
  const notesSaveTimer = useRef<number | null>(null);
  const [logging, setLogging] = useState(false);
  const [logged, setLogged] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  const [pending, setPending] = useState<CallRecord[]>([]);

  const setCallBoth = (c: CallRecord | null) => { callRef.current = c; setCall(c); };

  const loadHealth = useCallback(async () => {
    try { setHealth(await api.health()); setHealthError(null); }
    catch (e) { setHealthError(e instanceof ApiError ? e.message : 'Could not reach the Fetch server.'); }
  }, []);

  const loadContacts = useCallback(async () => {
    setLoadingContacts(true); setContactsError(null);
    try {
      const list = (await api.contacts(rep || null)).contacts;
      setContacts(list);
      // keep the selected contact's guard result fresh (rep or rules may have changed)
      setSelected((cur) => (cur ? list.find((c) => c.id === cur.id) ?? cur : cur));
    }
    catch (e) { setContacts([]); setContactsError(e instanceof ApiError ? e.message : 'Could not load contacts.'); }
    finally { setLoadingContacts(false); }
  }, [rep]);

  const loadPending = useCallback(async () => {
    try { setPending((await api.unloggedCalls()).calls.filter((c) => c.id !== callRef.current?.id)); } catch { /* non-critical */ }
  }, []);

  useEffect(() => { loadHealth(); loadContacts(); loadPending(); }, [loadHealth, loadContacts, loadPending]);
  useEffect(() => {
    api.telnyxNumbers().then((r) => { setNumbers(r.numbers); setDefaultNumber(r.defaultNumber); }).catch(() => { /* picker hidden; server default is used */ });
  }, []);
  // The saved pick only counts while it is still an active number on the account.
  const fromNumber = numbers.some((n) => n.phoneNumber === callerId) ? callerId : defaultNumber;
  useEffect(() => () => dialerRef.current?.destroy(), []);

  // Ringback tone while dialing — Telnyx doesn't always send early media before the
  // call connects, so without this the rep would hear silence during "Calling…".
  useEffect(() => {
    if (dialState === 'calling') startRingback(); else stopRingback();
    return () => stopRingback();
  }, [dialState]);

  /** Lazily create the dialer (real or mock) — fetches a Telnyx JWT from the server on first use. */
  const getDialer = async (): Promise<Dialer> => {
    if (dialerRef.current) return dialerRef.current;
    const t = await api.telnyxToken();
    const d: Dialer = t.mock ? new MockDialer() : new TelnyxDialer(t.token!, t.callerNumber);
    dialerRef.current = d;
    return d;
  };

  const handleDialEvent = async (e: DialEvent) => {
    const cur = callRef.current;
    setDialState(e.state);
    if (e.error) setCallError(e.error);
    if (!cur) return;
    try {
      if (e.state === 'calling') {
        await api.updateStatus(cur.id, { status: 'calling', telnyxCallId: e.telnyxCallId });
      } else if (e.state === 'connected') {
        const { call } = await api.updateStatus(cur.id, { status: 'connected', telnyxCallId: e.telnyxCallId, startedAt: new Date().toISOString() });
        setCallBoth(call);
      } else if (e.state === 'ended' || e.state === 'failed') {
        const status = e.state === 'failed' ? 'failed' : e.neverConnected ? 'no-answer' : 'completed';
        const { call } = await api.updateStatus(cur.id, { status, telnyxCallId: e.telnyxCallId ?? cur.telnyxCallId, endedAt: new Date().toISOString() });
        setCallBoth(call);
        // Pre-select an obvious disposition; the rep can still change it
        setDisposition((d) => d ?? (status === 'completed' ? 'connected' : status === 'no-answer' ? 'no_answer' : null));
      }
    } catch (err) {
      setCallError(err instanceof ApiError ? `Server update failed: ${err.message}` : 'Server update failed.');
    }
  };

  const startCall = async (contactId: string | null, contactName: string, phoneRaw: string | null) => {
    setCallError(null); setLogError(null); setLogged(false); setDisposition(null); setNotesState(''); setNotesError(null); setCallBoth(null); setLoggedNote(null);
    setDialState('connecting');
    try {
      // 1. Create the server-side record first (normalises the number, refuses if invalid)
      const { call } = await api.createCall({ twentyContactId: contactId, contactName, phoneNumber: phoneRaw, sessionId, repEmail: rep || null, callerId: fromNumber });
      setCallBoth(call);
      // 2. Dial through Telnyx from the browser, from the caller ID the server accepted
      const dialer = await getDialer();
      await dialer.dial(call.phoneNumber, handleDialEvent, call.callerId || undefined);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BLOCKED') {
        // Guard refused it server-side; the attempt is already stored as an audit record
        setCallBoth(e.body.call ?? null);
        setCallError(e.message);
        setDialState('blocked');
        return;
      }
      const msg = e instanceof ApiError ? e.message : (e as Error).message || 'Could not start the call.';
      setCallError(msg);
      setDialState('failed'); // always surface the error — a call record may not exist yet to key off
    }
  };

  const callSelected = () => { if (selected) startCall(selected.id, selected.name, selected.phoneRaw); };
  const callManualNumber = () => startCall(null, manualNumber, manualNumber);

  const hangup = async () => { await dialerRef.current?.hangup(); };

  const onNotesChange = (value: string) => {
    setNotesState(value);
    const cur = callRef.current;
    if (!cur) return;
    if (notesSaveTimer.current) window.clearTimeout(notesSaveTimer.current);
    setNotesError(null);
    notesSaveTimer.current = window.setTimeout(() => {
      api.saveNotes(cur.id, value)
        .then(() => setNotesError(null))
        .catch((e) => setNotesError(e instanceof ApiError ? e.message : 'Notes did not save — check your connection and try again.'));
    }, 600);
  };

  const chooseDisposition = async (d: Disposition) => {
    if (!call) return;
    setDisposition(d); setLogError(null);
    try { const r = await api.setDisposition(call.id, d, notes); setCallBoth(r.call); }
    catch (e) { setLogError(e instanceof ApiError ? e.message : 'Could not save the disposition.'); }
  };

  const [loggedNote, setLoggedNote] = useState<string | null>(null);

  const logCall = async () => {
    if (!call) return;
    setLogging(true); setLogError(null);
    try {
      // The notes and outcome on screen travel with the log request, so a pending or failed
      // autosave can't leave the Twenty note without them.
      if (notesSaveTimer.current) { window.clearTimeout(notesSaveTimer.current); notesSaveTimer.current = null; }
      const r = await api.logCall(call.id, { notes, disposition });
      setCallBoth(r.call);
      if (!r.noContact && !r.call.twentyNoteId) throw new Error('The server did not confirm a Twenty note. Try again.');
      setLogged(true);
      setLoggedNote(r.noContact ? 'No Twenty contact linked — saved locally only' : null);
      loadPending();
      if (disposition === 'do_not_call') loadContacts();
    } catch (e) {
      setLogError(e instanceof ApiError ? e.message : 'Call completed, but the activity could not be logged to Twenty.');
    } finally { setLogging(false); }
  };

  const newCall = () => { setDialState('idle'); setCallBoth(null); setDisposition(null); setNotesState(''); setNotesError(null); setManualNumber(''); setLogged(false); setLogError(null); setCallError(null); setLoggedNote(null); };

  const busy = dialState === 'connecting' || dialState === 'calling' || dialState === 'connected';
  const showCallPanel = dialState !== 'idle';

  return (
    <div className="mx-auto max-w-4xl p-6" style={{ background: "#F3EEE7", minHeight: "100vh" }}>
      <header className="flex items-center justify-between pb-4 mb-4" style={{ borderBottom: '1px solid var(--fetch-line)' }}>
        <img src="/fetch-logo.png" alt="Fetch" className="h-9 w-auto" />
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-neutral-600">
            Rep
            <input
              type="email"
              value={rep}
              placeholder="you@company.com"
              onChange={(e) => setRep(e.target.value)}
              onBlur={() => { repStore.set(rep); loadContacts(); }}
              className="h-8 w-44 rounded-md px-2.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2" style={{ border: '1px solid var(--fetch-line)', background: '#fff' }}
            />
          </label>
          {numbers.length > 1 && (
            <label className="flex items-center gap-1.5 text-xs text-neutral-600">
              Call from
              <select
                value={fromNumber ?? ''}
                disabled={busy}
                onChange={(e) => { setCallerId(e.target.value); callerIdStore.set(e.target.value); }}
                className="h-8 rounded-md px-2 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50" style={{ border: '1px solid var(--fetch-line)', background: '#fff' }}
              >
                {numbers.map((n) => <option key={n.phoneNumber} value={n.phoneNumber}>{n.phoneNumber}{n.phoneNumber === defaultNumber ? ' (default)' : ''}</option>)}
              </select>
            </label>
          )}
          {health?.mode === 'mock' && <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide" style={{ background: '#FDECC8', color: '#7A5A12' }}>MOCK MODE</span>}
          <button type="button" onClick={loadContacts} disabled={loadingContacts || busy} className="h-8 rounded-md px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 hover:bg-black/5 active:bg-black/10" style={{ border: '1px solid var(--fetch-line)', background: '#fff', color: 'var(--fetch-ink)' }}>
            {loadingContacts ? 'Refreshing…' : 'Refresh Contacts'}
          </button>
        </div>
      </header>

      <div className="mt-4 space-y-2">
        {healthError && <Banner kind="error">{healthError}</Banner>}
        {health && health.problems.length > 0 && <Banner kind="warn">Server is missing configuration: {health.problems.join(', ')}. Calls will fail until fixed.</Banner>}
        {health?.mode === 'mock' && <Banner kind="info">Mock mode: contacts are fake and calls are simulated. Set MOCK_MODE=false with real credentials for live calling.</Banner>}
        {contactsError && <Banner kind="error">Twenty error: {contactsError}</Banner>}
      </div>

      <main className="mt-6 grid gap-6 md:grid-cols-[1fr_1.3fr]">
        <div className="space-y-6">
          <section className="rounded-lg p-4" style={{ background: 'var(--fetch-panel, #fff)', border: '1px solid var(--fetch-line)', boxShadow: '0 1px 2px rgba(43,29,20,0.04), 0 8px 24px -14px rgba(43,29,20,0.14)' }}>
            <div className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--fetch-muted)' }}>Contacts {health && `· ${health.mode === 'mock' ? 'mock' : 'Twenty'}`}</div>
            <div className="mt-2">
              <ContactList contacts={contacts} selectedId={selected?.id ?? null} onSelect={(c) => { if (!busy) { setSelected(c); if (!busy && dialState !== 'idle' && (logged || !call)) newCall(); } }} disabled={busy} />
            </div>
          </section>

          <section className="rounded-lg p-4" style={{ background: 'var(--fetch-panel, #fff)', border: '1px solid var(--fetch-line)', boxShadow: '0 1px 2px rgba(43,29,20,0.04), 0 8px 24px -14px rgba(43,29,20,0.14)' }}>
            <div className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--fetch-muted)' }}>Dial a number</div>
            <p className="mt-1 text-xs" style={{ color: 'var(--fetch-muted)' }}>For a number that isn't a Twenty contact. Guard's DNC and calling-hours rules still apply; there's just no CRM record to log to.</p>
            <div className="mt-3">
              <Keypad value={manualNumber} onChange={setManualNumber} onCall={callManualNumber} disabled={busy} />
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-lg p-4" style={{ background: 'var(--fetch-panel, #fff)', border: '1px solid var(--fetch-line)', boxShadow: '0 1px 2px rgba(43,29,20,0.04), 0 8px 24px -14px rgba(43,29,20,0.14)' }}>
            <div className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--fetch-muted)' }}>Contact</div>
            <div className="mt-2">
              <ContactCard contact={selected} onCall={callSelected} callDisabled={busy || (showCallPanel && !logged && dialState !== 'failed' && dialState !== 'blocked')} />
            </div>
          </section>

          {showCallPanel && (
            <section className="rounded-lg p-4" style={{ background: 'var(--fetch-panel, #fff)', border: '1px solid var(--fetch-line)', boxShadow: '0 1px 2px rgba(43,29,20,0.04), 0 8px 24px -14px rgba(43,29,20,0.14)' }}>
              <div className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--fetch-muted)' }}>Call status</div>
              <div className="mt-2">
                <CallPanel
                  dialState={dialState} call={call} error={callError} onHangup={hangup}
                  notes={notes} onNotesChange={onNotesChange} notesError={notesError}
                  disposition={disposition} onDisposition={chooseDisposition}
                  onLog={logCall} logging={logging} logged={logged} logError={logError}
                  loggedNote={loggedNote}
                />
                {(logged || dialState === 'blocked' || (dialState === 'failed' && !call)) && (
                  <button type="button" onClick={newCall} className="mt-3 text-sm text-neutral-600 underline">Start another call</button>
                )}
              </div>
            </section>
          )}

          <PendingCalls calls={pending} onChanged={loadPending} />
        </div>
      </main>
    </div>
  );
}
