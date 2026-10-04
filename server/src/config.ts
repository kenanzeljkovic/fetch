import path from 'node:path';
import dotenv from 'dotenv';

// Load .env from the repo root first, then server/.env as an override, regardless of cwd
// (npm workspaces run scripts with server/ as the working directory).
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const env = process.env;
const strip = (s: string) => s.replace(/\/$/, '');

export const config = {
  port: Number(env.PORT) || 4000,
  mockMode: env.MOCK_MODE === 'true',
  corsOrigins: (env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  twenty: {
    url: strip(env.TWENTY_API_URL || 'https://api.twenty.com'),
    apiKey: env.TWENTY_API_KEY || '',
  },
  telnyx: {
    apiKey: env.TELNYX_API_KEY || '',
    connectionId: env.TELNYX_CONNECTION_ID || '',
    phoneNumber: env.TELNYX_PHONE_NUMBER || '',
    credentialId: env.TELNYX_CREDENTIAL_ID || '',
    publicKey: env.TELNYX_PUBLIC_KEY || '', // verifies webhook signatures (Portal → Keys & Credentials → Public Key)
    apiBase: strip(env.TELNYX_API_BASE || 'https://api.telnyx.com/v2'), // override only for tests
  },
  databaseUrl: env.DATABASE_URL || '',
  // Calls/settings JSON and call recordings. On Railway point this at the volume's mount path.
  dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.resolve(__dirname, '..', 'data'),
  recordingEnabled: env.ENABLE_CALL_RECORDING === 'true',
  /** Public origin of this server, for recording links in Twenty notes. Empty = taken from the request. */
  publicUrl: strip(env.PUBLIC_URL || ''),
};

export const twentyConfigured = () => Boolean(config.twenty.url && config.twenty.apiKey);
export const telnyxConfigured = () =>
  Boolean(config.telnyx.apiKey && config.telnyx.connectionId && config.telnyx.phoneNumber);

/** Fail fast on a misconfigured live deployment; mock mode needs nothing. */
export function validateConfig(): string[] {
  if (config.mockMode) return [];
  const problems: string[] = [];
  if (!twentyConfigured()) problems.push('TWENTY_API_URL / TWENTY_API_KEY');
  if (!config.telnyx.apiKey) problems.push('TELNYX_API_KEY');
  if (!config.telnyx.connectionId) problems.push('TELNYX_CONNECTION_ID');
  if (!/^\+[1-9]\d{7,14}$/.test(config.telnyx.phoneNumber)) problems.push('TELNYX_PHONE_NUMBER (must be E.164, e.g. +18135551234)');
  return problems;
}
