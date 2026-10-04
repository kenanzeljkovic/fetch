import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { getStore, DISPOSITIONS, CallRecord, CallStatus, Disposition } from '../store';
import { formatForDisplay, isE164, toE164 } from '../lib/phone';
import { HttpError } from '../lib/errors';
import { Contact, getContact, logCallNote, MOCK_CONTACTS } from '../services/twenty';
import { addToDnc, checkCall } from '../services/guard';
import { resolveCallerId } from '../services/telnyx';

export const callsRouter = Router();

/** [fetch:log] trace for the call -> note flow in Railway logs. Never logs note text; phones only by last 4. */
const trace = (step: string, data: Record<string, unknown>) => console.log(`[fetch:log] ${step} ${JSON.stringify(data)}`);
const last4 = (p: string | null | undefined) => (p ? `…${String(p).slice(-4)}` : null);

const STATUSES: CallStatus[] = ['initiated', 'calling', 'connected', 'completed', 'no-answer', 'failed'];
const MAX_NOTES = 4000;

/**
 * Optional { notes, disposition } carried on /disposition and /log, so the outcome and the notes the
 * rep sees are saved in the same request that uses them — never left to an earlier autosave that may
 * have failed. Absent fields leave the record as it is.
 */
function outcomePatch(body: any): Partial<CallRecord> {
  const patch: Partial<CallRecord> = {};
  if (body?.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string') throw new HttpError(400, 'notes must be a string.', 'BAD_REQUEST');
    patch.notes = body.notes ? body.notes.slice(0, MAX_NOTES) : '';
  }
  if (body?.disposition !== undefined && body.disposition !== null) {
    if (!DISPOSITIONS.includes(body.disposition)) throw new HttpError(400, `disposition must be one of ${DISPOSITIONS.join(', ')}`, 'BAD_REQUEST');
    patch.disposition = body.disposition as Disposition;
  }
  return patch;
}

/**
 * Embed calls name the exact Twenty record they were placed from: { objectType, recordId }.
 * The record is re-read by id — never searched — and it is the only place the note can go.
 * Tonight only people are supported; company pages are refused before anything is stored.
 */
async function resolveTwentyRecord(twenty: unknown, e164: string): Promise<Contact> {
  const t = twenty as { objectType?: unknown; recordId?: unknown };
  if (!t || typeof t !== 'object' || typeof t.recordId !== 'string' || !t.recordId) {
    throw new HttpError(400, 'twenty must be { objectType, recordId }.', 'BAD_REQUEST');
  }
  if (t.objectType === 'company') {
    throw new HttpError(422, "Calls from a company record aren't supported yet. Open the person's record in Twenty and call from there.", 'COMPANY_NOT_SUPPORTED');
  }
  if (t.objectType !== 'person') throw new HttpError(400, 'twenty.objectType must be "person".', 'BAD_REQUEST');

  let contact: Contact | undefined;
  try {
    contact = config.mockMode ? MOCK_CONTACTS.find((m) => m.id === t.recordId) : await getContact(t.recordId);
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 404)) throw e;
  }
  if (!contact) throw new HttpError(404, `No person with id ${t.recordId} exists in Twenty, so the call was not placed.`, 'CONTACT_NOT_FOUND');
  if (!contact.phones.includes(e164)) {
    throw new HttpError(409, `${formatForDisplay(e164)} is not one of ${contact.name}'s phone numbers in Twenty, so the call was not placed.`, 'PHONE_MISMATCH');
  }
  return contact;
}

/** Create a call record before dialing. Normalises the number; refuses to proceed if it can't. */
callsRouter.post('/api/calls', async (req, res, next) => {
  try {
    const { twentyContactId, contactName, phoneNumber, sessionId, repEmail, twenty, callerId } = req.body ?? {};
    if (twenty != null && twentyContactId != null) throw new HttpError(400, 'Send either twenty or twentyContactId, not both.', 'BAD_REQUEST');
    // twentyContactId is optional — a manual dial (typed on the keypad) has no CRM contact behind it.
    if (twentyContactId != null && typeof twentyContactId !== 'string') throw new HttpError(400, 'twentyContactId must be a string.', 'BAD_REQUEST');
    if (!phoneNumber) throw new HttpError(400, 'Enter a phone number to call.', 'NO_PHONE');
    const e164 = toE164(phoneNumber);
    if (!e164 || !isE164(e164)) throw new HttpError(400, `"${phoneNumber}" is not a valid phone number, so the call was not placed.`, 'INVALID_PHONE');

    // Caller ID for this call only: the rep's pick if it's an active number on the account, else TELNYX_PHONE_NUMBER.
    const fromNumber = await resolveCallerId(callerId);

    // Fetch Guard: re-read the contact from the source of truth (never trust the browser's copy).
    // Manual dials have no CRM record, so only the phone-based rules (internal DNC, calling hours) apply.
    trace('POST /api/calls', { twenty: twenty ?? null, twentyContactId: twentyContactId ?? null, phone: last4(e164), callerId: last4(fromNumber), repEmail: repEmail ?? null });
    const record = twenty != null ? await resolveTwentyRecord(twenty, e164) : null;
    trace('POST /api/calls record', { resolved: record ? record.id : null, name: record?.name ?? null });
    const contact = record
      ? record
      : !twentyContactId
      ? { doNotCall: false, companyType: null }
      : config.mockMode
      ? MOCK_CONTACTS.find((m) => m.id === twentyContactId) ?? { doNotCall: false, companyType: null }
      : await getContact(twentyContactId);
    const guard = await checkCall({ repEmail: repEmail ?? null, phoneNumber: e164, contact });

    const base = {
      id: randomUUID(),
      twentyContactId: record ? record.id : twentyContactId || null,
      twentyObjectType: record || twentyContactId ? ('person' as const) : null,
      contactName: record ? record.name : String(contactName || '').trim() || (twentyContactId ? '(no name)' : e164),
      phoneNumber: e164,
      callerId: fromNumber,
      telnyxCallId: null,
      disposition: null,
      notes: null,
      startedAt: null,
      endedAt: null,
      durationSeconds: null,
      twentyNoteId: null,
      loggedAt: null,
      lastLogError: null,
      sessionId: sessionId ?? null,
      repEmail: repEmail ?? null,
    };

    // Authoritative display values for the embed, straight from the Twenty record.
    const recordInfo = record ? { name: record.name, company: record.company } : undefined;

    if (!guard.allowed) {
      // Refused server-side. The attempt itself is stored — that is the audit trail.
      const blocked = await getStore().create({ ...base, status: 'blocked', blockedReasons: guard.reasons, endedAt: new Date().toISOString() });
      return res.status(403).json({ error: guard.detail.join(' '), code: 'BLOCKED', reasons: guard.reasons, detail: guard.detail, call: blocked, contact: recordInfo });
    }

    const rec = await getStore().create({ ...base, status: 'initiated', blockedReasons: null });
    res.status(201).json({ call: rec, guard, contact: recordInfo });
  } catch (e) { next(e); }
});

callsRouter.get('/api/calls', async (req, res, next) => {
  try {
    const unloggedOnly = req.query.unlogged === 'true';
    res.json({ calls: await getStore().list({ limit: 50, unloggedOnly }) });
  } catch (e) { next(e); }
});

callsRouter.get('/api/calls/:id', async (req, res, next) => {
  try {
    const call = await getStore().get(req.params.id);
    if (!call) throw new HttpError(404, 'Call not found.', 'CALL_NOT_FOUND');
    res.json({ call });
  } catch (e) { next(e); }
});

/** The browser reports lifecycle transitions here (calling -> connected -> completed / no-answer / failed). */
callsRouter.post('/api/calls/:id/status', async (req, res, next) => {
  try {
    const { status, telnyxCallId, startedAt, endedAt } = req.body ?? {};
    if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`, 'BAD_REQUEST');
    const store = getStore();
    const cur = await store.get(req.params.id);
    if (!cur) throw new HttpError(404, 'Call not found.', 'CALL_NOT_FOUND');

    const patch: Record<string, unknown> = { status };
    if (telnyxCallId) patch.telnyxCallId = String(telnyxCallId);
    if (startedAt) patch.startedAt = new Date(startedAt).toISOString();
    if (endedAt) patch.endedAt = new Date(endedAt).toISOString();
    const started = (patch.startedAt as string) ?? cur.startedAt;
    const ended = (patch.endedAt as string) ?? cur.endedAt;
    if (started && ended) patch.durationSeconds = Math.max(0, Math.round((new Date(ended).getTime() - new Date(started).getTime()) / 1000));
    if (!started && ended) patch.durationSeconds = 0;

    res.json({ call: await store.update(cur.id, patch) });
  } catch (e) { next(e); }
});

/** Free-text notes, saved independently so they persist as the rep types, before disposition/logging. */
callsRouter.post('/api/calls/:id/notes', async (req, res, next) => {
  try {
    const store = getStore();
    const cur = await store.get(req.params.id);
    if (!cur) throw new HttpError(404, 'Call not found.', 'CALL_NOT_FOUND');
    if (cur.twentyNoteId) throw new HttpError(409, 'This call is already logged to Twenty; notes can no longer be changed.', 'ALREADY_LOGGED');
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, MAX_NOTES) : '';
    res.json({ call: await store.update(cur.id, { notes }) });
  } catch (e) { next(e); }
});

/** Body { disposition, notes? }. Allowed during the call too, so an outcome picked mid-call is never lost. */
callsRouter.post('/api/calls/:id/disposition', async (req, res, next) => {
  try {
    const { disposition } = req.body ?? {};
    if (!DISPOSITIONS.includes(disposition)) throw new HttpError(400, `disposition must be one of ${DISPOSITIONS.join(', ')}`, 'BAD_REQUEST');
    const patch = outcomePatch(req.body);
    const store = getStore();
    const cur = await store.get(req.params.id);
    if (!cur) throw new HttpError(404, 'Call not found.', 'CALL_NOT_FOUND');
    if (cur.twentyNoteId) throw new HttpError(409, 'This call is already logged to Twenty; its disposition can no longer be changed.', 'ALREADY_LOGGED');
    if (cur.status === 'blocked') throw new HttpError(409, 'A call blocked by Fetch Guard has no outcome.', 'BLOCKED');
    const call = await store.update(cur.id, patch);
    trace('POST /disposition saved', { callId: cur.id, disposition: call.disposition, notesLength: call.notes?.length ?? 0 });
    // "Do Not Call" is a compliance event, not just a label: the number goes on the internal DNC list immediately.
    if (disposition === 'do_not_call') await addToDnc(cur.phoneNumber);
    res.json({ call, addedToDnc: disposition === 'do_not_call' });
  } catch (e) { next(e); }
});

/**
 * Write the call to Twenty as a Note on the ORIGINAL contact ID.
 * Idempotent: a second call returns the existing note instead of creating a duplicate.
 * On failure the record keeps everything needed to retry (and stores the error).
 * Body (optional): { notes, disposition } — saved onto the record first, so the note carries exactly
 * what the rep had on screen when they logged.
 */
callsRouter.post('/api/calls/:id/log', async (req, res, next) => {
  try {
    const store = getStore();
    const patch = outcomePatch(req.body);
    let cur = await store.get(req.params.id);
    if (!cur) throw new HttpError(404, 'Call not found.', 'CALL_NOT_FOUND');
    if (!cur.twentyNoteId && cur.status === 'blocked') delete patch.disposition; // a blocked attempt is logged as such
    if (!cur.twentyNoteId && Object.keys(patch).length) {
      const wasDnc = cur.disposition === 'do_not_call';
      cur = await store.update(cur.id, patch);
      // Same compliance side effect as POST /disposition.
      if (!wasDnc && cur.disposition === 'do_not_call') await addToDnc(cur.phoneNumber);
    }
    trace('POST /log start', {
      callId: cur.id, status: cur.status, disposition: cur.disposition, twentyObjectType: cur.twentyObjectType,
      twentyContactId: cur.twentyContactId, notesLength: cur.notes?.length ?? 0, twentyNoteId: cur.twentyNoteId,
    });
    if (cur.twentyNoteId) return res.json({ call: cur, alreadyLogged: true, message: 'Already logged to Twenty.' });
    if (['initiated', 'calling', 'connected'].includes(cur.status)) throw new HttpError(409, 'The call has not ended yet.', 'CALL_ACTIVE');
    // A Guard-blocked attempt has no disposition; it is logged as "Blocked by Fetch Guard".
    if (!cur.disposition && cur.status !== 'blocked') throw new HttpError(400, 'Pick a disposition before logging the call.', 'NO_DISPOSITION');

    // Manual dial with no Twenty contact behind it — nothing to write to the CRM, so just
    // mark the call closed out locally. Still real work: it clears the Unlogged Calls list
    // and keeps the audit trail (disposition, notes, duration) in Fetch's own store.
    if (!cur.twentyContactId) {
      trace('POST /log no Twenty record, saved in Fetch only', { callId: cur.id });
      const call = await store.update(cur.id, { loggedAt: new Date().toISOString(), lastLogError: null });
      return res.json({ call, noContact: true, message: 'No Twenty contact linked — saved locally only.' });
    }

    if (config.mockMode) {
      const call = await store.update(cur.id, { twentyNoteId: `mock-note-${cur.id.slice(0, 8)}`, loggedAt: new Date().toISOString(), lastLogError: null });
      return res.json({ call, mock: true });
    }

    try {
      const noteId = await logCallNote({
        target: { objectType: cur.twentyObjectType ?? 'person', recordId: cur.twentyContactId },
        contactName: cur.contactName,
        phoneNumber: cur.phoneNumber,
        callerId: cur.callerId || config.telnyx.phoneNumber || null,
        repEmail: cur.repEmail,
        durationSeconds: cur.durationSeconds ?? 0,
        disposition: cur.disposition,
        blockedReasons: cur.status === 'blocked' ? cur.blockedReasons : null,
        notes: cur.notes,
        telnyxCallId: cur.telnyxCallId,
        date: new Date(cur.endedAt ?? cur.createdAt),
      });
      trace('POST /log Twenty note created', { callId: cur.id, noteId, target: `${cur.twentyObjectType ?? 'person'} ${cur.twentyContactId}` });
      const call = await store.update(cur.id, { twentyNoteId: noteId, loggedAt: new Date().toISOString(), lastLogError: null });
      res.json({ call });
    } catch (e: any) {
      console.error(`[fetch:log] POST /log Twenty FAILED ${JSON.stringify({ callId: cur.id, status: e.status ?? null, code: e.code ?? null, error: e.message })}`);
      await store.update(cur.id, { lastLogError: e.message });
      throw new HttpError(e.status && e.status !== 404 ? e.status : 502, `Call completed, but the activity could not be logged to Twenty. ${e.message}`, 'TWENTY_LOG_FAILED');
    }
  } catch (e) { next(e); }
});
