import { z } from "zod";

// Node's parser keeps local development secrets out of the client bundle and
// avoids adding a runtime dependency just to read an ignored `.env` file. A
// deployed process must receive its environment from its host instead.
export function loadLocalEnvFile(): void {
  if (process.env.NODE_ENV === "production") return;
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const environment = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  APP_ORIGIN: z.string().url(),
  WEB_ORIGIN: z.string().url(),
  TRUSTED_ORIGINS: z.string().min(1),
  TWITCH_CLIENT_ID: z.string().min(1),
  TWITCH_CLIENT_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(40)
});

export type AppConfig = z.infer<typeof environment> & {
  trustedOrigins: Set<string>;
  twitchRedirectUri: string;
  secureCookies: boolean;
};

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environment.parse(raw);
  const encryptionKey = Buffer.from(parsed.TOKEN_ENCRYPTION_KEY, "base64");

  if (encryptionKey.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be base64-encoded 32 random bytes.");
  }

  const trustedOrigins = new Set(
    parsed.TRUSTED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
  );
  trustedOrigins.add(parsed.APP_ORIGIN);
  trustedOrigins.add(parsed.WEB_ORIGIN);

  return {
    ...parsed,
    trustedOrigins,
    twitchRedirectUri: new URL("/auth/twitch/callback", parsed.APP_ORIGIN).toString(),
    secureCookies: new URL(parsed.APP_ORIGIN).protocol === "https:"
  };
}

