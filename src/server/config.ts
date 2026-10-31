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
  APP_ORIGIN: z.string().url().optional(),
  WEB_ORIGIN: z.string().url().optional(),
  TRUSTED_ORIGINS: z.string().optional(),
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  TWITCH_CLIENT_ID: z.string().min(1),
  TWITCH_CLIENT_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(40)
});

type ParsedConfig = z.infer<typeof environment>;

export type AppConfig = Omit<ParsedConfig, "APP_ORIGIN" | "WEB_ORIGIN" | "TRUSTED_ORIGINS" | "RENDER_EXTERNAL_URL"> & {
  APP_ORIGIN: string;
  WEB_ORIGIN: string;
  TRUSTED_ORIGINS: string;
  trustedOrigins: Set<string>;
  twitchRedirectUri: string;
  secureCookies: boolean;
};

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environment.parse(raw);
  const appOrigin = parsed.APP_ORIGIN ?? parsed.RENDER_EXTERNAL_URL;

  if (!appOrigin) {
    throw new Error("APP_ORIGIN must be set, or the hosting provider must supply RENDER_EXTERNAL_URL.");
  }

  const webOrigin = parsed.WEB_ORIGIN ?? appOrigin;
  const trustedOriginList = parsed.TRUSTED_ORIGINS ?? [appOrigin, ...(webOrigin === appOrigin ? [] : [webOrigin])].join(",");
  const encryptionKey = Buffer.from(parsed.TOKEN_ENCRYPTION_KEY, "base64");

  if (encryptionKey.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be base64-encoded 32 random bytes.");
  }

  const trustedOrigins = new Set(
    trustedOriginList.split(",").map((origin) => origin.trim()).filter(Boolean)
  );
  trustedOrigins.add(appOrigin);
  trustedOrigins.add(webOrigin);

  return {
    ...parsed,
    APP_ORIGIN: appOrigin,
    WEB_ORIGIN: webOrigin,
    TRUSTED_ORIGINS: trustedOriginList,
    trustedOrigins,
    twitchRedirectUri: new URL("/auth/twitch/callback", appOrigin).toString(),
    secureCookies: new URL(appOrigin).protocol === "https:"
  };
}

