import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "../../../src/server/security/rate-limit";

describe("FixedWindowRateLimiter", () => {
  it("blocks requests over the fixed-window limit without blocking other keys", () => {
    const limiter = new FixedWindowRateLimiter();
    expect(limiter.allow("viewer-a", 2, 1_000, 10)).toBe(true);
    expect(limiter.allow("viewer-a", 2, 1_000, 20)).toBe(true);
    expect(limiter.allow("viewer-a", 2, 1_000, 30)).toBe(false);
    expect(limiter.allow("viewer-b", 2, 1_000, 30)).toBe(true);
  });

  it("opens a new window after expiration", () => {
    const limiter = new FixedWindowRateLimiter();
    expect(limiter.allow("viewer", 1, 1_000, 10)).toBe(true);
    expect(limiter.allow("viewer", 1, 1_000, 999)).toBe(false);
    expect(limiter.allow("viewer", 1, 1_000, 1_010)).toBe(true);
  });
});
