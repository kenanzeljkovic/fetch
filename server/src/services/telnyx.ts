/**
 * Telnyx integration (server side only — the browser never sees TELNYX_API_KEY).
 *
 * Browser calling uses Telnyx's WebRTC JS SDK (@telnyx/webrtc) authenticated with a
 * short-lived JWT. The JWT chain, per Telnyx's current docs:
 *   1. A *Credential* SIP Connection exists in the portal  -> TELNYX_CONNECTION_ID
 *   2. POST /v2/telephony_credentials { connection_id, name } -> credential id (one per user)
 *   3. POST /v2/telephony_credentials/{id}/token             -> JWT, valid 24h
 * The browser then does `new TelnyxRTC({ login_token })` and `client.newCall(...)`.
 */
import { config } from '../config';
import { HttpError } from '../lib/errors';

export async function telnyxFetch(path: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(`${config.telnyx.apiBase}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${config.telnyx.apiKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
  } catch (e: any) {
    throw new HttpError(502, `Could not reach Telnyx: ${e.message}`, 'TELNYX_UNREACHABLE');
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(401, 'Telnyx rejected the API key. Check TELNYX_API_KEY.', 'TELNYX_AUTH');
  return res;
}

let cachedCredentialId: string | null = config.telnyx.credentialId || null;

/** Returns a telephony credential ID for this connection, creating one if needed. */
export async function ensureCredential(): Promise<string> {
  if (cachedCredentialId) return cachedCredentialId;
  const res = await telnyxFetch('/telephony_credentials', {
    method: 'POST',
    body: JSON.stringify({ connection_id: config.telnyx.connectionId, name: `fetch-${Date.now()}` }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.data?.id) {
    const detail = json?.errors?.map((e: any) => e.detail || e.title).join('; ') || res.statusText;
    throw new HttpError(502, `Telnyx could not create a telephony credential: ${detail}`, 'TELNYX_CREDENTIAL');
  }
  cachedCredentialId = json.data.id;
  console.log(`[telnyx] created telephony credential ${cachedCredentialId} — set TELNYX_CREDENTIAL_ID=${cachedCredentialId} in .env to reuse it`);
  return cachedCredentialId!;
}

/** Mints a 24h JWT for the browser SDK. */
export async function createLoginToken(): Promise<string> {
  const credId = await ensureCredential();
  const res = await telnyxFetch(`/telephony_credentials/${credId}/token`, { method: 'POST' });
  const text = await res.text();
  if (!res.ok) {
    // A stale credential ID (e.g. deleted in the portal) — drop the cache so the next call recreates it.
    if (res.status === 404) cachedCredentialId = null;
    throw new HttpError(502, `Telnyx could not mint a login token (${res.status}): ${text.slice(0, 200)}`, 'TELNYX_TOKEN');
  }
  // The token endpoint returns the JWT as plain text; some clients wrap it in JSON.
  try { const j = JSON.parse(text); return j?.data?.token ?? j?.token ?? text; } catch { return text.trim(); }
}

export interface TelnyxNumber {
  phoneNumber: string;            // E.164
  connectionId: string | null;
  connectionName: string | null;
  tags: string[];
}

const NUMBERS_TTL_MS = 60_000;
let numbersCache: { at: number; numbers: TelnyxNumber[] } | null = null;

/**
 * Active numbers on the Telnyx account — the only numbers a rep may pick as caller ID.
 * Cached for a minute: the options page, every dock, and every POST /api/calls read it.
 */
export async function listPhoneNumbers(): Promise<TelnyxNumber[]> {
  if (numbersCache && Date.now() - numbersCache.at < NUMBERS_TTL_MS) return numbersCache.numbers;
  const res = await telnyxFetch('/phone_numbers?filter[status]=active&page[size]=250');
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.errors?.map((e: any) => e.detail || e.title).join('; ') || res.statusText;
    throw new HttpError(502, `Telnyx could not list phone numbers: ${detail}`, 'TELNYX_NUMBERS');
  }
  const numbers: TelnyxNumber[] = (Array.isArray(json?.data) ? json.data : [])
    .filter((n: any) => typeof n?.phone_number === 'string')
    .map((n: any) => ({
      phoneNumber: n.phone_number,
      connectionId: n.connection_id ? String(n.connection_id) : null,
      connectionName: n.connection_name ?? null,
      tags: Array.isArray(n.tags) ? n.tags : [],
    }));
  numbersCache = { at: Date.now(), numbers };
  return numbers;
}

// MOCK MODE — fake numbers so the caller ID picker can be clicked through without credentials.
const MOCK_NUMBERS: TelnyxNumber[] = [
  { phoneNumber: '+10000000000', connectionId: 'mock', connectionName: 'Mock connection', tags: [] },
  { phoneNumber: '+10000000001', connectionId: 'mock', connectionName: 'Mock connection', tags: [] },
];

/** Numbers a rep may use as caller ID, plus the server default (TELNYX_PHONE_NUMBER). */
export async function callerIdOptions(): Promise<{ numbers: TelnyxNumber[]; defaultNumber: string }> {
  if (config.mockMode) return { numbers: MOCK_NUMBERS, defaultNumber: MOCK_NUMBERS[0].phoneNumber };
  return { numbers: await listPhoneNumbers(), defaultNumber: config.telnyx.phoneNumber };
}

/**
 * The caller ID for one call: the rep's pick if it is an active number on this Telnyx account,
 * otherwise TELNYX_PHONE_NUMBER. A number that isn't ours is refused rather than silently swapped,
 * so the rep never believes they called from a number they didn't.
 */
export async function resolveCallerId(requested: unknown): Promise<string> {
  const { numbers, defaultNumber } = await callerIdOptions();
  if (requested == null || requested === '' || requested === defaultNumber) return defaultNumber;
  if (typeof requested !== 'string' || !numbers.some((n) => n.phoneNumber === requested)) {
    throw new HttpError(400, `${String(requested)} is not an active number on this Telnyx account, so it can't be used as caller ID.`, 'INVALID_CALLER_ID');
  }
  return requested;
}
