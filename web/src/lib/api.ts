export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  company: string | null;
  phoneRaw: string | null;
  phone: string | null;
  email: string | null;
  doNotCall: boolean;
  companyType: string | null;
  guard?: GuardResult;
}

export type GuardReason = 'DNC_INTERNAL' | 'DNC_CRM' | 'COMPANY_TYPE' | 'CALLING_HOURS' | 'REP_UNKNOWN';
export interface GuardResult { allowed: boolean; reasons: GuardReason[]; detail: string[]; timezone: string | null }

export interface GuardRules {
  dncList: string[];
  repPermissions: Record<string, { companyTypes: 'ALL' | string[] }>;
  defaultCompanyTypes: 'ALL' | string[];
  callingHours: { startHour: number; endHour: number; enabled: boolean };
  enforceCrmDnc: boolean;
}

export type CallStatus = 'initiated' | 'calling' | 'connected' | 'completed' | 'no-answer' | 'failed' | 'blocked';
export type Disposition = 'connected' | 'no_answer' | 'voicemail' | 'busy' | 'wrong_number' | 'do_not_call' | 'other';

export interface CallRecord {
  id: string;
  twentyContactId: string | null;
  twentyObjectType?: 'person' | 'company' | null;
  contactName: string;
  phoneNumber: string;
  callerId?: string | null;
  telnyxCallId: string | null;
  status: CallStatus;
  disposition: Disposition | null;
  notes?: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  twentyNoteId: string | null;
  loggedAt: string | null;
  lastLogError: string | null;
  repEmail: string | null;
  blockedReasons: string[] | null;
  createdAt: string;
}

export interface TelnyxNumber { phoneNumber: string; connectionName: string | null; onDialerConnection: boolean }

export interface Health {
  ok: boolean;
  mode: 'mock' | 'live';
  twenty: string;
  telnyx: string;
  store: string;
  callerNumber: string | null;
  problems: string[];
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code: string, public body: any = {}) { super(message); }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  } catch {
    throw new ApiError(0, 'Could not reach the Fetch server.', 'NETWORK');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error || res.statusText, json.code || 'ERROR', json);
  return json as T;
}

export const api = {
  health: () => req<Health>('/api/health'),
  contacts: (rep: string | null) => req<{ contacts: Contact[]; source: string }>(`/api/contacts${rep ? `?rep=${encodeURIComponent(rep)}` : ''}`),
  telnyxNumbers: () => req<{ defaultNumber: string; numbers: TelnyxNumber[] }>('/api/telnyx/numbers'),
  telnyxToken: () => req<{ token?: string; callerNumber: string; mock?: boolean }>('/api/telnyx/token', { method: 'POST' }),
  createCall: (body: {
    twentyContactId?: string | null;
    /** Embed: the exact Twenty record the call was placed from. The server re-reads it by id. */
    twenty?: { objectType: 'person' | 'company'; recordId: string } | null;
    contactName: string; phoneNumber: string | null; sessionId: string; repEmail: string | null;
    /** Caller ID for this call only; omitted = TELNYX_PHONE_NUMBER. */
    callerId?: string | null;
  }) =>
    req<{ call: CallRecord; guard?: GuardResult; contact?: { name: string; company: string | null } }>('/api/calls', { method: 'POST', body: JSON.stringify(body) }),
  guardRules: () => req<{ rules: GuardRules }>('/api/guard/rules'),
  saveGuardRules: (patch: Partial<GuardRules>) => req<{ rules: GuardRules }>('/api/guard/rules', { method: 'PUT', body: JSON.stringify(patch) }),
  addDnc: (phoneNumber: string) => req<{ rules: GuardRules }>('/api/guard/dnc', { method: 'POST', body: JSON.stringify({ phoneNumber }) }),
  updateStatus: (id: string, body: { status: CallStatus; telnyxCallId?: string | null; startedAt?: string; endedAt?: string }) =>
    req<{ call: CallRecord }>(`/api/calls/${id}/status`, { method: 'POST', body: JSON.stringify(body) }),
  setDisposition: (id: string, disposition: Disposition) =>
    req<{ call: CallRecord; addedToDnc?: boolean }>(`/api/calls/${id}/disposition`, { method: 'POST', body: JSON.stringify({ disposition }) }),
  saveNotes: (id: string, notes: string) =>
    req<{ call: CallRecord }>(`/api/calls/${id}/notes`, { method: 'POST', body: JSON.stringify({ notes }) }),
  logCall: (id: string) => req<{ call: CallRecord; alreadyLogged?: boolean; mock?: boolean; noContact?: boolean; message?: string }>(`/api/calls/${id}/log`, { method: 'POST' }),
  unloggedCalls: () => req<{ calls: CallRecord[] }>('/api/calls?unlogged=true'),
  statsToday: (rep: string | null) =>
    req<{ callsToday: number; connects: number; talkSeconds: number }>(`/api/stats/today${rep ? `?rep=${encodeURIComponent(rep)}` : ''}`),
};

// Storage can throw inside a third-party iframe (the Twenty embed) when the browser blocks
// third-party storage, so neither of these may take the app down at import time.
export const sessionId = (() => {
  const key = 'fetch.sessionId';
  try {
    let v = sessionStorage.getItem(key);
    if (!v) { v = crypto.randomUUID(); sessionStorage.setItem(key, v); }
    return v;
  } catch {
    return crypto.randomUUID();
  }
})();

export const repStore = {
  get: () => { try { return localStorage.getItem('fetch.repEmail') || ''; } catch { return ''; } },
  set: (v: string) => { try { localStorage.setItem('fetch.repEmail', v.trim().toLowerCase()); } catch { /* storage blocked */ } },
};

/** The rep's default caller ID in the standalone app (the extension keeps its own in chrome.storage.sync). */
export const callerIdStore = {
  get: () => { try { return localStorage.getItem('fetch.callerId') || ''; } catch { return ''; } },
  set: (v: string) => { try { localStorage.setItem('fetch.callerId', v); } catch { /* storage blocked */ } },
};
