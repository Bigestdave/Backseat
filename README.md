# Backseat — Twitch chat backs the rival

Backseat is a two-creator Twitch format: each creator’s community chooses a short, pre-approved challenge for the **other** creator.

> **Verification-first:** this README is designed to be checked, not trusted. Every claim below either has a source pointer and a local check, or is explicitly marked **unverified**. The simulated demo is never presented as Twitch activity.

**One-line description:** Backseat lets two Twitch communities playfully backseat the rival, through one server-enforced vote path and a read-only OBS overlay.

- Live demo: <https://backseat-2znp.onrender.com/>
- Source: <https://github.com/Bigestdave/Backseat>

## What it does

1. Two creators authenticate with Twitch, then create and join a private battle.
2. Both approve the exact same three-option challenge list.
3. Both set up their own private OBS Browser Source and confirm it.
4. Each chat votes with `!vote 1`, `!vote 2`, or `!vote 3`.
5. A vote from Creator A’s chat targets Creator B; a vote from Creator B’s chat targets Creator A.
6. The server reveals the chosen challenges, waits for both creators to be ready, runs a shared countdown, and expires the restrictions.

The browser is not trusted to decide any of this. The backend owns membership, challenge approval, target routing, vote timing, round transitions, and overlay access.

## Fast local audit

The application requires Node 22+ (the deployment version is pinned in [`.node-version`](.node-version)). After installing dependencies, these are the quick checks:

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Expected results at the latest checked commit:

- TypeScript type check passes.
- All **39** unit tests pass.
- The production client and Fastify server build successfully.
- The production dependency audit is shown transparently below; it currently reports three moderate upstream dependency findings.

## Claims you can verify

| Claim | How to check it | What to expect |
| --- | --- | --- |
| Only exact vote commands are accepted | Run `npm test -- chat-routing` or inspect [`chat-routing.ts`](src/server/services/chat-routing.ts) | `!vote 1`, `!vote 2`, and `!vote 3` are accepted; malformed commands and `!pick 1` are rejected. |
| Chat votes target the rival, not the streamer whose chat sent them | Run `npm test -- chat-routing` | A host-channel vote resolves to the guest; a guest-channel vote resolves to the host, using stable Twitch IDs. |
| Creators cannot vote in their own battle | Run `npm test -- chat-routing` | Messages sent by either participating creator are ignored. |
| The overlay does not receive voter identities or vote data | Run `npm test -- overlay-state` or inspect [`overlay-state.ts`](src/server/services/overlay-state.ts) | The public snapshot contains challenge and restriction state only; it has no voter or vote fields. |
| Both creators must approve the same challenge list | Run `npm test -- rounds` | A challenge set is only approved after both creator roles approve the same immutable version. |
| A chat disconnect invalidates a live round | Run `npm test -- rounds` and inspect [`battle-service.ts`](src/server/services/battle-service.ts) | Voting, revealed, countdown, and active rounds can transition to `invalidated`; assignments are cleared. |
| Simulated activity cannot masquerade as Twitch activity | Start the in-app demo and inspect `/api/demo/*` routes in [`server.ts`](src/server/server.ts) | Demo identities are prefixed `demo:` and the UI visibly labels its controls and overlay **Simulated**. |

## Real versus simulated

Backseat has two deliberately separate paths:

- **Real battle:** Twitch OAuth, EventSub chat-message subscriptions, two independently authorized creator accounts, and private overlay credentials.
- **Simulated demo:** isolated `demo:` users and simulated votes for rehearsing the product flow. These actions never call Twitch and must be described as **Simulated votes** in any recording.

### Live integration status

| Area | Status |
| --- | --- |
| OAuth, EventSub, rival-routing, overlay, and round logic | Implemented in the server code |
| Type checks, unit tests, and production build | Verified locally |
| Render health endpoint and Supabase schema migration | Configured for the live deployment |
| Real Twitch chat vote from a third viewer account | **Requires the controlled test below before it is claimed as proven** |
| OBS Browser Source display | **Requires manual OBS verification** |

## Controlled Twitch proof

This is the minimum live proof for a demo video. Use two creator accounts plus a third viewer account.

1. Connect both creator accounts and create/join one real battle.
2. Create private overlay links, add them as OBS Browser Sources, and confirm each source.
3. Have both creators approve the challenge list and open voting.
4. From the third account, send `!vote 1` in the host’s Twitch chat. The Backseat receipt must identify the **guest** as the target.
5. Send a vote from the guest’s chat. The receipt must identify the **host** as the target.
6. Record this as **Controlled test**. If the demo uses any on-screen simulated controls, label them **Simulated votes**.

Do not claim the Twitch portion is live-tested until steps 1–5 have been recorded successfully.

## Architecture

```text
Twitch chat / EventSub WebSocket
              │
              ▼
Fastify server ── server-enforced routing + round state ── PostgreSQL
     │                         │                              │
     │                         └── authenticated creator dashboard
     │
     └── read-only SSE public snapshot ── private OBS overlay
```

### Twitch connection

- **OAuth:** confidential authorization-code flow using `user:read:chat`.
- **Chat ingestion:** Twitch EventSub WebSocket `channel.chat.message` events.
- **Routing:** source-channel Twitch IDs determine which *opponent* receives a vote.
- **Safety:** tokens stay server-side, creator sessions are HttpOnly, OAuth tokens are encrypted at rest, and request logs redact sensitive headers.

### Battle rules

- One active battle per creator.
- Single-use invitations, with host-controlled rotation.
- Exactly three challenge choices, versioned and immutable once proposed.
- Both creators approve the same version before voting opens.
- One replaceable vote per viewer per round; delivery/message identifiers are deduplicated.
- A viewer is locked to one community for the battle, preventing cross-channel switching.
- The backend owns deadlines, tie-break persistence, countdown, restriction expiry, stop, disconnect invalidation, and battle end.

### Overlay privacy

The overlay is deliberately read-only. It receives public participants, challenge labels, timer state, and restrictions—not creator controls, OAuth tokens, raw chat text, individual votes, or viewer identities. Its URL secret stays in the URL fragment and is exchanged for a scoped HttpOnly session.

## Run locally

1. Register a Twitch application and add `http://localhost:3000/auth/twitch/callback` as a redirect URI.
2. Copy `.env.example` to `.env` and provide `DATABASE_URL`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `SESSION_SECRET`, and `TOKEN_ENCRYPTION_KEY`.
3. Generate the encryption key without committing it:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

4. Start PostgreSQL, then run:

   ```bash
   npm install
   npm run db:migrate
   npm run dev
   ```

5. Open <http://localhost:5173>. Use a separate browser profile for the second creator account.

## Deploy on Render and Supabase

[`render.yaml`](render.yaml) deploys one Node web service. The same process serves the dashboard, API, overlay SSE stream, EventSub client, and round scheduler so the demo does not need cross-service coordination.

1. Create a Supabase project and copy the **Session pooler** PostgreSQL URI to `DATABASE_URL`. Do not use the project URL or publishable API key.
2. Import this repository as a Render Blueprint.
3. Set these server-side Render environment variables: `DATABASE_URL`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `SESSION_SECRET`, and `TOKEN_ENCRYPTION_KEY`.
4. Register `https://<your-render-host>/auth/twitch/callback` in the Twitch Developer Console.
5. Render runs `npm run db:migrate` before startup. Confirm `/health` returns `{"status":"ok"}`.

Render’s Free tier can sleep after inactivity. That is acceptable for a hackathon demo, but it means Twitch messages cannot be collected while the service is asleep. Wake the app and confirm both chat feeds are connected before recording a real test.

## Scope and honest limitations

Backseat is intentionally narrow. It is a two-creator Twitch interaction, not a game controller, moderation product, payment system, or AI decision-maker.

- It does not control a game or verify whether a streamer physically follows a challenge.
- It does not store raw chat text.
- It does not claim production-grade deletion/retention tooling; that is a hardening milestone.
- A simulated vote is not a Twitch vote and is labelled as such.
- A live OAuth, EventSub, chat, or OBS claim belongs in the demo only after the controlled test succeeds.

### Dependency audit note

`npm audit --omit=dev` currently reports three moderate findings through the `glob`/`minimatch` dependency path used by `@fastify/static`. The audit tool’s automatic remedy proposes a breaking package change, so it has not been applied blindly during the hackathon. The current audit output is intentionally left reproducible with the command above rather than hidden behind a claim of zero vulnerabilities.

## How OpenAI Codex was used

Codex helped turn the product handoff and UI references into the application: the two-creator state model, challenge-approval flow, private invitations, Twitch chat-routing rules, public overlay contract, and deployment configuration. It also helped trace build, migration, and timestamp-persistence failures through logs, then verify repairs with type checks, unit tests, production builds, and dependency auditing.

## Security notes

Never commit `.env`, database URIs, Twitch secrets, OAuth tokens, invitation secrets, or overlay URLs. The backend—not the browser—enforces sessions, battle membership, invitation use, origin checks, overlay scope, and rival targeting. Rotating an overlay link revokes the previous credential.
