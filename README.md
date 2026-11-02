# Backseat — Twitch chat backseats the rival

> **Don’t trust this README. Check it.** Every claim below has a command or source file you can check in about two minutes, with no Twitch account needed. Anything not proven yet is marked **Not yet proven**.

**In one line:** Backseat gives each Twitch chat a real say in a two-streamer match, but only over the rival, and only from challenges both streamers approved.

- **Live app:** <https://backseat-2znp.onrender.com/> (Render’s Free plan can take about a minute to wake after inactivity.)
- **Demo video:** _Add the public or unlisted YouTube URL after recording._
- **Built with:** OpenAI Codex — main session `01a184e9-88ae-7191-ac0a-be3b4980e1dc`

## The problem

Streamers love playing with other streamers, and chat always has something to say. Most of that energy is ignored or turns into spam because it has no shared, fair way to affect the action. Backseat gives both communities a small, visible role without letting either community sabotage its own streamer.

## What it does

1. Two creators sign in with Twitch. One creates a private battle invitation; the other accepts it.
2. Both approve the exact same list of three challenges.
3. Each adds a private, read-only OBS overlay and confirms it.
4. Each chat votes with `!vote 1`, `!vote 2`, or `!vote 3`.
5. A vote in Creator A’s chat picks a challenge for **Creator B**, and the other way round.
6. The server reveals both challenges, waits for both creators to be ready, runs one shared three-second countdown, then ends each challenge on its own timer.

Either creator can stop a round. Backseat shows the challenges and timers. **It does not control the game or check whether players follow the rules.** The browser decides nothing here: the server owns membership, approval, routing, timing, and overlay access.

## Two-minute check — no Twitch account needed

Requires Node 22+.

```bash
git clone https://github.com/Bigestdave/Backseat && cd Backseat
npm ci
npm run typecheck       # passes
npm test                # 39 tests pass in 6 files
npm run build           # client and server build
npm audit --omit=dev    # 3 moderate findings, explained below
```

Last checked on 2 November 2026 at code commit [`7dbf222`](https://github.com/Bigestdave/Backseat/commit/7dbf222).

## Claims you can check

| # | Claim | How to check | What you should see |
| --- | --- | --- | --- |
| 1 | Only `!vote 1`, `!vote 2`, and `!vote 3` count | `npm test -- chat-routing` | `parseVoteCommand` tests: malformed commands and `!pick 1` are rejected. |
| 2 | A vote goes to the rival, not your own streamer | `npm test -- chat-routing` | `routes a host-channel vote to the guest using stable Twitch IDs` and `routes a guest-channel vote to the host`. |
| 3 | Creators cannot vote in their own battle | `npm test -- chat-routing` | `excludes the participating %s creator from voting`, run for both creators. |
| 4 | Chats outside the battle are ignored | `npm test -- chat-routing` | `ignores votes from a channel outside the two creators' battle`. |
| 5 | Both creators must approve the same list | `npm test -- rounds` | `requires both creators to approve the same immutable version`. |
| 6 | A chat disconnect cancels the live round | `npm test -- rounds` | `invalidates every live phase when chat disconnects`. |
| 7 | One shared countdown is set by the server | `npm test -- rounds` | `commits one shared server countdown when the second creator is ready`. |
| 8 | No votes means no made-up challenge | `npm test -- rounds` | `never invents a challenge when a community has no votes`. |
| 9 | A tie is broken once by the server | `npm test -- rounds` | `resolves a tie once using the server-supplied random decision`. |
| 10 | The overlay never gets voter names or votes | `npm test -- overlay-state` | `shows public assignments but never vote or viewer fields`. |
| 11 | A viewer cannot switch teams mid-battle | Read `battle_team_locks` in [`battle-service.ts`](src/server/services/battle-service.ts) | Checked in code and the database schema. **No dedicated unit test yet.** |

Simulated mode is separate: `/api/demo/*` in [`server.ts`](src/server/server.ts) uses `demo:` identities only, and the UI labels it **Simulated**. It never calls Twitch.

## Try to make a chat hurt its own streamer

That is the one thing Backseat must never allow. The current checks are:

- **A creator votes in the battle:** ignored (claim 3).
- **A viewer votes in both chats:** locked to their first team (claim 11).
- **A chat outside the battle votes:** ignored (claim 4).
- **Twitch sends the same message twice:** deduplicated by delivery and message ID.
- **A viewer spams votes:** one vote per viewer per round; a new vote replaces the old one.

Found another route? Open an issue. We would rather know.

## What’s proven and what is not yet

| Area | Status |
| --- | --- |
| Vote routing, round rules, and overlay privacy | **Proven** by 39 passing unit tests |
| Type check and production build | **Proven** locally |
| Render health endpoint | **Responding** with `{"status":"ok"}` |
| Supabase-backed deployment | **Configured**; migration runs during startup |
| Real `!vote` from a third Twitch account reaching the rival | **Not yet proven** — update with the video timestamp after the controlled test |
| OBS Browser Source display | **Not yet proven** — update with the video timestamp after recording |
| Database behaviour under real concurrent load | **Not tested** beyond unit tests |

## Questions you might have

**Can players just ignore the challenge?**
Yes. Backseat is a public dare between two streamers, with both chats watching. It does not control a game or determine whether a player follows the rule. That keeps it game-agnostic.

**Why chat commands instead of a Twitch Extension or voting site?**
Every viewer can already type in chat. There is nothing extra to install and no new site or viewer login to manage.

**Why cancel the whole round when chat drops?**
Twitch does not resend messages missed during a disconnect. A half-counted vote is not fair, so Backseat invalidates the round rather than pretending the result is complete.

**What are the three audit findings?**
They are moderate denial-of-service advisories in `minimatch`, pulled in through `glob` by `@fastify/static`. The automated audit remedy proposes a breaking package change, so the finding is disclosed rather than blindly applied or hidden.

**Why is the first load slow?**
Render’s Free plan sleeps when idle. While it is asleep, no chat is collected. On wake, Backseat clears stale state and reconnects before a vote can open.

**Is it production-ready?**
Not yet. A creator-facing data deletion flow and automatic data-retention job are still a hardening milestone.

**How was Codex used?**
Codex turned the product handoff and UI designs into this app: the battle flow, invitations, approvals, chat routing, and overlay. It also helped track down deployment, migration, and timestamp-persistence bugs on the hosted app, then ran type checks, tests, and builds after each repair.

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

## How OpenAI Codex was used

Codex helped turn the product handoff and UI references into the application: the two-creator state model, challenge-approval flow, private invitations, Twitch chat-routing rules, public overlay contract, and deployment configuration. It also helped trace build, migration, and timestamp-persistence failures through logs, then verify repairs with type checks, unit tests, production builds, and dependency auditing.

## Security notes

Never commit `.env`, database URIs, Twitch secrets, OAuth tokens, invitation secrets, or overlay URLs. The backend—not the browser—enforces sessions, battle membership, invitation use, origin checks, overlay scope, and rival targeting. Rotating an overlay link revokes the previous credential.
