# Backseat — Twitch chat backseats the rival

> **Don’t trust this README. Check it.** Every claim below has a command or source file you can check in about two minutes, with no Twitch account needed. Anything not proven yet is marked **Not yet proven**.

**In one line:** Backseat gives each Twitch chat a real say in a two-streamer match, but only over the rival, and only from challenges both streamers approved.

- **Live app:** <https://backseat-2znp.onrender.com/> (Render’s Free plan can take about a minute to wake after inactivity.)
- **Demo video:** _Add the public or unlisted YouTube URL after recording._
- **Built with:** OpenAI Codex — main session `01a184e9-88ae-7191-ac0a-be3b4980e1dc`

## The problem

Streamers love playing with other streamers, and chat always has something to say. Most of that energy is ignored or turns into spam because it has no shared, fair way to affect the action. Backseat gives both communities a small, visible role without letting either community sabotage its own streamer.

## What it does

1. Two streamers sign in with Twitch. One creates a private battle invitation; the other accepts it.
2. Together they build, then both approve, the same **two to four** challenges. Every option is 10, 20, 30, or 60 seconds.
3. Each adds a private, read-only OBS overlay and confirms it.
4. Each chat picks with `!pick 1` through `!pick 4` (only positions in the approved list count). `!vote N` remains a quiet compatibility alias.
5. A pick in Streamer A’s chat applies a challenge to **Streamer B**, and the other way round.
6. The server reveals both picks, waits for both streamers to be ready, runs one shared three-second countdown, then ends each challenge on its own timer.

Either streamer can start the next pick, lock it early, or stop a round. Backseat shows the challenges and timers. **It does not control the game or check whether players follow the rules.** After a completed round, streamers can self-report host, guest, or draw; Backseat stores that score but does not verify it. The browser decides nothing here: the server owns membership, approval, routing, timing, and overlay access.

## Two-minute check — no Twitch account needed

Requires Node 22+.

```bash
git clone https://github.com/Bigestdave/Backseat && cd Backseat
npm ci
npm run typecheck       # passes
npm test                # 42 tests pass in 6 files
npm run build           # client and server build
npm audit --omit=dev    # 3 moderate findings, explained below
```

Last checked locally on 2 November 2026 before the next deployment.

## Claims you can check

| # | Claim | How to check | What you should see |
| --- | --- | --- | --- |
| 1 | `!pick 1` through `!pick 4` parse; malformed commands do not | `npm test -- chat-routing` | `parseVoteCommand` accepts the documented command and the quiet `!vote` alias, but rejects `!pick 5` and free text. |
| 2 | A pick goes to the rival, not your own streamer | `npm test -- chat-routing` | `routes a host-channel vote to the guest using stable Twitch IDs` and `routes a guest-channel vote to the host`. |
| 3 | Streamers cannot pick in their own battle | `npm test -- chat-routing` | `excludes the participating %s creator from voting`, run for both streamer roles. |
| 4 | Chats outside the battle are ignored | `npm test -- chat-routing` | `ignores votes from a channel outside the two creators' battle`. |
| 5 | Lists have two to four consecutive options with approved durations | `npm test -- rounds` | `accepts two to four consecutive pick positions` and rejects unsupported durations. |
| 6 | Both streamers must approve the same list | `npm test -- rounds` | `requires both creators to approve the same immutable version`. |
| 7 | One shared countdown is set by the server | `npm test -- rounds` | `commits one shared server countdown when the second creator is ready`. |
| 8 | No picks means no made-up challenge | `npm test -- rounds` | `never invents a challenge when a community has no votes`. |
| 9 | A tie is broken once by the server | `npm test -- rounds` | `resolves a tie once using the server-supplied random decision`. |
| 10 | The overlay never gets viewer names or individual picks | `npm test -- overlay-state` | `shows public assignments but never pick or viewer fields`. |
| 11 | A viewer cannot switch teams mid-battle | Read `battle_team_locks` in [`battle-service.ts`](src/server/services/battle-service.ts) | Checked in code and the database schema. **No dedicated unit test yet.** |

Simulated mode is separate: `/api/demo/*` in [`server.ts`](src/server/server.ts) uses `demo:` identities only, and the UI labels it **Simulated**. It never calls Twitch.

## Try to make a chat hurt its own streamer

That is the one thing Backseat must never allow. The current checks are:

- **A streamer picks in the battle:** ignored (claim 3).
- **A viewer picks in both chats:** locked to their first team (claim 11).
- **A chat outside the battle picks:** ignored (claim 4).
- **Twitch sends the same message twice:** deduplicated by delivery and message ID.
- **A viewer spams picks:** one pick per viewer per round; a new pick replaces the old one.

Found another route? Open an issue. We would rather know.

## What’s proven and what is not yet

| Area | Status |
| --- | --- |
| Pick routing, round rules, and overlay privacy | **Proven** by 42 passing unit tests |
| Type check and production build | **Proven** locally |
| Render health endpoint | **Responding** with `{"status":"ok"}` |
| Supabase-backed deployment | **Configured**; migration runs during startup |
| Real `!pick` from a third Twitch account reaching the rival | **Not yet proven** — update with the video timestamp after the controlled test |
| OBS Browser Source display | **Not yet proven** — update with the video timestamp after recording |
| Database behaviour under real concurrent load | **Not tested** beyond unit tests |

## Questions you might have

**Can players just ignore the challenge?**
Yes. Backseat is a public dare between two streamers, with both chats watching. It does not control a game or determine whether a player follows the rule. That keeps it game-agnostic.

**Why chat commands instead of a Twitch Extension or voting site?**
Every viewer can already type in chat. There is nothing extra to install and no new site or viewer login to manage.

**What happens when chat drops?**
Twitch does not resend messages missed during a disconnect. Backseat cancels a pick, reveal, or countdown that has not begun; an already active challenge keeps running because the result was already chosen. Reconnecting never restarts an interrupted round.

**What are the three audit findings?**
They are moderate denial-of-service advisories in `minimatch`, pulled in through `glob` by `@fastify/static`. The automated audit remedy proposes a breaking package change, so the finding is disclosed rather than blindly applied or hidden.

**Why is the first load slow?**
Render’s Free plan sleeps when idle. While it is asleep, no chat is collected. On wake, Backseat clears stale state and reconnects before a pick can open.

**Is it production-ready?**
Not yet. A streamer-facing data deletion flow and automatic data-retention job are still a hardening milestone.

**How was Codex used?**
Codex turned the product handoff and UI designs into this app: the battle flow, invitations, approvals, chat routing, and overlay. It also helped track down deployment, migration, and timestamp-persistence bugs on the hosted app, then ran type checks, tests, and builds after each repair.

## Controlled Twitch proof

This is the minimum live proof for a demo video. Use two streamer accounts plus a third viewer account.

1. Connect both streamer accounts and create/join one real battle.
2. Create private overlay links, add them as OBS Browser Sources, and confirm each source.
3. Have both streamers approve the challenge list and open picks.
4. From the third account, send `!pick 1` in the host’s Twitch chat. The Backseat receipt must identify the **guest** as the target.
5. Send a pick from the guest’s chat. The receipt must identify the **host** as the target.
6. Record this as **Controlled test**. If the demo uses any on-screen simulated controls, label them **Simulated picks**.

Do not claim the Twitch portion is live-tested until steps 1–5 have been recorded successfully.

## Architecture

```text
Twitch chat / EventSub WebSocket
              │
              ▼
Fastify server ── server-enforced routing + round state ── PostgreSQL
     │                         │                              │
     │                         └── authenticated streamer dashboard
     │
     └── read-only SSE public snapshot ── private OBS overlay
```

### Twitch connection

- **OAuth:** confidential authorization-code flow using `user:read:chat`.
- **Chat ingestion:** Twitch EventSub WebSocket `channel.chat.message` events.
- **Routing:** source-channel Twitch IDs determine which *opponent* receives a pick.
- **Safety:** tokens stay server-side, streamer sessions are HttpOnly, OAuth tokens are encrypted at rest, and request logs redact sensitive headers.

### Battle rules

- One active battle per streamer.
- Single-use invitations, with host-controlled rotation.
- Two to four challenge choices, versioned and immutable once proposed. Each option records its original contributor.
- Either streamer can edit the shared list; a new version resets both approvals.
- Both streamers approve the same version before picks open.
- One replaceable pick per viewer per round; delivery/message identifiers are deduplicated.
- A viewer is locked to one community for the battle, preventing cross-channel switching.
- The backend owns deadlines, tie-break persistence, countdown, challenge expiry, stop, disconnect handling, and battle end.
- Either streamer can open the next pick or lock an active pick early. A completed round’s score is self-reported and visibly labelled as such.

### Overlay privacy

The overlay is deliberately read-only. It receives public participants, challenge labels, timer state, and assignments—not streamer controls, OAuth tokens, raw chat text, individual picks, or viewer identities. Its URL secret stays in the URL fragment and is exchanged for a scoped HttpOnly session.

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

5. Open <http://localhost:5173>. Use a separate browser profile for the second streamer account.

## Deploy on Render and Supabase

[`render.yaml`](render.yaml) deploys one Node web service. The same process serves the dashboard, API, overlay SSE stream, EventSub client, and round scheduler so the demo does not need cross-service coordination.

1. Create a Supabase project and copy the **Session pooler** PostgreSQL URI to `DATABASE_URL`. Do not use the project URL or publishable API key.
2. Import this repository as a Render Blueprint.
3. Set these server-side Render environment variables: `DATABASE_URL`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `SESSION_SECRET`, and `TOKEN_ENCRYPTION_KEY`.
4. Register `https://<your-render-host>/auth/twitch/callback` in the Twitch Developer Console.
5. Render runs `npm run db:migrate` before startup. Confirm `/health` returns `{"status":"ok"}`.

Render’s Free tier can sleep after inactivity. That is acceptable for a hackathon demo, but it means Twitch messages cannot be collected while the service is asleep. Wake the app and confirm both chat feeds are connected before recording a real test.

## Scope and honest limitations

Backseat is intentionally narrow. It is a two-streamer Twitch interaction, not a game controller, moderation product, payment system, or AI decision-maker.

- It does not control a game or verify whether a streamer physically follows a challenge.
- It does not store raw chat text.
- It does not claim production-grade deletion/retention tooling; that is a hardening milestone.
- A simulated pick is not a Twitch pick and is labelled as such.
- A live OAuth, EventSub, chat, or OBS claim belongs in the demo only after the controlled test succeeds.

## How OpenAI Codex was used

Codex helped turn the product handoff and UI references into the application: the two-streamer state model, shared challenge flow, private invitations, Twitch chat-routing rules, public overlay contract, visual integration, and deployment configuration. It also helped trace build, migration, and timestamp-persistence failures through logs, then verify repairs with type checks, unit tests, production builds, and dependency auditing.

## Security notes

Never commit `.env`, database URIs, Twitch secrets, OAuth tokens, invitation secrets, or overlay URLs. The backend—not the browser—enforces sessions, battle membership, invitation use, origin checks, overlay scope, and rival targeting. Rotating an overlay link revokes the previous credential.
