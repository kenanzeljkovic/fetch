import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config, validateConfig } from './config';
import { HttpError } from './lib/errors';
import { healthRouter } from './routes/health';
import { contactsRouter } from './routes/contacts';
import { telnyxRouter } from './routes/telnyx';
import { callsRouter } from './routes/calls';
import { guardRouter } from './routes/guard';
import { statsRouter } from './routes/stats';
import { recordingsRouter } from './routes/recordings';
import { embedHeaders } from './middleware/embedHeaders';
import { storeKind } from './store';

const app = express();
app.set('trust proxy', true);
// rawBody is kept for Telnyx webhook signature checks.
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
app.use(cors({ origin: config.corsOrigins }));
// The only frame policy: lets Twenty (EMBED_ALLOWED_ORIGINS) frame the app for the extension's dock.
app.use(embedHeaders(process.env.EMBED_ALLOWED_ORIGINS));
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'microphone=*');
  next();
});

app.use(healthRouter);
app.use(contactsRouter);
app.use(telnyxRouter);
app.use(callsRouter);
app.use(guardRouter);
app.use(statsRouter);
app.use(recordingsRouter);

// In production the server also serves the built frontend (web/dist).
const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code ?? 'ERROR' });
  }
  console.error(err);
  res.status(500).json({ error: (err as Error)?.message || 'Unexpected server error', code: 'INTERNAL' });
});

const problems = validateConfig();
app.listen(config.port, () => {
  console.log(`Fetch server on http://localhost:${config.port}  mode=${config.mockMode ? 'MOCK' : 'live'}  store=${storeKind()}`);
  if (config.recordingEnabled && !config.telnyx.publicKey) console.warn('[config] ENABLE_CALL_RECORDING is on without TELNYX_PUBLIC_KEY: Telnyx webhooks are not signature-checked');
  if (problems.length) console.warn(`[config] missing or invalid: ${problems.join(', ')} — live calls will fail until fixed`);
});
