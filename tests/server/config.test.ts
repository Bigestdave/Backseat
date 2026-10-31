import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config";

const baseEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://backseat:password@example.supabase.co:5432/postgres",
  RENDER_EXTERNAL_URL: "https://backseat-demo.onrender.com",
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: "s".repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64")
};

describe("deployment origin configuration", () => {
  it("uses Render's assigned URL for same-origin app, browser, and OAuth callback", () => {
    const config = loadConfig(baseEnvironment);

    expect(config.APP_ORIGIN).toBe("https://backseat-demo.onrender.com");
    expect(config.WEB_ORIGIN).toBe(config.APP_ORIGIN);
    expect(config.TRUSTED_ORIGINS).toBe(config.APP_ORIGIN);
    expect(config.trustedOrigins).toEqual(new Set([config.APP_ORIGIN]));
    expect(config.twitchRedirectUri).toBe("https://backseat-demo.onrender.com/auth/twitch/callback");
    expect(config.secureCookies).toBe(true);
  });

  it("allows explicit public origins to override the provider-assigned URL", () => {
    const config = loadConfig({
      ...baseEnvironment,
      APP_ORIGIN: "https://backseat.example",
      WEB_ORIGIN: "https://backseat.example"
    });

    expect(config.twitchRedirectUri).toBe("https://backseat.example/auth/twitch/callback");
    expect(config.trustedOrigins).toContain("https://backseat.example");
  });

  it("requires an explicit origin when the hosting platform provides no public URL", () => {
    const { RENDER_EXTERNAL_URL: _renderUrl, ...withoutRenderUrl } = baseEnvironment;

    expect(() => loadConfig(withoutRenderUrl)).toThrow("APP_ORIGIN must be set");
  });
});
