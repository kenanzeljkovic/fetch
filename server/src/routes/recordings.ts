import { Router } from 'express';
import fs from 'node:fs';
import { getStore } from '../store';
import { downloadRecording, recordingFile, recordingPath, verifyWebhook } from '../services/recording';

export const recordingsRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Telnyx Call Control webhooks. Only call.recording.saved is acted on; everything else is acknowledged.
 * Point the connection's webhook URL at https://<fetch>/api/webhooks/telnyx in the Telnyx portal.
 * Always 200 once parsed, so Telnyx doesn't retry events we chose to ignore.
 */
recordingsRouter.post('/api/webhooks/telnyx', async (req, res) => {
  if (!verifyWebhook((req as any).rawBody, req.get('telnyx-signature-ed25519'), req.get('telnyx-timestamp'))) {
    console.warn('[fetch:rec] webhook rejected: bad signature');
    return res.status(401).json({ error: 'Invalid signature.', code: 'BAD_SIGNATURE' });
  }
  const event = req.body?.data;
  const type: string = event?.event_type || '';
  if (type !== 'call.recording.saved' && type !== 'recording.saved') return res.json({ ok: true, ignored: type || 'unknown' });

  const p = event.payload || {};
  let callId = '';
  try { callId = Buffer.from(String(p.client_state || ''), 'base64').toString('utf8'); } catch { /* not ours */ }
  const store = getStore();
  const call = UUID.test(callId) ? await store.get(callId) : null;
  // The record must be one we started recording, on this same Telnyx call — client_state alone isn't trusted.
  if (!call || call.telnyxCallId !== p.call_control_id) {
    console.warn(`[fetch:rec] recording.saved for an unknown call ${JSON.stringify({ callId: callId.slice(0, 36), callControlId: p.call_control_id ?? null })}`);
    return res.json({ ok: true, ignored: 'unknown call' });
  }
  if (call.recordingStatus === 'saved') return res.json({ ok: true, alreadySaved: true });

  const url: string | undefined = p.recording_urls?.mp3 || p.public_recording_urls?.mp3;
  try {
    if (!url) throw new Error('payload has no mp3 URL');
    await downloadRecording(url, call.id);
    await store.update(call.id, { recordingStatus: 'saved', recordingUrl: recordingPath(call.id) });
    console.log(`[fetch:rec] recording saved ${JSON.stringify({ callId: call.id })}`);
    res.json({ ok: true });
  } catch (e: any) {
    console.error(`[fetch:rec] recording download FAILED ${JSON.stringify({ callId: call.id, error: e.message })}`);
    await store.update(call.id, { recordingStatus: 'failed' });
    res.status(502).json({ error: e.message, code: 'RECORDING_DOWNLOAD' }); // non-2xx: Telnyx retries with a fresh URL
  }
});

/** The stored mp3. Linked from the Twenty note. */
recordingsRouter.get('/api/recordings/:file', (req, res) => {
  const m = req.params.file.match(/^(.+)\.mp3$/);
  if (!m || !UUID.test(m[1])) return res.status(404).json({ error: 'Recording not found.', code: 'NOT_FOUND' });
  const file = recordingFile(m[1].toLowerCase());
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Recording not found (it may still be processing).', code: 'NOT_FOUND' });
  res.type('audio/mpeg').sendFile(file);
});
