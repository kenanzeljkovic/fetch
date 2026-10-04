export type CallStatus =
  | 'initiated'   // record created, browser is about to dial
  | 'calling'     // Telnyx call in progress, not yet answered
  | 'connected'   // remote party answered
  | 'completed'   // ended after being connected
  | 'no-answer'   // ended without ever connecting
  | 'failed'      // Telnyx / browser error
  | 'blocked';    // refused by Fetch Guard before dialing (audit record)

export type RecordingStatus =
  | 'recording'   // record_start accepted by Telnyx
  | 'saved'       // call.recording.saved received and the mp3 stored
  | 'failed';     // record_start refused, or the download failed

export type Disposition = 'connected' | 'no_answer' | 'voicemail' | 'busy' | 'wrong_number' | 'do_not_call' | 'other';

export const DISPOSITIONS: Disposition[] = ['connected', 'no_answer', 'voicemail', 'busy', 'wrong_number', 'do_not_call', 'other'];

export interface CallRecord {
  id: string;
  twentyContactId: string | null; // null for a manual dial with no linked Twenty contact     // source of truth for logging — never re-searched
  twentyObjectType: 'person' | 'company' | null; // which Twenty object twentyContactId points at (null = manual dial; older records: treat as person)
  contactName: string;
  phoneNumber: string;         // E.164
  callerId: string | null;     // the Telnyx number the call was placed from (null on records older than 0.4)
  telnyxCallId: string | null;
  status: CallStatus;
  disposition: Disposition | null;
  notes: string | null;
  startedAt: string | null;    // when the remote party answered (ISO)
  endedAt: string | null;
  durationSeconds: number | null;
  twentyNoteId: string | null; // set once logged; guards against duplicate logging
  loggedAt: string | null;
  lastLogError: string | null;
  sessionId: string | null;    // browser session that placed the call
  repEmail: string | null;     // who placed (or attempted) the call
  blockedReasons: string[] | null; // Guard reason codes when status === 'blocked'
  recordingStatus?: RecordingStatus | null; // null/absent = not recorded
  recordingUrl?: string | null;    // served path (/api/recordings/<id>.mp3), set once recording started
  createdAt: string;
  updatedAt: string;
}

export interface CallStore {
  create(input: Omit<CallRecord, 'createdAt' | 'updatedAt'>): Promise<CallRecord>;
  get(id: string): Promise<CallRecord | null>;
  update(id: string, patch: Partial<CallRecord>): Promise<CallRecord>;
  list(opts?: { limit?: number; unloggedOnly?: boolean }): Promise<CallRecord[]>;
  getSetting<T = unknown>(key: string): Promise<T | null>;
  setSetting<T = unknown>(key: string, value: T): Promise<void>;
}
