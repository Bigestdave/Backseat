import { describe, expect, it } from "vitest";
import { decrypt, encrypt, sha256 } from "../../../src/server/security/crypto";

const key = Buffer.alloc(32, 7).toString("base64");

describe("token encryption", () => {
  it("round-trips a provider token without storing it in plaintext", () => {
    const plaintext = "twitch-access-token";
    const ciphertext = encrypt(plaintext, key);
    expect(ciphertext).not.toContain(plaintext);
    expect(decrypt(ciphertext, key)).toBe(plaintext);
  });

  it("rejects a tampered encrypted payload", () => {
    const pieces = encrypt("refresh-token", key).split(".");
    pieces[2] = "AAAA";
    expect(() => decrypt(pieces.join("."), key)).toThrow();
  });

  it("uses stable non-reversible hashes for externally presented secrets", () => {
    expect(sha256("secret")).toHaveLength(64);
    expect(sha256("secret")).toBe(sha256("secret"));
    expect(sha256("secret")).not.toBe(sha256("other-secret"));
  });
});
