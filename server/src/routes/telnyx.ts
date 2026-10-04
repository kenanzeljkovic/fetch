import { Router } from 'express';
import { config, telnyxConfigured } from '../config';
import { callerIdOptions, createLoginToken } from '../services/telnyx';
import { HttpError } from '../lib/errors';

export const telnyxRouter = Router();

/**
 * Hands the browser a short-lived Telnyx JWT plus the caller number.
 * No secret ever leaves the server. In mock mode the browser simulates calls instead.
 */
telnyxRouter.post('/api/telnyx/token', async (_req, res, next) => {
  try {
    if (config.mockMode) return res.json({ mock: true, callerNumber: '+10000000000' });
    if (!telnyxConfigured()) throw new HttpError(503, 'Telnyx is not configured (TELNYX_API_KEY / TELNYX_CONNECTION_ID / TELNYX_PHONE_NUMBER).', 'TELNYX_NOT_CONFIGURED');
    const token = await createLoginToken();
    res.json({ token, callerNumber: config.telnyx.phoneNumber, expiresInSeconds: 24 * 3600 });
  } catch (e) { next(e); }
});

/**
 * Caller ID choices for the extension's options page, the dock, and the web app:
 * every active number on the Telnyx account. defaultNumber is TELNYX_PHONE_NUMBER.
 */
telnyxRouter.get('/api/telnyx/numbers', async (_req, res, next) => {
  try {
    if (!config.mockMode && !config.telnyx.apiKey) throw new HttpError(503, 'Telnyx is not configured (TELNYX_API_KEY).', 'TELNYX_NOT_CONFIGURED');
    const { numbers, defaultNumber } = await callerIdOptions();
    res.json({
      defaultNumber,
      numbers: numbers.map((n) => ({
        phoneNumber: n.phoneNumber,
        connectionName: n.connectionName,
        // Numbers on another connection can still be presented as caller ID, but flag it for the rep.
        onDialerConnection: config.mockMode || n.connectionId === config.telnyx.connectionId,
      })),
    });
  } catch (e) { next(e); }
});
