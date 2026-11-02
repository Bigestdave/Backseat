import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHALLENGES,
  DomainRuleError,
  approveChallengeSet,
  assertRoundTransition,
  challengeSetIsApproved,
  clearCreatorReady,
  resolveVoteTally,
  setCreatorReady,
  validateChallengeDrafts,
  voteIsTimely,
  votingDeadline
} from "../../../src/server/domain/rounds";

describe("challenge-set rules", () => {
  it("accepts the three approved demo restrictions", () => {
    expect(() => validateChallengeDrafts(DEFAULT_CHALLENGES)).not.toThrow();
  });

  it("accepts two to four consecutive pick positions", () => {
    expect(() => validateChallengeDrafts(DEFAULT_CHALLENGES.slice(0, 2))).not.toThrow();
    expect(() => validateChallengeDrafts([
      ...DEFAULT_CHALLENGES,
      { position: 4, title: "One hand only", instruction: "Use one hand.", durationSeconds: 30 }
    ])).not.toThrow();
  });

  it("rejects non-consecutive positions and unsupported durations", () => {
    expect(() => validateChallengeDrafts([
      DEFAULT_CHALLENGES[0],
      { ...DEFAULT_CHALLENGES[1], position: 1 },
      DEFAULT_CHALLENGES[2]
    ])).toThrow("consecutive positions");
    expect(() => validateChallengeDrafts([
      DEFAULT_CHALLENGES[0],
      { ...DEFAULT_CHALLENGES[1], durationSeconds: 25 }
    ])).toThrow("10, 20, 30, or 60");
  });

  it("requires both creators to approve the same immutable version", () => {
    const hostApproved = approveChallengeSet(new Set(), "host");
    expect(challengeSetIsApproved(hostApproved)).toBe(false);
    expect(challengeSetIsApproved(approveChallengeSet(hostApproved, "guest"))).toBe(true);
  });
});

describe("round rules", () => {
  it("allows only legal lifecycle transitions", () => {
    expect(() => assertRoundTransition("voting", "revealed")).not.toThrow();
    expect(() => assertRoundTransition("revealed", "active")).toThrow("Cannot transition");
  });

  it("invalidates every live phase when chat disconnects", () => {
    for (const phase of ["voting", "revealed", "countdown", "active"] as const) {
      expect(() => assertRoundTransition(phase, "invalidated")).not.toThrow();
    }
  });

  it("commits one shared server countdown when the second creator is ready", () => {
    const now = new Date("2026-10-30T10:00:00.000Z");
    const host = setCreatorReady({}, "host", now);
    expect(host.countdownStartsAt).toBeNull();

    const both = setCreatorReady(host.readiness, "guest", now);
    expect(both.countdownStartsAt?.toISOString()).toBe("2026-10-30T10:00:03.000Z");
    expect(clearCreatorReady(host.readiness, "host")).toEqual({});
  });

  it("resolves a tie once using the server-supplied random decision", () => {
    expect(resolveVoteTally({ 1: 4, 2: 4, 3: 1 }, () => 1)).toEqual({
      kind: "selected",
      option: 2,
      tiedOptions: [1, 2]
    });
  });

  it("never invents a challenge when a community has no votes", () => {
    expect(resolveVoteTally({ 1: 0, 2: 0, 3: 0 }, () => 0)).toEqual({ kind: "no-votes" });
  });

  it("uses the server deadline as an exclusive boundary", () => {
    const now = new Date("2026-10-30T10:00:00.000Z");
    const deadline = votingDeadline(now, 30);
    expect(voteIsTimely(new Date("2026-10-30T10:00:29.999Z"), deadline)).toBe(true);
    expect(voteIsTimely(deadline, deadline)).toBe(false);
  });
});
