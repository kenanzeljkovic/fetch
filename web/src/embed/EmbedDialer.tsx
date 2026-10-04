/**
 * EmbedDialer — the panel from the mockups (queue · active call · notes · outcome · manual keypad).
 * Wired to the app by EmbedApp.tsx.
 *
 * Purely presentational: every piece of state and every action comes in as a prop, so it wires
 * onto the existing calling/Guard/logging hooks without touching them. Nothing here talks to
 * Telnyx or the API.
 */
import React, { useEffect, useRef } from 'react';
import './embed.css';

export type CallState = 'idle' | 'checking' | 'blocked' | 'dialing' | 'ringing' | 'connected' | 'ended';

export interface QueueItem { id: string; name: string; company?: string | null; phone: string; }
export interface EmbedContact {
  id?: string | null;
  objectType?: 'person' | 'company' | null;
  name?: string | null;
  company?: string | null;
  phone: string;
}
export interface Outcome { code: string; label: string; }
export interface CallerIdOption { value: string; label: string; }
export interface Stats { callsToday: number; connects: number; talkSeconds: number; }
export interface LogStatus { state: 'pending' | 'logging' | 'logged' | 'local' | 'failed'; message: string; }

export interface EmbedDialerProps {
  theme: 'light' | 'dark';
  view: 'call' | 'manual';
  onViewChange: (view: 'call' | 'manual') => void;
  onMinimize: () => void;

  stats: Stats;

  queue: QueueItem[];
  activeQueueId?: string | null;
  onSelectQueue: (item: QueueItem) => void;

  contact: EmbedContact | null;
  callerId?: string | null;                // the number this call is (or will be) placed from
  callerIdOptions?: CallerIdOption[];      // empty/omitted = no picker, just show callerId
  onCallerIdChange?: (value: string) => void;
  callState: CallState;
  seconds: number;
  blockedDetail?: string[];
  error?: string | null;                   // call could not be placed / Telnyx or mic failure

  notes: string;
  onNotesChange: (notes: string) => void;
  notesDisabled?: boolean;
  outcomes: Outcome[];
  outcome: string | null;
  onOutcome: (code: string) => void;
  outcomesDisabled?: boolean;
  confirmOutcome?: string | null;          // outcome waiting for its confirming second click
  logStatus?: LogStatus | null;

  onCall: () => void;
  onHangup: () => void;
  onToggleMute?: () => void;
  muted?: boolean;

  manualDigits: string;                    // raw digits, e.g. "813555"
  onManualDigitsChange: (digits: string) => void;
  onManualCall: () => void;
  manualError?: string | null;
}

const KEYS: Array<[string, string]> = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];

const STATUS_LABEL: Record<CallState, string> = {
  idle: 'Ready',
  checking: 'Checking with Guard',
  blocked: 'Blocked',
  dialing: 'Dialing',
  ringing: 'Ringing',
  connected: 'Connected',
  ended: 'Call ended',
};

export function formatPhone(value: string): string {
  const d = (value || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return value || '';
}

/** "(813) 555-12__" while typing a US number; raw digits with a leading + otherwise. */
export function formatDialInput(digits: string): string {
  const d = digits.replace(/\D/g, '');
  if (d.length > 10) return '+' + d;
  const pad = (s: string, n: number) => s + '_'.repeat(Math.max(0, n - s.length));
  return `(${pad(d.slice(0, 3), 3)}) ${pad(d.slice(3, 6), 3)}-${pad(d.slice(6, 10), 4)}`;
}

export function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTalk(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function initials(name?: string | null): string {
  const parts = (name || '').split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0].toUpperCase()).join('') || '#';
}

function Logo() {
  return (
    <svg className="fd-logo" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="#F26A1E" />
      <rect x="5" y="9" width="2.4" height="6" rx="1.2" fill="#fff" />
      <rect x="9.2" y="6" width="2.4" height="12" rx="1.2" fill="#fff" />
      <rect x="13.4" y="8" width="2.4" height="8" rx="1.2" fill="#fff" />
      <rect x="17.6" y="10" width="2.4" height="4" rx="1.2" fill="#fff" />
    </svg>
  );
}

export default function EmbedDialer(p: EmbedDialerProps) {
  const active = p.callState === 'dialing' || p.callState === 'ringing' || p.callState === 'connected';

  return (
    <div className="fd" data-theme={p.theme}>
      <header className="fd-head">
        <div className="fd-brand">
          <Logo />
          <span>Fetch dialer</span>
        </div>
        <div className="fd-stats">
          <div className="fd-stat"><span className="fd-stat-label">Calls today</span><span className="fd-stat-value">{p.stats.callsToday}</span></div>
          <div className="fd-stat"><span className="fd-stat-label">Connects</span><span className="fd-stat-value">{p.stats.connects}</span></div>
          <div className="fd-stat"><span className="fd-stat-label">Talk time</span><span className="fd-stat-value">{formatTalk(p.stats.talkSeconds)}</span></div>
        </div>
        <div className="fd-head-actions">
          <button
            type="button"
            className="fd-btn fd-btn-quiet fd-btn-sm"
            onClick={() => p.onViewChange(p.view === 'manual' ? 'call' : 'manual')}
          >
            {p.view === 'manual' ? 'Back to queue' : 'Dial a number'}
          </button>
          <button type="button" className="fd-iconbtn" aria-label="Minimize" title="Minimize" onClick={p.onMinimize}>–</button>
        </div>
      </header>

      {p.view === 'manual' ? <ManualDial {...p} /> : <CallView {...p} active={active} />}
    </div>
  );
}

/* ------------------------------------------------------------------ call view */

function CallView(p: EmbedDialerProps & { active: boolean }) {
  const next = p.queue.find((q) => q.id !== p.activeQueueId);
  const c = p.contact;

  return (
    <div className="fd-body">
      <aside className="fd-queue" aria-label="Queue">
        <div className="fd-section-title">Queue</div>
        {p.queue.length === 0 ? (
          <div className="fd-queue-empty">Click a phone number in Twenty to add a call here.</div>
        ) : (
          <ul className="fd-queue-list">
            {p.queue.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="fd-queue-item"
                  data-active={item.id === p.activeQueueId ? '1' : '0'}
                  onClick={() => p.onSelectQueue(item)}
                  disabled={p.active}
                  title={p.active ? 'Finish the current call first' : `${item.name} · ${formatPhone(item.phone)}`}
                >
                  <span className="fd-queue-avatar">{initials(item.name)}</span>
                  <span className="fd-queue-name">{item.name}</span>
                  {item.id === p.activeQueueId && <span className="fd-queue-dot" aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="fd-main">
        {!c ? (
          <div className="fd-main-empty">
            <div className="fd-main-empty-title">No one on the line</div>
            <div className="fd-muted">Click a phone number in Twenty, or dial one yourself.</div>
            <button type="button" className="fd-btn fd-btn-primary" onClick={() => p.onViewChange('manual')}>Dial a number</button>
          </div>
        ) : (
          <>
            <div className="fd-who">
              <div className="fd-avatar">{initials(c.name)}</div>
              <div className="fd-who-text">
                <div className="fd-name">{c.name || formatPhone(c.phone)}</div>
                <div className="fd-sub">{c.company || (c.name ? formatPhone(c.phone) : 'Not a Twenty contact')}</div>
              </div>
              <div className="fd-timer">
                <div className="fd-clock">{formatTimer(p.seconds)}</div>
                <div className="fd-status" data-state={p.callState}><i aria-hidden="true" />{STATUS_LABEL[p.callState]}</div>
              </div>
            </div>

            {p.error && p.callState !== 'blocked' && <div className="fd-error fd-error-block" role="alert">{p.error}</div>}

            {p.callState === 'blocked' && (
              <div className="fd-blocked" role="alert">
                <div className="fd-blocked-title">Fetch Guard refused this call</div>
                {(p.blockedDetail || []).map((d, i) => <div key={i}>{d}</div>)}
              </div>
            )}

            <label className="fd-label" htmlFor="fd-notes">Notes</label>
            <textarea
              id="fd-notes"
              className="fd-notes"
              placeholder="What did they say? This is logged to the contact in Twenty."
              value={p.notes}
              disabled={p.notesDisabled}
              onChange={(e) => p.onNotesChange(e.target.value)}
            />

            <div className="fd-label">Outcome</div>
            <div className="fd-outcomes" role="group" aria-label="Call outcome">
              {p.outcomes.map((o) => (
                <button
                  key={o.code}
                  type="button"
                  className="fd-chip"
                  data-on={p.outcome === o.code || p.confirmOutcome === o.code ? '1' : '0'}
                  data-confirm={p.confirmOutcome === o.code ? '1' : '0'}
                  aria-pressed={p.outcome === o.code}
                  disabled={p.outcomesDisabled}
                  onClick={() => p.onOutcome(o.code)}
                >
                  {p.confirmOutcome === o.code ? `Click again: ${o.label}` : o.label}
                </button>
              ))}
            </div>
            {p.logStatus && (
              <div className="fd-logstatus" data-state={p.logStatus.state} role={p.logStatus.state === 'failed' ? 'alert' : 'status'}>
                {p.logStatus.message}
              </div>
            )}

            <CallerIdPicker {...p} locked={p.active || p.callState === 'checking'} />

            <div className="fd-foot">
              <div className="fd-upnext">
                {next ? (<>Up next <b>{next.name}</b>{next.company ? <span className="fd-muted"> · {next.company}</span> : null}</>) : <span className="fd-muted">Queue is empty</span>}
              </div>
              <div className="fd-actions">
                {p.active ? (
                  <>
                    {p.onToggleMute && (
                      <button type="button" className="fd-btn fd-btn-quiet" aria-pressed={!!p.muted} onClick={p.onToggleMute}>
                        {p.muted ? 'Unmute' : 'Mute'}
                      </button>
                    )}
                    <button type="button" className="fd-btn fd-btn-danger" onClick={p.onHangup}>Hang up</button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="fd-btn fd-btn-primary"
                    onClick={p.onCall}
                    disabled={p.callState === 'checking'}
                  >
                    {p.callState === 'ended' ? 'Call again' : p.callState === 'checking' ? 'Checking…' : 'Call'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ caller ID */

/** Small "Call from" picker above the Call button. Locked while a call is live: it shows the number in use. */
function CallerIdPicker(p: EmbedDialerProps & { locked: boolean }) {
  const options = p.callerIdOptions || [];
  const canPick = !p.locked && options.length > 1 && !!p.onCallerIdChange;
  return (
    <div className="fd-callerpick">
      <label className="fd-callerid" htmlFor={canPick ? 'fd-callerid-select' : undefined}>
        Call from
        {canPick ? (
          <select id="fd-callerid-select" value={p.callerId || ''} onChange={(e) => p.onCallerIdChange!(e.target.value)}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <span>{p.callerId ? formatPhone(p.callerId) : '—'}</span>
        )}
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------ manual dial */

function ManualDial(p: EmbedDialerProps) {
  const digits = p.manualDigits.replace(/\D/g, '');
  const valid = digits.length === 10 || (digits.length === 11 && digits[0] === '1') || digits.length >= 8 && digits.length <= 15;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const press = (k: string) => {
    if (k === '*' || k === '#') return;
    if (k === '0' && digits.length === 0) return;      // leading zero is never a US number
    if (digits.length >= 15) return;
    p.onManualDigitsChange(digits + k);
  };
  const backspace = () => p.onManualDigitsChange(digits.slice(0, -1));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (/^\d$/.test(e.key)) { press(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace') { backspace(); e.preventDefault(); }
    else if (e.key === 'Enter' && valid) { p.onManualCall(); e.preventDefault(); }
  };

  return (
    <div className="fd-manual" ref={ref} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="fd-label">Dial a number</div>
      <div className="fd-dialrow">
        <div className="fd-dialnum" aria-live="polite">{formatDialInput(digits)}</div>
        <button type="button" className="fd-iconbtn" aria-label="Delete last digit" onClick={backspace} disabled={!digits}>⌫</button>
      </div>

      <div className="fd-keypad">
        {KEYS.map(([k, letters]) => (
          <button key={k} type="button" className="fd-key" onClick={() => press(k)} aria-label={letters ? `${k} ${letters}` : k}>
            <span className="fd-key-num">{k}</span>
            <span className="fd-key-sub">{letters || '\u00a0'}</span>
          </button>
        ))}
      </div>

      {p.manualError && <div className="fd-error" role="alert">{p.manualError}</div>}

      <CallerIdPicker {...p} locked={p.callState === 'checking' || p.callState === 'dialing' || p.callState === 'ringing' || p.callState === 'connected'} />

      <button type="button" className="fd-btn fd-btn-primary fd-wide" disabled={!valid} onClick={p.onManualCall}>
        Call this number
      </button>
      <div className="fd-guardnote"><i aria-hidden="true" />Guard checks DNC and calling hours before dialing</div>
    </div>
  );
}
