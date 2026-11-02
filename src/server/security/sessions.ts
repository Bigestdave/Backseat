import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config";
import type { Database } from "../db/client";
import { timestamp } from "../db/timestamp";
import { randomSecret, sha256 } from "./crypto";
import { clearCookie, secureCookieOptions } from "./http";

export const CREATOR_SESSION_COOKIE = "backseat_session";
export const OVERLAY_SESSION_COOKIE = "backseat_overlay";

export type SessionUser = {
  id: string;
  twitchId: string;
  login: string;
  displayName: string;
  isDemo: boolean;
};

export async function createCreatorSession(
  database: Database,
  reply: FastifyReply,
  config: AppConfig,
  userId: string
): Promise<void> {
  const token = randomSecret(36);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 14);
  await database.client`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES (
      ${randomUUID()}, ${userId}, ${sha256(token)},
      ${timestamp(database.client, expiresAt)}, ${timestamp(database.client, now)}
    )
  `;
  reply.setCookie(CREATOR_SESSION_COOKIE, token, {
    ...secureCookieOptions(config),
    maxAge: 60 * 60 * 24 * 14
  });
}

export async function getCreatorSession(
  database: Database,
  request: FastifyRequest
): Promise<SessionUser | null> {
  const token = request.cookies[CREATOR_SESSION_COOKIE];
  if (!token) return null;
  const [row] = await database.client<SessionUser[]>`
    SELECT u.id, u.twitch_id AS "twitchId", u.login, u.display_name AS "displayName",
      (u.twitch_id LIKE 'demo:%') AS "isDemo"
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha256(token)}
      AND s.revoked_at IS NULL
      AND s.expires_at > NOW()
      AND (
        u.twitch_id LIKE 'demo:%'
        OR EXISTS (SELECT 1 FROM oauth_grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL)
      )
  `;
  return row ?? null;
}

export async function requireCreatorSession(database: Database, request: FastifyRequest): Promise<SessionUser> {
  const user = await getCreatorSession(database, request);
  if (!user) {
    const error = new Error("Sign in with Twitch to continue.");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
  return user;
}

export function clearCreatorSession(reply: FastifyReply, config: AppConfig): void {
  clearCookie(reply, CREATOR_SESSION_COOKIE, config);
}

export function setOverlaySession(
  reply: FastifyReply,
  config: AppConfig,
  credentialId: string,
  expiresAt: Date
): void {
  reply.setCookie(OVERLAY_SESSION_COOKIE, credentialId, {
    ...secureCookieOptions(config),
    signed: true,
    maxAge: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
  });
}

export function getOverlayCredentialId(request: FastifyRequest): string | null {
  const raw = request.cookies[OVERLAY_SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

