# Fetch

**Version 0.3.2** — see [CHANGELOG.md](./CHANGELOG.md) for what changed each release.

Fetch is a browser-based sales dialer for teams that run their pipeline in **Twenty CRM** and place calls over **Telnyx**. A rep picks a Twenty contact (or types a number), Fetch checks the call against its compliance rules, dials it from the browser over WebRTC, and writes the outcome back to that exact contact in Twenty as a note.

```
Twenty CRM ──contacts──▶ Fetch ──WebRTC──▶ Telnyx ──▶ PSTN
    ▲                      │
    └───call note──────────┘
```

Fetch runs in two places:

- **The Fetch web app** — a standalone dialer page: contact list, manual keypad, call panel, dispositions, and unlogged-call recovery.
- **The Chrome extension** — brings Fetch into Twenty itself: "Call with Fetch" tags on phone numbers, a floating dock with the dialer, and automatic logging to the record you called from.

What it does:

- **Click-to-call** from a Twenty contact or a manually dialed number, with DTMF and ringback tones.
- **Fetch Guard** — every call is checked server-side before dialing: internal DNC list, Twenty's `doNotCall` flag, per-rep Company Type permissions, and local calling hours. Refused calls are stored as an audit trail.
- **Dispositions and notes**, logged to Twenty as a note on the contact's timeline. Logging is idempotent and retryable if Twenty is unreachable.
- **Server-side Telnyx credentials** — the browser only ever gets a short-lived JWT.

---

## Project structure

```
fetch/
├── package.json            npm workspaces (server + web), root scripts
├── .env.example            every variable you need, with where to find it
├── Dockerfile              single-container deploy (server serves the built web app)
├── CHANGELOG.md
├── docs/                   design notes (Fetch Guard vs. Watchdog)
├── server/                 Node 20 + TypeScript + Express
│   ├── src/index.ts        app entry: routes, static hosting, error handler
│   ├── src/config.ts       env loading + validation
│   ├── src/routes/         health, contacts, telnyx (JWT), calls (lifecycle + logging), guard (rules), stats
│   ├── src/middleware/embedHeaders.ts   frame-ancestors policy so Twenty may frame the app
│   ├── src/services/twenty.ts   Twenty REST client + note logging (+ isolated mock data)
│   ├── src/services/guard.ts    Fetch Guard: DNC, calling hours, per-rep Company Type permissions
│   ├── src/services/telnyx.ts   telephony credential + JWT minting (server-side only)
│   ├── src/store/          CallStore interface, JSON-file store, PostgreSQL store
│   ├── src/lib/phone.ts    E.164 normalisation
│   ├── db/schema.sql       PostgreSQL schema (optional)
│   └── scripts/migrate.js  applies schema.sql to DATABASE_URL
├── web/                    React 18 + TypeScript + Vite + Tailwind
│   ├── src/App.tsx         the standalone dialer: contacts → call → disposition → log
│   ├── src/lib/api.ts      typed client for the Fetch backend
│   ├── src/lib/dialer.ts   TelnyxDialer (real, @telnyx/webrtc) and MockDialer (mock mode)
│   ├── src/components/     ContactList, ContactCard, CallPanel, Keypad, PendingCalls, Banner
│   ├── src/embed/          the dialer panel rendered inside the extension's dock (/?embed=1)
│   ├── src/offscreen/      the extension's offscreen dialer, built into extension/offscreen.js
│   └── vite.offscreen.config.ts   build config for that bundle
└── extension/              Chrome extension (Manifest V3)
    ├── manifest.json
    ├── content.js          record detection, phone tagging, pill / quick-call card / panel, iframe bridge
    ├── dock.css.js         dock styles (injected into a shadow root)
    ├── content.css         "Call with Fetch" tag styles (lives in Twenty's DOM)
    ├── options.html/js     settings: Twenty URL, Fetch app URL, rep email, theme, microphone grant
    ├── background.js       opens settings on install / toolbar click; relays the dialer to the offscreen document
    ├── offscreen.html      hosts the Telnyx client and the mic (offscreen.js is built, not committed)
    └── icons/
```

## Setup

Requirements: **Node 20+**, **Chrome 116+** (for the extension), a Twenty workspace, and a Telnyx account.

### Quick start (mock mode, no credentials)

```bash
npm install
cp .env.example .env          # set MOCK_MODE=true
npm run dev                   # server on :4000, web on :5173
```

Open http://localhost:5173. Contacts are fake and calls are simulated (the `MOCK MODE` badge is shown). Use this to click through the UI. Nothing in mock mode touches Twenty or Telnyx.

### 1. Twenty

- Sign in to Twenty (cloud: `https://api.twenty.com` is the API base; self-hosted: your domain).
- **Settings → API & Webhooks → + Create key.** Copy it once.
- Make sure at least one Person has a phone number in the Phone field.
- For Fetch Guard, add (Settings → Data model) a boolean `doNotCall` on **People** and a text/select `companyType` on **Companies**.

```
TWENTY_API_URL=https://api.twenty.com
TWENTY_API_KEY=<key>
```

### 2. Telnyx (about 15 minutes in the portal)

1. **API key** — Account → Keys & Credentials → API Keys → Create. → `TELNYX_API_KEY`
2. **Phone number** — Numbers → Buy Numbers → any voice-enabled US number. → `TELNYX_PHONE_NUMBER` (E.164, e.g. `+18135551234`)
3. **Credential SIP Connection** — Voice → SIP Connections → Add → type **Credentials**.
   - Outbound tab: create/select an **Outbound Voice Profile** (required for PSTN calls).
   - Copy the **Connection ID** (numeric). → `TELNYX_CONNECTION_ID`
4. **Assign the number to that connection** — Numbers → My Numbers → your number → Connection/App = the credential connection from step 3.
5. Optional: after the first run, the server logs the telephony credential it created. Put it in `TELNYX_CREDENTIAL_ID` so it is reused.

### 3. Configure and run the app

```bash
npm install
cp .env.example .env          # fill in the Twenty and Telnyx values, MOCK_MODE=false
npm run dev
```

Open http://localhost:5173 in Chrome. `localhost` counts as a secure origin, so the microphone prompt works. (Any other host needs HTTPS.) `GET /api/health` should report `mode: live` and `problems: []`.

### 4. Chrome extension (Fetch inside Twenty)

1. **Build the offscreen dialer.** MV3 forbids remote code, so the Telnyx SDK is bundled into the extension:
   ```bash
   npm run build:extension      # writes extension/offscreen.js
   ```
   Re-run it (and reload the extension) whenever `web/src/offscreen/` or `web/src/lib/dialer.ts` changes.
2. **Load it.** Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** → pick the `extension/` folder.
3. **Configure it.** Click the Fetch toolbar icon to open settings: your Twenty URL, the Fetch app URL (`http://localhost:5173` in dev, your deployed HTTPS URL in production), and your email → **Save**. Chrome asks for permission on your Twenty domain (turns the extension on there) and on the Fetch app (lets the dialer fetch its Telnyx token).
4. **Enable microphone** on the same settings page. The dialer runs in an offscreen document, which can't show a permission prompt, so the mic is granted here once. Until then, dialing fails with an error saying so.
5. **Allow Twenty to frame Fetch.** Set `EMBED_ALLOWED_ORIGINS=https://<your-twenty-origin>` on the Fetch server and restart/redeploy.
6. Reload Twenty. The Fetch pill appears bottom-right; open a person with a phone number and call.

How the extension works:

- **Contact association** — the extension sends the Twenty record id from the URL (`/object/person/<uuid>`) or the table row. The server re-reads that record by id before dialing and logging; a name is never used to decide where a note goes.
- **Where calls run** — the dock is an iframe of the Fetch app (`/?embed=1`), but Telnyx runs in the extension's offscreen document so Twenty's `Permissions-Policy` can't block the mic. Route: iframe `FETCH_DIALER` → `content.js` → `background.js` → `offscreen.js`, and call events come back the same way to the tab that dialed. One Telnyx connection serves every Twenty tab; a second tab can't dial while a call is live, and closing or reloading the tab that owns a call hangs it up.
- **Storage is partitioned** inside a cross-site iframe, so the embed doesn't share localStorage with the standalone app. The rep email is passed in via `FETCH_INIT`.
- **Twenty's DOM** — phone fields render as `tel:` links, which the extension keys on first; plain-text numbers in small cells are tagged as a fallback. The extension only ever adds sibling elements and never rewrites React-owned text.
- **Deploy order** — ship the web app before extension 0.5.0. The current web app still dials in the iframe for older extensions, but 0.5.0 drops `allow="microphone"` from the iframe, so an older web app can't place calls under it.

---

## How the integrations work

### Twenty authentication and API calls

- Every request carries `Authorization: Bearer <TWENTY_API_KEY>`.
- Contacts: `GET {TWENTY_API_URL}/rest/people?limit=50&depth=1`. `depth=1` expands the `company` relation so the company name is available. The server normalises each person to `{ id, name, company, phoneRaw, phone (E.164), email }`. Phone data is read from the `phones` composite (`primaryPhoneNumber` + `primaryPhoneCallingCode`) with a fallback to the older flat `phone` field.
- The **Twenty person ID is carried on the call record from creation onward** and is the only thing used when logging. Fetch never searches Twenty again after the call.

### Twenty activity logging

Twenty has no native "Call" activity object, so Fetch uses the closest reliable mechanism — a **Note attached to the person**:

1. `POST /rest/notes` with `{ title, bodyV2: { markdown } }` (falls back to `{ title, body }` if the workspace rejects `bodyV2`).
2. `POST /rest/noteTargets` with `{ noteId, personId }` — this is what places the note on that person's timeline.

Resulting note:

```
Outbound call via Fetch — Voicemail

Contact: John Smith
Phone: +18135551234
Duration: 2m 23s
Disposition: Voicemail
Telnyx Call ID: v3:…
Date: September 11, 2026
```

The note ID is stored on the call record; a second "Log Call" returns the existing note instead of creating a duplicate.

### Telnyx authentication (server side)

The browser never sees `TELNYX_API_KEY`. `POST /api/telnyx/token` does, per Telnyx's current docs:

1. `POST https://api.telnyx.com/v2/telephony_credentials` `{ connection_id, name }` → a credential for this connection (created once, ID cached / `TELNYX_CREDENTIAL_ID`).
2. `POST https://api.telnyx.com/v2/telephony_credentials/{id}/token` → a JWT valid for 24 hours.
3. The JWT and `TELNYX_PHONE_NUMBER` (caller ID) are returned to the browser.

### Telnyx browser calling

`web/src/lib/dialer.ts` uses the official `@telnyx/webrtc` SDK:

```ts
const client = new TelnyxRTC({ login_token: jwt });
client.remoteElement = 'remoteAudio';            // <audio> in index.html
client.on('telnyx.ready', …); client.on('telnyx.error', …);
client.on('telnyx.notification', n => { if (n.type === 'callUpdate') … n.call.state … });
client.connect();
const call = client.newCall({ destinationNumber: '+1813…', callerNumber: TELNYX_PHONE_NUMBER });
call.hangup();
```

Call state mapping: `new/trying/requesting/ringing/early` → **Calling**, `active` → **Connected**, `hangup/destroy` → **Call ended** (or **Call failed** if the hangup cause is an error and the call never connected). A `userMediaError` notification or a denied `getUserMedia` → "Microphone access was denied".

The Telnyx call ID stored on the record is `call.telnyxIDs.telnyxCallControlId` (falls back to the SDK call ID).

### Call lifecycle

```
Rep clicks Call
  → POST /api/calls            record created, number normalised (refused if invalid)   status: initiated
  → dialer.dial()              browser asks for mic, Telnyx dials                       status: calling
  → call.state = active        POST /api/calls/:id/status {connected, startedAt}        status: connected
  → hangup                     POST /api/calls/:id/status {completed | no-answer | failed, endedAt}
Rep picks disposition          POST /api/calls/:id/disposition
Rep clicks Log Call            POST /api/calls/:id/log   → note + noteTarget in Twenty → "✓ Call logged to Twenty"
```

If logging fails, the UI says **"Call completed, but the activity could not be logged to Twenty."** The record keeps the contact ID, disposition, duration and the error, and shows a **Retry logging** button. Unlogged calls (including ones interrupted by a page refresh) also appear in the **Unlogged calls** panel on the next load.

---

## Fetch Guard (compliance engine)

Every call is checked **server-side** in `POST /api/calls` before anything is dialed. A call is allowed only if every rule permits it. Refused calls are not silently dropped: they are stored with `status: "blocked"`, the rep, and the reason codes — that record is the audit trail.

| Rule | Reason code | Source of truth |
|---|---|---|
| Internal Do Not Call list | `DNC_INTERNAL` | Fetch settings (`guard.rules.dncList`); written to by the **Do Not Call** disposition |
| CRM Do Not Call flag | `DNC_CRM` | Twenty `Person.doNotCall` (custom boolean) |
| Per-rep Company Type permissions | `COMPANY_TYPE` | Fetch settings (`repPermissions[repEmail].companyTypes`) checked against Twenty `Company.companyType` |
| Calling hours | `CALLING_HOURS` | contact's local time from the US area code (8:00–21:00 default, the federal TSR window) |

The contact list is pre-checked for the rep entered in the header, so restricted contacts show a badge (**DNC**, **Not permitted**, **Outside hours**) and a disabled Call button *before* anyone clicks — silent when everything is allowed, immediate and clear when something isn't. The server re-checks anyway; the browser's copy of a contact is never trusted.

**Twenty fields to add** (Settings → Data model): a boolean `doNotCall` on **People** and a text/select `companyType` on **Companies**. If they don't exist, `DNC_CRM` never fires and Company Type permissions treat every company as untyped.

**Rep identity:** the prototype has no login, so the rep types their email once in the header (kept in the browser). V1 replaces this with real auth; the email is already the key used for permissions and audit.

### Guard API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/guard/rules` | current rules |
| PUT | `/api/guard/rules` | partial update, e.g. `{"repPermissions":{"rep@co.com":{"companyTypes":["Property Management"]}}}` or `{"callingHours":{"startHour":9,"endHour":20,"enabled":true}}` |
| POST | `/api/guard/dnc` | `{ "phoneNumber": "(813) 555-0100" }` → adds to the internal list |
| POST | `/api/guard/check` | ad-hoc check `{ repEmail, phoneNumber, doNotCall?, companyType? }` → `{ allowed, reasons, detail, timezone }` — the seam a Watchdog bridge would use |

`POST /api/calls` returns **403 `BLOCKED`** with `reasons`, `detail`, and the stored `call` when refused. `GET /api/calls?rep=` and the audit list include blocked attempts; the unlogged-calls panel excludes them.

There is no auth on the rules endpoints in the prototype (single trusted operator on localhost). Do not expose them publicly before V1 auth.

See `docs/watchdog-vs-fetch-guard.md` for how this maps to Watchdog.

---

## API

All responses are JSON. Errors: `{ "error": "<human message>", "code": "<CODE>" }`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | `{ ok, mode: 'live'|'mock', twenty, telnyx, store, callerNumber, problems[] }` |
| GET | `/api/contacts` | `{ contacts: Contact[], source }` — up to 50 people from Twenty |
| GET | `/api/contacts/:id` | one contact |
| POST | `/api/telnyx/token` | `{ token, callerNumber, expiresInSeconds }` (mock mode: `{ mock: true }`) |
| POST | `/api/calls` | body `{ twentyContactId, contactName, phoneNumber, sessionId?, repEmail?, callerId? }` (`callerId` must be an active account number, else 400 `INVALID_CALLER_ID`) → `{ call, guard }` (201). 400 `NO_PHONE` / `INVALID_PHONE`; **403 `BLOCKED`** with `reasons` + stored audit record |
| GET | `/api/calls?unlogged=true` | recent calls; `unlogged=true` filters to ended-but-unlogged |
| GET | `/api/calls/:id` | one call |
| POST | `/api/calls/:id/status` | body `{ status, telnyxCallId?, startedAt?, endedAt? }`; computes `durationSeconds` |
| GET | `/api/telnyx/numbers` | `{ defaultNumber, numbers[] }` — active Telnyx numbers for the caller ID picker |
| POST | `/api/webhooks/telnyx` | Telnyx webhook; stores the mp3 on `call.recording.saved` |
| GET | `/api/recordings/:callId.mp3` | the stored recording |
| POST | `/api/calls/:id/disposition` | body `{ disposition, notes? }`; allowed mid-call; 409 `ALREADY_LOGGED` after logging; `do_not_call` also adds the number to the internal DNC list |
| POST | `/api/calls/:id/log` | body `{ notes?, disposition? }` saved first, then writes the note; idempotent (`alreadyLogged: true`); 409 `CALL_ACTIVE` while in progress; 400 `NO_DISPOSITION`; 502 `TWENTY_LOG_FAILED` (retryable) |

Call record:

```json
{
  "id": "…", "twentyContactId": "…", "contactName": "John Smith", "phoneNumber": "+18135551234",
  "telnyxCallId": "v3:…", "status": "completed", "disposition": "voicemail",
  "startedAt": "…", "endedAt": "…", "durationSeconds": 143,
  "twentyNoteId": "…", "loggedAt": "…", "lastLogError": null, "sessionId": "…",
  "repEmail": "rep@company.com", "blockedReasons": null
}
```

Statuses: `initiated → calling → connected → completed` | `no-answer` | `failed` | `blocked` (refused by Guard, audit only).
Dispositions: `connected, no_answer, voicemail, busy, wrong_number, do_not_call, other`.

## Storage

- Default: `server/data/calls.json` and `server/data/settings.json` (Guard rules), created automatically. Enough for the prototype.
- PostgreSQL: set `DATABASE_URL`, run `npm run db:migrate -w server`. Schema is `server/db/schema.sql`; the store implementation is `server/src/store/postgresStore.ts`.

## Deployment

The server serves the built frontend, so one process is enough.

**Docker (any host: Railway, Render, Fly.io, a VPS):**

```bash
docker build -t fetch .
docker run -p 4000:4000 --env-file .env fetch
```

**Without Docker:**

```bash
npm ci && npm run build && npm start      # serves API + web on $PORT
```

Requirements in production:
- **HTTPS is mandatory** — browsers only allow microphone access and WebRTC on secure origins.
- Set `CORS_ORIGINS` to your site's origin (only needed if the frontend is hosted separately).
- Put all variables from `.env.example` in the host's environment settings; never commit `.env`.
- `MOCK_MODE=false`.
- `EMBED_ALLOWED_ORIGINS` set to your Twenty origin if reps use the Chrome extension.

## Test plan

Success criteria (all must pass):

1. `npm run dev` starts; `/api/health` shows `mode: live`, `twenty: configured`, `telnyx: configured`, `problems: []`
2. Contacts list shows real Twenty people with company and phone
3. Select a contact → name, company, formatted phone, email shown
4. Click **Call** → browser asks for microphone permission
5. Status shows **Calling…**; the destination phone rings from `TELNYX_PHONE_NUMBER`
6. Answer → status **Connected**, timer runs, audio both ways
7. **Hang up** → status **Call ended**, duration shown
8. Disposition buttons appear; pick one
9. **Log Call** → **✓ Call logged to Twenty**
10. Open the contact in Twenty → the note "Outbound call via Fetch — …" is on their timeline with the right duration and disposition
11. `GET /api/calls` shows the record with `twentyContactId`, `telnyxCallId`, `durationSeconds`, `twentyNoteId`

Error cases:

| Case | How to test | Expected |
|---|---|---|
| No phone number | select a contact without a phone | Call button disabled; message under the number |
| Invalid phone | put `12345` in a contact's phone | "can't be normalised" message; `POST /api/calls` returns 400 `INVALID_PHONE`, no call placed |
| Mic denied | block the microphone in the browser, click Call | "Microphone access was denied…", status **Call failed** |
| Telnyx auth failure | wrong `TELNYX_API_KEY` | `/api/telnyx/token` → 401 `TELNYX_AUTH`, shown in the call panel |
| Telnyx call failure | dial an unallocated number | **Call failed** with the Telnyx cause |
| Twenty auth failure | wrong `TWENTY_API_KEY` | red banner "Twenty rejected the API key" |
| Twenty unavailable | wrong `TWENTY_API_URL` | banner "Could not reach Twenty at …" |
| Logging failure | revoke the Twenty key after the call, then Log | "Call completed, but the activity could not be logged…", **Retry logging** works after restoring the key |
| Refresh during a call | reload the tab mid-call | on reload, the call appears under **Unlogged calls**; log it from there |
| Duplicate logging | call `POST /api/calls/:id/log` twice | second response `alreadyLogged: true`, one note in Twenty |
| Guard: CRM DNC | set `doNotCall` on a person in Twenty | badge **DNC**, Call disabled, `POST /api/calls` → 403 `DNC_CRM`, blocked record stored |
| Guard: permissions | `PUT /api/guard/rules` restricting your email to one Company Type | other types badge **Not permitted** and are refused |
| Guard: hours | set `callingHours` to a window that excludes now | badge **Outside hours**; check reports the contact's local hour and zone |
| Guard: write-back | log a call with disposition **Do Not Call** | number appears in `dncList`; next attempt refused `DNC_INTERNAL` |

Automated coverage run during development (mock mode and a fake Twenty server): every endpoint above, the outage → retry → single-note path, the duplicate guard, and both phone-number rejections.

## Current limitations

Intentionally **not** implemented:

- Login / users / roles — single anonymous rep; `/api/telnyx/token` has no auth. Do not expose this deployment publicly without adding authentication first.
- Multi-subsidiary data separation.
- Power dialing, parallel dialing, sequences, queues.
- Recording-consent prompts. `ENABLE_CALL_RECORDING=true` records every answered call; there is no announcement or per-call consent yet, so check the law for the states you call (Florida is all-party consent).
- Voicemail / answering-machine detection.
- Inbound calls.
- Guard is rules-only: no National DNC Registry scrub (needs an FTC subscription + scrub API), no consent capture, no recording-consent prompts, no abandonment pacing — those are V1 (see the blueprint).
- Guard rules have no admin UI; use the API.
- Analytics, dashboards, AI summaries, coaching.
- Contact search/pagination beyond the first 50 people.
- JWT refresh: the Telnyx token lasts 24 h; reload the page after that.
- Twenty webhooks (contacts are pulled on load / Refresh, not pushed).
- A native Twenty "Call" object — notes are used instead (see above). A custom `Call` object in Twenty is the planned V1 upgrade.

## Configuration reference

All variables live in `.env` (see `.env.example`).

| Variable | Where it comes from |
|---|---|
| `MOCK_MODE` | `false` for real calls; `true` for fake contacts and simulated calls |
| `TWENTY_API_URL` | `https://api.twenty.com` for cloud, or your self-hosted URL |
| `TWENTY_API_KEY` | Twenty → Settings → API & Webhooks → + Create key |
| `TELNYX_API_KEY` | Telnyx Portal → Account → Keys & Credentials → API Keys |
| `TELNYX_CONNECTION_ID` | Telnyx Portal → Voice → SIP Connections → your *Credentials* connection (with an Outbound Voice Profile) |
| `TELNYX_PHONE_NUMBER` | a Telnyx number assigned to that connection, E.164 |
| `TELNYX_CREDENTIAL_ID` | optional; printed by the server on first run, paste it back to reuse |
| `DATABASE_URL` | optional; PostgreSQL connection string. Empty = JSON file store |
| `PORT`, `CORS_ORIGINS` | server port; allowed frontend origin(s) in dev |
| `EMBED_ALLOWED_ORIGINS` | your Twenty origin(s), comma-separated, so the extension's dock can frame Fetch |
| `ENABLE_CALL_RECORDING` | `true` records answered calls (Telnyx `record_start`, mp3, single channel); files land in `DATA_DIR/recordings/` and are linked from the Twenty note |
| `TELNYX_PUBLIC_KEY` | Telnyx Portal → Keys & Credentials → Public Key; verifies `/api/webhooks/telnyx` signatures. Also set the connection's webhook URL to `https://<fetch>/api/webhooks/telnyx` |
| `PUBLIC_URL` | optional public origin of the server for recording links (default: taken from the request) |
| `DATA_DIR` | optional; where the JSON store and recordings live (default `server/data`). On Railway, point it at a volume |
