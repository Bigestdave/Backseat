# Backseat — Milestone 1 (local implementation)

Backseat is a two-creator Twitch experience: each creator's community chooses a preapproved restriction for the other creator. The code keeps the Twitch/OAuth boundary real, but this checkout has not yet been connected to Twitch or PostgreSQL, so no live integration claim is being made.

## Implemented in code

- Server-side Twitch authorization-code OAuth using `user:read:chat`; encrypted tokens and HttpOnly creator sessions.
- One active battle per creator, single-use invitations that the host can rotate, and two distinct creator accounts.
- EventSub WebSocket ingestion for active battle participants only, with stable-ID reciprocal routing: a host-channel vote targets the guest and vice versa.
- Voting opens only when both live Twitch chat subscriptions are connected. A chat disconnect invalidates the current round, clears both assignments, and requires a new vote after reconnect.
- Durable Twitch delivery/message deduplication, a per-viewer team lock, one replaceable vote per viewer per round, and bounded chat ingestion.
- Versioned, immutable challenge sets. Both creators must approve the exact same version before the host can open voting.
- An authoritative PostgreSQL round state machine: `voting → revealed → countdown → active → terminal`; the server owns voting deadlines, the shared countdown, tie-break persistence, and restriction expiry.
- Either creator can withdraw readiness before the countdown commits, stop the current round immediately, or end the battle through a separate confirmation. Ending a battle clears live restrictions, revokes its invitation/overlay credentials, and releases both creator seats.
- A read-only SSE overlay that receives public battle state only. It never receives viewer identities, individual vote data, tokens, or creator controls. Overlay URLs use a fragment-held secret exchanged for a scoped HttpOnly session.
- An isolated simulated demo that uses namespaced `demo:` identities and the same chat-vote and round services. Its controls and overlay are visibly labelled **Simulated**; it cannot create real battles, authenticate with Twitch, or deliver events into a real battle.
- Self-hosted Geist Variable fonts via Fontsource; no remote font dependency.

## Explicitly not complete

- No actual Twitch developer credentials, authorized accounts, live EventSub subscription, or OBS source were available in this checkout. Real OAuth/chat/overlay behavior is therefore **unverified**.
- The PostgreSQL migrations have not been run against a reachable database here. The transaction and concurrency paths are **unverified** outside unit tests.
- A simulated demo is available for exercising the UI and domain flow, but it does not verify Twitch authorization, EventSub delivery, chat routing from Twitch, or OBS display.
- No game integration, game control, score system, production deployment, deletion portal, or automated retention job is included.

## Local setup

1. Register a Twitch application with this redirect URI: `http://localhost:3000/auth/twitch/callback`.
2. Copy `.env.example` to `.env` and fill in `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `SESSION_SECRET`, and `TOKEN_ENCRYPTION_KEY`.
3. Generate the encryption key with a cryptographically secure command such as `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and keep `.env` private.
4. Start PostgreSQL with `docker compose up -d db`, or provide an equivalent `DATABASE_URL` for an existing local PostgreSQL instance.
5. Run `npm install`, `npm run db:migrate`, and `npm run dev`.
6. Open `http://localhost:5173`, connect the first Twitch account, create a battle, and copy the invitation.
7. Use a separate browser profile for the second Twitch account to accept the invitation.
8. Each creator creates a private overlay link and uses it as an OBS Browser Source. The page itself has a transparent background; only the in-app preview composition is dark.

## Render Free demo deployment

The repository includes a Render Blueprint at `render.yaml` for one Node web service on the **Free** plan. It builds the client and server together, starts the Fastify server, and checks `/health`. The app currently serves the UI, API, read-only SSE overlay, Twitch EventSub listener, and round scheduler from one process. Keeping them together avoids introducing cross-service session, event-bus, and scheduler coordination for this demo. The pinned Node version is in `.node-version`. This Blueprint does not create a database or deploy anything until you import it in Render and confirm it there.

1. Create the Supabase project and copy its PostgreSQL connection URI from **Connect**. `DATABASE_URL` must be the Postgres URI, not the Supabase project URL or publishable API key. Use Supabase's shared **Session pooler** URI (port 5432) for this persistent app; it supports IPv4, which is the safer choice for hosted networks. Keep the URI private.
2. Import this repository as a Render Blueprint. The app uses Render's assigned `RENDER_EXTERNAL_URL` as its same-origin app and web address automatically. If you later add a custom domain, set `APP_ORIGIN` and `WEB_ORIGIN` to that HTTPS origin and set `TRUSTED_ORIGINS` to it as well. In the Twitch developer console, register `https://<your-render-host>/auth/twitch/callback` as the OAuth redirect URI.
3. Add `DATABASE_URL`, Twitch client ID/secret, `SESSION_SECRET`, and `TOKEN_ENCRYPTION_KEY` in Render's environment settings. Treat all of these as server-side secrets; never put them in Vite/client variables or commit them. Generate `TOKEN_ENCRYPTION_KEY` as base64-encoded 32 random bytes (the generation command in Local setup works).
4. The Render start command runs `npm run db:migrate` before starting the app, so the schema is created from the configured `DATABASE_URL` on first deploy and any unapplied migrations run on later deploys. Check the service logs for `Applied 0000_milestone_zero.sql` and `Applied 0001_domain_rules.sql`, then verify `/health` returns `{"status":"ok"}`. The migration command intentionally does not need Twitch credentials.

Render Free sleeps after 15 minutes without qualifying inbound traffic; waking on a later request takes about a minute, and Render may restart the service at any time. Supabase preserves the database through that sleep, but Twitch chat messages are not collected while Backseat is offline. On startup Backseat clears stale chat-connected state, invalidates any live round and clears its restrictions, then reconciles EventSub subscriptions again. Warm the site shortly before the demo and prove both chat feeds reconnect before opening a vote. This is a demo tradeoff, not an always-on production setup; the app does not send artificial keep-alive traffic.

## Live integration proof checklist

The UI intentionally starts each item as **unverified**. To prove Milestone 0 with two authorized accounts:

1. Verify both OAuth callbacks result in creator sessions.
2. Verify EventSub creates `channel.chat.message` subscriptions for each active creator.
3. Have both creators propose/approve a challenge set, create their individual overlay links, put them in OBS, and explicitly confirm their own source.
4. Open a vote. Send `!vote 1`, `!vote 2`, or `!vote 3` from a third Twitch account in the host's chat; the creator receipt must show the guest as target.
5. Repeat from the guest's chat and verify the host is target. Try an opposite-channel vote from the same viewer and verify it is ignored.
6. Close voting, verify the saved outcomes, confirm from both creators, and check the server-scheduled countdown, active restrictions, expiry, stop, and next-vote behavior.
7. Put both private overlay links into OBS at 1920×1080 and visually confirm readability, reconnection behavior, and that it never exposes voter information.

## Verification status in this checkout

| Area | Status |
| --- | --- |
| TypeScript type check | Passed locally |
| Unit tests for chat routing, security utilities, round-domain rules, and public-overlay privacy | Passed locally: 36 tests |
| Production build | Passed locally |
| Production dependency audit | Passed locally: `npm audit --omit=dev` reports 0 vulnerabilities |
| PostgreSQL migrations and transactional round flow | Requires a reachable PostgreSQL instance |
| Twitch OAuth, EventSub, real chat ingestion | Unverified until app credentials and two authorized Twitch accounts are supplied |
| OBS browser-source display | Unverified until manually tested in OBS |

## Security notes

Never commit `.env`, Twitch tokens, invitation secrets, or overlay URLs. The server redacts authorization and cookie headers from logs; OAuth callback request logging is disabled because Twitch returns its authorization code in the query string. The backend—not the browser—checks sessions, battle membership, invitation consumption, origin, overlay scope, and routing. Rotating an overlay link revokes the prior credential and closes its stream at the next authoritative event.

Current retention is deliberately narrow but incomplete: browser sessions expire after 14 days, invitation secrets expire after 7 days, and overlay credentials expire after 30 days. Backseat stores encrypted OAuth tokens, accepted command metadata, and deduplication receipts; it does **not** store raw chat text. A creator-facing deletion/revocation flow and an automated retention job are deferred to the hardening milestone, so this is not yet suitable for production data-retention commitments.

At the last local check, the full development dependency audit still reported four moderate findings inherited through Drizzle Kit's legacy loader. They are absent from the production dependency graph; the audit tool's offered change is a backwards major-version move, so it was not applied blindly. Keep the development server local and revisit the toolchain when Drizzle Kit publishes a compatible upstream fix.

