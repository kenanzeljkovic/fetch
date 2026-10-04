/**
 * Call recording (ENABLE_CALL_RECORDING=true).
 *
 *   1. The dialer reports the call connected with its Telnyx call control id
 *      → POST /v2/calls/{call_control_id}/actions/record_start { format: mp3, channels: single, client_state }
 *      client_state carries our call id so the webhook can find the record without searching.
 *   2. After hang-up Telnyx sends call.recording.saved to POST /api/webhooks/telnyx with a short-lived
 *      download URL → the file is saved to <DATA_DIR>/recordings/<callId>.mp3 and served at
 *      /api/recordings/<callId>.mp3.
 *
 * Recording can't start at POST /api/calls: the browser places the Telnyx call after that, and Telnyx
 * only records an answered call.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { HttpError } from '../lib/errors';
import { telnyxFetch } from './telnyx';

export const recordingsDir = () => path.join(config.dataDir, 'recordings');
export const recordingFile = (callId: string) => path.join(recordingsDir(), `${callId}.mp3`);
/** Served path; the call id is a random UUID, so the URL is unguessable but not otherwise protected. */
export const recordingPath = (callId: string) => `/api/recordings/${callId}.mp3`;

const MAX_BYTES = 200 * 1024 * 1024;

export async function startRecording(callControlId: string, callId: string): Promise<void> {
  const res = await telnyxFetch(`/calls/${encodeURIComponent(callControlId)}/actions/record_start`, {
    method: 'POST',
    body: JSON.stringify({ format: 'mp3', channels: 'single', client_state: Buffer.from(callId).toString('base64') }),
  });
  if (!res.ok) {
    const json: any = await res.json().catch(() => ({}));
    const detail = json?.errors?.map((e: any) => e.detail || e.title).join('; ') || res.statusText;
    throw new HttpError(502, `Telnyx would not start recording (${res.status}): ${detail}`, 'TELNYX_RECORDING');
  }
}

/** Telnyx's download links are pre-signed S3 URLs. Without signature checks, nothing else is fetched. */
function allowedDownload(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (/\.amazonaws\.com$/i.test(u.hostname) || /(^|\.)telnyx\.com$/i.test(u.hostname));
  } catch {
    return false;
  }
}

export async function downloadRecording(url: string, callId: string): Promise<void> {
  if (!config.telnyx.publicKey && !allowedDownload(url)) {
    throw new HttpError(400, 'Recording URL is not a Telnyx download link.', 'BAD_RECORDING_URL');
  }
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(502, `Could not download the recording (${res.status}).`, 'RECORDING_DOWNLOAD');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new HttpError(502, 'Recording is too large.', 'RECORDING_DOWNLOAD');
  await fs.mkdir(recordingsDir(), { recursive: true });
  const tmp = `${recordingFile(callId)}.part`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, recordingFile(callId));
}

/**
 * Telnyx signs webhooks with Ed25519 over `${timestamp}|${rawBody}` (headers telnyx-signature-ed25519,
 * telnyx-timestamp). The public key is in the portal (Keys & Credentials → Public Key) → TELNYX_PUBLIC_KEY.
 */
export function verifyWebhook(rawBody: Buffer | undefined, signature: string | undefined, timestamp: string | undefined): boolean {
  if (!config.telnyx.publicKey) return true; // not configured: callers apply the narrower checks instead
  if (!rawBody || !signature || !timestamp) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const raw = Buffer.from(config.telnyx.publicKey, 'base64');
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.concat([Buffer.from(`${timestamp}|`), rawBody]), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
