import { describe, expect, it } from "vitest";
import { createPublicOverlaySnapshot } from "../../../src/server/services/overlay-state";

const now = new Date("2026-10-30T12:00:00.000Z");
const participants = [
  { displayName: "Host", role: "host" as const, overlayConfirmedAt: now, chatConnectedAt: now },
  { displayName: "Guest", role: "guest" as const, overlayConfirmedAt: now, chatConnectedAt: now }
];
const challengeSet = {
  options: [
    { position: 1 as const, title: "No boosting", durationSeconds: 20 },
    { position: 2 as const, title: "No jumping", durationSeconds: 20 },
    { position: 3 as const, title: "Reverse only", durationSeconds: 10 }
  ],
  approvedByUserIds: ["host-user", "guest-user"]
};

describe("public overlay state", () => {
  it("does not mark the battle ready until both creators have joined", () => {
    const snapshot = createPublicOverlaySnapshot({
      mode: "real",
      participants: [participants[0]],
      challengeSet: null,
      round: null,
      now
    });

    expect(snapshot.phase).toBe("waiting-for-rival");
    expect(snapshot.restrictions).toEqual([]);
  });

  it("only exposes the approved public state to a ready overlay", () => {
    const snapshot = createPublicOverlaySnapshot({ mode: "real", participants, challengeSet, round: null, now });

    expect(snapshot.phase).toBe("ready-for-voting");
    expect(snapshot.challenges).toEqual(challengeSet.options);
    expect(JSON.stringify(snapshot)).not.toContain("host-user");
    expect(JSON.stringify(snapshot)).not.toContain("guest-user");
    expect(snapshot.participants.every((participant) => participant.chatConnected)).toBe(true);
  });

  it("keeps the overlay out of ready state while either Twitch chat feed is disconnected", () => {
    const snapshot = createPublicOverlaySnapshot({
      mode: "real",
      participants: [participants[0], { ...participants[1], chatConnectedAt: null }],
      challengeSet,
      round: null,
      now
    });

    expect(snapshot.phase).toBe("setup");
    expect(snapshot.participants[1]?.chatConnected).toBe(false);
  });

  it("shows public assignments but never vote or viewer fields", () => {
    const snapshot = createPublicOverlaySnapshot({
      mode: "real",
      participants,
      challengeSet,
      now,
      round: {
        phase: "active",
        votingDeadlineAt: new Date("2026-10-30T12:00:30.000Z"),
        countdownStartsAt: new Date("2026-10-30T12:00:33.000Z"),
        assignments: [{
          targetDisplayName: "Guest",
          title: "No boosting",
          instruction: "Do not use boost.",
          endsAt: new Date("2026-10-30T12:00:53.000Z"),
          clearedAt: null
        }]
      }
    });

    expect(snapshot.phase).toBe("active");
    expect(snapshot.restrictions).toEqual([{
      targetDisplayName: "Guest",
      title: "No boosting",
      instruction: "Do not use boost.",
      endsAt: "2026-10-30T12:00:53.000Z",
      clearedAt: null
    }]);
    expect(Object.keys(snapshot)).not.toContain("votes");
    expect(Object.keys(snapshot)).not.toContain("viewers");
  });

  it("carries only the relevant server deadline for a voting phase", () => {
    const snapshot = createPublicOverlaySnapshot({
      mode: "simulated",
      participants,
      challengeSet,
      now,
      round: {
        phase: "voting",
        votingDeadlineAt: new Date("2026-10-30T12:00:30.000Z"),
        countdownStartsAt: null,
        assignments: []
      }
    });

    expect(snapshot.votingDeadlineAt).toBe("2026-10-30T12:00:30.000Z");
    expect(snapshot.countdownStartsAt).toBeNull();
  });
});
