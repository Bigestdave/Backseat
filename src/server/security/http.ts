import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config";

export function assertTrustedOrigin(request: FastifyRequest, config: AppConfig): void {
  const origin = request.headers.origin;
  if (!origin || !config.trustedOrigins.has(origin)) {
    const error = new Error("Untrusted request origin.");
    Object.assign(error, { statusCode: 403 });
    throw error;
  }
}

export function secureCookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.secureCookies,
    path: "/"
  };
}

export function clearCookie(reply: FastifyReply, name: string, config: AppConfig) {
  reply.clearCookie(name, secureCookieOptions(config));
}

