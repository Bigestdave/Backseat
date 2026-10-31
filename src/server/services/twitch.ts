import { randomUUID } from "node:crypto";
import { decrypt, encrypt } from "../security/crypto";
import type { AppConfig } from "../config";
import type { Database } from "../db/client";

export const REQUIRED_TWITCH_SCOPES = ["user:read:chat"] as const;

type TwitchTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
};

type TwitchValidation = {
  client_id: string;
  login: string;
  scopes: string[];
  user_id: string;
  expires_in: number;
};

export type TwitchIdentity = {
  twitchId: string;
  login: string;
  displayName: string;
  scopes: string[];
};

async function requestToken(params: URLSearchParams): Promise<TwitchTokenResponse> {
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!response.ok) throw new Error("Twitch token exchange failed.");
  return response.json() as Promise<TwitchTokenResponse>;
}

export async function validateAccessToken(accessToken: string): Promise<TwitchValidation> {
  const response = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${accessToken}` }
  });
  if (!response.ok) {
    const error = new Error("Twitch access token validation failed.");
    Object.assign(error, { statusCode: response.status });
    throw error;
  }
  return response.json() as Promise<TwitchValidation>;
}

export function createAuthorizationUrl(config: AppConfig, state: string): string {
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: config.TWITCH_CLIENT_ID,
    redirect_uri: config.twitchRedirectUri,
    response_type: "code",
    scope: REQUIRED_TWITCH_SCOPES.join(" "),
    state,
    force_verify: "true"
  }).toString();
  return url.toString();
}

export class TwitchTokenService {
  private readonly refreshLocks = new Map<string, Promise<{ accessToken: string; twitchId: string }>>();

  constructor(private readonly database: Database, private readonly config: AppConfig) {}

  async exchangeCode(code: string): Promise<TwitchIdentity> {
    const token = await requestToken(new URLSearchParams({
      client_id: this.config.TWITCH_CLIENT_ID,
      client_secret: this.config.TWITCH_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: this.config.twitchRedirectUri
    }));
    return this.persistValidatedToken(token);
  }

  async accessTokenForUser(userId: string): Promise<{ accessToken: string; twitchId: string }> {
    const [grant] = await this.database.client<{
      accessTokenCiphertext: string;
      refreshTokenCiphertext: string;
      expiresAt: Date;
      twitchId: string;
      revokedAt: Date | null;
    }[]>`
      SELECT g.access_token_ciphertext AS "accessTokenCiphertext",
             g.refresh_token_ciphertext AS "refreshTokenCiphertext",
             g.expires_at AS "expiresAt",
             g.revoked_at AS "revokedAt",
             u.twitch_id AS "twitchId"
      FROM oauth_grants g
      JOIN users u ON u.id = g.user_id
      WHERE g.user_id = ${userId}
    `;
    if (!grant || grant.revokedAt) throw new Error("Twitch connection is unavailable.");

    if (grant.expiresAt.getTime() - Date.now() >= 5 * 60_000) {
      return {
        accessToken: decrypt(grant.accessTokenCiphertext, this.config.TOKEN_ENCRYPTION_KEY),
        twitchId: grant.twitchId
      };
    }
    return this.refreshAccessToken(userId);
  }

  async validateConnectedGrants(): Promise<void> {
    const users = await this.database.client<{ userId: string }[]>`
      SELECT user_id AS "userId"
      FROM oauth_grants WHERE revoked_at IS NULL
    `;
    await Promise.all(users.map(async (grant) => {
      try {
        // This goes through the five-minute refresh window before validation.
        // A normal expired access token must be refreshed, not mistaken for a
        // user revoking Backseat's authorization.
        const { accessToken } = await this.accessTokenForUser(grant.userId);
        await validateAccessToken(accessToken);
        await this.database.client`UPDATE oauth_grants SET validated_at = NOW() WHERE user_id = ${grant.userId}`;
      } catch (error) {
        // A temporary network or provider failure is not proof that the creator
        // revoked access. Only an explicit invalid-token response revokes it.
        if (typeof (error as { statusCode?: unknown }).statusCode === "number" &&
          (error as { statusCode: number }).statusCode === 401) {
          await this.database.client`UPDATE oauth_grants SET revoked_at = NOW() WHERE user_id = ${grant.userId}`;
        }
      }
    }));
  }

  private async refreshAccessToken(userId: string): Promise<{ accessToken: string; twitchId: string }> {
    const existing = this.refreshLocks.get(userId);
    if (existing) return existing;
    const refresh = this.refreshAccessTokenUnlocked(userId).finally(() => this.refreshLocks.delete(userId));
    this.refreshLocks.set(userId, refresh);
    return refresh;
  }

  private async refreshAccessTokenUnlocked(userId: string): Promise<{ accessToken: string; twitchId: string }> {
    // Re-read after acquiring the in-process lock: an earlier request may have
    // already stored replacement tokens.
    const [grant] = await this.database.client<{
      accessTokenCiphertext: string;
      refreshTokenCiphertext: string;
      expiresAt: Date;
      twitchId: string;
      revokedAt: Date | null;
    }[]>`
      SELECT g.access_token_ciphertext AS "accessTokenCiphertext",
             g.refresh_token_ciphertext AS "refreshTokenCiphertext",
             g.expires_at AS "expiresAt", g.revoked_at AS "revokedAt",
             u.twitch_id AS "twitchId"
      FROM oauth_grants g JOIN users u ON u.id = g.user_id
      WHERE g.user_id = ${userId}
    `;
    if (!grant || grant.revokedAt) throw new Error("Twitch connection is unavailable.");
    if (grant.expiresAt.getTime() - Date.now() >= 5 * 60_000) {
      return {
        accessToken: decrypt(grant.accessTokenCiphertext, this.config.TOKEN_ENCRYPTION_KEY),
        twitchId: grant.twitchId
      };
    }

    const refreshed = await requestToken(new URLSearchParams({
      client_id: this.config.TWITCH_CLIENT_ID,
      client_secret: this.config.TWITCH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: decrypt(grant.refreshTokenCiphertext, this.config.TOKEN_ENCRYPTION_KEY)
    }));
    const identity = await this.persistValidatedToken(refreshed);
    if (identity.twitchId !== grant.twitchId) throw new Error("Twitch token identity changed.");
    return { accessToken: refreshed.access_token, twitchId: grant.twitchId };
  }

  private async persistValidatedToken(token: TwitchTokenResponse): Promise<TwitchIdentity> {
    const validation = await validateAccessToken(token.access_token);
    if (validation.client_id !== this.config.TWITCH_CLIENT_ID) throw new Error("Twitch token belongs to another client.");
    if (!REQUIRED_TWITCH_SCOPES.every((scope) => validation.scopes.includes(scope))) {
      throw new Error("Twitch did not grant chat-read access.");
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + token.expires_in * 1000);
    const [user] = await this.database.client<{ id: string }[]>`
      INSERT INTO users (id, twitch_id, login, display_name, created_at, updated_at)
      VALUES (${randomUUID()}, ${validation.user_id}, ${validation.login}, ${validation.login}, ${now}, ${now})
      ON CONFLICT (twitch_id) DO UPDATE
        SET login = EXCLUDED.login, display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at
      RETURNING id
    `;
    await this.database.client`
      INSERT INTO oauth_grants (
        user_id, access_token_ciphertext, refresh_token_ciphertext, scopes, expires_at, validated_at, revoked_at, updated_at
      ) VALUES (
        ${user.id}, ${encrypt(token.access_token, this.config.TOKEN_ENCRYPTION_KEY)},
        ${encrypt(token.refresh_token, this.config.TOKEN_ENCRYPTION_KEY)},
        ${JSON.stringify(validation.scopes)}::jsonb, ${expiresAt}, ${now}, NULL, ${now}
      ) ON CONFLICT (user_id) DO UPDATE SET
        access_token_ciphertext = EXCLUDED.access_token_ciphertext,
        refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
        scopes = EXCLUDED.scopes,
        expires_at = EXCLUDED.expires_at,
        validated_at = EXCLUDED.validated_at,
        revoked_at = NULL,
        updated_at = EXCLUDED.updated_at
    `;
    return {
      twitchId: validation.user_id,
      login: validation.login,
      displayName: validation.login,
      scopes: validation.scopes
    };
  }
}

