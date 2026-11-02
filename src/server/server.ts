import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { OverlaySnapshot } from "../shared/contracts";
import type { AppConfig } from "./config";
import { createDatabase } from "./db/client";
import { timestamp } from "./db/timestamp";
import { constantTimeEquals, randomSecret, sha256 } from "./security/crypto";
import { assertTrustedOrigin, clearCookie, secureCookieOptions } from "./security/http";
import { FixedWindowRateLimiter } from "./security/rate-limit";
import {
  clearCreatorSession,
  createCreatorSession,
  getCreatorSession,
  getOverlayCredentialId,
  requireCreatorSession,
  setOverlaySession
} from "./security/sessions";
import { ChatIngestionService } from "./services/chat-ingestion";
import { BattleService } from "./services/battle-service";
import { BattleEventBus } from "./services/event-bus";
import { createPublicOverlaySnapshot } from "./services/overlay-state";
import { createAuthorizationUrl, TwitchTokenService } from "./services/twitch";
import { TwitchEventSubService } from "./services/twitch-eventsub";
import { DEFAULT_CHALLENGES, type VoteOption } from "./domain/rounds";

const OAUTH_STATE_COOKIE = "backseat_oauth_state";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type CurrentBattleRow = {
  id: string;
  hostUserId: string;
  guestUserId: string | null;
  mode: "real" | "simulated";
  status: "setup" | "integration-proof" | "ended";
  stateVersion: number;
  currentChallengeSetVersionId: string | null;
  currentRoundId: string | null;
};

type ParticipantRow = {
  userId: string;
  displayName: string;
  role: "host" | "guest";
  overlayConfirmedAt: Date | null;
  chatConnectedAt: Date | null;
};

type ChallengeSetSnapshot = {
  id: string;
  version: number;
  votingDurationSeconds: number;
  options: Array<{ id: string; position: 1 | 2 | 3; title: string; instruction: string; durationSeconds: number }>;
  approvedByUserIds: string[];
};

type RoundSnapshot = {
  id: string;
  phase: "voting" | "revealed" | "countdown" | "active" | "complete" | "no-votes" | "stopped" | "invalidated";
  stateVersion: number;
  votingDeadlineAt: Date;
  countdownStartsAt: Date | null;
  activeAt: Date | null;
  completedAt: Date | null;
  terminalReason: string | null;
  readyUserIds: string[];
  assignments: Array<{
    targetUserId: string;
    targetDisplayName: string;
    title: string | null;
    instruction: string | null;
    durationSeconds: number | null;
    resolution: "winner" | "tie-break" | "no-votes";
    startsAt: Date | null;
    endsAt: Date | null;
    clearedAt: Date | null;
  }>;
};

function clientUrl(config: AppConfig, query: Record<string, string> = {}): string {
  const url = new URL(config.WEB_ORIGIN);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.toString();
}

function apiError(message: string, statusCode: number): Error {
  const error = new Error(message);
  Object.assign(error, { statusCode });
  return error;
}

function oauthFailureReason(error: unknown): "token-exchange" | "token-validation" | "scope" | "database-schema" | "server" {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Twitch token exchange failed")) return "token-exchange";
  if (message.includes("Twitch access token validation failed")) return "token-validation";
  if (message.includes("Twitch did not grant chat-read access")) return "scope";
  if (message.includes("relation") && message.includes("does not exist")) return "database-schema";
  return "server";
}

function enforceRateLimit(
  limiter: FixedWindowRateLimiter,
  key: string,
  maximum: number,
  windowMs: number
): void {
  if (!limiter.allow(key, maximum, windowMs)) {
    throw apiError("Too many requests. Please wait and try again.", 429);
  }
}

async function currentBattleForUser(
  app: FastifyInstance,
  userId: string
): Promise<CurrentBattleRow | null> {
  const [battle] = await app.database.client<CurrentBattleRow[]>`
    SELECT battle.id, battle.host_user_id AS "hostUserId", battle.guest_user_id AS "guestUserId",
      battle.mode, battle.status, battle.state_version AS "stateVersion",
      battle.current_challenge_set_version_id AS "currentChallengeSetVersionId",
      battle.current_round_id AS "currentRoundId"
    FROM active_battle_members membership
    JOIN battles battle ON battle.id = membership.battle_id
    WHERE membership.user_id = ${userId} AND battle.status <> 'ended'
  `;
  return battle ?? null;
}

async function requireCurrentBattle(app: FastifyInstance, userId: string): Promise<CurrentBattleRow> {
  const battle = await currentBattleForUser(app, userId);
  if (!battle) throw apiError("Create or join a battle first.", 409);
  return battle;
}

async function participantsForBattle(app: FastifyInstance, battleId: string): Promise<ParticipantRow[]> {
  return app.database.client<ParticipantRow[]>`
    SELECT member.user_id AS "userId", user_record.display_name AS "displayName", member.role,
      member.overlay_confirmed_at AS "overlayConfirmedAt", member.chat_connected_at AS "chatConnectedAt"
    FROM battle_members member
    JOIN users user_record ON user_record.id = member.user_id
    WHERE member.battle_id = ${battleId}
    ORDER BY CASE member.role WHEN 'host' THEN 0 ELSE 1 END
  `;
}

async function challengeSetForBattle(app: FastifyInstance, versionId: string | null): Promise<ChallengeSetSnapshot | null> {
  if (!versionId) return null;
  const [version] = await app.database.client<{
    id: string;
    version: number;
    votingDurationSeconds: number;
  }[]>`
    SELECT id, version, voting_duration_seconds AS "votingDurationSeconds"
    FROM challenge_set_versions WHERE id = ${versionId}
  `;
  if (!version) return null;
  const [options, approvals] = await Promise.all([
    app.database.client<ChallengeSetSnapshot["options"]>`
      SELECT id, position, title, instruction, duration_seconds AS "durationSeconds"
      FROM challenge_options WHERE challenge_set_version_id = ${versionId}
      ORDER BY position
    `,
    app.database.client<{ userId: string }[]>`
      SELECT user_id AS "userId" FROM challenge_set_approvals
      WHERE challenge_set_version_id = ${versionId}
    `
  ]);
  return { ...version, options, approvedByUserIds: approvals.map((approval) => approval.userId) };
}

async function roundForBattle(app: FastifyInstance, roundId: string | null): Promise<RoundSnapshot | null> {
  if (!roundId) return null;
  const [round] = await app.database.client<Omit<RoundSnapshot, "readyUserIds" | "assignments">[]>`
    SELECT id, phase, state_version AS "stateVersion", voting_deadline_at AS "votingDeadlineAt",
      countdown_starts_at AS "countdownStartsAt", active_at AS "activeAt", completed_at AS "completedAt",
      terminal_reason AS "terminalReason"
    FROM rounds WHERE id = ${roundId}
  `;
  if (!round) return null;
  const [ready, assignments] = await Promise.all([
    app.database.client<{ userId: string }[]>`
      SELECT user_id AS "userId" FROM round_readiness WHERE round_id = ${roundId}
    `,
    app.database.client<RoundSnapshot["assignments"]>`
      SELECT assignment.target_user_id AS "targetUserId", target.display_name AS "targetDisplayName",
        option.title, option.instruction, option.duration_seconds AS "durationSeconds",
        assignment.resolution, assignment.starts_at AS "startsAt", assignment.ends_at AS "endsAt",
        assignment.cleared_at AS "clearedAt"
      FROM round_assignments assignment
      JOIN users target ON target.id = assignment.target_user_id
      LEFT JOIN challenge_options option ON option.id = assignment.challenge_option_id
      WHERE assignment.round_id = ${roundId}
      ORDER BY target.display_name
    `
  ]);
  return { ...round, readyUserIds: ready.map((entry) => entry.userId), assignments };
}

async function loadOverlaySnapshot(app: FastifyInstance, credentialId: string): Promise<OverlaySnapshot> {
  const [credential] = await app.database.client<{
    battleId: string;
    mode: "real" | "simulated";
    currentChallengeSetVersionId: string | null;
    currentRoundId: string | null;
  }[]>`
    SELECT credential.battle_id AS "battleId", battle.mode,
      battle.current_challenge_set_version_id AS "currentChallengeSetVersionId",
      battle.current_round_id AS "currentRoundId"
    FROM overlay_credentials credential
    JOIN battles battle ON battle.id = credential.battle_id
    WHERE credential.id = ${credentialId}
      AND credential.revoked_at IS NULL
      AND credential.expires_at > NOW()
      AND battle.status <> 'ended'
  `;
  if (!credential) throw apiError("Overlay link is invalid or has expired.", 401);

  const [participants, challengeSet, round] = await Promise.all([
    participantsForBattle(app, credential.battleId),
    challengeSetForBattle(app, credential.currentChallengeSetVersionId),
    roundForBattle(app, credential.currentRoundId)
  ]);
  return createPublicOverlaySnapshot({
    mode: credential.mode,
    participants,
    challengeSet,
    round,
    now: new Date()
  });
}

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    database: ReturnType<typeof createDatabase>;
    events: BattleEventBus;
    eventSub: TwitchEventSubService;
  }
}

export async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      redact: [
        "req.headers.cookie",
        "req.headers.authorization",
        "req.body.code",
        "req.body.secret",
        "body.code",
        "body.secret"
      ]
    }
  });
  const database = createDatabase(config);
  const events = new BattleEventBus();
  const rateLimiter = new FixedWindowRateLimiter();
  const tokens = new TwitchTokenService(database, config);
  const battles = new BattleService(database, events);
  const ingestion = new ChatIngestionService(battles);
  const eventSub = new TwitchEventSubService(
    database,
    config,
    tokens,
    (message) => ingestion.ingest(message).then(() => undefined),
    (userId, connected) => battles.setChatConnection(userId, connected),
    app.log
  );

  app.decorate("config", config);
  app.decorate("database", database);
  app.decorate("events", events);
  app.decorate("eventSub", eventSub);
  await app.register(cookie, { secret: config.SESSION_SECRET });

  app.setErrorHandler((error, request, reply) => {
    const knownError = error as { statusCode?: unknown; message?: unknown };
    const statusCode = typeof knownError.statusCode === "number" ? knownError.statusCode : 500;
    if (statusCode >= 500) request.log.error({ err: error }, "Unhandled server error");
    reply.status(statusCode).send({
      error: statusCode >= 500
        ? "An unexpected error occurred."
        : typeof knownError.message === "string" ? knownError.message : "Request failed."
    });
  });

  app.get("/health", async (_request, reply) => {
    try {
      // A process that has not reached PostgreSQL is not ready to accept an
      // OAuth callback or issue an overlay credential.
      await database.client`SELECT 1`;
      return { status: "ok" };
    } catch (error) {
      app.log.warn({ err: error }, "Health check could not reach PostgreSQL");
      return reply.status(503).send({ status: "unavailable" });
    }
  });

  app.get("/auth/twitch", async (request, reply) => {
    enforceRateLimit(rateLimiter, `oauth-start:${request.ip}`, 10, 10 * 60_000);
    const state = randomSecret(32);
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      ...secureCookieOptions(config),
      signed: true,
      maxAge: 10 * 60
    });
    return reply.redirect(createAuthorizationUrl(config, state));
  });

  // Twitch returns the authorization code in the query string. Suppress
  // automatic request logging here so that code and state never reach logs.
  app.get("/auth/twitch/callback", { logLevel: "silent" }, async (request, reply) => {
    enforceRateLimit(rateLimiter, `oauth-callback:${request.ip}`, 20, 10 * 60_000);
    const query = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(request.query);
    const rawCookie = request.cookies[OAUTH_STATE_COOKIE];
    const cookieState = rawCookie ? request.unsignCookie(rawCookie) : { valid: false, value: "" };
    clearCookie(reply, OAUTH_STATE_COOKIE, config);

    if (query.error || !query.code || !query.state || !cookieState.valid || !constantTimeEquals(query.state, cookieState.value)) {
      return reply.redirect(clientUrl(config, { oauth: "denied" }));
    }
    try {
      const identity = await tokens.exchangeCode(query.code);
      const [user] = await database.client<{ id: string }[]>`SELECT id FROM users WHERE twitch_id = ${identity.twitchId}`;
      if (!user) throw new Error("Twitch identity was not stored.");
      await createCreatorSession(database, reply, config, user.id);
      // A creator has authenticated before they create a battle. EventSub is
      // reconciled again when a battle exists, so an upstream socket issue
      // must not turn a successful OAuth callback into a failed login.
      void eventSub.reconcile().catch((error: unknown) => {
        request.log.warn({ err: error }, "Twitch EventSub reconciliation after OAuth failed");
      });
      return reply.redirect(clientUrl(config, { connected: "1" }));
    } catch (error) {
      request.log.warn({ err: error }, "Twitch OAuth callback failed");
      return reply.redirect(clientUrl(config, { oauth: "failed", reason: oauthFailureReason(error) }));
    }
  });

  app.post("/api/logout", async (request, reply) => {
    assertTrustedOrigin(request, config);
    const token = request.cookies.backseat_session;
    if (token) await database.client`UPDATE sessions SET revoked_at = NOW() WHERE token_hash = ${sha256(token)}`;
    clearCreatorSession(reply, config);
    return reply.status(204).send();
  });

  app.get("/api/session", async (request) => {
    const user = await getCreatorSession(database, request);
    return { user };
  });

  app.post("/api/demo/start", async (request, reply) => {
    assertTrustedOrigin(request, config);
    enforceRateLimit(rateLimiter, `demo-start:${request.ip}`, 5, 60 * 60_000);
    const existing = await getCreatorSession(database, request);
    if (existing && !existing.isDemo) {
      throw apiError("Sign out of Twitch before starting the isolated simulated demo.", 409);
    }
    if (existing && await currentBattleForUser(app, existing.id)) {
      throw apiError("End the current demo battle before starting another one.", 409);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * DAY);
    const battleId = randomUUID();
    const hostId = randomUUID();
    const guestId = randomUUID();
    const versionId = randomUUID();
    const hostOverlaySecret = randomSecret(32);
    const guestOverlaySecret = randomSecret(32);
    const optionIds = new Map<VoteOption, string>(DEFAULT_CHALLENGES.map((option) => [option.position, randomUUID()]));

    await database.client.begin(async (transaction) => {
      await transaction`
        INSERT INTO users (id, twitch_id, login, display_name, created_at, updated_at)
        VALUES
          (${hostId}, ${`demo:${battleId}:host`}, 'demo-host', 'DemoHost', ${timestamp(transaction, now)}, ${timestamp(transaction, now)}),
          (${guestId}, ${`demo:${battleId}:guest`}, 'demo-guest', 'DemoRival', ${timestamp(transaction, now)}, ${timestamp(transaction, now)})
      `;
      await transaction`
        INSERT INTO battles (
          id, host_user_id, guest_user_id, mode, status, current_challenge_set_version_id, state_version, created_at, updated_at
        ) VALUES (
          ${battleId}, ${hostId}, ${guestId}, 'simulated', 'integration-proof', ${versionId}, 5,
          ${timestamp(transaction, now)}, ${timestamp(transaction, now)}
        )
      `;
      await transaction`
        INSERT INTO battle_members (battle_id, user_id, role, overlay_confirmed_at, chat_connected_at, created_at)
        VALUES
          (${battleId}, ${hostId}, 'host', ${timestamp(transaction, now)}, ${timestamp(transaction, now)}, ${timestamp(transaction, now)}),
          (${battleId}, ${guestId}, 'guest', ${timestamp(transaction, now)}, ${timestamp(transaction, now)}, ${timestamp(transaction, now)})
      `;
      await transaction`
        INSERT INTO active_battle_members (user_id, battle_id, created_at)
        VALUES (${hostId}, ${battleId}, ${timestamp(transaction, now)}), (${guestId}, ${battleId}, ${timestamp(transaction, now)})
      `;
      await transaction`
        INSERT INTO challenge_set_versions (
          id, battle_id, version, proposed_by_user_id, voting_duration_seconds, created_at
        ) VALUES (${versionId}, ${battleId}, 1, ${hostId}, 30, ${timestamp(transaction, now)})
      `;
      for (const option of DEFAULT_CHALLENGES) {
        await transaction`
          INSERT INTO challenge_options (
            id, challenge_set_version_id, position, title, instruction, duration_seconds, created_at
          ) VALUES (
            ${optionIds.get(option.position)!}, ${versionId}, ${option.position}, ${option.title},
            ${option.instruction}, ${option.durationSeconds}, ${timestamp(transaction, now)}
          )
        `;
      }
      await transaction`
        INSERT INTO challenge_set_approvals (challenge_set_version_id, user_id, approved_at)
        VALUES (${versionId}, ${hostId}, ${timestamp(transaction, now)}), (${versionId}, ${guestId}, ${timestamp(transaction, now)})
      `;
      await transaction`
        INSERT INTO overlay_credentials (id, owner_user_id, battle_id, secret_hash, expires_at, created_at)
        VALUES
          (${randomUUID()}, ${hostId}, ${battleId}, ${sha256(hostOverlaySecret)}, ${timestamp(transaction, expiresAt)}, ${timestamp(transaction, now)}),
          (${randomUUID()}, ${guestId}, ${battleId}, ${sha256(guestOverlaySecret)}, ${timestamp(transaction, expiresAt)}, ${timestamp(transaction, now)})
      `;
    });
    await createCreatorSession(database, reply, config, hostId);
    return reply.status(201).send({
      overlayUrl: `${clientUrl(config, { overlay: "1" })}#${hostOverlaySecret}`
    });
  });

  app.get("/api/battles/current", async (request) => {
    const user = await requireCreatorSession(database, request);
    const battle = await currentBattleForUser(app, user.id);
    if (!battle) return { serverTime: new Date().toISOString(), battle: null };
    const [participants, challengeSet, round] = await Promise.all([
      participantsForBattle(app, battle.id),
      challengeSetForBattle(app, battle.currentChallengeSetVersionId),
      roundForBattle(app, battle.currentRoundId)
    ]);
    const [lastVote] = await database.client<{
      option: "1" | "2" | "3";
      sourceDisplayName: string;
      targetDisplayName: string;
      receivedAt: Date;
    }[]>`
      SELECT command.option, source.display_name AS "sourceDisplayName", target.display_name AS "targetDisplayName", command.received_at AS "receivedAt"
      FROM chat_commands command
      JOIN users target ON target.id = command.target_user_id
      JOIN users source ON source.twitch_id = command.source_channel_twitch_id
      WHERE command.battle_id = ${battle.id}
      ORDER BY command.received_at DESC LIMIT 1
    `;
    return {
      serverTime: new Date().toISOString(),
      battle: {
        ...battle,
        role: battle.hostUserId === user.id ? "host" : "guest",
        participants,
        challengeSet,
        round,
        lastAcceptedVote: lastVote ?? null
      }
    };
  });

  app.post("/api/battles", async (request, reply) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    if (user.isDemo) throw apiError("End the simulated demo and connect Twitch before creating a real battle.", 409);
    const existing = await currentBattleForUser(app, user.id);
    if (existing) throw apiError("You already have an open battle.", 409);

    const now = new Date();
    const battleId = randomUUID();
    const invitationSecret = randomSecret(32);
    await database.client.begin(async (transaction) => {
      await transaction`
        INSERT INTO battles (id, host_user_id, guest_user_id, mode, status, created_at, updated_at)
        VALUES (${battleId}, ${user.id}, NULL, 'real', 'setup', ${timestamp(transaction, now)}, ${timestamp(transaction, now)})
      `;
      await transaction`
        INSERT INTO battle_members (battle_id, user_id, role, created_at)
        VALUES (${battleId}, ${user.id}, 'host', ${timestamp(transaction, now)})
      `;
      const activeMembership = await transaction<{ userId: string }[]>`
        INSERT INTO active_battle_members (user_id, battle_id, created_at)
        VALUES (${user.id}, ${battleId}, ${timestamp(transaction, now)})
        ON CONFLICT (user_id) DO NOTHING
        RETURNING user_id AS "userId"
      `;
      if (activeMembership.length !== 1) {
        throw apiError("You already have an open battle.", 409);
      }
      await transaction`
        INSERT INTO battle_invitations (id, battle_id, secret_hash, expires_at, created_at)
        VALUES (
          ${randomUUID()}, ${battleId}, ${sha256(invitationSecret)},
          ${timestamp(transaction, new Date(now.getTime() + 7 * DAY))}, ${timestamp(transaction, now)}
        )
      `;
    });
    await eventSub.reconcile();
    return reply.status(201).send({ inviteUrl: clientUrl(config, { invite: invitationSecret }) });
  });

  app.post("/api/battles/current/invitation/rotate", async (request) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `battle-write:${user.id}`, 40, 60_000);
    const battle = await requireCurrentBattle(app, user.id);
    if (battle.mode !== "real" || battle.hostUserId !== user.id) {
      throw apiError("Only the real battle host can rotate its invitation.", 403);
    }

    const invitationSecret = randomSecret(32);
    const now = new Date();
    await database.client.begin(async (transaction) => {
      const [lockedBattle] = await transaction<{ id: string }[]>`
        SELECT id FROM battles
        WHERE id = ${battle.id} AND status = 'setup' AND guest_user_id IS NULL
        FOR UPDATE
      `;
      if (!lockedBattle) throw apiError("This battle can no longer accept a rival.", 409);
      await transaction`
        UPDATE battle_invitations SET revoked_at = COALESCE(revoked_at, ${timestamp(transaction, now)})
        WHERE battle_id = ${battle.id} AND consumed_at IS NULL AND revoked_at IS NULL
      `;
      await transaction`
        INSERT INTO battle_invitations (id, battle_id, secret_hash, expires_at, created_at)
        VALUES (
          ${randomUUID()}, ${battle.id}, ${sha256(invitationSecret)},
          ${timestamp(transaction, new Date(now.getTime() + 7 * DAY))}, ${timestamp(transaction, now)}
        )
      `;
    });
    return { inviteUrl: clientUrl(config, { invite: invitationSecret }) };
  });

  app.post("/api/invitations/accept", async (request) => {
    assertTrustedOrigin(request, config);
    enforceRateLimit(rateLimiter, `invitation:${request.ip}`, 10, 60_000);
    const user = await requireCreatorSession(database, request);
    if (user.isDemo) throw apiError("Simulated demo identities cannot accept real battle invitations.", 403);
    const { secret } = z.object({ secret: z.string().min(40).max(200) }).parse(request.body);
    const now = new Date();
    const secretHash = sha256(secret);
    const result = await database.client.begin(async (transaction) => {
      const [candidate] = await transaction<{ invitationId: string; battleId: string }[]>`
        SELECT id AS "invitationId", battle_id AS "battleId"
        FROM battle_invitations WHERE secret_hash = ${secretHash}
      `;
      if (!candidate) throw apiError("This invitation is invalid or unavailable.", 404);
      const [lockedBattle] = await transaction<{ id: string }[]>`
        SELECT id FROM battles WHERE id = ${candidate.battleId} FOR UPDATE
      `;
      if (!lockedBattle) throw apiError("This invitation is invalid or unavailable.", 404);
      const [invitation] = await transaction<{
        invitationId: string;
        battleId: string;
        hostUserId: string;
        guestUserId: string | null;
      }[]>`
        SELECT invitation.id AS "invitationId", invitation.battle_id AS "battleId",
          battle.host_user_id AS "hostUserId", battle.guest_user_id AS "guestUserId"
        FROM battle_invitations invitation
        JOIN battles battle ON battle.id = invitation.battle_id
        JOIN active_battle_members host_membership
          ON host_membership.battle_id = battle.id AND host_membership.user_id = battle.host_user_id
        WHERE invitation.id = ${candidate.invitationId}
          AND invitation.revoked_at IS NULL
          AND invitation.consumed_at IS NULL
          AND invitation.expires_at > ${timestamp(transaction, now)}
          AND battle.status = 'setup'
        FOR UPDATE OF invitation
      `;
      if (!invitation || invitation.hostUserId === user.id || invitation.guestUserId) {
        throw apiError("This invitation is invalid or unavailable.", 404);
      }
      const guestMembership = await transaction<{ userId: string }[]>`
        INSERT INTO active_battle_members (user_id, battle_id, created_at)
        VALUES (${user.id}, ${invitation.battleId}, ${timestamp(transaction, now)})
        ON CONFLICT (user_id) DO NOTHING
        RETURNING user_id AS "userId"
      `;
      if (guestMembership.length !== 1) {
        throw apiError("You already have an open battle.", 409);
      }
      const changed = await transaction<{ id: string }[]>`
        UPDATE battles SET guest_user_id = ${user.id}, status = 'integration-proof', updated_at = ${timestamp(transaction, now)}
        WHERE id = ${invitation.battleId} AND guest_user_id IS NULL AND status = 'setup'
        RETURNING id
      `;
      if (changed.length !== 1) throw apiError("This invitation was claimed by another creator.", 409);
      await transaction`
        UPDATE battle_invitations SET consumed_at = ${timestamp(transaction, now)}, consumed_by_user_id = ${user.id}
        WHERE id = ${invitation.invitationId}
      `;
      await transaction`
        INSERT INTO battle_members (battle_id, user_id, role, created_at)
        VALUES (${invitation.battleId}, ${user.id}, 'guest', ${timestamp(transaction, now)})
      `;
      return invitation.battleId;
    });
    await eventSub.reconcile();
    events.publish(result);
    return { battleId: result };
  });

  const challengeOptionSchema = z.object({
    position: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    title: z.string().trim().min(1).max(80),
    instruction: z.string().trim().min(1).max(180),
    durationSeconds: z.number().int().min(1).max(300)
  });
  const challengeSetSchema = z.object({
    stateVersion: z.number().int().min(0),
    votingDurationSeconds: z.number().int().min(5).max(120),
    options: z.array(challengeOptionSchema).length(3)
  });
  const stateVersionSchema = z.object({ stateVersion: z.number().int().min(0) });

  app.post("/api/battles/current/challenge-sets", async (request) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `battle-write:${user.id}`, 40, 60_000);
    const battle = await requireCurrentBattle(app, user.id);
    const input = challengeSetSchema.parse(request.body);
    return battles.proposeChallengeSet(battle.id, user.id, input.stateVersion, input);
  });

  app.post("/api/battles/current/challenge-set/approve", async (request) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `battle-write:${user.id}`, 40, 60_000);
    const battle = await requireCurrentBattle(app, user.id);
    const { stateVersion } = stateVersionSchema.parse(request.body);
    return battles.approveChallengeSet(battle.id, user.id, stateVersion);
  });

  app.post("/api/battles/current/overlay-confirmation", async (request) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `battle-write:${user.id}`, 40, 60_000);
    const battle = await requireCurrentBattle(app, user.id);
    const { stateVersion } = stateVersionSchema.parse(request.body);
    return battles.confirmOverlay(battle.id, user.id, stateVersion);
  });

  app.post("/api/battles/current/rounds/open", async (request) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `battle-write:${user.id}`, 40, 60_000);
    const battle = await requireCurrentBattle(app, user.id);
    const { stateVersion } = stateVersionSchema.parse(request.body);
    return battles.openVoting(battle.id, user.id, stateVersion);
  });

  const roundParamsSchema = z.object({ roundId: z.uuid() });

  app.post("/api/battles/current/rounds/:roundId/ready", async (request) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `battle-write:${user.id}`, 40, 60_000);
    const battle = await requireCurrentBattle(app, user.id);
    const { roundId } = roundParamsSchema.parse(request.params);
    return battles.setRoundReady(battle.id, user.id, roundId);
  });

  app.post("/api/battles/current/rounds/:roundId/unready", async (request, reply) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `battle-write:${user.id}`, 40, 60_000);
    const battle = await requireCurrentBattle(app, user.id);
    const { roundId } = roundParamsSchema.parse(request.params);
    await battles.unsetRoundReady(battle.id, user.id, roundId);
    return reply.status(204).send();
  });

  app.post("/api/battles/current/rounds/:roundId/cancel-start", async (request, reply) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `battle-write:${user.id}`, 40, 60_000);
    const battle = await requireCurrentBattle(app, user.id);
    const { roundId } = roundParamsSchema.parse(request.params);
    await battles.cancelCountdown(battle.id, user.id, roundId);
    return reply.status(204).send();
  });

  app.post("/api/battles/current/rounds/:roundId/stop", async (request, reply) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `battle-write:${user.id}`, 40, 60_000);
    const battle = await requireCurrentBattle(app, user.id);
    const { roundId } = roundParamsSchema.parse(request.params);
    // A stop is intentionally keyed to its exact round and bypasses the
    // normal state-version check: a late stop may still protect a live round,
    // but can never affect the round opened after it.
    await battles.stopRound(battle.id, user.id, roundId);
    return reply.status(204).send();
  });

  app.post("/api/battles/current/end", async (request, reply) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `battle-write:${user.id}`, 40, 60_000);
    const battle = await requireCurrentBattle(app, user.id);
    const { stateVersion } = stateVersionSchema.parse(request.body);
    await battles.endBattle(battle.id, user.id, stateVersion);
    await eventSub.reconcile();
    return reply.status(204).send();
  });

  const simulatedVoteSchema = z.object({
    sourceRole: z.enum(["host", "guest"]),
    option: z.union([z.literal(1), z.literal(2), z.literal(3)])
  });

  app.post("/api/demo/votes", async (request) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `demo-vote:${user.id}`, 30, 60_000);
    const battle = await requireCurrentBattle(app, user.id);
    if (!user.isDemo || battle.mode !== "simulated" || battle.hostUserId !== user.id) {
      throw apiError("Simulated votes are only available inside your isolated demo battle.", 403);
    }
    const { sourceRole, option } = simulatedVoteSchema.parse(request.body);
    const [source] = await database.client<{ twitchId: string }[]>`
      SELECT user_record.twitch_id AS "twitchId"
      FROM battle_members member
      JOIN users user_record ON user_record.id = member.user_id
      WHERE member.battle_id = ${battle.id} AND member.role = ${sourceRole}
    `;
    if (!source) throw apiError("The simulated creator is unavailable.", 409);
    return battles.ingestChatVote({
      deliveryId: `demo-delivery:${randomUUID()}`,
      messageId: `demo-message:${randomUUID()}`,
      sourceChannelTwitchId: source.twitchId,
      viewerTwitchId: `demo-viewer:${battle.id}:${sourceRole}`,
      text: `!vote ${option}`,
      receivedAt: new Date()
    });
  });

  app.post("/api/demo/rounds/:roundId/rival-ready", async (request) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `demo-ready:${user.id}`, 20, 60_000);
    const battle = await requireCurrentBattle(app, user.id);
    if (!user.isDemo || battle.mode !== "simulated" || battle.hostUserId !== user.id || !battle.guestUserId) {
      throw apiError("Simulated rival readiness is only available inside your isolated demo battle.", 403);
    }
    const { roundId } = roundParamsSchema.parse(request.params);
    return battles.setRoundReady(battle.id, battle.guestUserId, roundId);
  });

  app.post("/api/overlay-credentials", async (request, reply) => {
    assertTrustedOrigin(request, config);
    const user = await requireCreatorSession(database, request);
    enforceRateLimit(rateLimiter, `overlay-create:${user.id}`, 10, 60 * 60_000);
    const battle = await currentBattleForUser(app, user.id);
    if (!battle) throw apiError("Create or join a battle before creating an overlay link.", 409);

    const now = new Date();
    const secret = randomSecret(32);
    const expiresAt = new Date(now.getTime() + 30 * DAY);
    await database.client.begin(async (transaction) => {
      await transaction`
        UPDATE overlay_credentials SET revoked_at = ${timestamp(transaction, now)}
        WHERE owner_user_id = ${user.id} AND battle_id = ${battle.id} AND revoked_at IS NULL
      `;
      await transaction`
        INSERT INTO overlay_credentials (id, owner_user_id, battle_id, secret_hash, expires_at, created_at)
        VALUES (
          ${randomUUID()}, ${user.id}, ${battle.id}, ${sha256(secret)},
          ${timestamp(transaction, expiresAt)}, ${timestamp(transaction, now)}
        )
      `;
      // Rotating the private browser-source link invalidates a prior manual
      // confirmation: the creator must confirm the newly issued source.
      await transaction`
        UPDATE battle_members SET overlay_confirmed_at = NULL
        WHERE battle_id = ${battle.id} AND user_id = ${user.id}
      `;
      await transaction`
        UPDATE battles SET state_version = state_version + 1, updated_at = ${timestamp(transaction, now)}
        WHERE id = ${battle.id}
      `;
    });
    events.publish(battle.id);
    return reply.send({ overlayUrl: `${clientUrl(config, { overlay: "1" })}#${secret}` });
  });

  app.post("/api/overlay/exchange", async (request, reply) => {
    assertTrustedOrigin(request, config);
    enforceRateLimit(rateLimiter, `overlay-exchange:${request.ip}`, 20, 60_000);
    const { secret } = z.object({ secret: z.string().min(40).max(200) }).parse(request.body);
    const [credential] = await database.client<{ id: string; expiresAt: Date }[]>`
      SELECT id, expires_at AS "expiresAt"
      FROM overlay_credentials
      WHERE secret_hash = ${sha256(secret)} AND revoked_at IS NULL AND expires_at > NOW()
    `;
    if (!credential) throw apiError("Overlay link is invalid or has expired.", 401);
    setOverlaySession(reply, config, credential.id, credential.expiresAt);
    return reply.status(204).send();
  });

  app.get("/api/overlay/snapshot", async (request) => {
    const credentialId = getOverlayCredentialId(request);
    if (!credentialId) throw apiError("Overlay session is missing.", 401);
    return loadOverlaySnapshot(app, credentialId);
  });

  app.get("/api/overlay/events", async (request, reply) => {
    const credentialId = getOverlayCredentialId(request);
    if (!credentialId) throw apiError("Overlay session is missing.", 401);
    const initial = await loadOverlaySnapshot(app, credentialId);
    const [credential] = await database.client<{ battleId: string }[]>`
      SELECT battle_id AS "battleId" FROM overlay_credentials WHERE id = ${credentialId} AND revoked_at IS NULL
    `;
    if (!credential) throw apiError("Overlay link is invalid or has expired.", 401);

    reply.hijack();
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("snapshot", initial);
    const unsubscribe = events.subscribe(credential.battleId, () => {
      void loadOverlaySnapshot(app, credentialId).then((snapshot) => send("snapshot", snapshot)).catch(() => reply.raw.end());
    });
    const heartbeat = setInterval(() => send("heartbeat", { serverTime: new Date().toISOString() }), 10_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return reply;
  });

  if (config.NODE_ENV === "production") {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const clientRoot = path.resolve(here, "../../dist");
    await app.register(fastifyStatic, { root: clientRoot, wildcard: false });
    app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  }

  const validationTimer = setInterval(() => {
    void tokens.validateConnectedGrants().catch((error: unknown) => {
      app.log.warn({ err: error }, "Scheduled Twitch token validation failed");
    });
  }, HOUR);
  validationTimer.unref();

  let roundTicker: NodeJS.Timeout | null = null;
  const advanceRounds = () => {
    void battles.advanceDueRounds().catch((error: unknown) => {
      app.log.warn({ err: error }, "Scheduled round transition failed");
    });
  };

  app.addHook("onReady", async () => {
    // An upstream Twitch outage must not make the creator dashboard or the
    // already-authorized overlay unavailable. Token validation retries on its
    // normal schedule and EventSub reconciliation logs individual failures.
    try {
      await tokens.validateConnectedGrants();
    } catch (error) {
      app.log.warn({ err: error }, "Initial Twitch token validation failed");
    }
    try {
      await battles.resetChatConnections();
    } catch (error) {
      app.log.warn({ err: error }, "Stale Twitch chat connection state could not be reset");
    }
    eventSub.start();
    advanceRounds();
    roundTicker = setInterval(advanceRounds, 1_000);
    roundTicker.unref();
  });
  app.addHook("onClose", async () => {
    clearInterval(validationTimer);
    if (roundTicker) clearInterval(roundTicker);
    await eventSub.stop();
    await database.client.end();
  });

  return app;
}

